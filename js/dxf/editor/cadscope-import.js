/* Worker job ownership only. The Editor commits results and owns scene setup. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfEditorImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function create(client) {
        let epoch = 0;
        function cancel() {
            // Invalidate callbacks before cancellation can settle the worker promise.
            epoch++;
            client.cancel();
        }
        function begin(file) {
            cancel();
            const current = epoch;
            const isCurrent = () => current === epoch;
            function checkCurrent() {
                if (!isCurrent()) throw Object.assign(new Error('Import cancelled'), { name: 'AbortError' });
            }
            async function load(onProgress) {
                checkCurrent();
                const result = await client.start({ file }, event => {
                    if (isCurrent()) onProgress(event);
                });
                checkCurrent();
                if (!result?.parsed || !result.recovery || typeof result.rawText !== 'string') {
                    throw new Error('Incomplete drawing received from import worker');
                }
                return result;
            }
            return { load, isCurrent };
        }
        return { begin, cancel };
    }
    return { create };
});
