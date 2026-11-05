// Pure import preparation shared by the editor and its dedicated worker.
(function (root) {
    'use strict';
    function normalizeDxfHandle(handle) {
        return String(handle ?? '').trim().toUpperCase();
    }

    function normalizeLayoutName(name) {
        const value = String(name ?? '').trim();
        if (!value) return '';
        if (/^\*?model[_\s-]*space$/i.test(value) || /^model$/i.test(value)) return 'Model';
        if (/^\*?paper[_\s-]*space\d*$/i.test(value)) return 'Paper Space';
        return value;
    }

    function parseDxfPairs(text) {
        const lines = String(text || '').replace(/\r/g, '').split('\n');
        const pairs = [];
        for (let i = 0; i < lines.length - 1; i += 2) {
            const code = lines[i].trim();
            const value = lines[i + 1] ?? '';
            if (code !== '') pairs.push({ code, value: value.trim() });
        }
        return pairs;
    }

    function extractDxfSectionRecords(text, sectionName, preparedPairs = null) {
        const pairs = preparedPairs || parseDxfPairs(text);
        const target = String(sectionName || '').toUpperCase();
        let inSection = false;
        const sectionPairs = [];
        for (let i = 0; i < pairs.length; i++) {
            const pair = pairs[i];
            if (!inSection && pair.code === '0' && pair.value.toUpperCase() === 'SECTION') {
                const next = pairs[i + 1];
                if (next?.code === '2' && next.value.toUpperCase() === target) {
                    inSection = true;
                    i += 1;
                }
                continue;
            }
            if (inSection && pair.code === '0' && pair.value.toUpperCase() === 'ENDSEC') break;
            if (inSection) sectionPairs.push(pair);
        }

        const records = [];
        let current = null;
        sectionPairs.forEach(pair => {
            if (pair.code === '0') {
                if (current) records.push(current);
                current = { type: pair.value, pairs: [] };
            } else if (current) {
                current.pairs.push(pair);
            }
        });
        if (current) records.push(current);
        return records;
    }

    function firstRecordValue(record, codes) {
        const wanted = Array.isArray(codes) ? codes.map(String) : [String(codes)];
        // Codes are listed in priority order: only fall back to the next code
        // if the preferred one is absent (e.g. LAYOUT name code 1 vs plotter code 2).
        for (const w of wanted) {
            const found = record?.pairs?.find(pair => pair.code === w);
            if (found && found.value !== '') return found.value;
        }
        return '';
    }

    function allRecordValues(record, code) {
        return (record?.pairs || []).filter(pair => pair.code === String(code)).map(pair => pair.value);
    }

    function parseRawDxfEntitySpaceMap(text, preparedRecords = null) {
        const map = new Map();
        (preparedRecords || extractDxfSectionRecords(text, 'ENTITIES')).forEach(record => {
            const handle = normalizeDxfHandle(firstRecordValue(record, '5'));
            if (!handle) return;
            const paperRaw = firstRecordValue(record, '67');
            const layoutRaw = firstRecordValue(record, '410');
            const layoutName = normalizeLayoutName(layoutRaw);
            map.set(handle, {
                type: record.type,
                handle,
                layer: firstRecordValue(record, '8'),
                paperSpace: Number(paperRaw) === 1 || (layoutName && layoutName !== 'Model'),
                layoutName,
            });
        });
        return map;
    }

    const ISO_PAPER_SIZES_MM = {
        A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420],
        A4: [210, 297], A5: [148, 210], A6: [105, 148], A7: [74, 105],
    };

    function makePaperSize(width, height, unit = 'mm') {
        const w = Number(width);
        const h = Number(height);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
        const normalizedUnit = /in/i.test(unit) ? 'in' : 'mm';
        return {
            width: w,
            height: h,
            unit: normalizedUnit,
            widthMm: normalizedUnit === 'in' ? w * 25.4 : w,
            heightMm: normalizedUnit === 'in' ? h * 25.4 : h,
        };
    }

    function orientPaperSize(width, height, mediaName = '') {
        const name = String(mediaName || '').toLowerCase();
        let w = Number(width), h = Number(height);
        if (/landscape|land/i.test(name) && h > w) [w, h] = [h, w];
        if (/portrait|port/i.test(name) && w > h) [w, h] = [h, w];
        return [w, h];
    }

    function parsePaperSizeFromMediaName(mediaName) {
        const name = String(mediaName || '');
        if (!name) return null;

        // Common AutoCAD/BricsCAD media names look like:
        // ISO_A2_(594.00_x_420.00_MM), ISO full bleed A4 (297.00 x 210.00 MM), or ANSI_A_(11.00_x_8.50_Inches)
        const numericMatch = name.match(/[-+]?\d*\.?\d+\s*(?:x|_x_|×|_)\s*[-+]?\d*\.?\d+\s*_?\s*(mm|millimeters?|inches?|inch|in)/i);
        if (numericMatch) {
            const numbers = numericMatch[0].match(/[-+]?\d*\.?\d+/g) || [];
            if (numbers.length >= 2) {
                const unit = /in/i.test(numericMatch[1]) ? 'in' : 'mm';
                const [w, h] = orientPaperSize(Number(numbers[0]), Number(numbers[1]), name);
                const parsed = makePaperSize(w, h, unit);
                if (parsed) return parsed;
            }
        }

        // Fallback for media names that only contain the canonical ISO token, e.g. "ISO_A2".
        const isoMatch = name.match(/\b(?:ISO[_\s-]*)?(A[0-7])\b/i);
        if (isoMatch && ISO_PAPER_SIZES_MM[isoMatch[1].toUpperCase()]) {
            const [baseW, baseH] = ISO_PAPER_SIZES_MM[isoMatch[1].toUpperCase()];
            const [w, h] = orientPaperSize(baseW, baseH, name);
            return makePaperSize(w, h, 'mm');
        }

        return null;
    }

    function getPlotUnitName(value) {
        const n = Number(value);
        if (n === 0) return 'in';
        if (n === 1) return 'mm';
        if (n === 2) return 'px';
        return '';
    }

    function normalizePaperDimensionPair(width, height, mediaName = '', plotUnitRaw = '') {
        const parsedMedia = parsePaperSizeFromMediaName(mediaName);
        const plotUnit = getPlotUnitName(plotUnitRaw) || parsedMedia?.unit || 'mm';
        const [w, h] = orientPaperSize(Number(width), Number(height), mediaName);
        return makePaperSize(w, h, plotUnit === 'px' ? 'mm' : plotUnit);
    }

    function parseRawDxfLayouts(text, preparedRecords = null) {
        const layouts = [];
        (preparedRecords || extractDxfSectionRecords(text, 'OBJECTS')).forEach(record => {
            if (String(record.type || '').toUpperCase() !== 'LAYOUT') return;
            const rawName = firstRecordValue(record, ['1', '2']);
            const name = normalizeLayoutName(rawName);
            if (!name || name === 'Model') return;
            const mediaName = firstRecordValue(record, '4');
            const plotUnitRaw = firstRecordValue(record, '72');
            const mediaPaper = parsePaperSizeFromMediaName(mediaName);
            const candidates = [
                mediaPaper,
                normalizePaperDimensionPair(firstRecordValue(record, '44'), firstRecordValue(record, '45'), mediaName, plotUnitRaw),
                // Layout limits are not paper size; keep them as last-resort fallback only.
                normalizePaperDimensionPair(firstRecordValue(record, '10'), firstRecordValue(record, '20'), mediaName, plotUnitRaw),
            ].filter(Boolean);
            const paper = candidates.find(candidate => candidate.width > 0 && candidate.height > 0) || null;
            const lowerLeft = {
                x: Number(firstRecordValue(record, '10')),
                y: Number(firstRecordValue(record, '20')),
            };
            const upperRight = {
                x: Number(firstRecordValue(record, '11')),
                y: Number(firstRecordValue(record, '21')),
            };
            const hasLimits = [lowerLeft.x, lowerLeft.y, upperRight.x, upperRight.y].every(Number.isFinite) && upperRight.x > lowerLeft.x && upperRight.y > lowerLeft.y;
            layouts.push({
                key: `layout:${name}`,
                name,
                paperWidth: paper?.width || null,
                paperHeight: paper?.height || null,
                paperWidthMm: paper?.widthMm || null,
                paperHeightMm: paper?.heightMm || null,
                paperUnit: paper?.unit || getPlotUnitName(plotUnitRaw) || '',
                mediaName,
                plotRotation: Number(firstRecordValue(record, '73')) || Number(firstRecordValue(record, '74')) || 0,
                paperBounds: hasLimits ? { minX: lowerLeft.x, minY: lowerLeft.y, maxX: upperRight.x, maxY: upperRight.y, width: upperRight.x - lowerLeft.x, height: upperRight.y - lowerLeft.y } : null,
                tabOrder: Number(firstRecordValue(record, '71')) || layouts.length + 1,
            });
        });
        return layouts.sort((a, b) => (a.tabOrder || 0) - (b.tabOrder || 0) || a.name.localeCompare(b.name));
    }

    function parseRawDxfPaperViewports(text, preparedRecords = null) {
        const viewports = [];
        (preparedRecords || extractDxfSectionRecords(text, 'ENTITIES')).forEach(record => {
            if (String(record.type || '').toUpperCase() !== 'VIEWPORT') return;
            const layoutName = normalizeLayoutName(firstRecordValue(record, '410')) || 'Paper Space';
            const center = {
                x: Number(firstRecordValue(record, '10')),
                y: Number(firstRecordValue(record, '20')),
                z: Number(firstRecordValue(record, '30')) || 0,
            };
            const width = Number(firstRecordValue(record, '40'));
            const height = Number(firstRecordValue(record, '41'));
            if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
            viewports.push({
                type: 'VIEWPORT',
                handle: normalizeDxfHandle(firstRecordValue(record, '5')) || `RAW_VIEWPORT_${viewports.length}`,
                layer: firstRecordValue(record, '8') || '0',
                colorNumber: Number(firstRecordValue(record, '62')) || 7,
                __paperSpace: true,
                __layoutName: layoutName,
                __rawViewport: true,
                centerPoint: center,
                center,
                width,
                height,
                viewId: Number(firstRecordValue(record, '69')) || null,
                status: Number(firstRecordValue(record, '68')) || null,
                __viewCenter: {
                    x: Number(firstRecordValue(record, '12')),
                    y: Number(firstRecordValue(record, '22')),
                    z: Number(firstRecordValue(record, '32')) || 0,
                },
                __viewTarget: {
                    x: Number(firstRecordValue(record, '17')),
                    y: Number(firstRecordValue(record, '27')),
                    z: Number(firstRecordValue(record, '37')) || 0,
                },
                __viewHeight: Number(firstRecordValue(record, '45')),
                __viewTwist: Number(firstRecordValue(record, '51')),
                __customScale: Number(firstRecordValue(record, '45')) && Number(firstRecordValue(record, '41'))
                    ? Math.abs(Number(firstRecordValue(record, '41'))) / Math.abs(Number(firstRecordValue(record, '45')))
                    : null,
                __clipBoundaryHandle: normalizeDxfHandle(firstRecordValue(record, '340')) || null,
                __frozenLayerHandles: (record.pairs || [])
                    .filter(p => p.code === '331')
                    .map(p => String(p.value).trim().toUpperCase()),
            });
        });
        return viewports;
    }
    function assignRawEntityIndices(currentDxf, currentDxfRawText, preparedLines = null) {
        if (!currentDxf || !currentDxfRawText) return;

        // --- Phase 1: Walk raw text, collect handle → rawKey for every raw entity. ---
        const rawHandleToKey = new Map();   // handle → "E:n" or "B:name:n"
        const rawEntitiesBySection = [];     // [{key, type, handle}] for ENTITIES section
        const rawEntitiesByBlock = {};       // blockName → [{key, type, handle}]
        const lines = preparedLines || currentDxfRawText.replace(/\r\n/g, '\n').split('\n');
        let i = 0, sectionName = null, entityIdx = 0, blockName = null, blockIdx = 0;
        const pairAt = (p) => ({ code: (lines[p] ?? '').trim(), value: (lines[p + 1] ?? '') });

        while (i < lines.length) {
            const code = (lines[i] ?? '').trim();
            const value = (lines[i + 1] ?? '').trim();

            if (code === '0' && value.toUpperCase() === 'SECTION') {
                const n = pairAt(i + 2);
                sectionName = (n.code === '2') ? n.value.trim().toUpperCase() : null;
                entityIdx = 0; blockName = null;
                i += 4; continue;
            }
            if (code === '0' && value.toUpperCase() === 'ENDSEC') {
                sectionName = null; blockName = null;
                i += 2; continue;
            }

            const inEntities = sectionName === 'ENTITIES';
            const inBlocks   = sectionName === 'BLOCKS';

            if ((inEntities || inBlocks) && code === '0') {
                const entityType = value.toUpperCase();
                // Capture the block to extract handle and, for BLOCK, the name.
                let j = i + 2, handle = '', blkDefName = null;
                while (j < lines.length) {
                    const c = (lines[j] ?? '').trim();
                    if (c === '0') break;
                    const v = (lines[j + 1] ?? '').trim();
                    if (c === '5' && !handle) handle = v;
                    if (entityType === 'BLOCK' && c === '2' && blkDefName === null) blkDefName = v;
                    j += 2;
                }

                if (inBlocks) {
                    if (entityType === 'BLOCK') { blockName = blkDefName; blockIdx = 0; }
                    else if (entityType === 'ENDBLK') { blockName = null; }
                    else if (blockName !== null) {
                        const key = `B:${blockName}:${blockIdx}`;
                        if (handle) rawHandleToKey.set(handle.toUpperCase(), key);
                        if (!rawEntitiesByBlock[blockName]) rawEntitiesByBlock[blockName] = [];
                        rawEntitiesByBlock[blockName].push({ key, type: entityType, handle });
                        blockIdx++;
                    }
                } else { // ENTITIES
                    const key = `E:${entityIdx}`;
                    if (handle) rawHandleToKey.set(handle.toUpperCase(), key);
                    rawEntitiesBySection.push({ key, type: entityType, handle });
                    entityIdx++;
                }
                i = j; continue;
            }
            i++;
        }

        // --- Phase 2: Tag parsed entities. ---
        // Try handle first (works for all proper CAD files).
        // Fall back to sequential type-matching for handle-less files.
        function tagEntities(parsedEntities, rawList) {
            // First pass: handle lookup
            const unmatched = [];
            const usedKeys = new Set();
            parsedEntities.forEach((e, idx) => {
                const h = String(e.handle ?? '').trim().toUpperCase();
                const key = h ? rawHandleToKey.get(h) : null;
                if (key && !usedKeys.has(key)) {
                    e.__rawKey = key;
                    usedKeys.add(key);
                } else {
                    unmatched.push({ entity: e, idx });
                }
            });
            // Second pass: position fallback for unmatched entities
            if (unmatched.length > 0) {
                const available = rawList.filter(r => !usedKeys.has(r.key));
                let avIdx = 0;
                for (const u of unmatched) {
                    // Match by type if possible
                    const match = available.slice(avIdx).find(r => r.type === u.entity.type?.toUpperCase());
                    if (match) {
                        u.entity.__rawKey = match.key;
                        usedKeys.add(match.key);
                        avIdx = available.indexOf(match) + 1;
                    } else if (avIdx < available.length) {
                        u.entity.__rawKey = available[avIdx].key;
                        usedKeys.add(available[avIdx].key);
                        avIdx++;
                    }
                }
            }
            // The parser folds classic POLYLINE/VERTEX/SEQEND sequences into one
            // POLYLINE object. Preserve each raw VERTEX identity for targeted grip edits.
            for (const entity of parsedEntities) {
                if (entity?.type !== 'POLYLINE' || !Array.isArray(entity.vertices)) continue;
                const parentIndex = rawList.findIndex(record => record.key === entity.__rawKey);
                if (parentIndex < 0) continue;
                const rawVertices = [];
                for (let i = parentIndex + 1; i < rawList.length && rawList[i]?.type === 'VERTEX'; i++) rawVertices.push(rawList[i]);
                const byVertexHandle = new Map(rawVertices.filter(record => record.handle)
                    .map(record => [String(record.handle).toUpperCase(), record.key]));
                entity.vertices.forEach((vertex, index) => {
                    const handle = String(vertex?.handle ?? '').trim().toUpperCase();
                    vertex.__rawKey = (handle && byVertexHandle.get(handle)) || rawVertices[index]?.key || null;
                });
            }
        }

        tagEntities(currentDxf.entities || [], rawEntitiesBySection);
        if (currentDxf.blocks) {
            for (const [name, block] of Object.entries(currentDxf.blocks)) {
                tagEntities(block.entities || [], rawEntitiesByBlock[name] || []);
            }
        }
        // Persist for lazy tagging of raw viewports
        return rawHandleToKey;
    }
    function normalizeMirroredEntities(currentDxf, currentDxfRawText) {
        const O = root.DxfOcs;
        const result = { ops: [], unsupported: {} };
        if (!O || !currentDxfRawText || !currentDxf) return result;
        const { byKey } = O.scanExtrusions(currentDxfRawText);
        if (!byKey.size) return result;
        const done = new Set();
        const visit = (list) => {
            for (const e of list || []) {
                const k = e?.__rawKey;
                const n = k && byKey.get(k);
                if (!n) continue;
                const r = O.normalizeEntity(e, n);
                if (r) { result.ops.push([k, r.ops]); done.add(k); }
            }
        };
        visit(currentDxf.entities);
        for (const b of Object.values(currentDxf.blocks || {})) visit(b?.entities);
        for (const [k, n] of byKey) {
            if (!done.has(k) && O.isUnsupportedMirror(n.type, n)) {
                result.unsupported[n.type] = (result.unsupported[n.type] || 0) + 1;
            }
        }
        return result;
    }
    function parseRawLayerTableInfo(rawText, preparedLines = null) {
        const out = {};
        if (!rawText) return out;
        const lines = preparedLines || rawText.replace(/\r\n/g, '\n').split('\n');
        let i = 0, section = null, inLayerTable = false;
        while (i < lines.length) {
            const code = (lines[i] ?? '').trim();
            const value = (lines[i + 1] ?? '').trim();
            if (code === '0' && value.toUpperCase() === 'SECTION') {
                section = (lines[i + 2] ?? '').trim() === '2' ? (lines[i + 3] ?? '').trim().toUpperCase() : null;
                i += 4; continue;
            }
            if (code === '0' && value.toUpperCase() === 'ENDSEC') { section = null; inLayerTable = false; i += 2; continue; }
            if (section === 'TABLES' && code === '0') {
                const t = value.toUpperCase();
                if (t === 'TABLE') {
                    inLayerTable = (lines[i + 3] ?? '').trim().toUpperCase() === 'LAYER'
                        && (lines[i + 2] ?? '').trim() === '2';
                } else if (t === 'ENDTAB') {
                    inLayerTable = false;
                } else if (t === 'LAYER' && inLayerTable) {
                    let name = '', flags = 0, ltype = '', weight = null, handle = '', j = i + 2;
                    while (j < lines.length && (lines[j] ?? '').trim() !== '0') {
                        const cc = (lines[j] ?? '').trim();
                        const vv = (lines[j + 1] ?? '').trim();
                        if (cc === '2' && !name) name = vv;
                        if (cc === '5' && !handle) handle = vv.toUpperCase();
                        if (cc === '70') flags = parseInt(vv, 10) || 0;
                        if (cc === '6' && !ltype) ltype = vv;
                        if (cc === '370') weight = parseInt(vv, 10);
                        j += 2;
                    }
                    if (name) out[name] = { locked: (flags & 4) === 4, linetype: ltype || null, weight: Number.isFinite(weight) ? weight : null, handle: handle || null };
                    i = j; continue;
                }
            }
            i += 2;
        }
        return out;
    }
    function computeNextHandleSeed(currentDxfRawText, rawHandleToKeyMap) {
        let max = 0xFF;
        const bump = (h) => { const v = parseInt(h, 16); if (Number.isFinite(v) && v > max) max = v; };
        for (const h of rawHandleToKeyMap.keys()) bump(h);
        // Tables, blocks and OBJECTS own handles too (5, or 105 on DIMSTYLE),
        // and $HANDSEED is the file's own "next free" mark: new entities must
        // stay above all of them or they collide with e.g. a DICTIONARY.
        const raw = currentDxfRawText || '';
        const re = /(?:^|\n)[ \t]*(?:5|105)[ \t]*\r?\n[ \t]*([0-9A-Fa-f]{1,16})[ \t]*\r?$/gm;
        let m;
        while ((m = re.exec(raw))) bump(m[1]);
        const seed = /\$HANDSEED[ \t]*\r?\n[ \t]*5[ \t]*\r?\n[ \t]*([0-9A-Fa-f]+)/.exec(raw);
        if (seed) { const v = parseInt(seed[1], 16); if (Number.isFinite(v) && v - 1 > max) max = v - 1; }
        return max + 1;
    }
    function prepareSpaces(rawText) {
        const pairs = parseDxfPairs(rawText);
        const entities = extractDxfSectionRecords(rawText, 'ENTITIES', pairs);
        const objects = extractDxfSectionRecords(rawText, 'OBJECTS', pairs);
        return { rawMap: parseRawDxfEntitySpaceMap(rawText, entities),
            viewports: parseRawDxfPaperViewports(rawText, entities), layouts: parseRawDxfLayouts(rawText, objects) };
    }
    const api = { normalizeDxfHandle, normalizeLayoutName, parseDxfPairs, extractDxfSectionRecords, firstRecordValue, allRecordValues, parseRawDxfEntitySpaceMap, makePaperSize, orientPaperSize, parsePaperSizeFromMediaName, getPlotUnitName, normalizePaperDimensionPair, parseRawDxfLayouts, parseRawDxfPaperViewports, assignRawEntityIndices, normalizeMirroredEntities, parseRawLayerTableInfo, computeNextHandleSeed, prepareSpaces };
    root.DxfImportSetup = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

