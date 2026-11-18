/* Visibility for Editor settings popups; draft data stays with each dialog. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfEditorDialogs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function create(document, triggers) {
        const isOpen = popup => !!popup && !popup.classList.contains('closed');

        // Resolve buttons lazily so setup does not depend on app initialization order.
        function setOpen(popup, open) {
            if (!popup) return;
            popup.classList.toggle('closed', !open);
            const buttonId = triggers[popup.id];
            if (buttonId) document.getElementById(buttonId)?.classList.toggle('active', open);
        }

        // Return whether Escape consumed a popup, preserving its existing priority.
        function closeOthers(except = null) {
            let closed = false;
            document.querySelectorAll('.settings-popup').forEach(popup => {
                if (popup === except) return;
                closed = isOpen(popup) || closed;
                setOpen(popup, false);
            });
            return closed;
        }

        function toggle(popup, force = null) {
            if (!popup) return false;
            const open = force === null ? !isOpen(popup) : !!force;
            if (open) closeOthers(popup);
            setOpen(popup, open);
            return open;
        }

        return { isOpen, setOpen, closeOthers, toggle };
    }

    return { create };
});
