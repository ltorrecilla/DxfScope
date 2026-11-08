/** Named layer states stored in an app-owned DXF XRECORD. */
(function (root) {
    'use strict';

    const ENTRY = 'LITEAECO_LAYER_STATES';
    const OBJECTS = 'OBJECTS';

    function pairsFrom(raw, preparedLines = null) {
        const lines = preparedLines || String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        const end = lines.at(-1) === '' ? lines.length - 1 : lines.length;
        const pairs = [];
        for (let i = 0; i + 1 < end; i += 2) pairs.push([lines[i].trim(), lines[i + 1]]);
        return pairs;
    }

    function section(pairs, name) {
        for (let i = 0; i + 1 < pairs.length; i++) {
            if (pairs[i][0] !== '0' || pairs[i][1].trim().toUpperCase() !== 'SECTION') continue;
            if (pairs[i + 1][0] !== '2' || pairs[i + 1][1].trim().toUpperCase() !== name) continue;
            for (let j = i + 2; j < pairs.length; j++) {
                if (pairs[j][0] === '0' && pairs[j][1].trim().toUpperCase() === 'ENDSEC') return { start: i + 2, end: j };
            }
        }
        return null;
    }

    function records(pairs, range) {
        const result = [];
        if (!range) return result;
        for (let i = range.start; i < range.end;) {
            if (pairs[i][0] !== '0') { i++; continue; }
            let j = i + 1;
            while (j < range.end && pairs[j][0] !== '0') j++;
            result.push({ start: i, end: j, type: pairs[i][1].trim().toUpperCase(), body: pairs.slice(i, j) });
            i = j;
        }
        return result;
    }

    function value(body, code) {
        return body.find(p => p[0] === code)?.[1]?.trim() || '';
    }

    function rootDictionary(items) {
        const dictionaries = items.filter(r => r.type === 'DICTIONARY');
        return dictionaries.find(r => value(r.body, '330') === '0')
            || dictionaries.find(r => r.body.some(p => p[0] === '3' && p[1] === 'ACAD_LAYOUT'))
            || dictionaries[0] || null;
    }

    function entryHandle(body) {
        for (let i = 0; i + 1 < body.length; i++) {
            if (body[i][0] === '3' && body[i][1] === ENTRY && body[i + 1][0] === '350') return body[i + 1][1].trim().toUpperCase();
        }
        return '';
    }

    function normalize(data) {
        const states = [];
        const used = new Set();
        for (const item of Array.isArray(data?.states) ? data.states : []) {
            const name = String(item?.name || '').trim();
            if (!name || name.length > 120 || used.has(name.toLocaleLowerCase())) continue;
            used.add(name.toLocaleLowerCase());
            const visibility = {};
            for (const [layer, shown] of Object.entries(item.visibility || {})) {
                if (layer && typeof shown === 'boolean') visibility[layer] = shown;
            }
            const state = { name, visibility };
            if (item.properties && typeof item.properties === 'object') {
                state.properties = {};
                for (const [layer, value] of Object.entries(item.properties)) {
                    if (!layer || !value || typeof value !== 'object') continue;
                    const properties = {};
                    if (Number.isInteger(value.color) && value.color >= 0 && value.color <= 0xffffff) properties.color = value.color;
                    if (Number.isInteger(value.weight) && value.weight >= -3 && value.weight <= 211) properties.weight = value.weight;
                    if (typeof value.linetype === 'string' && value.linetype.trim()) properties.linetype = value.linetype;
                    state.properties[layer] = properties;
                }
            }
            states.push(state);
        }
        const current = {};
        for (const [layer, shown] of Object.entries(data?.current || {})) {
            if (layer && typeof shown === 'boolean') current[layer] = shown;
        }
        const active = states.some(s => s.name === data?.active) ? data.active : null;
        return { states, active, current };
    }

    function read(raw, preparedLines = null) {
        const pairs = pairsFrom(raw, preparedLines);
        const items = records(pairs, section(pairs, OBJECTS));
        const dictionary = rootDictionary(items);
        const handle = dictionary && entryHandle(dictionary.body);
        if (!handle) return { ...normalize(null), present: false };
        const rec = items.find(r => r.type === 'XRECORD' && value(r.body, '5').toUpperCase() === handle);
        if (!rec) return { ...normalize(null), present: false };
        try {
            const encoded = rec.body.filter(p => p[0] === '1').map(p => p[1]).join('');
            const parsed = JSON.parse(decodeURIComponent(encoded));
            if (parsed?.app !== ENTRY || parsed?.version !== 1) throw new Error('Unknown layer-state format');
            return { ...normalize(parsed), present: true };
        } catch (_) {
            return { ...normalize(null), present: false };
        }
    }

    function maxHandle(pairs) {
        let max = 0;
        for (const [code, raw] of pairs) {
            if (!['5', '105', '330', '340', '350', '360', '390'].includes(code)) continue;
            const v = raw.trim();
            if (/^[0-9a-f]+$/i.test(v)) max = Math.max(max, parseInt(v, 16));
        }
        return max;
    }

    function write(raw, data) {
        const clean = normalize(data);
        const pairs = pairsFrom(raw);
        let range = section(pairs, OBJECTS);
        let nextHandle = maxHandle(pairs) + 1;
        const alloc = () => (nextHandle++).toString(16).toUpperCase();
        if (!range) {
            const eof = pairs.findIndex(p => p[0] === '0' && p[1].trim().toUpperCase() === 'EOF');
            const at = eof < 0 ? pairs.length : eof;
            pairs.splice(at, 0, ['0', 'SECTION'], ['2', OBJECTS], ['0', 'ENDSEC']);
            range = section(pairs, OBJECTS);
        }

        let items = records(pairs, range);
        let dictionary = rootDictionary(items);
        let rootHandle;
        if (!dictionary) {
            rootHandle = alloc();
            pairs.splice(range.start, 0,
                ['0', 'DICTIONARY'], ['5', rootHandle], ['330', '0'],
                ['100', 'AcDbDictionary'], ['281', '1']);
            range = section(pairs, OBJECTS);
            items = records(pairs, range);
            dictionary = rootDictionary(items);
        } else {
            rootHandle = value(dictionary.body, '5');
        }
        if (!rootHandle) throw new Error('DXF root dictionary has no handle');

        let recordHandle = entryHandle(dictionary.body);
        const existing = items.find(r => r.type === 'XRECORD' && value(r.body, '5').toUpperCase() === recordHandle);
        if (recordHandle && !existing) throw new Error('Layer-state dictionary entry is invalid');
        if (!recordHandle) {
            recordHandle = alloc();
            pairs.splice(dictionary.end, 0, ['3', ENTRY], ['350', recordHandle]);
        }

        const json = JSON.stringify({ app: ENTRY, version: 1, ...clean });
        const encoded = encodeURIComponent(json);
        const record = [['0', 'XRECORD'], ['5', recordHandle], ['330', rootHandle],
            ['100', 'AcDbXrecord'], ['280', '1']];
        for (let i = 0; i < encoded.length; i += 240) record.push(['1', encoded.slice(i, i + 240)]);
        range = section(pairs, OBJECTS);
        items = records(pairs, range);
        const old = items.find(r => r.type === 'XRECORD' && value(r.body, '5').toUpperCase() === recordHandle);
        if (old) pairs.splice(old.start, old.end - old.start, ...record);
        else pairs.splice(range.end, 0, ...record);

        const handseed = pairs.findIndex((p, i) => p[0] === '9' && p[1].trim() === '$HANDSEED' && pairs[i + 1]?.[0] === '5');
        if (handseed >= 0) pairs[handseed + 1][1] = nextHandle.toString(16).toUpperCase();
        return pairs.flat().join('\n') + '\n';
    }

    const api = { read, write, normalize };
    root.DxfLayerStates = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
