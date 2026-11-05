/** DXF GROUP objects and their ACAD_GROUP dictionary. */
(function (root) {
    'use strict';

    const cleanHandle = value => String(value || '').trim().toUpperCase();
    const pairsFrom = raw => {
        const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
        if (lines.at(-1) === '') lines.pop();
        const pairs = [];
        for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i].trim(), lines[i + 1]]);
        return pairs;
    };
    const flatten = pairs => pairs.flat().join('\n') + '\n';
    const first = (body, code) => body.find(pair => pair[0] === code)?.[1]?.trim() || '';
    const section = (pairs, name) => {
        for (let i = 0; i + 1 < pairs.length; i++) {
            if (pairs[i][0] !== '0' || pairs[i][1].trim().toUpperCase() !== 'SECTION') continue;
            if (pairs[i + 1][0] !== '2' || pairs[i + 1][1].trim().toUpperCase() !== name) continue;
            for (let j = i + 2; j < pairs.length; j++) {
                if (pairs[j][0] === '0' && pairs[j][1].trim().toUpperCase() === 'ENDSEC') return { start: i + 2, end: j };
            }
        }
        return null;
    };
    const records = (pairs, range) => {
        const out = [];
        if (!range) return out;
        for (let i = range.start; i < range.end;) {
            if (pairs[i][0] !== '0') { i++; continue; }
            let j = i + 1;
            while (j < range.end && pairs[j][0] !== '0') j++;
            out.push({ type: pairs[i][1].trim().toUpperCase(), body: pairs.slice(i, j) });
            i = j;
        }
        return out;
    };
    const dictEntries = body => {
        const entries = new Map();
        for (let i = 0; i + 1 < body.length; i++) {
            if (body[i][0] === '3' && ['350', '360'].includes(body[i + 1][0])) {
                entries.set(body[i][1], cleanHandle(body[i + 1][1]));
            }
        }
        return entries;
    };
    const withoutEntries = body => body.filter((pair, i) =>
        !(pair[0] === '3' && ['350', '360'].includes(body[i + 1]?.[0]))
        && !(['350', '360'].includes(pair[0]) && body[i - 1]?.[0] === '3'));
    const rootDictionary = items => items.find(r => r.type === 'DICTIONARY' && cleanHandle(first(r.body, '330')) === '0')
        || items.find(r => r.type === 'DICTIONARY' && dictEntries(r.body).has('ACAD_LAYOUT'))
        || items.find(r => r.type === 'DICTIONARY');

    function read(raw) {
        const pairs = pairsFrom(raw);
        const items = records(pairs, section(pairs, 'OBJECTS'));
        const rootDict = rootDictionary(items);
        const groupDictHandle = dictEntries(rootDict?.body || []).get('ACAD_GROUP');
        const groupDict = items.find(r => r.type === 'DICTIONARY' && cleanHandle(first(r.body, '5')) === groupDictHandle);
        if (!groupDict) return [];
        const byHandle = new Map(items.filter(r => r.type === 'GROUP').map(r => [cleanHandle(first(r.body, '5')), r]));
        const groups = [];
        for (const [name, handle] of dictEntries(groupDict.body)) {
            const record = byHandle.get(handle);
            if (!record) continue;
            groups.push({ name, handle, description: first(record.body, '300'),
                unnamed: first(record.body, '70') === '1', selectable: first(record.body, '71') !== '0',
                members: record.body.filter(pair => pair[0] === '340').map(pair => cleanHandle(pair[1])).filter(Boolean),
                rawBody: record.body.map(pair => [...pair]) });
        }
        return groups;
    }

    function write(raw, groups) {
        const pairs = pairsFrom(raw);
        const range = section(pairs, 'OBJECTS');
        const items = records(pairs, range);
        let rootDict = rootDictionary(items);
        const oldGroupDictHandle = dictEntries(rootDict?.body || []).get('ACAD_GROUP');
        let groupDict = items.find(r => r.type === 'DICTIONARY' && cleanHandle(first(r.body, '5')) === oldGroupDictHandle);
        const oldGroupHandles = new Set(dictEntries(groupDict?.body || []).values());
        let next = 1;
        for (const pair of pairs) if (pair[0] === '5' || pair[0] === '105') {
            const value = parseInt(pair[1], 16);
            if (Number.isFinite(value)) next = Math.max(next, value + 1);
        }
        for (const group of groups) {
            const value = parseInt(group.handle, 16);
            if (Number.isFinite(value)) next = Math.max(next, value + 1);
        }
        const alloc = () => (next++).toString(16).toUpperCase();
        if (!rootDict) rootDict = { type: 'DICTIONARY', body: [['0', 'DICTIONARY'], ['5', alloc()], ['330', '0'], ['100', 'AcDbDictionary'], ['281', '1']] };
        const rootHandle = cleanHandle(first(rootDict.body, '5'));
        if (!groupDict) groupDict = { type: 'DICTIONARY', body: [['0', 'DICTIONARY'], ['5', alloc()], ['330', rootHandle], ['100', 'AcDbDictionary'], ['281', '1']] };
        const groupDictHandle = cleanHandle(first(groupDict.body, '5'));
        if (!dictEntries(rootDict.body).has('ACAD_GROUP')) rootDict.body = [...rootDict.body, ['3', 'ACAD_GROUP'], ['350', groupDictHandle]];
        groupDict.body = withoutEntries(groupDict.body);
        for (const group of groups) {
            if (!group.handle) group.handle = alloc();
            groupDict.body.push(['3', group.name], ['350', cleanHandle(group.handle)]);
        }
        const rewritten = [];
        for (const record of items) {
            if (record.type === 'GROUP' && oldGroupHandles.has(cleanHandle(first(record.body, '5')))) continue;
            if (record === rootDict || record === groupDict) continue;
            rewritten.push(...record.body);
        }
        rewritten.push(...rootDict.body, ...groupDict.body);
        for (const group of groups) {
            const body = group.rawBody
                ? group.rawBody.filter(pair => pair[0] !== '340').map(pair => [...pair])
                : [['0', 'GROUP'], ['5', cleanHandle(group.handle)], ['330', groupDictHandle], ['100', 'AcDbGroup'],
                    ['300', group.description || ''], ['70', group.unnamed ? '1' : '0'], ['71', group.selectable === false ? '0' : '1']];
            for (const member of group.members || []) body.push(['340', cleanHandle(member)]);
            rewritten.push(...body);
        }
        let output;
        if (range) output = [...pairs.slice(0, range.start), ...rewritten, ...pairs.slice(range.end)];
        else {
            const eof = pairs.findIndex(pair => pair[0] === '0' && pair[1].trim().toUpperCase() === 'EOF');
            const at = eof < 0 ? pairs.length : eof;
            output = [...pairs.slice(0, at), ['0', 'SECTION'], ['2', 'OBJECTS'], ...rewritten,
                ['0', 'ENDSEC'], ...pairs.slice(at)];
        }
        const handseed = output.findIndex(pair => pair[0] === '9' && pair[1].trim().toUpperCase() === '$HANDSEED');
        if (handseed >= 0 && output[handseed + 1]?.[0] === '5') output[handseed + 1] = ['5', next.toString(16).toUpperCase()];
        return flatten(output);
    }

    const api = { read, write, cleanHandle };
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.DxfGroups = api;
})(typeof window !== 'undefined' ? window : globalThis);
