/**
 * dxf_tool_modify.js — geometry for the TRIM and EXTEND tools.
 *
 * Pure math, Node-tested. window.DxfToolModify + module exports.
 */
(function (root) {
    'use strict';

    const EPS = 1e-9;

    /**
     * Segment/segment intersection. Returns { t, u, x, y } where t is the
     * parameter along a→b and u along c→d (both in [0,1]), or null.
     */
    const PARAM_TOL = 1e-6; // generous parameter tolerance so corner touches register

    function segSegIntersection(a, b, c, d) {
        const r = { x: b.x - a.x, y: b.y - a.y };
        const s = { x: d.x - c.x, y: d.y - c.y };
        const denom = r.x * s.y - r.y * s.x;
        if (Math.abs(denom) < EPS) return null; // parallel / collinear
        const qp = { x: c.x - a.x, y: c.y - a.y };
        const t = (qp.x * s.y - qp.y * s.x) / denom;
        const u = (qp.x * r.y - qp.y * r.x) / denom;
        if (t < -PARAM_TOL || t > 1 + PARAM_TOL || u < -PARAM_TOL || u > 1 + PARAM_TOL) return null;
        return { t: Math.min(1, Math.max(0, t)), u: Math.min(1, Math.max(0, u)), x: a.x + r.x * t, y: a.y + r.y * t };
    }

    /**
     * Distance-based fallback for corner touches: parameters t of every endpoint of
     * the cutting segments that lies ON the line a→b (within tol, world units).
     */
    function endpointTouchParams(a, b, cutterSegments, tol) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-18) return [];
        const out = [];
        for (const s of cutterSegments || []) {
            for (const p of [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]) {
                const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
                if (t < -1e-9 || t > 1 + 1e-9) continue;
                const px = a.x + dx * t, py = a.y + dy * t;
                if (Math.hypot(p.x - px, p.y - py) <= tol) out.push(Math.min(1, Math.max(0, t)));
            }
        }
        return out;
    }

    /** Do a→b's own endpoints both touch any of the given segments (within tol)? */
    function endpointsTouchSegments(a, b, segments, tol) {
        const near = (p) => (segments || []).some(s =>
            distPointToSegment(p.x, p.y, s.x1, s.y1, s.x2, s.y2) <= tol);
        return near(a) && near(b);
    }

    function distPointToSegment(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-18) return Math.hypot(px - x1, py - y1);
        let t = ((px - x1) * dx + (py - y1) * dy) / len2;
        t = Math.min(1, Math.max(0, t));
        return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
    }

    /**
     * Ray (origin p, unit dir) vs segment c→d. Returns { t } (distance along the
     * ray, t > EPS) or null.
     */
    function raySegIntersection(p, dir, c, d) {
        const s = { x: d.x - c.x, y: d.y - c.y };
        const denom = dir.x * s.y - dir.y * s.x;
        if (Math.abs(denom) < EPS) return null;
        const qp = { x: c.x - p.x, y: c.y - p.y };
        const t = (qp.x * s.y - qp.y * s.x) / denom;
        const u = (qp.x * dir.y - qp.y * dir.x) / denom;
        if (t <= EPS || u < -EPS || u > 1 + EPS) return null;
        return { t, x: p.x + dir.x * t, y: p.y + dir.y * t };
    }

    /**
     * Ray vs full circle. Returns array of { t, x, y } with t > EPS, sorted.
     */
    function rayCircleIntersections(p, dir, center, radius) {
        const ox = p.x - center.x, oy = p.y - center.y;
        const b = 2 * (dir.x * ox + dir.y * oy);
        const cc = ox * ox + oy * oy - radius * radius;
        const disc = b * b - 4 * cc;
        if (disc < 0) return [];
        const sq = Math.sqrt(disc);
        return [(-b - sq) / 2, (-b + sq) / 2]
            .filter(t => t > EPS)
            .map(t => ({ t, x: p.x + dir.x * t, y: p.y + dir.y * t }))
            .sort((m, n) => m.t - n.t);
    }

    /** Is angle (rad) inside the CCW arc range start→end? */
    function angleInArc(angle, start, end) {
        const TAU = Math.PI * 2;
        const norm = (a) => ((a % TAU) + TAU) % TAU;
        const a = norm(angle), s = norm(start);
        let e = norm(end);
        if (e <= s) e += TAU;
        const a2 = a < s ? a + TAU : a;
        return a2 >= s - 1e-9 && a2 <= e + 1e-9;
    }

    /**
     * TRIM computation for a straight line a→b:
     *   cuts    — sorted intersection parameters t ∈ (0,1) with the cutting edges
     *   clickT  — parameter of the user's click on the line
     * Returns:
     *   null                                  — no cuts around the click (nothing to trim)
     *   { kind:'shorten-start', newStart }    — clicked span touches the a end
     *   { kind:'shorten-end',   newEnd }      — clicked span touches the b end
     *   { kind:'split', end1, start2 }        — clicked span is interior: keep a→end1 and start2→b
     */
    /**
     * The cuts bracketing the clicked point on a run parameterised 0→1.
     * Returns { lower, upper }, either of which is null at a free end.
     * Cuts at the very ends are dropped: there is nothing between them and the
     * end to remove.
     */
    function bracketingCuts(cuts, clickT) {
        const ts = [...new Set(cuts.filter(t => t > 1e-6 && t < 1 - 1e-6).map(t => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y);
        let lower = null, upper = null;
        for (const t of ts) {
            if (t < clickT) lower = t;
            else if (upper === null) { upper = t; break; }
        }
        return { lower, upper, ts };
    }

    function computeLineTrim(a, b, cuts, clickT) {
        const { lower, upper, ts } = bracketingCuts(cuts, clickT);
        if (!ts.length) return null;
        const lerp = (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        if (lower === null && upper === null) return null;
        if (lower === null) return { kind: 'shorten-start', newStart: lerp(upper) };
        if (upper === null) return { kind: 'shorten-end', newEnd: lerp(lower) };
        return { kind: 'split', end1: lerp(lower), start2: lerp(upper) };
    }

    const TAU = Math.PI * 2;
    const normAngle = (a) => ((a % TAU) + TAU) % TAU;

    /**
     * Angles (rad, measured at `center`) where the straight segment a→b crosses
     * the circle. A tangent segment yields one angle, a chord two, a miss none.
     * Solved algebraically rather than against a tessellation, so the result is
     * exact no matter how coarsely the circle happens to be drawn.
     */
    function segCircleAngles(a, b, center, radius) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < EPS || !(radius > 0)) return [];
        const dir = { x: dx / len, y: dy / len };
        const ox = a.x - center.x, oy = a.y - center.y;
        const bq = 2 * (dir.x * ox + dir.y * oy);
        const cc = ox * ox + oy * oy - radius * radius;
        const disc = bq * bq - 4 * cc;
        if (disc < 0) return [];
        const sq = Math.sqrt(disc);
        const slack = len * PARAM_TOL;
        const out = [];
        const roots = sq < EPS ? [-bq / 2] : [(-bq - sq) / 2, (-bq + sq) / 2];
        for (const t of roots) {
            if (t < -slack || t > len + slack) continue;   // beyond the segment's ends
            out.push(Math.atan2(a.y + dir.y * t - center.y, a.x + dir.x * t - center.x));
        }
        return out;
    }

    /** Sorted, de-duplicated cut angles in [0, 2π). Coincident cuts collapse. */
    function normalizeCutAngles(angles, tol) {
        const eps = Number.isFinite(tol) && tol > 0 ? tol : 1e-7;
        const sorted = (angles || []).map(normAngle).filter(Number.isFinite).sort((a, b) => a - b);
        const out = [];
        for (const a of sorted) {
            if (out.length && a - out[out.length - 1] <= eps) continue;
            out.push(a);
        }
        // The first and last can also be neighbours across the 0/2π seam.
        if (out.length > 1 && out[0] + TAU - out[out.length - 1] <= eps) out.pop();
        return out;
    }

    /**
     * TRIM a full circle: drop the span the user clicked in.
     *
     * A circle has no ends, so removing one span always leaves exactly one arc —
     * the rest of the way round. Returns { startAngle, endAngle } (CCW) for that
     * arc, or null when fewer than two distinct cuts were found, which would mean
     * removing the whole circle rather than trimming it.
     */
    function computeCircleTrim(cutAngles, clickAngle, tol) {
        const ts = normalizeCutAngles(cutAngles, tol);
        if (ts.length < 2) return null;
        const click = normAngle(clickAngle);
        // The span [ts[i], ts[i+1]) holding the click; before the first cut means
        // the span that wraps past 2π from the last one.
        let i = -1;
        for (let k = 0; k < ts.length; k++) {
            if (ts[k] <= click) i = k; else break;
        }
        if (i === -1) i = ts.length - 1;
        return { startAngle: ts[(i + 1) % ts.length], endAngle: ts[i] };
    }

    /**
     * TRIM an arc running CCW from startAngle to endAngle. Unlike a circle an arc
     * has two free ends, so the clicked span may be at either end (shorten) or in
     * the middle (split into two arcs). Angles are radians.
     */
    function computeArcTrim(startAngle, endAngle, cutAngles, clickAngle, tol) {
        let sweep = normAngle(endAngle - startAngle);
        if (sweep < EPS) sweep = TAU;                  // a closed arc is a circle
        const param = (a) => normAngle(a - startAngle) / sweep;
        // Each cut is carried as its own angle alongside the parameter used to
        // order it. Rebuilding the angle from the parameter would lose precision
        // over a long sweep and leave a sliver of arc behind at the cut.
        const cuts = normalizeCutAngles(cutAngles, tol)
            .map(a => ({ a, t: param(a) }))
            .filter(c => c.t > 1e-6 && c.t < 1 - 1e-6)
            .sort((p, q) => p.t - q.t);
        const clickT = param(clickAngle);
        let lower = null, upper = null;
        for (const c of cuts) {
            if (c.t < clickT) lower = c;
            else if (upper === null) { upper = c; break; }
        }
        if (lower === null && upper === null) return null;
        if (lower === null) return { kind: 'shorten-start', newStart: upper.a };
        if (upper === null) return { kind: 'shorten-end', newEnd: lower.a };
        return { kind: 'split', end1: lower.a, start2: upper.a };
    }

    /**
     * EXTEND: find where the ray from `endpoint` away from `otherEnd` first meets
     * the boundary (given as segments and/or circles). Returns { x, y } or null.
     *   boundarySegments: [{x1,y1,x2,y2}]
     *   boundaryCircles:  [{ center:{x,y}, radius, startAngle?, endAngle? }]  (angles → arc)
     */
    function computeExtension(endpoint, otherEnd, boundarySegments, boundaryCircles) {
        const dx = endpoint.x - otherEnd.x, dy = endpoint.y - otherEnd.y;
        const len = Math.hypot(dx, dy);
        if (len < EPS) return null;
        const dir = { x: dx / len, y: dy / len };
        let best = null;
        for (const s of boundarySegments || []) {
            const hit = raySegIntersection(endpoint, dir, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
            if (hit && (!best || hit.t < best.t)) best = hit;
        }
        for (const cir of boundaryCircles || []) {
            for (const hit of rayCircleIntersections(endpoint, dir, cir.center, cir.radius)) {
                if (Number.isFinite(cir.startAngle) && Number.isFinite(cir.endAngle)) {
                    const ang = Math.atan2(hit.y - cir.center.y, hit.x - cir.center.x);
                    if (!angleInArc(ang, cir.startAngle, cir.endAngle)) continue;
                }
                if (!best || hit.t < best.t) best = hit;
            }
        }
        return best ? { x: best.x, y: best.y } : null;
    }

    // ===================== OFFSET =====================

    /**
     * Offset a LINE by distance d. `side` is a point indicating which side to offset
     * toward (the click). Returns { a, b } for the parallel line, or null.
     */
    function offsetLine(a, b, dist, side) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < EPS) return null;
        let nx = -dy / len, ny = dx / len;              // left normal
        if (side) {
            const toSide = (side.x - a.x) * nx + (side.y - a.y) * ny;
            if (toSide < 0) { nx = -nx; ny = -ny; }     // flip toward the click
        }
        const ox = nx * dist, oy = ny * dist;
        return { a: { x: a.x + ox, y: a.y + oy }, b: { x: b.x + ox, y: b.y + oy } };
    }

    /** Offset a CIRCLE: grows or shrinks the radius depending on the click side. */
    function offsetCircle(center, radius, dist, side) {
        let outward = true;
        if (side) outward = Math.hypot(side.x - center.x, side.y - center.y) >= radius;
        const r = outward ? radius + dist : radius - dist;
        return r > EPS ? { center: { ...center }, radius: r } : null;
    }

    /** Offset an ARC (same centre, adjusted radius). Angles unchanged. */
    function offsetArc(center, radius, startDeg, endDeg, dist, side) {
        const c = offsetCircle(center, radius, dist, side);
        return c ? { center: c.center, radius: c.radius, startDeg, endDeg } : null;
    }

    /**
     * Offset an open/closed polyline by moving every edge along its normal and
     * re-intersecting neighbours. `side` chooses the direction. Bulges are dropped
     * (straight-segment approximation) — callers that need arcs should pre-flatten.
     */
    function offsetPolyline(points, closed, dist, side) {
        const n = points.length;
        if (n < 2) return null;
        // Signed area decides the consistent normal direction for closed loops.
        const lines = [];
        const count = closed ? n : n - 1;
        for (let i = 0; i < count; i++) {
            const a = points[i], b = points[(i + 1) % n];
            const off = offsetLine(a, b, dist, side && count === 1 ? side : null);
            // For multi-segment we pick the side by the click relative to the whole
            // path centroid unless a specific side point is given.
            lines.push({ a, b });
        }
        // Determine normal sign from the click side using the nearest edge.
        let sign = 1;
        if (side) {
            let best = Infinity, bestSign = 1;
            for (const { a, b } of lines) {
                const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
                const nx = -dy / len, ny = dx / len;
                const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                const dd = distPointToSegment(side.x, side.y, a.x, a.y, b.x, b.y);
                if (dd < best) { best = dd; bestSign = ((side.x - mid.x) * nx + (side.y - mid.y) * ny) >= 0 ? 1 : -1; }
            }
            sign = bestSign;
        }
        // Offset each edge as an infinite line, then intersect consecutive edges.
        const offLines = lines.map(({ a, b }) => {
            const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len * sign, ny = dx / len * sign;
            return { a: { x: a.x + nx * dist, y: a.y + ny * dist }, b: { x: b.x + nx * dist, y: b.y + ny * dist } };
        });
        const result = [];
        const lineIntersect = (L1, L2) => {
            const r = { x: L1.b.x - L1.a.x, y: L1.b.y - L1.a.y };
            const s = { x: L2.b.x - L2.a.x, y: L2.b.y - L2.a.y };
            const denom = r.x * s.y - r.y * s.x;
            if (Math.abs(denom) < EPS) return { x: L1.b.x, y: L1.b.y }; // parallel: use endpoint
            const qp = { x: L2.a.x - L1.a.x, y: L2.a.y - L1.a.y };
            const t = (qp.x * s.y - qp.y * s.x) / denom;
            return { x: L1.a.x + r.x * t, y: L1.a.y + r.y * t };
        };
        if (!closed) result.push({ x: offLines[0].a.x, y: offLines[0].a.y });
        for (let i = 0; i < offLines.length; i++) {
            if (closed) {
                const prev = offLines[(i - 1 + offLines.length) % offLines.length];
                result.push(lineIntersect(prev, offLines[i]));
            } else if (i > 0) {
                result.push(lineIntersect(offLines[i - 1], offLines[i]));
            }
        }
        if (!closed) result.push({ x: offLines[offLines.length - 1].b.x, y: offLines[offLines.length - 1].b.y });
        return { points: result, closed };
    }

    // ===================== FILLET / CHAMFER =====================

    /** Intersection of two infinite lines (a1→a2, b1→b2), or null if parallel. */
    function lineLinePoint(a1, a2, b1, b2) {
        const r = { x: a2.x - a1.x, y: a2.y - a1.y };
        const s = { x: b2.x - b1.x, y: b2.y - b1.y };
        const denom = r.x * s.y - r.y * s.x;
        if (Math.abs(denom) < EPS) return null;
        const qp = { x: b1.x - a1.x, y: b1.y - a1.y };
        const t = (qp.x * s.y - qp.y * s.x) / denom;
        return { x: a1.x + r.x * t, y: a1.y + r.y * t };
    }

    // Which endpoint of a line to KEEP. With a hint (the user's click) we keep the
    // end lying on the same side of the corner as the click along the line; without
    // one we keep the farther end.
    function keptEnd(line, corner, hint) {
        const dxa = line.a.x - corner.x, dya = line.a.y - corner.y;
        const dxb = line.b.x - corner.x, dyb = line.b.y - corner.y;
        if (hint) {
            const hx = hint.x - corner.x, hy = hint.y - corner.y;
            // Dot of each endpoint direction with the click direction: the endpoint
            // pointing the same way as the click is the side the user means.
            const da = dxa * hx + dya * hy;
            const db = dxb * hx + dyb * hy;
            if (da !== db) return da > db ? line.a : line.b;
        }
        return (dxa * dxa + dya * dya) >= (dxb * dxb + dyb * dyb) ? line.a : line.b;
    }

    // Which endpoint of a line is farther from the corner (the end to keep).
    function farEnd(line, corner) {
        const d1 = Math.hypot(line.a.x - corner.x, line.a.y - corner.y);
        const d2 = Math.hypot(line.b.x - corner.x, line.b.y - corner.y);
        return d1 >= d2 ? line.a : line.b;
    }

    /**
     * Fillet two lines with a rounded arc of the given radius.
     * hint1 / hint2 are optional click points that fix which side of each line to
     * keep (so the arc lands in the corner the user actually clicked).
     * Returns { corner, line1End, line2End, arc:{center,radius,startDeg,endDeg} } or null.
     */
    function filletLines(l1, l2, radius, hint1, hint2) {
        const corner = lineLinePoint(l1.a, l1.b, l2.a, l2.b);
        if (!corner) return null;
        const p1 = keptEnd(l1, corner, hint1), p2 = keptEnd(l2, corner, hint2);
        // Unit directions from the corner toward each line's kept end.
        let d1 = { x: p1.x - corner.x, y: p1.y - corner.y };
        let d2 = { x: p2.x - corner.x, y: p2.y - corner.y };
        const l1len = Math.hypot(d1.x, d1.y), l2len = Math.hypot(d2.x, d2.y);
        if (l1len < EPS || l2len < EPS) return null;
        d1 = { x: d1.x / l1len, y: d1.y / l1len };
        d2 = { x: d2.x / l2len, y: d2.y / l2len };
        const dot = Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y));
        const half = Math.acos(dot) / 2;
        if (half < EPS) return null;
        const tanDist = radius / Math.tan(half);   // distance from corner to tangent points
        if (tanDist > l1len || tanDist > l2len) return null; // radius too big for these lines
        const t1 = { x: corner.x + d1.x * tanDist, y: corner.y + d1.y * tanDist };
        const t2 = { x: corner.x + d2.x * tanDist, y: corner.y + d2.y * tanDist };
        // Arc centre: along the bisector of the two KEPT directions — this puts the
        // centre inside the (smaller) angle the user selected, never the reflex side.
        let bis = { x: d1.x + d2.x, y: d1.y + d2.y };
        const bl = Math.hypot(bis.x, bis.y);
        if (bl < EPS) return null;
        bis = { x: bis.x / bl, y: bis.y / bl };
        const center = { x: corner.x + bis.x * (radius / Math.sin(half)),
                         y: corner.y + bis.y * (radius / Math.sin(half)) };
        let startDeg = Math.atan2(t1.y - center.y, t1.x - center.x) * 180 / Math.PI;
        let endDeg = Math.atan2(t2.y - center.y, t2.x - center.x) * 180 / Math.PI;
        // A DXF arc always sweeps CCW start→end. The fillet is the MINOR arc between
        // the tangent points (≤180°); if going start→end CCW would take the long way,
        // swap the ends so the short arc is drawn.
        let ccwSweep = ((endDeg - startDeg) % 360 + 360) % 360;
        if (ccwSweep > 180) { const t = startDeg; startDeg = endDeg; endDeg = t; }
        return {
            corner, p1, p2, line1End: t1, line2End: t2,
            arc: { center, radius, startDeg, endDeg },
        };
    }

    /**
     * Chamfer two lines with a straight bevel. `dist` is cut back along each line
     * from the corner (equal-distance chamfer). hint1/hint2 fix the kept sides.
     */
    function chamferLines(l1, l2, dist, hint1, hint2) {
        const corner = lineLinePoint(l1.a, l1.b, l2.a, l2.b);
        if (!corner) return null;
        const p1 = keptEnd(l1, corner, hint1), p2 = keptEnd(l2, corner, hint2);
        let d1 = { x: p1.x - corner.x, y: p1.y - corner.y };
        let d2 = { x: p2.x - corner.x, y: p2.y - corner.y };
        const l1len = Math.hypot(d1.x, d1.y), l2len = Math.hypot(d2.x, d2.y);
        if (dist > l1len || dist > l2len || l1len < EPS || l2len < EPS) return null;
        d1 = { x: d1.x / l1len, y: d1.y / l1len };
        d2 = { x: d2.x / l2len, y: d2.y / l2len };
        const t1 = { x: corner.x + d1.x * dist, y: corner.y + d1.y * dist };
        const t2 = { x: corner.x + d2.x * dist, y: corner.y + d2.y * dist };
        return { corner, p1, p2, line1End: t1, line2End: t2, bevel: { a: t1, b: t2 } };
    }

    /**
     * Vertex shared by two polyline spans, or -1 when they do not adjoin.
     * Span i runs from vertex i to vertex i+1; on a closed polyline the last
     * span wraps back to vertex 0.
     */
    function sharedCornerIndex(segA, segB, vertexCount, closed) {
        const n = vertexCount;
        if (!(n >= 3) || segA === segB || segA < 0 || segB < 0) return -1;
        const spanCount = closed ? n : n - 1;
        if (segA >= spanCount || segB >= spanCount) return -1;
        if (segA + 1 === segB) return segB;
        if (segB + 1 === segA) return segA;
        // The wrap-around join exists only on a closed polyline.
        if (closed && segA === spanCount - 1 && segB === 0) return 0;
        if (closed && segB === spanCount - 1 && segA === 0) return 0;
        return -1;
    }

    /**
     * Fillet or chamfer the corner where two adjoining STRAIGHT spans of a
     * polyline meet. The corner vertex is replaced by the two cut points; for a
     * fillet the first of them carries the bulge that draws the arc.
     *
     *   verts       [{x, y, bulge}] — the polyline's vertices
     *   closed      whether the last span wraps to the first vertex
     *   cornerIndex the vertex shared by the two spans
     *   param       fillet radius, or chamfer setback along each span
     *   mode        'fillet' | 'chamfer'
     *
     * Curved spans are refused: rounding an already-curved corner needs a
     * tangent solve rather than this straight-span construction. Returns
     * { vertices, cut, bulge, t1, t2 } or null when the corner cannot take it.
     */
    function polylineCornerCut(verts, closed, cornerIndex, param, mode) {
        const n = Array.isArray(verts) ? verts.length : 0;
        if (n < 3 || !(param > 0)) return null;
        if (!Number.isInteger(cornerIndex) || cornerIndex < 0 || cornerIndex >= n) return null;
        // An open polyline's first and last vertices are free ends, not corners.
        if (!closed && (cornerIndex === 0 || cornerIndex === n - 1)) return null;

        const pi = (cornerIndex - 1 + n) % n;
        const ni = (cornerIndex + 1) % n;
        const bulgeOf = (v) => Math.abs(Number(v && v.bulge) || 0);
        // verts[i].bulge describes the span i → i+1, so these are the two spans
        // that meet at the corner.
        if (bulgeOf(verts[pi]) > EPS || bulgeOf(verts[cornerIndex]) > EPS) return null;

        const C = verts[cornerIndex], A = verts[pi], B = verts[ni];
        let d1 = { x: A.x - C.x, y: A.y - C.y };
        let d2 = { x: B.x - C.x, y: B.y - C.y };
        const l1 = Math.hypot(d1.x, d1.y), l2 = Math.hypot(d2.x, d2.y);
        if (l1 < EPS || l2 < EPS) return null;
        d1 = { x: d1.x / l1, y: d1.y / l1 };
        d2 = { x: d2.x / l2, y: d2.y / l2 };

        const dot = Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y));
        const angle = Math.acos(dot);                  // interior angle at the corner
        // A straight run has nothing to round; a doubled-back one has no corner.
        if (angle < 1e-6 || Math.PI - angle < 1e-6) return null;

        const cut = mode === 'chamfer' ? param : param / Math.tan(angle / 2);
        if (!(cut > EPS) || cut >= l1 || cut >= l2) return null;

        const t1 = { x: C.x + d1.x * cut, y: C.y + d1.y * cut };
        const t2 = { x: C.x + d2.x * cut, y: C.y + d2.y * cut };

        let bulge = 0;
        if (mode !== 'chamfer') {
            // Bulge = tan(sweep/4), signed by the direction the polyline turns:
            // positive is counter-clockwise, matching the DXF convention.
            const sweep = Math.PI - angle;
            const inDir = { x: -d1.x, y: -d1.y };      // travel direction into the corner
            const cross = inDir.x * d2.y - inDir.y * d2.x;
            bulge = Math.tan(sweep / 4) * (cross >= 0 ? 1 : -1);
        }

        const copy = (v, x, y, b) => {
            const o = { x, y, bulge: b };
            if (Number.isFinite(v && v.startWidth)) o.startWidth = v.startWidth;
            if (Number.isFinite(v && v.endWidth)) o.endWidth = v.endWidth;
            return o;
        };
        const vertices = verts.map(v => copy(v, v.x, v.y, Number(v.bulge) || 0));
        vertices.splice(cornerIndex, 1, copy(C, t1.x, t1.y, bulge), copy(C, t2.x, t2.y, 0));

        return { vertices, cut, bulge, t1, t2, cornerIndex };
    }

    /**
     * Reverse a vertex run, moving the bulges with it.
     *
     * A bulge lives on the vertex that STARTS the span it describes, so reversing
     * the order alone would leave every arc attached to the wrong span and bowing
     * the wrong way. Each bulge therefore shifts back by one vertex and flips
     * sign, because the span is now travelled in the opposite direction.
     */
    function reverseChain(vertices) {
        const n = vertices.length;
        const out = [];
        for (let j = 0; j < n; j++) {
            const v = vertices[n - 1 - j];
            // The span leaving reversed vertex j is the original span that ENDED at
            // it, i.e. the one starting at vertex n-2-j.
            const b = j < n - 1 ? -(Number(vertices[n - 2 - j].bulge) || 0) : 0;
            const o = { x: v.x, y: v.y, bulge: b };
            if (Number.isFinite(v.startWidth)) o.startWidth = v.startWidth;
            if (Number.isFinite(v.endWidth)) o.endWidth = v.endWidth;
            out.push(o);
        }
        return out;
    }

    function copyChain(vertices) {
        return vertices.map(v => {
            const o = { x: v.x, y: v.y, bulge: Number(v.bulge) || 0 };
            if (Number.isFinite(v.startWidth)) o.startWidth = v.startWidth;
            if (Number.isFinite(v.endWidth)) o.endWidth = v.endWidth;
            return o;
        });
    }

    function samePoint(a, b, tol) {
        return Math.hypot(a.x - b.x, a.y - b.y) <= tol;
    }

    /**
     * Join open vertex runs end-to-end into one longer run.
     *
     *   chains  [{ vertices: [{x, y, bulge}], closed }]  — two or more
     *   tol     how close two endpoints must be to count as the same point
     *
     * Chains are consumed greedily from the first one, growing at either end and
     * reversing whichever run needs it, so the user's pick order and the stored
     * direction of each polyline do not matter. Returns
     * { vertices, closed, joined } — `joined` counting the runs merged — or null
     * when the ends do not meet, when fewer than two runs were supplied, or when
     * any of them is already closed (a closed loop has no free end to join to).
     */
    function joinChains(chains, tol) {
        const eps = Number.isFinite(tol) && tol > 0 ? tol : EPS;
        const runs = (chains || []).filter(c => c && Array.isArray(c.vertices) && c.vertices.length >= 2);
        if (runs.length < 2) return null;
        if (runs.some(c => c.closed)) return null;

        let acc = copyChain(runs[0].vertices);
        const pending = runs.slice(1).map(c => copyChain(c.vertices));
        let joined = 1;

        let progress = true;
        while (pending.length && progress) {
            progress = false;
            for (let i = 0; i < pending.length; i++) {
                const other = pending[i];
                const accStart = acc[0], accEnd = acc[acc.length - 1];
                const oStart = other[0], oEnd = other[other.length - 1];

                let piece = null, atEnd = true;
                if (samePoint(accEnd, oStart, eps)) { piece = other; atEnd = true; }
                else if (samePoint(accEnd, oEnd, eps)) { piece = reverseChain(other); atEnd = true; }
                else if (samePoint(accStart, oEnd, eps)) { piece = other; atEnd = false; }
                else if (samePoint(accStart, oStart, eps)) { piece = reverseChain(other); atEnd = false; }
                if (!piece) continue;

                if (atEnd) {
                    // The shared point survives as acc's last vertex, so it takes over
                    // the outgoing bulge of the piece's first vertex.
                    acc[acc.length - 1].bulge = Number(piece[0].bulge) || 0;
                    for (let k = 1; k < piece.length; k++) acc.push(piece[k]);
                } else {
                    // Prepending: the piece's last vertex is the shared one, so it is
                    // dropped in favour of acc[0], which already carries the right
                    // outgoing bulge. Every other bulge stays where it is.
                    acc = [...piece.slice(0, piece.length - 1), ...acc];
                }
                pending.splice(i, 1);
                joined++;
                progress = true;
                break;
            }
        }

        if (pending.length) return null;   // something never met the growing chain

        // Ends that meet turn the result into a closed loop rather than leaving a
        // duplicated vertex sitting on top of the start point.
        let closed = false;
        if (acc.length > 2 && samePoint(acc[0], acc[acc.length - 1], eps)) {
            // Only the duplicated vertex goes. In a closed run the last remaining
            // vertex already carries the bulge for the span that wraps to the
            // start, so no bulge is touched here.
            acc.pop();
            closed = true;
        }
        if (acc.length < 2) return null;
        return { vertices: acc, closed, joined };
    }

    // ===================== Polyline trimming =====================
    // A polyline is walked with one continuous parameter: t = spanIndex + u, where
    // u is the fraction travelled along that span. Cuts, the click and the pieces
    // that survive are all expressed in it, so straight and bulged spans are
    // handled by the same bookkeeping.

    /**
     * Centre, radius and signed sweep of a bulged span. Mirrors the convention the
     * renderer uses, so the arc computed here is the arc drawn on screen: positive
     * bulge sweeps counter-clockwise, and the centre sits on the left of the chord
     * scaled by cos(sweep/2).
     */
    function bulgeArc(p1, p2, bulge) {
        const b = Number(bulge) || 0;
        if (Math.abs(b) < 1e-12) return null;
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const chord = Math.hypot(dx, dy);
        if (chord < EPS) return null;
        const theta = 4 * Math.atan(b);
        const radius = Math.abs(chord / (2 * Math.sin(theta / 2)));
        const h = radius * Math.cos(Math.abs(theta) / 2) * (b >= 0 ? 1 : -1);
        const center = {
            x: (p1.x + p2.x) / 2 + (-dy / chord) * h,
            y: (p1.y + p2.y) / 2 + (dx / chord) * h,
        };
        return { center, radius, theta, startAngle: Math.atan2(p1.y - center.y, p1.x - center.x) };
    }

    /** Fraction along a bulged span at which the given angle sits, or null. */
    function arcFractionAtAngle(arc, angle) {
        if (!arc || Math.abs(arc.theta) < EPS) return null;
        const travelled = arc.theta > 0
            ? normAngle(angle - arc.startAngle)
            : normAngle(arc.startAngle - angle);
        const u = travelled / Math.abs(arc.theta);
        return u <= 1 + 1e-9 ? Math.min(1, u) : null;
    }

    /** The point a fraction u along a span, straight or bulged. */
    function pointOnSpan(p1, p2, bulge, u) {
        const arc = bulgeArc(p1, p2, bulge);
        if (!arc) return { x: p1.x + (p2.x - p1.x) * u, y: p1.y + (p2.y - p1.y) * u };
        const a = arc.startAngle + arc.theta * u;
        return { x: arc.center.x + Math.cos(a) * arc.radius, y: arc.center.y + Math.sin(a) * arc.radius };
    }

    /**
     * The bulge of the piece of a span between fractions u0 and u1. A bulge is
     * tan(sweep/4), so a sub-arc covering part of the sweep is simply
     * tan((u1-u0)·atan(bulge)) — no arc reconstruction needed.
     */
    function subSpanBulge(bulge, u0, u1) {
        const b = Number(bulge) || 0;
        if (Math.abs(b) < 1e-12) return 0;
        return Math.tan((u1 - u0) * Math.atan(b));
    }

    /** Closest point on a span to (px, py): { u, dist }. */
    function closestOnSpan(p1, p2, bulge, px, py) {
        const arc = bulgeArc(p1, p2, bulge);
        if (!arc) {
            const dx = p2.x - p1.x, dy = p2.y - p1.y;
            const len2 = dx * dx + dy * dy;
            if (len2 < EPS) return { u: 0, dist: Math.hypot(px - p1.x, py - p1.y) };
            let u = ((px - p1.x) * dx + (py - p1.y) * dy) / len2;
            u = Math.max(0, Math.min(1, u));
            return { u, dist: Math.hypot(p1.x + dx * u - px, p1.y + dy * u - py) };
        }
        const ang = Math.atan2(py - arc.center.y, px - arc.center.x);
        let u = arcFractionAtAngle(arc, ang);
        // Off the arc's sweep entirely: the nearer of its two ends wins.
        if (u === null) {
            const d1 = Math.hypot(px - p1.x, py - p1.y);
            const d2 = Math.hypot(px - p2.x, py - p2.y);
            u = d1 <= d2 ? 0 : 1;
        }
        const pt = pointOnSpan(p1, p2, bulge, u);
        return { u, dist: Math.hypot(pt.x - px, pt.y - py) };
    }

    /** Span count: one per edge, plus the closing edge when the run is closed. */
    function spanCount(vertexCount, closed) {
        return closed ? vertexCount : vertexCount - 1;
    }

    /** Global parameter of the point on the polyline nearest (px, py). */
    function polylineParamAt(vertices, closed, px, py) {
        const n = vertices.length;
        const N = spanCount(n, closed);
        let best = null;
        for (let i = 0; i < N; i++) {
            const r = closestOnSpan(vertices[i], vertices[(i + 1) % n], vertices[i].bulge, px, py);
            if (!best || r.dist < best.dist) best = { t: i + r.u, dist: r.dist };
        }
        return best;
    }

    /**
     * Global parameters where the cutting segments meet the polyline. Endpoints of
     * cutters that merely touch it count too: in real drawings an edge very often
     * stops on the polyline rather than crossing it.
     */
    function polylineCutParams(vertices, closed, cutters, touchTol) {
        const n = vertices.length;
        const N = spanCount(n, closed);
        const tol = Number.isFinite(touchTol) && touchTol > 0 ? touchTol : 1e-9;
        const out = [];
        for (let i = 0; i < N; i++) {
            const p1 = vertices[i], p2 = vertices[(i + 1) % n];
            const b = Number(p1.bulge) || 0;
            const arc = bulgeArc(p1, p2, b);
            for (const s of cutters || []) {
                const c1 = { x: s.x1, y: s.y1 }, c2 = { x: s.x2, y: s.y2 };
                if (arc) {
                    for (const ang of segCircleAngles(c1, c2, arc.center, arc.radius)) {
                        const u = arcFractionAtAngle(arc, ang);
                        if (u !== null) out.push(i + u);
                    }
                } else {
                    const hit = segSegIntersection(p1, p2, c1, c2);
                    if (hit) out.push(i + hit.t);
                }
                // A cutter that ends on the polyline without crossing it.
                for (const end of [c1, c2]) {
                    const r = closestOnSpan(p1, p2, b, end.x, end.y);
                    if (r.dist <= tol) out.push(i + r.u);
                }
            }
        }
        return out;
    }

    /**
     * Copy the polyline between two global parameters, walking forwards and
     * wrapping past the end when the run is closed. Boundary spans are split, with
     * the pieces keeping the right share of any arc.
     */
    function extractPolylineRun(vertices, closed, tA, tB) {
        const n = vertices.length;
        const N = spanCount(n, closed);
        const total = tB - tA;
        if (!(total > 1e-9)) return null;
        const out = [];
        let i = Math.floor(tA + 1e-9);
        let u0 = tA - i;
        if (u0 > 1 - 1e-9) { i += 1; u0 = 0; }
        let consumed = 0;
        let guard = N + 2;                       // a run can wrap at most once
        while (consumed < total - 1e-9 && guard-- > 0) {
            const span = ((i % N) + N) % N;
            const p1 = vertices[span], p2 = vertices[(span + 1) % n];
            const b = Number(p1.bulge) || 0;
            const take = Math.min(1 - u0, total - consumed);
            const u1 = u0 + take;
            const start = u0 <= 1e-9 ? { x: p1.x, y: p1.y } : pointOnSpan(p1, p2, b, u0);
            const v = { x: start.x, y: start.y, bulge: subSpanBulge(b, u0, u1) };
            if (Number.isFinite(p1.startWidth)) v.startWidth = p1.startWidth;
            if (Number.isFinite(p1.endWidth)) v.endWidth = p1.endWidth;
            out.push(v);
            consumed += take;
            if (consumed >= total - 1e-9) {
                const end = u1 >= 1 - 1e-9 ? { x: p2.x, y: p2.y } : pointOnSpan(p1, p2, b, u1);
                out.push({ x: end.x, y: end.y, bulge: 0 });
            }
            u0 = 0;
            i += 1;
        }
        return out.length >= 2 ? out : null;
    }

    /**
     * TRIM a polyline: drop the stretch the user clicked, bounded by the nearest
     * cut on each side.
     *
     *   vertices  [{x, y, bulge}]
     *   closed    whether the last span wraps to the first vertex
     *   cutters   [{x1, y1, x2, y2}] — every other visible edge, flattened
     *   click     {x, y} — where the user clicked on the polyline
     *
     * An open polyline loses a stretch from one end (one piece survives) or from
     * the middle (two do). A closed one always yields a single open run. Returns
     * { runs: [{ vertices, closed }], wholeEntity } — `wholeEntity` meaning the
     * click had no cut on either side and the entire object is the clicked
     * stretch — or null when there is nothing to cut.
     */
    function computePolylineTrim(vertices, closed, cutters, click, touchTol) {
        const verts = Array.isArray(vertices) ? vertices : [];
        const n = verts.length;
        const N = spanCount(n, closed);
        if (N < 1) return null;

        const at = polylineParamAt(verts, closed, click.x, click.y);
        if (!at) return null;
        const clickT = at.t;

        // Cuts on the parameter line, de-duplicated. On a closed run the seam at
        // 0 and N is the same point, so a cut there must not appear twice.
        const raw = polylineCutParams(verts, closed, cutters, touchTol)
            .filter(t => Number.isFinite(t) && t >= -1e-9 && t <= N + 1e-9)
            .map(t => Math.min(N, Math.max(0, t)));
        const ts = [];
        for (const t of raw.sort((a, b) => a - b)) {
            if (ts.length && t - ts[ts.length - 1] <= 1e-7) continue;
            ts.push(t);
        }
        if (closed && ts.length > 1 && ts[0] + N - ts[ts.length - 1] <= 1e-7) ts.pop();

        if (closed) {
            if (ts.length < 2) return null;      // no stretch to remove, only a point
            let i = -1;
            for (let k = 0; k < ts.length; k++) { if (ts[k] <= clickT) i = k; else break; }
            if (i === -1) i = ts.length - 1;
            const from = ts[(i + 1) % ts.length];
            let to = ts[i];
            if (to <= from) to += N;             // the survivor wraps past the seam
            const run = extractPolylineRun(verts, true, from, to);
            return run ? { runs: [{ vertices: run, closed: false }], wholeEntity: false } : null;
        }

        // Open: interior cuts only — one at a free end has nothing behind it.
        const interior = ts.filter(t => t > 1e-9 && t < N - 1e-9);
        let lower = null, upper = null;
        for (const t of interior) {
            if (t < clickT) lower = t;
            else if (upper === null) { upper = t; break; }
        }
        if (lower === null && upper === null) {
            return { runs: [], wholeEntity: true };
        }
        const runs = [];
        if (lower !== null) {
            const r = extractPolylineRun(verts, false, 0, lower);
            if (r) runs.push({ vertices: r, closed: false });
        }
        if (upper !== null) {
            const r = extractPolylineRun(verts, false, upper, N);
            if (r) runs.push({ vertices: r, closed: false });
        }
        return runs.length ? { runs, wholeEntity: false } : null;
    }

    // ===== LENGTHEN: change a line/arc length by a signed delta =====

    /**
     * LENGTHEN a line a→b at one end. Positive delta extends, negative
     * shortens. Returns the moved endpoint { x, y }, or null when the result
     * would vanish or invert.
     */
    function computeLengthenLine(a, b, end, delta) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < EPS) return null;
        const newLen = len + delta;
        if (newLen <= EPS) return null;
        const ux = dx / len, uy = dy / len;
        if (end === 'end') return { x: a.x + ux * newLen, y: a.y + uy * newLen };
        return { x: b.x - ux * newLen, y: b.y - uy * newLen };
    }

    /**
     * LENGTHEN an arc at one end by a signed ARC-LENGTH delta. Returns new
     * { startAngle, endAngle } (radians), or null when the arc would vanish
     * or close into a full circle.
     */
    function computeLengthenArc(startAngle, endAngle, radius, end, delta) {
        if (!(radius > 0)) return null;
        let sweep = normAngle(endAngle - startAngle);
        if (sweep < EPS) sweep = TAU;
        const newSweep = sweep + delta / radius;
        if (newSweep <= 1e-9 || newSweep >= TAU - 1e-9) return null;
        if (end === 'end') return { startAngle, endAngle: startAngle + newSweep };
        return { startAngle: endAngle - newSweep, endAngle };
    }

    // ===== BREAK: remove the stretch between two picked points =====

    /**
     * BREAK a line a→b between two picked points. Both picks are projected
     * onto the segment. Returns the same shapes as computeLineTrim —
     * shorten-start / shorten-end / split — plus { kind:'whole' } when the
     * picks span the entire line, or null for coincident picks.
     */
    function computeLineBreak(a, b, p1, p2) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < EPS * EPS) return null;
        const param = (p) => Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        let t1 = param(p1), t2 = param(p2);
        if (t2 < t1) { const t = t1; t1 = t2; t2 = t; }
        if (t2 - t1 <= 1e-9) return null;
        const lerp = (t) => ({ x: a.x + dx * t, y: a.y + dy * t });
        const atStart = t1 <= 1e-9, atEnd = t2 >= 1 - 1e-9;
        if (atStart && atEnd) return { kind: 'whole' };
        if (atStart) return { kind: 'shorten-start', newStart: lerp(t2) };
        if (atEnd) return { kind: 'shorten-end', newEnd: lerp(t1) };
        return { kind: 'split', end1: lerp(t1), start2: lerp(t2) };
    }

    /**
     * BREAK a full circle between two picks. The stretch removed runs CCW from
     * the FIRST pick to the second (AutoCAD convention), so the surviving arc
     * runs CCW from the second pick back to the first. Returns
     * { startAngle, endAngle } (radians) or null for coincident picks.
     */
    function computeCircleBreak(center, p1, p2) {
        const a1 = Math.atan2(p1.y - center.y, p1.x - center.x);
        const a2 = Math.atan2(p2.y - center.y, p2.x - center.x);
        if (normAngle(a2 - a1) <= 1e-9 || normAngle(a1 - a2) <= 1e-9) return null;
        return { startAngle: a2, endAngle: a1 };
    }

    /**
     * BREAK an arc (CCW startAngle→endAngle) between two picks projected onto
     * it. Order along the arc decides the removed stretch. Same result shapes
     * as computeArcTrim plus { kind:'whole' }; null for coincident picks.
     */
    function computeArcBreak(startAngle, endAngle, p1Angle, p2Angle) {
        let sweep = normAngle(endAngle - startAngle);
        if (sweep < EPS) sweep = TAU;
        const param = (a) => Math.min(1, Math.max(0, normAngle(a - startAngle) / sweep));
        const items = [
            { a: p1Angle, t: param(p1Angle) },
            { a: p2Angle, t: param(p2Angle) },
        ].sort((p, q) => p.t - q.t);
        const [lo, hi] = items;
        if (hi.t - lo.t <= 1e-9) return null;
        const atStart = lo.t <= 1e-6, atEnd = hi.t >= 1 - 1e-6;
        if (atStart && atEnd) return { kind: 'whole' };
        if (atStart) return { kind: 'shorten-start', newStart: hi.a };
        if (atEnd) return { kind: 'shorten-end', newEnd: lo.a };
        return { kind: 'split', end1: lo.a, start2: hi.a };
    }

    /**
     * BREAK a polyline between two picks projected onto it (bulge-aware).
     * Open: removes the middle stretch → up to two runs (or zero when the
     * picks span the whole polyline). Closed: removes forward (increasing
     * parameter) from the FIRST pick to the second → one open run.
     * Returns { runs: [{ vertices, closed }] } or null.
     */
    function computePolylineBreak(vertices, closed, p1, p2) {
        const verts = Array.isArray(vertices) ? vertices : [];
        const N = spanCount(verts.length, closed);
        if (N < 1) return null;
        const at1 = polylineParamAt(verts, closed, p1.x, p1.y);
        const at2 = polylineParamAt(verts, closed, p2.x, p2.y);
        if (!at1 || !at2) return null;
        let t1 = at1.t, t2 = at2.t;
        if (closed) {
            if (Math.abs(t1 - t2) <= 1e-9) return null;
            // Survivor runs from the second pick forward to the first.
            let from = t2, to = t1;
            if (to <= from) to += N;
            const run = extractPolylineRun(verts, true, from, to);
            return run ? { runs: [{ vertices: run, closed: false }] } : null;
        }
        if (t2 < t1) { const t = t1; t1 = t2; t2 = t; }
        if (t2 - t1 <= 1e-9) return null;
        const runs = [];
        if (t1 > 1e-9) {
            const r = extractPolylineRun(verts, false, 0, t1);
            if (r) runs.push({ vertices: r, closed: false });
        }
        if (t2 < N - 1e-9) {
            const r = extractPolylineRun(verts, false, t2, N);
            if (r) runs.push({ vertices: r, closed: false });
        }
        return { runs };
    }

    const DxfToolModify = {
        segSegIntersection, raySegIntersection, rayCircleIntersections,
        angleInArc, computeLineTrim, computeExtension,
        endpointTouchParams, endpointsTouchSegments, distPointToSegment,
        offsetLine, offsetCircle, offsetArc, offsetPolyline,
        lineLinePoint, filletLines, chamferLines,
        sharedCornerIndex, polylineCornerCut,
        reverseChain, joinChains,
        segCircleAngles, normalizeCutAngles, computeCircleTrim, computeArcTrim,
        bulgeArc, pointOnSpan, subSpanBulge, closestOnSpan,
        polylineParamAt, polylineCutParams, extractPolylineRun, computePolylineTrim,
        computeLineBreak, computeCircleBreak, computeArcBreak, computePolylineBreak,
        computeLengthenLine, computeLengthenArc,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = DxfToolModify;
    if (root) root.DxfToolModify = DxfToolModify;
})(typeof window !== 'undefined' ? window : null);
