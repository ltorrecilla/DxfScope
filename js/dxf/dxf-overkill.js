/**
 * dxf-overkill.js — CLEAN GEOMETRY: tiny elements, duplicates, collinear merge.
 *
 * Pure analysis, no DOM, never mutates its input. window.DxfOverkill + Node exports.
 * The editor applies the result (undo, delete, raw patches).
 *
 *   DxfOverkill.analyze(entities, {
 *     tiny:       { enabled: true, threshold: 0.1 },
 *     duplicates: true,
 *     merge:      { overlap: true, endToEnd: false },
 *     tolerance:  1e-6,          // drawing units, shared by duplicates + merge
 *     ignoreColor: false, ignoreLinetype: false, ignoreLineweight: false,
 *     isLocked:   (layer) => bool,
 *     measure:    (entity) => size | null   // optional; tiny-pass extent override
 *   })
 *
 *   → {
 *       tiny:       [entity],
 *       duplicates: [{ keep, remove: [entity] }],
 *       merges:     [{ keep, absorb: [entity], a:{x,y,z}, b:{x,y,z}, changed }],
 *       skipped:    { TYPE: n },   // in scope but not handled by duplicates/merge
 *       locked:     n,             // entities left alone on locked layers
 *       scanned:    n,
 *       counts:     { tiny, duplicates, merged, absorbed, removed }
 *     }
 *
 * Passes run in order, each on what survives the previous one:
 *   1. tiny        — extent below threshold (zero-length slivers first, so they
 *                    are never mistaken for duplicates)
 *   2. duplicates  — identical type + style + geometry (direction-free)
 *   3. merge       — overlapping / touching collinear LINEs collapse into one
 *
 * Keep rule everywhere: an imported entity beats one created this session
 * (stable handles keep DXF Compare matching by handle), then file order.
 */
(function (root) {
    'use strict';

    const DEFAULT_TOLERANCE = 1e-6;
    const TAU = Math.PI * 2;
    const PARAM_Q = 1e-9;        // quantum for dimensionless values (bulge, ratio, knots)
    const DEG_Q = 1e-6;          // quantum for angles stored in degrees
    const ANG_TOL = 1e-7;        // radians: direction clustering for the merge pass

    const TINY_TYPES = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE', 'CIRCLE', 'ARC', 'ELLIPSE', 'SPLINE', 'POINT']);
    const DUP_TYPES = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE', 'CIRCLE', 'ARC', 'ELLIPSE', 'SPLINE', 'POINT',
        'TEXT', 'MTEXT', 'INSERT']);

    // ---------------------------------------------------------------- helpers

    const fin = Number.isFinite;
    const typeOf = (e) => String(e && e.type || '').toUpperCase();

    function isImported(e) {
        const k = e && e.__rawKey;
        return !(typeof k === 'string' && k.startsWith('NEW:'));
    }

    /** Pick the entity to keep from a list of { e, idx }. */
    function preferred(items) {
        let best = items[0];
        for (let i = 1; i < items.length; i++) {
            const it = items[i];
            const bi = isImported(best.e), ii = isImported(it.e);
            if (ii && !bi) { best = it; continue; }
            if (ii === bi && it.idx < best.idx) best = it;
        }
        return best;
    }

    function makeQ(tol) {
        return (v) => {
            const n = Number(v);
            if (!fin(n)) return 'x';
            const r = Math.round(n / tol);
            return r === 0 ? '0' : String(r);       // never "-0"
        };
    }

    function normAngle(a) { return ((a % TAU) + TAU) % TAU; }

    function isPaper(e) { return !!(e && (e.inPaperSpace === true || e.__paperSpace === true)); }

    function extrusionSign(e) {
        const z = fin(e.extrusionDirectionZ) ? e.extrusionDirectionZ
            : (e.extrusionDirection && fin(e.extrusionDirection.z) ? e.extrusionDirection.z : 1);
        return z < 0 ? '-' : '+';
    }

    function styleKey(e, o) {
        const parts = [e.layer || '0'];
        if (!o.ignoreColor) {
            const ci = e.colorIndex ?? e.colorNumber;
            parts.push('c' + (ci == null ? 256 : ci) + ':' + (e.color ?? '') + ':' + (e.trueColor ?? ''));
        }
        if (!o.ignoreLinetype) {
            const lt = e.lineType ?? e.linetype ?? e.lineTypeName ?? 'BYLAYER';
            parts.push('l' + String(lt).toUpperCase() + ':' + (fin(e.lineTypeScale) ? e.lineTypeScale : 1));
        }
        if (!o.ignoreLineweight) {
            const lw = e.lineweight ?? e.lineWeight;
            parts.push('w' + (fin(lw) ? lw : -1));
        }
        parts.push(isPaper(e) ? 'P' + (e.layoutName || e.__layoutName || '') : 'M');
        return parts.join('|');
    }

    // ------------------------------------------------------------ tiny pass

    function bulgeArcPoints(p1, p2, bulge, out) {
        const b = Number(bulge) || 0;
        if (Math.abs(b) < 1e-12) return;
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const chord = Math.hypot(dx, dy);
        if (chord < 1e-15) return;
        const theta = 4 * Math.atan(b);
        const r = Math.abs(chord / (2 * Math.sin(theta / 2)));
        const h = r * Math.cos(Math.abs(theta) / 2) * (b >= 0 ? 1 : -1);
        const cx = (p1.x + p2.x) / 2 - (dy / chord) * h;
        const cy = (p1.y + p2.y) / 2 + (dx / chord) * h;
        const a0 = Math.atan2(p1.y - cy, p1.x - cx);
        for (let i = 1; i < 16; i++) {
            const a = a0 + theta * (i / 16);
            out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
        }
    }

    /** Analytic extent (max of bbox width/height). null when it cannot be measured. */
    function defaultMeasure(e) {
        const t = typeOf(e);
        const pts = [];
        if (t === 'POINT') return 0;
        if (t === 'CIRCLE') return fin(e.radius) ? 2 * Math.abs(e.radius) : null;
        if (t === 'LINE' || t === 'LWPOLYLINE' || t === 'POLYLINE') {
            const vs = (e.vertices || []).filter(v => v && fin(v.x) && fin(v.y));
            if (!vs.length) return null;
            const closed = !!(e.shape || e.closed);
            for (let i = 0; i < vs.length; i++) {
                pts.push(vs[i]);
                if (t !== 'LINE' && (i < vs.length - 1 || closed)) bulgeArcPoints(vs[i], vs[(i + 1) % vs.length], vs[i].bulge, pts);
            }
        } else if (t === 'ARC') {
            const c = e.center, r = Math.abs(Number(e.radius));
            if (!c || !fin(r)) return null;
            const s = normAngle(Number(e.startAngle) || 0);
            let sweep = normAngle((Number(e.endAngle) || 0) - s);
            if (sweep < 1e-12) sweep = TAU;
            for (let i = 0; i <= 32; i++) {
                const a = s + sweep * (i / 32);
                pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
            }
        } else if (t === 'ELLIPSE') {
            const c = e.center, m = e.majorAxisEndPoint;
            if (!c || !m) return null;
            const len = Math.hypot(m.x, m.y);
            const ratio = Math.abs(Number(e.axisRatio ?? 1)) || 1;
            const ux = m.x / (len || 1), uy = m.y / (len || 1);
            const s = Number(e.startAngle) || 0;
            let en = fin(e.endAngle) ? Number(e.endAngle) : TAU;
            if (en <= s) en += TAU;
            for (let i = 0; i <= 32; i++) {
                const p = s + (en - s) * (i / 32);
                const ca = Math.cos(p) * len, sa = Math.sin(p) * len * ratio;
                pts.push({ x: c.x + ux * ca - uy * sa, y: c.y + uy * ca + ux * sa });
            }
        } else if (t === 'SPLINE') {
            for (const p of (e.fitPoints && e.fitPoints.length ? e.fitPoints : e.controlPoints) || []) pts.push(p);
        } else {
            return null;
        }
        let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
        for (const p of pts) {
            if (!p || !fin(p.x) || !fin(p.y)) continue;
            if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x;
            if (p.y < mnY) mnY = p.y; if (p.y > mxY) mxY = p.y;
        }
        if (!fin(mnX)) return null;
        return Math.max(mxX - mnX, mxY - mnY);
    }

    /**
     * Entities whose extent is below `threshold`. POINTs have no extent and
     * always qualify (matches the editor's previous cleaner).
     */
    function findTiny(entities, threshold, measure) {
        const out = [];
        if (!(threshold > 0)) return out;
        const m = typeof measure === 'function' ? measure : defaultMeasure;
        for (const e of entities || []) {
            if (!e || !TINY_TYPES.has(typeOf(e))) continue;
            if (typeOf(e) === 'POINT') { out.push(e); continue; }
            const size = m(e);
            if (size === null || size === undefined || !fin(size)) continue;
            if (size < threshold) out.push(e);
        }
        return out;
    }

    // ------------------------------------------------------ duplicates pass

    function pt(q, p) {
        if (!p) return '~';
        return q(p.x) + ',' + q(p.y) + (fin(p.z) && p.z !== 0 ? ',' + q(p.z) : '');
    }

    /** Vertex run as a string, open or closed, with bulges and widths. */
    function runString(q, vs) {
        const bq = makeQ(PARAM_Q);
        return vs.map(v => {
            let s = q(v.x) + ',' + q(v.y);
            const b = Number(v.bulge) || 0;
            if (b) s += 'b' + bq(b);
            if (fin(v.startWidth) && v.startWidth) s += 's' + q(v.startWidth);
            if (fin(v.endWidth) && v.endWidth) s += 'e' + q(v.endWidth);
            return s;
        }).join(';');
    }

    /**
     * Reverse a vertex run. A bulge belongs to the span LEAVING its vertex, so
     * every bulge shifts one vertex and flips sign; widths swap ends.
     */
    function reverseRun(vs, closed) {
        const n = vs.length, out = [];
        for (let j = 0; j < n; j++) {
            const v = vs[n - 1 - j];
            const from = closed ? vs[((n - 2 - j) % n + n) % n] : (j < n - 1 ? vs[n - 2 - j] : null);
            out.push({
                x: v.x, y: v.y,
                bulge: from ? -(Number(from.bulge) || 0) : 0,
                startWidth: from ? from.endWidth : undefined,
                endWidth: from ? from.startWidth : undefined,
            });
        }
        return out;
    }

    /**
     * Canonical string of a closed run: start at the lowest vertex. When the
     * lowest vertex occurs more than once every candidate start is tried, so a
     * loop that revisits a point still has one canonical form.
     */
    function closedRunString(q, vs) {
        let minX = Infinity, minY = Infinity;
        const keys = vs.map(v => [Number(q(v.x)), Number(q(v.y))]);
        for (const [x, y] of keys) {
            if (x < minX || (x === minX && y < minY)) { minX = x; minY = y; }
        }
        let best = null;
        for (let i = 0; i < vs.length; i++) {
            if (keys[i][0] !== minX || keys[i][1] !== minY) continue;
            const s = runString(q, vs.slice(i).concat(vs.slice(0, i)));
            if (best === null || s < best) best = s;
        }
        return best ?? runString(q, vs);
    }

    function polylineKey(q, e) {
        const vs = (e.vertices || []).filter(v => v && fin(v.x) && fin(v.y));
        if (vs.length < 2) return null;
        if (e.is3dPolygonMesh || e.isPolyfaceMesh) return null;
        const closed = !!(e.shape || e.closed);
        let a, b;
        if (closed) {
            a = closedRunString(q, vs);
            b = closedRunString(q, reverseRun(vs, true));
        } else {
            a = runString(q, vs);
            b = runString(q, reverseRun(vs, false));
        }
        const extra = [closed ? 'C' : 'O', fin(e.width) ? q(e.width) : '', fin(e.elevation) ? q(e.elevation) : '',
            e.is3dPolyline ? '3d' : ''].join(':');
        return extra + '#' + (a < b ? a : b);
    }

    function arcEnd(c, r, ang) { return { x: c.x + Math.cos(ang) * r, y: c.y + Math.sin(ang) * r }; }

    /** Geometry fingerprint per type, or null when the type is not handled. */
    function geometryKey(e, tol) {
        const q = makeQ(tol);
        const pq = makeQ(PARAM_Q);
        const dq = makeQ(DEG_Q);
        const t = typeOf(e);
        switch (t) {
            case 'LINE': {
                const v = e.vertices;
                if (!v || v.length < 2) return null;
                const a = pt(q, v[0]), b = pt(q, v[1]);
                return a < b ? a + '>' + b : b + '>' + a;
            }
            case 'LWPOLYLINE':
            case 'POLYLINE':
                return polylineKey(q, e);
            case 'CIRCLE':
                if (!e.center || !fin(e.radius)) return null;
                return pt(q, e.center) + 'r' + q(Math.abs(e.radius)) + extrusionSign(e);
            case 'ARC': {
                if (!e.center || !fin(e.radius)) return null;
                const r = Math.abs(e.radius);
                const s = arcEnd(e.center, r, Number(e.startAngle) || 0);
                const en = arcEnd(e.center, r, Number(e.endAngle) || 0);
                return pt(q, e.center) + 'r' + q(r) + 's' + pt(q, s) + 'e' + pt(q, en) + extrusionSign(e);
            }
            case 'ELLIPSE': {
                if (!e.center || !e.majorAxisEndPoint) return null;
                const s = Number(e.startAngle) || 0;
                const en = fin(e.endAngle) ? Number(e.endAngle) : TAU;
                const span = Math.abs(en - s);
                const full = span < PARAM_Q || Math.abs(span - TAU) < 1e-9;
                return pt(q, e.center) + 'm' + pt(q, e.majorAxisEndPoint) + 'k' + pq(e.axisRatio ?? 1)
                    + (full ? 'F' : 'p' + pq(normAngle(s)) + ':' + pq(normAngle(en))) + extrusionSign(e);
            }
            case 'SPLINE': {
                const cps = (e.controlPoints || []).map(p => pt(q, p)).join(';');
                const fps = (e.fitPoints || []).map(p => pt(q, p)).join(';');
                if (!cps && !fps) return null;
                const kn = (e.knotValues || []).map(pq).join(';');
                return [e.degreeOfSplineCurve ?? e.degree ?? '', e.closed ? 'C' : '', e.periodic ? 'P' : '',
                    e.rational ? 'R' : '', cps, fps, kn].join('#');
            }
            case 'POINT':
                return e.position ? pt(q, e.position) : null;
            case 'TEXT': {
                const p = e.startPoint || e.position;
                if (!p) return null;
                const aligned = !!(e.halign || e.valign);
                return ['s' + String(e.text ?? ''), pt(q, p), aligned ? pt(q, e.endPoint) : '',
                    q(e.textHeight ?? 0), dq(normDeg(e.rotation)), e.halign || 0, e.valign || 0,
                    pq(e.xScale ?? 1), e.textStyle || '', extrusionSign(e)].join('|');
            }
            case 'MTEXT': {
                if (!e.position) return null;
                return ['s' + String(e.text ?? ''), pt(q, e.position), q(e.height ?? 0), q(e.width ?? 0),
                    dq(normDeg(e.rotation)), e.attachmentPoint || 0,
                    e.directionVector ? pq(e.directionVector.x) + ',' + pq(e.directionVector.y) : '',
                    e.textStyle || ''].join('|');
            }
            case 'INSERT': {
                const p = e.position || e.insertPoint || e.insertionPoint;
                if (!p) return null;
                const attrs = Array.isArray(e.attributes)
                    ? e.attributes.map(a => (a.tag || '') + '=' + String(a.text ?? '') + '@' + pt(q, a.startPoint || a.position)).join(';')
                    : '';
                return [e.name || e.block || '', pt(q, p), pq(e.xScale ?? 1), pq(e.yScale ?? 1), pq(e.zScale ?? 1),
                    dq(normDeg(e.rotation)), e.columnCount || 1, e.rowCount || 1,
                    q(e.columnSpacing || 0), q(e.rowSpacing || 0), attrs, extrusionSign(e)].join('|');
            }
            default:
                return null;
        }
    }

    function normDeg(d) { const n = Number(d) || 0; return ((n % 360) + 360) % 360; }

    function findDuplicates(items, o) {
        const groups = new Map();
        for (const it of items) {
            const g = geometryKey(it.e, o.tolerance);
            if (g === null) continue;
            const key = typeOf(it.e) + '#' + styleKey(it.e, o) + '#' + g;
            let list = groups.get(key);
            if (!list) groups.set(key, list = []);
            list.push(it);
        }
        const out = [];
        for (const list of groups.values()) {
            if (list.length < 2) continue;
            const keep = preferred(list);
            out.push({ keep: keep.e, remove: list.filter(x => x !== keep).map(x => x.e) });
        }
        return out;
    }

    // ---------------------------------------------------------- merge pass

    function lineRecord(it, tol) {
        const v = it.e.vertices;
        if (!v || v.length < 2) return null;
        const a = v[0], b = v[1];
        if (![a.x, a.y, b.x, b.y].every(fin)) return null;
        // Planar lines only: a 3D line seen from above is not "the same" line.
        if (Math.abs(a.z || 0) > tol || Math.abs(b.z || 0) > tol) return null;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (!(len > tol)) return null;
        let ang = Math.atan2(dy, dx);
        if (ang < 0) ang += Math.PI;
        if (ang >= Math.PI) ang -= Math.PI;
        // Fold the wrap at the horizontal so near-0 and near-π directions meet.
        if (ang > Math.PI - ANG_TOL) ang -= Math.PI;
        return { it, a, b, len, ux: dx / len, uy: dy / len, ang };
    }

    /** Distance from p to the infinite line through r.a along (r.ux, r.uy). */
    function distToLine(p, r) {
        return Math.abs((p.x - r.a.x) * r.uy - (p.y - r.a.y) * r.ux);
    }

    function buildMerge(members, tol) {
        const keepItem = preferred(members.map(m => m.it));
        const k = members.find(m => m.it === keepItem);
        let tmin = 0, tmax = k.len;
        for (const m of members) {
            for (const p of [m.a, m.b]) {
                const t = (p.x - k.a.x) * k.ux + (p.y - k.a.y) * k.uy;
                if (t < tmin) tmin = t;
                if (t > tmax) tmax = t;
            }
        }
        const za = k.a.z || 0, zb = k.b.z || 0;
        const a = { x: k.a.x + k.ux * tmin, y: k.a.y + k.uy * tmin, z: za };
        const b = { x: k.a.x + k.ux * tmax, y: k.a.y + k.uy * tmax, z: zb };
        const changed = Math.abs(tmin) > tol * 1e-3 || Math.abs(tmax - k.len) > tol * 1e-3;
        return {
            keep: k.it.e,
            absorb: members.filter(m => m !== k).map(m => m.it.e),
            a, b, changed,
        };
    }

    /** Sweep one offset group; returns merges and the lines that did not fit. */
    function sweepGroup(list, o, merges) {
        const tol = o.tolerance;
        const rejected = [];
        let run = null;
        const flush = () => {
            if (run && run.members.length > 1) merges.push(buildMerge(run.members, tol));
            run = null;
        };
        for (const L of list) {
            if (!run) { run = { ref: L, members: [L], end: L.t1 }; continue; }
            if (distToLine(L.a, run.ref) > tol || distToLine(L.b, run.ref) > tol) {
                rejected.push(L);
                continue;
            }
            const gap = L.t0 - run.end;
            const join = gap < -tol ? o.merge.overlap : (gap <= tol ? o.merge.endToEnd : false);
            if (join) {
                run.members.push(L);
                if (L.t1 > run.end) run.end = L.t1;
            } else {
                flush();
                run = { ref: L, members: [L], end: L.t1 };
            }
        }
        flush();
        return rejected;
    }

    function findMerges(items, o) {
        const tol = o.tolerance;
        const merges = [];
        const byStyle = new Map();
        for (const it of items) {
            if (typeOf(it.e) !== 'LINE') continue;
            const r = lineRecord(it, tol);
            if (!r) continue;
            const k = styleKey(it.e, o);
            let list = byStyle.get(k);
            if (!list) byStyle.set(k, list = []);
            list.push(r);
        }
        for (const lines of byStyle.values()) {
            if (lines.length < 2) continue;
            lines.sort((p, q) => p.ang - q.ang);
            // Direction clusters: consecutive angles within ANG_TOL chain together.
            let start = 0;
            for (let i = 1; i <= lines.length; i++) {
                if (i < lines.length && lines[i].ang - lines[i - 1].ang <= ANG_TOL) continue;
                if (i - start > 1) mergeCluster(lines.slice(start, i), o, merges);
                start = i;
            }
        }
        return merges;
    }

    function mergeCluster(cluster, o, merges) {
        const tol = o.tolerance;
        const ref = cluster[0];
        const d0x = Math.cos(ref.ang), d0y = Math.sin(ref.ang);
        const n0x = -d0y, n0y = d0x;
        const ox = ref.a.x, oy = ref.a.y;
        let maxAlong = 0;
        for (const L of cluster) {
            const ta = (L.a.x - ox) * d0x + (L.a.y - oy) * d0y;
            const tb = (L.b.x - ox) * d0x + (L.b.y - oy) * d0y;
            L.t0 = Math.min(ta, tb);
            L.t1 = Math.max(ta, tb);
            L.c = ((L.a.x + L.b.x) / 2 - ox) * n0x + ((L.a.y + L.b.y) / 2 - oy) * n0y;
            maxAlong = Math.max(maxAlong, Math.abs(ta), Math.abs(tb));
        }
        // Offset window: the tolerance plus what the angular spread of the
        // cluster can add over its length. Exact copies give a window of tol.
        const spread = cluster[cluster.length - 1].ang - cluster[0].ang;
        const W = tol + spread * maxAlong * 1.01;
        cluster.sort((p, q) => p.c - q.c);
        let s = 0;
        for (let i = 1; i <= cluster.length; i++) {
            if (i < cluster.length && cluster[i].c - cluster[i - 1].c <= W) continue;
            if (i - s > 1) {
                let pending = cluster.slice(s, i).sort((p, q) => p.t0 - q.t0 || p.t1 - q.t1);
                // Lines that did not sit on a run's line get their own sweep;
                // every sweep places at least one line, so this terminates.
                while (pending.length > 1) pending = sweepGroup(pending, o, merges);
            }
            s = i;
        }
    }

    // -------------------------------------------------------------- analyze

    function normalizeOptions(opts) {
        const o = opts || {};
        const tol = Number(o.tolerance);
        return {
            tiny: { enabled: !!(o.tiny && o.tiny.enabled), threshold: Number(o.tiny && o.tiny.threshold) || 0 },
            duplicates: !!o.duplicates,
            merge: {
                enabled: !!(o.merge && (o.merge.overlap || o.merge.endToEnd)),
                overlap: !!(o.merge && o.merge.overlap),
                endToEnd: !!(o.merge && o.merge.endToEnd),
            },
            tolerance: tol > 0 ? tol : DEFAULT_TOLERANCE,
            ignoreColor: !!o.ignoreColor,
            ignoreLinetype: !!o.ignoreLinetype,
            ignoreLineweight: !!o.ignoreLineweight,
            isLocked: typeof o.isLocked === 'function' ? o.isLocked : () => false,
            measure: o.measure,
        };
    }

    function analyze(entities, opts) {
        const o = normalizeOptions(opts);
        const result = {
            tiny: [], duplicates: [], merges: [], skipped: {}, locked: 0, scanned: 0,
            counts: { tiny: 0, duplicates: 0, merged: 0, absorbed: 0, removed: 0 },
        };
        let items = [];
        let idx = 0;
        for (const e of entities || []) {
            if (!e) continue;
            result.scanned++;
            if (o.isLocked(e.layer || '0')) { result.locked++; continue; }
            items.push({ e, idx: idx++ });
        }

        if (o.tiny.enabled && o.tiny.threshold > 0) {
            result.tiny = findTiny(items.map(x => x.e), o.tiny.threshold, o.measure);
            const gone = new Set(result.tiny);
            items = items.filter(x => !gone.has(x.e));
        }

        if (o.duplicates || o.merge.enabled) {
            for (const it of items) {
                const t = typeOf(it.e);
                const handled = (o.duplicates && DUP_TYPES.has(t)) || (o.merge.enabled && t === 'LINE');
                if (!handled) result.skipped[t || '?'] = (result.skipped[t || '?'] || 0) + 1;
            }
        }

        if (o.duplicates) {
            result.duplicates = findDuplicates(items, o);
            const gone = new Set(result.duplicates.flatMap(d => d.remove));
            items = items.filter(x => !gone.has(x.e));
        }

        if (o.merge.enabled) result.merges = findMerges(items, o);

        const c = result.counts;
        c.tiny = result.tiny.length;
        c.duplicates = result.duplicates.reduce((n, d) => n + d.remove.length, 0);
        c.merged = result.merges.length;
        c.absorbed = result.merges.reduce((n, m) => n + m.absorb.length, 0);
        c.removed = c.tiny + c.duplicates + c.absorbed;
        return result;
    }

    const DxfOverkill = {
        DEFAULT_TOLERANCE,
        analyze, findTiny, defaultMeasure,
        geometryKey, styleKey, reverseRun,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = DxfOverkill;
    if (root) root.DxfOverkill = DxfOverkill;
})(typeof window !== 'undefined' ? window : null);
