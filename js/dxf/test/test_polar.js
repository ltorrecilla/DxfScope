/**
 * test_polar.js — polar tracking behaviour of resolveToolPoint.
 */
const assert = require('assert');
const { loadViewerPage } = require('./test_harness.js');

const TAIL = `
window.__t.hook = {
    resolveToolPoint, setPolarTracking, setOrthoMode,
    setIncrement(v) { polarIncrementDeg = v; },
};`;

const page = loadViewerPage({ tail: TAIL });
const fatal = page.errors.filter(e => !/canvas|WebGL|not implemented/i.test(String(e && e.message)));
assert.strictEqual(fatal.length, 0, 'page load errors: ' + fatal.map(e => e && e.message).join(' | '));
const h = page.win.__t.hook;

const anchor = { x: 0, y: 0 };
const near30 = { x: Math.cos(32 * Math.PI / 180) * 10, y: Math.sin(32 * Math.PI / 180) * 10 }; // 2 deg off a 30-deg ray

// Off: point passes through untouched.
h.setPolarTracking(false);
let p = h.resolveToolPoint(near30, null, anchor);
assert(Math.abs(p.x - near30.x) < 1e-12 && Math.abs(p.y - near30.y) < 1e-12, 'polar off must not alter points');

// On: 2 degrees off a 30-degree ray snaps onto it (15-degree increments).
h.setPolarTracking(true);
h.setIncrement(15);
p = h.resolveToolPoint(near30, null, anchor);
const ang = Math.atan2(p.y, p.x) * 180 / Math.PI;
assert(Math.abs(ang - 30) < 1e-9, 'should snap to 30 deg, got ' + ang);
// Distance preserved by projection (cos of 2 deg off)
const d = Math.hypot(p.x, p.y);
assert(Math.abs(d - 10 * Math.cos(2 * Math.PI / 180)) < 1e-9, 'projected distance wrong: ' + d);

// Beyond tolerance: 8 degrees off any ray stays free.
const off8 = { x: Math.cos(38 * Math.PI / 180) * 10, y: Math.sin(38 * Math.PI / 180) * 10 };
p = h.resolveToolPoint(off8, null, anchor);
assert(Math.abs(p.x - off8.x) < 1e-12, '8 deg off must stay free');

// Snap wins over polar.
p = h.resolveToolPoint(near30, { snapped: true, x: 99, y: 98 }, anchor);
assert.strictEqual(p.x, 99);

// Ortho wins over polar when both are on.
h.setOrthoMode(true);
p = h.resolveToolPoint({ x: 10, y: 1 }, null, anchor);
assert(Math.abs(p.y) < 1e-12 && Math.abs(p.x - 10) < 1e-12, 'ortho must dominate');
h.setOrthoMode(false);

// No anchor (first click of a tool): free.
p = h.resolveToolPoint(near30, null, null);
assert(Math.abs(p.x - near30.x) < 1e-12);

console.log('ALL POLAR TRACKING TESTS PASS');
