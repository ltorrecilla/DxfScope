/**
 * dxf_paper_frames.js — paper-space viewport (frame) math.
 *
 * Pure functions, DOM-free. Exposes window.DxfPaperFrames + Node exports.
 *
 * DXF scale model:
 *   viewport scale = paper height (code 41) / view height (code 45)
 *   "1:n" therefore means  viewHeight = paperHeight × n
 */
(function (root) {
    'use strict';

    // Standard architectural/engineering scales offered in the UI, as denominators n of 1:n.
    const STANDARD_SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];

    // DXF $INSUNITS → millimetres per model unit. Paper space is treated as mm
    // (metric sheet convention); a model drawn in metres therefore has factor 1000.
    const INSUNITS_TO_MM = {
        0: 1,        // unitless
        1: 25.4,     // inches
        2: 304.8,    // feet
        3: 1609344,  // miles
        4: 1,        // millimetres
        5: 10,       // centimetres
        6: 1000,     // metres
        7: 1e6,      // kilometres
        8: 0.0254,   // microinches
        9: 0.0254 * 1000, // mils
        10: 914.4,   // yards
        14: 100,     // decimetres
    };
    function mmPerModelUnit(insunits) {
        const f = INSUNITS_TO_MM[Number(insunits)];
        return Number.isFinite(f) && f > 0 ? f : 1;
    }
    const INSUNITS_LABEL = { 0: '—', 1: 'in', 2: 'ft', 3: 'mi', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 8: 'µin', 9: 'mil', 10: 'yd', 14: 'dm' };
    function unitLabel(insunits) { return INSUNITS_LABEL[Number(insunits)] || '—'; }

    /**
     * view height (code 45, MODEL units) for a "1:n" scale on a frame of the given
     * paper height (mm). unitFactor = mm per model unit (default 1 = same unit).
     */
    function viewHeightForScale(paperHeight, n, unitFactor) {
        const f = Number.isFinite(unitFactor) && unitFactor > 0 ? unitFactor : 1;
        return Math.abs(paperHeight) * Math.abs(n) / f;
    }

    /** the "n" of 1:n for a viewport. unitFactor = mm per model unit. */
    function scaleDenominator(paperHeight, viewHeight, unitFactor) {
        const ph = Math.abs(paperHeight), vh = Math.abs(viewHeight);
        const f = Number.isFinite(unitFactor) && unitFactor > 0 ? unitFactor : 1;
        if (!(ph > 0) || !(vh > 0)) return null;
        return vh * f / ph;
    }

    /** Human label like "1:50" (rounded sensibly) or "1:12.5" for non-integers. */
    function scaleLabel(n) {
        if (!Number.isFinite(n) || n <= 0) return '—';
        const rounded = Math.round(n);
        if (Math.abs(n - rounded) < 0.01) return `1:${rounded}`;
        return `1:${(Math.round(n * 100) / 100)}`;
    }

    /**
     * Fit the model extents into a frame: returns { viewCenter, viewHeight }.
     * extents = {minX, minY, maxX, maxY} in model units; frameW/frameH in paper units.
     */
    function fitViewToExtents(extents, frameW, frameH, marginFrac) {
        const margin = 1 + (marginFrac ?? 0.05);
        const extW = Math.max(extents.maxX - extents.minX, 1e-9);
        const extH = Math.max(extents.maxY - extents.minY, 1e-9);
        const frameAspect = Math.abs(frameW) / Math.max(Math.abs(frameH), 1e-9);
        // View height must cover the extents height AND the extents width via aspect.
        const viewHeight = Math.max(extH, extW / frameAspect) * margin;
        return {
            viewCenter: {
                x: (extents.minX + extents.maxX) / 2,
                y: (extents.minY + extents.maxY) / 2,
            },
            viewHeight,
        };
    }

    /**
     * Pan the inside view: dragging the CONTENT by (dPaperX, dPaperY) paper units
     * means the view center moves the opposite way in model units.
     */
    function panViewCenter(viewCenter, dPaperX, dPaperY, viewHeight, paperHeight) {
        const f = Math.abs(viewHeight) / Math.max(Math.abs(paperHeight), 1e-9);
        return {
            x: viewCenter.x - dPaperX * f,
            y: viewCenter.y - dPaperY * f,
        };
    }

    /** Next free viewport id (code 69). Id 1 is reserved for the layout's overall viewport. */
    function nextViewportId(existingIds) {
        let max = 1;
        for (const id of existingIds || []) {
            const v = Number(id);
            if (Number.isFinite(v) && v > max) max = v;
        }
        return max + 1;
    }

    const DxfPaperFrames = {
        STANDARD_SCALES,
        mmPerModelUnit, unitLabel,
        viewHeightForScale, scaleDenominator, scaleLabel,
        fitViewToExtents, panViewCenter, nextViewportId,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = DxfPaperFrames;
    if (root) root.DxfPaperFrames = DxfPaperFrames;
})(typeof window !== 'undefined' ? window : null);
