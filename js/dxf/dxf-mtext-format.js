(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.DxfMTextFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function inspect(raw, baseFont = 'arial.ttf') {
        const input = String(raw ?? '');
        const glyphs = [], stack = [];
        let state = { fontFile: baseFont, bold: false, italic: false };
        const emit = (ch, start, end) => glyphs.push({ ch, start, end, ...state });
        for (let i = 0; i < input.length; i++) {
            const start = i, ch = input[i];
            if (ch === '{') { stack.push({ ...state }); continue; }
            if (ch === '}') { state = stack.pop() || state; continue; }
            if (ch === '%' && input[i + 1] === '%') {
                const symbol = { d: '°', p: '±', c: 'Ø' }[input[i + 2]?.toLowerCase()];
                if (symbol) { emit(symbol, start, i + 3); i += 2; continue; }
            }
            if (ch !== '\\') { emit(ch, start, i + 1); continue; }
            const code = input[++i];
            if (!code) break;
            if (code === 'P') { emit('\n', start, i + 1); continue; }
            if (code === '~') { emit(' ', start, i + 1); continue; }
            if (code === '\\' || code === '{' || code === '}') { emit(code, start, i + 1); continue; }
            if (code === 'L' || code === 'l' || code === 'O' || code === 'o' || code === 'K' || code === 'k') {
                if (input[i + 1] === ';') i++;
                continue;
            }
            if (/[HhWwFfCcAaQqSs]/.test(code)) {
                const end = input.indexOf(';', i + 1);
                const arg = input.slice(i + 1, end < 0 ? input.length : end);
                i = end < 0 ? input.length : end;
                if (code === 'f' || code === 'F') {
                    const [fontFile, ...flags] = arg.split('|');
                    state.fontFile = fontFile.trim();
                    const shx = /\.shx$/i.test(state.fontFile);
                    state.bold = !shx && flags.some(flag => /^b1$/i.test(flag.trim()));
                    state.italic = !shx && flags.some(flag => /^i1$/i.test(flag.trim()));
                } else if (code === 'S' || code === 's') {
                    for (const part of arg.replace(/[\^#]/g, '/')) emit(part, start, i + 1);
                }
                continue;
            }
        }
        while (glyphs.length && /\s/.test(glyphs[0].ch)) glyphs.shift();
        while (glyphs.length && /\s/.test(glyphs.at(-1).ch)) glyphs.pop();
        return { text: glyphs.map(g => g.ch).join(''), glyphs };
    }

    function formatSelection(raw, start, end, kind, baseFont = 'arial.ttf') {
        const source = String(raw ?? '');
        const { text, glyphs } = inspect(source, baseFont);
        if (!['bold', 'italic'].includes(kind) || !Number.isInteger(start) || !Number.isInteger(end) ||
            start < 0 || end > glyphs.length || start >= end) return null;
        const selected = glyphs.slice(start, end);
        if (selected.some(g => g.fontFile !== selected[0].fontFile ||
            g.bold !== selected[0].bold || g.italic !== selected[0].italic)) return null;
        const fontFile = selected[0].fontFile;
        if (!/\.(ttf|otf)$/i.test(fontFile) || /[\\;{}\r\n]/.test(fontFile)) return null;
        const from = selected[0].start, to = selected.at(-1).end;
        const segment = source.slice(from, to);
        if (/[{}]/.test(segment) || /\\[FfSs][^;]*;/.test(segment)) return null;
        const bold = kind === 'bold' ? !selected[0].bold : selected[0].bold;
        const italic = kind === 'italic' ? !selected[0].italic : selected[0].italic;
        const prefix = `{\\f${fontFile}|b${Number(bold)}|i${Number(italic)};`;
        return { raw: source.slice(0, from) + prefix + segment + '}' + source.slice(to),
            text, bold, italic };
    }

    return { inspect, formatSelection };
});
