/* Pure snap selection shared by Compare measurement and alignment input. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfCompareSnap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    // Inputs are read-only; tolerance is supplied in drawing units by the caller.
    function find(p, segments, settings, tol, anchor) {
        if (!segments || settings.snapEnabled === false) return { x: p.x, y: p.y, type: 'FREE', snapped: false };
        const snapEnd = settings.snapEndpoint !== false;
        const snapMid = settings.snapMidpoint !== false;
        const snapEdge = settings.snapEdge !== false;
        const snapPerpendicular = settings.snapPerpendicular !== false;
        const snapIntersection = settings.snapIntersection !== false;
        const nearby = [];
        let best = null;
        // Editor scoring: nearer wins, with a small per-type priority penalty
        // so endpoints beat midpoints beat edge points at similar distance.
        const consider = (q, type, priority) => {
            const dist = Math.hypot(q.x - p.x, q.y - p.y);
            if (dist > tol) return;
            const score = dist + priority * tol * 0.05;
            if (!best || score < best.score) best = { x: q.x, y: q.y, type, score, snapped: true };
        };
        for (const q of segments.points || []) {
            if (q.type === 'NOD' ? settings.snapNode !== false : settings.snapInsertion !== false) consider(q, q.type, 0);
        }
        for (const c of segments.curves || []) {
            if (settings.snapCenter !== false) consider(c, 'CEN', 0);
            const at = a => ({ x: c.x + c.u.x * Math.cos(a) + c.v.x * Math.sin(a), y: c.y + c.u.y * Math.cos(a) + c.v.y * Math.sin(a) });
            const onArc = a => ((a - c.start) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) <= c.sweep + 1e-9;
            if (settings.snapQuadrant !== false) {
                for (const a of [Math.atan2(c.v.x, c.u.x), Math.atan2(c.v.y, c.u.y)]) {
                    for (const t of [a, a + Math.PI]) if (onArc(t)) consider(at(t), 'QUA', 1);
                }
            }
            if (settings.snapTangent !== false && anchor) {
                const det = c.u.x * c.v.y - c.u.y * c.v.x;
                if (Math.abs(det) < 1e-12) continue;
                const dx = anchor.x - c.x, dy = anchor.y - c.y;
                const x = (dx * c.v.y - dy * c.v.x) / det, y = (c.u.x * dy - c.u.y * dx) / det;
                const distance = Math.hypot(x, y);
                if (distance >= 1) {
                    const a = Math.atan2(y, x), delta = Math.acos(1 / distance);
                    for (const t of [a - delta, a + delta]) if (onArc(t)) consider(at(t), 'TAN', 1);
                }
            }
        }
        for (const s of segments) {
            if (snapEnd) {
                consider({ x: s.x1, y: s.y1 }, 'END', 0);
                consider({ x: s.x2, y: s.y2 }, 'END', 0);
            }
            if (snapMid) consider({ x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 }, 'MID', 1);
            if (snapEdge || snapPerpendicular || snapIntersection) {
                const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
                const len2 = dx * dx + dy * dy;
                if (len2 < 1e-18) continue;
                let t = ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / len2;
                t = Math.max(0, Math.min(1, t));
                const nearest = { x: s.x1 + t * dx, y: s.y1 + t * dy };
                if (snapEdge) consider(nearest, 'EDGE', 3);
                if (snapIntersection && Math.hypot(nearest.x - p.x, nearest.y - p.y) <= tol) nearby.push(s);
                if (snapPerpendicular && anchor) {
                    const foot = ((anchor.x - s.x1) * dx + (anchor.y - s.y1) * dy) / len2;
                    if (foot >= 0 && foot <= 1) consider({ x: s.x1 + foot * dx, y: s.y1 + foot * dy }, 'PERP', 1);
                }
            }
        }
        for (let i = 0; i < nearby.length; i++) for (let j = i + 1; j < nearby.length; j++) {
            const a = nearby[i], b = nearby[j];
            const ax = a.x2 - a.x1, ay = a.y2 - a.y1, bx = b.x2 - b.x1, by = b.y2 - b.y1;
            const cross = ax * by - ay * bx;
            if (Math.abs(cross) < 1e-12) continue;
            const qx = b.x1 - a.x1, qy = b.y1 - a.y1;
            const t = (qx * by - qy * bx) / cross, u = (qx * ay - qy * ax) / cross;
            if (t >= 0 && t <= 1 && u >= 0 && u <= 1) consider({ x: a.x1 + t * ax, y: a.y1 + t * ay }, 'INT', 0);
        }
        return best || { x: p.x, y: p.y, type: 'FREE', snapped: false };
    }
    return { find };
});
