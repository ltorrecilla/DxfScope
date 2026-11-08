/* Own the translation bridge and attribute refresh; app callbacks read live state. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfEditorTranslations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function create({ document, window, translate, refreshDynamic }) {
        let connected = false;
        let timer = null;
        let previousRefresh;

        function refresh() {
            // Only annotated attributes are translated here, never filenames or draft values.
            for (const [marker, attribute] of [
                ['data-i18n-title', 'title'],
                ['data-i18n-aria-label', 'aria-label'],
                ['data-i18n-placeholder', 'placeholder']
            ]) {
                document.querySelectorAll(`[${marker}]`).forEach(element => {
                    const key = element.getAttribute(marker);
                    if (key) element.setAttribute(attribute, translate(key, element.getAttribute(attribute) || key));
                });
            }
            refreshDynamic();
        }

        function connect() {
            if (connected) return;
            connected = true;
            previousRefresh = window.refreshDxfTranslations;
            window.refreshDxfTranslations = refresh;
            document.addEventListener('languageLoaded', refresh);
            // Wait until the app's synchronous initialization has finished.
            timer = window.setTimeout(() => { timer = null; refresh(); }, 0);
        }

        function dispose() {
            if (!connected) return;
            connected = false;
            document.removeEventListener('languageLoaded', refresh);
            if (timer !== null) window.clearTimeout(timer);
            timer = null;
            // Do not overwrite a bridge installed by a later owner.
            if (window.refreshDxfTranslations === refresh) {
                if (previousRefresh === undefined) delete window.refreshDxfTranslations;
                else window.refreshDxfTranslations = previousRefresh;
            }
        }

        return { refresh, connect, dispose };
    }

    return { create };
});
