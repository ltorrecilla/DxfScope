/**
 * dxf-xline.js — XLINE (construction line) and RAY.
 *
 * Both are infinite: XLINE both ways from its base point, RAY one way.
 * DXF: 10/20/30 base point, 11/21/31 unit direction vector (not a point).
 * dxf-parser drops both types, so they are read from the raw text here.
 *
 *   parseRawXlines(rawText) → [{ type, handle, layer, basePoint, direction, ... __rawKey }]
 *       ENTITIES section only; __rawKey uses the editor's 'E:<n>' indexing.
 *   clipToCircle(entity, center, radius) → {x1,y1,x2,y2} | null
 *       The visible piece inside a circle — what gets drawn. Callers pick a
 *       circle well beyond the view or the drawing extents.
 *   unit(dx, dy) → {x, y} | null
 *   isInfinite(entity) → bool
 *
 * Pure, no DOM. window.DxfXline + Node exports.
 */
(function (root) {
    'use strict';

    const fin = Number.isFinite;

    function isInfinite(e) {
        const t = String(e && e.type || '').toUpperCase();
        return t === 'XLINE' || t === 'RAY';
    }

    function unit(dx, dy) {
        const L = Math.hypot(dx, dy);
        return fin(L) && L > 1e-12 ? { x: dx / L, y: dy / L } : null;
    }

    /**
     * Piece of the infinite line (or ray) inside the circle (center, radius).
     * null when it misses the circle (or the ray points away from it).
     */
    function clipToCircle(e, center, radius) {
        const b = e && e.basePoint, d0 = e && e.direction;
        if (!b || !d0 || !center || !(radius > 0)) return null;
        const d = unit(Number(d0.x), Number(d0.y));
        if (!d || !fin(b.x) || !fin(b.y)) return null;
        // Line: b + t·d. Closest approach to the centre at t0.
        const t0 = (center.x - b.x) * d.x + (center.y - b.y) * d.y;
        const fx = b.x + d.x * t0, fy = b.y + d.y * t0;
        const off2 = (center.x - fx) ** 2 + (center.y - fy) ** 2;
        if (off2 >= radius * radius) return null;
        const half = Math.sqrt(radius * radius - off2);
        let t1 = t0 - half, t2 = t0 + half;
        if (String(e.type).toUpperCase() === 'RAY') {
            if (t2 <= 0) return null;
            t1 = Math.max(t1, 0);
        }
        return { x1: b.x + d.x * t1, y1: b.y + d.y * t1, x2: b.x + d.x * t2, y2: b.y + d.y * t2 };
    }

    function parseRawXlines(rawText, preparedLines = null) {
        const out = [];
        if (!rawText) return out;
        const lines = preparedLines || String(rawText).replace(/\r\n/g, '\n').split('\n');
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
                if (type === 'XLINE' || type === 'RAY') {
                    const e = {
                        type, handle: '', layer: '0',
                        basePoint: { x: NaN, y: NaN, z: 0 },
                        direction: { x: NaN, y: NaN, z: 0 },
                        inPaperSpace: false,
                    };
                    for (const [c, v] of pairs) {
                        const num = parseFloat(v);
                        switch (c) {
                            case '5': if (!e.handle) e.handle = v; break;
                            case '8': e.layer = v; break;
                            case '6': e.lineType = v; break;
                            case '48': e.lineTypeScale = num; break;
                            case '62': e.colorIndex = parseInt(v, 10); break;
                            case '420': e.trueColor = parseInt(v, 10); break;
                            case '370': e.lineweight = parseInt(v, 10); break;
                            case '67': e.inPaperSpace = parseInt(v, 10) === 1; break;
                            case '410': e.layoutName = v; break;
                            case '10': e.basePoint.x = num; break;
                            case '20': e.basePoint.y = num; break;
                            case '30': e.basePoint.z = num || 0; break;
                            case '11': e.direction.x = num; break;
                            case '21': e.direction.y = num; break;
                            case '31': e.direction.z = num || 0; break;
                        }
                    }
                    const d = unit(e.direction.x, e.direction.y);
                    if (fin(e.basePoint.x) && fin(e.basePoint.y) && d) {
                        e.direction = { x: d.x, y: d.y, z: 0 };
                        e.__rawKey = `E:${entityIdx}`;
                        out.push(e);
                    }
                }
                entityIdx++;
                i = j; continue;
            }
            i += 2;
        }
        return out;
    }

    const DxfXline = { parseRawXlines, clipToCircle, unit, isInfinite };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfXline;
    if (root) root.DxfXline = DxfXline;
})(typeof window !== 'undefined' ? window : null);
