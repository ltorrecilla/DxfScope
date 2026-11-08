/**
 * dxf-plotstyle.js — color-dependent (CTB) and named (STB) plot styles.
 *
 * A CTB table has 255 styles, one per ACI colour (style i ↔ ACI i+1). Each
 * style can replace the plotted colour, screen it towards white, turn it to
 * grey, and set a fixed pen width (lineweight index into the table's 27
 * weights; index 0 = "use object lineweight").
 *
 *   ACI_RGB[i]            AutoCAD colour of ACI i (0..255), classic palette
 *                         (same table as dxf-parser: 250..255 = 51,91,132,173,214,255 grey)
 *   aciToRgb(i), nearestAci(rgb)
 *   LINEWEIGHTS           default custom_lineweight_table (mm)
 *   newTable(name, desc)  all "use object" styles (= acad.ctb)
 *   builtin(name), BUILTIN_NAMES
 *       acad.ctb, monochrome.ctb, grayscale.ctb,
 *       Screening 25%.ctb, Screening 50%.ctb, Screening 75%.ctb, Screening 100%.ctb
 *   resolve(table, { aci, rgb, lwMm }) → { rgb, lwMm }
 *       aci: 1..255 of the object (null for true colour → nearest ACI style)
 *       rgb: object's display colour; lwMm: object lineweight (mm) or null
 *       Object colour ACI 7 / white plots black (paper is white).
 *   parseCtbText(text) / writeCtbText(table)     the decompressed CTB body
 *   decodeCtb(bytes, inflate) → Promise<table>   whole .ctb file
 *   encodeCtb(table, deflate) → Promise<Uint8Array>
 *       inflate/deflate: zlib (RFC 1950) functions, sync or async;
 *       browser: DxfPlotStyle.browserInflate / browserDeflate.
 *
 * STB tables have kind='stb' and a variable list of named styles, including
 * protected Normal. resolve() accepts styleName; the binary/text codec APIs
 * retain their historical Ctb names and handle both formats. Extra imported
 * properties are retained for export. DXF assignments live in dxf-plotstyle-names.
 * window.DxfPlotStyle + Node exports.
 */
(function (root) {
    'use strict';

    const ACI_RGB = (typeof module === 'object' && module.exports ? require('./dxf-color.js') : globalThis.DxfColor).ACI_RGB;

    const LINEWEIGHTS = [0.00, 0.05, 0.09, 0.10, 0.13, 0.15, 0.18, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.53,
        0.60, 0.65, 0.70, 0.80, 0.90, 1.00, 1.06, 1.20, 1.40, 1.58, 2.00, 2.11];

    // Plot style codes (acadctb).
    const OBJECT_LINETYPE = 31, FILL_OBJECT = 73, END_OBJECT = 4, JOIN_OBJECT = 5, AUTOMATIC = 0;
    const POLICY_DITHER = 1, POLICY_GRAY = 2;
    const HEADER = 'PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec';

    function aciToRgb(i) { return ACI_RGB[Math.max(0, Math.min(255, i | 0))]; }

    function nearestAci(rgb) {
        const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
        let best = 7, bd = Infinity;
        for (let i = 1; i < 256; i++) {
            const c = ACI_RGB[i];
            const dr = ((c >> 16) & 255) - r, dg = ((c >> 8) & 255) - g, db = (c & 255) - b;
            const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
            if (d < bd) { bd = d; best = i; if (!d) break; }
        }
        return best;
    }

    const colorName = (i) => 'Color_' + (i + 1);

    function newStyle(i) {
        return {
            name: colorName(i), localizedName: colorName(i), description: '',
            color: null,               // null = use object colour, else 0xRRGGBB
            colorAci: null,            // ACI when the file stored an ACI colour
            dithering: true, grayscale: false,
            physicalPen: AUTOMATIC, virtualPen: AUTOMATIC,
            screen: 100, linepatternSize: 0.5,
            linetype: OBJECT_LINETYPE, adaptiveLinetype: true,
            lineweight: 0,             // index into table.lineweights, 0 = object
            fillStyle: FILL_OBJECT, endStyle: END_OBJECT, joinStyle: JOIN_OBJECT,
        };
    }

    function newTable(name, description, kind = /\.stb$/i.test(name || '') ? 'stb' : 'ctb') {
        const styles = [];
        for (let i = 0; i < (kind === 'stb' ? 1 : 255); i++) styles.push(newStyle(i));
        if (kind === 'stb') Object.assign(styles[0], { name: 'Normal', localizedName: 'Normal' });
        return {
            kind,
            name: name || (kind === 'stb' ? 'acad.stb' : 'acad.ctb'), description: description || '',
            scaleFactor: 1.0, applyFactor: false, lineweightUnits: 0,
            lineweights: LINEWEIGHTS.slice(), styles,
        };
    }

    function toNamedTable(table, name) {
        validate(table);
        if (table.kind === 'stb') throw new Error('Expected a CTB table');
        const result = clone(table);
        result.kind = 'stb'; result.name = name || table.name.replace(/\.ctb$/i, '-named.stb');
        result.styles = [newTable('acad.stb').styles[0], ...table.styles.map((style, i) => ({
            ...clone(style), name: colorName(i), localizedName: colorName(i),
        }))];
        // STB widths are absolute. Bake the CTB scale into the weight table.
        if (table.applyFactor) result.lineweights = result.lineweights.map(w => w * (Number(table.scaleFactor) || 1));
        result.applyFactor = false; result.scaleFactor = 1;
        validate(result);
        return result;
    }

    const BUILTIN_NAMES = ['acad.ctb', 'monochrome.ctb', 'grayscale.ctb',
        'Screening 25%.ctb', 'Screening 50%.ctb', 'Screening 75%.ctb', 'Screening 100%.ctb'];

    function builtin(name) {
        const key = String(name || '').trim().toLowerCase();
        if (key === 'acad.stb') return newTable('acad.stb');
        const canon = BUILTIN_NAMES.find(n => n.toLowerCase() === key || n.toLowerCase() === key + '.ctb');
        if (!canon) return null;
        const t = newTable(canon);
        if (canon === 'monochrome.ctb') for (const s of t.styles) s.color = 0x000000;
        if (canon === 'grayscale.ctb') for (const s of t.styles) s.grayscale = true;
        const m = /^Screening (\d+)%/.exec(canon);
        if (m) for (const s of t.styles) s.screen = +m[1];
        return t;
    }

    function clone(t) { return JSON.parse(JSON.stringify(t)); }

    const lum = (c) => Math.round(0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255));
    function screenRgb(c, screen) {
        if (screen >= 100) return c;
        const f = Math.max(0, screen) / 100;
        const ch = (v) => Math.round(255 - (255 - v) * f);
        return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
    }

    /** Plotted colour and width of one object. */
    function resolve(table, obj) {
        const o = obj || {};
        let aci = Number.isFinite(o.aci) && o.aci >= 1 && o.aci <= 255 ? (o.aci | 0) : null;
        let rgb = Number.isFinite(o.rgb) ? (o.rgb & 0xffffff) : (aci ? ACI_RGB[aci] : 0);
        if (aci == null) aci = nearestAci(rgb);
        const selected = table?.kind === 'stb' ? namedStyle(table, o.styleName || 'Normal') : table?.styles?.[aci - 1];
        const s = table?.kind === 'stb' && selected?.name.toLowerCase() === 'normal' ? null : selected;
        let lwMm = Number.isFinite(o.lwMm) ? o.lwMm : null;
        if (s) {
            if (s.color != null) rgb = s.color;
            else if (aci === 7 || rgb === 0xffffff) rgb = 0x000000;
            if (s.grayscale) { const g = lum(rgb); rgb = (g << 16) | (g << 8) | g; }
            rgb = screenRgb(rgb, s.screen);
            if (s.lineweight > 0) {
                const w = (table.lineweights || LINEWEIGHTS)[s.lineweight];
                if (Number.isFinite(w)) lwMm = w * (table.kind !== 'stb' && table.applyFactor ? (table.scaleFactor || 1) : 1);
            }
        } else if (aci === 7 || rgb === 0xffffff) rgb = 0x000000;
        if (table?.kind !== 'stb') return { rgb, lwMm };
        return { rgb, lwMm, linetype: s?.linetype ?? OBJECT_LINETYPE,
            linepatternSize: s?.linepatternSize ?? 0.5, adaptiveLinetype: s?.adaptiveLinetype !== false,
            endStyle: s?.endStyle ?? END_OBJECT, joinStyle: s?.joinStyle ?? JOIN_OBJECT };
    }

    function namedStyle(table, name) {
        const key = String(name || 'Normal').toLowerCase();
        return table?.styles?.find(s => s.name.toLowerCase() === key) || null;
    }
    const LINETYPE_NAMES = ['Solid','Dashed','Dotted','Dash dot','Short dash','Medium dash','Long dash',
        'Short dash ×2','Medium dash ×2','Long dash ×2','Medium long dash','Medium dash short dash short dash',
        'Long dash short dash','Long dash dot dot','Long dash dot','Medium dash dot short dash dot','Sparse dot',
        'ISO dash','ISO dash space','ISO long dash dot','ISO long dash double dot','ISO long dash triple dot',
        'ISO dot','ISO long dash short dash','ISO long dash double short dash','ISO dash dot','ISO double dash dot',
        'ISO dash double dot','ISO double dash double dot','ISO dash triple dot','ISO double dash triple dot','Use object linetype'];
    const LINE_PATTERNS = [[],[3,-1.5],[0,-1.5],[3,-1.5,0,-1.5],[1.5,-1],[3,-1],[6,-1],
        [3,-2],[6,-2],[12,-2],[6,-1.5,3,-1.5],[3,-1,1,-1,1,-1],[6,-1.5,1.5,-1.5],
        [6,-1.5,0,-1.5,0,-1.5],[6,-1.5,0,-1.5],[3,-1,0,-1,1,-1,0,-1],[0,-3],
        [12,-3],[12,-18],[24,-3,0,-3],[24,-3,0,-3,0,-3],[24,-3,0,-3,0,-3,0,-3],
        [0,-3],[24,-3,6,-3],[24,-3,6,-3,6,-3],[12,-3,0,-3],[12,-3,12,-3,0,-3],
        [12,-3,0,-3,0,-3],[12,-3,12,-3,0,-3,0,-3],[12,-3,0,-3,0,-3,0,-3],
        [12,-3,12,-3,0,-3,0,-3,0,-3]];
    function linePattern(code, size = 0.5, factor = 1) {
        if (code === OBJECT_LINETYPE || !Number.isInteger(code) || !LINE_PATTERNS[code]) return undefined;
        return LINE_PATTERNS[code].map(n => n * (Number(size) > 0 ? size : 0.5) * (code >= 17 ? 1 : factor));
    }
    function validate(table) {
        if (!Array.isArray(table?.styles) || !table.styles.length) throw new Error('Plot style table has no styles.');
        if (table.kind !== 'stb') {
            if (table.styles.length !== 255) throw new Error('CTB requires 255 styles.');
            return table;
        }
        const seen = new Set();
        for (const s of table.styles) {
            const name = String(s.name || '').trim();
            if (!name || /[\r\n{}"=]/.test(name) || seen.has(name.toLowerCase())) throw new Error('Invalid or duplicate plot style name: ' + name);
            seen.add(name.toLowerCase());
        }
        if (!seen.has('normal')) throw new Error('STB requires the Normal style.');
        return table;
    }

    // ---------------------------------------------------------------- text format

    /** Tokenise "key=value", "key{", "}" lines into a nested object. */
    function parseTree(text) {
        const rootObj = {};
        const stack = [rootObj];
        const lines = String(text).replace(/\0+$/, '').split(/\r?\n/);
        for (let raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            if (line === '}') { if (stack.length > 1) stack.pop(); continue; }
            if (line.endsWith('{') && !line.includes('=')) {
                const o = {};
                stack[stack.length - 1][line.slice(0, -1).trim()] = o;
                stack.push(o);
                continue;
            }
            const eq = line.indexOf('=');
            if (eq < 0) continue;
            const k = line.slice(0, eq).trim();
            let v = line.slice(eq + 1);
            if (v.startsWith('"')) v = v.slice(1).replace(/"$/, '');
            else v = v.trim();
            stack[stack.length - 1][k] = v;
        }
        return rootObj;
    }

    const bool = (v, d) => (v == null ? d : /^true$/i.test(String(v).trim()));
    const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

    /** CTB colour integer → { rgb } | { aci } | null (object colour). */
    function decodeColor(v) {
        if (v == null || v === '') return null;
        let n = int(v, -1);
        let u = (n >= 0 ? -n : n) >>> 0;          // ezdxf writes the negated form
        if (u === 0xffffffff || u === 0xc3ffffff) return null;
        const type = u >>> 24;
        if (type === 0xc3) return { aci: u & 255 };
        if (type === 0xc0 || type === 0xc1) return null;   // ByLayer / ByBlock
        return { rgb: u & 0xffffff };
    }
    const encodeColor = (rgb) => ((0xc2000000 | (rgb & 0xffffff)) | 0);

    function parseCtbText(text, name, kind) {
        const tree = parseTree(text);
        kind = kind || (/^false$/i.test(tree.aci_table_available) ? 'stb' : 'ctb');
        const t = newTable(name || 'imported.' + kind, tree.description || '', kind);
        t.sourceTree = tree;
        if (kind === 'stb') t.styles = [];
        t.scaleFactor = parseFloat(tree.scale_factor) || 1;
        t.applyFactor = bool(tree.apply_factor, false);
        t.lineweightUnits = int(tree.custom_lineweight_display_units, 0);
        if (tree.custom_lineweight_table) {
            const lw = [];
            for (const [k, v] of Object.entries(tree.custom_lineweight_table)) lw[int(k, 0)] = parseFloat(v) || 0;
            if (lw.length) t.lineweights = Array.from(lw, (v) => v ?? 0);
        }
        const ps = tree.plot_style || {};
        for (const [k, d] of Object.entries(ps)) {
            const i = int(k, -1);
            if (i < 0 || (kind === 'ctb' && i > 254) || typeof d !== 'object') continue;
            const s = kind === 'stb' ? newStyle(i) : t.styles[i];
            if (kind === 'stb') t.styles.push(s);
            s.sourceProperties = d;
            s.name = d.name ?? s.name;
            s.localizedName = d.localized_name ?? s.localizedName;
            s.description = d.description ?? '';
            const c = decodeColor(d.mode_color != null ? d.mode_color : d.color);
            const raw = decodeColor(d.color);
            if (raw == null && d.mode_color == null) { s.color = null; }
            else if (c && c.aci != null) { s.colorAci = c.aci; s.color = ACI_RGB[c.aci] ?? 0; }
            else if (c) s.color = c.rgb;
            else s.color = null;
            const pol = int(d.color_policy, POLICY_DITHER);
            // Named-style writers use the C3 tag for an RGB payload when the
            // NAMED_COLOR policy bit is set; it is not an ACI array index.
            if (kind === 'stb' && (pol & 4) && c) {
                s.color = int(d.mode_color ?? d.color, -1) & 0xffffff;
                s.colorAci = null;
            }
            s.dithering = !!(pol & POLICY_DITHER);
            s.grayscale = !!(pol & POLICY_GRAY);
            s.physicalPen = int(d.physical_pen_number, AUTOMATIC);
            s.virtualPen = int(d.virtual_pen_number, AUTOMATIC);
            s.screen = Math.max(0, Math.min(100, int(d.screen, 100)));
            s.linepatternSize = parseFloat(d.linepattern_size) || 0.5;
            s.linetype = int(d.linetype, OBJECT_LINETYPE);
            s.adaptiveLinetype = bool(d.adaptive_linetype, true);
            s.lineweight = int(d.lineweight, 0);
            s.fillStyle = int(d.fill_style, FILL_OBJECT);
            s.endStyle = int(d.end_style, END_OBJECT);
            s.joinStyle = int(d.join_style, JOIN_OBJECT);
        }
        return validate(t);
    }

    function writeCtbText(t) {
        validate(t);
        const out = [];
        const w = (s) => out.push(s);
        const named = t.kind === 'stb';
        const safe = value => String(value ?? '').replace(/[\r\n]/g, ' ');
        w('description="' + (t.description || ''));
        w('aci_table_available=' + (named ? 'FALSE' : 'TRUE'));
        w('scale_factor=' + (Number(t.scaleFactor) || 1).toFixed(1));
        w('apply_factor=' + (t.applyFactor ? 'TRUE' : 'FALSE'));
        w('custom_lineweight_display_units=' + (t.lineweightUnits | 0));
        if (!named) {
            w('aci_table{');
            for (let i = 0; i < 255; i++) w(' ' + i + '="' + colorName(i));
            w('}');
        }
        const writeExtra = (obj, indent, skip) => {
            for (const [key, value] of Object.entries(obj || {})) {
                if (skip?.has(key)) continue;
                if (value && typeof value === 'object') { w(indent + key + '{'); writeExtra(value, indent + ' '); w(indent + '}'); }
                else w(indent + key + '=' + (typeof value === 'string' && !/^(?:-?[\d.]+|TRUE|FALSE)$/i.test(value) ? '"' : '') + safe(value));
            }
        };
        writeExtra(t.sourceTree, '', new Set(['description','aci_table_available','scale_factor','apply_factor','custom_lineweight_display_units','aci_table','plot_style','custom_lineweight_table']));
        w('plot_style{');
        for (let i = 0; i < t.styles.length; i++) {
            const s = t.styles[i] || newStyle(i);
            w(' ' + i + '{');
            w('  name="' + safe(s.name || colorName(i)));
            w('  localized_name="' + safe(s.localizedName || s.name || colorName(i)));
            w('  description="' + safe(s.description));
            if (s.color == null) w('  color=-1');
            else { const c = encodeColor(s.color); w('  color=' + c); w('  mode_color=' + c); }
            w('  color_policy=' + ((int(s.sourceProperties?.color_policy, 0) & ~7) | (s.dithering ? POLICY_DITHER : 0) | (s.grayscale ? POLICY_GRAY : 0) | (named && s.name.toLowerCase() !== 'normal' ? 4 : 0)));
            w('  physical_pen_number=' + (s.physicalPen | 0));
            w('  virtual_pen_number=' + (s.virtualPen | 0));
            w('  screen=' + (s.screen ?? 100));
            w('  linepattern_size=' + (Number(s.linepatternSize) || 0.5));
            w('  linetype=' + (s.linetype ?? OBJECT_LINETYPE));
            w('  adaptive_linetype=' + (s.adaptiveLinetype === false ? 'FALSE' : 'TRUE'));
            w('  lineweight=' + (s.lineweight | 0));
            w('  fill_style=' + (s.fillStyle ?? FILL_OBJECT));
            w('  end_style=' + (s.endStyle ?? END_OBJECT));
            w('  join_style=' + (s.joinStyle ?? JOIN_OBJECT));
            writeExtra(s.sourceProperties, '  ', new Set(['name','localized_name','description','color','mode_color','color_policy','physical_pen_number','virtual_pen_number','screen','linepattern_size','linetype','adaptive_linetype','lineweight','fill_style','end_style','join_style']));
            w(' }');
        }
        w('}');
        w('custom_lineweight_table{');
        (t.lineweights || LINEWEIGHTS).forEach((v, i) => w(' ' + i + '=' + (Number(v) || 0).toFixed(2)));
        w('}');
        return out.join('\n') + '\n\0';
    }

    // ---------------------------------------------------------------- binary

    function adler32(bytes) {
        let a = 1, b = 0;
        for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
        return ((b << 16) | a) >>> 0;
    }

    const enc = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s) : Uint8Array.from(Buffer.from(s, 'utf8')));
    const dec = (b) => (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8').decode(b) : Buffer.from(b).toString('utf8'));

    /** .ctb bytes → table. Header is 48 text bytes + 3 uint32 (some writers use 8-byte fields). */
    async function decodeCtb(bytes, inflate, name) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const head = String.fromCharCode(...u8.subarray(0, 48));
        const kind = head.startsWith('PIAFILEVERSION_2.0,STBVER1') ? 'stb' : 'ctb';
        if (!head.startsWith('PIAFILEVERSION_2.0,' + (kind === 'stb' ? 'STBVER1' : 'CTBVER1'))) throw new Error('Not a CTB or STB file');
        // Find the zlib stream: 0x78 after the 12 (or 24) header bytes.
        let start = 60;
        if (!(u8[start] === 0x78) && u8[72] === 0x78) start = 72;
        const body = await inflate(u8.subarray(start));
        return parseCtbText(dec(body instanceof Uint8Array ? body : new Uint8Array(body)), name, kind);
    }

    async function encodeCtb(table, deflate) {
        const text = enc(writeCtbText(table));
        const comp = await deflate(text);
        const c8 = comp instanceof Uint8Array ? comp : new Uint8Array(comp);
        const out = new Uint8Array(60 + c8.length);
        out.set(enc(table.kind === 'stb' ? HEADER.replace('CTBVER1', 'STBVER1') : HEADER), 0);
        const dv = new DataView(out.buffer);
        dv.setUint32(48, adler32(c8), true);
        dv.setUint32(52, text.length, true);
        dv.setUint32(56, c8.length, true);
        out.set(c8, 60);
        return out;
    }

    async function streamBytes(bytes, Stream) {
        const s = new Blob([bytes]).stream().pipeThrough(new Stream('deflate'));
        return new Uint8Array(await new Response(s).arrayBuffer());
    }
    const browserInflate = (b) => streamBytes(b, DecompressionStream);
    const browserDeflate = (b) => streamBytes(b, CompressionStream);

    const DxfPlotStyle = {
        ACI_RGB, LINEWEIGHTS, BUILTIN_NAMES,
        aciToRgb, nearestAci, newTable, builtin, clone, resolve, namedStyle, validate, newStyle, linePattern, LINETYPE_NAMES, toNamedTable,
        parseCtbText, writeCtbText, decodeColor, encodeColor,
        adler32, decodeCtb, encodeCtb, browserInflate, browserDeflate,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfPlotStyle;
    if (root) root.DxfPlotStyle = DxfPlotStyle;
})(typeof window !== 'undefined' ? window : null);
