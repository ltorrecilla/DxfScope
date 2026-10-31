/**
 * test_smoke.js — pre-deployment sanity check for DXF_Viewer.html.
 *
 * Loads the page through test_harness.js and asserts it still boots: zero
 * load errors, every helper module present, no duplicate function
 * declarations, and every wired feature still wired. The broad smoke test the
 * other test_*.js files sit above.
 *
 * Runs the page's whole module body in jsdom against Universal-Proxy stubs, so
 * TDZ crashes ("Cannot access 'x' before initialization"), missing references
 * and other startup errors surface here rather than in the browser. Also greps
 * the source for duplicate function declarations — the recurring failure mode
 * when patches are applied by string replacement.
 *
 *   node test_smoke.js
 */
const fs = require('fs');
const path = require('path');
const { loadViewerPage } = require('./test_harness.js');

const HTML = path.join(__dirname, 'DXF_Viewer.html');
const { win, errors, executed, inlineCount, moduleRan } = loadViewerPage({ root: __dirname });

const msg = (e) => String((e && e.message) || e).split('\n')[0];
const tdz = errors.filter(e => /before initialization/i.test(msg(e)));
const undef = errors.filter(e => /is not defined/i.test(msg(e)));

console.log(`module body executed   : ${moduleRan ? 'yes' : 'NO'}`);
console.log(`other inline blocks    : ${executed}/${inlineCount}`);
console.log(`helper modules         : DxfHatch=${!!win.DxfHatch} DxfDim=${!!win.DxfDim} DxfEmit=${!!win.DxfEmit} DxfSanitize=${!!win.DxfSanitize}`);
console.log(`TDZ errors             : ${tdz.length}`);
console.log(`undefined references   : ${undef.length}`);
console.log(`total errors           : ${errors.length}`);
for (const e of errors.slice(0, 12)) console.log('  ! ' + msg(e));

// ---- module APIs the page depends on ----------------------------------------
const need = {
    DxfHatch: ['hatchAnchors', 'setHatchAnchor', 'hatchStraightSegments',
               'hatchCircleEdges', 'setHatchCircleRadius', 'translateHatch',
               'buildHatchLoops', 'emitHatchPairs', 'makeHatchFromEntities'],
    DxfDim: ['buildDimGeometry', 'synthesizeFromEntity', 'emitDimensionPairs'],
    DxfEmit: ['emitEntity', 'entityStyleOpts'],
    DxfOpsEdit: ['create', 'rotateEntity', 'scaleEntity', 'rotatePoint'],
    DxfPdfImport: ['extractEntities', 'buildSubpaths', 'matMul', 'parseColor', 'entitiesBounds',
                   'optimizeEntities', 'fitArcBulge', 'weldChains', 'dedupeEntities', 'mergeCollinear',
                   'textToEntities', 'pageBaseMatrix'],
    DxfToolModify: ['filletLines', 'chamferLines', 'sharedCornerIndex', 'polylineCornerCut',
                    'reverseChain', 'joinChains', 'segCircleAngles',
                    'computeCircleTrim', 'computeArcTrim', 'bulgeArc',
                    'computePolylineTrim', 'extractPolylineRun'],
};
let apiOk = true;
for (const [mod, fns] of Object.entries(need)) {
    const missing = fns.filter(f => typeof win[mod]?.[f] !== 'function');
    if (missing.length) { apiOk = false; console.log(`  ! ${mod} missing: ${missing.join(', ')}`); }
}
console.log(`module APIs            : ${apiOk ? 'complete' : 'INCOMPLETE'}`);

// ---- wiring the page is expected to contain ---------------------------------
const pageSrc = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n');
const wiring = {
    'hatch grip branch': "if (src.type === 'HATCH') {",
    'hatch in grip gate': "srcType === 'HATCH'",
    'hatch grip predicate': 'function isHatchGrip(',
    'hatch trial paths': 'function hatchTrialPaths(',
    'hatch preview': 'function previewHatchPaths(',
    'hatch commit': 'function commitHatchGeometry(',
    'loop cache reset on undo': '__hatchLoopCache = new WeakMap();\n            clearSelection();',
    'ink-anchored dim text': '__inkAnchor: true,',
    'ink anchoring in sprite': 'tNode.__inkAnchor && inkTop !== null',
    'zero gap accepted': 'Number.isFinite(v) && v >= 0',
    'polyline span picking': 'function polylineSpanAtPoint(',
    'polyline corner rewrite': 'function patchPolylineWholeBlock(',
    'polyline rewrite recorded': 'function recordPolylineRewrite(',
    'polyline rewrite dispatched': "edits.type === 'polyline'",
    'fillet arc keeps source layer': 'endAngle: res.arc.endDeg * Math.PI / 180 },\n                    { keepLayer: true });',
    'chamfer bevel keeps source layer': 'res.bevel.b.y, z: 0 }] },\n                    { keepLayer: true });',
    'offset keeps source layer': 'registerNewEntity(created, { keepLayer: true });',
    'bulge survives transform': 'if (bulge) p.bulge = bulge * bulgeSign;',
    'space repeats last command': 'function repeatLastCommand(',
    'space acts as enter': "event.key === 'Enter' || event.key === ' '",
    'commands are remembered': "rememberCommand('draw', toolName);",
    'panels clear the toolbar': '#inspector-panel, #block-library { top: var(--draw-toolbar-h, 0px); }',
    'toolbar height tracked': 'function trackToolbarHeight(',
    'polyline section markup': 'id="prop-poly-section"',
    'polyline section logic': 'function populatePolylineSection(',
    'polyline close applies': 'function setPolylinesClosed(',
    'area select anchored in world': 'areaSelectAnchor = { x: target.x, y: target.y };',
    'area select box re-projected': 'if (isAreaSelecting) drawAreaSelectBox();',
    'pan does not cancel selection': 'areaSelectPanProbe',
    'escape closes popups': 'function closeOpenPopups(',
    'escape checked before tools': "if (event.key === 'Escape' && closeOpenPopups())",
    'shared delete helper': 'function deleteEntities(entities) {',
    'join button markup': 'id="btn-poly-join"',
    'join applies': 'function joinSelectedPolylines(',
    'join reuses delete': 'deleteEntities(consumed);',
    'circle trim routed': "if (src.type === 'CIRCLE' || src.type === 'ARC') { trimCircularEntity(",
    'circle trim handler': 'function trimCircularEntity(',
    'circle cut gathering': 'function gatherCircleCutAngles(',
    'polyline trim routed': "if (src.type === 'LWPOLYLINE') { trimPolylineEntity(",
    'polyline trim handler': 'function trimPolylineEntity(',
    'shared cutter gathering': 'function gatherCutterSegments(',
    'selection modifier mapping': 'function selectionModeFromEvent(',
    'add to selection': 'function addToSelection(',
    'remove from selection': 'function removeFromSelection(',
    'area box inherits the mode': 'applySelectionMode(areaSelectMode, results);',
    'previous selection restore': 'function restorePreviousSelection(',
    'previous selection button': 'id="btn-select-previous"',
    'block library toggles': 'openBlockLibrary();                 // no argument = toggle',
    'rename block icon': "mkBtn('whole-word'",
    'pdf importer script tag': 'src="../js/dxf/dxf_pdf_import.js"',
    'pdf page picker': 'id="pdf-import-modal"',
    'pdf routed from processFile': 'openPdfImport(file); return;',
    'pdf lazy load': 'await import(/* webpackIgnore: true */ url)',
    'pdf worker same-origin': "lib.GlobalWorkerOptions.workerSrc = url.replace(",
    'pdf calibration': 'function handlePdfCalibrateClick(',
    'pdf reassembly toggle': 'id="pdf-import-tidy"',
    'pdf reassembly runs': 'S.optimizeEntities(result.entities',
    'pdf import toolbar button': 'id="btn-import-pdf"',
    'pdf dedicated picker': 'id="pdfFileInput"',
    'pdf canvas drop': 'function enableCanvasPdfDrop(',
    'pdf text toggle': 'id="pdf-import-text"',
    'pdf text extraction': 'S.textToEntities(await page.getTextContent()',
    'created entities carry style': 'E.entityStyleOpts(',
    'rotated text corners': 'sprite.userData.__worldCorners = corners;',
    'rotated text frame': 'function pointInTextFrame(',
    'shared text outline': 'function textBoundsEdges(',
    'text transform preview': 'function entityPreviewSegments(',
    'ops preview uses it': 'for (const seg of entityPreviewSegments(src)) opsBaseSegments.push(seg);',
    'rotate reference key': 'function opsToolToggleReference(',
    'rotate reference vector drawn': 'function opsReferenceVector(',
};
let wiringOk = true;
for (const [label, needle] of Object.entries(wiring)) {
    if (!pageSrc.includes(needle)) { wiringOk = false; console.log(`  ! wiring missing: ${label}`); }
}
console.log(`viewer wiring          : ${wiringOk ? 'complete' : 'INCOMPLETE'}`);

// ---- duplicate-declaration guard (the str_replace seam failure mode) --------
const names = [...pageSrc.matchAll(/\n\s*function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
const counts = names.reduce((a, n) => (a[n] = (a[n] || 0) + 1, a), {});
const repeated = Object.entries(counts).filter(([, c]) => c > 1);
console.log(`duplicate functions    : ${repeated.length ? repeated.map(([n, c]) => `${n}x${c}`).join(', ') : 'none'}`);

const fatal = !moduleRan || errors.length || !apiOk || !wiringOk || repeated.length;
console.log(fatal ? '\nFAIL' : '\nPASS');
process.exit(fatal ? 1 : 0);
