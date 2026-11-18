/* Browser delivery and recovery setup; the app supplies live drawing snapshots. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfEditorPersistence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const OFF_KEY = 'liteaeco.dxfEditor.autosaveOff';

    function download({ document, window }, output, name) {
        const link = document.createElement('a');
        const url = window.URL.createObjectURL(new window.Blob([output], { type: 'application/dxf' }));
        try {
            link.href = url;
            link.download = `${(name || 'drawing.dxf').replace(/\.dxf$/i, '')}-edited.dxf`;
            document.body.appendChild(link);
            link.click();
        } finally {
            link.remove();
            // Delay revocation until the browser has consumed the download URL.
            window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
        }
    }

    function createRecovery({ document, window, isDirty, snapshot, isImportBusy, onStatus, offerRecovery }) {
        let storage = null;
        try { storage = window.localStorage; } catch { /* Optional preference/heartbeat storage. */ }
        const engine = window.DxfAutosave && window.indexedDB
            ? window.DxfAutosave.create({
                storage: window.DxfAutosave.idbStorage('liteaeco-dxf-editor-recovery'),
                alive: storage, isDirty, onStatus,
                // Never combine an incoming drawing with the old edit registry.
                serialize: () => isImportBusy() ? { text: null } : snapshot()
            }) : null;
        let connected = false, timer = null;
        const onHidden = () => {
            if (document.visibilityState === 'hidden' && isDirty()) engine.flush();
        };
        const onLeave = () => engine.leave();
        function setEnabled(on) {
            try { on ? storage?.removeItem(OFF_KEY) : storage?.setItem(OFF_KEY, '1'); } catch { /* Optional preference. */ }
            return engine?.setEnabled(on);
        }
        function connect() {
            if (!engine || connected) return;
            connected = true;
            try { if (storage?.getItem(OFF_KEY) === '1') engine.setEnabled(false); } catch { /* Use default. */ }
            engine.startHeartbeat();
            document.addEventListener('visibilitychange', onHidden);
            window.addEventListener('pagehide', onLeave);
            timer = window.setTimeout(() => { timer = null; offerRecovery(); }, 400);
        }
        // Detach UI bindings only; the caller owns the engine's document lifetime.
        function disconnect() {
            if (!connected) return;
            connected = false;
            document.removeEventListener('visibilitychange', onHidden);
            window.removeEventListener('pagehide', onLeave);
            if (timer !== null) window.clearTimeout(timer);
            timer = null;
        }
        return { engine, connect, disconnect, setEnabled };
    }
    return { download, createRecovery };
});
