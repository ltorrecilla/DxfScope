/**
 * dxf_hatch.js — HATCH support.
 *
 * dxf-parser drops HATCH entities entirely (they never reach currentDxf.entities),
 * so they are read straight from the raw text here — the same approach the viewer
 * already uses for VIEWPORT records and the LAYER table.
 *
 * Responsibilities:
 *   parseRawDxfHatches(text)          → hatch records with raw keys
 *   buildHatchLoops(hatch, helpers)   → boundary paths flattened to point rings
 *   classifyLoops(loops)              → outer rings + their holes (even-odd nesting)
 *   patternSegments(hatch, loops)     → line segments for a pattern fill
 *
 * Pattern definition data (codes 53/43/44/45/46/49) is written by CAD applications
 * with the hatch scale and angle already applied, so it is used as-is.
 *
 * window.DxfHatch + Node exports.
 */
(function (root) {
    'use strict';

    const DEG = Math.PI / 180;
    const EPS = 1e-9;

    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
    const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

    // ===================== Raw parsing =====================

    /**
     * Scan the ENTITIES section for HATCH records. Entity indices follow the same
     * "E:n" scheme the viewer uses elsewhere, so hatches can be patched or deleted
     * by the serializer exactly like any other entity.
     */
    function parseRawDxfHatches(rawText) {
        const out = [];
        if (!rawText) return out;
        const lines = String(rawText).replace(/\r\n/g, '\n').split('\n');
        let i = 0, section = null, entityIdx = 0;

        while (i < lines.length - 1) {
            const code = (lines[i] ?? '').trim();
            const value = (lines[i + 1] ?? '').trim();

            if (code === '0' && value.toUpperCase() === 'SECTION') {
                const c2 = (lines[i + 2] ?? '').trim();
                section = c2 === '2' ? (lines[i + 3] ?? '').trim().toUpperCase() : null;
                entityIdx = 0;
                i += 4; continue;
            }
            if (code === '0' && value.toUpperCase() === 'ENDSEC') { section = null; i += 2; continue; }

            if (section === 'ENTITIES' && code === '0') {
                const type = value.toUpperCase();
                let j = i + 2;
                const pairs = [];
                while (j < lines.length - 1) {
                    const c = (lines[j] ?? '').trim();
                    if (c === '0') break;
                    pairs.push([c, lines[j + 1] ?? '']);
                    j += 2;
                }
                if (type === 'HATCH') {
                    const h = parseHatchRecord(pairs);
                    if (h) { h.__rawKey = `E:${entityIdx}`; out.push(h); }
                }
                entityIdx++;
                i = j; continue;
            }
            i += 2;
        }
        return out;
    }

    function parseHatchRecord(pairs) {
        const h = {
            type: 'HATCH', handle: '', layer: '0', colorNumber: null, trueColor: null,
            patternName: 'SOLID', solid: true, gradient: false,
            style: 0, patternAngle: 0, patternScale: 1, double: false,
            elevation: 0, paths: [], patternLines: [],
            __paperSpace: false, __layoutName: null,
        };
        let i = 0, numPaths = 0;

        // ---- header (everything up to the boundary path count) ----
        for (; i < pairs.length; i++) {
            const [c, v] = pairs[i];
            if (c === '91') { numPaths = int(v); i++; break; }
            switch (c) {
                case '5': h.handle = String(v).trim(); break;
                case '8': h.layer = String(v).trim(); break;
                case '62': h.colorNumber = int(v); break;
                case '420': h.trueColor = int(v); break;
                case '67': h.__paperSpace = int(v) === 1; break;
                case '410': h.__layoutName = String(v).trim(); break;
                case '2': h.patternName = String(v).trim(); break;
                case '70': h.solid = int(v) === 1; break;
                case '30': h.elevation = num(v); break;
                case '450': h.gradient = int(v) === 1; break;
                default: break;
            }
        }

        // ---- boundary paths ----
        for (let p = 0; p < numPaths; p++) {
            while (i < pairs.length && pairs[i][0] !== '92') i++;
            if (i >= pairs.length) break;
            const flags = int(pairs[i][1]); i++;
            const path = { flags, pts: [], polyline: (flags & 2) === 2 };

            if (path.polyline) {
                let hasBulge = 0, isClosed = 0, nVerts = 0;
                while (i < pairs.length) {
                    const [c, v] = pairs[i];
                    if (c === '72') { hasBulge = int(v); i++; }
                    else if (c === '73') { isClosed = int(v); i++; }
                    else if (c === '93') { nVerts = int(v); i++; break; }
                    else break;
                }
                const verts = [];
                while (i < pairs.length) {
                    const [c, v] = pairs[i];
                    if (c === '10') {
                        if (verts.length >= nVerts) break;
                        verts.push({ x: num(v), y: 0, bulge: 0 }); i++;
                    } else if (c === '20') {
                        if (verts.length) verts[verts.length - 1].y = num(v);
                        i++;
                    } else if (c === '42') {
                        if (verts.length) verts[verts.length - 1].bulge = num(v);
                        i++;
                    } else break;
                }
                path.vertices = verts;
                path.closed = isClosed === 1 || true; // hatch boundaries are always closed
                path.hasBulge = hasBulge === 1;
            } else {
                while (i < pairs.length && pairs[i][0] !== '93') i++;
                const nEdges = i < pairs.length ? int(pairs[i][1]) : 0;
                i++;
                path.edges = [];
                for (let e = 0; e < nEdges; e++) {
                    while (i < pairs.length && pairs[i][0] !== '72') i++;
                    if (i >= pairs.length) break;
                    const et = int(pairs[i][1]); i++;
                    if (et === 4) {
                        const sp = { type: 4, degree: 3, knots: [], controls: [], fits: [] };
                        let nKnots = 0, nCtrl = 0, nFit = 0;
                        while (i < pairs.length) {
                            const [c, v] = pairs[i];
                            if (c === '94') { sp.degree = int(v); i++; }
                            else if (c === '73' || c === '74') { i++; }
                            else if (c === '95') { nKnots = int(v); i++; }
                            else if (c === '96') { nCtrl = int(v); i++; }
                            else break;
                        }
                        for (let k = 0; k < nKnots && i < pairs.length && pairs[i][0] === '40'; k++) { sp.knots.push(num(pairs[i][1])); i++; }
                        while (i < pairs.length && sp.controls.length < nCtrl) {
                            const [c, v] = pairs[i];
                            if (c === '10') { sp.controls.push({ x: num(v), y: 0 }); i++; }
                            else if (c === '20') { if (sp.controls.length) sp.controls[sp.controls.length - 1].y = num(v); i++; }
                            else if (c === '42') { i++; }
                            else break;
                        }
                        if (i < pairs.length && pairs[i][0] === '97') { nFit = int(pairs[i][1]); i++; }
                        while (i < pairs.length && sp.fits.length < nFit) {
                            const [c, v] = pairs[i];
                            if (c === '11') { sp.fits.push({ x: num(v), y: 0 }); i++; }
                            else if (c === '21') { if (sp.fits.length) sp.fits[sp.fits.length - 1].y = num(v); i++; }
                            else break;
                        }
                        while (i < pairs.length && ['12', '22', '13', '23'].includes(pairs[i][0])) i++;
                        path.edges.push(sp);
                    } else {
                        const d = {};
                        while (i < pairs.length && !['72', '97', '92'].includes(pairs[i][0])) {
                            const [c, v] = pairs[i];
                            if (!(c in d)) d[c] = num(v);
                            i++;
                        }
                        path.edges.push({ type: et, d });
                    }
                }
            }
            h.paths.push(path);
        }

        // ---- trailing style + pattern definition ----
        let numPatLines = 0;
        while (i < pairs.length) {
            const [c, v] = pairs[i];
            if (c === '75') h.style = int(v);
            else if (c === '52') h.patternAngle = num(v);
            else if (c === '41') h.patternScale = num(v);
            else if (c === '77') h.double = int(v) === 1;
            else if (c === '78') { numPatLines = int(v); i++; break; }
            i++;
        }
        for (let k = 0; k < numPatLines; k++) {
            while (i < pairs.length && pairs[i][0] !== '53') i++;
            if (i >= pairs.length) break;
            const pl = { angle: num(pairs[i][1]), base: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, dashes: [] };
            i++;
            let nDash = 0;
            while (i < pairs.length) {
                const [c, v] = pairs[i];
                if (c === '43') { pl.base.x = num(v); i++; }
                else if (c === '44') { pl.base.y = num(v); i++; }
                else if (c === '45') { pl.offset.x = num(v); i++; }
                else if (c === '46') { pl.offset.y = num(v); i++; }
                else if (c === '79') { nDash = int(v); i++; break; }
                else break;
            }
            while (i < pairs.length && pl.dashes.length < nDash && pairs[i][0] === '49') {
                pl.dashes.push(num(pairs[i][1])); i++;
            }
            h.patternLines.push(pl);
        }
        return h.paths.length ? h : null;
    }

    // ===================== Boundary → point rings =====================

    function arcPoints(cx, cy, r, a0Deg, a1Deg, ccw, segFor) {
        let a0 = a0Deg * DEG, a1 = a1Deg * DEG;
        let sweep;
        if (ccw === false) {
            sweep = a0 - a1;
            while (sweep <= 0) sweep += Math.PI * 2;
            sweep = -sweep;
        } else {
            sweep = a1 - a0;
            while (sweep <= 0) sweep += Math.PI * 2;
        }
        if (Math.abs(Math.abs(sweep) - Math.PI * 2) < 1e-6 || Math.abs(sweep) < EPS) {
            sweep = Math.sign(sweep || 1) * Math.PI * 2;
        }
        const n = Math.max(2, segFor(r, Math.abs(sweep)));
        const pts = [];
        for (let k = 0; k <= n; k++) {
            const t = a0 + sweep * (k / n);
            pts.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r });
        }
        return pts;
    }

    function ellipseEdgePoints(d, segFor) {
        const cx = d['10'] || 0, cy = d['20'] || 0;
        const mx = d['11'] || 0, my = d['21'] || 0;      // major axis endpoint, relative to centre
        const ratio = d['40'] || 1;
        const a0 = (d['50'] || 0), a1 = (d['51'] || 360);
        const ccw = d['73'] === undefined ? true : d['73'] === 1;
        const major = Math.hypot(mx, my);
        const minor = major * ratio;
        const rot = Math.atan2(my, mx);
        // Parameter angles sweep in the ellipse's own frame.
        let s0 = a0 * DEG, s1 = a1 * DEG, sweep;
        if (ccw) { sweep = s1 - s0; while (sweep <= 0) sweep += Math.PI * 2; }
        else { sweep = s0 - s1; while (sweep <= 0) sweep += Math.PI * 2; sweep = -sweep; }
        if (Math.abs(Math.abs(a1 - a0) - 360) < 1e-6) sweep = Math.sign(sweep || 1) * Math.PI * 2;
        const n = Math.max(2, segFor(major, Math.abs(sweep)));
        const pts = [];
        for (let k = 0; k <= n; k++) {
            const t = s0 + sweep * (k / n);
            const ex = Math.cos(t) * major, ey = Math.sin(t) * minor;
            pts.push({
                x: cx + ex * Math.cos(rot) - ey * Math.sin(rot),
                y: cy + ex * Math.sin(rot) + ey * Math.cos(rot),
            });
        }
        return pts;
    }

    function pushPts(ring, pts) {
        for (const p of pts) {
            const last = ring[ring.length - 1];
            if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) ring.push({ x: p.x, y: p.y });
        }
    }

    /**
     * Flatten every boundary path to a closed ring of points.
     * helpers.bulgePoints(p0, p1, bulge) → points (reuses the viewer's own bulge
     * maths); helpers.curveSegments(radius, sweep) → segment count.
     */
    function buildHatchLoops(hatch, helpers) {
        const segFor = helpers?.curveSegments || ((r, sweep) => Math.max(8, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * 64)));
        const bulgePoints = helpers?.bulgePoints;
        const loops = [];

        for (const path of hatch.paths || []) {
            const ring = [];
            if (path.polyline) {
                const vs = path.vertices || [];
                for (let k = 0; k < vs.length; k++) {
                    const a = vs[k];
                    const b = vs[(k + 1) % vs.length];
                    if (k === vs.length - 1 && !path.closed) break;
                    if (a.bulge && bulgePoints) pushPts(ring, bulgePoints(a, b, a.bulge));
                    else { pushPts(ring, [a]); pushPts(ring, [b]); }
                }
            } else {
                for (const edge of path.edges || []) {
                    if (edge.type === 1) {
                        pushPts(ring, [{ x: edge.d['10'] || 0, y: edge.d['20'] || 0 },
                                       { x: edge.d['11'] || 0, y: edge.d['21'] || 0 }]);
                    } else if (edge.type === 2) {
                        const d = edge.d;
                        pushPts(ring, arcPoints(d['10'] || 0, d['20'] || 0, d['40'] || 0,
                            d['50'] || 0, d['51'] || 360, d['73'] === undefined ? true : d['73'] === 1, segFor));
                    } else if (edge.type === 3) {
                        pushPts(ring, ellipseEdgePoints(edge.d, segFor));
                    } else if (edge.type === 4) {
                        // Splines are approximated by their fit points when present,
                        // otherwise by the control polygon.
                        pushPts(ring, edge.fits?.length ? edge.fits : (edge.controls || []));
                    }
                }
            }
            if (ring.length >= 3) {
                const first = ring[0], last = ring[ring.length - 1];
                if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-9) ring.push({ x: first.x, y: first.y });
                loops.push(ring);
            }
        }
        return loops;
    }

    // ===================== Nesting (islands) =====================

    function ringArea(ring) {
        let a = 0;
        for (let i = 0; i < ring.length - 1; i++) a += ring[i].x * ring[i + 1].y - ring[i + 1].x * ring[i].y;
        return a / 2;
    }

    function pointInRing(pt, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
            const yi = ring[i].y, yj = ring[j].y;
            if ((yi > pt.y) !== (yj > pt.y)) {
                const x = ring[i].x + (pt.y - yi) / (yj - yi) * (ring[j].x - ring[i].x);
                if (pt.x < x) inside = !inside;
            }
        }
        return inside;
    }

    /**
     * Even-odd nesting: a loop enclosed by an odd number of other loops is a hole.
     * Each hole is attached to the smallest loop containing it.
     */
    function classifyLoops(loops) {
        const info = loops.map(ring => ({ ring, area: Math.abs(ringArea(ring)), depth: 0 }));
        for (let i = 0; i < info.length; i++) {
            const probe = info[i].ring[0];
            for (let j = 0; j < info.length; j++) {
                if (i === j) continue;
                if (pointInRing(probe, info[j].ring)) info[i].depth++;
            }
        }
        const outers = info.filter(l => l.depth % 2 === 0).map(l => ({ ring: l.ring, area: l.area, holes: [] }));
        for (const l of info) {
            if (l.depth % 2 === 0) continue;
            let best = null;
            for (const o of outers) {
                if (o.area <= l.area) continue;
                if (!pointInRing(l.ring[0], o.ring)) continue;
                if (!best || o.area < best.area) best = o;
            }
            (best || outers[0])?.holes.push(l.ring);
        }
        return outers;
    }

    // ===================== Pattern fills =====================

    function ringsBBox(loops) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const ring of loops) for (const p of ring) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
        return { minX, minY, maxX, maxY };
    }

    /**
     * Slice one infinite line against the boundary using the even-odd rule: sort the
     * crossings along the line and keep alternate spans. Islands fall out for free.
     */
    function clipLineToLoops(org, dir, loops) {
        const ts = [];
        for (const ring of loops) {
            for (let i = 0; i < ring.length - 1; i++) {
                const a = ring[i], b = ring[i + 1];
                const ex = b.x - a.x, ey = b.y - a.y;
                const denom = dir.x * ey - dir.y * ex;
                if (Math.abs(denom) < 1e-12) continue; // parallel
                // Solve org + t*dir = a + u*edge (Cramer's rule).
                const px = a.x - org.x, py = a.y - org.y;
                const t = (px * ey - py * ex) / denom;       // along the hatch line
                const u = (px * dir.y - py * dir.x) / denom; // along the edge
                if (u >= -1e-9 && u < 1 - 1e-9) ts.push(t);   // half-open: no double count at vertices
            }
        }
        if (ts.length < 2) return [];
        ts.sort((p, q) => p - q);
        const spans = [];
        for (let i = 0; i + 1 < ts.length; i += 2) {
            if (ts[i + 1] - ts[i] > 1e-9) spans.push([ts[i], ts[i + 1]]);
        }
        return spans;
    }

    function applyDashes(spans, dashes, phase0) {
        if (!dashes || !dashes.length) return spans;
        const period = dashes.reduce((s, d) => s + Math.abs(d), 0);
        if (!(period > EPS)) return spans;
        const out = [];
        for (const [s0, s1] of spans) {
            // Walk the dash pattern from the line origin so adjacent lines stay in step.
            let base = Math.floor((s0 - phase0) / period) * period + phase0;
            for (let guard = 0; base < s1 && guard < 10000; guard++) {
                let cursor = base;
                for (const d of dashes) {
                    const len = Math.abs(d);
                    if (d > 0 || d === 0) {          // pen down (a dot renders as a tiny dash)
                        const a = Math.max(cursor, s0);
                        const b = Math.min(cursor + (d === 0 ? 1e-6 : len), s1);
                        if (b > a) out.push([a, b]);
                    }
                    cursor += len === 0 ? 1e-6 : len;
                }
                base += period;
            }
        }
        return out;
    }

    /**
     * Generate the line segments for a pattern hatch.
     * maxSegments guards against pathological scales producing millions of lines.
     */
    function patternSegments(hatch, loops, maxSegments = 20000) {
        const segs = [];
        if (!loops.length) return segs;
        const bbox = ringsBBox(loops);
        if (!Number.isFinite(bbox.minX)) return segs;
        const diag = Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) || 1;

        const families = [...(hatch.patternLines || [])];
        if (hatch.double) {
            for (const pl of [...families]) {
                families.push({ ...pl, angle: pl.angle + 90, offset: { x: pl.offset.x, y: pl.offset.y } });
            }
        }

        for (const pl of families) {
            const th = pl.angle * DEG;
            const dir = { x: Math.cos(th), y: Math.sin(th) };
            const nrm = { x: -Math.sin(th), y: Math.cos(th) };
            const spacing = pl.offset.y;
            if (!(Math.abs(spacing) > 1e-9)) continue; // degenerate definition

            // Perpendicular extent of the boundary relative to the pattern base.
            const corners = [
                { x: bbox.minX, y: bbox.minY }, { x: bbox.maxX, y: bbox.minY },
                { x: bbox.maxX, y: bbox.maxY }, { x: bbox.minX, y: bbox.maxY },
            ];
            let pMin = Infinity, pMax = -Infinity;
            for (const c of corners) {
                const p = (c.x - pl.base.x) * nrm.x + (c.y - pl.base.y) * nrm.y;
                if (p < pMin) pMin = p;
                if (p > pMax) pMax = p;
            }
            const k0 = Math.floor(pMin / Math.abs(spacing)) - 1;
            const k1 = Math.ceil(pMax / Math.abs(spacing)) + 1;
            if (!Number.isFinite(k0) || !Number.isFinite(k1)) continue;
            if ((k1 - k0) > 100000) continue; // pattern scale is nonsense for this boundary

            for (let k = k0; k <= k1; k++) {
                const org = {
                    x: pl.base.x + (pl.offset.x * k) * dir.x + (spacing * k) * nrm.x,
                    y: pl.base.y + (pl.offset.x * k) * dir.y + (spacing * k) * nrm.y,
                };
                let spans = clipLineToLoops(org, dir, loops);
                if (!spans.length) continue;
                spans = applyDashes(spans, pl.dashes, 0);
                for (const [t0, t1] of spans) {
                    if (t1 - t0 < 1e-9) continue;
                    segs.push({
                        x1: org.x + dir.x * t0, y1: org.y + dir.y * t0,
                        x2: org.x + dir.x * t1, y2: org.y + dir.y * t1,
                    });
                    if (segs.length >= maxSegments) return segs;
                }
            }
        }
        return segs;
    }

    /** Point-in-hatch test for selection (even-odd across every loop). */
    function pointInHatch(pt, loops) {
        let inside = false;
        for (const ring of loops) if (pointInRing(pt, ring)) inside = !inside;
        return inside;
    }


    // ===================== Pattern library =====================
    // The standard ANSI definitions (as they appear in acad.pat). Values are in
    // pattern units and get scaled/rotated before they are written to the file,
    // because CAD applications store hatch pattern data already transformed.
    const PATTERN_DEFS = {
        SOLID: [],
        ANSI31: [{ angle: 45, base: { x: 0, y: 0 }, offset: { x: 0, y: 0.125 }, dashes: [] }],
        ANSI32: [
            { angle: 45, base: { x: 0, y: 0 }, offset: { x: 0, y: 0.375 }, dashes: [] },
            { angle: 45, base: { x: 0.176776695, y: 0 }, offset: { x: 0, y: 0.375 }, dashes: [] },
        ],
        ANSI37: [
            { angle: 45, base: { x: 0, y: 0 }, offset: { x: 0, y: 0.125 }, dashes: [] },
            { angle: 135, base: { x: 0, y: 0 }, offset: { x: 0, y: 0.125 }, dashes: [] },
        ],
        NET: [
            { angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 0.125 }, dashes: [] },
            { angle: 90, base: { x: 0, y: 0 }, offset: { x: 0, y: 0.125 }, dashes: [] },
        ],
        DASHED: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 0.125 }, dashes: [0.25, -0.125] }],
    };

    function patternNames() { return Object.keys(PATTERN_DEFS); }

    /** Scale + rotate a pattern definition. Offsets are frame-relative, so they only scale. */
    function transformPattern(defs, scale, angleDeg) {
        const s = scale > 0 ? scale : 1;
        const th = (angleDeg || 0) * DEG;
        const cos = Math.cos(th), sin = Math.sin(th);
        return defs.map(d => ({
            angle: d.angle + (angleDeg || 0),
            base: {
                x: (d.base.x * s) * cos - (d.base.y * s) * sin,
                y: (d.base.x * s) * sin + (d.base.y * s) * cos,
            },
            offset: { x: d.offset.x * s, y: d.offset.y * s },
            dashes: d.dashes.map(v => v * s),
        }));
    }

    // ===================== Boundary from existing entities =====================

    /** Turn a closed entity into a HATCH boundary path. Returns null if unusable. */
    function boundaryFromEntity(entity) {
        if (!entity) return null;
        const t = String(entity.type || '').toUpperCase();
        if (t === 'LWPOLYLINE' || t === 'POLYLINE') {
            const verts = (entity.vertices || []).map(v => ({ x: v.x, y: v.y, bulge: Number(v.bulge) || 0 }));
            if (verts.length < 3) return null;
            const closed = !!(entity.shape || entity.closed);
            if (!closed) {
                // Only accept an open polyline whose ends already coincide.
                const a = verts[0], b = verts[verts.length - 1];
                if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-7) return null;
                verts.pop();
                if (verts.length < 3) return null;
            }
            const hasBulge = verts.some(v => Math.abs(v.bulge) > 1e-12);
            return { flags: 2, polyline: true, closed: true, hasBulge, vertices: verts };
        }
        if (t === 'CIRCLE') {
            const c = entity.center || {};
            const r = Number(entity.radius) || 0;
            if (!(r > 0)) return null;
            return { flags: 0, polyline: false, edges: [{ type: 2, d: { '10': c.x, '20': c.y, '40': r, '50': 0, '51': 360, '73': 1 } }] };
        }
        if (t === 'ELLIPSE') {
            const c = entity.center || {};
            const mp = entity.majorAxisEndPoint || {};
            const ratio = Number(entity.axisRatio ?? entity.ratio) || 1;
            if (!Number.isFinite(c.x) || !Number.isFinite(mp.x)) return null;
            return { flags: 0, polyline: false, edges: [{ type: 3, d: { '10': c.x, '20': c.y, '11': mp.x, '21': mp.y, '40': ratio, '50': 0, '51': 360, '73': 1 } }] };
        }
        return null;
    }

    /**
     * Build a HATCH from boundary entities. Paths enclosed by another path are
     * flagged as islands; the odd-parity style then cuts them out anywhere.
     */
    function makeHatchFromEntities(entities, opts) {
        const o = opts || {};
        const paths = [];
        for (const e of entities || []) {
            const p = boundaryFromEntity(e);
            if (p) paths.push(p);
        }
        if (!paths.length) return null;

        const name = PATTERN_DEFS[o.patternName] ? o.patternName : 'SOLID';
        const solid = name === 'SOLID';
        const hatch = {
            type: 'HATCH', layer: o.layer || '0',
            patternName: name, solid, gradient: false,
            style: 0, patternAngle: o.angle || 0, patternScale: o.scale > 0 ? o.scale : 1,
            double: false, elevation: 0, paths,
            patternLines: solid ? [] : transformPattern(PATTERN_DEFS[name], o.scale, o.angle),
            colorNumber: null, trueColor: null,
        };
        // Island flags: a path contained by another is "outermost", not "external".
        const loops = buildHatchLoops(hatch, o.helpers || {});
        const areas = loops.map(r => Math.abs(ringArea(r)));
        loops.forEach((ring, i) => {
            let contained = false;
            for (let j = 0; j < loops.length; j++) {
                if (i === j || areas[j] <= areas[i]) continue;
                if (pointInRing(ring[0], loops[j])) { contained = true; break; }
            }
            if (paths[i]) paths[i].flags |= contained ? 16 : 1;
        });
        return hatch;
    }

    // ===================== Emission =====================

    function emitHatchPairs(hatch, handle, layer) {
        const n = (v) => String(Math.round(Number(v) * 1e9) / 1e9);
        const out = [
            '0', 'HATCH', '5', String(handle), '8', layer || hatch.layer || '0',
            '100', 'AcDbEntity', '100', 'AcDbHatch',
            '10', '0', '20', '0', '30', n(hatch.elevation || 0),
            '210', '0', '220', '0', '230', '1',
            '2', hatch.patternName || 'SOLID',
            '70', hatch.solid ? '1' : '0',
            '71', '0',                       // non-associative
            '91', String(hatch.paths.length),
        ];
        for (const p of hatch.paths) {
            out.push('92', String(p.flags | (p.polyline ? 2 : 0)));
            if (p.polyline) {
                out.push('72', p.hasBulge ? '1' : '0', '73', '1', '93', String(p.vertices.length));
                for (const v of p.vertices) {
                    out.push('10', n(v.x), '20', n(v.y));
                    if (p.hasBulge) out.push('42', n(v.bulge || 0));
                }
            } else {
                out.push('93', String(p.edges.length));
                for (const e of p.edges) {
                    out.push('72', String(e.type));
                    if (e.type === 1) {
                        out.push('10', n(e.d['10']), '20', n(e.d['20']), '11', n(e.d['11']), '21', n(e.d['21']));
                    } else if (e.type === 2) {
                        out.push('10', n(e.d['10']), '20', n(e.d['20']), '40', n(e.d['40']),
                                 '50', n(e.d['50']), '51', n(e.d['51']), '73', String(e.d['73'] ?? 1));
                    } else if (e.type === 3) {
                        out.push('10', n(e.d['10']), '20', n(e.d['20']), '11', n(e.d['11']), '21', n(e.d['21']),
                                 '40', n(e.d['40']), '50', n(e.d['50']), '51', n(e.d['51']), '73', String(e.d['73'] ?? 1));
                    }
                }
            }
            out.push('97', '0');            // no associated source objects
        }
        out.push('75', String(hatch.style || 0), '76', '1');
        if (!hatch.solid) {
            out.push('52', n(hatch.patternAngle || 0), '41', n(hatch.patternScale || 1), '77', '0',
                     '78', String(hatch.patternLines.length));
            for (const pl of hatch.patternLines) {
                out.push('53', n(pl.angle), '43', n(pl.base.x), '44', n(pl.base.y),
                         '45', n(pl.offset.x), '46', n(pl.offset.y), '79', String(pl.dashes.length));
                for (const d of pl.dashes) out.push('49', n(d));
            }
        }
        out.push('98', '0');                // no seed points
        return out;
    }

    /**
     * Re-pattern an existing hatch in place: updates pattern name, scale, angle and
     * the derived pattern-line definitions. Boundary paths are untouched, so the
     * fill still covers exactly the same area.
     */
    function applyPatternToHatch(hatch, opts) {
        const o = opts || {};
        const name = PATTERN_DEFS[o.patternName] ? o.patternName : hatch.patternName;
        const solid = name === 'SOLID';
        hatch.patternName = name;
        hatch.solid = solid;
        hatch.gradient = false;
        if (Number.isFinite(o.scale) && o.scale > 0) hatch.patternScale = o.scale;
        if (Number.isFinite(o.angle)) hatch.patternAngle = o.angle;
        hatch.patternLines = solid ? [] : transformPattern(PATTERN_DEFS[name], hatch.patternScale, hatch.patternAngle);
        return hatch;
    }

    // ===================== Grip editing =====================
    // The viewer needs movable control points for a hatch's boundary. An "anchor"
    // is one such point; several structure slots may share it (consecutive LINE
    // edges meet at the same coordinate), so moving an anchor keeps the loop
    // closed instead of tearing it open.

    function hatchAnchors(hatch, tol) {
        const eps = Number.isFinite(tol) ? tol : 1e-7;
        const out = [];
        const paths = hatch && hatch.paths ? hatch.paths : [];
        for (let pi = 0; pi < paths.length; pi++) {
            const path = paths[pi];
            if (path.polyline) {
                const vs = path.vertices || [];
                for (let vi = 0; vi < vs.length; vi++) {
                    out.push({
                        x: num(vs[vi].x), y: num(vs[vi].y), pathIndex: pi,
                        slots: [{ kind: 'v', vi }],
                    });
                }
            } else {
                const edges = path.edges || [];
                for (let ei = 0; ei < edges.length; ei++) {
                    const e = edges[ei];
                    if (e.type !== 1) continue;   // only line edges have movable ends
                    const ends = [
                        { x: num(e.d['10']), y: num(e.d['20']), slot: { kind: 'e', ei, xk: '10', yk: '20' } },
                        { x: num(e.d['11']), y: num(e.d['21']), slot: { kind: 'e', ei, xk: '11', yk: '21' } },
                    ];
                    for (const end of ends) {
                        let merged = null;
                        for (const a of out) {
                            if (a.pathIndex !== pi) continue;
                            if (Math.hypot(a.x - end.x, a.y - end.y) <= eps) { merged = a; break; }
                        }
                        if (merged) merged.slots.push(end.slot);
                        else out.push({ x: end.x, y: end.y, pathIndex: pi, slots: [end.slot] });
                    }
                }
            }
        }
        return out;
    }

    /** Write an anchor's new position back into every structure slot it covers. */
    function setHatchAnchor(hatch, anchor, x, y) {
        const path = hatch && hatch.paths ? hatch.paths[anchor && anchor.pathIndex] : null;
        if (!path || !anchor) return false;
        for (const s of anchor.slots || []) {
            if (s.kind === 'v') {
                const v = (path.vertices || [])[s.vi];
                if (v) { v.x = x; v.y = y; }
            } else {
                const e = (path.edges || [])[s.ei];
                if (e && e.d) { e.d[s.xk] = x; e.d[s.yk] = y; }
            }
        }
        anchor.x = x; anchor.y = y;
        return true;
    }

    /**
     * Straight boundary segments, expressed as index pairs into `anchors`.
     * Bulged polyline spans and curved edges are skipped — dragging those as a
     * whole would need an arc solve, which grips do not attempt.
     */
    function hatchStraightSegments(hatch, anchors) {
        const list = anchors || hatchAnchors(hatch);
        const out = [];
        const findPoly = (pi, vi) => list.findIndex(a => a.pathIndex === pi &&
            (a.slots || []).some(s => s.kind === 'v' && s.vi === vi));
        const findEdge = (pi, ei, xk) => list.findIndex(a => a.pathIndex === pi &&
            (a.slots || []).some(s => s.kind === 'e' && s.ei === ei && s.xk === xk));

        const paths = hatch && hatch.paths ? hatch.paths : [];
        for (let pi = 0; pi < paths.length; pi++) {
            const path = paths[pi];
            if (path.polyline) {
                const vs = path.vertices || [];
                for (let k = 0; k < vs.length; k++) {
                    const a = vs[k], b = vs[(k + 1) % vs.length];
                    if (k === vs.length - 1 && path.closed === false) break;
                    if (Math.abs(num(a.bulge)) > 1e-12) continue;
                    const ia = findPoly(pi, k), ib = findPoly(pi, (k + 1) % vs.length);
                    if (ia < 0 || ib < 0 || ia === ib) continue;
                    out.push({ pathIndex: pi, a: ia, b: ib, x1: num(a.x), y1: num(a.y), x2: num(b.x), y2: num(b.y) });
                }
            } else {
                const edges = path.edges || [];
                for (let ei = 0; ei < edges.length; ei++) {
                    if (edges[ei].type !== 1) continue;
                    const d = edges[ei].d;
                    const ia = findEdge(pi, ei, '10'), ib = findEdge(pi, ei, '11');
                    if (ia < 0 || ib < 0 || ia === ib) continue;
                    out.push({
                        pathIndex: pi, a: ia, b: ib,
                        x1: num(d['10']), y1: num(d['20']), x2: num(d['11']), y2: num(d['21']),
                    });
                }
            }
        }
        return out;
    }

    /** Circular boundary edges, which can be resized by a perimeter grip. */
    function hatchCircleEdges(hatch) {
        const out = [];
        const paths = hatch && hatch.paths ? hatch.paths : [];
        for (let pi = 0; pi < paths.length; pi++) {
            const path = paths[pi];
            if (path.polyline) continue;
            const edges = path.edges || [];
            for (let ei = 0; ei < edges.length; ei++) {
                const e = edges[ei];
                if (e.type !== 2) continue;
                const r = num(e.d['40']);
                if (!(r > 0)) continue;
                out.push({ pathIndex: pi, edgeIndex: ei, cx: num(e.d['10']), cy: num(e.d['20']), radius: r });
            }
        }
        return out;
    }

    function setHatchCircleRadius(hatch, ref, radius) {
        const path = hatch && hatch.paths ? hatch.paths[ref && ref.pathIndex] : null;
        const e = path && path.edges ? path.edges[ref.edgeIndex] : null;
        if (!e || !e.d || !(radius > 0)) return false;
        e.d['40'] = radius;
        return true;
    }

    /**
     * Shift every boundary path by (dx, dy). Pattern base points move with it:
     * they are absolute WCS coordinates, so leaving them behind would make the
     * fill slide underneath the shape.
     */
    function translateHatch(hatch, dx, dy) {
        if (!hatch || !(Number.isFinite(dx) && Number.isFinite(dy))) return hatch;
        for (const path of hatch.paths || []) {
            if (path.polyline) {
                for (const v of path.vertices || []) { v.x = num(v.x) + dx; v.y = num(v.y) + dy; }
                continue;
            }
            for (const e of path.edges || []) {
                if (e.type === 4) {
                    for (const c of e.controls || []) { c.x = num(c.x) + dx; c.y = num(c.y) + dy; }
                    for (const f of e.fits || []) { f.x = num(f.x) + dx; f.y = num(f.y) + dy; }
                    continue;
                }
                const d = e.d;
                if (!d) continue;
                d['10'] = num(d['10']) + dx;
                d['20'] = num(d['20']) + dy;
                // 11/21 is a second absolute point on a LINE edge, but the major
                // axis vector (relative to the centre) on an ELLIPSE edge.
                if (e.type === 1) { d['11'] = num(d['11']) + dx; d['21'] = num(d['21']) + dy; }
            }
        }
        for (const pl of hatch.patternLines || []) {
            if (!pl.base) continue;
            pl.base.x = num(pl.base.x) + dx;
            pl.base.y = num(pl.base.y) + dy;
        }
        return hatch;
    }

    /**
     * Read WIPEOUT entities from raw DXF text (dxf-parser drops them).
     * Inverse of the emit mapping, with the general (possibly rotated) u/v
     * frame honoured: world = insert + u*(x'+0.5) + v*(0.5-y'). Returns
     * viewer-shaped entities with __rawKey following the E:{index} scheme.
     */
    function parseRawDxfWipeouts(rawText) {
        const out = [];
        if (!rawText) return out;
        const lines = String(rawText).replace(/\r\n/g, '\n').split('\n');
        let i = 0, section = null, entityIdx = 0;
        while (i < lines.length - 1) {
            const code = (lines[i] ?? '').trim();
            const value = (lines[i + 1] ?? '').trim();
            if (code === '0' && value.toUpperCase() === 'SECTION') {
                const c2 = (lines[i + 2] ?? '').trim();
                section = c2 === '2' ? (lines[i + 3] ?? '').trim().toUpperCase() : null;
                entityIdx = 0;
                i += 4; continue;
            }
            if (code === '0' && value.toUpperCase() === 'ENDSEC') { section = null; i += 2; continue; }
            if (section === 'ENTITIES' && code === '0') {
                const type = value.toUpperCase();
                let j = i + 2;
                const pairs = [];
                while (j < lines.length - 1) {
                    const c = (lines[j] ?? '').trim();
                    if (c === '0') break;
                    pairs.push([c, (lines[j + 1] ?? '').trim()]);
                    j += 2;
                }
                if (type === 'WIPEOUT') {
                    const e = { handle: '', layer: '0', inPaperSpace: false };
                    const insert = { x: 0, y: 0 }, u = { x: 1, y: 0 }, v = { x: 0, y: 1 };
                    const clip = [];
                    let cur = null;
                    for (const [c, val] of pairs) {
                        const f = parseFloat(val);
                        switch (c) {
                            case '5': e.handle = val; break;
                            case '8': e.layer = val; break;
                            case '62': e.colorIndex = parseInt(val, 10); break;
                            case '420': e.trueColor = parseInt(val, 10); break;
                            case '67': e.inPaperSpace = parseInt(val, 10) === 1; break;
                            case '10': insert.x = f; break;
                            case '20': insert.y = f; break;
                            case '11': u.x = f; break;
                            case '21': u.y = f; break;
                            case '12': v.x = f; break;
                            case '22': v.y = f; break;
                            case '14': cur = { x: f, y: 0 }; clip.push(cur); break;
                            case '24': if (cur) cur.y = f; break;
                        }
                    }
                    // Drop the duplicated closing vertex.
                    if (clip.length > 1) {
                        const a = clip[0], b = clip[clip.length - 1];
                        if (Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12) clip.pop();
                    }
                    if (clip.length >= 3) {
                        const vertices = clip.map(cv => {
                            const fx = cv.x + 0.5;
                            const fy = 0.5 - cv.y;
                            return {
                                x: insert.x + u.x * fx + v.x * fy,
                                y: insert.y + u.y * fx + v.y * fy,
                                z: 0,
                            };
                        });
                        out.push({ type: 'WIPEOUT', ...e, vertices, closed: true, __rawKey: `E:${entityIdx}` });
                    }
                }
                entityIdx++;
                i = j; continue;
            }
            i += 2;
        }
        return out;
    }

    /**
     * Read table entities from raw DXF text (dxf-parser drops them).
     * Accepts BOTH spellings: AutoCAD writes 0/ACAD_TABLE; libredwg's DXF
     * writer emits 0/TABLE for pre-R2010 output. Returns first-class
     * ACAD_TABLE entities carrying the full cell model:
     *   { type:'ACAD_TABLE', position, rotation(deg), rows, cols,
     *     colWidths[], rowHeights[], cells:[{type,text,align}] row-major,
     *     blockName, handle, layer, inPaperSpace, __acadTable, __rawKey }
     * Row/column counts (91/92) are read only from the AcDbTable subclass
     * BEFORE the first cell marker (171) — the per-cell blobs reuse code 91
     * for cell flags. Cell text comes from classic code 1 (plus 3 overflow
     * chunks) or, failing that, the 2008+ extended 302 chunks.
     * R2010+ DWGs converted by libredwg produce a BARE 0/ACAD_TABLE marker
     * with no data at all (dwg_dxf_TABLECONTENT is a release-build stub);
     * such markers come back with __unsupported:true so the host can warn.
     */
    function parseRawDxfAcadTables(rawText) {
        const out = [];
        if (!rawText) return out;
        const lines = String(rawText).replace(/\r\n/g, '\n').split('\n');
        let i = 0, section = null, entityIdx = 0;
        while (i < lines.length - 1) {
            const code = (lines[i] ?? '').trim();
            const value = (lines[i + 1] ?? '').trim();
            if (code === '0' && value.toUpperCase() === 'SECTION') {
                const c2 = (lines[i + 2] ?? '').trim();
                section = c2 === '2' ? (lines[i + 3] ?? '').trim().toUpperCase() : null;
                entityIdx = 0;
                i += 4; continue;
            }
            if (code === '0' && value.toUpperCase() === 'ENDSEC') { section = null; i += 2; continue; }
            if (section === 'ENTITIES' && code === '0') {
                const type = value.toUpperCase();
                let j = i + 2;
                const pairs = [];
                while (j < lines.length - 1) {
                    const c = (lines[j] ?? '').trim();
                    if (c === '0') break;
                    pairs.push([c, (lines[j + 1] ?? '').trim()]);
                    j += 2;
                }
                if (type === 'ACAD_TABLE' || type === 'TABLE') {
                    const e = parseTablePairs(pairs, entityIdx);
                    if (e) out.push(e);
                }
                entityIdx++;
                i = j; continue;
            }
            i += 2;
        }
        return out;
    }

    // One table's group-code pairs → entity, or an __unsupported marker for
    // the bare-ACAD_TABLE case (R2010+ DWG through libredwg's stub writer).
    function parseTablePairs(pairs, entityIdx) {
        if (!pairs.length) {
            return { type: 'ACAD_TABLE', __acadTable: true, __unsupported: true, __rawKey: `E:${entityIdx}` };
        }
        const e = {
            type: 'ACAD_TABLE', handle: '', layer: '0', inPaperSpace: false,
            position: { x: 0, y: 0, z: 0 }, rotation: 0,
            rows: 0, cols: 0, colWidths: [], rowHeights: [], cells: [],
            blockName: '', __acadTable: true, __rawKey: `E:${entityIdx}`,
        };
        const dir = { x: 1, y: 0 };
        let subclass = '', sawDir = false, hasRot50 = false, inCells = false;
        let cell = null;
        const finishCell = () => { if (cell) e.cells.push(cell); cell = null; };
        for (const [c, val] of pairs) {
            const f = parseFloat(val);
            if (c === '100') { subclass = val; continue; }
            if (c === '171') { finishCell(); inCells = true; cell = { type: parseInt(val, 10) || 0, text1: [], text3: [], text302: [], align: 0, spanC: 1, spanR: 1, merged: false, textHeight: 0 }; continue; }
            if (inCells) {
                if (!cell) continue;
                if (c === '1') cell.text1.push(val);
                else if (c === '3') cell.text3.push(val);
                else if (c === '302') cell.text302.push(val);
                else if (c === '170') cell.align = parseInt(val, 10) || 0;
                else if (c === '173') cell.merged = parseInt(val, 10) === 1;
                else if (c === '175') cell.spanC = Math.max(1, parseInt(val, 10) || 1);
                else if (c === '176') cell.spanR = Math.max(1, parseInt(val, 10) || 1);
                else if (c === '140') cell.textHeight = parseFloat(val) || 0;
                continue;
            }
            switch (c) {
                case '5': e.handle = val; break;
                case '8': e.layer = val; break;
                case '62': e.colorIndex = parseInt(val, 10); break;
                case '420': e.trueColor = parseInt(val, 10); break;
                case '67': e.inPaperSpace = parseInt(val, 10) === 1; break;
                case '2': if (!e.blockName) e.blockName = val; break;
                case '342': if (!e.tableStyleHandle) e.tableStyleHandle = val; break;
                case '10': if (subclass !== 'AcDbTable') e.position.x = Number.isFinite(f) ? f : 0; break;
                case '20': if (subclass !== 'AcDbTable') e.position.y = Number.isFinite(f) ? f : 0; break;
                case '50': if (Number.isFinite(f)) { e.rotation = f; hasRot50 = true; } break;
                case '11': if (!sawDir && Number.isFinite(f)) { dir.x = f; sawDir = true; } break;
                case '21': if (sawDir && Number.isFinite(f)) dir.y = f; break;
                case '91': if (subclass === 'AcDbTable' && !e.rows) e.rows = parseInt(val, 10) || 0; break;
                case '92': if (subclass === 'AcDbTable' && !e.cols) e.cols = parseInt(val, 10) || 0; break;
                case '142': if (Number.isFinite(f)) e.colWidths.push(f); break;
                case '141': if (Number.isFinite(f)) e.rowHeights.push(f); break;
            }
        }
        finishCell();
        if (!hasRot50 && (dir.x !== 1 || dir.y !== 0)) {
            e.rotation = Math.atan2(dir.y, dir.x) * 180 / Math.PI;
        }
        // Normalize: text from classic 1 (+3 overflow) else extended 302 chunks.
        e.cells = e.cells.map(c => ({
            type: c.type,
            text: (c.text1.length ? c.text1.concat(c.text3) : c.text302).join(''),
            align: c.align,
            spanC: c.spanC || 1, spanR: c.spanR || 1,
            textHeight: c.textHeight || 0,
        }));
        // Pad/trim the arrays so geometry code can trust rows*cols.
        if (e.rows > 0 && e.cols > 0) {
            while (e.colWidths.length < e.cols) e.colWidths.push(e.colWidths[e.colWidths.length - 1] || 10);
            while (e.rowHeights.length < e.rows) e.rowHeights.push(e.rowHeights[e.rowHeights.length - 1] || 5);
            e.colWidths.length = e.cols;
            e.rowHeights.length = e.rows;
            const n = e.rows * e.cols;
            while (e.cells.length < n) e.cells.push({ type: 1, text: '', align: 0, spanC: 1, spanR: 1, textHeight: 0 });
            e.cells.length = n;
            markCoveredCells(e);
        }
        if (!e.rows || !e.cols) {
            return { type: 'ACAD_TABLE', __acadTable: true, __unsupported: true, __rawKey: `E:${entityIdx}`, handle: e.handle, layer: e.layer };
        }
        return e;
    }

    /**
     * World-space geometry for a table entity: grid line segments plus a
     * per-cell layout record. Insertion point = TOP-LEFT corner; the table
     * grows to the right along the rotated x-axis and DOWNWARD from it.
     * cells[i] = { index, row, col, corners:[tl,tr,br,bl], cx, cy, w, h }
     * with corners/centers already rotated into world coordinates.
     */
    // Coverage map for merged regions: a cell with spanC/spanR > 1 is the
    // ROOT of its merge; every other cell inside the span is COVERED and
    // renders as part of the root. Spans are clamped to the grid so a
    // malformed file cannot push coverage out of bounds.
    function markCoveredCells(e) {
        const rows = e.rows, cols = e.cols;
        for (const c of e.cells) { delete c.covered; delete c.rootIndex; }
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const i = r * cols + c;
                const cell = e.cells[i];
                if (!cell || cell.covered) continue;
                const sc = Math.min(cell.spanC || 1, cols - c);
                const sr = Math.min(cell.spanR || 1, rows - r);
                cell.spanC = sc; cell.spanR = sr;
                if (sc === 1 && sr === 1) continue;
                for (let rr = r; rr < r + sr; rr++) {
                    for (let cc = c; cc < c + sc; cc++) {
                        const j = rr * cols + cc;
                        if (j === i) continue;
                        const cov = e.cells[j];
                        if (cov && !cov.covered && (cov.spanC || 1) === 1 && (cov.spanR || 1) === 1) {
                            cov.covered = true; cov.rootIndex = i;
                        }
                    }
                }
            }
        }
    }

    function acadTableGeometry(e) {
        const rot = (Number(e.rotation) || 0) * Math.PI / 180;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const px = e.position?.x || 0, py = e.position?.y || 0;
        const W = (e.colWidths || []).reduce((a, b) => a + b, 0);
        const H = (e.rowHeights || []).reduce((a, b) => a + b, 0);
        // local (lx right, ly down) → world
        const w = (lx, ly) => ({ x: px + lx * cos + ly * sin, y: py + lx * sin - ly * cos });
        const rows = e.rows || 0, cols = e.cols || 0;
        const cum = (arr) => { const out = [0]; for (const v of arr || []) out.push(out[out.length - 1] + v); return out; };
        const cx = cum(e.colWidths), cy = cum(e.rowHeights);
        // Root lookup so grid lines interior to a merged region are skipped.
        const rootAt = (r, c) => {
            const cell = e.cells?.[r * cols + c];
            if (!cell) return r * cols + c;
            return cell.covered ? cell.rootIndex : r * cols + c;
        };
        const segments = [];
        const seg = (a, b) => segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        // Vertical boundaries b = 0..cols, drawn per row and skipped where the
        // cells on both sides belong to the same merge root.
        for (let b = 0; b <= cols; b++) {
            for (let r = 0; r < rows; r++) {
                if (b > 0 && b < cols && rootAt(r, b - 1) === rootAt(r, b)) continue;
                seg(w(cx[b], cy[r]), w(cx[b], cy[r + 1]));
            }
        }
        // Horizontal boundaries b = 0..rows, per column, same skip rule.
        for (let b = 0; b <= rows; b++) {
            for (let c = 0; c < cols; c++) {
                if (b > 0 && b < rows && rootAt(b - 1, c) === rootAt(b, c)) continue;
                seg(w(cx[c], cy[b]), w(cx[c + 1], cy[b]));
            }
        }
        const cells = [];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const i = r * cols + c;
                const data = e.cells?.[i];
                if (data?.covered) { cells.push({ index: i, row: r, col: c, covered: true, rootIndex: data.rootIndex }); continue; }
                // A merge root's rectangle spans the whole merged region.
                const sc = data?.spanC || 1, sr = data?.spanR || 1;
                const x0 = cx[c], x1 = cx[Math.min(c + sc, cols)];
                const y0 = cy[r], y1 = cy[Math.min(r + sr, rows)];
                const cw = x1 - x0, rh = y1 - y0;
                const tl = w(x0, y0), trc = w(x1, y0), br = w(x1, y1), bl = w(x0, y1);
                const ctr = w((x0 + x1) / 2, (y0 + y1) / 2);
                const pad = Math.min(cw * 0.08, rh * 0.3);
                cells.push({ index: i, row: r, col: c, corners: [tl, trc, br, bl], cx: ctr.x, cy: ctr.y, w: cw, h: rh,
                    leftMid: w(x0 + pad, (y0 + y1) / 2),
                    rightMid: w(x1 - pad, (y0 + y1) / 2) });
            }
        }
        return { segments, cells, width: W, height: H };
    }

    /**
     * Which cell contains world point (wx, wy)? Inverse-rotates into the
     * table's local frame and walks the cumulative widths/heights.
     * Returns { index, row, col } or null.
     */
    function acadTableCellAt(e, wx, wy) {
        const rot = (Number(e.rotation) || 0) * Math.PI / 180;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const dx = wx - (e.position?.x || 0), dy = wy - (e.position?.y || 0);
        const lx = dx * cos + dy * sin;       // inverse rotation
        const ly = dx * sin - dy * cos;       // local y measured downward
        if (lx < 0 || ly < 0) return null;
        let col = -1, acc = 0;
        for (let c = 0; c < (e.cols || 0); c++) { acc += e.colWidths[c]; if (lx <= acc) { col = c; break; } }
        if (col < 0) return null;
        let row = -1; acc = 0;
        for (let r = 0; r < (e.rows || 0); r++) { acc += e.rowHeights[r]; if (ly <= acc) { row = r; break; } }
        if (row < 0) return null;
        let index = row * e.cols + col;
        const cell = e.cells?.[index];
        if (cell?.covered && Number.isFinite(cell.rootIndex)) {
            index = cell.rootIndex;
            row = Math.floor(index / e.cols);
            col = index % e.cols;
        }
        return { index, row, col };
    }

    const DxfHatch = {
        parseRawDxfHatches, parseRawDxfWipeouts, parseRawDxfAcadTables,
        acadTableGeometry, acadTableCellAt, markCoveredCells,
        buildHatchLoops, classifyLoops,
        patternSegments, pointInHatch, pointInRing, ringArea,
        PATTERN_DEFS, patternNames, transformPattern,
        boundaryFromEntity, makeHatchFromEntities, applyPatternToHatch, emitHatchPairs,
        hatchAnchors, setHatchAnchor, hatchStraightSegments,
        hatchCircleEdges, setHatchCircleRadius, translateHatch,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfHatch;
    if (root) root.DxfHatch = DxfHatch;
})(typeof window !== 'undefined' ? window : null);
