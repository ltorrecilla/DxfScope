// Dedicated DXF/DWG import worker. Protocol must match dxf-import-client.js.
const VERSION = 1;
let activeId;
const timings = [];
const progress = (stage, loaded, total) => self.postMessage({ version: VERSION, id: activeId, type: 'progress', stage, loaded, total });
const timed = async (stage, fn) => {
    progress(stage);
    const start = performance.now();
    try { return await fn(); } finally { timings.push({ stage, ms: performance.now() - start }); }
};

async function readFile(file, binary) {
    const chunkSize = 2 * 1024 * 1024;
    const bytes = binary ? new Uint8Array(file.size) : null;
    const parts = []; let decoder;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
        const chunk = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
        if (binary) bytes.set(chunk, offset);
        else {
            if (!decoder) decoder = new TextDecoder(chunk[0] === 0xff && chunk[1] === 0xfe ? 'utf-16le'
                : chunk[0] === 0xfe && chunk[1] === 0xff ? 'utf-16be' : 'utf-8');
            parts.push(decoder.decode(chunk, { stream: true }));
        }
        progress('read', Math.min(offset + chunk.length, file.size), file.size);
    }
    if (binary) return bytes.buffer;
    if (decoder) parts.push(decoder.decode());
    return parts.join('');
}

async function converter() {
    // Existing bundled LibreDWG (GPL-3), loaded lazily in this job's worker.
    const base = new URL('../libredwg/', import.meta.url);
    const fetchOk = async name => {
        const response = await fetch(new URL(name, base));
        if (!response.ok) throw new Error(`Converter ${name}: HTTP ${response.status}`);
        return response;
    };
    const [glue, dist, wasm] = await Promise.all([
        fetchOk('libredwg-web.glue.js').then(r => r.text()),
        fetchOk('libredwg-web.js').then(r => r.text()),
        fetchOk('libredwg-web.wasm').then(r => r.arrayBuffer()),
    ]);
    const wasmBinary = new Uint8Array(wasm);
    if (wasmBinary[0] !== 0 || wasmBinary[1] !== 0x61 || wasmBinary[2] !== 0x73 || wasmBinary[3] !== 0x6d) throw new Error('Invalid converter WebAssembly response');
    const glueUrl = URL.createObjectURL(new Blob([glue], { type: 'text/javascript' }));
    let distUrl;
    try {
        const rewritten = dist.split('"../wasm/libredwg-web.js"').join(JSON.stringify(glueUrl));
        if (rewritten === dist) throw new Error('Unsupported converter module layout');
        distUrl = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
        const mod = await import(distUrl);
        return mod.LibreDwg.createByWasmInstance(await mod.createModule({ wasmBinary, locateFile: f => f }));
    } finally {
        URL.revokeObjectURL(glueUrl);
        if (distUrl) URL.revokeObjectURL(distUrl);
    }
}

function normalizeText(raw) {
    if (/^AutoCAD Binary DXF/.test(raw)) throw new Error('Binary DXF is unsupported. Save as ASCII DXF or DWG.');
    if (raw.indexOf('\n') < 0 && raw.indexOf('\r') >= 0) raw = raw.replace(/\r/g, '\n');
    if (/^\s*0\s*\r?\n\s*SECTION\s*$/m.test(raw) && !/\n\s*0\s*\r?\n\s*EOF\s*$/.test(raw.trimEnd() + '\n')) raw = raw.replace(/\s*$/, '') + '\n0\nEOF\n';
    return raw;
}

self.onmessage = async ({ data }) => {
    if (activeId !== undefined) return; // One job per worker; terminate to cancel.
    activeId = data?.id;
    try {
        if (data?.version !== VERSION) throw new Error('DXF worker version mismatch. Reload the page.');
        let rawText, sizeBytes = data.file?.size ?? data.rawText?.length ?? 0;
        let name = data.file?.name || data.name || 'drawing.dxf';
        const dwg = /\.dwg$/i.test(name);
        if (data.file) {
            const input = await timed('read', () => readFile(data.file, dwg));
            if (dwg) {
                const lib = await timed('converter', converter);
                const converted = await timed('convert', () => lib.dwg_write_dxf(input));
                if (!converted?.length) throw new Error('DWG conversion returned no drawing data.');
                rawText = new TextDecoder().decode(converted);
                sizeBytes = converted.length; name = name.replace(/\.dwg$/i, '.dxf');
            } else rawText = input;
        } else rawText = String(data.rawText || '');
        rawText = normalizeText(rawText);
        // These existing UMD readers expose browser globals. Alias only during
        // module registration; converter environment detection sees a real worker.
        self.window = self;
        try {
            await timed('modules', () => Promise.all(['dxf-parser','dxf-text','dxf-dim-style','dxf-dim-assoc',
                'dxf-hatch','dxf-dim','dxf-xline','dxf-mleader','dxf-layer-states','dxf-ocs','dxf-import-setup'].map(name => import(`./${name}.js?v=import-2`))));
        } finally { delete self.window; }
        const parsed = await timed('parse', () => new self.DxfParser().parseSync(rawText));
        const recovery = await timed('recover', () => {
            const lines = /\r(?!\n)/.test(rawText) ? null : rawText.split(/\r\n|\n/);
            const dimStyles = self.DxfDimStyle.recover(parsed, rawText, lines);
            const textStyles = self.DxfText.parseStyles(rawText, lines);
            self.DxfText.applyRawTextProps(parsed, rawText, lines);
            self.DxfDimAssoc.recover(parsed, rawText, lines);
            return { dimStyles, textStyles,
                hatches: self.DxfHatch.parseRawDxfHatches(rawText, lines),
                leaders: self.DxfDim.parseRawDxfLeaders(rawText, lines),
                xlines: self.DxfXline.parseRawXlines(rawText, lines),
                wipeouts: self.DxfHatch.parseRawDxfWipeouts(rawText, lines),
                tables: self.DxfHatch.parseRawDxfAcadTables(rawText, lines),
                layerStates: self.DxfLayerStates.read(rawText, lines),
                multileaders: {
                    blockNames: self.DxfMLeader.parseBlockRecordHandles(rawText, lines),
                    found: self.DxfMLeader.parseRawMultileaders(rawText, lines),
                    creation: self.DxfMLeader.findCreationStyles(rawText, lines),
                    dimStyles: self.DxfMLeader.parseRawDimStyles(rawText, lines),
                    extras: self.DxfMLeader.parseRawLeaderExtras(rawText, lines),
                },
            };
        });
        recovery.setup = await timed('setup', () => {
            const setup = self.DxfImportSetup;
            const lines = /\r(?!\n)/.test(rawText) ? null : rawText.split(/\r\n|\n/);
            const rawHandleToKey = setup.assignRawEntityIndices(parsed, rawText, lines) || new Map();
            return { rawHandleToKey, mirrorFix: setup.normalizeMirroredEntities(parsed, rawText),
                nextHandle: setup.computeNextHandleSeed(rawText, rawHandleToKey),
                layerInfo: setup.parseRawLayerTableInfo(rawText, lines), spaces: setup.prepareSpaces(rawText) };
        });
        progress('transfer');
        self.postMessage({ version: VERSION, id: activeId, type: 'result', result: { rawText, parsed, recovery, name, sizeBytes, timings } });
    } catch (error) {
        self.postMessage({ version: VERSION, id: activeId, type: 'error', message: error?.message || String(error) });
    }
};
