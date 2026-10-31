/**
 * test_otrack.js — object snap tracking: acquisition, ray constraint,
 * priority ordering, toggle clearing.
 */
const assert = require('assert');
const { loadViewerPage } = require('./test_harness.js');

const TAIL = `
window.__t.hook = {
    setOtrack, otrackAcquire, resolveToolPoint, setOrthoMode, setPolarTracking,
    acquired() { return otrackAcquired; },
    // getSnapTolerance needs a camera; stub a fixed view for deterministic tol.
    setCamera() { camera = { top: 50, bottom: -50, zoom: 1 }; },
};`;

const page = loadViewerPage({ tail: TAIL });
const fatal = page.errors.filter(e => !/canvas|WebGL|not implemented/i.test(String(e && e.message)));
assert.strictEqual(fatal.length, 0, 'page load errors: ' + fatal.map(e => e && e.message).join(' | '));
const h = page.win.__t.hook;
h.setCamera();   // visibleHeight 100 -> snap tol 3, otrack tol 1.8, dedupe 1.5

// Off: acquisition ignored.
h.setOtrack(false);
h.otrackAcquire({ snapped: true, x: 10, y: 10 });
assert.strictEqual(h.acquired().length, 0, 'no acquisition while off');

// On: snapped points acquire, non-snapped don't, dedupe by proximity, max 2.
h.setOtrack(true);
h.otrackAcquire({ snapped: true, x: 10, y: 10 });
h.otrackAcquire({ snapped: false, x: 50, y: 50 });
h.otrackAcquire({ snapped: true, x: 10.5, y: 10.5 });   // within dedupe tol of first
assert.strictEqual(h.acquired().length, 1, 'dedupe must hold');
h.otrackAcquire({ snapped: true, x: 40, y: 0 });
h.otrackAcquire({ snapped: true, x: 0, y: 40 });
assert.strictEqual(h.acquired().length, 2, 'max 2 acquired');
assert.strictEqual(h.acquired()[0].x, 40, 'oldest evicted');

// Constraint: near the horizontal ray through (40,0) -> y snaps to 0.
let p = h.resolveToolPoint({ x: 25, y: 1.2 }, null, null);
assert(Math.abs(p.y) < 1e-9 && Math.abs(p.x - 25) < 1e-9, 'should land on the H ray, got ' + JSON.stringify(p));

// Near the vertical ray through (0,40) -> x snaps to 0.
p = h.resolveToolPoint({ x: -1.5, y: 20 }, null, null);
assert(Math.abs(p.x) < 1e-9 && Math.abs(p.y - 20) < 1e-9, 'should land on the V ray');

// Beyond tolerance: free.
p = h.resolveToolPoint({ x: 25, y: 5 }, null, null);
assert.strictEqual(p.y, 5, 'far from any ray must stay free');

// Snap always wins over tracking.
p = h.resolveToolPoint({ x: 25, y: 1 }, { snapped: true, x: 99, y: 99 }, null);
assert.strictEqual(p.x, 99);

// Ortho wins over tracking.
h.setOrthoMode(true);
p = h.resolveToolPoint({ x: 25, y: 1.2 }, null, { x: 20, y: 20 });
// dy (18.8) > dx (5) so ortho constrains to the vertical through the anchor.
assert(Math.abs(p.x - 20) < 1e-9 && Math.abs(p.y - 1.2) < 1e-9, 'ortho anchor must dominate tracking');
h.setOrthoMode(false);

// Toggling off clears acquired points.
h.setOtrack(false);
assert.strictEqual(h.acquired().length, 0, 'toggle off clears acquisitions');

console.log('ALL OTRACK TESTS PASS');
