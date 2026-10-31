/**
 * test_leader.js — leader host commit: arrowhead geometry, leader line,
 * text editor opened at the landing.
 */
const assert = require('assert');
const { loadViewerPage } = require('./test_harness.js');

const TAIL = `
window.__t.hook = {
    setDxf(v) { currentDxf = v; },
    commitNewLeader,
    textEditVisible() { return textEditInput && textEditInput.style.display === 'block'; },
};`;

const page = loadViewerPage({ tail: TAIL });
const fatal = page.errors.filter(e => !/canvas|WebGL|not implemented/i.test(String(e && e.message)));
assert.strictEqual(fatal.length, 0, 'page load errors: ' + fatal.map(e => e && e.message).join(' | '));
const h = page.win.__t.hook;

const dxf = { entities: [], blocks: {}, tables: { layer: { layers: { '0': { name: '0' } } } }, header: {} };
h.setDxf(dxf);

// Leader pointing right: tip (0,0), landing (20,0), bend at (30,10).
h.commitNewLeader([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 10 }]);

const polys = dxf.entities.filter(e => e.type === 'LWPOLYLINE');
assert.strictEqual(polys.length, 2, 'arrowhead + leader line');

const arrow = polys.find(p => p.closed);
const lineP = polys.find(p => !p.closed);
assert.ok(arrow && lineP, 'one closed (arrow) and one open (line)');

// Arrow: 3 vertices, tip at origin, base symmetric about the X axis.
assert.strictEqual(arrow.vertices.length, 3);
assert(Math.abs(arrow.vertices[0].x) < 1e-9 && Math.abs(arrow.vertices[0].y) < 1e-9, 'arrow tip at pick');
assert(Math.abs(arrow.vertices[1].y + arrow.vertices[2].y) < 1e-9, 'arrow base symmetric');
assert(arrow.vertices[1].x > 0, 'arrow points along the first segment');

// Leader line starts at the arrow base (not the tip), passes the last bend,
// then ends on a HORIZONTAL landing segment for the note.
assert(lineP.vertices[0].x > 0 && lineP.vertices[0].x < 5, 'line starts at arrow base');
const landEnd = lineP.vertices.at(-1);
const bend = lineP.vertices.at(-2);
assert.strictEqual(bend.x, 30, 'bend preserved');
assert.strictEqual(bend.y, 10);
assert(Math.abs(landEnd.y - 10) < 1e-9, 'landing must be horizontal');
assert(landEnd.x > 30, 'landing continues away from the bend');

// Text editor opened for the note.
assert.ok(h.textEditVisible(), 'inline text editor must open at the landing');

console.log('ALL LEADER TESTS PASS');
