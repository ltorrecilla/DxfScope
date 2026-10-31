/**
 * test_break.js — drive the BREAK tool end-to-end in jsdom.
 * Line split, circle→arc, arc split, open polyline split, closed polyline open.
 */
const assert = require('assert');
const { loadViewerPage } = require('./test_harness.js');

const TAIL = `
window.__t.hook = {
    setDxf(v) { currentDxf = v; },
    getDxf() { return currentDxf; },
    startModifyTool, handleBreakClick,
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

// ===== LINE split =====
{
    const { win } = freshPage();
    const h = win.__t.hook;
    const line = { type: 'LINE', layer: '0', __rawKey: 'H1', vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
    const dxf = makeDxf([line]);
    h.setDxf(dxf);
    h.setPicker(() => line);
    h.startModifyTool('break');
    h.handleBreakClick({ x: 3, y: 0 });
    h.handleBreakClick({ x: 7, y: 0 });
    assert.strictEqual(dxf.entities.length, 2, 'line should split into two');
    assert(Math.abs(line.vertices[1].x - 3) < 1e-9, 'kept part must end at 3');
    const part = dxf.entities[1];
    assert(Math.abs(part.vertices[0].x - 7) < 1e-9 && Math.abs(part.vertices[1].x - 10) < 1e-9, 'new part 7..10');
    // Persistence: original patched, part registered
    assert.ok(h.registry().geometryEditsByHandle.get('H1'), 'geometry edit not recorded');
    assert.ok(h.registry().createdEntities.includes(part), 'new part not registered');
    console.log('line break: PASS');
}

// ===== CIRCLE becomes ARC =====
{
    const { win } = freshPage();
    const h = win.__t.hook;
    const circ = { type: 'CIRCLE', layer: '0', __rawKey: 'H2', center: { x: 0, y: 0 }, radius: 5 };
    const dxf = makeDxf([circ]);
    h.setDxf(dxf);
    h.setPicker(() => circ);
    h.startModifyTool('break');
    h.handleBreakClick({ x: 5, y: 0 });    // 0 deg
    h.handleBreakClick({ x: 0, y: 5 });    // 90 deg
    assert.strictEqual(dxf.entities.length, 1, 'circle replaced by one arc');
    const arc = dxf.entities[0];
    assert.strictEqual(arc.type, 'ARC');
    const T = Math.PI * 2, norm = a => ((a % T) + T) % T;
    assert(Math.abs(norm(arc.startAngle) - Math.PI / 2) < 1e-9, 'arc starts at 90deg');
    assert(Math.abs(norm(arc.endAngle)) < 1e-9, 'arc ends at 0deg');
    console.log('circle break: PASS');
}

// ===== ARC split into two =====
{
    const { win } = freshPage();
    const h = win.__t.hook;
    const arc = { type: 'ARC', layer: '0', __rawKey: 'H3', center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI };
    const dxf = makeDxf([arc]);
    h.setDxf(dxf);
    h.setPicker(() => arc);
    h.startModifyTool('break');
    const at = a => ({ x: 5 * Math.cos(a), y: 5 * Math.sin(a) });
    h.handleBreakClick(at(Math.PI / 4));
    h.handleBreakClick(at(Math.PI / 2));
    assert.strictEqual(dxf.entities.length, 2, 'arc split in two');
    assert.strictEqual(dxf.entities[0].type, 'ARC');
    assert.strictEqual(dxf.entities[1].type, 'ARC');
    console.log('arc break: PASS');
}

// ===== Open polyline split =====
{
    const { win } = freshPage();
    const h = win.__t.hook;
    const pl = { type: 'LWPOLYLINE', layer: '0', __rawKey: 'H4', closed: false, shape: false,
        vertices: [{ x: 0, y: 0, bulge: 0 }, { x: 10, y: 0, bulge: 0 }, { x: 20, y: 0, bulge: 0 }] };
    const dxf = makeDxf([pl]);
    h.setDxf(dxf);
    h.setPicker(() => pl);
    h.startModifyTool('break');
    h.handleBreakClick({ x: 4, y: 0 });
    h.handleBreakClick({ x: 15, y: 0 });
    assert.strictEqual(dxf.entities.length, 2, 'open polyline split into two runs');
    assert(Math.abs(pl.vertices.at(-1).x - 4) < 1e-9, 'first run ends at 4');
    const part = dxf.entities[1];
    assert(Math.abs(part.vertices[0].x - 15) < 1e-9, 'second run starts at 15');
    console.log('open polyline break: PASS');
}

// ===== Closed polyline opens =====
{
    const { win } = freshPage();
    const h = win.__t.hook;
    const pl = { type: 'LWPOLYLINE', layer: '0', __rawKey: 'H5', closed: true, shape: true,
        vertices: [{ x: 0, y: 0, bulge: 0 }, { x: 10, y: 0, bulge: 0 }, { x: 10, y: 10, bulge: 0 }, { x: 0, y: 10, bulge: 0 }] };
    const dxf = makeDxf([pl]);
    h.setDxf(dxf);
    h.setPicker(() => pl);
    h.startModifyTool('break');
    h.handleBreakClick({ x: 5, y: 0 });
    h.handleBreakClick({ x: 10, y: 5 });
    assert.strictEqual(dxf.entities.length, 1, 'closed polyline stays one entity');
    assert.strictEqual(!!pl.closed, false, 'polyline must be open after break');
    console.log('closed polyline break: PASS');
}

console.log('ALL BREAK TESTS PASS');
