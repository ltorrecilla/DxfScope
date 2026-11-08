/* Prepare a complete drawing pair without mutating the displayed contexts. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfCompareImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function create(client, contexts) {
        let epoch = 0;

        // Invalidate callbacks before terminating the worker that could deliver them.
        function cancel() {
            epoch++;
            client.cancel();
        }

        // Capture the selected files once; newer selections cannot alter this job.
        function begin(files, onProgress) {
            cancel();
            const currentEpoch = epoch;
            const isCurrent = () => currentEpoch === epoch;
            const a = files.a && files.b ? files.a : null;
            const b = files.b || files.a;
            const checkCurrent = () => {
                if (!isCurrent()) throw Object.assign(new Error('Import cancelled'), { name: 'AbortError' });
            };

            async function read(file, sideKey) {
                checkCurrent();
                if (!file) {
                    const empty = contexts.create(sideKey);
                    empty.dxf = { entities: [], blocks: {} };
                    return empty;
                }
                const result = await client.start({ file, target: 'compare', sideKey }, event => {
                    if (isCurrent()) onProgress?.(file, event);
                });
                checkCurrent();
                if (!result?.context?.dxf) throw new Error('Incomplete drawing received from import worker');
                // Restore caches omitted by the worker's structured-clone payload.
                return Object.assign(contexts.create(sideKey), result.context);
            }

            // One worker client runs sequentially. Publish only after both sides succeed.
            async function load() {
                const nextA = await read(a, 'A');
                const nextB = await read(b, 'B');
                checkCurrent();
                return { a: nextA, b: nextB, singleFileMode: !a };
            }
            return { load, isCurrent };
        }

        return { begin, cancel };
    }

    return { create };
});
