/**
 * test_stretch.js — STRETCH end-to-end in jsdom: no-selection capture,
 * 4-click flow, partial line move with correct coordinate patch, polyline
 * rewrite, rigid circle translate.
 */
const assert = require('assert');
const { loadViewerPage } = require('./test_harness.js');

const TAIL = `
window.__t.hook = {
    setDxf(v) { currentDxf = v; },
    setSelection(v) { selectedEntities = v; },
    startOpsTool,
    opsTools() { return opsTools; },
    registry() { return editRegistry; },
};`;

function freshPage() {
    const page = loadViewerPage({ tail: TAIL });
    const fatal = page.errors.filter(e => !/canvas|WebGL|not implemented/i.test(String(e && e.message)));
    assert.strictEqual(fatal.length, 0, 'page load errors: ' + fatal.map(e => e && e.message).join(' | '));
    return page;
}

{
    const { win } = freshPage();
    const h = win.__t.hook;
    const line = { type: 'LINE', layer: '0', __rawKey: 'L1', vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }] };
    const poly = { type: 'LWPOLYLINE', layer: '0', __rawKey: 'P1', closed: false,
        vertices: [{ x: 0, y: 10, bulge: 0 }, { x: 20, y: 10, bulge: 0 }, { x: 20, y: 30, bulge: 0 }] };
    const circ = { type: 'CIRCLE', layer: '0', __rawKey: 'C1', center: { x: 18, y: 5 }, radius: 2 };
    const far = { type: 'LINE', layer: '0', __rawKey: 'F1', vertices: [{ x: 100, y: 100 }, { x: 110, y: 100 }] };
    const dxf = { entities: [line, poly, circ, far], blocks: {},
        tables: { layer: { layers: { '0': { name: '0' } } } }, header: {} };
    h.setDxf(dxf);
    h.setSelection([]);                    // no selection: stretch must self-capture

    h.startOpsTool('stretch');
    const m = h.opsTools();
    assert.strictEqual(m.activeTool(), 'stretch', 'stretch tool must start without a selection');

    // Crossing box around x in [15,25], y in [-5,15]: catches line end (20,0),
    // poly vertex (20,10), circle center (18,5). Poly vertex (20,30) stays out.
    m.handleClick({ x: 15, y: -5 });
    m.handleClick({ x: 25, y: 15 });
    m.handleClick({ x: 0, y: 0 });        // base
    m.handleClick({ x: 5, y: 3 });        // destination: delta (5,3)

    // LINE: only the second endpoint moved, first untouched.
    assert.strictEqual(line.vertices[0].x, 0, 'line start must not move');
    assert(Math.abs(line.vertices[1].x - 25) < 1e-9 && Math.abs(line.vertices[1].y - 3) < 1e-9, 'line end moved by delta');
    // Persisted as a coordinate patch touching ONLY codes 11/21.
    const patch = h.registry().geometryEditsByHandle.get('L1');
    assert.ok(patch, 'line patch recorded');
    assert.strictEqual(patch['10'], undefined, 'unmoved endpoint must not be patched');
    assert(Math.abs(patch['11'] - 25) < 1e-9, 'moved endpoint patched');

    // POLYLINE: middle vertex moved, ends as expected.
    assert.strictEqual(poly.vertices[0].x, 0);
    assert(Math.abs(poly.vertices[1].x - 25) < 1e-9 && Math.abs(poly.vertices[1].y - 13) < 1e-9);
    assert.strictEqual(poly.vertices[2].y, 30, 'out-of-box vertex must stay');

    // CIRCLE: rigid move, radius untouched, translate transform recorded.
    assert(Math.abs(circ.center.x - 23) < 1e-9 && Math.abs(circ.center.y - 8) < 1e-9);
    assert.strictEqual(circ.radius, 2);
    const ct = h.registry().geometryEditsByHandle.get('C1');
    assert.strictEqual(ct.type, 'translate');
    assert.strictEqual(ct.dx, 5);

    // Far line untouched, nothing recorded.
    assert.strictEqual(far.vertices[0].x, 100);
    assert.strictEqual(h.registry().geometryEditsByHandle.get('F1'), undefined);

    // Tool exits after commit.
    assert.ok(!m.isActive(), 'stretch exits after commit');
    console.log('stretch end-to-end: PASS');
}

console.log('ALL STRETCH TESTS PASS');
