/* Presentation resources for one retained tool root (or standalone document).
 * Recovery/storage/page-leave work must use the real window outside this owner. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfWorkspaceActivity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    function create({ window: env, document }) {
        let active = true, disposed = false, serial = 0, inFlight = 0, focus = null, wasInert = false;
        const jobs = new Map(), listeners = [], observers = [];
        const now = () => env.performance.now();
        const inputEvents = ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointermove',
            'pointercancel', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick',
            'contextmenu', 'wheel', 'scroll', 'input', 'change', 'submit', 'dragover', 'drop', 'touchstart', 'touchmove'];
        // A parked tool must not block input aimed at the active tool or site UI.
        const blockInput = event => {
            if (active || (document.modeRoot && !document.modeRoot.contains(event.target))) return;
            event.stopImmediatePropagation();
            if (event.cancelable) event.preventDefault();
        };
        inputEvents.forEach(type => env.addEventListener(type, blockInput, { capture: true, passive: false }));
        function report(error) {
            if (env.reportError) env.reportError(error);
            else env.setTimeout(() => { throw error; }, 0);
        }
        function invoke(callback, args) {
            const result = callback(...args);
            if (result?.then) {
                inFlight++;
                Promise.resolve(result).then(() => { inFlight--; }, error => { inFlight--; report(error); });
            }
        }
        function arm(job) {
            if (!active || disposed) return;
            const generation = ++job.generation;
            job.started = now();
            const run = (...args) => {
                if (!active || job.generation !== generation || !jobs.has(job.id)) return;
                jobs.delete(job.id);
                invoke(job.callback, args);
            };
            job.native = job.kind === 'frame' ? env.requestAnimationFrame(run)
                : job.kind === 'idle' && env.requestIdleCallback ? env.requestIdleCallback(run, job.options)
                : env.setTimeout(run, job.delay);
        }
        function disarm(job) {
            job.generation++;
            if (job.native == null) return;
            if (job.kind === 'frame') env.cancelAnimationFrame(job.native);
            else if (job.kind === 'idle' && env.cancelIdleCallback) env.cancelIdleCallback(job.native);
            else env.clearTimeout(job.native);
            if (job.kind === 'timer') job.delay = Math.max(0, job.delay - (now() - job.started));
            job.native = null;
        }
        function schedule(kind, callback, delay = 0, options) {
            if (disposed) return null;
            const job = { id: ++serial, kind, callback, delay, options, generation: 0, native: null };
            jobs.set(job.id, job); arm(job); return job.id;
        }
        function cancel(id) { const job = jobs.get(id); if (job) { disarm(job); jobs.delete(id); } }
        function listen(target, type, callback, options) {
            const handler = event => { if (active) invoke(e => callback.call(target, e), [event]); };
            listeners.push({ target, type, callback, handler, options });
            target.addEventListener(type, handler, options);
        }
        function unlisten(target, type, callback, options) {
            const capture = option => typeof option === 'boolean' ? option : !!option?.capture;
            for (let i = listeners.length - 1; i >= 0; i--) {
                const item = listeners[i];
                if (item.target === target && item.type === type && item.callback === callback && capture(item.options) === capture(options)) {
                    item.target.removeEventListener(type, item.handler, item.options); listeners.splice(i, 1);
                }
            }
        }
        function observe(callback, target) {
            if (!target || !env.ResizeObserver) return;
            const observer = new env.ResizeObserver((...args) => { if (active) callback(...args); });
            observers.push({ observer, target }); observer.observe(target);
        }
        function suspend() {
            if (!active || disposed) return;
            if (inFlight) throw new Error('Presentation task is still running');
            active = false;
            focus = document.activeElement;
            wasInert = document.body.inert;
            document.body.inert = true;
            focus?.blur?.();
            jobs.forEach(disarm);
            observers.forEach(({ observer }) => observer.disconnect());
        }
        function activate() {
            if (active) return;
            if (disposed) throw new Error('Workspace is disposed');
            active = true; document.body.inert = wasInert;
            observers.forEach(({ observer, target }) => observer.observe(target));
            jobs.forEach(arm);
            if (focus?.isConnected && !wasInert) focus.focus({ preventScroll: true });
        }
        function dispose() {
            if (disposed) return;
            suspend(); disposed = true;
            jobs.clear();
            listeners.forEach(({ target, type, handler, options }) => target.removeEventListener(type, handler, options));
            listeners.length = 0; observers.length = 0;
            // Detached roots remain inert; remove their page-level input listeners.
            if (document.modeRoot) inputEvents.forEach(type => env.removeEventListener(type, blockInput, { capture: true }));
        }
        return { isActive: () => active, isBusy: () => inFlight > 0,
            setTimeout: (callback, delay) => schedule('timer', callback, delay), clearTimeout: cancel,
            requestAnimationFrame: callback => schedule('frame', callback), cancelAnimationFrame: cancel,
            requestIdleCallback: (callback, options) => schedule('idle', callback, 0, options), cancelIdleCallback: cancel,
            listen, unlisten, observe, suspend, activate, dispose };
    }
    // Final teardown only; suspension retains these objects and cached textures.
    function disposeGraphics({ scenes = [], renderers = [], controls = [], textures = new Map() }) {
        const geometries = new Set(), materials = new Set(), maps = new Set();
        controls.filter(Boolean).forEach(control => control.dispose());
        scenes.filter(Boolean).forEach(scene => {
            scene.traverse(object => {
                if (object.geometry) geometries.add(object.geometry);
                for (const material of [object.material].flat().filter(Boolean)) {
                    materials.add(material);
                    if (material.map) maps.add(material.map);
                }
                object.element?.remove();
            });
            scene.clear();
        });
        textures.forEach(entry => { if (entry?.texture) maps.add(entry.texture); });
        geometries.forEach(geometry => geometry.dispose());
        materials.forEach(material => material.dispose());
        maps.forEach(texture => texture.dispose());
        textures.clear();
        renderers.filter(Boolean).forEach(renderer => {
            renderer.dispose?.(); renderer.forceContextLoss?.(); renderer.domElement?.remove();
        });
    }
    return { create, disposeGraphics };
});
