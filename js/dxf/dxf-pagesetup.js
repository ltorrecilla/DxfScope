/**
 * dxf-pagesetup.js — page setup of a layout (LAYOUT object, AcDbPlotSettings)
 * ↔ the editor's plot settings. Pure, no DOM.
 *
 *   PAPERS                 known sheets { id, w, h (mm, portrait), dxf }
 *   STANDARD_SCALES[i]     code 75 → [paper, drawing] (i = 0 is "fit")
 *   parse(pairs)           LAYOUT record pairs [{code, value}] → raw page setup
 *   isSet(raw)             the file really has a page setup (device or name set)
 *   toSettings(raw, ctx)   raw → plot settings (partial)
 *   encode(st, ctx)        plot settings → { values: {code: value}, flagsMask, flagsValue,
 *                          fill: {code: value} (only where the record has it empty) }
 *   apply(arr, enc)        patch a flat [code, value, …] LAYOUT record
 *   paperName(w, h)        AutoCAD-style media name for a sheet in mm
 *
 * ctx: { paperSpace: bool, unitMm: mm per drawing unit (model INSUNITS, 1 for
 *        a mm sheet, 25.4 for an inch sheet), paper: {width, height} mm (encode) }
 * Plot settings (the PLOT dialog's state):
 *   area 'layout'|'extents'|'display'|'window', window {minX,minY,maxX,maxY},
 *   paper id | 'layout' | 'custom', customPaper {w,h}, orient 'landscape'|'portrait',
 *   scale 'fit' | 'a:b' (real scale) | 'custom', customMm, customUnits,
 *   center, ox, oy (mm), margin (mm), table, lineweights, scaleLw
 *
 * window.DxfPageSetup + Node exports.
 */
(function (root) {
    'use strict';

    const PAPERS = [
        { id: 'A0', w: 841, h: 1189, dxf: 'ISO_A0_(841.00_x_1189.00_MM)' },
        { id: 'A1', w: 594, h: 841, dxf: 'ISO_A1_(594.00_x_841.00_MM)' },
        { id: 'A2', w: 420, h: 594, dxf: 'ISO_A2_(420.00_x_594.00_MM)' },
        { id: 'A3', w: 297, h: 420, dxf: 'ISO_A3_(297.00_x_420.00_MM)' },
        { id: 'A4', w: 210, h: 297, dxf: 'ISO_A4_(210.00_x_297.00_MM)' },
        { id: 'A5', w: 148, h: 210, dxf: 'ISO_A5_(148.00_x_210.00_MM)' },
        { id: 'ANSI A (Letter)', w: 215.9, h: 279.4, dxf: 'ANSI_A_(8.50_x_11.00_Inches)' },
        { id: 'Legal', w: 215.9, h: 355.6, dxf: 'Legal_(8.50_x_14.00_Inches)' },
        { id: 'ANSI B (Tabloid)', w: 279.4, h: 431.8, dxf: 'ANSI_B_(11.00_x_17.00_Inches)' },
        { id: 'ANSI C', w: 431.8, h: 558.8, dxf: 'ANSI_C_(17.00_x_22.00_Inches)' },
        { id: 'ANSI D', w: 558.8, h: 863.6, dxf: 'ANSI_D_(22.00_x_34.00_Inches)' },
        { id: 'ANSI E', w: 863.6, h: 1117.6, dxf: 'ANSI_E_(34.00_x_44.00_Inches)' },
    ];

    // Code 75 (AutoCAD's list). Imperial entries are paper inch : drawing inch.
    const STANDARD_SCALES = [
        null, [1 / 128, 12], [1 / 64, 12], [1 / 32, 12], [1 / 16, 12], [3 / 32, 12], [1 / 8, 12], [3 / 16, 12],
        [1 / 4, 12], [3 / 8, 12], [1 / 2, 12], [3 / 4, 12], [1, 12], [3, 12], [6, 12], [12, 12],
        [1, 1], [1, 2], [1, 4], [1, 8], [1, 10], [1, 16], [1, 20], [1, 30], [1, 40], [1, 50], [1, 100],
        [2, 1], [4, 1], [8, 1], [10, 1], [100, 1], [1000, 1],
    ];
    // Real scales the PLOT dialog lists (paper : real world).
    const DIALOG_SCALES = [[1, 1], [1, 2], [1, 5], [1, 10], [1, 20], [1, 25], [1, 50], [1, 100], [1, 200], [1, 250], [1, 500], [1, 1000], [1, 2000], [1, 5000], [2, 1], [5, 1], [10, 1]];

    const F_CENTERED = 4, F_STD_SCALE = 16, F_SCALE_LW = 64, F_PRINT_LW = 128;
    const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
    const near = (a, b, tol) => Math.abs(a - b) <= (tol ?? Math.max(1e-9, Math.abs(b) * 1e-6));
    const fmt = (v) => { const r = Math.round(v * 1e6) / 1e6; return String(Object.is(r, -0) ? 0 : r); };

    function parse(pairs) {
        const raw = {
            pageSetup: '', device: '', paperName: '', styleSheet: '', viewName: '',
            margins: [0, 0, 0, 0], paperW: 0, paperH: 0, originX: 0, originY: 0,
            win: [0, 0, 0, 0], numerator: 1, denominator: 1, flags: 0, units: 1,
            rotation: 0, plotType: 0, stdScale: 0, stdFactor: 1, name: '',
        };
        let zone = '';
        const seen = new Set();
        for (const pr of pairs || []) {
            const c = String(pr.code).trim(), v = String(pr.value ?? '').trim();
            if (c === '100') { zone = v; continue; }
            if (zone === 'AcDbLayout' && c === '1' && !raw.name) { raw.name = v; continue; }
            if (zone !== 'AcDbPlotSettings' || seen.has(c)) continue;
            seen.add(c);
            switch (c) {
                case '1': raw.pageSetup = v; break;
                case '2': raw.device = v; break;
                case '4': raw.paperName = v; break;
                case '6': raw.viewName = v; break;
                case '7': raw.styleSheet = v; break;
                case '40': raw.margins[0] = num(v); break;
                case '41': raw.margins[1] = num(v); break;
                case '42': raw.margins[2] = num(v); break;
                case '43': raw.margins[3] = num(v); break;
                case '44': raw.paperW = num(v); break;
                case '45': raw.paperH = num(v); break;
                case '46': raw.originX = num(v); break;
                case '47': raw.originY = num(v); break;
                case '48': raw.win[0] = num(v); break;
                case '49': raw.win[1] = num(v); break;
                case '140': raw.win[2] = num(v); break;
                case '141': raw.win[3] = num(v); break;
                case '142': raw.numerator = num(v, 1); break;
                case '143': raw.denominator = num(v, 1); break;
                case '70': raw.flags = parseInt(v, 10) || 0; break;
                case '72': raw.units = parseInt(v, 10) || 0; break;
                case '73': raw.rotation = parseInt(v, 10) || 0; break;
                case '74': raw.plotType = parseInt(v, 10) || 0; break;
                case '75': raw.stdScale = parseInt(v, 10) || 0; break;
                case '147': raw.stdFactor = num(v, 1); break;
                default: break;
            }
        }
        return raw;
    }

    function isSet(raw) {
        if (!raw) return false;
        const dev = String(raw.device || '').trim();
        return !!(String(raw.pageSetup || '').trim() || (dev && dev.toLowerCase() !== 'none_device'));
    }

    /** Sheet as laid out (rotation applied), mm. */
    function sheetOf(raw) {
        let w = raw.paperW, h = raw.paperH;
        if (!(w > 0 && h > 0)) return null;
        if (raw.rotation === 1 || raw.rotation === 3) [w, h] = [h, w];
        return { width: w, height: h };
    }

    function paperIdFor(w, h) {
        const lo = Math.min(w, h), hi = Math.max(w, h);
        const p = PAPERS.find(q => near(q.w, lo, 0.6) && near(q.h, hi, 0.6));
        return p ? p.id : null;
    }

    function paperName(w, h) {
        const id = paperIdFor(w, h);
        const p = id ? PAPERS.find(q => q.id === id) : null;
        if (p && /Inches/.test(p.dxf)) return p.dxf;
        if (p) return `ISO_${p.id}_(${w.toFixed(2)}_x_${h.toFixed(2)}_MM)`;
        return `Custom_(${w.toFixed(2)}_x_${h.toFixed(2)}_MM)`;
    }

    /** Paper mm per drawing unit stored in the file (null = fit). */
    function storedK(raw) {
        const inch = raw.units === 0 ? 25.4 : 1;
        if ((raw.flags & F_STD_SCALE) && raw.stdScale === 0) return null;
        if ((raw.flags & F_STD_SCALE) && STANDARD_SCALES[raw.stdScale]) {
            const [a, b] = STANDARD_SCALES[raw.stdScale];
            const imperial = raw.stdScale >= 1 && raw.stdScale <= 15;
            return (a / b) * (imperial ? 25.4 : inch);
        }
        const d = raw.denominator || 1;
        return (raw.numerator / d) * inch;
    }

    function toSettings(raw, ctx = {}) {
        const unitMm = ctx.unitMm || 1;
        const inch = raw.units === 0 ? 25.4 : 1;
        const st = {};
        // Area.
        if (raw.plotType === 5) st.area = ctx.paperSpace ? 'layout' : 'extents';
        else if (raw.plotType === 4) {
            st.area = 'window';
            st.window = { minX: raw.win[0], minY: raw.win[1], maxX: raw.win[2], maxY: raw.win[3] };
            if (!(raw.win[2] > raw.win[0] && raw.win[3] > raw.win[1])) { st.area = 'extents'; delete st.window; }
        } else if (raw.plotType === 1 || raw.plotType === 2) st.area = 'extents';
        else st.area = 'display';
        // Paper.
        const sheet = sheetOf(raw);
        if (sheet) {
            const id = paperIdFor(sheet.width, sheet.height);
            if (ctx.paperSpace) st.paper = 'layout';
            else if (id) st.paper = id;
            else { st.paper = 'custom'; st.customPaper = { w: Math.min(sheet.width, sheet.height), h: Math.max(sheet.width, sheet.height) }; }
            st.orient = sheet.width >= sheet.height ? 'landscape' : 'portrait';
        }
        // Scale: our presets are real scales (paper : real world).
        const k = storedK(raw);
        if (k === null) st.scale = 'fit';
        else {
            const real = k / unitMm;
            const hit = DIALOG_SCALES.find(([a, b]) => near(real, a / b, Math.abs(a / b) * 1e-6));
            if (hit) st.scale = `${hit[0]}:${hit[1]}`;
            else {
                st.scale = 'custom';
                const n = raw.numerator * inch, d = raw.denominator || 1;
                st.customMm = (raw.flags & F_STD_SCALE) ? k : n;
                st.customUnits = (raw.flags & F_STD_SCALE) ? 1 : d;
            }
        }
        st.center = !!(raw.flags & F_CENTERED);
        st.ox = raw.originX * inch;
        st.oy = raw.originY * inch;
        st.margin = Math.max(0, ...raw.margins.map(m => m * inch));
        st.lineweights = !!(raw.flags & F_PRINT_LW);
        st.scaleLw = !!(raw.flags & F_SCALE_LW);
        if (raw.styleSheet) st.table = raw.styleSheet;
        return st;
    }

    function encode(st, ctx = {}) {
        const unitMm = ctx.unitMm || 1;
        const values = {};
        const paper = ctx.paper;
        if (paper && paper.width > 0 && paper.height > 0) {
            values['4'] = paperName(paper.width, paper.height);
            values['44'] = fmt(paper.width);
            values['45'] = fmt(paper.height);
            values['73'] = '0';
        }
        values['72'] = '1';
        const m = Math.max(0, Number(st.margin) || 0);
        values['40'] = values['41'] = values['42'] = values['43'] = fmt(m);
        values['46'] = fmt(Number(st.ox) || 0);
        values['47'] = fmt(Number(st.oy) || 0);
        const area = st.area || (ctx.paperSpace ? 'layout' : 'extents');
        values['74'] = area === 'layout' ? '5' : area === 'window' ? '4' : area === 'extents' ? '1' : '0';
        if (area === 'window' && st.window) {
            const w = st.window;
            values['48'] = fmt(Math.min(w.minX, w.maxX)); values['49'] = fmt(Math.min(w.minY, w.maxY));
            values['140'] = fmt(Math.max(w.minX, w.maxX)); values['141'] = fmt(Math.max(w.minY, w.maxY));
        }
        let flagsValue = 0;
        const flagsMask = F_CENTERED | F_STD_SCALE | F_SCALE_LW | F_PRINT_LW;
        if (st.center) flagsValue |= F_CENTERED;
        if (st.scaleLw) flagsValue |= F_SCALE_LW;
        if (st.lineweights !== false) flagsValue |= F_PRINT_LW;
        if (st.scale === 'fit') {
            flagsValue |= F_STD_SCALE;
            values['75'] = '0';
            values['142'] = '1'; values['143'] = '1'; values['147'] = '1';
        } else {
            let k;
            if (st.scale === 'custom') k = (Number(st.customMm) || 1) / (Number(st.customUnits) || 1);
            else {
                const mm = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(st.scale || '1:1');
                k = unitMm * (mm ? (+mm[1]) / (+mm[2]) : 1);
            }
            // A plain ratio AutoCAD lists (16…32) is written as a standard scale.
            let std = -1;
            for (let i = 16; i < STANDARD_SCALES.length; i++) { const [a, b] = STANDARD_SCALES[i]; if (near(k, a / b, (a / b) * 1e-9)) { std = i; break; } }
            if (std > 0) { flagsValue |= F_STD_SCALE; values['75'] = String(std); }
            else values['75'] = '0';
            if (st.scale === 'custom') { values['142'] = fmt(Number(st.customMm) || 1); values['143'] = fmt(Number(st.customUnits) || 1); }
            else if (k >= 1) { values['142'] = fmt(k); values['143'] = '1'; }
            else { values['142'] = '1'; values['143'] = fmt(1 / k); }
            values['147'] = fmt(k);
        }
        if (st.table !== undefined) values['7'] = st.table || '';
        // An empty plotter name marks "no page setup"; AutoCAD writes "None".
        return { values, flagsMask, flagsValue, fill: { '2': 'None' } };
    }

    // Order AutoCAD writes AcDbPlotSettings in; used to place codes a record lacks.
    const ORDER = ['1', '2', '4', '6', '40', '41', '42', '43', '44', '45', '46', '47', '48', '49', '140', '141', '142', '143', '70', '72', '73', '74', '7', '75', '147', '76', '77', '78', '148', '149'];

    function apply(arr, enc) {
        if (!enc) return arr;
        const values = { ...(enc.values || {}) };
        const fill = enc.fill || {};
        const mask = enc.flagsMask | 0, fv = enc.flagsValue | 0;
        // Split: head (before AcDbPlotSettings body), body pairs, tail (from next 100).
        let s = -1, e = -1;
        for (let k = 0; k + 1 < arr.length; k += 2) {
            const c = String(arr[k]).trim(), v = String(arr[k + 1]).trim();
            if (c === '100' && v === 'AcDbPlotSettings') { s = k + 2; continue; }
            if (s >= 0 && c === '100') { e = k; break; }
        }
        if (s < 0) return arr;
        if (e < 0) e = arr.length;
        const body = [];
        for (let k = s; k + 1 < e; k += 2) body.push([arr[k], arr[k + 1]]);
        const done = new Set();
        let sawFlags = false;
        for (const p of body) {
            const c = String(p[0]).trim();
            if (c === '70' && !sawFlags) {
                sawFlags = true;
                if (mask) { const f = parseInt(String(p[1]).trim(), 10) || 0; p[1] = String((f & ~mask) | (fv & mask)); }
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(values, c) && !done.has(c)) { p[1] = String(values[c]); done.add(c); }
            else if (Object.prototype.hasOwnProperty.call(fill, c) && !done.has(c)) { if (!String(p[1]).trim()) p[1] = String(fill[c]); done.add(c); }
        }
        for (const c of Object.keys(fill)) if (!done.has(c) && !Object.prototype.hasOwnProperty.call(values, c)) values[c] = fill[c];
        if (!sawFlags && mask) values['70'] = String(fv & mask);
        // Insert missing codes after the nearest earlier code in ORDER.
        for (const c of Object.keys(values)) {
            if (done.has(c) || (c === '70' && sawFlags)) continue;
            const oi = ORDER.indexOf(c);
            let at = 0;
            for (let b = 0; b < body.length; b++) {
                const bi = ORDER.indexOf(String(body[b][0]).trim());
                if (bi >= 0 && oi >= 0 && bi < oi) at = b + 1;
            }
            body.splice(at, 0, [c, String(values[c])]);
            done.add(c);
        }
        return [...arr.slice(0, s), ...body.flat(), ...arr.slice(e)];
    }

    const DxfPageSetup = { PAPERS, STANDARD_SCALES, DIALOG_SCALES, parse, isSet, sheetOf, paperIdFor, paperName, storedK, toSettings, encode, apply };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfPageSetup;
    if (root) root.DxfPageSetup = DxfPageSetup;
})(typeof window !== 'undefined' ? window : null);
