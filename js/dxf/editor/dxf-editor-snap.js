/* Snap evaluation over a nearby candidate set; index, tracking state and graphics stay app-owned. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfEditorSnap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function snapAngleInSweep(a, start, sweep) {
        const TAU = Math.PI * 2;
        if (sweep >= TAU - 1e-9) return true;
        const t = ((a - start) % TAU + TAU) % TAU;
        return t <= sweep + 1e-9;
    }

    function projectPointToSegment(px, py, x1, y1, x2, y2) {
        const l2 = (x1 - x2) ** 2 + (y1 - y2) ** 2;
        if (l2 === 0) return { x: x1, y: y1, t: 0 };
        const rawT = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
        const t = Math.max(0, Math.min(1, rawT));
        return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), t, rawT };
    }

    function considerSnapCandidate(best, candidate, wx, wy, tolerance, priority) {
        const dist = Math.hypot(candidate.x - wx, candidate.y - wy);
        if (dist > tolerance) return best;
        const score = dist + priority * tolerance * 0.05;
        // A polyline vertex also appears as a generic END feature. On an
        // exact tie, keep the direct source vertex so dimensions can link.
        if (!best || score < best.score - 1e-9
            || (Math.abs(score - best.score) <= 1e-9 && candidate.source && !best.source)) {
            return { ...candidate, dist, score, snapped: true };
        }
        return best;
    }

    function snapIntersections(near, wx, wy, tol, push, limit) {
        const segs = near.segs.length > limit ? [] : near.segs;
        // Only segments that pass within the magnet can produce a crossing inside it.
        const local = segs.filter(s => {
            const p = projectPointToSegment(wx, wy, s.x1, s.y1, s.x2, s.y2);
            return Math.hypot(p.x - wx, p.y - wy) <= tol;
        });
        const straight = local.filter(s => !s.curve);
        const curvesNear = near.curves.filter(c => Math.abs(Math.hypot(wx - c.cx, wy - c.cy) - c.r) <= tol);
        // Straight × straight (tessellated chords of different curves are skipped:
        // curve crossings are solved exactly below).
        for (let a = 0; a < local.length; a++) {
            const s = local[a];
            for (let b = a + 1; b < local.length; b++) {
                const t = local[b];
                if (s.entity === t.entity && s.curve && t.curve) continue;
                if (s.curve && t.curve) continue;
                if ((s.curve && curvesNear.some(c => c.entity === s.entity)) || (t.curve && curvesNear.some(c => c.entity === t.entity))) continue;
                const rx = s.x2 - s.x1, ry = s.y2 - s.y1, qx = t.x2 - t.x1, qy = t.y2 - t.y1;
                const den = rx * qy - ry * qx;
                if (Math.abs(den) < 1e-12) continue;
                const ox = t.x1 - s.x1, oy = t.y1 - s.y1;
                const u = (ox * qy - oy * qx) / den, v = (ox * ry - oy * rx) / den;
                if (u < -1e-9 || u > 1 + 1e-9 || v < -1e-9 || v > 1 + 1e-9) continue;
                push(s.x1 + rx * u, s.y1 + ry * u);
            }
        }
        // Straight × circle/arc.
        for (const c of curvesNear) {
            for (const s of straight) {
                const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
                const A = dx * dx + dy * dy;
                if (A < 1e-18) continue;
                const fx = s.x1 - c.cx, fy = s.y1 - c.cy;
                const B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - c.r * c.r;
                const disc = B * B - 4 * A * C;
                if (disc < 0) continue;
                const sq = Math.sqrt(disc);
                for (const u of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
                    if (u < -1e-9 || u > 1 + 1e-9) continue;
                    const x = s.x1 + dx * u, y = s.y1 + dy * u;
                    if (snapAngleInSweep(Math.atan2(y - c.cy, x - c.cx), c.start, c.sweep)) push(x, y);
                }
            }
        }
        // Circle/arc × circle/arc.
        for (let a = 0; a < curvesNear.length; a++) {
            for (let b = a + 1; b < curvesNear.length; b++) {
                const p = curvesNear[a], q = curvesNear[b];
                const d = Math.hypot(q.cx - p.cx, q.cy - p.cy);
                if (d < 1e-12 || d > p.r + q.r + 1e-9 || d < Math.abs(p.r - q.r) - 1e-9) continue;
                const l = (p.r * p.r - q.r * q.r + d * d) / (2 * d);
                const hh = Math.sqrt(Math.max(0, p.r * p.r - l * l));
                const mx = p.cx + (q.cx - p.cx) * l / d, my = p.cy + (q.cy - p.cy) * l / d;
                const ex = -(q.cy - p.cy) / d, ey = (q.cx - p.cx) / d;
                for (const sgn of [1, -1]) {
                    const x = mx + ex * hh * sgn, y = my + ey * hh * sgn;
                    if (snapAngleInSweep(Math.atan2(y - p.cy, x - p.cx), p.start, p.sweep)
                        && snapAngleInSweep(Math.atan2(y - q.cy, x - q.cx), q.start, q.sweep)) push(x, y);
                }
            }
        }
    }

    function find(wx, wy, settings, candidates, tolerance, anchor, trackingAt, excludeSource = null, intersectionLimit = 400) {
        const S = settings;
        if (!S.enabled) return { x: wx, y: wy, type: 'FREE', snapped: false };
        const near = { ...candidates };
        if (excludeSource) {
            // A polyline being grip-edited is still present at its old
            // location until commit. Its own nearest-edge/midpoint snaps
            // can mask tracking guides and targets on other geometry.
            near.segs = near.segs.filter(seg => seg.source !== excludeSource);
            near.curves = near.curves.filter(curve => curve.source !== excludeSource);
            near.pts = near.pts.filter(point => point.source !== excludeSource || point.type === 'END');
        }
        let best = null;
        const consider = (c, priority) => { best = considerSnapCandidate(best, c, wx, wy, tolerance, priority); };

        // AutoCAD-style priority: exact points first, derived ones after.
        const PRIO = { END: 0, INT: 0, CEN: 0, QUA: 0, NOD: 0, INS: 0, MID: 1, PERP: 2, TAN: 2, EDGE: 3 };
        const enabledFor = { END: S.endpoint, MID: S.midpoint, CEN: S.center, QUA: S.quadrant, NOD: S.node, INS: S.insertion };
        for (const p of near.pts) {
            if (!enabledFor[p.type]) continue;
            consider(p, PRIO[p.type]);
        }

        if (S.intersection) {
            snapIntersections(near, wx, wy, tolerance, (x, y) => consider({ x, y, type: 'INT' }, PRIO.INT), intersectionLimit);
        }

        if (anchor && S.perpendicular) {
            for (const seg of near.segs) {
                if (seg.curve) continue;
                const foot = projectPointToSegment(anchor.x, anchor.y, seg.x1, seg.y1, seg.x2, seg.y2);
                if (foot.rawT >= 0 && foot.rawT <= 1) consider({ x: foot.x, y: foot.y, type: 'PERP', segment: seg }, PRIO.PERP);
            }
            // Perpendicular to a circle/arc lies on the line through its centre.
            for (const c of near.curves) {
                const dx = anchor.x - c.cx, dy = anchor.y - c.cy, L = Math.hypot(dx, dy);
                if (L < 1e-12) continue;
                for (const sgn of [1, -1]) {
                    const x = c.cx + dx / L * c.r * sgn, y = c.cy + dy / L * c.r * sgn;
                    if (snapAngleInSweep(Math.atan2(y - c.cy, x - c.cx), c.start, c.sweep)) consider({ x, y, type: 'PERP' }, PRIO.PERP);
                }
            }
        }

        if (anchor && S.tangent) {
            for (const c of near.curves) {
                const dx = anchor.x - c.cx, dy = anchor.y - c.cy, L = Math.hypot(dx, dy);
                if (L <= c.r + 1e-9) continue;   // anchor on or inside: no tangent
                const base = Math.atan2(dy, dx), off = Math.acos(c.r / L);
                for (const a of [base + off, base - off]) {
                    if (!snapAngleInSweep(a, c.start, c.sweep)) continue;
                    consider({ x: c.cx + c.r * Math.cos(a), y: c.cy + c.r * Math.sin(a), type: 'TAN' }, PRIO.TAN);
                }
            }
        }

        // Nearest is the fallback, as in AutoCAD: any real snap point inside
        // the magnet wins over a point merely lying on an edge.
        if (best) return best;

        // Tracking crossings take precedence over a merely nearby edge.
        const tracking = trackingAt({ x: wx, y: wy });
        if (tracking) return tracking;

        if (S.edge) {
            for (const seg of near.segs) {
                const edge = projectPointToSegment(wx, wy, seg.x1, seg.y1, seg.x2, seg.y2);
                consider({ x: edge.x, y: edge.y, type: 'EDGE', segment: seg }, PRIO.EDGE);
            }
            // On a true circle/arc, nearest is the exact radial projection.
            for (const c of near.curves) {
                const dx = wx - c.cx, dy = wy - c.cy, L = Math.hypot(dx, dy);
                if (L < 1e-12) continue;
                const a = Math.atan2(dy, dx);
                if (!snapAngleInSweep(a, c.start, c.sweep)) continue;
                consider({ x: c.cx + dx / L * c.r, y: c.cy + dy / L * c.r, type: 'EDGE' }, PRIO.EDGE - 0.5);
            }
        }

        return best || { x: wx, y: wy, type: 'FREE', snapped: false };
    }

    return { find, angleInSweep: snapAngleInSweep, projectPointToSegment };
});
