(function (root) {
    'use strict';

    function point(pairs, xCode) {
        const get = code => {
            const pair = pairs.find(p => p.code === String(code));
            return pair ? Number(pair.value) : undefined;
        };
        const x = get(xCode);
        if (x === undefined) return null;
        return { x, y: get(Number(xCode) + 10) ?? 0, z: get(Number(xCode) + 20) ?? 0 };
    }

    function first(pairs, code, fallback = undefined) {
        const pair = pairs.find(p => p.code === String(code));
        return pair ? pair.value : fallback;
    }

    function parseAttrib(record, rawHandleToKey) {
        const p = record.pairs || [];
        const flags = Number(first(p, 70, 0)) || 0;
        const textFlags = Number(first(p, 71, 0)) || 0;
        const handle = String(first(p, 5, '')).trim();
        const attr = {
            type: 'ATTRIB',
            handle,
            layer: first(p, 8, '0'),
            text: first(p, 1, ''),
            tag: first(p, 2, ''),
            prompt: first(p, 3, ''),
            textStyle: first(p, 7, 'STANDARD'),
            startPoint: point(p, 10),
            endPoint: point(p, 11),
            thickness: Number(first(p, 39, 0)) || 0,
            textHeight: Number(first(p, 40, 0)) || 0,
            scale: Number.isFinite(Number(first(p, 41, 1))) ? Number(first(p, 41, 1)) : 1,
            rotation: Number(first(p, 50, 0)) || 0,
            obliqueAngle: Number(first(p, 51, 0)) || 0,
            invisible: !!(flags & 1),
            constant: !!(flags & 2),
            verificationRequired: !!(flags & 4),
            preset: !!(flags & 8),
            backwards: !!(textFlags & 2),
            mirrored: !!(textFlags & 4),
            horizontalJustification: Number(first(p, 72, 0)) || 0,
            halign: Number(first(p, 72, 0)) || 0,
            fieldLength: Number(first(p, 73, 0)) || 0,
            verticalJustification: Number(first(p, 74, 0)) || 0,
            valign: Number(first(p, 74, 0)) || 0,
            extrusionDirectionX: Number(first(p, 210, 0)) || 0,
            extrusionDirectionY: Number(first(p, 220, 0)) || 0,
            extrusionDirectionZ: Number(first(p, 230, 1)) || 1,
        };
        attr.__rawKey = record.rawKey || (handle && rawHandleToKey?.get(handle.toUpperCase())) || null;
        return attr;
    }

    function attachToEntityList(parsedEntities, rawRecords, rawHandleToKey) {
        if (!Array.isArray(parsedEntities)) return;
        const insertsByHandle = new Map();
        parsedEntities.forEach(entity => {
            if (entity?.type === 'INSERT' && entity.handle) insertsByHandle.set(String(entity.handle).toUpperCase(), entity);
        });

        const parsedInserts = parsedEntities.filter(entity => entity?.type === 'INSERT');
        let fallbackIndex = 0;
        const insertsUsed = new Set();
        for (let i = 0; i < rawRecords.length; i++) {
            const record = rawRecords[i];
            if (String(record.type).toUpperCase() !== 'INSERT') continue;
            const handle = String(first(record.pairs || [], 5, '')).trim().toUpperCase();
            let insert = handle ? insertsByHandle.get(handle) : null;
            if (!insert) {
                const blockName = String(first(record.pairs || [], 2, '')).toUpperCase();
                insert = parsedInserts.slice(fallbackIndex).find(entity => !insertsUsed.has(entity)
                    && String(entity.name || entity.block || entity.blockName || '').toUpperCase() === blockName);
                if (insert) fallbackIndex = parsedInserts.indexOf(insert) + 1;
            }
            if (!insert) continue;
            insertsUsed.add(insert);

            const attributes = [];
            let j = i + 1;
            while (j < rawRecords.length && String(rawRecords[j].type).toUpperCase() === 'ATTRIB') {
                attributes.push(parseAttrib(rawRecords[j], rawHandleToKey));
                j++;
            }
            // Only treat a contiguous ATTRIB run as attached when its sequence closes
            // with SEQEND, as required by the INSERT attribute sequence in DXF.
            if (String(rawRecords[j]?.type || '').toUpperCase() === 'SEQEND') {
                insert.attributes = attributes;
                insert.__hasAttribSequence = true;
                insert.__seqendHandle = String(first(rawRecords[j].pairs || [], 5, '')).trim();
            }
            i = j - 1;
        }
    }

    function scanAttributeRecords(rawText) {
        const lines = String(rawText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        const bySection = { ENTITIES: [], BLOCKS: [] };
        let section = null, record = null;
        let entityIndex = 0, blockName = null, blockIndex = 0;
        const keepCodes = type => type === 'ATTRIB' ? null
            : type === 'INSERT' ? new Set(['5', '2', '66'])
                : type === 'BLOCK' ? new Set(['2'])
                    : type === 'SEQEND' ? new Set(['5']) : null;
        const save = () => {
            if (!record || !bySection[section]) { record = null; return; }
            if (record.type === 'BLOCK') {
                blockName = String(first(record.pairs || [], 2, '')).toUpperCase();
                blockIndex = 0;
            } else if (record.type === 'ENDBLK') {
                bySection[section].push(record);
                blockName = null;
                record = null;
                return;
            }
            bySection[section].push(record);
            record = null;
        };
        for (let i = 0; i + 1 < lines.length; i += 2) {
            const code = lines[i].trim(), value = lines[i + 1].trim();
            if (code === '0' && value === 'SECTION') {
                save();
                const sectionCode = (lines[i + 2] || '').trim();
                const sectionValue = (lines[i + 3] || '').trim().toUpperCase();
                section = sectionCode === '2' && Object.hasOwn(bySection, sectionValue) ? sectionValue : null;
                entityIndex = 0; blockName = null; blockIndex = 0;
                i += 2;
                continue;
            }
            if (code === '0' && value === 'ENDSEC') { save(); section = null; continue; }
            if (code === '0') {
                save();
                const type = value.toUpperCase();
                if (section) {
                    const rawKey = section === 'ENTITIES'
                        ? `E:${entityIndex++}`
                        : type !== 'BLOCK' && type !== 'ENDBLK' && blockName !== null
                            ? `B:${blockName}:${blockIndex++}` : null;
                    if (['INSERT', 'ATTRIB', 'SEQEND', 'BLOCK', 'ENDBLK'].includes(type)) {
                        record = { type, pairs: [], rawKey };
                    }
                }
                continue;
            }
            if (record) {
                const allowed = keepCodes(record.type);
                if (!allowed || allowed.has(code)) record.pairs.push({ code, value });
            }
        }
        save();
        return bySection;
    }

    function recoverInsertAttributes(rawText, parsed, rawHandleToKey) {
        if (!parsed) return 0;
        const records = scanAttributeRecords(rawText);
        const entities = records.ENTITIES;
        attachToEntityList(parsed.entities, entities, rawHandleToKey);
        let count = 0;
        const rawBlocks = records.BLOCKS;
        const entitiesByBlock = new Map();
        let blockName = null;
        let blockEntities = null;
        for (const record of rawBlocks) {
            const type = String(record.type || '').toUpperCase();
            if (type === 'BLOCK') {
                blockName = String(first(record.pairs || [], 2, '')).toUpperCase();
                blockEntities = [];
            } else if (type === 'ENDBLK') {
                if (blockName) entitiesByBlock.set(blockName, blockEntities || []);
                blockName = null;
                blockEntities = null;
            } else if (blockEntities) {
                blockEntities.push(record);
            }
        }
        for (const [name, block] of Object.entries(parsed.blocks || {})) {
            const raw = entitiesByBlock.get(String(name).toUpperCase());
            if (!raw) continue;
            const before = (block.entities || []).reduce((n, entity) => n + (entity.attributes?.length || 0), 0);
            attachToEntityList(block.entities, raw, rawHandleToKey);
            count += (block.entities || []).reduce((n, entity) => n + (entity.attributes?.length || 0), 0) - before;
        }
        return count + (parsed.entities || []).reduce((n, entity) => n + (entity.attributes?.length || 0), 0);
    }

    root.DxfAttributes = { recoverInsertAttributes };
})(typeof window !== 'undefined' ? window : globalThis);
