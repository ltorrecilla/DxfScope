/* Evaluate imported DXF control-point SPLINEs using their actual knot vector. */
(function (root) {
    'use strict';

    function sample(entity, options = {}) {
        const points = entity?.controlPoints;
        const degree = Number(entity?.degreeOfSplineCurve ?? entity?.degree);
        const knots = entity?.knotValues || entity?.knots;
        if (!Array.isArray(points) || !Array.isArray(knots) || points.length < 2
            || !Number.isInteger(degree) || degree < 1 || degree >= points.length
            || knots.length !== points.length + degree + 1) return null;
        const n = points.length - 1;
        const weights = entity.weights || entity.weightValues || entity.controlPointWeights || [];
        const first = Number(knots[degree]), last = Number(knots[n + 1]);
        if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first
            || knots.some((value, i) => !Number.isFinite(Number(value)) || (i > 0 && Number(value) < Number(knots[i - 1])))) return null;
        const evaluate = u => {
            let low = degree, high = n + 1;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (Number(knots[mid + 1]) <= u) low = mid + 1;
                else high = mid;
            }
            const span = u >= last ? n : Math.min(low, n);
            const work = [];
            for (let j = 0; j <= degree; j++) {
                const index = span - degree + j;
                const point = points[index];
                const weight = Number(weights[index] ?? point?.weight ?? 1);
                if (!point || !Number.isFinite(weight) || weight <= 0) return null;
                work.push([Number(point.x) * weight, Number(point.y) * weight,
                    Number(point.z || 0) * weight, weight]);
            }
            for (let r = 1; r <= degree; r++) for (let j = degree; j >= r; j--) {
                const index = span - degree + j;
                const denominator = Number(knots[index + degree - r + 1]) - Number(knots[index]);
                const alpha = denominator > 0 ? (u - Number(knots[index])) / denominator : 0;
                for (let c = 0; c < 4; c++) work[j][c] = (1 - alpha) * work[j - 1][c] + alpha * work[j][c];
            }
            const [x, y, z, w] = work[degree];
            return w > 0 && [x, y, z].every(Number.isFinite) ? { x: x / w, y: y / w, z: z / w } : null;
        };
        const spans = [];
        for (let i = degree; i <= n; i++) if (Number(knots[i + 1]) > Number(knots[i]))
            spans.push([Number(knots[i]), Number(knots[i + 1])]);
        const perSpan = Math.max(2, Math.min(48, Math.floor(Number(options.samplesPerSpan) || 16),
            Math.floor(8192 / Math.max(1, spans.length))));
        const result = [];
        for (const [a, b] of spans) for (let i = 0; i < perSpan; i++) {
            const point = evaluate(a + (b - a) * i / perSpan);
            if (point) result.push(point);
        }
        const end = evaluate(last);
        if (end) result.push(end);
        return result.length >= 2 ? result : null;
    }

    const api = { sample };
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.DxfSpline = api;
})(typeof window !== 'undefined' ? window : globalThis);
