/**
 * test_radial_dim.js — drive radial + diameter dimensions end-to-end in jsdom.
 * Uses the commit path directly (canvas click routing is exercised by the
 * validation branch test).
 */
const assert = require('assert');
const { loadViewerPage } = require('./test_harness.js');

const TAIL = `
window.__t.hook = {
    setDxf(v) { currentDxf = v; },
    getDxf() { return currentDxf; },
    setRadialSource(v) { radialDimSource = v; },
    commitNewRadialDimension,
    registry() { return editRegistry; },
    emitDim(dim, h, layer, block) { return window.DxfDim.emitDimensionPairs(dim, h, layer, block); },
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

// ===== Radial dim on a circle =====
{
    const { win } = freshPage();
    const h = win.__t.hook;
    const circ = { type: 'CIRCLE', layer: '0', __rawKey: 'H1', center: { x: 0, y: 0 }, radius: 10 };
    const dxf = makeDxf([circ]);
    h.setDxf(dxf);
    h.setRadialSource(circ);
    h.commitNewRadialDimension({ x: 10, y: 0 }, { x: 20, y: 0 }, false); // place at 0deg
    const dim = dxf.entities.find(e => e.type === 'DIMENSION');
    assert.ok(dim, 'DIMENSION entity created');
    assert.strictEqual(dim.dimensionType, 32 | 4, 'radial type flag');
    assert.strictEqual(dim.actualMeasurement, 10);
    // Block graphics exist with R-prefixed text
    const blk = dxf.blocks[dim.block];
    assert.ok(blk, 'dim block registered');
    const txt = blk.entities.find(e => e.type === 'TEXT');
    assert.strictEqual(txt.text, 'R10');
    // Serialization dispatches to the radial emitter
    const pairs = h.emitDim(dim.__dim, 'FF', '0', dim.block);
    assert.ok(pairs.includes('AcDbRadialDimension'), 'emitter must write radial subclass');
    assert.strictEqual(pairs[pairs.indexOf('70') + 1], String(32 | 4));
    console.log('radial dim: PASS');
}

// ===== Diameter dim on an arc =====
{
    const { win } = freshPage();
    const h = win.__t.hook;
    const arc = { type: 'ARC', layer: '0', __rawKey: 'H2', center: { x: 5, y: 5 }, radius: 4,
        startAngle: 0, endAngle: Math.PI };
    const dxf = makeDxf([arc]);
    h.setDxf(dxf);
    h.setRadialSource(arc);
    h.commitNewRadialDimension({ x: 9, y: 5 }, { x: 5, y: 20 }, true); // place at 90deg
    const dim = dxf.entities.find(e => e.type === 'DIMENSION');
    assert.ok(dim, 'DIMENSION entity created');
    assert.strictEqual(dim.dimensionType, 32 | 3, 'diameter type flag');
    assert.strictEqual(dim.actualMeasurement, 8);
    const blk = dxf.blocks[dim.block];
    const txt = blk.entities.find(e => e.type === 'TEXT');
    assert.strictEqual(txt.text, '\u23008');
    // Geometry spans the circle: line from (5,1) to (5,9)
    const line = blk.entities.find(e => e.type === 'LINE');
    const ys = [line.vertices[0].y, line.vertices[1].y].sort((a, b) => a - b);
    assert(Math.abs(ys[0] - 1) < 1e-9 && Math.abs(ys[1] - 9) < 1e-9, 'diameter line spans the circle');
    // Two closed arrowhead polylines with tips on the circle
    const arrows = blk.entities.filter(e => e.type === 'LWPOLYLINE' && e.closed);
    assert.strictEqual(arrows.length, 2, 'diameter must have two arrowheads');
    const tipYs = arrows.map(a => a.vertices[0].y).sort((a, b) => a - b);
    assert(Math.abs(tipYs[0] - 1) < 1e-9 && Math.abs(tipYs[1] - 9) < 1e-9, 'arrow tips on the circle');
    const pairs = h.emitDim(dim.__dim, 'FE', '0', dim.block);
    assert.ok(pairs.includes('AcDbDiametricDimension'));
    console.log('diameter dim: PASS');
}

// ===== Guard: no source entity → no dimension =====
{
    const { win } = freshPage();
    const h = win.__t.hook;
    const dxf = makeDxf([]);
    h.setDxf(dxf);
    h.setRadialSource(null);
    h.commitNewRadialDimension({ x: 0, y: 0 }, { x: 1, y: 1 }, false);
    assert.strictEqual(dxf.entities.length, 0, 'no dim without a source entity');
    console.log('radial guard: PASS');
}

console.log('ALL RADIAL DIM TESTS PASS');
