/**
 * dxf-assoc.js — associative hatch helpers (pure, no DOM).
 *
 * A linked HATCH (code 71 = 1) lists each boundary's source objects by handle
 * (97 count + 330 handles) and every source object carries a back-link to the
 * hatch in its {ACAD_REACTORS group. AutoCAD needs both sides.
 *
 *   signature(entity) → string      geometry fingerprint of a boundary object
 *   syncReactors(text, links) → text
 *       links: Map(sourceHandle → Set(hatchHandle)) for every linked hatch.
 *       Adds missing back-links, drops ones that point to a hatch that no
 *       longer uses the object, and drops dangling ones (handle not in file).
 *   interiorPoint(ring) → {x,y} | null   a point strictly inside a closed ring
 *
 * window.DxfAssoc + Node exports.
 */
(function (root) {
    'use strict';

    const r9 = (v) => (Number.isFinite(+v) ? Math.round(+v * 1e9) / 1e9 : v);
    const pt = (p) => (p ? [r9(p.x), r9(p.y)] : null);

    /** Geometry fingerprint: changes whenever the object's shape or place changes. */
    function signature(e) {
        if (!e) return '';
        const vs = Array.isArray(e.vertices) ? e.vertices.map(v => [r9(v.x), r9(v.y), r9(v.bulge || 0)]) : null;
        return JSON.stringify([
            e.type, vs, !!(e.shape || e.closed),
            pt(e.center), r9(e.radius), r9(e.startAngle), r9(e.endAngle), r9(e.__angleOffsetDeg || 0),
            pt(e.majorAxisEndPoint), r9(e.axisRatio ?? e.ratio), r9(e.startParameter ?? e.startAngle), r9(e.endParameter),
            (e.controlPoints || []).map(pt), (e.fitPoints || []).map(pt),
            pt(e.basePoint), pt(e.direction), pt(e.position || e.insertionPoint),
            r9(e.xScale), r9(e.yScale), r9(e.rotation), e.name || e.block || null,
            pt(e.__center), r9(e.__radius),
        ]);
    }

    /**
     * A point inside a closed ring (first/last equal): midpoints of scanline
     * spans, widest first. accept(p) can reject candidates (e.g. inside an island).
     */
    function interiorPoint(ring, accept) {
        if (!ring || ring.length < 4) return null;
        let minY = Infinity, maxY = -Infinity;
        for (const p of ring) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
        const cands = [];
        for (let k = 1; k < 24; k++) {
            const y = minY + (maxY - minY) * (k / 24);
            const xs = [];
            for (let i = 0; i < ring.length - 1; i++) {
                const a = ring[i], b = ring[i + 1];
                if ((a.y > y) !== (b.y > y)) xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
            }
            xs.sort((p, q) => p - q);
            for (let j = 0; j + 1 < xs.length; j += 2) {
                const w = xs[j + 1] - xs[j];
                // Several points per span, so a span crossing an island still offers one outside it.
                for (const f of [0.5, 0.25, 0.75, 0.1, 0.9]) cands.push({ x: xs[j] + w * f, y, w: w * (f === 0.5 ? 1 : 0.5) * (1 - Math.abs(k / 24 - 0.5)) });
            }
        }
        cands.sort((a, b) => b.w - a.w);
        for (const c of cands) if (!accept || accept(c)) return { x: c.x, y: c.y };
        return null;
    }

    /**
     * Rewrite {ACAD_REACTORS groups. Works on the line array of a whole DXF;
     * only ENTITIES and BLOCKS records are touched.
     */
    function syncReactors(text, links) {
        if (!text) return text;
        const lines = String(text).split('\n');
        const val = (i) => (lines[i] ?? '').trim();
        const eol = lines.length && lines[0].endsWith('\r') ? '\r' : '';
        // Every handle in the file, and which of them are hatches.
        const all = new Set(), hatches = new Set();
        let lastType = '';
        for (let i = 0; i + 1 < lines.length; i += 2) {
            const c = val(i), v = val(i + 1);
            if (c === '0') lastType = v.toUpperCase();
            else if (c === '5' || c === '105') { all.add(v.toUpperCase()); if (lastType === 'HATCH') hatches.add(v.toUpperCase()); }
        }
        const want = new Map();
        for (const [src, set] of links || []) want.set(String(src).toUpperCase(), new Set([...set].map(h => String(h).toUpperCase())));

        const out = [];
        let section = null, i = 0, changed = false;
        while (i + 1 < lines.length) {
            const c = val(i), v = val(i + 1);
            if (c === '0' && v.toUpperCase() === 'SECTION') { section = val(i + 3).toUpperCase(); out.push(lines[i], lines[i + 1]); i += 2; continue; }
            if (c === '0' && v.toUpperCase() === 'ENDSEC') { section = null; out.push(lines[i], lines[i + 1]); i += 2; continue; }
            if (c === '0' && (section === 'ENTITIES' || section === 'BLOCKS') && !['BLOCK', 'ENDBLK', 'SECTION', 'ENDSEC'].includes(v.toUpperCase())) {
                // One record: [i, j)
                let j = i + 2;
                while (j + 1 < lines.length && val(j) !== '0') j += 2;
                const rec = lines.slice(i, j);
                let h = null, hIdx = -1;
                for (let k = 2; k + 1 < rec.length; k += 2) if ((rec[k] ?? '').trim() === '5') { h = (rec[k + 1] ?? '').trim().toUpperCase(); hIdx = k; break; }
                if (h) {
                    // Existing reactor group.
                    let g0 = -1, g1 = -1;
                    const have = [];
                    for (let k = 2; k + 1 < rec.length; k += 2) {
                        if ((rec[k] ?? '').trim() === '102' && (rec[k + 1] ?? '').trim().toUpperCase() === '{ACAD_REACTORS') {
                            g0 = k;
                            for (let m = k + 2; m + 1 < rec.length; m += 2) {
                                const cm = (rec[m] ?? '').trim();
                                if (cm === '102') { g1 = m + 2; break; }
                                if (cm === '330') have.push((rec[m + 1] ?? '').trim().toUpperCase());
                            }
                            break;
                        }
                    }
                    const target = want.get(h) || new Set();
                    const next = have.filter(r => all.has(r) && !(hatches.has(r) && !target.has(r)));
                    for (const t of target) if (!next.includes(t) && all.has(t)) next.push(t);
                    const same = next.length === have.length && next.every((r, k) => r === have[k]);
                    if (!same) {
                        changed = true;
                        const group = next.length ? ['102' + eol, '{ACAD_REACTORS' + eol, ...next.flatMap(r => ['330' + eol, r + eol]), '102' + eol, '}' + eol] : [];
                        let body;
                        if (g0 >= 0 && g1 > g0) body = [...rec.slice(0, g0), ...group, ...rec.slice(g1)];
                        else body = [...rec.slice(0, hIdx + 2), ...group, ...rec.slice(hIdx + 2)];
                        out.push(...body);
                        i = j;
                        continue;
                    }
                }
                out.push(...rec);
                i = j;
                continue;
            }
            out.push(lines[i], lines[i + 1]);
            i += 2;
        }
        if (i < lines.length) out.push(...lines.slice(i));
        return changed ? out.join('\n') : text;
    }

    const DxfAssoc = { signature, syncReactors, interiorPoint };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfAssoc;
    if (root) root.DxfAssoc = DxfAssoc;
})(typeof window !== 'undefined' ? window : null);
