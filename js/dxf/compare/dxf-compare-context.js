/* Drawing data and recovery lifecycle; no DOM or renderer dependencies. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfCompareContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
        function create(sideKey) {
            return {
                key: sideKey,          // 'A' | 'B'
                dxf: null,
                rawHatches: [],
                fileName: '',
                hatchLoopCache: new WeakMap(),
                dimTextHeightCache: null,
                modelEntities: [],     // parsed entities + raw hatches, model space
                paperActive: [],       // ENTITIES-section paper entities (active layout)
                layouts: [],           // [{ name, blockName, tabOrder, paperWidth, paperHeight }]
                viewports: [],         // raw VIEWPORT scan (DxfLayout.viewports)
                entityTags: {},        // raw ENTITIES scan: handle -> { owner, name410 }
                __layoutRecordSet: null, // lazy Set of layout block-record handles
            };
        }
        function isPaperEntity(e) { return !!(e && (e.inPaperSpace === true || e.__paperSpace === true)); }
        function prepare(ctx, rawText, fileName, deps) {
            // Silent sanitize: read-only tool, so structural fixes are free wins.
            let text = rawText;
            try {
                if (deps.DxfSanitize?.sanitizeDxf) text = deps.DxfSanitize.sanitizeDxf(rawText).text;
            } catch (e) { /* sanitize is best-effort */ }

            const parser = new deps.DxfParser();
            const dxf = parser.parseSync(text);
            deps.DxfAttributes?.recoverInsertAttributes(text, dxf);
            deps.DxfColor.recover(dxf, text);
            deps.DxfDimStyle.recover(dxf, text);
            // Match the editor: synthesized repair styles must not override the
            // original drawing's font fallback (e.g. sanitizer's STANDARD/txt).
            ctx.textStyles = deps.DxfText.parseStyles(rawText);
            deps.DxfText.applyRawTextProps(dxf, text);
            // Mirrored (negative-extrusion) arcs, circles, polylines and ellipses
            // store OCS coordinates; rewrite them world-aligned so both sides
            // render where AutoCAD draws them and fingerprint identically.
            ctx.mirror = deps.DxfOcs ? deps.DxfOcs.normalizeDrawing(dxf, text) : null;
            ctx.dxf = dxf;
            ctx.fileName = fileName;
            ctx.hatchLoopCache = new WeakMap();
            ctx.dimTextHeightCache = null;

            // dxf-parser drops HATCH / LEADER / WIPEOUT / ACAD_TABLE recover from raw text.
            const recoveredHatches = deps.DxfHatch?.parseRawDxfHatches ? deps.DxfHatch.parseRawDxfHatches(text) : [];
            ctx.rawHatches = recoveredHatches.filter(h => !h.__blockName);
            for (const hatch of recoveredHatches) {
                if (!hatch.__blockName) continue;
                const block = dxf.blocks?.[hatch.__blockName];
                if (block) (block.entities || (block.entities = [])).push(hatch);
            }
            if (!Array.isArray(dxf.entities)) dxf.entities = [];
            if (deps.DxfDim?.parseRawDxfLeaders) {
                for (const led of deps.DxfDim.parseRawDxfLeaders(text)) dxf.entities.push(led);
            }
            if (deps.DxfHatch?.parseRawDxfWipeouts) {
                for (const w of deps.DxfHatch.parseRawDxfWipeouts(text)) dxf.entities.push(w);
            }
            // MULTILEADER is dropped by dxf-parser too; LEADER loses its path type,
            // hook line and dimstyle overrides.
            ctx.mleaderBlockNames = new Map();
            ctx.leaderDimStyles = new Map();
            if (deps.DxfMLeader) {
                const M = deps.DxfMLeader;
                ctx.mleaderBlockNames = M.parseBlockRecordHandles(text);
                const found = M.parseRawMultileaders(text);
                for (const e of found.entities) { delete e.__rawBlock; dxf.entities.push(e); }
                for (const [name, list] of Object.entries(found.blocks)) {
                    const blk = dxf.blocks?.[name];
                    if (blk) { blk.entities = blk.entities || []; for (const e of list) { delete e.__rawBlock; blk.entities.push(e); } }
                }
                ctx.leaderDimStyles = M.parseRawDimStyles(text);
                const extras = M.parseRawLeaderExtras(text);
                for (const e of dxf.entities) if (e?.type === 'LEADER' && extras.has(e.__rawKey)) e.__leaderExtras = extras.get(e.__rawKey);
            }
            if (deps.DxfHatch?.parseRawDxfAcadTables) {
                for (const t of deps.DxfHatch.parseRawDxfAcadTables(text)) {
                    if (!t.__unsupported) dxf.entities.push(t);
                }
            }
            ctx.modelEntities = [
                ...dxf.entities.filter(e => !isPaperEntity(e)),
                ...ctx.rawHatches.filter(h => !isPaperEntity(h)),
            ];
            ctx.paperActive = [
                ...dxf.entities.filter(e => isPaperEntity(e)),
                ...ctx.rawHatches.filter(h => isPaperEntity(h)),
            ];
            ctx.layouts = deps.DxfLayout?.scan ? deps.DxfLayout.scan(text) : [];
            ctx.viewports = deps.DxfLayout?.viewports ? deps.DxfLayout.viewports(text) : [];
            ctx.entityTags = deps.DxfLayout.entityTags(text);
            ctx.__layoutRecordSet = null;
        }
    function replace(target, fresh) {
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(target, fresh);
        return target;
    }
    function reset(ctx) { return replace(ctx, create(ctx.key)); }
    function load(ctx, rawText, fileName, deps) {
        const fresh = create(ctx.key);
        prepare(fresh, rawText, fileName, deps);
        return replace(ctx, fresh);
    }
    // Read raw ownership tags without replacing source entity identities.
    function entityLayoutTag(ctx, e) {
        if (typeof e.__layoutName === 'string' && e.__layoutName) {
            return { owner: '', name410: e.__layoutName };
        }
        const h = e.handle != null ? String(e.handle).toUpperCase() : '';
        return (h && ctx.entityTags[h]) || { owner: '', name410: '' };
    }

    // Choose the active paper layout for otherwise untagged entities.
    function activeLayout(ctx) {
        const lays = ctx.layouts || [];
        if (lays.length === 1) return lays[0];
        const bare = lays.find(l => l.blockName && /^\*?PAPER_SPACE$/i.test(l.blockName));
        if (bare) return bare;
        let best = null;
        for (const l of lays) if (!best || l.tabOrder < best.tabOrder) best = l;
        return best;
    }

    // Partition ENTITIES-section paper content by owner, name, then active fallback.
    function paperEntitiesForLayout(ctx, lay, isActive, layoutApi) {
        const out = [];
        for (const e of ctx.paperActive) {
            const tag = entityLayoutTag(ctx, e);
            const owner = layoutApi.paperOwner({
                owner: tag.owner || (typeof e.ownerHandle === 'string' ? e.ownerHandle : ''),
                name410: tag.name410,
            }, ctx.layouts, isActive ? lay : null);
            if (owner === lay.name) out.push(e);
        }
        return out;
    }

    // Return source entities plus stable synthetic viewport frames for one space.
    function getSpaceEntities(ctx, key, layoutApi) {
        if (key === 'model') return ctx.modelEntities;
        const lay = ctx.layouts.find(l => l.name.toLowerCase() === key);
        if (!lay) return null; // layout missing on this side
        const block = lay.blockName ? getBlockByName(ctx, lay.blockName) : null;
        const fromBlock = (block && Array.isArray(block.entities)) ? block.entities : [];
        // The active layout's entities live in the ENTITIES section (67=1),
        // its *Paper_Space block is typically empty. Writers that dump ALL
        // layouts into ENTITIES are handled by the 330/410 partition; only
        // UNTAGGED entities fall back to the active layout.
        const isActive = activeLayout(ctx) === lay;
        const fromEntities = paperEntitiesForLayout(ctx, lay, isActive && fromBlock.length === 0, layoutApi);
        const base = [...fromBlock, ...fromEntities];
        // dxf-parser drops VIEWPORT: add scanner viewports as entity-shaped
        // objects (frame rectangles + diffable) unless already parsed.
        if (!base.some(e => e?.type === 'VIEWPORT')) {
            for (const vp of getSpaceViewports(ctx, lay.name.toLowerCase(), layoutApi)) {
                base.push(vp.__entity || (vp.__entity = {
                    type: 'VIEWPORT', handle: vp.handle || '', layer: vp.layer || '0',
                    center: { x: vp.cx, y: vp.cy }, width: vp.width, height: vp.height,
                    viewCenter: { x: vp.viewCenterX, y: vp.viewCenterY },
                    viewHeight: vp.viewHeight, twist: vp.twistDeg,
                }));
            }
        }
        return base;
    }

    // Resolve named block definitions, including parser name/xref aliases.
    function getBlockByName(ctx, name) {
        if (!name || !ctx.dxf?.blocks) return null;
        const blocks = ctx.dxf.blocks;
        return blocks[name] || Object.values(blocks).find(b => b?.name === name || b?.xrefPath === name) || null;
    }

    // Exclude inactive and full-sheet bookkeeping viewports from display.
    function isReservedViewport(vp, layout) {
        if (vp.viewId === 1 || vp.status < 0) return true;
        // Full-sheet non-plotting viewport some writers add.
        const pw = layout?.paperWidth || 0, ph = layout?.paperHeight || 0;
        if (pw > 0 && ph > 0) {
            const same = vp.width >= pw * 0.96 && vp.height >= ph * 0.96;
            const swapped = vp.width >= ph * 0.96 && vp.height >= pw * 0.96;
            if ((same || swapped) && !vp.viewId) return true;
        }
        return false;
    }

    // Select usable viewport records belonging to one drawing layout.
    function getSpaceViewports(ctx, key, layoutApi) {
        if (key === 'model') return [];
        const lay = ctx.layouts.find(l => l.name.toLowerCase() === key);
        if (!lay) return [];
        const isActive = activeLayout(ctx) === lay;
        const wanted = (lay.blockRecordHandle || '').toUpperCase();
        const name = (lay.name || '').toLowerCase();
        return ctx.viewports.filter(vp => {
            if (vp.viewHeight <= 0) return false;
            if (isReservedViewport(vp, lay)) return false;
            if (vp.blockName) return lay.blockName && vp.blockName.toUpperCase() === lay.blockName.toUpperCase();
            // ENTITIES-section frame: owner handle, then 410 tag, then
            // (untagged only) the active-layout fallback.
            if (wanted && vp.ownerHandles?.includes(wanted)) return true;
            const tag = ctx.entityTags[String(vp.handle || '').toUpperCase()];
            const owner = layoutApi.paperOwner(tag, ctx.layouts, isActive ? lay : null);
            if (owner) return owner.toLowerCase() === name;
            return false;
        });
    }

    return { create, reset, load, prepare, replace, isPaperEntity,
        activeLayout, getBlockByName, getSpaceEntities, getSpaceViewports };
});
