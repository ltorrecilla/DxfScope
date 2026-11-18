/* Inspector visibility and resizing only; drawing selection and edits stay app-owned. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfEditorInspector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function create({ panel, sections, closeButton, resizeHandle, readWidth, saveWidth }) {
        const listeners = [];
        let connected = false;
        let drag = null;
        const isClosed = () => panel.classList.contains('translate-x-full');
        function listen(element, event, handler) {
            if (!element) return;
            element.addEventListener(event, handler);
            listeners.push(() => element.removeEventListener(event, handler));
        }

        // Derive active styling from the visible section, without touching its contents.
        function select(name) {
            if (!sections[name]) return;
            for (const [key, { tab, toolbar, content }] of Object.entries(sections)) {
                const active = key === name;
                tab.classList.toggle('text-blue-600', active);
                tab.classList.toggle('border-blue-600', active);
                tab.classList.toggle('text-slate-500', !active);
                tab.classList.toggle('border-transparent', !active);
                content.classList.toggle('hidden', !active);
                toolbar.classList.toggle('active', active && !isClosed());
            }
        }
        function open(name) {
            if (!sections[name]) return;
            panel.classList.remove('translate-x-full');
            select(name);
        }
        function close() {
            panel.classList.add('translate-x-full');
            for (const { toolbar } of Object.values(sections)) toolbar.classList.remove('active');
        }
        function toggle(name) {
            if (!sections[name]) return;
            if (!isClosed() && sections[name].toolbar.classList.contains('active')) close();
            else open(name);
        }

        function stopResize() {
            if (!drag) return;
            const { pointerId, transition } = drag;
            drag = null;
            panel.style.transition = transition;
            if (resizeHandle.hasPointerCapture(pointerId)) resizeHandle.releasePointerCapture(pointerId);
            try { saveWidth(Math.round(panel.getBoundingClientRect().width)); } catch { /* Storage is optional. */ }
        }

        function connect() {
            if (connected) return;
            connected = true;
            for (const [name, { tab, toolbar }] of Object.entries(sections)) {
                listen(tab, 'click', () => select(name));
                listen(toolbar, 'click', () => toggle(name));
            }
            listen(closeButton, 'click', close);
            if (!resizeHandle) return;
            try {
                const width = Number(readWidth());
                if (Number.isFinite(width) && width >= 240 && width <= 640) panel.style.width = width + 'px';
            } catch { /* Blocked storage must not prevent Editor startup. */ }
            listen(resizeHandle, 'pointerdown', event => {
                if (drag) return;
                drag = { pointerId: event.pointerId, x: event.clientX,
                    width: panel.getBoundingClientRect().width, transition: panel.style.transition };
                panel.style.transition = 'none';
                resizeHandle.setPointerCapture(event.pointerId);
                event.preventDefault();
            });
            listen(resizeHandle, 'pointermove', event => {
                if (!drag || event.pointerId !== drag.pointerId) return;
                const width = Math.min(640, Math.max(240, drag.width + drag.x - event.clientX));
                panel.style.width = width + 'px';
            });
            for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
                listen(resizeHandle, eventName, event => {
                    if (drag?.pointerId === event.pointerId) stopResize();
                });
            }
        }

        function dispose() {
            stopResize();
            listeners.splice(0).forEach(remove => remove());
            connected = false;
        }

        return { open, close, toggle, connect, dispose };
    }

    return { create };
});
