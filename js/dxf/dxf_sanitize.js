/**
 * dxf_sanitize.js — DXF structural sanitizer + empty-drawing template.
 *
 * sanitizeDxf(rawText) → { text, fixes: [string] }
 *   Normalizes the structural issues that most often make AutoCAD reject
 *   third-party DXF files. Never touches valid geometry.
 *
 * createEmptyDrawing(insunits) → raw DXF text for a clean minimal drawing
 *   (Model + Layout1, layer 0, required tables, valid handles).
 *
 * window.DxfSanitize + Node exports.
 */
(function (root) {
    'use strict';

    // ---------- pair helpers ----------

    function toPairs(rawText) {
        const lines = String(rawText || '').replace(/\r\n/g, '\n').split('\n');
        // Drop a single trailing empty line (file terminator artifact)
        if (lines.length % 2 === 1 && lines[lines.length - 1].trim() === '') lines.pop();
        const pairs = [];
        for (let i = 0; i + 1 < lines.length; i += 2) {
            pairs.push([lines[i].trim(), lines[i + 1]]);
        }
        return pairs;
    }

    function fromPairs(pairs) {
        const out = [];
        for (const [c, v] of pairs) out.push(c, v);
        return out.join('\r\n') + '\r\n';
    }

    // Find [start, end) pair-index ranges of each section.
    function findSections(pairs) {
        const sections = [];
        let current = null;
        for (let i = 0; i < pairs.length; i++) {
            const [c, v] = pairs[i];
            if (c === '0' && v.trim().toUpperCase() === 'SECTION') {
                current = { start: i, name: (pairs[i + 1]?.[0] === '2' ? pairs[i + 1][1].trim().toUpperCase() : '') };
            } else if (c === '0' && v.trim().toUpperCase() === 'ENDSEC' && current) {
                current.end = i; // index of the ENDSEC pair itself
                sections.push(current);
                current = null;
            }
        }
        return sections;
    }

    // ---------- canonical fragments ----------

    function headerVars(insunits, handseedHex) {
        return [
            ['0', 'SECTION'], ['2', 'HEADER'],
            ['9', '$ACADVER'], ['1', 'AC1021'],
            ['9', '$INSUNITS'], ['70', String(insunits)],
            ['9', '$HANDSEED'], ['5', handseedHex],
            ['0', 'ENDSEC'],
        ];
    }

    function tableRecord(type, handle, extra) {
        return [['0', type], ['5', handle], ['100', 'AcDbSymbolTableRecord'], ...extra];
    }

    const REQUIRED_LTYPES = ['BYBLOCK', 'BYLAYER', 'CONTINUOUS'];

    function ltypeRecord(name, handle) {
        return tableRecord('LTYPE', handle, [
            ['100', 'AcDbLinetypeTableRecord'],
            ['2', name], ['70', '0'],
            ['3', name === 'CONTINUOUS' ? 'Solid line' : ''],
            ['72', '65'], ['73', '0'], ['40', '0'],
        ]);
    }

    function layerRecord(name, handle) {
        return tableRecord('LAYER', handle, [
            ['100', 'AcDbLayerTableRecord'],
            ['2', name], ['70', '0'], ['62', '7'], ['6', 'CONTINUOUS'], ['370', '-3'], ['390', '0'],
        ]);
    }

    function styleRecord(handle) {
        return tableRecord('STYLE', handle, [
            ['100', 'AcDbTextStyleTableRecord'],
            ['2', 'STANDARD'], ['70', '0'], ['40', '0'], ['41', '1'], ['50', '0'], ['71', '0'], ['42', '2.5'], ['3', 'txt'], ['4', ''],
        ]);
    }

    function appidRecord(handle) {
        return tableRecord('APPID', handle, [
            ['100', 'AcDbRegAppTableRecord'], ['2', 'ACAD'], ['70', '0'],
        ]);
    }

    function vportRecord(handle) {
        return tableRecord('VPORT', handle, [
            ['100', 'AcDbViewportTableRecord'],
            ['2', '*ACTIVE'], ['70', '0'],
            ['10', '0'], ['20', '0'], ['11', '1'], ['21', '1'],
            ['12', '0'], ['22', '0'], ['13', '0'], ['23', '0'],
            ['14', '10'], ['24', '10'], ['15', '10'], ['25', '10'],
            ['16', '0'], ['26', '0'], ['36', '1'],
            ['17', '0'], ['27', '0'], ['37', '0'],
            ['40', '100'], ['41', '1.5'], ['42', '50'], ['43', '0'], ['44', '0'],
            ['50', '0'], ['51', '0'],
            ['71', '0'], ['72', '100'], ['73', '1'], ['74', '3'], ['75', '0'], ['76', '0'], ['77', '0'], ['78', '0'],
        ]);
    }

    function blockRecordRecord(name, handle) {
        return [['0', 'BLOCK_RECORD'], ['5', handle], ['100', 'AcDbSymbolTableRecord'], ['100', 'AcDbBlockTableRecord'], ['2', name], ['340', '0']];
    }

    function blockDef(name, handle, endHandle, paper) {
        return [
            ['0', 'BLOCK'], ['5', handle], ['8', '0'],
            ['100', 'AcDbEntity'], ...(paper ? [['67', '1']] : []), ['100', 'AcDbBlockBegin'],
            ['2', name], ['70', '0'], ['10', '0'], ['20', '0'], ['30', '0'], ['3', name], ['1', ''],
            ['0', 'ENDBLK'], ['5', endHandle], ['8', '0'],
            ['100', 'AcDbEntity'], ...(paper ? [['67', '1']] : []), ['100', 'AcDbBlockEnd'],
        ];
    }

    function layoutObject(name, handle, ownerDict, blockRecHandle, tabOrder, isModel) {
        return [
            ['0', 'LAYOUT'], ['5', handle], ['330', ownerDict],
            ['100', 'AcDbPlotSettings'],
            ['4', isModel ? '' : 'ISO_A3_(420.00_x_297.00_MM)'],
            ['6', ''],
            ['40', '7.5'], ['41', '20'], ['42', '7.5'], ['43', '20'],
            ['44', isModel ? '0' : '420'], ['45', isModel ? '0' : '297'], ['46', '0'], ['47', '0'],
            ['48', '0'], ['49', '0'], ['140', '0'], ['141', '0'], ['142', '1'], ['143', '1'],
            ['70', isModel ? '1712' : '688'], ['72', '1'], ['73', '1'], ['74', '5'],
            ['7', ''], ['75', '16'], ['147', '1'], ['148', '0'], ['149', '0'],
            ['100', 'AcDbLayout'],
            ['1', name], ['70', '1'], ['71', String(tabOrder)],
            ['10', '0'], ['20', '0'], ['11', isModel ? '12' : '420'], ['21', isModel ? '9' : '297'],
            ['12', '0'], ['22', '0'], ['32', '0'],
            ['14', '0'], ['24', '0'], ['34', '0'],
            ['15', '0'], ['25', '0'], ['35', '0'],
            ['146', '0'],
            ['13', '0'], ['23', '0'], ['33', '0'],
            ['16', '1'], ['26', '0'], ['36', '0'],
            ['17', '0'], ['27', '1'], ['37', '0'],
            ['76', '0'],
            ['330', blockRecHandle],
        ];
    }

    // ---------- the sanitizer ----------

    const COORD_CODES = new Set();
    for (let c = 10; c <= 59; c++) COORD_CODES.add(String(c));
    for (let c = 140; c <= 149; c++) COORD_CODES.add(String(c));

    // Simple entity types we can safely repair, mapped to their primary
    // subclass marker. Compound/complex types (POLYLINE, DIMENSION, HATCH,
    // INSERT-with-attribs, …) are deliberately omitted so we never touch
    // structure we don't fully model.
    const ENTITY_SUBCLASS = {
        LINE: 'AcDbLine', LWPOLYLINE: 'AcDbPolyline', CIRCLE: 'AcDbCircle',
        ARC: 'AcDbArc', ELLIPSE: 'AcDbEllipse', POINT: 'AcDbPoint',
        TEXT: 'AcDbText', MTEXT: 'AcDbMText', SPLINE: 'AcDbSpline',
        SOLID: 'AcDbTrace', TRACE: 'AcDbTrace', '3DFACE': 'AcDbFace',
        XLINE: 'AcDbXline', RAY: 'AcDbRay',
    };
    // Group codes belonging to the AcDbEntity (common) subclass — these sit
    // between the AcDbEntity marker and the type-specific subclass marker.
    const ENTITY_COMMON = new Set(['6', '8', '48', '60', '62', '67', '284', '347', '370', '410', '420', '430', '440']);

    function sanitizeDxf(rawText) {
        const fixes = [];
        let pairs = toPairs(rawText);
        if (!pairs.length) {
            pairs = [['0', 'SECTION'], ['2', 'ENTITIES'], ['0', 'ENDSEC'], ['0', 'EOF']];
            fixes.push('File was empty — created a minimal skeleton.');
        }
        if (!pairs.some(([c, v]) => c === '0' && v.trim().toUpperCase() === 'EOF')) {
            pairs.push(['0', 'EOF']);
            fixes.push('Added missing EOF marker.');
        }

        // ---- Pass 1: collect handles, referenced layers/linetypes; find sections ----
        const scan = () => {
            const info = {
                handles: new Map(),         // handle -> count
                maxHandle: 0xFF,
                refLayers: new Set(),
                refLtypes: new Set(),
                tables: new Set(),          // table names present
                tableRecords: {},           // tableName -> Set of record name (code 2)
                sections: findSections(pairs),
            };
            let section = null, tableName = null, recType = null;
            for (let i = 0; i < pairs.length; i++) {
                const [c, vRaw] = pairs[i];
                const v = String(vRaw).trim();
                if (c === '0' && v.toUpperCase() === 'SECTION') { section = (pairs[i + 1]?.[0] === '2') ? pairs[i + 1][1].trim().toUpperCase() : null; continue; }
                if (c === '0' && v.toUpperCase() === 'ENDSEC') { section = null; tableName = null; recType = null; continue; }
                if (c === '0') {
                    recType = v.toUpperCase();
                    if (section === 'TABLES' && recType === 'TABLE') {
                        tableName = (pairs[i + 1]?.[0] === '2') ? pairs[i + 1][1].trim().toUpperCase() : null;
                        if (tableName) { info.tables.add(tableName); info.tableRecords[tableName] = info.tableRecords[tableName] || new Set(); }
                    }
                    if (recType === 'ENDTAB') tableName = null;
                    continue;
                }
                if (c === '5' || c === '105') {
                    // Skip $HANDSEED's own value: it's a seed, not a handle in use.
                    const prev = pairs[i - 1];
                    if (!(prev && prev[0] === '9' && prev[1].trim().toUpperCase() === '$HANDSEED')) {
                        const h = v.toUpperCase();
                        info.handles.set(h, (info.handles.get(h) || 0) + 1);
                        const n = parseInt(h, 16);
                        if (Number.isFinite(n) && n > info.maxHandle) info.maxHandle = n;
                    }
                }
                if (c === '2' && section === 'TABLES' && tableName && recType && recType !== 'TABLE') {
                    info.tableRecords[tableName].add(v.toUpperCase());
                }
                if ((section === 'ENTITIES' || section === 'BLOCKS') && c === '8' && v) info.refLayers.add(v);
                if ((section === 'ENTITIES' || section === 'BLOCKS') && c === '6' && v) info.refLtypes.add(v.toUpperCase());
            }
            return info;
        };

        let info = scan();
        let nextHandle = info.maxHandle + 1;
        const newHandle = () => (nextHandle++).toString(16).toUpperCase();

        // ---- Fix: duplicate handles (keep first occurrence) & missing entity handles ----
        {
            const seen = new Set();
            let dupes = 0;
            for (let i = 0; i < pairs.length; i++) {
                const [c, v] = pairs[i];
                if (c !== '5' && c !== '105') continue;
                const prev = pairs[i - 1];
                if (prev && prev[0] === '9' && prev[1].trim().toUpperCase() === '$HANDSEED') continue;
                const h = String(v).trim().toUpperCase();
                if (seen.has(h)) { pairs[i] = [c, newHandle()]; dupes++; }
                else seen.add(h);
            }
            if (dupes) fixes.push(`Re-assigned ${dupes} duplicate handle(s).`);

            // Missing handles on ENTITIES-section entities
            let added = 0, section = null;
            for (let i = 0; i < pairs.length; i++) {
                const [c, vRaw] = pairs[i];
                const v = String(vRaw).trim().toUpperCase();
                if (c === '0' && v === 'SECTION') { section = (pairs[i + 1]?.[0] === '2') ? pairs[i + 1][1].trim().toUpperCase() : null; continue; }
                if (c === '0' && v === 'ENDSEC') { section = null; continue; }
                if (section !== 'ENTITIES' || c !== '0' || v === 'SECTION') continue;
                // entity block: check whether a code 5 appears before the next 0
                let j = i + 1, has5 = false;
                while (j < pairs.length && pairs[j][0] !== '0') {
                    if (pairs[j][0] === '5') { has5 = true; break; }
                    j++;
                }
                if (!has5) { pairs.splice(i + 1, 0, ['5', newHandle()]); added++; }
            }
            if (added) fixes.push(`Assigned ${added} missing entity handle(s).`);
        }

        // ---- Fix: entities with invalid (NaN) numeric values ----
        {
            let removed = 0, section = null, i = 0;
            while (i < pairs.length) {
                const [c, vRaw] = pairs[i];
                const v = String(vRaw).trim().toUpperCase();
                if (c === '0' && v === 'SECTION') { section = (pairs[i + 1]?.[0] === '2') ? pairs[i + 1][1].trim().toUpperCase() : null; i++; continue; }
                if (c === '0' && v === 'ENDSEC') { section = null; i++; continue; }
                if (section === 'ENTITIES' && c === '0' && v !== 'SECTION' && v !== 'ENDSEC') {
                    let j = i + 1, bad = false;
                    while (j < pairs.length && pairs[j][0] !== '0') {
                        if (COORD_CODES.has(pairs[j][0]) && !Number.isFinite(Number(pairs[j][1]))) { bad = true; }
                        j++;
                    }
                    if (bad) { pairs.splice(i, j - i); removed++; continue; }
                    i = j; continue;
                }
                i++;
            }
            if (removed) fixes.push(`Removed ${removed} entit${removed === 1 ? 'y' : 'ies'} with invalid coordinates.`);
        }

        info = scan();
        nextHandle = Math.max(nextHandle, info.maxHandle + 1);

        // ---- Fix: HEADER variables ----
        {
            let headerSec = info.sections.find(s => s.name === 'HEADER');
            if (!headerSec) {
                pairs.splice(0, 0, ...headerVars(4, nextHandle.toString(16).toUpperCase()));
                fixes.push('Created missing HEADER section ($ACADVER, $INSUNITS, $HANDSEED).');
            } else {
                const seg = pairs.slice(headerSec.start, headerSec.end + 1);
                const hasVar = (name) => seg.some(([c, v]) => c === '9' && v.trim().toUpperCase() === name);
                const inserts = [];
                if (!hasVar('$ACADVER')) inserts.push(['9', '$ACADVER'], ['1', 'AC1021']);
                if (!hasVar('$INSUNITS')) inserts.push(['9', '$INSUNITS'], ['70', '4']);
                if (!hasVar('$HANDSEED')) inserts.push(['9', '$HANDSEED'], ['5', nextHandle.toString(16).toUpperCase()]);
                if (inserts.length) {
                    pairs.splice(headerSec.start + 2, 0, ...inserts);
                    fixes.push(`Added missing header variable(s): ${inserts.filter(p => p[0] === '9').map(p => p[1]).join(', ')}.`);
                }
            }
        }

        info = scan();

        // ---- Fix: required TABLES + records ----
        {
            let tablesSec = info.sections.find(s => s.name === 'TABLES');
            if (!tablesSec) {
                const headerSec = findSections(pairs).find(s => s.name === 'HEADER');
                const at = headerSec ? headerSec.end + 1 : 0;
                pairs.splice(at, 0, ['0', 'SECTION'], ['2', 'TABLES'], ['0', 'ENDSEC']);
                fixes.push('Created missing TABLES section.');
                info = scan();
                tablesSec = info.sections.find(s => s.name === 'TABLES');
            }

            const ensureTable = (name, records) => {
                // records: [{ name, make(handle) }]
                info = scan();
                const sec = findSections(pairs).find(s => s.name === 'TABLES');
                const have = info.tableRecords[name] || new Set();
                const missing = records.filter(r => !have.has(r.name.toUpperCase()));
                if (!info.tables.has(name)) {
                    const recs = [];
                    for (const r of records) recs.push(...r.make(newHandle()));
                    pairs.splice(sec.end, 0,
                        ['0', 'TABLE'], ['2', name], ['5', newHandle()], ['100', 'AcDbSymbolTable'], ['70', String(records.length)],
                        ...recs,
                        ['0', 'ENDTAB']);
                    fixes.push(`Created ${name} table (${records.map(r => r.name).join(', ')}).`);
                    return;
                }
                if (!missing.length) return;
                // insert before the table's ENDTAB
                let inTable = false, insertAt = -1;
                for (let i = sec.start; i <= sec.end; i++) {
                    const [c, vRaw] = pairs[i];
                    const v = String(vRaw).trim().toUpperCase();
                    if (c === '0' && v === 'TABLE') inTable = (pairs[i + 1]?.[1] || '').trim().toUpperCase() === name;
                    if (c === '0' && v === 'ENDTAB' && inTable) { insertAt = i; break; }
                }
                if (insertAt < 0) return;
                const recs = [];
                for (const r of missing) recs.push(...r.make(newHandle()));
                pairs.splice(insertAt, 0, ...recs);
                fixes.push(`Added missing ${name} record(s): ${missing.map(r => r.name).join(', ')}.`);
            };

            ensureTable('APPID', [{ name: 'ACAD', make: (h) => appidRecord(h) }]);
            ensureTable('VPORT', [{ name: '*ACTIVE', make: (h) => vportRecord(h) }]);
            ensureTable('STYLE', [{ name: 'STANDARD', make: (h) => styleRecord(h) }]);
            const neededLtypes = [...new Set([...REQUIRED_LTYPES, ...info.refLtypes])]
                .filter(n => n !== 'BYLAYER' || true);
            ensureTable('LTYPE', neededLtypes.map(n => ({ name: n, make: (h) => ltypeRecord(n, h) })));
            const neededLayers = [...new Set(['0', ...info.refLayers])];
            ensureTable('LAYER', neededLayers.map(n => ({ name: n, make: (h) => layerRecord(n, h) })));
            ensureTable('BLOCK_RECORD', [
                { name: '*MODEL_SPACE', make: (h) => blockRecordRecord('*Model_Space', h) },
                { name: '*PAPER_SPACE', make: (h) => blockRecordRecord('*Paper_Space', h) },
            ]);
        }

        // ---- Fix: existing LAYER records missing the 390 PlotStyleName ----
        // R2000+ requires group code 390 on every AcDbLayerTableRecord. AutoCAD
        // aborts the whole drawing ("Did not receive PlotStyleName") if any layer
        // record omits it. ensureTable() only adds missing *records* by name; this
        // repairs the contents of records that already exist. Handle 0 = null, so
        // AutoCAD falls back to the default "Normal" plot style — matching the
        // layerRecord() factory above.
        {
            let patched = 0;
            let section = null, tableName = null;
            for (let i = 0; i < pairs.length; i++) {
                const [c, vRaw] = pairs[i];
                const v = String(vRaw).trim().toUpperCase();
                if (c === '0' && v === 'SECTION') { section = (pairs[i + 1]?.[0] === '2') ? pairs[i + 1][1].trim().toUpperCase() : null; continue; }
                if (c === '0' && v === 'ENDSEC') { section = null; tableName = null; continue; }
                if (section === 'TABLES' && c === '0' && v === 'TABLE') { tableName = (pairs[i + 1]?.[0] === '2') ? pairs[i + 1][1].trim().toUpperCase() : null; continue; }
                if (c === '0' && v === 'ENDTAB') { tableName = null; continue; }
                if (section === 'TABLES' && tableName === 'LAYER' && c === '0' && v === 'LAYER') {
                    // Walk to the end of this record (next code-0 pair); insert 390 if absent.
                    let j = i + 1, has390 = false;
                    while (j < pairs.length && pairs[j][0] !== '0') {
                        if (pairs[j][0] === '390') has390 = true;
                        j++;
                    }
                    if (!has390) { pairs.splice(j, 0, ['390', '0']); patched++; i = j; }
                    else { i = j - 1; }
                }
            }
            if (patched) fixes.push(`Added missing PlotStyleName (390) to ${patched} layer record(s).`);
        }

        // ---- Fix: BLOCKS section with *Model_Space / *Paper_Space ----
        {
            info = scan();
            let blocksSec = findSections(pairs).find(s => s.name === 'BLOCKS');
            if (!blocksSec) {
                const tablesSec = findSections(pairs).find(s => s.name === 'TABLES');
                const at = tablesSec ? tablesSec.end + 1 : 0;
                pairs.splice(at, 0, ['0', 'SECTION'], ['2', 'BLOCKS'], ['0', 'ENDSEC']);
                fixes.push('Created missing BLOCKS section.');
                blocksSec = findSections(pairs).find(s => s.name === 'BLOCKS');
            }
            const seg = pairs.slice(blocksSec.start, blocksSec.end + 1);
            const hasBlock = (n) => seg.some(([c, v], i) => c === '2' && v.trim().toUpperCase() === n);
            const inserts = [];
            if (!hasBlock('*MODEL_SPACE')) inserts.push(...blockDef('*Model_Space', newHandle(), newHandle(), false));
            if (!hasBlock('*PAPER_SPACE')) inserts.push(...blockDef('*Paper_Space', newHandle(), newHandle(), true));
            if (inserts.length) {
                pairs.splice(blocksSec.end, 0, ...inserts);
                fixes.push('Added missing *Model_Space / *Paper_Space block definitions.');
            }
        }

        // ---- Fix: ENTITIES section must exist ----
        if (!findSections(pairs).find(s => s.name === 'ENTITIES')) {
            const eofIdx = pairs.findIndex(([c, v]) => c === '0' && v.trim().toUpperCase() === 'EOF');
            pairs.splice(eofIdx < 0 ? pairs.length : eofIdx, 0, ['0', 'SECTION'], ['2', 'ENTITIES'], ['0', 'ENDSEC']);
            fixes.push('Created missing ENTITIES section.');
        }

        // ---- Fix: entities missing AcDbEntity / type subclass markers ----
        // R2000+ entities must carry the AcDbEntity subclass marker plus their
        // type-specific subclass (AcDbLine, AcDbPolyline, …). Older/foreign
        // exporters often omit them and strict readers then reject the geometry.
        // Only the simple types in ENTITY_SUBCLASS are repaired; the two markers
        // are inserted at their canonical positions and no other tag is moved.
        {
            let patched = 0, section = null, i = 0;
            while (i < pairs.length) {
                const [c, vRaw] = pairs[i];
                const v = String(vRaw).trim().toUpperCase();
                if (c === '0' && v === 'SECTION') { section = (pairs[i + 1]?.[0] === '2') ? pairs[i + 1][1].trim().toUpperCase() : null; i++; continue; }
                if (c === '0' && v === 'ENDSEC') { section = null; i++; continue; }
                if ((section === 'ENTITIES' || section === 'BLOCKS') && c === '0' && ENTITY_SUBCLASS[v]) {
                    let end = i + 1;
                    while (end < pairs.length && pairs[end][0] !== '0') end++;
                    const subclass = ENTITY_SUBCLASS[v];
                    const slice = pairs.slice(i, end);
                    const hasEnt = slice.some(([cc, vv]) => cc === '100' && String(vv).trim() === 'AcDbEntity');
                    const hasSub = slice.some(([cc, vv]) => cc === '100' && String(vv).trim() === subclass);
                    if (hasEnt && hasSub) { i = end; continue; }
                    const consumeGroup = (arr, k) => { // copy a 102 {...} group, return new k
                        arr.push(pairs[k]); k++;
                        while (k < end && !(pairs[k][0] === '102' && String(pairs[k][1]).trim() === '}')) { arr.push(pairs[k]); k++; }
                        if (k < end) { arr.push(pairs[k]); k++; }
                        return k;
                    };
                    const rebuilt = [pairs[i]]; // 0 / TYPE
                    let k = i + 1;
                    // header: handle(5/105), reactor/xdict 102-groups, owner(330/360)
                    while (k < end) {
                        const hc = pairs[k][0];
                        if (hc === '5' || hc === '105' || hc === '330' || hc === '360') { rebuilt.push(pairs[k]); k++; }
                        else if (hc === '102') { k = consumeGroup(rebuilt, k); }
                        else break;
                    }
                    if (!hasEnt) rebuilt.push(['100', 'AcDbEntity']);
                    // common (AcDbEntity) props, preserving an in-place AcDbEntity marker
                    while (k < end) {
                        const cc = pairs[k][0];
                        if (cc === '100' && String(pairs[k][1]).trim() === 'AcDbEntity') { rebuilt.push(pairs[k]); k++; }
                        else if (ENTITY_COMMON.has(cc)) { rebuilt.push(pairs[k]); k++; }
                        else if (cc === '102') { k = consumeGroup(rebuilt, k); }
                        else break;
                    }
                    if (!hasSub) rebuilt.push(['100', subclass]);
                    while (k < end) { rebuilt.push(pairs[k]); k++; }
                    pairs.splice(i, end - i, ...rebuilt);
                    patched++;
                    i += rebuilt.length;
                    continue;
                }
                i++;
            }
            if (patched) fixes.push(`Added missing subclass marker(s) to ${patched} entit${patched === 1 ? 'y' : 'ies'}.`);
        }

        // ---- Final: correct $HANDSEED to be above every handle in use ----
        {
            info = scan();
            const seed = Math.max(nextHandle, info.maxHandle + 1).toString(16).toUpperCase();
            for (let i = 0; i < pairs.length - 1; i++) {
                if (pairs[i][0] === '9' && pairs[i][1].trim().toUpperCase() === '$HANDSEED' && pairs[i + 1][0] === '5') {
                    if (parseInt(pairs[i + 1][1], 16) <= info.maxHandle) {
                        pairs[i + 1] = ['5', seed];
                        fixes.push('Corrected $HANDSEED (was at or below existing handles).');
                    }
                    break;
                }
            }
        }

        return { text: fromPairs(pairs), fixes };
    }

    // ---------- empty drawing template ----------

    function createEmptyDrawing(insunits) {
        let h = 0x100;
        const nh = () => (h++).toString(16).toUpperCase();
        const dictRoot = nh(), dictLayouts = nh();
        const brModel = nh(), brPaper = nh();
        const loModel = nh(), loPaper = nh();
        const pairs = [
            ...headerVars(Number.isFinite(Number(insunits)) ? Number(insunits) : 4, '3000'),
            ['0', 'SECTION'], ['2', 'TABLES'],
            ['0', 'TABLE'], ['2', 'VPORT'], ['5', nh()], ['100', 'AcDbSymbolTable'], ['70', '1'], ...vportRecord(nh()), ['0', 'ENDTAB'],
            ['0', 'TABLE'], ['2', 'LTYPE'], ['5', nh()], ['100', 'AcDbSymbolTable'], ['70', '3'],
            ...ltypeRecord('BYBLOCK', nh()), ...ltypeRecord('BYLAYER', nh()), ...ltypeRecord('CONTINUOUS', nh()),
            ['0', 'ENDTAB'],
            ['0', 'TABLE'], ['2', 'LAYER'], ['5', nh()], ['100', 'AcDbSymbolTable'], ['70', '1'], ...layerRecord('0', nh()), ['0', 'ENDTAB'],
            ['0', 'TABLE'], ['2', 'STYLE'], ['5', nh()], ['100', 'AcDbSymbolTable'], ['70', '1'], ...styleRecord(nh()), ['0', 'ENDTAB'],
            ['0', 'TABLE'], ['2', 'APPID'], ['5', nh()], ['100', 'AcDbSymbolTable'], ['70', '1'], ...appidRecord(nh()), ['0', 'ENDTAB'],
            ['0', 'TABLE'], ['2', 'BLOCK_RECORD'], ['5', nh()], ['100', 'AcDbSymbolTable'], ['70', '2'],
            ...blockRecordRecord('*Model_Space', brModel), ...blockRecordRecord('*Paper_Space', brPaper),
            ['0', 'ENDTAB'],
            ['0', 'ENDSEC'],
            ['0', 'SECTION'], ['2', 'BLOCKS'],
            ...blockDef('*Model_Space', nh(), nh(), false),
            ...blockDef('*Paper_Space', nh(), nh(), true),
            ['0', 'ENDSEC'],
            ['0', 'SECTION'], ['2', 'ENTITIES'],
            ['0', 'ENDSEC'],
            ['0', 'SECTION'], ['2', 'OBJECTS'],
            ['0', 'DICTIONARY'], ['5', dictRoot], ['100', 'AcDbDictionary'], ['281', '1'],
            ['3', 'ACAD_LAYOUT'], ['350', dictLayouts],
            ['0', 'DICTIONARY'], ['5', dictLayouts], ['330', dictRoot], ['100', 'AcDbDictionary'], ['281', '1'],
            ['3', 'Model'], ['350', loModel],
            ['3', 'Layout1'], ['350', loPaper],
            ...layoutObject('Model', loModel, dictLayouts, brModel, 0, true),
            ...layoutObject('Layout1', loPaper, dictLayouts, brPaper, 1, false),
            ['0', 'ENDSEC'],
            ['0', 'EOF'],
        ];
        return fromPairs(pairs);
    }

    const DxfSanitize = { sanitizeDxf, createEmptyDrawing };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfSanitize;
    if (root) root.DxfSanitize = DxfSanitize;
})(typeof window !== 'undefined' ? window : null);