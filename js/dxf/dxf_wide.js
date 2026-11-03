/**
 * dxf_wide.js — wide (filled) polylines and DONUT geometry.
 *
 * LWPOLYLINE width lives in code 43 (constant width, all spans) or per vertex
 * in 40/41 (start/end width of the span that starts at that vertex). AutoCAD
 * draws such a polyline as a filled band centred on the path; arcs (bulges)
 * become curved bands, widths taper linearly along a span, and spans whose
 * widths meet at a vertex are joined with a miter.
 *
 *   wideTriangles(vertices, closed, constantWidth, opts) → number[] | null
 *       flat [x0,y0, x1,y1, x2,y2, ...] triangle list, null when nothing is wide.
 *       opts.scale       — multiplies every width (block insert scale)
 *       opts.segments(r, sweep) — arc tessellation count (host smoothness)
 *   hasWidth(entity) → bool
 *   donutPolyline(center, insideDia, outsideDia) → { vertices, width } | null
 *       AutoCAD's DONUT: a closed two-bulge LWPOLYLINE with constant width.
 *
 * Pure, no DOM. window.DxfWide + Node exports.
 */
(function (root) {
    'use strict';

    const TAU = Math.PI * 2;
    const MITER_LIMIT = 10;     // miter length / half width; sharper joins are beveled
    const fin = Number.isFinite;

    function spanWidths(v, constantWidth) {
        const sw = Number(v && v.startWidth), ew = Number(v && v.endWidth);
        const hasOwn = (fin(sw) && sw > 0) || (fin(ew) && ew > 0);
        if (hasOwn) return [fin(sw) ? Math.max(sw, 0) : 0, fin(ew) ? Math.max(ew, 0) : 0];
        const c = Number(constantWidth);
        return fin(c) && c > 0 ? [c, c] : [0, 0];
    }

    /** True when any span of the polyline has a non-zero width. */
    function hasWidth(e) {
        if (!e) return false;
        const t = String(e.type || '').toUpperCase();
        if (t !== 'LWPOLYLINE' && t !== 'POLYLINE') return false;
        const vs = Array.isArray(e.vertices) ? e.vertices : [];
        if (vs.length < 2) return false;
        return vs.some(v => { const w = spanWidths(v, e.width); return w[0] > 0 || w[1] > 0; });
    }

    function defaultSegments(r, sweep) {
        return Math.max(4, Math.min(256, Math.ceil(Math.abs(sweep) / (Math.PI / 36))));
    }

    /**
     * Samples of one span: [{x, y, tx, ty, w}] — position, unit tangent, width.
     */
    function sampleSpan(a, b, sw, ew, segFn) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const chord = Math.hypot(dx, dy);
        if (!(chord > 1e-12)) return null;
        const bulge = Number(a.bulge) || 0;
        if (Math.abs(bulge) < 1e-12) {
            const tx = dx / chord, ty = dy / chord;
            return [{ x: a.x, y: a.y, tx, ty, w: sw }, { x: b.x, y: b.y, tx, ty, w: ew }];
        }
        const theta = 4 * Math.atan(bulge);              // signed sweep, + = CCW
        const r = Math.abs(chord / (2 * Math.sin(theta / 2)));
        const h = r * Math.cos(theta / 2) * Math.sign(theta);   // signed centre offset (left of the chord for CCW)
        const cx = (a.x + b.x) / 2 - (dy / chord) * h;
        const cy = (a.y + b.y) / 2 + (dx / chord) * h;
        const a0 = Math.atan2(a.y - cy, a.x - cx);
        const n = Math.max(2, Math.round(segFn(r, Math.abs(theta)) || 2));
        const dir = theta > 0 ? 1 : -1;
        const out = [];
        for (let k = 0; k <= n; k++) {
            const t = k / n;
            const ang = a0 + theta * t;
            const c = Math.cos(ang), s = Math.sin(ang);
            out.push({
                x: k === n ? b.x : cx + r * c,
                y: k === n ? b.y : cy + r * s,
                tx: -s * dir, ty: c * dir,
                w: sw + (ew - sw) * t,
            });
        }
        return out;
    }

    function pushTri(out, a, b, c) { out.push(a.x, a.y, b.x, b.y, c.x, c.y); }

    // Band along the samples of one span.
    function bandTriangles(samples, out) {
        const side = (p, sign) => ({ x: p.x - p.ty * p.w / 2 * sign, y: p.y + p.tx * p.w / 2 * sign });
        for (let k = 0; k < samples.length - 1; k++) {
            const p = samples[k], q = samples[k + 1];
            if (!(p.w > 0) && !(q.w > 0)) continue;
            const L0 = side(p, 1), R0 = side(p, -1), L1 = side(q, 1), R1 = side(q, -1);
            pushTri(out, L0, R0, R1);
            pushTri(out, L0, R1, L1);
        }
    }

    /**
     * Fill the wedge on the outer side of a turn at vertex P between the end of
     * one span (tangent t1, width w1) and the start of the next (t2, w2).
     */
    function joinTriangles(P, t1, w1, t2, w2, out) {
        if (!(w1 > 0) || !(w2 > 0)) return;
        const cross = t1.x * t2.y - t1.y * t2.x;
        const dot = t1.x * t2.x + t1.y * t2.y;
        if (Math.abs(cross) < 1e-12 && dot > 0) return;           // straight through
        // Outer side: right for a left (CCW) turn, left for a right turn.
        const s = cross > 0 ? -1 : 1;
        const A = { x: P.x - t1.y * w1 / 2 * s, y: P.y + t1.x * w1 / 2 * s };
        const B = { x: P.x - t2.y * w2 / 2 * s, y: P.y + t2.x * w2 / 2 * s };
        // Miter: A + u·t1 = B − v·t2, i.e. u·t1 + v·t2 = B − A.
        const det = t1.x * t2.y - t1.y * t2.x;
        let M = null;
        if (Math.abs(det) > 1e-12) {
            const rx = B.x - A.x, ry = B.y - A.y;
            const u = (rx * t2.y - ry * t2.x) / det;
            const v = (t1.x * ry - t1.y * rx) / det;
            const lim = MITER_LIMIT * Math.max(w1, w2) / 2;
            if (u >= 0 && v >= 0 && u <= lim && v <= lim) M = { x: A.x + u * t1.x, y: A.y + u * t1.y };
        }
        if (M) { pushTri(out, P, A, M); pushTri(out, P, M, B); }
        else pushTri(out, P, A, B);                                 // bevel
    }

    function wideTriangles(vertices, closed, constantWidth, opts) {
        const o = opts || {};
        const scale = fin(o.scale) && o.scale > 0 ? o.scale : 1;
        const segFn = typeof o.segments === 'function' ? o.segments : defaultSegments;
        const vs = (vertices || []).filter(v => v && fin(v.x) && fin(v.y));
        const n = vs.length;
        if (n < 2) return null;
        const spanCount = closed ? n : n - 1;
        const spans = [];
        let any = false;
        for (let i = 0; i < spanCount; i++) {
            const [sw, ew] = spanWidths(vs[i], constantWidth);
            if (sw > 0 || ew > 0) any = true;
            spans.push(sampleSpan(vs[i], vs[(i + 1) % n], sw * scale, ew * scale, segFn));
        }
        if (!any) return null;
        const out = [];
        for (const s of spans) if (s) bandTriangles(s, out);
        // Joins between consecutive non-degenerate spans.
        const live = spans.map((s, i) => ({ s, i })).filter(x => x.s);
        const pairs = live.length - (closed ? 0 : 1);
        for (let k = 0; k < pairs; k++) {
            const A = live[k].s, B = live[(k + 1) % live.length].s;
            if (A === B) continue;
            const end = A[A.length - 1], start = B[0];
            if (Math.abs(end.w - start.w) > 1e-9 * Math.max(1, end.w)) continue;   // a step in width: no join
            joinTriangles(end, { x: end.tx, y: end.ty }, end.w, { x: start.tx, y: start.ty }, start.w, out);
        }
        return out.length ? out : null;
    }

    function donutPolyline(center, insideDia, outsideDia) {
        const di = Math.abs(Number(insideDia)), dout = Math.abs(Number(outsideDia));
        if (!center || !fin(center.x) || !fin(center.y) || !fin(di) || !fin(dout)) return null;
        const inner = Math.min(di, dout), outer = Math.max(di, dout);
        if (!(outer > 0) || outer - inner < 1e-12) return null;
        const width = (outer - inner) / 2;
        const mid = (outer + inner) / 4;                  // path radius, centred in the band
        return {
            width,
            vertices: [
                { x: center.x - mid, y: center.y, bulge: 1 },
                { x: center.x + mid, y: center.y, bulge: 1 },
            ],
        };
    }

    const DxfWide = { wideTriangles, hasWidth, donutPolyline, spanWidths };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfWide;
    if (root) root.DxfWide = DxfWide;
})(typeof window !== 'undefined' ? window : null);
