/**
 * dxf-purge.js — PURGE: find and remove unused named objects in raw DXF text.
 *
 *   analyze(text) → { layers:[name], blocks:[name], linetypes:[name],
 *                     styles:[name], dimstyles:[name] }      (unused items)
 *   purge(text, pick?) → { text, removed: {…same keys…} }
 *       pick: { layers: Set|array, … } limits what goes (default: everything
 *       unused). Nested items freed by a purge (a layer only used inside a
 *       purged block) are found in further passes, like AutoCAD's
 *       "Purge nested items".
 *
 * An item counts as used when it is referenced by name (code 8 layer, 6
 * linetype, 7 text style, 3 dimstyle, 2 block name on INSERT / DIMENSION,
 * header variables) or by handle from any other record (3xx pointer codes).
 * Never purged: layer 0, DEFPOINTS, the current layer / linetype / style /
 * dimstyle, BYLAYER / BYBLOCK / CONTINUOUS, STANDARD, anonymous and layout
 * blocks, shape-file styles, xref-dependent names (with "|").
 *
 * Pure text in, text out. window.DxfPurge + Node exports.
 */
(function (root) {
    'use strict';

    const KINDS = { LAYER: 'layers', LTYPE: 'linetypes', STYLE: 'styles', DIMSTYLE: 'dimstyles', BLOCK_RECORD: 'blocks' };
    const POINTER = (c) => { const n = +c; return (n >= 330 && n <= 369) || (n >= 390 && n <= 399) || (n >= 480 && n <= 481) || n === 1005; };

    function toPairs(text) {
        const lines = String(text).split('\n');
        const pairs = [];
        for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i], lines[i + 1]]);
        return { pairs, tail: lines.length % 2 ? [lines[lines.length - 1]] : [] };
    }
    const code = (p) => p[0].trim();
    const val = (p) => p[1].trim();

    /** Records: [{ section, table, type, start, end }] — pair index ranges. */
    function records(pairs) {
        const out = [];
        let section = null, table = null;
        for (let i = 0; i < pairs.length; i++) {
            if (code(pairs[i]) !== '0') continue;
            const t = val(pairs[i]).toUpperCase();
            if (t === 'SECTION') { section = pairs[i + 1] && code(pairs[i + 1]) === '2' ? val(pairs[i + 1]).toUpperCase() : null; continue; }
            if (t === 'ENDSEC') { section = null; continue; }
            if (t === 'TABLE') { table = pairs[i + 1] && code(pairs[i + 1]) === '2' ? val(pairs[i + 1]).toUpperCase() : null; }
            if (t === 'ENDTAB') { table = null; }
            let j = i + 1;
            while (j < pairs.length && code(pairs[j]) !== '0') j++;
            out.push({ section, table, type: t, start: i, end: j });
        }
        return out;
    }

    function recCodes(pairs, r) {
        const m = new Map();
        for (let k = r.start + 1; k < r.end; k++) {
            const c = code(pairs[k]);
            if (!m.has(c)) m.set(c, val(pairs[k]));
        }
        return m;
    }

    function analyzePairs(pairs) {
        const recs = records(pairs);
        const named = [];                 // { kind, name, handle, rec, flags }
        const blockDefs = new Map();      // BLOCK name (upper) → [records of BLOCK..ENDBLK]
        const header = new Map();
        // Header variables.
        for (let i = 0; i + 1 < pairs.length; i++) {
            if (code(pairs[i]) === '9') header.set(val(pairs[i]).toUpperCase(), val(pairs[i + 1]));
            if (code(pairs[i]) === '0' && val(pairs[i]).toUpperCase() === 'ENDSEC' && header.size) break;
        }
        let curBlock = null;
        for (const r of recs) {
            if (r.section === 'TABLES' && KINDS[r.type] && r.table === r.type) {
                const c = recCodes(pairs, r);
                named.push({ kind: KINDS[r.type], name: c.get('2') || '', handle: (c.get('5') || c.get('105') || '').toUpperCase(), rec: r, flags: +(c.get('70') || 0) });
            }
            if (r.section === 'BLOCKS') {
                if (r.type === 'BLOCK') { curBlock = (recCodes(pairs, r).get('2') || '').toUpperCase(); blockDefs.set(curBlock, [r]); continue; }
                if (curBlock) blockDefs.get(curBlock).push(r);
                if (r.type === 'ENDBLK') curBlock = null;
            }
        }
        // Which records belong to which block definition (to ignore self-references).
        const ownerOf = new Map();
        for (const [name, list] of blockDefs) for (const r of list) ownerOf.set(r.start, name);

        // Name and handle usage, per referencing record.
        const usedNames = { layers: new Map(), linetypes: new Map(), styles: new Map(), dimstyles: new Map(), blocks: new Map() };
        const handleRefs = new Map();     // handle → Set(owner block name | '*')
        const note = (m, name, owner) => { const k = String(name).toUpperCase(); if (!m.has(k)) m.set(k, new Set()); m.get(k).add(owner); };
        for (const r of recs) {
            if (r.section !== 'ENTITIES' && r.section !== 'BLOCKS' && r.section !== 'TABLES' && r.section !== 'OBJECTS') continue;
            const owner = ownerOf.get(r.start) || '*';
            const inTable = r.section === 'TABLES';
            const isEntity = r.section === 'ENTITIES' || (r.section === 'BLOCKS' && r.type !== 'BLOCK' && r.type !== 'ENDBLK');
            for (let k = r.start + 1; k < r.end; k++) {
                const c = code(pairs[k]), v = val(pairs[k]);
                if (POINTER(c)) {
                    const h = v.toUpperCase();
                    // A record pointing at itself or its owner is not a "use".
                    if (!handleRefs.has(h)) handleRefs.set(h, new Set());
                    handleRefs.get(h).add(inTable ? 'T:' + r.type + ':' + r.start : owner);
                }
                if (isEntity || (r.section === 'BLOCKS' && r.type === 'BLOCK')) {
                    if (c === '8') note(usedNames.layers, v, owner);
                    if (c === '6') note(usedNames.linetypes, v, owner);
                    if (c === '7' && /^(TEXT|MTEXT|ATTDEF|ATTRIB|DIMENSION|LEADER|TOLERANCE|MLINE)$/.test(r.type)) note(usedNames.styles, v, owner);
                    if (c === '3' && /^(DIMENSION|LEADER|TOLERANCE)$/.test(r.type)) note(usedNames.dimstyles, v, owner);
                    if (c === '2' && /^(INSERT|DIMENSION|ACAD_TABLE|TABLE)$/.test(r.type)) note(usedNames.blocks, v, owner);
                }
                if (inTable && r.type === 'LAYER' && c === '6') note(usedNames.linetypes, v, '*');
                if (inTable && r.type === 'DIMSTYLE' && (c === '3' || c === '4' || c === '5' || c === '6' || c === '7')) {
                    // Old-style dimstyle arrow block names / text style name.
                    if (c === '7') note(usedNames.styles, v, '*'); else note(usedNames.blocks, v, '*');
                }
            }
        }
        // Header references.
        const H = (k) => (header.get(k) || '').toUpperCase();
        const keep = {
            layers: new Set(['0', 'DEFPOINTS', H('$CLAYER')]),
            linetypes: new Set(['BYLAYER', 'BYBLOCK', 'CONTINUOUS', H('$CELTYPE')]),
            styles: new Set(['STANDARD', H('$TEXTSTYLE'), H('$DIMTXSTY')]),
            dimstyles: new Set(['STANDARD', H('$DIMSTYLE')]),
            blocks: new Set([H('$DIMBLK'), H('$DIMBLK1'), H('$DIMBLK2'), H('$DIMLDRBLK')]),
        };
        const unused = { layers: [], blocks: [], linetypes: [], styles: [], dimstyles: [] };
        for (const it of named) {
            const up = it.name.toUpperCase();
            if (!it.name || keep[it.kind].has(up) || it.name.includes('|')) continue;
            if (it.kind === 'blocks' && (it.name.startsWith('*') || /^\*?(MODEL|PAPER)_SPACE/i.test(it.name))) continue;
            if (it.kind === 'styles' && (it.flags & 1)) continue;            // shape file
            if (it.kind === 'layers' && (it.flags & 16)) continue;           // xref-dependent
            // By name, from anything but the item's own block definition.
            const byName = usedNames[it.kind].get(up);
            const selfOnly = (set) => [...set].every(o => it.kind === 'blocks' && o === up);
            if (byName && !selfOnly(byName)) continue;
            // By handle, from anything but its own block definition / its own record.
            const refs = it.handle ? handleRefs.get(it.handle) : null;
            const real = refs ? [...refs].filter(o => !(it.kind === 'blocks' && o === up) && o !== 'T:' + it.rec.type + ':' + it.rec.start) : [];
            // The BLOCK_RECORD table itself and layout objects point at block records;
            // only count references from entities, other tables and dictionaries' users.
            if (real.length) {
                if (it.kind !== 'blocks') continue;
                // For blocks, entities/objects in other blocks or the drawing count.
                continue;
            }
            unused[it.kind].push(it.name);
        }
        return { unused, named, blockDefs, recs };
    }

    function analyze(text) { return analyzePairs(toPairs(text).pairs).unused; }

    function purge(text, pick) {
        const removed = { layers: [], blocks: [], linetypes: [], styles: [], dimstyles: [] };
        let cur = String(text);
        const want = {};
        if (pick) for (const k of Object.keys(removed)) want[k] = pick[k] ? new Set([...pick[k]].map(s => String(s).toUpperCase())) : new Set();
        for (let pass = 0; pass < 8; pass++) {
            const { pairs, tail } = toPairs(cur);
            const { unused, named, blockDefs } = analyzePairs(pairs);
            const drop = new Set();     // pair indices start→end ranges to remove
            const ranges = [];
            let any = false;
            for (const kind of Object.keys(unused)) {
                for (const name of unused[kind]) {
                    if (pick && !want[kind].has(name.toUpperCase())) continue;
                    const it = named.find(n => n.kind === kind && n.name === name);
                    if (!it) continue;
                    ranges.push([it.rec.start, it.rec.end]);
                    if (kind === 'blocks') for (const r of blockDefs.get(name.toUpperCase()) || []) ranges.push([r.start, r.end]);
                    removed[kind].push(name);
                    any = true;
                }
            }
            if (!any) break;
            for (const [a, b] of ranges) for (let k = a; k < b; k++) drop.add(k);
            const kept = pairs.filter((_, k) => !drop.has(k));
            cur = kept.flatMap(p => p).concat(tail).join('\n');
            if (pick) break;            // an explicit pick is applied once, as listed
        }
        return { text: cur, removed };
    }

    const DxfPurge = { analyze, purge };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfPurge;
    if (root) root.DxfPurge = DxfPurge;
})(typeof window !== 'undefined' ? window : null);
