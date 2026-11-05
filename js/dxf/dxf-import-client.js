/* One active import per editor. Cancellation also interrupts synchronous WASM. */
(function (root) {
    class DxfImportClient {
        constructor(url, WorkerClass = root.Worker) { this.url = url; this.WorkerClass = WorkerClass; this.serial = 0; this.job = null; }
        cancel() {
            const job = this.job;
            if (!job) return;
            this.job = null; job.worker.terminate();
            const error = new Error('Import cancelled'); error.name = 'AbortError'; job.reject(error);
        }
        start(input, onProgress) {
            this.cancel();
            const id = ++this.serial;
            return new Promise((resolve, reject) => {
                const worker = new this.WorkerClass(this.url, { type: 'module', name: 'DXF import' });
                const job = this.job = { id, worker, reject };
                const finish = (error, result) => {
                    if (this.job !== job) return;
                    this.job = null; worker.terminate();
                    if (error) reject(error); else resolve(result);
                };
                worker.onmessage = ({ data }) => {
                    if (this.job !== job || data?.id !== id) return;
                    if (data.version !== 1) return finish(new Error('DXF worker version mismatch. Reload the page.'));
                    if (data.type === 'progress') onProgress?.(data);
                    else if (data.type === 'result') finish(null, data.result);
                    else if (data.type === 'error') finish(new Error(data.message));
                };
                worker.onerror = event => { event.preventDefault?.(); finish(new Error(event.message || 'Could not start the DXF import worker.')); };
                worker.onmessageerror = () => finish(new Error('Could not receive the imported drawing.'));
                try { worker.postMessage({ ...input, version: 1, id }); } catch (error) { finish(error); }
            });
        }
    }
    root.DxfImportClient = DxfImportClient;
    if (typeof module === 'object' && module.exports) module.exports = DxfImportClient;
})(typeof globalThis !== 'undefined' ? globalThis : this);
