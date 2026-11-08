/* Recover DIMSTYLE and per-dimension overrides omitted by dxf-parser. */
(function (root) {
    'use strict';
    const codes = { 3:'DIMPOST',40:'DIMSCALE',41:'DIMASZ',42:'DIMEXO',44:'DIMEXE',45:'DIMRND',
        71:'DIMTOL',72:'DIMLIM',173:'DIMALT',172:'DIMTOFL',174:'DIMTIX',175:'DIMSOXD',176:'DIMCLRD',177:'DIMCLRE',178:'DIMCLRT',278:'DIMDSEP',281:'DIMSD1',282:'DIMSD2',283:'DIMTOLJ',284:'DIMTZIN',285:'DIMALTZ',286:'DIMALTTZ',289:'DIMATFIT',290:'DIMFXLON',49:'DIMFXL', 140:'DIMTXT',142:'DIMTSZ',144:'DIMLFAC',147:'DIMGAP',75:'DIMSE1',76:'DIMSE2',77:'DIMTAD',78:'DIMZIN',79:'DIMAZIN',
        179:'DIMADEC',271:'DIMDEC',275:'DIMAUNIT',277:'DIMLUNIT',280:'DIMJUST',
        340:'DIMTXSTY',342:'DIMBLK',343:'DIMBLK1',344:'DIMBLK2' };
    function recover(drawing, raw, preparedLines = null) {
        const lines = preparedLines || String(raw || '').split(/\r\n|\n|\r/), records = [];
        let record;
        for (let i = 0; i + 1 < lines.length; i += 2) {
            const code = lines[i].trim(), value = lines[i + 1].trim();
            if (code === '0') { record = { type:value, pairs:[] }; records.push(record); }
            else if (record) record.pairs.push([code, value]);
        }
        const styles = Object.create(null), dimensions = new Map();
        for (const r of records) {
            const first = code => r.pairs.find(p => p[0] === code)?.[1];
            if (r.type === 'DIMSTYLE') {
                const style = {};
                for (const [c,v] of r.pairs) if (codes[c]) style[codes[c]] = [3,340,342,343,344].includes(Number(c)) ? v : Number(v);
                styles[(first('2') || '').toUpperCase()] = style;
            } else if (r.type === 'DIMENSION' && first('5')) {
                const overrides = {}; let inDstyle = false, variable = null;
                for (const [c,v] of r.pairs) {
                    if (c === '1000' && v === 'DSTYLE') inDstyle = true;
                    else if (inDstyle && c === '1002' && v === '}') { inDstyle = false; variable = null; }
                    else if (inDstyle && variable === null && c === '1070') variable = v;
                    else if (inDstyle && variable !== null && ['1040','1070','1071','1000','1005'].includes(c)) {
                        if (codes[variable]) overrides[codes[variable]] = ['1000','1005'].includes(c) ? v : Number(v);
                        variable = null;
                    }
                }
                dimensions.set(first('5').toUpperCase(), { name:first('3') || 'STANDARD', overrides });
            }
        }
        // Shared fallback for incomplete files; the drawing's header and styles win.
        const defaults = { DIMDEC: 2, DIMLFAC: 1, DIMTSZ: 0, DIMASZ: 2.5 };
        for (const key of Object.values(codes)) if (drawing.header?.['$' + key] !== undefined) defaults[key] = drawing.header['$' + key];
        const apply = e => {
            if (e?.type !== 'DIMENSION') return;
            const record = dimensions.get(String(e.handle ?? '').toUpperCase());
            const name = record?.name || e.styleName || drawing.header?.$DIMSTYLE || 'STANDARD';
            e.styleName = name;
            e.__baseDimStyle = { ...defaults, ...(styles[String(name).toUpperCase()] || {}) };
            e.__resolvedDimStyle = { ...e.__baseDimStyle, ...(record?.overrides || {}) };
            e.__dimStyleOverrides = { ...(record?.overrides || {}) };
            if (record?.overrides) {
                const o = record.overrides;
                const inherited = { ...defaults, ...(styles[String(name).toUpperCase()] || {}) };
                e.__dimLocalStyle = {};
                if (Number.isFinite(o.DIMTAD) && o.DIMTAD !== inherited.DIMTAD) e.__dimLocalStyle.textPosition = o.DIMTAD === 0 ? 'center' : o.DIMTAD === 4 ? 'below' : 'above';
                if (Number.isFinite(o.DIMTSZ) && o.DIMTSZ !== inherited.DIMTSZ) {
                    e.__dimLocalStyle.markerType = o.DIMTSZ > 0 ? 'tick' : 'arrow';
                    if (o.DIMTSZ > 0) e.__dimLocalStyle.tickSize = o.DIMTSZ * (Number(e.__resolvedDimStyle.DIMSCALE) > 0 ? Number(e.__resolvedDimStyle.DIMSCALE) : 1);
                }
            }
        };
        const capture = e => {
            apply(e);
            if (e?.type === 'DIMENSION') e.__dimAcceptedState = captureDefinition(e);
        };
        (drawing.entities || []).forEach(capture);
        Object.values(drawing.blocks || {}).forEach(b => (b.entities || []).forEach(capture));
        return styles;
    }
    function captureDefinition(entity) {
        const out = {};
        for (const [key, value] of Object.entries(entity)) {
            if (!key.startsWith('__') || ['__dimStyleOverrides','__dimLocalStyle','__dimStyleAssigned','__dimStyleChanged','__dimStyleIndex','__dimTextFlip','__dimTextRot180'].includes(key)) out[key] = value;
        }
        return JSON.parse(JSON.stringify(out));
    }
    function restoreDefinition(entity) {
        const saved = entity.__dimAcceptedState;
        if (!saved) return;
        for (const key of Object.keys(captureDefinition(entity))) delete entity[key];
        Object.assign(entity, JSON.parse(JSON.stringify(saved)));
    }
    function unsupportedFeatures(style, blockNames, drawing) {
        const reasons = [];
        if (style.DIMALT) reasons.push('alternate units');
        if (style.DIMTOL || style.DIMLIM) reasons.push('tolerances or limits');
        if (style.DIMLUNIT != null && style.DIMLUNIT !== 2) reasons.push('non-decimal linear units');
        if (style.DIMJUST) reasons.push('non-centered automatic text');
        if (style.DIMFXLON) reasons.push('fixed-length extension lines');
        if (style.DIMSD1 || style.DIMSD2) reasons.push('suppressed dimension lines');
        if ([style.DIMCLRD, style.DIMCLRE, style.DIMCLRT].some(v => v != null && v !== 0 && v !== 256)) reasons.push('component color overrides');
        if (!(style.DIMTSZ > 0)) for (const handle of [style.DIMBLK1 || style.DIMBLK, style.DIMBLK2 || style.DIMBLK]) {
            if (!handle || String(handle) === '0') continue;
            const name = blockNames?.get(String(handle).toUpperCase()) || handle;
            if (!drawing?.blocks?.[name]?.entities?.length) { reasons.push('unresolved custom arrowhead'); break; }
        }
        return reasons;
    }

    // Resolve file values before converting lengths to drawing units. Keep the
    // original DIMSTYLE and override records untouched for round-trip export.
    function effectiveStyle(entity, drawing, textStyles) {
        const raw = { ...(entity.__baseDimStyle || entity.__resolvedDimStyle || {}), ...(entity.__dimStyleOverrides || {}) };
        const scale = Number(raw.DIMSCALE) > 0 ? Number(raw.DIMSCALE) : 1;
        const style = { ...raw, DIMSCALE: 1 };
        for (const key of ['DIMTXT','DIMASZ','DIMTSZ','DIMGAP','DIMEXO','DIMEXE'])
            if (Number.isFinite(raw[key])) style[key] = raw[key] * scale;
        const catalog = textStyles || {};
        const original = drawing?.blocks?.[entity.block]?.entities?.find(e => e.type === 'TEXT' || e.type === 'MTEXT');
        const textStyle = Object.values(catalog).find(s => s.handle && s.handle.toUpperCase() === String(raw.DIMTXSTY || '').toUpperCase())
            || catalog[String(original?.styleName || original?.textStyle || '').toUpperCase()];
        if (!(style.DIMTXT > 0) && textStyle?.fixedHeight > 0) style.DIMTXT = textStyle.fixedHeight * scale;
        return { raw, style, textStyle: textStyle?.name || original?.styleName || original?.textStyle || 'STANDARD',
            fontFile: textStyle?.fontFile, originalText: original };
    }

    function styleCodes(style) {
        const values = {
            3: style.dimPost || `${style.prefix || ''}<>${style.suffix || ''}`,
            40: 1, 41: style.arrowSize, 42: style.extensionOffset, 44: style.extensionOvershoot,
            45: style.rounding,
            140: style.textHeight, 142: style.markerType === 'arrow' ? 0 : style.tickSize,
            147: style.textGap, 77: style.textPosition === 'center' ? 0 : style.textPosition === 'below' ? 4 : 1,
            179: Number.isFinite(style.angularPrecision) ? style.angularPrecision : style.precision,
            271: style.precision, 275: Number.isFinite(style.angularUnit) ? style.angularUnit : 0,
            79: Number.isFinite(style.angularZeroSuppression) ? style.angularZeroSuppression : 0,
        };
        return Object.entries(values).filter(([c,v]) => c === '3' ? typeof v === 'string' : Number.isFinite(v)).map(([c,v]) => [c, String(v)]);
    }
    function pairsFrom(raw) {
        const lines = String(raw || '').split(/\r\n|\n|\r/);
        const pairs = [];
        for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i].trim(), lines[i + 1]]);
        return pairs;
    }
    function patchDimensionPairs(block, style) {
        const pairs = [];
        for (let i = 0; i + 1 < block.length; i += 2) pairs.push([String(block[i]).trim(), String(block[i + 1])]);
        const nameAt = pairs.findIndex(([c]) => c === '3');
        if (nameAt >= 0) pairs[nameAt][1] = style.name;
        else pairs.splice(1, 0, ['3', style.name]);
        const changedCodes = new Set(styleCodes(style).map(([code]) => code));
        const retainedOverrides = [];
        for (let i = 0; i < pairs.length; i++) {
            if (pairs[i][0] !== '1000' || pairs[i][1].trim() !== 'DSTYLE') continue;
            let end = i + 1;
            while (end < pairs.length && !(pairs[end][0] === '1002' && pairs[end][1].trim() === '}')) end++;
            for (let k = i + 1; k + 1 < end; k++) {
                if (pairs[k][0] === '1070' && !changedCodes.has(pairs[k][1].trim()) &&
                    ['1040','1070','1071','1000','1005'].includes(pairs[k + 1][0])) {
                    retainedOverrides.push(pairs[k], pairs[k + 1]); k++;
                }
            }
            const start = i > 0 && pairs[i - 1][0] === '1001' && pairs[i - 1][1].trim() === 'ACAD' ? i - 1 : i;
            pairs.splice(start, Math.min(end + 1, pairs.length) - start);
            break;
        }
        pairs.push(['1001','ACAD'],['1000','DSTYLE'],['1002','{']);
        pairs.push(...retainedOverrides);
        for (const [code,value] of styleCodes(style)) pairs.push(['1070',code],[code === '3' ? '1000' : Number(code) >= 70 && Number(code) < 80 || Number(code) >= 170 ? '1070' : '1040',value]);
        pairs.push(['1002','}']);
        return pairs.flat();
    }
    // Angular dimensions keep a live reference to their named DIMSTYLE. Rebuild
    // only genuine local overrides so later edits to the style still apply.
    function patchDimensionStyleReference(block, styleName, overrides) {
        const pairs = [];
        for (let i = 0; i + 1 < block.length; i += 2) pairs.push([String(block[i]).trim(), String(block[i + 1])]);
        const nameAt = pairs.findIndex(([code]) => code === '3');
        if (nameAt >= 0) pairs[nameAt][1] = styleName;
        else pairs.splice(1, 0, ['3', styleName]);
        const retained = [];
        for (let i = 0; i < pairs.length; i++) {
            if (pairs[i][0] !== '1000' || pairs[i][1].trim() !== 'DSTYLE') continue;
            let end = i + 1;
            while (end < pairs.length && !(pairs[end][0] === '1002' && pairs[end][1].trim() === '}')) end++;
            for (let k = i + 1; k + 1 < end; k++) {
                if (pairs[k][0] === '1070' && !codes[pairs[k][1].trim()] &&
                    ['1040','1070','1071','1000','1005'].includes(pairs[k + 1][0])) {
                    retained.push(pairs[k], pairs[k + 1]); k++;
                }
            }
            const start = i > 0 && pairs[i - 1][0] === '1001' && pairs[i - 1][1].trim() === 'ACAD' ? i - 1 : i;
            pairs.splice(start, Math.min(end + 1, pairs.length) - start);
            break;
        }
        const byName = Object.fromEntries(Object.entries(codes).map(([code, name]) => [name, code]));
        const local = Object.entries(overrides || {}).filter(([name, value]) =>
            byName[name] && (typeof value === 'string' || Number.isFinite(Number(value))));
        if (retained.length || local.length) {
            pairs.push(['1001','ACAD'],['1000','DSTYLE'],['1002','{'],...retained);
            for (const [name, value] of local) {
                const code = byName[name], n = Number(code);
                const type = [3,340,342,343,344].includes(n) ? (n === 3 ? '1000' : '1005')
                    : (n >= 70 && n < 80 || n >= 170 && n < 300) ? '1070' : '1040';
                pairs.push(['1070',code],[type,String(value)]);
            }
            pairs.push(['1002','}']);
        }
        return pairs.flat();
    }
    function upsertStyleTable(raw, styles) {
        if (!styles?.length) return raw;
        const pairs = pairsFrom(raw);
        let maxHandle = 0;
        for (const [c,v] of pairs) if (c === '5' || c === '105') {
            const n = parseInt(v,16); if (Number.isFinite(n)) maxHandle = Math.max(maxHandle,n);
        }
        let nextHandle = maxHandle + 1;
        const findTable = () => pairs.findIndex((p,i) => p[0] === '0' && p[1] === 'TABLE' && pairs[i + 1]?.[0] === '2' && pairs[i + 1][1].trim().toUpperCase() === 'DIMSTYLE');
        let table = findTable();
        if (table < 0) {
            const tables = pairs.findIndex((p,i) => p[0] === '0' && p[1] === 'SECTION' && pairs[i + 1]?.[0] === '2' && pairs[i + 1][1].trim().toUpperCase() === 'TABLES');
            if (tables < 0) {
                const before = pairs.findIndex((p,i) => p[0] === '0' && p[1] === 'SECTION' && pairs[i + 1]?.[0] === '2' && pairs[i + 1][1].trim().toUpperCase() === 'ENTITIES');
                const insert = before >= 0 ? before : 0;
                pairs.splice(insert, 0, ['0','SECTION'],['2','TABLES'],['0','TABLE'],['2','DIMSTYLE'],['70','0'],['0','ENDTAB'],['0','ENDSEC']);
                table = insert + 2;
            } else {
                let end = tables + 2;
                while (end < pairs.length && !(pairs[end][0] === '0' && pairs[end][1] === 'ENDSEC')) end++;
                pairs.splice(end, 0, ['0','TABLE'],['2','DIMSTYLE'],['70','0'],['0','ENDTAB']);
                table = end;
            }
        }
        let end = table + 1;
        while (end < pairs.length && !(pairs[end][0] === '0' && pairs[end][1] === 'ENDTAB')) end++;
        for (const style of styles) {
            const source = String(style.sourceName || style.name).toUpperCase();
            let start = table + 1;
            while (start < end) {
                if (pairs[start][0] === '0' && pairs[start][1] === 'DIMSTYLE') {
                    let stop = start + 1;
                    while (stop < end && pairs[stop][0] !== '0') stop++;
                    const name = pairs.slice(start, stop).find(p => p[0] === '2')?.[1]?.toUpperCase();
                    if (name === source) break;
                    start = stop;
                } else start++;
            }
            if (start < end) {
                let stop = start + 1;
                while (stop < end && pairs[stop][0] !== '0') stop++;
                const replacement = pairs.slice(start, stop).filter(p => p[0] !== '2' && !styleCodes(style).some(([code]) => code === p[0]));
                replacement.splice(1, 0, ['2',style.name]);
                replacement.push(...styleCodes(style));
                pairs.splice(start, stop - start, ...replacement);
                end += replacement.length - (stop - start);
            } else {
                const rec = [['0','DIMSTYLE'],['105',(nextHandle++).toString(16).toUpperCase()],
                    ['100','AcDbSymbolTableRecord'],['100','AcDbDimStyleTableRecord'],['2',style.name],['70','0'],...styleCodes(style)];
                pairs.splice(end, 0, ...rec); end += rec.length;
            }
        }
        const count = pairs.slice(table + 1, end).filter(p => p[0] === '0' && p[1] === 'DIMSTYLE').length;
        const countAt = pairs.findIndex((p,i) => i > table && i < end && p[0] === '70');
        if (countAt >= 0 && pairs.slice(table + 1, countAt).every(p => p[0] !== '0')) pairs[countAt][1] = String(count);
        else pairs.splice(table + 2, 0, ['70',String(count)]);
        const seed = pairs.findIndex((p,i) => p[0] === '9' && p[1] === '$HANDSEED' && pairs[i + 1]?.[0] === '5');
        if (seed >= 0) pairs[seed + 1][1] = Math.max(parseInt(pairs[seed + 1][1],16) || 0,nextHandle).toString(16).toUpperCase();
        return pairs.flat().join('\n') + '\n';
    }
    function removeStylesFromTable(raw, names) {
        const remove = new Set([...(names || [])].map(name => String(name).toUpperCase()));
        if (!remove.size) return raw;
        const pairs = pairsFrom(raw);
        const table = pairs.findIndex((p,i) => p[0] === '0' && p[1] === 'TABLE' &&
            pairs[i + 1]?.[0] === '2' && pairs[i + 1][1].trim().toUpperCase() === 'DIMSTYLE');
        if (table < 0) return raw;
        let end = table + 1;
        while (end < pairs.length && !(pairs[end][0] === '0' && pairs[end][1] === 'ENDTAB')) end++;
        let cursor = table + 2;
        while (cursor < end) {
            if (pairs[cursor][0] !== '0' || pairs[cursor][1] !== 'DIMSTYLE') { cursor++; continue; }
            let stop = cursor + 1;
            while (stop < end && pairs[stop][0] !== '0') stop++;
            const name = pairs.slice(cursor, stop).find(p => p[0] === '2')?.[1]?.trim().toUpperCase();
            if (remove.has(name)) {
                pairs.splice(cursor, stop - cursor);
                end -= stop - cursor;
            } else cursor = stop;
        }
        const count = pairs.slice(table + 1, end).filter(p => p[0] === '0' && p[1] === 'DIMSTYLE').length;
        const countAt = pairs.findIndex((p,i) => i > table && i < end && p[0] === '70' &&
            pairs.slice(table + 1, i).every(q => q[0] !== '0'));
        if (countAt >= 0) pairs[countAt][1] = String(count);
        return pairs.flat().join('\n') + '\n';
    }
    function previewDimensions(drawing, kind = 'overview') {
        const types = { linear: 0, aligned: 1, angular: 2, diameter: 3, radius: 4, ordinate: 6 };
        const dimensions = (drawing?.entities || []).filter(entity => entity.type === 'DIMENSION');
        return kind === 'overview' ? dimensions
            : Object.hasOwn(types, kind) ? dimensions.filter(entity => (entity.dimensionType & 15) === types[kind]) : [];
    }
    const api = { recover, effectiveStyle, captureDefinition, restoreDefinition, unsupportedFeatures, styleCodes, patchDimensionPairs, patchDimensionStyleReference,
        upsertStyleTable, removeStylesFromTable, previewDimensions };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.DxfDimStyle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
