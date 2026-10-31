/**
 * test_spline.js — spline tool through the machine and host, plus emitter
 * round-trip via the entity produced.
 */
const assert = require('assert');
const { loadViewerPage } = require('./test_harness.js');
const Draw = require('./dxf_tool_draw.js');
const Emit = require('./dxf_emit.js');

// ===== Machine: clicks + Enter commit the fit points =====
{
    let committed = null;
    const m = Draw.create({ onCommit: s => committed = s });
    m.start('spline');
    m.handleClick({ x: 0, y: 0 });
    m.handleClick({ x: 10, y: 8 });
    m.handleClick({ x: 20, y: -3 });
    m.handleClick({ x: 30, y: 5 });
    m.handleEnter();
    assert.ok(committed, 'commit fired on Enter');
    assert.strictEqual(committed.kind, 'spline');
    assert.strictEqual(committed.points.length, 4);
    console.log('machine spline commit: PASS');
}

// ===== Machine: fewer than 3 points does not commit =====
{
    let committed = null;
    const m = Draw.create({ onCommit: s => committed = s });
    m.start('spline');
    m.handleClick({ x: 0, y: 0 });
    m.handleClick({ x: 10, y: 0 });
    m.handleEnter();
    assert.strictEqual(committed, null, '2 points must not commit a spline');
    console.log('min-points guard: PASS');
}

// ===== Host: entity created, renderable, emittable =====
{
    const TAIL = `window.__t.hook = { setDxf(v){currentDxf=v;}, drawTools(){ return drawTools; } };`;
    const page = loadViewerPage({ tail: TAIL });
    const fatal = page.errors.filter(e => !/canvas|WebGL|not implemented/i.test(String(e && e.message)));
    assert.strictEqual(fatal.length, 0, 'page load errors: ' + fatal.map(e => e && e.message).join(' | '));
    const h = page.win.__t.hook;
    const dxf = { entities: [], blocks: {}, tables: { layer: { layers: { '0': { name: '0' } } } }, header: {} };
    h.setDxf(dxf);
    const dt = h.drawTools();
    dt.start('spline');
    dt.handleClick({ x: 0, y: 0 });
    dt.handleClick({ x: 10, y: 10 });
    dt.handleClick({ x: 20, y: 0 });
    dt.handleEnter();
    const e = dxf.entities.find(x => x.type === 'SPLINE');
    assert.ok(e, 'SPLINE entity created');
    assert.strictEqual(e.fitPoints.length, 3);
    assert.strictEqual(e.degree, 2);
    // Emitter serializes it with knots + control points + fit points.
    const pairs = Emit.emitEntity(e, '0', () => 'AC');
    assert.ok(pairs.includes('AcDbSpline'));
    assert.strictEqual(pairs[pairs.indexOf('74') + 1], '3', 'fit point count');
    assert.strictEqual(pairs[pairs.indexOf('71') + 1], '2', 'degree from 3 points');
    console.log('host spline commit + emit: PASS');
}

console.log('ALL SPLINE TESTS PASS');
