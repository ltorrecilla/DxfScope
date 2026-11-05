/**
 * dxf-mleader.js — MULTILEADER (MLEADER) read, display geometry, edit, save;
 * plus the classic LEADER display details dxf-parser leaves out.
 *
 * dxf-parser drops MULTILEADER entirely, so it is read from the raw text. The
 * entity is a flat group-code stream split into nested sections by 30x codes:
 *
 *   common codes
 *   300 CONTEXT_DATA{        context codes (content, scale, text, block)
 *     302 LEADER{            landing 10, dogleg dir 11, length 40, breaks 12/13
 *       304 LEADER_LINE{     vertices 10, break index 90, breaks 11/12
 *       305 }
 *     303 }
 *   301 }
 *   common codes (leader type 170, colour 91, dogleg 291, arrow 342/42, ...)
 *
 * The same code means different things per section (304 is the text in the
 * context, a section marker in a leader). Context data wins over common.
 * Reference: Alan Thomas, "DXF LEADER and MULTILEADER" notes, and GDAL's
 * ogrdxf_leader.cpp, whose display rules are followed here.
 *
 * Editing never rebuilds the entity: syncBlock() rewrites only the point,
 * text values of the ORIGINAL raw block from the in-memory model, so every
 * code this module does not understand survives untouched.
 *
 * Pure, no DOM. window.DxfMLeader + Node exports.
 */
(function (root) {
    'use strict';

    const fin = Number.isFinite;
    const num = (v) => { const n = parseFloat(v); return fin(n) ? n : 0; };
    const int = (v) => { const n = parseInt(v, 10); return fin(n) ? n : 0; };
    const P = (x, y) => ({ x, y });

    // Arrowhead blocks that sit on the tip without length (GDAL list).
    const ZERO_LENGTH_ARROWS = new Set(['_ArchTick', '_DotSmall', '_Integral', '_None', '_Oblique', '_Small']);

    // ------------------------------------------------------------ raw helpers

    function rawLines(rawText) {
        return String(rawText || '').replace(/\r\n/g, '\n').split('\n');
    }

    /**
     * Walk ENTITIES and BLOCKS, calling visit(type, lines, key) for every
     * entity, where `lines` is the flat [code, value, ...] slice including the
     * leading "0 TYPE" pair and key follows the editor's raw indexing.
     */
    function walkEntities(rawText, visit, preparedLines = null) {
        const lines = preparedLines || rawLines(rawText);
        let i = 0, section = null, eIdx = 0, blockName = null, bIdx = 0;
        while (i < lines.length - 1) {
            const code = (lines[i] ?? '').trim();
            const value = (lines[i + 1] ?? '').trim();
            if (code === '0' && value.toUpperCase() === 'SECTION') {
                const c2 = (lines[i + 2] ?? '').trim();
                section = c2 === '2' ? (lines[i + 3] ?? '').trim().toUpperCase() : null;
                eIdx = 0; blockName = null;
                i += 4; continue;
            }
            if (code === '0' && value.toUpperCase() === 'ENDSEC') { section = null; i += 2; continue; }
            if ((section === 'ENTITIES' || section === 'BLOCKS') && code === '0') {
                const type = value.toUpperCase();
                let j = i + 2, name = null;
                while (j < lines.length - 1 && (lines[j] ?? '').trim() !== '0') {
                    if (type === 'BLOCK' && (lines[j] ?? '').trim() === '2' && name === null) name = (lines[j + 1] ?? '').trim();
                    j += 2;
                }
                let key = null;
                if (section === 'BLOCKS') {
                    if (type === 'BLOCK') { blockName = name; bIdx = 0; }
                    else if (type === 'ENDBLK') blockName = null;
                    else if (blockName !== null) key = `B:${blockName}:${bIdx++}`;
                } else key = `E:${eIdx++}`;
                if (key) visit(type, lines.slice(i, j), key, blockName);
                i = j; continue;
            }
            i += 2;
        }
    }

    /** BLOCK_RECORD handle → block name (MULTILEADER refers to blocks by handle). */
    function parseBlockRecordHandles(rawText, preparedLines = null) {
        const out = new Map();
        const lines = preparedLines || rawLines(rawText);
        for (let i = 0; i < lines.length - 1; i += 2) {
            if ((lines[i] ?? '').trim() !== '0' || (lines[i + 1] ?? '').trim() !== 'BLOCK_RECORD') continue;
            let h = '', n = '';
            for (let j = i + 2; j < lines.length - 1 && (lines[j] ?? '').trim() !== '0'; j += 2) {
                const c = (lines[j] ?? '').trim(), v = (lines[j + 1] ?? '').trim();
                if (c === '5' && !h) h = v.toUpperCase();
                else if (c === '2' && !n) n = v;
            }
            if (h && n) out.set(h, n);
        }
        return out;
    }

    /**
     * MULTILEADER colour (common 91, context 91/93): the raw signed 32-bit
     * value of AutoCAD's RGBM union. Top byte: C0 ByLayer, C1 ByBlock,
     * C2 true colour (low 24 bits), C3 ACI (low byte).
     */
    function decodeColor(raw) {
        if (raw === undefined || raw === null || raw === '') return { kind: 'bylayer' };
        const u = (int(raw) >>> 0);
        const m = (u >>> 24) & 0xff;
        if (m === 0xc1) return { kind: 'byblock' };
        if (m === 0xc2) return { kind: 'rgb', value: u & 0xffffff };
        if (m === 0xc3) {
            const aci = u & 0xff;
            if (aci === 0) return { kind: 'byblock' };
            if (aci === 256) return { kind: 'bylayer' };
            return { kind: 'aci', value: aci };
        }
        return { kind: 'bylayer' };
    }

    // ------------------------------------------------------------ the walker

    /**
     * Visit every group pair of a MULTILEADER block with its section:
     * fn(code, value, k, sec) where sec is 'common' | 'context' | 'leader' | 'line'
     * and k is the index of the code line in `lines`. Marker pairs are reported
     * with the section they open/close from.
     */
    function walkSections(lines, fn) {
        let sec = 'common';
        for (let k = 2; k < lines.length - 1; k += 2) {
            const c = (lines[k] ?? '').trim();
            const v = lines[k + 1] ?? '';
            fn(c, v, k, sec);
            if (sec === 'common' && c === '300') sec = 'context';
            else if (sec === 'context' && c === '301') sec = 'common';
            else if (sec === 'context' && c === '302') sec = 'leader';
            else if (sec === 'leader' && c === '303') sec = 'context';
            else if (sec === 'leader' && c === '304') sec = 'line';
            else if (sec === 'line' && c === '305') sec = 'leader';
        }
    }

    // ------------------------------------------------------------ parsing

    function emptyEntity() {
        return {
            type: 'MULTILEADER', handle: '', layer: '0', inPaperSpace: false,
            leaderType: 1, leaderColor: { kind: 'bylayer' }, dogleg: true,
            arrowSize: 0, arrowBlockHandle: '', contentType: 2, blockHandle: '',
            attribs: [],
            ctx: {
                scale: 1, contentBase: null, textHeight: 0, arrowSize: 0, landingGap: 0,
                hasText: false, text: '', textPos: null, textDir: null, textRotation: 0,
                textWidth: 0, textAttach: 1, textColor: { kind: 'bylayer' }, textStyleHandle: '',
                hasBlock: false, blockHandle: '', blockPos: null, blockScale: { x: 1, y: 1 },
                blockRotation: 0, blockColor: { kind: 'byblock' }, planeOrigin: null,
            },
            leaders: [],
        };
    }

    function parseMultileader(lines) {
        const e = emptyEntity();
        let leader = null, line = null, pendingAttr = null, breakVertex = 0, pt = null;
        let afterContext = false;   // attribute 330s only follow the context data
        walkSections(lines, (c, v, k, sec) => {
            const tv = String(v).trim();
            if (sec === 'common') {
                if (c === '300') afterContext = true;
                switch (c) {
                    case '5': if (!e.handle) e.handle = tv; break;
                    case '8': e.layer = tv; break;
                    case '6': e.lineType = tv; break;
                    case '62': e.colorIndex = int(tv); break;
                    case '420': e.trueColor = int(tv); break;
                    case '370': e.lineweight = int(tv); break;
                    case '67': e.inPaperSpace = int(tv) === 1; break;
                    case '410': e.layoutName = tv; break;
                    case '340': e.styleHandle = tv; break;
                    case '170': e.leaderType = int(tv); break;
                    case '91': e.leaderColor = decodeColor(tv); break;
                    case '291': e.dogleg = int(tv) !== 0; break;
                    case '41': e.doglegLength = num(tv); break;
                    case '342': e.arrowBlockHandle = tv.toUpperCase(); break;
                    case '42': e.arrowSize = num(tv); break;
                    case '172': e.contentType = int(tv); break;
                    case '344': e.blockHandle = tv.toUpperCase(); break;
                    case '330': if (afterContext) { pendingAttr = { handle: tv.toUpperCase(), index: 0, width: 0, value: '' }; } break;
                    case '177': if (pendingAttr) pendingAttr.index = int(tv); break;
                    case '44': if (pendingAttr) pendingAttr.width = num(tv); break;
                    case '302': if (pendingAttr) { pendingAttr.value = String(v); e.attribs.push(pendingAttr); pendingAttr = null; } break;
                }
                return;
            }
            const X = e.ctx;
            if (sec === 'context') {
                switch (c) {
                    case '40': X.scale = num(tv) || 1; break;
                    case '10': X.contentBase = X.contentBase || P(0, 0); X.contentBase.x = num(tv); break;
                    case '20': X.contentBase = X.contentBase || P(0, 0); X.contentBase.y = num(tv); break;
                    case '41': X.textHeight = num(tv); break;
                    case '140': X.arrowSize = num(tv); break;
                    case '145': X.landingGap = num(tv); break;
                    case '290': X.hasText = int(tv) !== 0; break;
                    case '304': X.text = String(v); break;
                    case '12': X.textPos = X.textPos || P(0, 0); X.textPos.x = num(tv); break;
                    case '22': X.textPos = X.textPos || P(0, 0); X.textPos.y = num(tv); break;
                    case '13': X.textDir = X.textDir || P(1, 0); X.textDir.x = num(tv); break;
                    case '23': X.textDir = X.textDir || P(1, 0); X.textDir.y = num(tv); break;
                    case '42': X.textRotation = num(tv); break;
                    case '43': X.textWidth = num(tv); break;
                    case '171': X.textAttach = int(tv) || 1; break;
                    case '91': X.textColor = decodeColor(tv); break;
                    case '340': X.textStyleHandle = tv.toUpperCase(); break;
                    case '296': X.hasBlock = int(tv) !== 0; break;
                    case '341': X.blockHandle = tv.toUpperCase(); break;
                    case '15': X.blockPos = X.blockPos || P(0, 0); X.blockPos.x = num(tv); break;
                    case '25': X.blockPos = X.blockPos || P(0, 0); X.blockPos.y = num(tv); break;
                    case '16': X.blockScale.x = num(tv) || 1; break;
                    case '26': X.blockScale.y = num(tv) || 1; break;
                    case '46': X.blockRotation = num(tv); break;
                    case '93': X.blockColor = decodeColor(tv); break;
                    case '110': X.planeOrigin = X.planeOrigin || P(0, 0); X.planeOrigin.x = num(tv); break;
                    case '120': X.planeOrigin = X.planeOrigin || P(0, 0); X.planeOrigin.y = num(tv); break;
                    case '302': leader = { landing: P(0, 0), doglegDir: P(0, 0), doglegLength: 0, doglegBreaks: [], lines: [] }; break;
                }
                return;
            }
            if (sec === 'leader') {
                switch (c) {
                    case '10': leader.landing.x = num(tv); break;
                    case '20': leader.landing.y = num(tv); break;
                    case '11': leader.doglegDir.x = num(tv); break;
                    case '21': leader.doglegDir.y = num(tv); break;
                    case '40': leader.doglegLength = num(tv); break;
                    case '12': pt = [P(num(tv), 0), P(0, 0)]; break;
                    case '22': if (pt) pt[0].y = num(tv); break;
                    case '13': if (pt) pt[1].x = num(tv); break;
                    case '23': if (pt) { pt[1].y = num(tv); leader.doglegBreaks.push(pt); pt = null; } break;
                    case '304': line = { vertices: [], breaks: [] }; breakVertex = 0; break;
                    case '303': e.leaders.push(leader); leader = null; break;
                }
                return;
            }
            if (sec === 'line') {
                switch (c) {
                    case '10': line.vertices.push(P(num(tv), 0)); break;
                    case '20': if (line.vertices.length) line.vertices[line.vertices.length - 1].y = num(tv); break;
                    case '90': breakVertex = int(tv); break;
                    case '11': pt = [P(num(tv), 0), P(0, 0)]; break;
                    case '21': if (pt) pt[0].y = num(tv); break;
                    case '12': if (pt) pt[1].x = num(tv); break;
                    case '22': if (pt) { pt[1].y = num(tv); line.breaks.push({ index: breakVertex, a: pt[0], b: pt[1] }); pt = null; } break;
                    case '305': leader.lines.push(line); line = null; break;
                }
            }
        });
        return e;
    }

    /**
     * Every MULTILEADER in the file: { entities: [...], blocks: { name: [...] } }.
     * Each carries __rawKey (editor indexing) and __rawBlock (its raw lines, for
     * copies).
     */
    function parseRawMultileaders(rawText, preparedLines = null) {
        const out = { entities: [], blocks: {} };
        walkEntities(rawText, (type, lines, key, blockName) => {
            if (type !== 'MULTILEADER' && type !== 'MLEADER') return;
            const e = parseMultileader(lines);
            e.__rawKey = key;
            e.__rawBlock = lines;
            if (key.startsWith('B:')) (out.blocks[blockName] || (out.blocks[blockName] = [])).push(e);
            else out.entities.push(e);
        }, preparedLines);
        return out;
    }

    // ------------------------------------------------------------ display

    // Hermite-blended curve through pts; endTangent (unit) bends the last span.
    function splineThrough(pts, endTangent) {
        const p = [];
        for (const q of pts) { const l = p[p.length - 1]; if (!l || Math.hypot(q.x - l.x, q.y - l.y) > 1e-12) p.push(q); }
        if (p.length < 3 && !endTangent) return p;
        if (p.length < 2) return p;
        const n = p.length;
        const tan = [];
        for (let i = 0; i < n; i++) {
            const a = p[Math.max(0, i - 1)], b = p[Math.min(n - 1, i + 1)];
            tan.push(P((b.x - a.x) / (i === 0 || i === n - 1 ? 1 : 2), (b.y - a.y) / (i === 0 || i === n - 1 ? 1 : 2)));
        }
        if (endTangent) {
            const L = Math.hypot(p[n - 1].x - p[n - 2].x, p[n - 1].y - p[n - 2].y);
            tan[n - 1] = P(endTangent.x * L, endTangent.y * L);
        }
        const out = [p[0]];
        const S = 16;
        for (let i = 0; i < n - 1; i++) {
            const a = p[i], b = p[i + 1], ta = tan[i], tb = tan[i + 1];
            for (let s = 1; s <= S; s++) {
                const t = s / S, t2 = t * t, t3 = t2 * t;
                const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
                out.push(P(h00 * a.x + h10 * ta.x + h01 * b.x + h11 * tb.x, h00 * a.y + h10 * ta.y + h01 * b.y + h11 * tb.y));
            }
        }
        return out;
    }

    /**
     * Display geometry in world coordinates:
     *   { polylines: [[{x,y}...]], arrows: [{tip, dir, size, blockName}],
     *     text: {...}|null, block: {...}|null }
     * opts.blockNameByHandle: Map handle → block name.
     */
    function geometry(e, opts) {
        const o = opts || {};
        const names = o.blockNameByHandle || new Map();
        const X = e.ctx;
        const scale = X.scale || 1;
        const arrowSize = X.arrowSize > 0 ? X.arrowSize : (e.arrowSize || 0) * scale;
        const arrowBlock = e.arrowBlockHandle ? (names.get(e.arrowBlockHandle) || '') : '';
        const blockName = (X.blockHandle || e.blockHandle) ? (names.get(X.blockHandle || e.blockHandle) || '') : '';
        const out = { polylines: [], arrows: [], text: null, block: null };
        const spline = e.leaderType === 2;
        if (e.leaderType !== 0) {
            for (const L of e.leaders) {
                const dlen = L.doglegLength;
                const hasDir = L.doglegDir.x !== 0 || L.doglegDir.y !== 0;
                const showDogleg = e.dogleg && !spline && dlen !== 0 && hasDir;
                const doglegEnd = P(L.landing.x + L.doglegDir.x * dlen, L.landing.y + L.doglegDir.y * dlen);
                const landing = (!e.dogleg || spline) ? doglegEnd : P(L.landing.x, L.landing.y);
                for (const line of L.lines) {
                    const vs = line.vertices;
                    if (!vs.length) continue;
                    const second = vs.length > 1 ? vs[1] : landing;
                    let start = P(vs[0].x, vs[0].y);
                    // Arrowhead: AutoCAD draws it only when it fits in half the first segment.
                    const seg = Math.hypot(second.x - start.x, second.y - start.y);
                    if (arrowSize > 0 && seg > 0 && arrowSize <= 0.5 * seg && arrowBlock !== '_None') {
                        const dir = P((second.x - start.x) / seg, (second.y - start.y) / seg);
                        out.arrows.push({ tip: P(start.x, start.y), dir, size: arrowSize, blockName: arrowBlock || null });
                        if (!ZERO_LENGTH_ARROWS.has(arrowBlock)) start = P(start.x + dir.x * arrowSize, start.y + dir.y * arrowSize);
                    }
                    if (spline) {
                        const pts = [start, ...vs.slice(1).map(v => P(v.x, v.y)), landing];
                        const tanDir = blockName ? null : (hasDir ? (() => { const l = Math.hypot(L.doglegDir.x, L.doglegDir.y); return P(L.doglegDir.x / l, L.doglegDir.y / l); })() : null);
                        out.polylines.push(splineThrough(pts, tanDir));
                        continue;
                    }
                    let run = [start];
                    for (let i = 0; i < vs.length; i++) {
                        if (i > 0) run.push(P(vs[i].x, vs[i].y));
                        for (const br of line.breaks) {
                            if (br.index !== i) continue;
                            run.push(P(br.a.x, br.a.y));
                            out.polylines.push(run);
                            run = [P(br.b.x, br.b.y)];
                        }
                    }
                    run.push(landing);
                    out.polylines.push(run);
                }
                if (showDogleg) {
                    let run = [P(L.landing.x, L.landing.y)];
                    for (const [a, b] of L.doglegBreaks) { run.push(P(a.x, a.y)); out.polylines.push(run); run = [P(b.x, b.y)]; }
                    run.push(doglegEnd);
                    out.polylines.push(run);
                }
            }
        }
        const hasText = X.hasText && X.textPos && String(X.text).trim() !== '';
        if (hasText) {
            out.text = {
                text: X.text, position: P(X.textPos.x, X.textPos.y),
                height: X.textHeight || (4 * scale), rotationDeg: X.textRotation * 180 / Math.PI,
                // Context 171: 1 left, 2 centre, 3 right; MTEXT top row (GDAL).
                attachmentPoint: Math.min(3, Math.max(1, X.textAttach || 1)),
                width: X.textWidth || 0, color: X.textColor,
            };
        }
        if (blockName && X.blockPos && e.contentType === 1) {
            out.block = {
                name: blockName, position: P(X.blockPos.x, X.blockPos.y),
                xScale: (X.blockScale.x || 1) * scale, yScale: (X.blockScale.y || 1) * scale,
                rotationDeg: X.blockRotation * 180 / Math.PI, color: X.blockColor,
            };
        }
        return out;
    }

    // Colour fields for a child renderable.
    function colorFields(c, parent) {
        if (!c || c.kind === 'bylayer') return {};
        if (c.kind === 'byblock') {
            const f = {};
            if (fin(parent.colorIndex)) f.colorIndex = parent.colorIndex;
            if (fin(parent.trueColor)) f.trueColor = parent.trueColor;
            return f;
        }
        if (c.kind === 'aci') return { colorIndex: c.value };
        if (c.kind === 'rgb') return { trueColor: c.value };
        return {};
    }

    /**
     * Child renderables the host draws in place of the MULTILEADER: LWPOLYLINE
     * leader lines, wide 2-vertex LWPOLYLINE arrows (needs dxf_wide rendering),
     * INSERT arrow blocks, an MTEXT, an INSERT for block content with its
     * attribute values as ATTRIBs in world coordinates (__skipAttdefs tells the
     * host not to draw the block's own ATTDEF tags).
     * opts: { blockNameByHandle, getBlock(name) → {entities, position} }
     */
    function children(e, opts) {
        const o = opts || {};
        const g = geometry(e, o);
        const base = { layer: e.layer || '0' };
        if (e.lineType) base.lineType = e.lineType;
        const lineColor = colorFields(e.leaderColor, e);
        const out = [];
        for (const pl of g.polylines) {
            if (pl.length < 2) continue;
            out.push({ type: 'LWPOLYLINE', ...base, ...lineColor, shape: false, vertices: pl.map(p => ({ x: p.x, y: p.y })) });
        }
        for (const a of g.arrows) {
            if (a.blockName && o.getBlock && o.getBlock(a.blockName)) {
                out.push({ type: 'INSERT', ...base, ...lineColor, name: a.blockName,
                    position: { x: a.tip.x, y: a.tip.y, z: 0 }, xScale: a.size, yScale: a.size,
                    rotation: Math.atan2(a.dir.y, a.dir.x) * 180 / Math.PI + 180 });
                continue;
            }
            // Default arrowhead: filled triangle, length = size, base = size / 3.
            out.push({ type: 'LWPOLYLINE', ...base, ...lineColor, shape: false, vertices: [
                { x: a.tip.x, y: a.tip.y, startWidth: 0, endWidth: a.size / 3 },
                { x: a.tip.x + a.dir.x * a.size, y: a.tip.y + a.dir.y * a.size },
            ] });
        }
        if (g.text) {
            const t = g.text;
            out.push({ type: 'MTEXT', ...base, ...colorFields(t.color, e), text: t.text,
                position: { x: t.position.x, y: t.position.y, z: 0 }, height: t.height, textHeight: t.height,
                rotation: t.rotationDeg, attachmentPoint: t.attachmentPoint, width: t.width,
                // Anchor = top of the first line (the attachment row is always "top").
                valign: 3 });
        }
        if (g.block) {
            const b = g.block;
            const ins = { type: 'INSERT', ...base, ...colorFields(b.color, e), name: b.name,
                position: { x: b.position.x, y: b.position.y, z: 0 }, xScale: b.xScale, yScale: b.yScale,
                rotation: b.rotationDeg, __skipAttdefs: true, attributes: [] };
            const def = o.getBlock ? o.getBlock(b.name) : null;
            if (def && e.attribs.length) {
                const bp = def.position || { x: 0, y: 0 };
                const r = b.rotationDeg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
                const map = (p) => {
                    const lx = (p.x - bp.x) * b.xScale, ly = (p.y - bp.y) * b.yScale;
                    return { x: b.position.x + lx * cs - ly * sn, y: b.position.y + lx * sn + ly * cs, z: 0 };
                };
                for (const at of e.attribs) {
                    const d = (def.entities || []).find(x => x && x.type === 'ATTDEF' && String(x.handle || '').toUpperCase() === at.handle);
                    if (!d) continue;
                    const a = { ...d, type: 'ATTRIB', text: at.value, layer: (d.layer && d.layer !== '0') ? d.layer : base.layer };
                    for (const f of ['startPoint', 'endPoint', 'position']) if (d[f] && fin(d[f].x)) a[f] = map(d[f]);
                    const s = Math.abs(b.yScale) || 1;
                    if (fin(d.textHeight)) a.textHeight = d.textHeight * s;
                    if (fin(d.height)) a.height = d.height * s;
                    a.rotation = (Number(d.rotation) || 0) + b.rotationDeg;
                    delete a.handle;
                    ins.attributes.push(a);
                }
            }
            out.push(ins);
        }
        return out;
    }

    // ------------------------------------------------------------ editing

    function shift(p, dx, dy) { if (p) { p.x += dx; p.y += dy; } }

    /** Move the whole entity. */
    function translate(e, dx, dy) {
        moveContent(e, dx, dy);
        for (const L of e.leaders) for (const ln of L.lines) {
            for (const v of ln.vertices) shift(v, dx, dy);
            for (const b of ln.breaks) { shift(b.a, dx, dy); shift(b.b, dx, dy); }
        }
        e.__mlChildren = null;
    }

    /** Move content + landing/dogleg; leader line vertices (arrow tips) stay. */
    function moveContent(e, dx, dy) {
        const X = e.ctx;
        for (const p of [X.contentBase, X.textPos, X.blockPos, X.planeOrigin]) shift(p, dx, dy);
        for (const L of e.leaders) {
            shift(L.landing, dx, dy);
            for (const [a, b] of L.doglegBreaks) { shift(a, dx, dy); shift(b, dx, dy); }
        }
        e.__mlChildren = null;
    }

    /** Leader line arrow tips, for grips: [{leader, line, x, y}]. */
    function arrowTips(e) {
        const out = [];
        e.leaders.forEach((L, li) => L.lines.forEach((ln, lj) => {
            if (ln.vertices.length) out.push({ leader: li, line: lj, x: ln.vertices[0].x, y: ln.vertices[0].y });
        }));
        return out;
    }

    function setArrowTip(e, li, lj, p) {
        const v = e.leaders[li]?.lines[lj]?.vertices[0];
        if (!v) return false;
        v.x = p.x; v.y = p.y;
        e.__mlChildren = null;
        return true;
    }

    /** Content grip position: text anchor, else block insertion, else landing. */
    function contentPoint(e) {
        const X = e.ctx;
        if (X.hasText && X.textPos) return { x: X.textPos.x, y: X.textPos.y };
        if (X.blockPos && (X.blockHandle || e.blockHandle)) return { x: X.blockPos.x, y: X.blockPos.y };
        const L = e.leaders[0];
        return L ? { x: L.landing.x, y: L.landing.y } : (X.contentBase ? { ...X.contentBase } : null);
    }

    function getText(e) { return e.ctx.hasText ? e.ctx.text : ''; }
    function setText(e, t) { e.ctx.text = String(t ?? ''); e.__mlChildren = null; }

    const fmt = (v) => String(Math.round(Number(v) * 1e10) / 1e10);

    /**
     * Rewrite a raw MULTILEADER block from the model: every point the model
     * holds (content, text, block, plane origin, landings, dogleg breaks, line
     * vertices, line breaks) and the text (context 304). Nothing else changes.
     */
    function syncBlock(lines, e) {
        const out = lines.slice();
        const X = e.ctx;
        let li = -1, lj = -1, vi = 0, bi = 0, dbi = 0;
        // Unchanged values keep their original text (byte-identical save).
        const set = (k, v) => { if (fin(v) && num(String(out[k + 1]).trim()) !== v) out[k + 1] = fmt(v); };
        walkSections(lines, (c, v, k, sec) => {
            if (sec === 'context') {
                if (c === '10' && X.contentBase) set(k, X.contentBase.x);
                else if (c === '20' && X.contentBase) set(k, X.contentBase.y);
                else if (c === '12' && X.textPos) set(k, X.textPos.x);
                else if (c === '22' && X.textPos) set(k, X.textPos.y);
                else if (c === '15' && X.blockPos) set(k, X.blockPos.x);
                else if (c === '25' && X.blockPos) set(k, X.blockPos.y);
                else if (c === '110' && X.planeOrigin) set(k, X.planeOrigin.x);
                else if (c === '120' && X.planeOrigin) set(k, X.planeOrigin.y);
                else if (c === '304') out[k + 1] = String(X.text ?? '');
                else if (c === '302') { li++; lj = -1; dbi = 0; }
                return;
            }
            const L = e.leaders[li];
            if (sec === 'leader' && L) {
                if (c === '10') set(k, L.landing.x);
                else if (c === '20') set(k, L.landing.y);
                else if (c === '12') set(k, L.doglegBreaks[dbi]?.[0].x);
                else if (c === '22') set(k, L.doglegBreaks[dbi]?.[0].y);
                else if (c === '13') set(k, L.doglegBreaks[dbi]?.[1].x);
                else if (c === '23') { set(k, L.doglegBreaks[dbi]?.[1].y); dbi++; }
                else if (c === '304') { lj++; vi = 0; bi = 0; }
                return;
            }
            const ln = L?.lines[lj];
            if (sec === 'line' && ln) {
                if (c === '10') set(k, ln.vertices[vi]?.x);
                else if (c === '20') { set(k, ln.vertices[vi]?.y); vi++; }
                else if (c === '11') set(k, ln.breaks[bi]?.a.x);
                else if (c === '21') set(k, ln.breaks[bi]?.a.y);
                else if (c === '12') set(k, ln.breaks[bi]?.b.x);
                else if (c === '22') { set(k, ln.breaks[bi]?.b.y); bi++; }
            }
        });
        return out;
    }

    /**
     * Raw lines for a COPY: synced from the model, new handle and layer, and
     * without the ownership links that must stay unique (102 reactor/xdict
     * groups, 360 extension dictionary).
     */
    function copyBlock(e, handle, layer) {
        const src = syncBlock(e.__rawBlock || [], e);
        const out = [src[0], src[1]];
        let inGroup = false;
        for (let k = 2; k < src.length - 1; k += 2) {
            const c = (src[k] ?? '').trim(), v = (src[k + 1] ?? '').trim();
            if (c === '102') { inGroup = v.startsWith('{') ? true : (v === '}' ? false : inGroup); continue; }
            if (inGroup) continue;
            if (c === '360') continue;
            if (c === '5') { out.push(src[k], String(handle)); continue; }
            if (c === '8' && layer) { out.push(src[k], String(layer)); continue; }
            out.push(src[k], src[k + 1]);
        }
        if (!out.some((x, k) => k % 2 === 0 && String(x).trim() === '5')) out.splice(2, 0, '5', String(handle));
        return out;
    }

    /** Deep copy keeping __rawBlock (cloneEntityData drops __ fields). */
    function clone(e) {
        const c = JSON.parse(JSON.stringify({ ...e, __mlChildren: undefined, __rawBlock: undefined, __sourceEntity: undefined }));
        c.__rawBlock = (e.__rawBlock || []).slice();
        return c;
    }

    // ------------------------------------------------------------ creation (option B)

    /**
     * Styles needed to write a MULTILEADER AutoCAD will accept: an MLEADERSTYLE
     * (mandatory owner of the look) and a text STYLE. Null when the file has no
     * MLEADERSTYLE — the host then keeps making LEADER + MTEXT.
     */
    function findCreationStyles(rawText, preparedLines = null) {
        const lines = preparedLines || rawLines(rawText);
        let mls = null, mlsStandard = null, txt = null, txtStandard = null, ltByBlock = null;
        for (let i = 0; i < lines.length - 1; i += 2) {
            if ((lines[i] ?? '').trim() !== '0') continue;
            const t = (lines[i + 1] ?? '').trim();
            if (t !== 'MLEADERSTYLE' && t !== 'STYLE' && t !== 'LTYPE') continue;
            let h = '', name = '', desc = '';
            for (let j = i + 2; j < lines.length - 1 && (lines[j] ?? '').trim() !== '0'; j += 2) {
                const c = (lines[j] ?? '').trim(), v = (lines[j + 1] ?? '').trim();
                if (c === '5' && !h) h = v;
                else if (c === '2' && !name) name = v;
                else if (c === '3' && !desc) desc = v;
            }
            if (!h) continue;
            if (t === 'LTYPE') { if (/^byblock$/i.test(name)) ltByBlock = h; continue; }
            if (t === 'MLEADERSTYLE') { if (!mls) mls = h; if (/standard/i.test(desc || name)) mlsStandard = mlsStandard || h; }
            else { if (!txt) txt = h; if (/^standard$/i.test(name)) txtStandard = txtStandard || h; }
        }
        // MLEADERSTYLE names live in the ACAD_MLEADERSTYLE dictionary; prefer "Standard".
        const dict = /ACAD_MLEADERSTYLE/.test(rawText) ? rawText : '';
        if (dict) {
            const m = String(rawText).replace(/\r\n/g, '\n').match(/\n\s*3\n\s*Standard\n\s*350\n\s*([0-9A-Fa-f]+)\n/);
            if (m) mlsStandard = mlsStandard || m[1];
        }
        const style = mlsStandard || mls;
        if (!style || !(txtStandard || txt)) return null;
        return { styleHandle: style, textStyleHandle: txtStandard || txt, lineTypeHandle: ltByBlock };
    }

    /**
     * A new MULTILEADER: one leader, one straight line, text content. points
     * run from the arrow tip to the landing; the dogleg runs from the landing
     * toward the text side. Group layout follows AutoCAD's own output.
     */
    function emitMultileader(o) {
        const pts = (o.points || []).filter(p => fin(p.x) && fin(p.y));
        if (pts.length < 2) return [];
        const h = o.textHeight > 0 ? o.textHeight : 2.5;
        const arrow = o.arrowSize > 0 ? o.arrowSize : h;
        const landing = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        const side = landing.x >= prev.x ? 1 : -1;
        const dogLen = o.doglegLength > 0 ? o.doglegLength : h * 2;
        const gap = h * 0.5;
        const end = { x: landing.x + side * dogLen, y: landing.y };
        const textPos = { x: end.x + side * gap, y: end.y + h / 2 };
        const attach = side > 0 ? 1 : 3;
        const n = fmt;
        const out = ['0', 'MULTILEADER', '5', String(o.handle)];
        if (o.paperSpace) { out.push('67', '1'); if (o.layoutName) out.push('410', String(o.layoutName)); }
        out.push('100', 'AcDbEntity', '8', String(o.layer || '0'));
        if (fin(o.colorIndex)) out.push('62', String(o.colorIndex));
        out.push('100', 'AcDbMLeader', '270', '2',
            '300', 'CONTEXT_DATA{',
            '40', '1', '10', n(end.x), '20', n(end.y), '30', '0',
            '41', n(h), '140', n(arrow), '145', n(gap),
            '174', '1', '175', '1', '176', '0', '177', '0',
            '290', '1', '304', String(o.text ?? ''),
            '11', '0', '21', '0', '31', '1', '340', String(o.textStyleHandle),
            '12', n(textPos.x), '22', n(textPos.y), '32', '0',
            '13', '1', '23', '0', '33', '0',
            '42', '0', '43', '0', '44', '0', '45', '1',
            '170', '1', '90', '-1073741824', '171', String(attach), '172', '5',
            '91', '-1073741824', '141', '0', '92', '0',
            '291', '0', '292', '0', '173', '0', '293', '0',
            '142', '0', '143', '0', '294', '0', '295', '0', '296', '0',
            '110', n(end.x), '120', n(end.y), '130', '0',
            '111', '1', '121', '0', '131', '0',
            '112', '0', '122', '1', '132', '0',
            '297', '0',
            '302', 'LEADER{', '290', '1', '291', '1',
            '10', n(landing.x), '20', n(landing.y), '30', '0',
            '11', String(side), '21', '0', '31', '0',
            '90', '0', '40', n(dogLen),
            '304', 'LEADER_LINE{');
        for (let i = 0; i < pts.length - 1; i++) out.push('10', n(pts[i].x), '20', n(pts[i].y), '30', '0');
        out.push('91', '0', '305', '}', '271', '0', '303', '}',
            '272', '9', '273', '9', '301', '}',
            '340', String(o.styleHandle), '90', '330752',
            '170', '1', '91', '-1056964608',
            ...(o.lineTypeHandle ? ['341', String(o.lineTypeHandle)] : []),   // leader linetype: ByBlock
            '171', '-2',
            '290', '1', '291', '1', '41', n(dogLen), '42', n(arrow),
            '172', '2', '343', String(o.textStyleHandle), '173', '1',
            '95', '1', '174', '1', '175', '0', '92', '-1056964608',
            '292', '0', '93', '-1056964608', '10', '1', '20', '1', '30', '1',
            '43', '0', '176', '0', '293', '0', '294', '0', '178', '0', '179', '1',
            '45', n(h), '271', '0', '272', '9', '273', '9', '295', '0');
        return out;
    }

    // ------------------------------------------------------------ classic LEADER

    /** DIMSTYLE table: name (upper) → { DIMTAD, DIMGAP, DIMSCALE, DIMASZ }. */
    function parseRawDimStyles(rawText, preparedLines = null) {
        const out = new Map();
        const lines = preparedLines || rawLines(rawText);
        for (let i = 0; i < lines.length - 1; i += 2) {
            if ((lines[i] ?? '').trim() !== '0' || (lines[i + 1] ?? '').trim() !== 'DIMSTYLE') continue;
            const s = {};
            let name = '';
            for (let j = i + 2; j < lines.length - 1 && (lines[j] ?? '').trim() !== '0'; j += 2) {
                const c = (lines[j] ?? '').trim(), v = (lines[j + 1] ?? '').trim();
                if (c === '2' && !name) name = v;
                else if (c === '77') s.DIMTAD = int(v);
                else if (c === '147') s.DIMGAP = num(v);
                else if (c === '40') s.DIMSCALE = num(v);
                else if (c === '41') s.DIMASZ = num(v);
            }
            if (name) out.set(name.toUpperCase(), s);
        }
        return out;
    }

    /**
     * LEADER codes dxf-parser does not keep: 3 dimstyle, 71 arrow flag, 72 path
     * type (1 = spline), 73 creation (0 = text), 74 hook direction flip,
     * 41 annotation width, 211/221 horizontal direction, and DSTYLE overrides
     * in ACAD xdata (1070 code + value). Map rawKey → extras.
     */
    function parseRawLeaderExtras(rawText, preparedLines = null) {
        const out = new Map();
        walkEntities(rawText, (type, lines, key) => {
            if (type !== 'LEADER') return;
            const x = { dimstyle: '', arrow: 1, pathType: 0, creation: 3, flip: 0, textWidth: 0, hdir: { x: 1, y: 0 }, overrides: {} };
            let inAcad = false, pendingCode = null;
            for (let k = 2; k < lines.length - 1; k += 2) {
                const c = (lines[k] ?? '').trim(), v = (lines[k + 1] ?? '').trim();
                if (c === '1001') { inAcad = v === 'ACAD'; continue; }
                if (inAcad) {
                    if (c === '1070' && pendingCode === null) { pendingCode = int(v); continue; }
                    if (pendingCode !== null && (c === '1070' || c === '1040' || c === '1005')) {
                        const name = { 77: 'DIMTAD', 147: 'DIMGAP', 40: 'DIMSCALE', 41: 'DIMASZ' }[pendingCode];
                        if (name) x.overrides[name] = num(v);
                        pendingCode = null; continue;
                    }
                    if (c === '1000' || c === '1002') { pendingCode = null; continue; }
                    continue;
                }
                switch (c) {
                    case '3': x.dimstyle = v; break;
                    case '71': x.arrow = int(v); break;
                    case '72': x.pathType = int(v); break;
                    case '73': x.creation = int(v); break;
                    case '74': x.flip = int(v); break;
                    case '41': x.textWidth = num(v); break;
                    case '211': x.hdir.x = num(v); break;
                    case '221': x.hdir.y = num(v); break;
                }
            }
            out.set(key, x);
        }, preparedLines);
        return out;
    }

    /**
     * Displayed path of a classic LEADER: spline when 72 = 1, plus AutoCAD's
     * hook line under the text when DIMTAD ≠ 0 (not stored in the file):
     *   end = last vertex + (DIMGAP × DIMSCALE + annotation width) × direction.
     * style: merged dimstyle values { DIMTAD, DIMGAP, DIMSCALE }.
     */
    function leaderDisplayPoints(vertices, extras, style) {
        let pts = (vertices || []).filter(v => v && fin(v.x) && fin(v.y)).map(v => P(v.x, v.y));
        if (!extras || pts.length < 2) return pts;
        const s = { DIMTAD: 0, DIMGAP: 0.625, DIMSCALE: 1, ...(style || {}), ...(extras.overrides || {}) };
        const scale = s.DIMSCALE || 1;
        let dir = P(extras.hdir.x || 1, extras.hdir.y || 0);
        const dl = Math.hypot(dir.x, dir.y) || 1;
        dir = P(dir.x / dl, dir.y / dl);
        if (extras.flip === 1) dir = P(-dir.x, -dir.y);
        const hasText = extras.creation === 0;
        if (extras.pathType === 1) pts = splineThrough(pts, hasText ? dir : null);
        if (s.DIMTAD > 0 && hasText && extras.textWidth > 0) {
            const last = pts[pts.length - 1];
            const len = s.DIMGAP * scale + extras.textWidth;
            pts.push(P(last.x + dir.x * len, last.y + dir.y * len));
        }
        return pts;
    }

    const DxfMLeader = {
        parseRawMultileaders, parseMultileader, parseBlockRecordHandles, decodeColor,
        geometry, children, translate, moveContent, arrowTips, setArrowTip, contentPoint,
        getText, setText, syncBlock, copyBlock, clone,
        findCreationStyles, emitMultileader,
        parseRawDimStyles, parseRawLeaderExtras, leaderDisplayPoints, splineThrough,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfMLeader;
    if (root) root.DxfMLeader = DxfMLeader;
})(typeof window !== 'undefined' ? window : null);
