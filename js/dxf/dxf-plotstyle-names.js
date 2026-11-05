/* Named plot-style DXF references. Preserve raw records; change only requested
 * assignments and add dictionary placeholders for newly assigned names. */
(function(root) {
    'use strict';
    const upper = s => String(s || '').toUpperCase();
    function records(text) {
        const lines = String(text || '').split(/\r\n|\n|\r/), out = [];
        let rec = null, section = '';
        for (let i = 0; i + 1 < lines.length; i += 2) {
            const code = lines[i].trim(), value = lines[i + 1];
            if (code === '0') { rec = { type: upper(value.trim()), pairs: [], section }; out.push(rec); }
            if (!rec) continue;
            rec.pairs.push(code, value);
            if (rec.type === 'SECTION' && code === '2') { section = upper(value.trim()); rec.section = section; }
            if (rec.type === 'ENDSEC') section = '';
        }
        return out;
    }
    function value(rec, code) {
        for (let i = 0; i < (rec?.pairs.length || 0); i += 2) if (rec.pairs[i] === String(code)) return rec.pairs[i + 1].trim();
        return null;
    }
    function entries(rec) {
        const map = new Map(); let name = '';
        for (let i = 0; i < (rec?.pairs.length || 0); i += 2) {
            const c = rec.pairs[i], v = rec.pairs[i + 1].trim();
            if (c === '3') name = v;
            else if (name && (c === '350' || c === '360')) { map.set(name, upper(v)); name = ''; }
        }
        return map;
    }
    function read(text) {
        const all = records(text), byHandle = new Map(all.filter(r => value(r, 5)).map(r => [upper(value(r, 5)), r]));
        const rootDict = all.find(r => r.section === 'OBJECTS' && ['DICTIONARY','ACDBDICTIONARYWDFLT'].includes(r.type) && entries(r).has('ACAD_PLOTSTYLENAME'));
        const dict = byHandle.get(entries(rootDict).get('ACAD_PLOTSTYLENAME'));
        const names = entries(dict), byStyleHandle = new Map([...names].map(([name, h]) => [h, name]));
        const assigned = rec => {
            const enumValue = value(rec, 380);
            if (enumValue === '0') return 'BYLAYER';
            if (enumValue === '1') return 'BYBLOCK';
            if (enumValue === '2') return byStyleHandle.get(upper(value(dict, 340))) || 'Normal';
            const h = upper(value(rec, 390));
            if (h && h !== '0') return byStyleHandle.get(h) || '@' + h;
            const mode = Number(value(rec, 380) || 0);
            return mode === 1 ? 'BYBLOCK' : mode === 2 ? (byStyleHandle.get(upper(value(dict, 340))) || 'Normal') : 'BYLAYER';
        };
        const layers = new Map(), entities = new Map();
        for (const r of all) {
            if (r.type === 'LAYER' && r.section === 'TABLES') layers.set(value(r, 2), assigned(r));
            else if (['ENTITIES', 'BLOCKS'].includes(r.section) && value(r, 5)) entities.set(upper(value(r, 5)), assigned(r));
        }
        const header = all.find(r => r.type === 'SECTION' && r.section === 'HEADER');
        const variables = new Map();
        for (let i = 0; i < (header?.pairs.length || 0) - 3; i += 2)
            if (header.pairs[i] === '9') variables.set(header.pairs[i + 1].trim(), header.pairs[i + 3].trim());
        const named = Number(variables.get('$PSTYLEMODE') ?? 1) === 0;
        const defaultType = Number(variables.get('$CEPSNTYPE') || 0);
        const defaultHandle = upper(variables.get('$CEPSNID'));
        const defaultStyle = defaultType === 1 ? 'BYBLOCK' : defaultType === 2 ? 'Normal'
            : defaultType === 3 && defaultHandle ? byStyleHandle.get(defaultHandle) || '@' + defaultHandle : 'BYLAYER';
        const modeRoot = all.find(r => r.section === 'OBJECTS' && r.type === 'DICTIONARY' && entries(r).has('LITEAECO_PLOTSTYLE_MODE'));
        const modeRecord = byHandle.get(entries(modeRoot).get('LITEAECO_PLOTSTYLE_MODE'));
        let modeState = null;
        try {
            const data = JSON.parse(decodeURIComponent((modeRecord?.pairs || []).filter((_, i, a) => i % 2 && a[i - 1] === '1').join('')));
            if (data.version === 1) modeState = data;
        } catch (_) { /* No saved conversion state. */ }
        return { named, layers, entities, names, all, byHandle, dict, rootDict, defaultStyle, modeState };
    }
    function appendObjects(all, extra, rootDict) {
        let end = all.findIndex(r => r.section === 'OBJECTS' && r.type === 'ENDSEC');
        if (end >= 0) {
            // The named-object dictionary must be the first OBJECTS record.
            if (extra.includes(rootDict)) {
                const start = all.findIndex(r => r.type === 'SECTION' && r.section === 'OBJECTS');
                all.splice(start + 1, 0, rootDict); end++;
                extra = extra.filter(r => r !== rootDict);
            }
            all.splice(end, 0, ...extra);
        } else {
            const eof = all.findIndex(r => r.type === 'EOF');
            all.splice(eof < 0 ? all.length : eof, 0,
                { pairs: ['0','SECTION','2','OBJECTS'] }, ...extra, { pairs: ['0','ENDSEC'] });
        }
    }
    function sync(text, entityChanges, layerChanges) {
        if (!entityChanges.size && !layerChanges.size) return text;
        const state = read(text);
        if (!state.named) return text;
        let max = 255;
        for (const r of state.all) for (let i = 0; i < r.pairs.length; i += 2)
            if (r.pairs[i] === '5' || r.pairs[i] === '105') max = Math.max(max, parseInt(r.pairs[i + 1], 16) || 0);
        const allocate = () => (++max).toString(16).toUpperCase();
        const extra = [];
        const add = (type, pairs) => { const r = { type, section: 'OBJECTS', pairs: ['0', type, ...pairs] }; extra.push(r); return r; };
        let dict = state.dict, rootDict = state.rootDict;
        const handles = new Map([...state.names].map(([n, h]) => [n.toLowerCase(), h]));
        const ensureName = name => {
            if (handles.has(name.toLowerCase())) return handles.get(name.toLowerCase());
            if (!dict) {
                rootDict = rootDict || state.all.find(r => r.section === 'OBJECTS' && r.type === 'DICTIONARY' && (!value(r, 330) || value(r, 330) === '0'));
                if (!rootDict) rootDict = add('DICTIONARY', ['5', allocate(), '330', '0', '100', 'AcDbDictionary', '280', '0', '281', '1']);
                dict = add('ACDBDICTIONARYWDFLT', ['5', allocate(), '330', value(rootDict, 5), '100', 'AcDbDictionary', '280', '1', '281', '1']);
                rootDict.pairs.push('3', 'ACAD_PLOTSTYLENAME', '350', value(dict, 5));
                const normal = ensureName('Normal');
                dict.pairs.push('100', 'AcDbDictionaryWithDefault', '340', normal);
            }
            if (handles.has(name.toLowerCase())) return handles.get(name.toLowerCase());
            const h = allocate();
            // Entries belong in the dictionary subclass, before its default subclass.
            const next = dict.pairs.indexOf('AcDbDictionaryWithDefault');
            dict.pairs.splice(next < 0 ? dict.pairs.length : next - 1, 0, '3', name, '350', h);
            add('ACDBPLACEHOLDER', ['5', h, '330', value(dict, 5), '100', 'AcDbPlaceHolder']);
            handles.set(name.toLowerCase(), h);
            return h;
        };
        const patch = (r, name, layer) => {
            let type = 3, handle = null;
            if (upper(name) === 'BYLAYER') type = 0;
            else if (upper(name) === 'BYBLOCK') type = 1;
            else handle = /^@[0-9a-f]+$/i.test(name) ? name.slice(1).toUpperCase() : ensureName(name);
            const pairs = r.pairs;
            // Remove common style references, retaining custom entity data/XDATA.
            let common = true;
            for (let i = 2; i < pairs.length;) {
                if (pairs[i] === '100' && pairs[i + 1] !== 'AcDbEntity' && !layer) common = false;
                if ((layer || common) && ['380','390'].includes(pairs[i])) pairs.splice(i, 2);
                else i += 2;
            }
            const at = pairs.indexOf('AcDbEntity');
            const xdata = pairs.indexOf('1001');
            const index = layer ? (xdata < 0 ? pairs.length : xdata) : at >= 0 ? at + 1 : 2;
            pairs.splice(index, 0, ...(layer ? [] : ['380', String(type)]), ...(handle ? ['390', handle] : []));
        };
        for (const r of state.all) {
            const h = upper(value(r, 5));
            if (r.type === 'LAYER' && layerChanges.has(value(r, 2))) patch(r, layerChanges.get(value(r, 2)), true);
            else if (['ENTITIES','BLOCKS'].includes(r.section) && entityChanges.has(h)) patch(r, entityChanges.get(h), false);
        }
        if (extra.length) {
            appendObjects(state.all, extra, rootDict);
            const header = state.all.find(r => r.type === 'SECTION' && r.section === 'HEADER');
            if (header) {
                const at = header.pairs.indexOf('$HANDSEED');
                if (at >= 0) header.pairs[at + 2] = (max + 1).toString(16).toUpperCase();
                else header.pairs.push('9','$HANDSEED','5',(max + 1).toString(16).toUpperCase());
            }
        }
        return state.all.flatMap(r => r.pairs).join('\n') + '\n';
    }
    function colorStyle(aci, rgb, nearestAci, layer = false) {
        if (Number.isFinite(rgb)) return 'Color_' + nearestAci(rgb);
        const n = aci == null ? 256 : Math.abs(Number(aci));
        if (!layer && n === 0) return 'BYBLOCK';
        if (!layer && n === 256) return 'BYLAYER';
        return 'Color_' + (Number.isInteger(n) && n >= 1 && n <= 255 ? n : 7);
    }
    function colorAssignments(text, nearestAci) {
        const entities = new Map(), layers = new Map();
        const commonValue = (r, code) => {
            for (let i = 2; i < r.pairs.length; i += 2) {
                if (r.pairs[i] === '100' && r.pairs[i + 1] !== 'AcDbEntity') break;
                if (r.pairs[i] === String(code)) return r.pairs[i + 1].trim();
            }
            return null;
        };
        for (const r of records(text)) {
            const layer = r.section === 'TABLES' && r.type === 'LAYER';
            if (!layer && (!['ENTITIES','BLOCKS'].includes(r.section) || ['BLOCK','ENDBLK','SEQEND','VERTEX'].includes(r.type))) continue;
            const rgb = layer ? value(r, 420) : commonValue(r, 420), aci = layer ? value(r, 62) : commonValue(r, 62);
            const name = colorStyle(aci === null ? null : Number(aci), rgb === null ? null : Number(rgb), nearestAci, layer);
            if (layer) layers.set(value(r, 2), name);
            else if (value(r, 5)) entities.set(upper(value(r, 5)), name);
        }
        return { entities, layers };
    }
    function setMode(text, named, modeState) {
        const state = read(text), all = state.all;
        let header = all.find(r => r.type === 'SECTION' && r.section === 'HEADER');
        if (!header) {
            header = { type:'SECTION', section:'HEADER', pairs:['0','SECTION','2','HEADER'] };
            all.unshift(header, { type:'ENDSEC', section:'HEADER', pairs:['0','ENDSEC'] });
        }
        const at = header.pairs.indexOf('$PSTYLEMODE');
        if (at >= 0) { header.pairs[at + 1] = '290'; header.pairs[at + 2] = named ? '0' : '1'; }
        else header.pairs.push('9','$PSTYLEMODE','290',named ? '0' : '1');
        if (modeState) {
            let max = 255;
            for (const r of all) for (let i = 0; i < r.pairs.length; i += 2)
                if (['5','105','330','340','350','360','390'].includes(r.pairs[i])) max = Math.max(max, parseInt(r.pairs[i + 1], 16) || 0);
            const alloc = () => (++max).toString(16).toUpperCase(), extra = [];
            let rootDict = all.find(r => r.section === 'OBJECTS' && r.type === 'DICTIONARY' && (!value(r, 330) || value(r, 330) === '0'));
            if (!rootDict) { rootDict = {type:'DICTIONARY',section:'OBJECTS',pairs:['0','DICTIONARY','5',alloc(),'330','0','100','AcDbDictionary','281','1']}; extra.push(rootDict); }
            const key = 'LITEAECO_PLOTSTYLE_MODE';
            let record = state.byHandle.get(entries(rootDict).get(key));
            if (!record) {
                const h = alloc(); rootDict.pairs.push('3',key,'350',h);
                record = {type:'XRECORD',section:'OBJECTS',pairs:['0','XRECORD','5',h,'330',value(rootDict,5),'100','AcDbXrecord','280','1']}; extra.push(record);
            }
            // Keep the record header and replace only our versioned payload.
            for (let i = 0; i < record.pairs.length;) {
                if (record.pairs[i] === '1') record.pairs.splice(i,2); else i += 2;
            }
            const encoded = encodeURIComponent(JSON.stringify({...modeState,version:1}));
            for (let i = 0; i < encoded.length; i += 240) record.pairs.push('1',encoded.slice(i,i + 240));
            if (extra.length) {
                appendObjects(all, extra, rootDict);
            }
            const seed = header.pairs.indexOf('$HANDSEED');
            if (seed >= 0) header.pairs[seed + 2] = (max + 1).toString(16).toUpperCase();
            else header.pairs.push('9','$HANDSEED','5',(max + 1).toString(16).toUpperCase());
        }
        return all.flatMap(r => r.pairs).join('\n') + '\n';
    }
    const api = { read, sync, colorStyle, colorAssignments, setMode };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.DxfPlotStyleNames = api;
})(typeof window !== 'undefined' ? window : null);
