/**
 * test_lengthen.js — drive the LENGTHEN tool end-to-end in jsdom.
 */
const assert = require('assert');
const { loadViewerPage } = require('./test_harness.js');

const TAIL = `
window.__t.hook = {
    setDxf(v) { currentDxf = v; },
    startModifyTool, handleLengthenClick,
    setPicker(fn) { pickEntityAtPoint = fn; },
    registry() { return editRegistry; },
};`;

function freshPage() {
    const page = loadViewerPage({ tail: TAIL });
    const fatal = page.errors.filter(e => !/canvas|WebGL|not implemented/i.test(String(e && e.message)));
    assert.strictEqual(fatal.length, 0, 'page load errors: ' + fatal.map(e => e && e.message).join(' | '));
    return page;
}

function makeDxf(entities) {
    return { entities, blocks: {}, tables: { layer: { layers: { '0': { name: '0' } } } }, header: {} };
}

// ===== LINE: extend the far end by 5 =====
{
    const { win } = freshPage();
    const h = win.__t.hook;
    const line = { type: 'LINE', layer: '0', __rawKey: 'H1', vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
    h.setDxf(makeDxf([line]));
    h.setPicker(() => line);
    h.startModifyTool('lengthen');
    win.document.getElementById('modify-param').value = '5';
    h.handleLengthenClick({ x: 9.5, y: 0 });   // near end b
    assert(Math.abs(line.vertices[1].x - 15) < 1e-9, 'end should move to 15, got ' + line.vertices[1].x);
    assert.ok(h.registry().geometryEditsByHandle.get('H1'), 'line edit not recorded for save');
    console.log('line lengthen (extend end): PASS');
}

// ===== LINE: shorten from the start by 3 =====
{
    const { win } = freshPage();
    const h = win.__t.hook;
    const line = { type: 'LINE', layer: '0', __rawKey: 'H2', vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
    h.setDxf(makeDxf([line]));
    h.setPicker(() => line);
    h.startModifyTool('lengthen');
    win.document.getElementById('modify-param').value = '-3';
    h.handleLengthenClick({ x: 0.5, y: 0 });   // near start a
    assert(Math.abs(line.vertices[0].x - 3) < 1e-9, 'start should move to 3, got ' + line.vertices[0].x);
    console.log('line lengthen (shorten start): PASS');
}

// ===== LINE: vanish guard leaves geometry untouched =====
{
    const { win } = freshPage();
    const h = win.__t.hook;
    const line = { type: 'LINE', layer: '0', __rawKey: 'H3', vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
    h.setDxf(makeDxf([line]));
    h.setPicker(() => line);
    h.startModifyTool('lengthen');
    win.document.getElementById('modify-param').value = '-10';
    h.handleLengthenClick({ x: 9.5, y: 0 });
    assert(Math.abs(line.vertices[1].x - 10) < 1e-9, 'line must be untouched on vanish guard');
    console.log('line lengthen (vanish guard): PASS');
}

// ===== ARC: extend end by quarter-circumference =====
{
    const { win } = freshPage();
    const h = win.__t.hook;
    const arc = { type: 'ARC', layer: '0', __rawKey: 'H4', center: { x: 0, y: 0 }, radius: 10,
        startAngle: 0, endAngle: Math.PI / 2 };
    const dxf = makeDxf([arc]);
    h.setDxf(dxf);
    h.setPicker(() => arc);
    h.startModifyTool('lengthen');
    win.document.getElementById('modify-param').value = String(Math.PI * 10 / 2); // quarter circumference
    h.handleLengthenClick({ x: 0, y: 10 });    // near the 90-degree end
    assert.strictEqual(dxf.entities.length, 1, 'arc re-emitted as one entity');
    const out = dxf.entities[0];
    assert.strictEqual(out.type, 'ARC');
    assert(Math.abs(out.endAngle - Math.PI) < 1e-9, 'end angle should be 180deg, got ' + out.endAngle);
    assert(Math.abs(out.startAngle) < 1e-9, 'start angle should stay 0');
    console.log('arc lengthen: PASS');
}

console.log('ALL LENGTHEN TESTS PASS');
