/* Endpoint references for Linear/Aligned DIMASSOC objects. */
(function (root) {
    'use strict';
    const upper = v => String(v || '').toUpperCase();
    const close = (a, b) => a && b && Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
    const supported = e => e && ['LINE', 'LWPOLYLINE'].includes(upper(e.type)) && Array.isArray(e.vertices);

    function endpointRef(source, index) {
        if (!supported(source) || !source.handle || !Number.isInteger(index) || !source.vertices[index]) return null;
        if (upper(source.type) === 'LINE' && index > 1) return null;
        return { handle: upper(source.handle), vertex: index, point: {
            x: source.vertices[index].x, y: source.vertices[index].y,
        } };
    }

    function currentPoint(ref, entities) {
        if (!ref) return null;
        const source = (entities || []).find(e => upper(e.handle) === upper(ref.handle));
        if (!supported(source) || !source.vertices[ref.vertex]) return null;
        return source.vertices[ref.vertex];
    }

    function updateDimension(dim, entities) {
        if (!dim?.__dimAssoc || ![0, 1].includes((Number(dim.dimensionType) || 0) & 15)) return false;
        let changed = false;
        for (let i = 0; i < 2; i++) {
            const ref = dim.__dimAssoc.refs[i];
            if (!ref) continue;
            const point = currentPoint(ref, entities);
            if (!point) { dim.__dimAssoc.refs[i] = null; changed = true; continue; }
            const key = i ? 'linearOrAngularPoint2' : 'linearOrAngularPoint1';
            if (!close(dim[key], point)) {
                dim[key] = { x: point.x, y: point.y, z: point.z || 0 };
                changed = true;
            }
            ref.point = { x: point.x, y: point.y };
        }
        return changed;
    }

    function records(raw, preparedLines = null) {
        const lines = preparedLines || String(raw || '').replace(/\r\n?/g, '\n').split('\n');
        const out = []; let section = null;
        for (let i = 0; i + 1 < lines.length;) {
            if (lines[i].trim() === '0' && lines[i + 1].trim() === 'SECTION') {
                section = lines[i + 3]?.trim().toUpperCase(); i += 4; continue;
            }
            if (lines[i].trim() === '0' && lines[i + 1].trim() === 'ENDSEC') { section = null; i += 2; continue; }
            if (lines[i].trim() !== '0') { i += 2; continue; }
            const type = lines[i + 1].trim().toUpperCase(), pairs = [];
            let j = i + 2;
            while (j + 1 < lines.length && lines[j].trim() !== '0') { pairs.push([lines[j].trim(), lines[j + 1].trim()]); j += 2; }
            out.push({ section, type, pairs }); i = j;
        }
        return out;
    }

    function recover(drawing, raw, preparedLines = null) {
        const entities = drawing?.entities || [];
        const byHandle = new Map(entities.filter(e => e?.handle).map(e => [upper(e.handle), e]));
        for (const rec of records(raw, preparedLines)) {
            if (rec.section !== 'OBJECTS' || rec.type !== 'DIMASSOC') continue;
            const first = code => rec.pairs.find(p => p[0] === code)?.[1];
            const subclass = rec.pairs.findIndex(p => p[0] === '100' && p[1] === 'AcDbDimAssoc');
            if (subclass < 0) continue;
            const dim = byHandle.get(upper(rec.pairs.slice(subclass + 1).find(p => p[0] === '330')?.[1]));
            if (!dim || ![0, 1].includes((Number(dim.dimensionType) || 0) & 15)) continue;
            const flags = Number(first('90')) || 0;
            if (flags & ~3) continue;
            const osnaps = [];
            for (let i = subclass + 1; i < rec.pairs.length; i++) {
                if (rec.pairs[i][0] !== '1' || rec.pairs[i][1] !== 'AcDbOsnapPointRef') continue;
                const part = [];
                for (let j = i + 1; j < rec.pairs.length && rec.pairs[j][0] !== '1'; j++) part.push(rec.pairs[j]);
                const get = code => part.find(p => p[0] === code)?.[1];
                osnaps.push({ type: Number(get('72')), handle: upper(get('331')),
                    point: { x: Number(get('10')), y: Number(get('20')) } });
            }
            const refs = [null, null]; let next = 0, valid = true;
            for (let slot = 0; slot < 2; slot++) {
                if (!(flags & (1 << slot))) continue;
                const osnap = osnaps[next++], source = byHandle.get(osnap?.handle);
                if (osnap?.type !== 1 || !supported(source)) { valid = false; break; }
                const matches = source.vertices.map((v, index) => close(v, osnap.point) ? index : -1).filter(i => i >= 0);
                if (matches.length !== 1) { valid = false; break; }
                refs[slot] = endpointRef(source, matches[0]);
            }
            // An unsupported point reference remains in the source DXF as-is.
            if (valid && refs.some(Boolean)) dim.__dimAssoc = { handle: upper(first('5')), refs };
        }
    }

    function emitObject(dim) {
        const a = dim?.__dimAssoc, refs = a?.refs || [];
        const flags = (refs[0] ? 1 : 0) | (refs[1] ? 2 : 0);
        if (!a?.handle || !dim?.handle || !flags) return [];
        const n = v => String(Math.round(Number(v) * 1e9) / 1e9);
        const pairs = ['0','DIMASSOC','5',a.handle,'102','{ACAD_REACTORS','330',upper(dim.handle),'102','}',
            '100','AcDbDimAssoc','330',upper(dim.handle),'90',String(flags),'70','0','71','0'];
        for (const ref of refs) if (ref) pairs.push('1','AcDbOsnapPointRef','72','1','331',upper(ref.handle),
            '73','1','91',String(ref.vertex),'40','0','10',n(ref.point.x),'20',n(ref.point.y),'30','0','75','0');
        return pairs;
    }

    function sync(raw, entities) {
        const live = (entities || []).filter(e => e?.__dimAssoc?.handle && e.handle);
        const sourceRecords = records(raw);
        const dimensions = new Set(sourceRecords.filter(r => ['ENTITIES', 'BLOCKS'].includes(r.section)
            && r.type === 'DIMENSION').map(r => upper(r.pairs.find(p => p[0] === '5')?.[1])));
        for (const dim of entities || []) if (dim?.type === 'DIMENSION' && dim.handle)
            dimensions.add(upper(dim.handle));
        for (const dim of entities || []) if (dim?.type === 'DIMENSION' && dim.handle)
            dimensions.add(upper(dim.handle));
        const orphaned = new Set(sourceRecords.filter(r => r.section === 'OBJECTS' && r.type === 'DIMASSOC')
            .filter(r => {
                const subclass = r.pairs.findIndex(p => p[0] === '100' && p[1] === 'AcDbDimAssoc');
                const owner = subclass < 0 ? '' : upper(r.pairs.slice(subclass + 1).find(p => p[0] === '330')?.[1]);
                return owner && !dimensions.has(owner);
            }).map(r => upper(r.pairs.find(p => p[0] === '5')?.[1])).filter(Boolean));
        if (!live.length && !orphaned.size) return raw;
        const byAssoc = new Map(live.map(e => [upper(e.__dimAssoc.handle), e]));
        const managed = new Set([...byAssoc.keys(), ...orphaned]);
        const reactors = new Map();
        const addReactor = (handle, assoc) => {
            if (!handle) return;
            const key = upper(handle);
            if (!reactors.has(key)) reactors.set(key, new Set());
            reactors.get(key).add(upper(assoc));
        };
        for (const dim of live) {
            const assoc = dim.__dimAssoc;
            if (!assoc.refs.some(Boolean)) continue;
            addReactor(dim.handle, assoc.handle);
            for (const ref of assoc.refs) if (ref) addReactor(ref.handle, assoc.handle);
        }
        const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
        const out = []; let section = null, hasObjects = false;
        const seen = new Set();
        const withReactors = rec => {
            let handle = '', handleEnd = 2, start = -1, end = -1;
            for (let k = 2; k + 1 < rec.length; k += 2) {
                if (rec[k].trim() === '5' && !handle) { handle = upper(rec[k + 1]); handleEnd = k + 2; }
                if (rec[k].trim() === '102' && rec[k + 1].trim() === '{ACAD_REACTORS') {
                    start = k;
                    for (let j = k + 2; j + 1 < rec.length; j += 2)
                        if (rec[j].trim() === '102' && rec[j + 1].trim() === '}') { end = j + 2; break; }
                    break;
                }
            }
            if (!handle) return rec;
            const wanted = reactors.get(handle) || new Set();
            const existing = [];
            if (start >= 0 && end > start) for (let k = start + 2; k + 1 < end - 2; k += 2)
                if (rec[k].trim() === '330') existing.push(upper(rec[k + 1]));
            const next = [...existing.filter(h => !managed.has(h) || wanted.has(h))];
            for (const h of wanted) if (!next.includes(h)) next.push(h);
            if (next.length === existing.length && next.every((h, i) => h === existing[i])) return rec;
            const group = next.length ? ['102','{ACAD_REACTORS',...next.flatMap(h => ['330',h]),'102','}'] : [];
            return start >= 0 && end > start
                ? [...rec.slice(0, start), ...group, ...rec.slice(end)]
                : [...rec.slice(0, handleEnd), ...group, ...rec.slice(handleEnd)];
        };
        for (let i = 0; i + 1 < lines.length;) {
            const code = lines[i].trim(), value = lines[i + 1].trim();
            if (code === '0' && value === 'SECTION') {
                section = lines[i + 3]?.trim().toUpperCase();
                if (section === 'OBJECTS') hasObjects = true;
                out.push(...lines.slice(i, i + 4)); i += 4; continue;
            }
            if (code === '0' && value === 'ENDSEC') {
                if (section === 'OBJECTS') for (const dim of live) {
                    const h = upper(dim.__dimAssoc.handle);
                    if (!seen.has(h)) out.push(...emitObject(dim));
                }
                out.push(lines[i], lines[i + 1]); section = null; i += 2; continue;
            }
            if (code === '0' && value === 'EOF' && !hasObjects && live.length) {
                out.push('0','SECTION','2','OBJECTS');
                for (const dim of live) out.push(...emitObject(dim));
                out.push('0','ENDSEC');
            }
            if (code === '0' && (section === 'OBJECTS' || section === 'ENTITIES')) {
                let j = i + 2;
                while (j + 1 < lines.length && lines[j].trim() !== '0') j += 2;
                const rec = lines.slice(i, j);
                if (section === 'OBJECTS' && value === 'DIMASSOC') {
                    const h = upper(rec[rec.findIndex((v,k) => k % 2 === 0 && v.trim() === '5') + 1]);
                    if (orphaned.has(h)) { i = j; continue; }
                    const dim = byAssoc.get(h);
                    if (dim) { seen.add(h); out.push(...emitObject(dim)); i = j; continue; }
                }
                out.push(...(section === 'ENTITIES' ? withReactors(rec) : rec)); i = j; continue;
            }
            out.push(lines[i], lines[i + 1]); i += 2;
        }
        let result = out.join('\n');
        if (live.some(e => e.__dimAssoc.refs.some(Boolean)) && !/\n9\n\$DIMASSOC\n/.test('\n' + result)) {
            const start = result.indexOf('0\nSECTION\n2\nHEADER\n');
            if (start >= 0) {
                const end = result.indexOf('0\nENDSEC', start);
                if (end >= 0) result = result.slice(0, end) + '9\n$DIMASSOC\n280\n2\n' + result.slice(end);
            } else result = '0\nSECTION\n2\nHEADER\n9\n$DIMASSOC\n280\n2\n0\nENDSEC\n' + result;
        }
        return result;
    }

    const DxfDimAssoc = { endpointRef, currentPoint, updateDimension, recover, emitObject, sync };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfDimAssoc;
    if (root) root.DxfDimAssoc = DxfDimAssoc;
})(typeof window !== 'undefined' ? window : null);
