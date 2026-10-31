/**
 * dxf_linetype.js — DXF linetype patterns: rendering choppers + LTYPE emission.
 *
 * Patterns follow the dxf-parser convention: positive = dash length,
 * negative = gap length, 0 = dot (rendered as a very short dash).
 * Lengths are in drawing units and scale with $LTSCALE.
 *
 * window.DxfLinetype + Node exports.
 */
(function (root) {
    'use strict';

    // Built-in patterns (subset of acad.lin), used when the file lacks the LTYPE
    // definition or when the user assigns a linetype the file doesn't define yet.
    const BUILTIN = {
        DASHED:  { description: 'Dashed __ __ __ __ __ __ __ __ __ __ __ __ __ _', pattern: [0.5, -0.25] },
        DOTTED:  { description: 'Dotted . . . . . . . . . . . . . . . . . . . .', pattern: [0, -0.25] },
        DASHDOT: { description: 'Dash dot __ . __ . __ . __ . __ . __ . __ . __', pattern: [0.5, -0.25, 0, -0.25] },
        CENTER:  { description: 'Center ____ _ ____ _ ____ _ ____ _ ____ _ ____', pattern: [1.25, -0.25, 0.25, -0.25] },
        HIDDEN:  { description: 'Hidden __ __ __ __ __ __ __ __ __ __ __ __ __', pattern: [0.25, -0.125] },
    };

    const DOT_LEN_FRACTION = 0.04; // a dot's rendered length, as a fraction of the pattern cycle

    /** Is this linetype name effectively continuous (no chopping needed)? */
    function isContinuousName(name) {
        const n = String(name || '').trim().toUpperCase();
        return !n || n === 'CONTINUOUS' || n === 'BYLAYER' || n === 'BYBLOCK';
    }

    /** Effective linetype for an entity: entity's own unless BYLAYER/absent. */
    function resolveLinetypeName(entityLt, layerLt) {
        const e = String(entityLt || '').trim().toUpperCase();
        if (e && e !== 'BYLAYER' && e !== 'BYBLOCK') return entityLt;
        return layerLt || null;
    }

    /**
     * Build a segment chopper for a pattern. Carries the pattern phase across
     * successive chop() calls, so tessellated curves (many short chords) show a
     * continuous dash flow instead of restarting per chord.
     *   pattern: array of dash/gap/dot lengths (drawing units)
     *   scale:   overall multiplier ($LTSCALE etc.)
     * Returns { chop(x1,y1,x2,y2) -> [{x1,y1,x2,y2}], reset() } or null if the
     * pattern is degenerate (falls back to continuous rendering).
     */
    function createChopper(pattern, scale) {
        if (!Array.isArray(pattern) || !pattern.length) return null;
        const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
        const cycleRaw = pattern.reduce((a, v) => a + Math.abs(v), 0);
        if (!(cycleRaw > 0)) return null;
        const dotLen = cycleRaw * DOT_LEN_FRACTION * s;
        // Normalize into [{len, draw}] with dots as short drawn stubs.
        const elems = pattern.map(v => {
            if (v > 0) return { len: v * s, draw: true };
            if (v < 0) return { len: -v * s, draw: false };
            return { len: dotLen, draw: true, dot: true };
        });
        const cycle = elems.reduce((a, e) => a + e.len, 0);
        if (!(cycle > 0)) return null;

        let idx = 0;        // current element
        let rem = elems[0].len; // remaining length in current element

        function advance(d) { // consume d along the pattern
            while (d > 1e-12) {
                if (d < rem) { rem -= d; return; }
                d -= rem;
                idx = (idx + 1) % elems.length;
                rem = elems[idx].len;
            }
        }

        return {
            reset() { idx = 0; rem = elems[0].len; },
            chop(x1, y1, x2, y2) {
                const segLen = Math.hypot(x2 - x1, y2 - y1);
                if (!(segLen > 1e-12)) return [];
                const ux = (x2 - x1) / segLen, uy = (y2 - y1) / segLen;
                const outSegs = [];
                let t = 0;
                while (t < segLen - 1e-12) {
                    const take = Math.min(rem, segLen - t);
                    if (elems[idx].draw) {
                        outSegs.push({
                            x1: x1 + ux * t, y1: y1 + uy * t,
                            x2: x1 + ux * (t + take), y2: y1 + uy * (t + take),
                        });
                    }
                    t += take;
                    advance(take);
                }
                return outSegs;
            },
        };
    }

    /** Raw LTYPE table record pairs for a built-in pattern (for saving). */
    function emitLtypeRecord(name, handle) {
        const def = BUILTIN[String(name).toUpperCase()];
        if (!def) return null;
        const pat = def.pattern;
        const patternLength = pat.reduce((a, v) => a + Math.abs(v), 0);
        const pairs = ['0', 'LTYPE'];
        if (handle) pairs.push('5', String(handle));
        pairs.push(
            '100', 'AcDbSymbolTableRecord', '100', 'AcDbLinetypeTableRecord',
            '2', String(name).toUpperCase(), '70', '0',
            '3', def.description,
            '72', '65', '73', String(pat.length), '40', String(patternLength),
        );
        for (const v of pat) pairs.push('49', String(v), '74', '0');
        return pairs;
    }

    const DxfLinetype = {
        BUILTIN, isContinuousName, resolveLinetypeName, createChopper, emitLtypeRecord,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = DxfLinetype;
    if (root) root.DxfLinetype = DxfLinetype;
})(typeof window !== 'undefined' ? window : null);
