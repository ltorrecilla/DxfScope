/* Save named DXF STYLE records and their text references without rewriting unrelated tables. */
(function (root) {
    'use strict';

    function parseFontChoice(filename) {
        const value = String(filename || '').trim();
        const match = value.match(/^(.*)\.(ttf|otf|shx)$/i);
        return match ? { name: match[1], format: match[2].toLowerCase() }
            : { name: value, format: value ? 'other' : 'ttf' };
    }

    function fontFileFromChoice(name, format = 'ttf') {
        const value = String(name || '').trim();
        if (!value || format === 'other') return value;
        return value.replace(/\.(ttf|otf|shx)$/i, '') + '.' + format;
    }

    function sync(raw, styles, removedNames = [], activeName = 'STANDARD') {
        const pairs = [];
        const lines = String(raw || '').split(/\r\n|\n|\r/);
        for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i].trim(), lines[i + 1]]);
        const is = (i, code, value) => pairs[i]?.[0] === code && pairs[i]?.[1].trim().toUpperCase() === value;
        let nextHandle = 1;
        for (const [code, value] of pairs) if (code === '5' || code === '105') {
            const number = parseInt(value, 16);
            if (Number.isFinite(number)) nextHandle = Math.max(nextHandle, number + 1);
        }
        let table = pairs.findIndex((_, i) => is(i, '0', 'TABLE') && is(i + 1, '2', 'STYLE'));
        if (table < 0) {
            const tables = pairs.findIndex((_, i) => is(i, '0', 'SECTION') && is(i + 1, '2', 'TABLES'));
            if (tables < 0) {
                const entities = pairs.findIndex((_, i) => is(i, '0', 'SECTION') && is(i + 1, '2', 'ENTITIES'));
                const at = entities < 0 ? 0 : entities;
                pairs.splice(at, 0, ['0', 'SECTION'], ['2', 'TABLES'], ['0', 'TABLE'], ['2', 'STYLE'],
                    ['70', '0'], ['0', 'ENDTAB'], ['0', 'ENDSEC']);
                table = at + 2;
            } else {
                let at = tables + 2;
                while (at < pairs.length && !is(at, '0', 'ENDSEC')) at++;
                pairs.splice(at, 0, ['0', 'TABLE'], ['2', 'STYLE'], ['70', '0'], ['0', 'ENDTAB']);
                table = at;
            }
        }
        const recordBounds = () => {
            let end = table + 2;
            while (end < pairs.length && !is(end, '0', 'ENDTAB')) end++;
            return end;
        };
        const findRecord = name => {
            const end = recordBounds();
            for (let i = table + 2; i < end; i++) if (is(i, '0', 'STYLE')) {
                let stop = i + 1;
                while (stop < end && pairs[stop][0] !== '0') stop++;
                const found = pairs.slice(i, stop).find(pair => pair[0] === '2')?.[1].trim();
                if (found?.toUpperCase() === String(name).toUpperCase()) return [i, stop];
                i = stop - 1;
            }
            return null;
        };
        const removed = new Set(removedNames.map(name => String(name).toUpperCase()));
        for (const name of removed) {
            const found = findRecord(name);
            if (found) pairs.splice(found[0], found[1] - found[0]);
        }
        const values = style => ({
            '2': style.name, '3': style.fontFile || 'txt.shx', '4': style.bigFontFile || '',
            '40': String(Number(style.fixedHeight) || 0),
            '41': String(Number(style.widthFactor) || 1),
            '50': String(Number(style.oblique) || 0),
        });
        for (const style of styles || []) {
            if (!style?.name) continue;
            const fields = values(style);
            const found = findRecord(style.sourceName || style.name);
            if (found) {
                const record = pairs.slice(found[0], found[1]);
                const seen = new Set();
                for (const pair of record) if (Object.hasOwn(fields, pair[0])) {
                    pair[1] = fields[pair[0]];
                    seen.add(pair[0]);
                }
                for (const [code, value] of Object.entries(fields)) if (!seen.has(code)) record.push([code, value]);
                pairs.splice(found[0], found[1] - found[0], ...record);
            } else {
                const record = [['0', 'STYLE'], ['5', (nextHandle++).toString(16).toUpperCase()],
                    ['100', 'AcDbSymbolTableRecord'], ['100', 'AcDbTextStyleTableRecord'],
                    ['2', fields['2']], ['70', '0'], ['40', fields['40']], ['41', fields['41']],
                    ['50', fields['50']], ['71', '0'], ['42', '0'], ['3', fields['3']], ['4', fields['4']]];
                pairs.splice(recordBounds(), 0, ...record);
            }
        }
        const end = recordBounds();
        const count = pairs.slice(table + 2, end).filter(pair => pair[0] === '0' && pair[1].trim() === 'STYLE').length;
        const firstRecord = pairs.findIndex((_, i) => i > table + 1 && i < end && is(i, '0', 'STYLE'));
        const countPair = pairs.slice(table + 2, firstRecord < 0 ? end : firstRecord).find(pair => pair[0] === '70');
        if (countPair) countPair[1] = String(count);
        else pairs.splice(table + 2, 0, ['70', String(count)]);

        // A renamed style remains a live reference for all text, including block children.
        const renames = new Map((styles || []).filter(style => style.sourceName &&
            style.sourceName.toUpperCase() !== style.name.toUpperCase())
            .map(style => [style.sourceName.toUpperCase(), style.name]));
        let entity = '', inHeader = false;
        for (let i = 0; i < pairs.length; i++) {
            if (is(i, '0', 'SECTION')) inHeader = is(i + 1, '2', 'HEADER');
            else if (is(i, '0', 'ENDSEC')) inHeader = false;
            if (pairs[i][0] === '0') entity = pairs[i][1].trim().toUpperCase();
            if (inHeader && is(i, '9', '$TEXTSTYLE') && pairs[i + 1]?.[0] === '7')
                pairs[i + 1][1] = activeName;
            if (pairs[i][0] === '7' && ['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'].includes(entity)) {
                const old = pairs[i][1].trim().toUpperCase();
                if (renames.has(old)) pairs[i][1] = renames.get(old);
                else if (removed.has(old)) pairs[i][1] = 'STANDARD';
            }
        }
        const handseed = pairs.findIndex((_, i) => is(i, '9', '$HANDSEED') && pairs[i + 1]?.[0] === '5');
        if (handseed >= 0) pairs[handseed + 1][1] = Math.max(parseInt(pairs[handseed + 1][1], 16) || 0,
            nextHandle).toString(16).toUpperCase();
        return pairs.flat().join('\n') + '\n';
    }

    const api = { sync, parseFontChoice, fontFileFromChoice };
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.DxfTextStyle = api;
})(typeof window !== 'undefined' ? window : globalThis);
