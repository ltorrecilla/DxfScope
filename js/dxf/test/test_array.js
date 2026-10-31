/**
 * test_array.js — drive the ARRAY feature end-to-end in jsdom.
 *
 * Rect path: set a selection, fill the popup inputs, click Create array.
 * Polar path: apply from the popup, then feed a center click through the
 * ops state machine via applyOpsCommit-equivalent (opsTools.handleClick).
 */
const assert = require('assert');
const { loadViewerPage } = require('./test_harness.js');

const TAIL = `
window.__t.hook = {
    setDxf(v) { currentDxf = v; },
    getDxf() { return currentDxf; },
    setSelection(v) { selectedEntities = v; },
    getSelection() { return selectedEntities; },
    opsTools() { return opsTools; },
    pendingPolar() { return pendingPolarArray; },
    toggleArrayPopup,
    registry() { return editRegistry; },
};`;

function freshPage() {
    const page = loadViewerPage({ tail: TAIL });
    const fatal = page.errors.filter(e => !/canvas|WebGL|not implemented/i.test(String(e && e.message)));
    assert.strictEqual(fatal.length, 0, 'page load errors: ' + fatal.map(e => e && e.message).join(' | '));
    assert.ok(page.moduleRan, 'module body did not run');
    return page;
}

function makeDxf() {
    return {
        entities: [],
        blocks: {},
        tables: { layer: { layers: { '0': { name: '0' } } } },
        header: {},
    };
}

function click(win, el) {
    el.dispatchEvent(new win.window.MouseEvent('click', { bubbles: true }));
}

// ===== Test 1: rectangular array creates (rows*cols - 1) * n copies =====
{
    const page = freshPage();
    const { win } = page;
    const hook = win.__t.hook;

    const dxf = makeDxf();
    const line = { type: 'LINE', layer: '0', vertices: [{ x: 0, y: 0 }, { x: 5, y: 0 }] };
    const circ = { type: 'CIRCLE', layer: '0', center: { x: 2, y: 2 }, radius: 1 };
    dxf.entities.push(line, circ);
    hook.setDxf(dxf);
    hook.setSelection([line, circ]);

    win.document.getElementById('array-rows').value = '2';
    win.document.getElementById('array-cols').value = '3';
    win.document.getElementById('array-col-spacing').value = '10';
    win.document.getElementById('array-row-spacing').value = '20';

    const before = dxf.entities.length;
    click(win, win.document.getElementById('btn-array-apply'));
    const created = dxf.entities.length - before;

    // 2x3 grid, origin excluded => 5 offsets x 2 entities = 10 copies
    assert.strictEqual(created, 10, `expected 10 new entities, got ${created}`);

    // Spot-check last-cell placement: offset (2*10, 1*20) = (20, 20)
    const copies = dxf.entities.slice(before);
    const far = copies.filter(e => e.type === 'CIRCLE' && Math.abs(e.center.x - 22) < 1e-9 && Math.abs(e.center.y - 22) < 1e-9);
    assert.strictEqual(far.length, 1, 'far-corner circle copy missing');

    // Copies registered for save
    assert.ok(hook.registry().createdEntities.length >= 10, 'createdEntities not registered');

    // Originals untouched
    assert.strictEqual(line.vertices[0].x, 0);
    assert.strictEqual(circ.center.x, 2);
    console.log('rect array: PASS');
}

// ===== Test 2: polar array via center click =====
{
    const page = freshPage();
    const { win } = page;
    const hook = win.__t.hook;

    const dxf = makeDxf();
    const circ = { type: 'CIRCLE', layer: '0', center: { x: 10, y: 0 }, radius: 1 };
    dxf.entities.push(circ);
    hook.setDxf(dxf);
    hook.setSelection([circ]);

    // Open popup, switch to polar, set 4 items over 360, rotate on.
    hook.toggleArrayPopup();
    assert.ok(!win.document.getElementById('array-popup').classList.contains('closed'), 'popup did not open');
    click(win, win.document.getElementById('array-tab-polar'));
    win.document.getElementById('array-count').value = '4';
    win.document.getElementById('array-total-angle').value = '360';
    win.document.getElementById('array-rotate-items').checked = true;

    click(win, win.document.getElementById('btn-array-apply'));
    assert.ok(win.document.getElementById('array-popup').classList.contains('closed'), 'popup should close for center pick');
    assert.ok(hook.pendingPolar(), 'pendingPolarArray not set');
    assert.strictEqual(hook.opsTools().activeTool(), 'arraypolar', 'arraypolar tool not active');

    const before = dxf.entities.length;
    // Simulate the canvas click on the center (0,0)
    hook.opsTools().handleClick({ x: 0, y: 0 });
    const created = dxf.entities.length - before;

    // 4 items incl. original => 3 copies
    assert.strictEqual(created, 3, `expected 3 copies, got ${created}`);
    const copies = dxf.entities.slice(before);
    const at90 = copies.find(e => Math.abs(e.center.x) < 1e-9 && Math.abs(e.center.y - 10) < 1e-9);
    const at180 = copies.find(e => Math.abs(e.center.x + 10) < 1e-9 && Math.abs(e.center.y) < 1e-9);
    const at270 = copies.find(e => Math.abs(e.center.x) < 1e-9 && Math.abs(e.center.y + 10) < 1e-9);
    assert.ok(at90 && at180 && at270, 'copies not at 90/180/270 degrees');

    // Tool exits after commit
    assert.ok(!hook.opsTools().isActive(), 'ops tool should exit after commit');
    console.log('polar array: PASS');
}

// ===== Test 3: no selection => popup refuses to open =====
{
    const page = freshPage();
    const { win } = page;
    const hook = win.__t.hook;
    hook.setDxf(makeDxf());
    hook.setSelection([]);
    hook.toggleArrayPopup();
    assert.ok(win.document.getElementById('array-popup').classList.contains('closed'), 'popup must stay closed with no selection');
    console.log('empty selection guard: PASS');
}

console.log('ALL ARRAY TESTS PASS');
