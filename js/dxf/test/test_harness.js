/**
 * test_harness.js — load DXF_Viewer.html in jsdom and actually RUN it.
 *
 * The shared test utility: loadViewerPage() executes the page's ES-module
 * body against stubbed browser globals so load-time errors surface in Node.
 * Every other test_*.js file builds on this; it is not a test itself.
 *
 * The page's main script is an ES module (`import * as THREE from 'three'`),
 * which jsdom will not execute and `eval` will not accept. It is rewritten here
 * into plain script text with the imports bound to stubs, so the whole top-level
 * body really runs: that is what makes TDZ crashes and missing references
 * visible before deployment instead of in the browser.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HELPERS = ['dxf_emit.js', 'dxf_tool_draw.js', 'dxf_ops_edit.js', 'dxf_paper_frames.js',
                 'dxf_linetype.js', 'dxf_tool_modify.js', 'dxf_sanitize.js', 'dxf_dim.js',
                 'dxf_hatch.js', 'dxf_pdf_import.js'];

/** A proxy that answers any property access, call or construction. */
function makeUniversal(name, overrides) {
    const target = function () {};
    return new Proxy(target, {
        get(t, prop) {
            if (overrides && Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
            if (prop === Symbol.toPrimitive) return () => 0;
            if (prop === Symbol.iterator) return function* () {};
            if (prop === 'then') return undefined;             // never look thenable
            if (prop === 'length' || prop === 'count' || prop === 'size') return 0;
            if (prop === 'toString') return () => `[universal ${name}]`;
            if (prop === 'name') return name;
            if (!t[prop]) t[prop] = makeUniversal(`${name}.${String(prop)}`);
            return t[prop];
        },
        set(t, prop, v) { t[prop] = v; return true; },
        apply() { return makeUniversal(`${name}()`); },
        construct() { return makeUniversal(`new ${name}`); },
        has() { return true; },
    });
}

/**
 * @param {object}   o
 * @param {string}   o.file          path to the HTML page
 * @param {object}   o.three         overrides merged onto the THREE stub
 * @param {Function} o.getContext    canvas 2d context factory
 * @param {string[]} o.expose        closure names to publish on window.__t
 */
function loadViewerPage(o = {}) {
    const root = o.root || __dirname;
    const file = o.file || path.join(root, 'DXF_Viewer.html');
    let html = fs.readFileSync(file, 'utf8');

    // Pull the module body out before stripping, then remove every remote tag.
    const moduleMatch = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/);
    if (!moduleMatch) throw new Error('no module script found in ' + file);
    let moduleBody = moduleMatch[1];

    html = html.replace(/<script[^>]*type="importmap"[\s\S]*?<\/script>/g, '')
               .replace(/<script[^>]*type="module"[\s\S]*?<\/script>/g, '')
               .replace(/<script[^>]*\bsrc="[^"]*"[^>]*><\/script>/g, '');

    const helperSrc = HELPERS.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');

    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', e => errors.push(e));

    // A real origin is needed or localStorage throws for opaque origins.
    const dom = new JSDOM(html, {
        runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
        url: 'https://harness.local/dxf/DXF_Viewer.html',
    });
    const win = dom.window;

    // Renderers must hand back a real DOM node: the page appends it to a container.
    const domRenderer = (tag) => function () {
        this.domElement = win.document.createElement(tag);
        this.setSize = () => {};
        this.setPixelRatio = () => {};
        this.render = () => {};
        this.setClearColor = () => {};
        this.dispose = () => {};
        this.info = { render: {}, memory: {} };
    };
    const baseThree = {
        WebGLRenderer: domRenderer('canvas'),
    };
    const threeOverrides = Object.assign(baseThree, typeof o.three === 'function' ? o.three(win) : o.three);
    win.THREE = makeUniversal('THREE', threeOverrides);
    win.OrbitControls = makeUniversal('OrbitControls');
    win.CSS2DRenderer = domRenderer('div');
    win.CSS2DObject = makeUniversal('CSS2DObject');
    win.lucide = { createIcons() {} };
    win.tailwind = {};
    win.DxfParser = makeUniversal('DxfParser');
    win.jspdf = makeUniversal('jspdf');
    win.requestAnimationFrame = () => 0;
    win.cancelAnimationFrame = () => {};
    win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    win.matchMedia = win.matchMedia || (() => ({
        matches: false, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {},
    }));
    win.HTMLCanvasElement.prototype.getContext = o.getContext || (() => makeUniversal('ctx'));
    win.addEventListener('error', e => errors.push(e.error || new Error(e.message)));

    // Helper modules first — the page expects window.DxfHatch et al. to exist.
    try { win.eval(helperSrc); } catch (e) { errors.push(e); }

    // Remaining ordinary inline blocks (theme bootstrap, tailwind config…).
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
        .map(m => m[1]).filter(s => s.trim().length > 200);
    let executed = 0;
    for (const code of inline) {
        try { win.eval(code); executed++; } catch (e) { errors.push(e); }
    }

    // Rewrite the module's imports into bindings on the stubs, then run it.
    moduleBody = moduleBody
        .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+['"][^'"]+['"];?\s*$/m,
                 'const THREE = window.THREE;')
        .replace(/^\s*import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"];?\s*$/gm,
                 (_, names) => names.split(',').map(n => {
                     const id = n.trim().split(/\s+as\s+/).pop().trim();
                     return id ? `const ${id} = window.${id};` : '';
                 }).join(' '));

    const leftover = /^\s*(import|export)\s/m.exec(moduleBody);
    if (leftover) errors.push(new Error('unhandled module statement: ' + leftover[0].trim()));

    const expose = (o.expose || []).filter(Boolean);
    const tail = (expose.length
        ? `\n;window.__t = { ${expose.map(n => `${n}: (typeof ${n} === 'function' || typeof ${n} === 'object') ? ${n} : undefined`).join(', ')} };`
        : '\n;window.__t = window.__t || {};')
        // Raw code appended inside the module scope. Tests use it to install
        // setters for module-scoped `let` bindings, which cannot be written
        // through the plain value copies in window.__t.
        + (o.tail ? `\n;${o.tail}` : '');

    let moduleRan = false;
    try { win.eval(moduleBody + tail); moduleRan = true; }
    catch (e) { errors.push(e); }

    return { dom, win, errors, executed, inlineCount: inline.length, moduleRan };
}

module.exports = { loadViewerPage, makeUniversal, HELPERS };
