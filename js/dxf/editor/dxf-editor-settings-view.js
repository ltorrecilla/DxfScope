/* Settings presentation only; the Editor owns state, persistence and event handlers. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfEditorSettingsView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Render current viewer preferences without changing state or binding events.
    function options(state, tr) {
        const { baseWheelZoomSpeed, activeSpaceKey, isDarkMode, dynamicEnabled, showOriginAxes, textHaloEnabled, curveSmoothness, measurePrecision, selectionColor, selectionColors = [] } = state;
        const zoom = baseWheelZoomSpeed;
        const zoomValue = zoom >= 6 ? '6.4' : zoom >= 4 ? '4.4' : '2.8';
        return `
            <div class="settings-section-title">${tr('settingsSectionViewer', 'Viewer')}</div>
            <div class="settings-row">
                <div>
                    <label for="setting-selection-color" class="settings-row-label">${tr('selectionColor', 'Selection color')}</label>
                    <div class="settings-row-hint">${tr('selectionColorHint', 'Color of the selection halo. Changes appear immediately.')}</div>
                </div>
                <div class="settings-row-control">
                    <select id="setting-selection-color" class="settings-select">
                        ${selectionColors.map(([color, key, label]) => `<option value="${color}" ${color === selectionColor ? 'selected' : ''}>${tr(key, label)}</option>`).join('')}
                    </select>
                </div>
            </div>
            <div class="settings-row">
                <div>
                    <div class="settings-row-label">${tr('darkDrawingBackground', 'Dark drawing background')}</div>
                    <div class="settings-row-hint ${activeSpaceKey === 'model' ? 'hidden' : ''}">${activeSpaceKey === 'model' ? tr('darkDrawingBackgroundHint', 'Use the dark viewer background and flip standard black/white CAD colours for readability.') : tr('paperLightModeLocked', 'Paper space is always shown in light mode.')}</div>
                </div>
                <div class="settings-row-control"><label class="settings-check"><input id="setting-dark-mode" type="checkbox" ${isDarkMode ? 'checked' : ''} ${activeSpaceKey === 'model' ? '' : 'disabled'}></label></div>
            </div>
            <div class="settings-row">
                <label for="setting-pointer-input" class="settings-row-label">${tr('showPointerInput', 'Show pointer input')}</label>
                <div class="settings-row-control"><label class="settings-check"><input id="setting-pointer-input" type="checkbox" ${dynamicEnabled ? 'checked' : ''}></label></div>
            </div>
            <div class="settings-row">
                <div>
                    <div class="settings-row-label">${tr('mouseWheelZoom', 'Mouse wheel zoom')}</div>
                    <div class="settings-row-hint">${tr('mouseWheelZoomHint', 'Choose the regular wheel speed. Hold Shift while scrolling to zoom twice as fast, including inside an edited viewport.')}</div>
                </div>
                <div class="settings-row-control">
                    <select id="setting-zoom-speed" class="settings-select">
                        <option value="2.8" ${zoomValue === '2.8' ? 'selected' : ''}>${tr('zoomNormal', 'Normal')}</option>
                        <option value="4.4" ${zoomValue === '4.4' ? 'selected' : ''}>${tr('zoomFast', 'Fast')}</option>
                        <option value="6.4" ${zoomValue === '6.4' ? 'selected' : ''}>${tr('zoomVeryFast', 'Very fast')}</option>
                    </select>
                </div>
            </div>
            <div class="settings-row">
                <div>
                    <div class="settings-row-label">${tr('originAxesLabel', 'Show origin axes (0,0)')}</div>
                    <div class="settings-row-hint hidden">${tr('originAxesHint', 'Red X / green Y marker at the drawing origin in model space.')}</div>
                </div>
                <div class="settings-row-control"><label class="settings-check"><input id="setting-origin-axes" type="checkbox" ${showOriginAxes ? 'checked' : ''}></label></div>
            </div>
            <div class="settings-row">
                <div><div class="settings-row-label">${tr('textHaloLabel', 'Text halo')}</div></div>
                <div class="settings-row-control"><label class="settings-check"><input id="setting-text-halo" type="checkbox" ${textHaloEnabled ? 'checked' : ''}></label></div>
            </div>
            <div class="settings-row">
                <div>
                    <div class="settings-row-label">${tr('curveSmoothness', 'Curve smoothness')}</div>
                    <div class="settings-row-hint hidden">${tr('curveSmoothnessHint', 'Controls how finely circles, arcs, ellipses and bulge curves are approximated.')}</div>
                </div>
                <div class="settings-row-control">
                    <select id="setting-curve-smoothness" class="settings-select">
                        <option value="normal" ${curveSmoothness === 'normal' ? 'selected' : ''}>${tr('curveSmoothnessNormal', 'Normal')}</option>
                        <option value="high" ${curveSmoothness === 'high' ? 'selected' : ''}>${tr('curveSmoothnessHigh', 'High')}</option>
                        <option value="very-high" ${curveSmoothness === 'very-high' ? 'selected' : ''}>${tr('curveSmoothnessVeryHigh', 'Very high')}</option>
                        <option value="ultra" ${curveSmoothness === 'ultra' ? 'selected' : ''}>${tr('curveSmoothnessUltra', 'Ultra')}</option>
                    </select>
                </div>
            </div>
            <div class="settings-section-title">${tr('settingsSectionDimensions', 'Dimensions')}</div>
            <div class="settings-row">
                <div>
                    <div class="settings-row-label">${tr('measurementDecimals', 'Measurement decimals')}</div>
                    <div class="settings-row-hint hidden">${tr('measurementDecimalsHint', 'Decimal places shown on measure and hammer dimension labels.')}</div>
                </div>
                <div class="settings-row-control">
                    <select id="setting-measure-precision" class="settings-select">
                        <option value="2" ${measurePrecision === 2 ? 'selected' : ''}>${tr('twoDecimals', '2 decimals')}</option>
                        <option value="3" ${measurePrecision === 3 ? 'selected' : ''}>${tr('threeDecimals', '3 decimals')}</option>
                        <option value="4" ${measurePrecision === 4 ? 'selected' : ''}>${tr('fourDecimals', '4 decimals')}</option>
                    </select>
                </div>
            </div>
        `;
    }


    // Drafting aids, in AutoCAD's status-bar order.
    function drawing(state, tr) {
        const { orthoMode, polarTracking, polarIncrementDeg, measureSnapSettings, SNAP_MODE_KEYS, SNAP_MODE_LABELS, otrackEnabled, autosave } = state;
        return `
            <div class="settings-section-title settings-section-title--first">${tr('settingsSectionDrafting', 'Drafting aids')}</div>
            <div class="settings-row">
                <div>
                    <div class="settings-row-label">${tr('orthoModeLabel', 'Ortho mode (F8)')}</div>
                    <div class="settings-row-hint hidden">${tr('orthoModeHint', 'Constrain drawing and moves to horizontal/vertical axes.')}</div>
                </div>
                <div class="settings-row-control"><label class="settings-check"><input id="setting-ortho" type="checkbox" ${orthoMode ? 'checked' : ''}></label></div>
            </div>
            <div class="settings-row">
                <div>
                    <div class="settings-row-label">${tr('polarModeLabel', 'Polar tracking (F10)')}</div>
                    <div class="settings-row-hint hidden">${tr('polarModeHint', 'Snap drawing directions to angle increments. Ortho wins when both are on.')}</div>
                </div>
                <div class="settings-row-control" style="display:flex; align-items:center; gap:8px;">
                    <select id="setting-polar-inc" class="settings-select" style="width:70px;">
                        ${[5, 10, 15, 22.5, 30, 45, 90].map(v => `<option value="${v}" ${Number(polarIncrementDeg) === v ? 'selected' : ''}>${v}°</option>`).join('')}
                    </select>
                    <label class="settings-check"><input id="setting-polar" type="checkbox" ${polarTracking ? 'checked' : ''}></label>
                </div>
            </div>
            <div class="settings-row">
                <div>
                    <div class="settings-row-label">${tr('osnapModeLabel', 'Object snap (F3)')}</div>
                    <div class="settings-row-hint hidden">${tr('osnapModeHint', 'Snap the cursor to exact points on existing geometry.')}</div>
                </div>
                <div class="settings-row-control"><label class="settings-check"><input id="setting-osnap" type="checkbox" ${measureSnapSettings.enabled ? 'checked' : ''}></label></div>
            </div>
            <div class="settings-row" style="display:block;">
                <div class="osnap-modes">
                    ${SNAP_MODE_KEYS.map(k => `<label class="measure-snap-option"><input type="checkbox" data-snap-mode="${k}" ${measureSnapSettings[k] ? 'checked' : ''}><span class="dxf-snap-option-icon" aria-hidden="true" style="--dxf-snap-icon: url(../img/dxf/snaps/dxf-snap-${k}.svg)"></span><span>${tr(SNAP_MODE_LABELS[k][0], SNAP_MODE_LABELS[k][1])}</span></label>`).join('')}
                </div>
            </div>
            <div class="settings-row">
                <div>
                    <div class="settings-row-label">${tr('otrackModeLabel', 'Object snap tracking (F11)')}</div>
                    <div class="settings-row-hint hidden">${tr('otrackModeHint', 'Hover a snap point while drawing to acquire it, then align with its horizontal/vertical rays.')}</div>
                </div>
                <div class="settings-row-control"><label class="settings-check"><input id="setting-otrack" type="checkbox" ${otrackEnabled ? 'checked' : ''}></label></div>
            </div>
            <div class="settings-section-title">${tr('settingsSectionRecovery', 'Autosave & recovery')}</div>
            <div class="settings-row">
                <div>
                    <div class="settings-row-label">${tr('autosaveLabel', 'Autosave for recovery')}</div>
                    <div class="settings-row-hint">${tr('autosaveHint', 'Unsaved edits are kept in this browser and offered back after a crash or a closed tab.')}</div>
                </div>
                <div class="settings-row-control" style="display:flex; align-items:center; gap:8px;">
                    <button type="button" id="setting-recovery-open" class="settings-select" style="width:auto; padding:2px 8px; cursor:pointer;">${tr('recoveryOpenBtn', 'Recover…')}</button>
                    <label class="settings-check"><input id="setting-autosave" type="checkbox" ${autosave?.enabled !== false ? 'checked' : ''}></label>
                </div>
            </div>
        `;
    }

    // Resolve translations each render so language changes never retain old text.
    function help(tr) {
        return `
            <div class="settings-section-title settings-section-title--first">${tr('settingsHelpNavigation', 'Navigation')}</div>
            <ul class="settings-help-list">
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="move"></i><span class="settings-help-key">${tr('helpMiddleRightDrag', 'Middle / right drag')}</span><span>${tr('helpPanDrawing', 'Pan the 2D drawing.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="zoom-in"></i><span class="settings-help-key">${tr('helpMouseWheel', 'Wheel / Shift+wheel')}</span><span>${tr('helpZoomWheel', 'Scroll to zoom around the pointer. Hold Shift for twice the zoom speed.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="focus"></i><span class="settings-help-key">${tr('fitScreen', 'Fit Screen')}</span><span>${tr('helpFitScreen', 'Center and fit all visible drawing geometry.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="keyboard"></i><span class="settings-help-key">${tr('helpEscape', 'Escape')}</span><span>${tr('helpEscapeDesc', 'Exit measure tools and clear temporary dimensions.')}</span></li>
            </ul>
            <div class="settings-section-title">${tr('settingsHelpSelection', 'Selection & Editing')}</div>
            <ul class="settings-help-list">
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="mouse-pointer"></i><span class="settings-help-key">${tr('helpClickSelect', 'Click on entity')}</span><span>${tr('helpClickSelectDesc', 'Select a single line, arc, polyline, or text.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="mouse-pointer-click"></i><span class="settings-help-key">${tr('helpObjectRightClick', 'Right-click an object')}</span><span>${tr('helpObjectRightClickDesc', 'Open actions for the selected object, including Edit block in place for a block insertion. Right-drag still pans.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="square-dashed"></i><span class="settings-help-key">${tr('helpAreaSelectWindow', 'Click empty space, then click (L→R)')}</span><span>${tr('helpAreaSelectWindowDesc', 'Window select: only fully enclosed entities are selected (blue box). Hold Ctrl to add to the selection or Shift to remove from it, by click or by box.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="square-dashed"></i><span class="settings-help-key">${tr('helpAreaSelectCrossing', 'Click empty space, then click (R→L)')}</span><span>${tr('helpAreaSelectCrossingDesc', 'Crossing select: any entity touching the area is selected (green box). While the box is open you can pan (middle/right drag) and zoom to reach objects off-screen, the first corner stays put on the drawing.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="hand"></i><span class="settings-help-key">${tr('helpDragPan', 'Click & drag')}</span><span>${tr('helpDragPanDesc', 'Pan the drawing (does not start a selection).')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="type"></i><span class="settings-help-key">${tr('helpDoubleClickText', 'Double-click text')}</span><span>${tr('helpDoubleClickTextDesc', 'Edit text in place. Enter commits, Shift+Enter adds a line, Esc cancels.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="grip"></i><span class="settings-help-key">${tr('helpLineGrips', 'Select a line')}</span><span>${tr('helpLineGripsDesc', 'Orange square grips appear at each end. Click one, move, click again to reposition (snaps to nearby points).')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="pencil"></i><span class="settings-help-key">${tr('helpPropText', 'Text content field')}</span><span>${tr('helpPropTextDesc', 'Selected text can also be edited in the Properties panel; Apply or Ctrl+Enter to commit.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="trash-2"></i><span class="settings-help-key">${tr('helpDeleteKey', 'Delete / Backspace')}</span><span>${tr('helpDeleteDesc', 'Permanently remove selected entities from the drawing.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="save"></i><span class="settings-help-key">${tr('helpSaveKey', 'Save / Ctrl+S')}</span><span>${tr('helpSaveDesc', 'Download the edited drawing as a new DXF file.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="keyboard"></i><span class="settings-help-key">${tr('helpEscape', 'Escape')}</span><span>${tr('helpEscapeAreaSelect', 'Closes an open panel, then cancels an area selection, an active tool or a text edit.')}</span></li>
            </ul>
            <div class="settings-section-title">${tr('settingsHelpTools', 'Tools')}</div>
            <ul class="settings-help-list">
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="ruler"></i><span class="settings-help-key">${tr('measureTitle', 'Measure')}</span><span>${tr('helpMeasureDesc', 'Pick two snapped points to place a distance label.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="hammer"></i><span class="settings-help-key">${tr('hammerTitle', 'Hammer')}</span><span>${tr('helpHammerDesc', 'Click inside a room-like area to cast X/Y dimensions to nearby lines. Each click replaces the previous Quick result.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="layers"></i><span class="settings-help-key">${tr('cadLayersTitle', 'CAD Layers')}</span><span>${tr('helpLayersDesc', 'Toggle layers, inspect counts and override layer colours.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="list-collapse"></i><span class="settings-help-key">${tr('layerStatesTitle', 'Visibility states')}</span><span>${tr('helpLayerStatesDesc', 'Open the collapsible area in CAD Layers to save, restore, update, rename, or delete named layer visibility states.')}</span></li>
            </ul>
            <div class="settings-section-title">${tr('settingsHelpDrawing', 'Drawing')}</div>
            <ul class="settings-help-list">
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="pencil-line"></i><span class="settings-help-key">${tr('helpDrawLine', 'Line')}</span><span>${tr('helpDrawLineDesc', 'Click start and end; lines chain from the last point. Esc stops the chain.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="waypoints"></i><span class="settings-help-key">${tr('helpDrawPolyline', 'Polyline')}</span><span>${tr('helpDrawPolylineDesc', 'Click vertices; Enter finishes open, C closes the shape, Esc cancels. An existing polyline can be closed or re-opened later from the Properties panel, and selecting two or more open polylines or lines that share endpoints offers Join.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="square"></i><span class="settings-help-key">${tr('helpDrawRect', 'Rectangle')}</span><span>${tr('helpDrawRectDesc', 'Click one corner, then the opposite corner.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="radius"></i><span class="settings-help-key">${tr('helpDrawCircleArc', 'Circle / Arc')}</span><span>${tr('helpDrawCircleArcDesc', 'Circle: center then radius. Arc: start, a point on the arc, then end.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="hash"></i><span class="settings-help-key">${tr('helpDrawNumeric', 'Type a length')}</span><span>${tr('helpDrawNumericDesc', 'While drawing a line, polyline or circle, type a number to set the exact length/radius; direction follows the cursor.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="move"></i><span class="settings-help-key">${tr('helpOpsMove', 'Move / Rotate / Scale')}</span><span>${tr('helpOpsMoveDesc', 'Select objects first, then pick the operation. Click the base point, then click or type the distance / degrees / factor in the console.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="flip-horizontal-2"></i><span class="settings-help-key">${tr('helpOpsMirror', 'Mirror')}</span><span>${tr('helpOpsMirrorDesc', 'Two clicks define the mirror axis; mirrored copies are created and the originals are kept.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="sticky-note-plus"></i><span class="settings-help-key">${tr('helpViewport', 'Viewport frame')}</span><span>${tr('helpViewportDesc', 'In paper space: two corners create a frame fitted to the model. Select it to set the scale (1:n) or drag the center diamond to pan the view.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="fullscreen"></i><span class="settings-help-key">${tr('helpViewportEdit', 'Edit frame view')}</span><span>${tr('helpViewportEditDesc', 'Double-click inside a frame: the sheet stays put while drag pans and the wheel zooms the model view inside it. Esc applies.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="lock"></i><span class="settings-help-key">${tr('helpLayerLock', 'Layer lock')}</span><span>${tr('helpLayerLockDesc', 'The lock icon beside each layer color makes it reference-only: toned-down, unselectable and undraw-able, but still snappable.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="layout-grid"></i><span class="settings-help-key">${tr('helpLayouts', 'Paper spaces')}</span><span>${tr('helpLayoutsDesc', 'The + button in the bottom bar adds a paper space; hover a tab to rename or delete it (entities can be moved to another layout).')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="move-diagonal"></i><span class="settings-help-key">${tr('helpOrtho', 'Ortho (F8)')}</span><span>${tr('helpOrthoDesc', 'Constrains drawing, moves/copies and grip drags to horizontal/vertical. Snap points still win.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="rotate-ccw"></i><span class="settings-help-key">${tr('helpRepeat', 'Space')}</span><span>${tr('helpRepeatDesc', 'Repeats the last drawing, transform or modify command. While a tool is running it acts as Enter, finishing the current shape.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="copy"></i><span class="settings-help-key">${tr('helpCopy', 'Copy')}</span><span>${tr('helpCopyDesc', 'Like Move but keeps the original, works on viewport frames too.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="scissors"></i><span class="settings-help-key">${tr('helpTrimExtend', 'Trim / Extend')}</span><span>${tr('helpTrimExtendDesc', 'Trim: click the span of a line, polyline, circle or arc to remove between intersections. A trimmed circle becomes an arc, and an arc cut in the middle becomes two. Extend: pick a boundary, then click lines near the endpoint to extend to it.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="tally-4"></i><span class="settings-help-key">${tr('helpLinetype', 'Linetype & weight')}</span><span>${tr('helpLinetypeDesc', 'Dashed/dotted patterns render and save per layer (set in the color popup); lineweight is saved to the file (screen lines stay 1px).')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="unfold-horizontal"></i><span class="settings-help-key">${tr('helpDimensions', 'Dimensions')}</span><span>${tr('helpDimensionsDesc', 'Click a linear or aligned dimension to select its connected inline chain. Drag the diamond grip to move their dimension lines together, or use Move for the whole selection. Shift-click one dimension to select and move it independently, or Shift-click the shared diamond to move only its dimension. Alt-click also selects one dimension.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="file-plus-2"></i><span class="settings-help-key">${tr('helpNewDrawing', 'New drawing')}</span><span>${tr('helpNewDrawingDesc', 'Start from scratch with clean units (mm/cm/m/inch); the origin shows as a red X / green Y marker (toggle in settings).')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="file-input"></i><span class="settings-help-key">${tr('helpPdfImport', 'PDF import')}</span><span>${tr('helpPdfImportDesc', 'Drop a PDF onto an open drawing to bring in its vector linework. Pick a page, then click two points of a known distance to set the scale. Text comes across when the PDF still holds it as text, onto its own layer. Linework is reassembled on the way in, arcs recovered, duplicate paths dropped, touching segments welded into polylines. Scanned (image-only) PDFs have nothing to import.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="shield-check"></i><span class="settings-help-key">${tr('helpSanitize', 'Sanitize')}</span><span>${tr('helpSanitizeDesc', 'Left rail, shield icon: fix structural issues that make AutoCAD reject a file, and clean geometry: stray slivers, duplicate objects and overlapping collinear lines (OV / OVERKILL), across the whole drawing or only on layers you pick.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="paintbrush"></i><span class="settings-help-key">${tr('helpHatch', 'Hatches')}</span><span>${tr('helpHatchDesc', 'Imported fills and patterns render with their islands cut out. Click inside a fill to select it; delete and layer moves work like any entity. To create one, select closed shapes (a shape inside another becomes an island) and use the brush button to pick a pattern, scale and angle.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="shapes"></i><span class="settings-help-key">${tr('helpBlocks', 'Blocks')}</span><span>${tr('helpBlocksDesc', 'The Block Library tab in the left sidebar shows every block with a preview: insert (with scale/rotation), edit in place, rename, or delete unused ones. Editing a block updates every insertion of it at once. Select geometry and “Create block from selection” to make a new one; with an insertion selected, Explode in its properties breaks it into editable objects.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="copy-plus"></i><span class="settings-help-key">${tr('helpModify2', 'Offset · Fillet · Chamfer')}</span><span>${tr('helpModify2Desc', 'Offset copies a line/arc/circle/polyline parallel at a set distance (click the side). Fillet rounds a corner between two lines with a radius; chamfer bevels it. Both also work on two adjoining straight edges of one polyline, and the new geometry takes the layer of the first thing you clicked. Set the number in the toolbar field before clicking.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="undo-2"></i><span class="settings-help-key">${tr('helpUndo', 'Undo / redo')}</span><span>${tr('helpUndoDesc', 'Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes (Cmd on Mac), or use the toolbar arrows, which name the step. Covers drawing, editing, layers, layouts and dimensions; view settings like layer visibility are not part of history.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="mouse-pointer-click"></i><span class="settings-help-key">${tr('helpCtrlSelect', 'Ctrl+click')}</span><span>${tr('helpCtrlSelectDesc', 'Hold Ctrl (Cmd on Mac) and click to add or remove objects from the selection, shared properties appear when the selection is all texts or all dimensions.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="type"></i><span class="settings-help-key">${tr('helpTextStyle', 'Text style')}</span><span>${tr('helpTextStyleDesc', 'Select a text to change its size, font and alignment in the Properties panel. Fonts are a viewer setting; size and alignment save to the DXF.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="frame"></i><span class="settings-help-key">${tr('helpVpFreeze', 'Frame layers')}</span><span>${tr('helpVpFreezeDesc', 'Each viewport frame has its own layer toggles (in its Properties), independent per frame, saved as VP-freeze.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="type"></i><span class="settings-help-key">${tr('helpDrawText', 'MTEXT')}</span><span>${tr('helpDrawTextDesc', 'Click a point and type. Enter commits; Shift+Enter adds another line. The TEXT command creates single-line text.')}</span></li>
                <li class="settings-help-row"><i class="settings-help-icon" data-lucide="layers"></i><span class="settings-help-key">${tr('helpDrawLayer', 'Layer picker')}</span><span>${tr('helpDrawLayerDesc', 'New entities are placed on the layer selected in the toolbar dropdown.')}</span></li>
            </ul>
            <button type="button" id="settings-reset-view" class="settings-help-reset"><i data-lucide="focus"></i><span>${tr('fitDrawingToScreen', 'Fit drawing to screen')}</span></button>
        `;
    }


    return { options, drawing, help };
});
