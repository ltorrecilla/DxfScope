/**
 * test_ellipse.js — ellipse tool through the draw machine + host commit,
 * then round-trip through the emitter.
 */
const assert = require('assert');
const { loadViewerPage } = require('./test_harness.js');
const Draw = require('./dxf_tool_draw.js');
const Emit = require('./dxf_emit.js');

// ===== Machine-level: 3 clicks commit the right spec =====
{
    let committed = null;
    const m = Draw.create({ onCommit: s => committed = s });
    m.start('ellipse');
    m.handleClick({ x: 10, y: 10 });                 // center
    m.handleClick({ x: 30, y: 10 });                 // major end (len 20 along +X)
    m.handleClick({ x: 10, y: 18 });                 // pick 8 above center -> ratio 0.4
    assert.ok(committed, 'commit fired');
    assert.strictEqual(committed.kind, 'ellipse');
    assert(Math.abs(committed.ratio - 0.4) < 1e-9, 'ratio should be 0.4, got ' + committed.ratio);
    assert.strictEqual(committed.center.x, 10);
    assert.strictEqual(committed.majorEnd.x, 30);
    console.log('machine ellipse commit: PASS');
}

// ===== Ratio clamps to (0,1] =====
{
    let committed = null;
    const m = Draw.create({ onCommit: s => committed = s });
    m.start('ellipse');
    m.handleClick({ x: 0, y: 0 });
    m.handleClick({ x: 10, y: 0 });
    m.handleClick({ x: 0, y: 50 });                  // perp 50 > major 10 -> clamp 1
    assert.strictEqual(committed.ratio, 1);
    console.log('ratio clamp: PASS');
}

// ===== Host commit produces a well-formed ELLIPSE entity =====
{
    const TAIL = `window.__t.hook = { setDxf(v){currentDxf=v;}, drawTools() { return drawTools; } };`;
    const page = loadViewerPage({ tail: TAIL });
    const fatal = page.errors.filter(e => !/canvas|WebGL|not implemented/i.test(String(e && e.message)));
    assert.strictEqual(fatal.length, 0, 'page load errors: ' + fatal.map(e => e && e.message).join(' | '));
    const h = page.win.__t.hook;
    const dxf = { entities: [], blocks: {}, tables: { layer: { layers: { '0': { name: '0' } } } }, header: {} };
    h.setDxf(dxf);
    const dt = h.drawTools();
    dt.start('ellipse');
    dt.handleClick({ x: 5, y: 5 });
    dt.handleClick({ x: 15, y: 5 });
    dt.handleClick({ x: 5, y: 8 });
    const e = dxf.entities.find(x => x.type === 'ELLIPSE');
    assert.ok(e, 'ELLIPSE entity created');
    assert.strictEqual(e.center.x, 5);
    assert(Math.abs(e.majorAxisEndPoint.x - 10) < 1e-9, 'major end must be RELATIVE (+10,0)');
    assert(Math.abs(e.majorAxisEndPoint.y) < 1e-9);
    assert(Math.abs(e.axisRatio - 0.3) < 1e-9, 'ratio 3/10');
    // Emitter accepts it (colour/layer path).
    const pairs = Emit.emitEntity(e, '0', () => 'AB');
    assert.ok(pairs && pairs.includes('ELLIPSE'), 'emitter must serialize the ellipse');
    assert.ok(pairs.includes('AcDbEllipse'));
    console.log('host ellipse commit + emit: PASS');
}

console.log('ALL ELLIPSE TESTS PASS');
