/*
 * dxf_compare_engine.js — liteAECO DXF Compare
 * Pure diff engine. No DOM, no Three.js. Browser (window.DxfCompare) + Node exports.
 *
 * Two-stage matching:
 *   1. Handle mode  — both files carry stable string handles → pairwise compare.
 *   2. Fingerprint  — geometric hash multiset fallback (modified shows as del+add).
 *
 * Block definitions are diffed separately; a changed definition marks all its
 * INSERTs (transitively, through nested blocks) as modified.
 *
 * Model space only (entities with inPaperSpace === true are ignored).
 */
(function () {
    'use strict';

    var DEFAULT_TOLERANCE = 1e-4;

    // Keys that never describe drawing content.
    var EXCLUDE_KEYS = {
        handle: 1, ownerHandle: 1, materialObjectHandle: 1,
        inPaperSpace: 1, layoutName: 1, extendedData: 1,
        visible: 1 // visibility toggles are property noise, not geometry (flagged in docs)
    };
    // Internal viewer/parser bookkeeping.
    function isInternalKey(k) { return k.length > 1 && k.indexOf('__') === 0; }

    // ---- canonical serialization -------------------------------------------

    function quantize(n, tol) {
        if (!isFinite(n)) return 'x';
        var q = Math.round(n / tol);
        // Avoid "-0"
        return q === 0 ? '0' : String(q);
    }

    /**
     * Deterministic canonical string of a value.
     * Numbers quantized by tol; object keys sorted; excluded keys dropped.
     */
    function canon(v, tol) {
        if (v === null || v === undefined) return '~';
        var t = typeof v;
        if (t === 'number') return quantize(v, tol);
        if (t === 'string') return 's' + v;
        if (t === 'boolean') return v ? 'T' : 'F';
        if (Array.isArray(v)) {
            var parts = [];
            for (var i = 0; i < v.length; i++) parts.push(canon(v[i], tol));
            return '[' + parts.join(',') + ']';
        }
        if (t === 'object') {
            var keys = [];
            for (var k in v) {
                if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
                if (EXCLUDE_KEYS[k] || isInternalKey(k)) continue;
                if (v[k] === undefined) continue;
                keys.push(k);
            }
            keys.sort();
            var out = [];
            for (var j = 0; j < keys.length; j++) {
                out.push(keys[j] + ':' + canon(v[keys[j]], tol));
            }
            return '{' + out.join(',') + '}';
        }
        return '?';
    }

    /**
     * Fingerprint of one entity: type + layer + canonical content.
     * `withLayer:false` used for block-local entities where layer is inherited noise? 
     * No — layer changes inside blocks matter too. Keep layer always.
     */
    function fingerprint(entity, tol) {
        return (entity.type || '?') + '|' + (entity.layer || '0') + '|' + canon(entity, tol);
    }

    // ---- handle-mode viability ---------------------------------------------

    /**
     * Real DXF handles are hex strings from group 5. dxf-parser fabricates
     * numeric handles when missing — those are NOT stable across files.
     */
    function hasRealHandle(e) {
        return typeof e.handle === 'string' && e.handle.length > 0;
    }

    function handleModeViable(entsA, entsB, threshold) {
        threshold = threshold == null ? 0.8 : threshold;
        if (!entsA.length || !entsB.length) return false;
        var okA = 0, okB = 0;
        var seenA = {}, seenB = {}, dupA = false, dupB = false;
        for (var i = 0; i < entsA.length; i++) {
            if (hasRealHandle(entsA[i])) {
                okA++;
                if (seenA[entsA[i].handle]) dupA = true;
                seenA[entsA[i].handle] = 1;
            }
        }
        for (var j = 0; j < entsB.length; j++) {
            if (hasRealHandle(entsB[j])) {
                okB++;
                if (seenB[entsB[j].handle]) dupB = true;
                seenB[entsB[j].handle] = 1;
            }
        }
        if (dupA || dupB) return false;
        return (okA / entsA.length) >= threshold && (okB / entsB.length) >= threshold;
    }

    // ---- block definition diff ---------------------------------------------

    function normalizeBlocks(blocks) {
        // dxf-parser: drawing.blocks = { name: { name, entities: [...] } }
        var out = {};
        if (!blocks) return out;
        for (var name in blocks) {
            if (!Object.prototype.hasOwnProperty.call(blocks, name)) continue;
            var b = blocks[name];
            out[name] = (b && Array.isArray(b.entities)) ? b.entities : [];
        }
        return out;
    }

    function blockContentHash(entities, tol) {
        var fps = [];
        for (var i = 0; i < entities.length; i++) {
            fps.push(fingerprint(entities[i], tol));
        }
        fps.sort(); // order-independent multiset hash
        return fps.join('\n');
    }

    /**
     * Names of blocks whose effective content differs between A and B,
     * including transitive changes through nested INSERTs.
     * Returns { changed:Set-like map, added:[], removed:[] }.
     */
    function diffBlockDefs(blocksA, blocksB, tol) {
        var A = normalizeBlocks(blocksA), B = normalizeBlocks(blocksB);
        var changed = {}, added = [], removed = [];
        var name;
        for (name in A) {
            if (!(name in B)) { removed.push(name); changed[name] = 'removed'; }
        }
        for (name in B) {
            if (!(name in A)) { added.push(name); changed[name] = 'added'; }
        }
        for (name in A) {
            if (!(name in B)) continue;
            if (blockContentHash(A[name], tol) !== blockContentHash(B[name], tol)) {
                changed[name] = 'modified';
            }
        }
        // Transitive: block referencing a changed block is itself changed.
        // Iterate to fixpoint over B (current state) + A (for removed refs).
        var refs = {}; // name -> [inserted block names]
        function collectRefs(map) {
            for (var n in map) {
                var list = refs[n] || (refs[n] = []);
                var ents = map[n];
                for (var i = 0; i < ents.length; i++) {
                    var e = ents[i];
                    if (e && e.type === 'INSERT') {
                        var bn = e.name || e.block || e.blockName;
                        if (bn) list.push(bn);
                    }
                }
            }
        }
        collectRefs(A); collectRefs(B);
        var moved = true, guard = 0;
        while (moved && guard++ < 64) {
            moved = false;
            for (var n2 in refs) {
                if (changed[n2]) continue;
                var kids = refs[n2];
                for (var k = 0; k < kids.length; k++) {
                    if (changed[kids[k]]) { changed[n2] = 'nested'; moved = true; break; }
                }
            }
        }
        return { changed: changed, added: added, removed: removed };
    }

    // ---- main compare --------------------------------------------------------

    function listEntities(entities) {
        var out = [];
        if (!Array.isArray(entities)) return out;
        for (var i = 0; i < entities.length; i++) {
            if (entities[i]) out.push(entities[i]);
        }
        return out;
    }

    function modelSpace(entities) {
        var out = [];
        if (!Array.isArray(entities)) return out;
        for (var i = 0; i < entities.length; i++) {
            var e = entities[i];
            if (!e || e.inPaperSpace === true || e.__paperSpace === true) continue;
            out.push(e);
        }
        return out;
    }

    function insertBlockName(e) { return e.name || e.block || e.blockName || null; }

    /**
     * compare(drawingA, drawingB, opts)
     *   drawing*: { entities:[], blocks:{} }  (dxf-parser shape)
     *   opts.tolerance  — quantization step, default 1e-4
     *   opts.forceMode  — 'handle' | 'fingerprint' (optional override)
     *
     * Returns {
     *   mode: 'handle'|'fingerprint',
     *   tolerance,
     *   added:    [{b}],
     *   deleted:  [{a}],
     *   modified: [{a,b,reason}],        // empty in fingerprint mode except block-driven
     *   unchanged:[{a,b}],
     *   blocks: { changed:{name:kind}, added:[], removed:[] },
     *   counts: { added, deleted, modified, unchanged }
     * }
     */
    function compare(drawingA, drawingB, opts) {
        opts = opts || {};
        var tol = (typeof opts.tolerance === 'number' && opts.tolerance > 0)
            ? opts.tolerance : DEFAULT_TOLERANCE;

        var filterPaper = opts.filterPaperSpace !== false;
        var entsA = filterPaper ? modelSpace(drawingA && drawingA.entities) : listEntities(drawingA && drawingA.entities);
        var entsB = filterPaper ? modelSpace(drawingB && drawingB.entities) : listEntities(drawingB && drawingB.entities);

        var blockDiff = diffBlockDefs(
            drawingA && drawingA.blocks, drawingB && drawingB.blocks, tol);

        var mode = opts.forceMode;
        if (mode !== 'handle' && mode !== 'fingerprint') {
            mode = handleModeViable(entsA, entsB) ? 'handle' : 'fingerprint';
        }

        var added = [], deleted = [], modified = [], unchanged = [];
        var i, e, fp;

        if (mode === 'handle') {
            var byHandleA = {}, byHandleB = {};
            var restA = [], restB = []; // entities without real handles → fingerprint sub-pass
            for (i = 0; i < entsA.length; i++) {
                e = entsA[i];
                if (hasRealHandle(e)) byHandleA[e.handle] = e; else restA.push(e);
            }
            for (i = 0; i < entsB.length; i++) {
                e = entsB[i];
                if (hasRealHandle(e)) byHandleB[e.handle] = e; else restB.push(e);
            }
            for (var h in byHandleA) {
                var a = byHandleA[h], b = byHandleB[h];
                if (!b) { deleted.push({ a: a }); continue; }
                var fa = fingerprint(a, tol), fb = fingerprint(b, tol);
                if (fa === fb) {
                    // Content equal — but a changed block def modifies its INSERTs.
                    if (a.type === 'INSERT' && blockDiff.changed[insertBlockName(a)]) {
                        modified.push({ a: a, b: b, reason: 'block' });
                    } else {
                        unchanged.push({ a: a, b: b });
                    }
                } else {
                    modified.push({ a: a, b: b, reason: 'content' });
                }
            }
            for (var h2 in byHandleB) {
                if (!byHandleA[h2]) added.push({ b: byHandleB[h2] });
            }
            // Leftovers without handles: fingerprint them against each other.
            fpPass(restA, restB);
        } else {
            fpPass(entsA, entsB);
        }

        function fpPass(listA, listB) {
            var mapA = {}, mapB = {};
            for (var x = 0; x < listA.length; x++) {
                fp = fingerprint(listA[x], tol);
                (mapA[fp] || (mapA[fp] = [])).push(listA[x]);
            }
            for (var y = 0; y < listB.length; y++) {
                fp = fingerprint(listB[y], tol);
                (mapB[fp] || (mapB[fp] = [])).push(listB[y]);
            }
            for (var f in mapA) {
                var la = mapA[f], lb = mapB[f] || [];
                var n = Math.min(la.length, lb.length);
                for (var p = 0; p < n; p++) {
                    var ea = la[p], eb = lb[p];
                    if (ea.type === 'INSERT' && blockDiff.changed[insertBlockName(ea)]) {
                        modified.push({ a: ea, b: eb, reason: 'block' });
                    } else {
                        unchanged.push({ a: ea, b: eb });
                    }
                }
                for (var d = n; d < la.length; d++) deleted.push({ a: la[d] });
                for (var g = n; g < lb.length; g++) added.push({ b: lb[g] });
            }
            for (var f2 in mapB) {
                if (mapA[f2]) continue;
                var lb2 = mapB[f2];
                for (var q = 0; q < lb2.length; q++) added.push({ b: lb2[q] });
            }
        }

        return {
            mode: mode,
            tolerance: tol,
            added: added,
            deleted: deleted,
            modified: modified,
            unchanged: unchanged,
            blocks: blockDiff,
            counts: {
                added: added.length,
                deleted: deleted.length,
                modified: modified.length,
                unchanged: unchanged.length
            }
        };
    }

    /** Per-layer breakdown of a compare() result. { layer: {added,deleted,modified,unchanged} } */
    function layerBreakdown(result) {
        var out = {};
        function bump(layer, key) {
            var l = layer || '0';
            var row = out[l] || (out[l] = { added: 0, deleted: 0, modified: 0, unchanged: 0 });
            row[key]++;
        }
        var i;
        for (i = 0; i < result.added.length; i++) bump(result.added[i].b.layer, 'added');
        for (i = 0; i < result.deleted.length; i++) bump(result.deleted[i].a.layer, 'deleted');
        for (i = 0; i < result.modified.length; i++) bump((result.modified[i].b || result.modified[i].a).layer, 'modified');
        for (i = 0; i < result.unchanged.length; i++) bump(result.unchanged[i].a.layer, 'unchanged');
        return out;
    }

    var DxfCompare = {
        DEFAULT_TOLERANCE: DEFAULT_TOLERANCE,
        compare: compare,
        fingerprint: fingerprint,
        layerBreakdown: layerBreakdown,
        handleModeViable: handleModeViable,
        diffBlockDefs: diffBlockDefs,
        _canon: canon
    };

    if (typeof window !== 'undefined') {
        window.DxfCompare = DxfCompare;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = DxfCompare;
    }
})();
