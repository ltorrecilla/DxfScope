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
            // Generated panels may be rebuilt below. Retain in-progress values
            // and focus; translating labels must not commit or discard edits.
            const drafts = Array.from(document.querySelectorAll('input[id], textarea[id], select[id]'))
                .filter(element => element.type !== 'file')
                .map(element => ({ id: element.id, value: element.value, checked: element.checked,
                    focused: element === document.activeElement,
                    start: element.selectionStart, end: element.selectionEnd }));
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
            for (const draft of drafts) {
                const element = document.getElementById(draft.id);
                if (!element) continue;
                element.value = draft.value;
                if (typeof draft.checked === 'boolean') element.checked = draft.checked;
                if (draft.focused) {
                    element.focus({ preventScroll: true });
                    if (typeof draft.start === 'number' && typeof element.setSelectionRange === 'function') {
                        element.setSelectionRange(draft.start, draft.end);
                    }
                }
            }
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
