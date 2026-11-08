/* Shared DXF text metrics, style lookup and canvas rasterization. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.DxfText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const FONT_STACKS = {
        Mono: 'Consolas, "Courier New", monospace',
        Sans: 'Arial, Helvetica, sans-serif',
        Serif: 'Georgia, "Times New Roman", serif',
        Arial: 'Arial, Helvetica, sans-serif',
        Times: '"Times New Roman", Times, serif',
        Courier: '"Courier New", Courier, monospace',
    };
    const capCache = new Map();

    function rotationDegrees(entity) {
        const direction = entity?.directionVector || entity?.textDirection;
        const x = Number(direction?.x), y = Number(direction?.y);
        if (Number.isFinite(x) && Number.isFinite(y) && Math.hypot(x, y) > 1e-12) {
            return Math.atan2(y, x) * 180 / Math.PI;
        }
        const angle = Number(entity?.rotation ?? entity?.rotationAngle ?? entity?.angle ?? 0);
        return Number.isFinite(angle) ? angle : 0;
    }

    function parseStyles(raw, preparedLines = null) {
        const styles = Object.create(null);
        const lines = preparedLines || String(raw || '').split(/\r\n|\n|\r/);
        let inTable = false, table = '', record = null;
        const save = () => { if (record?.name) styles[record.name.toUpperCase()] = record; record = null; };
        for (let i = 0; i + 1 < lines.length; i += 2) {
            const code = lines[i].trim(), value = lines[i + 1].trim();
            if (code === '0' && value === 'TABLE') { save(); inTable = true; table = ''; continue; }
            if (code === '0' && value === 'ENDTAB') { save(); inTable = false; continue; }
            if (inTable && code === '2' && !table) { table = value.toUpperCase(); continue; }
            if (!inTable || table !== 'STYLE') continue;
            if (code === '0' && value === 'STYLE') { save(); record = {}; continue; }
            if (!record) continue;
            if (code === '2') record.name = value;
            else if (code === '5') record.handle = value.toUpperCase();
            else if (code === '3') record.fontFile = value;
            else if (code === '4') record.bigFontFile = value;
            else if (code === '40') record.fixedHeight = Number(value) || 0;
            else if (code === '41') record.widthFactor = Number(value) || 1;
            else if (code === '50') record.oblique = Number(value) || 0;
            else if (code === '70') record.flags = Number(value) || 0;
            else if (code === '71') record.generationFlags = Number(value) || 0;
        }
        save();
        return styles;
    }

    function applyRawTextProps(dxf, raw, preparedLines = null) {
        const byHandle = new Map();
        const lines = preparedLines || String(raw || '').split(/\r\n|\n|\r/);
        let record = null;
        const save = () => { if (record?.handle) byHandle.set(record.handle.toUpperCase(), record); };
        for (let i = 0; i + 1 < lines.length; i += 2) {
            const code = lines[i].trim(), value = lines[i + 1].trim();
            if (code === '0') {
                save();
                record = /^(TEXT|MTEXT|ATTRIB|ATTDEF)$/.test(value) ? {} : null;
                continue;
            }
            if (!record) continue;
            if (code === '5') record.handle = value;
            else if (code === '7') record.textStyle = value;
            else if (code === '51') record.obliqueAngle = Number(value) || 0;
            else if (code === '44') record.lineSpacingFactor = Number(value) || 1;
            else if (code === '41') record.rawWidth = Number(value) || 0;
        }
        save();
        const apply = e => {
            if (!e || !/^(TEXT|MTEXT|ATTRIB|ATTDEF)$/.test(e.type)) return;
            const match = byHandle.get(String(e.handle || '').toUpperCase());
            if (match) {
                if (match.textStyle) e.textStyle = match.textStyle;
                if (match.obliqueAngle !== undefined) e.obliqueAngle = match.obliqueAngle;
                if (match.lineSpacingFactor !== undefined) e.lineSpacingFactor = match.lineSpacingFactor;
            }
        };
        (dxf?.entities || []).forEach(apply);
        Object.values(dxf?.blocks || {}).forEach(block => (block?.entities || []).forEach(apply));
    }

    function fontFamily(fontFile, requested) {
        if (FONT_STACKS[requested]) return FONT_STACKS[requested];
        const name = String(fontFile || '').replace(/^.*[\\/]/, '').replace(/\.(ttf|otf|shx)$/i, '');
        if (/\.shx$/i.test(fontFile || '')) return FONT_STACKS.Sans;
        if (/^(arial|helvetica)$/i.test(name)) return FONT_STACKS.Arial;
        if (/^(times|times new roman)$/i.test(name)) return FONT_STACKS.Times;
        if (/^(cour|courier|courier new)$/i.test(name)) return FONT_STACKS.Courier;
        if (/^georgia$/i.test(name)) return FONT_STACKS.Serif;
        if (/^(consola|consolas)$/i.test(name)) return FONT_STACKS.Mono;
        if (/^[\w -]+$/.test(name) && name) return `"${name}", ${FONT_STACKS.Sans}`;
        return FONT_STACKS.Sans;
    }

    function resolve(entity, styles, overrideFont) {
        // A block child can point __sourceEntity at its INSERT for selection.
        // Its font and width still belong to the child text entity.
        const source = entity?.__textSourceEntity || entity?.__sourceEntity || entity || {};
        const styleName = String(source.textStyle || source.styleName || 'STANDARD').toUpperCase();
        const style = styles?.[styleName] || {};
        const entityWidth = Number(source.scale ?? source.xScale ?? source.widthFactor ?? 1) || 1;
        const rawHeight = Number(source.__textHeight ?? source.textHeight ?? source.height ?? source.nominalTextHeight);
        return {
            font: fontFamily(style.fontFile, overrideFont || entity?.__fontFamily || source.__fontFamily),
            height: rawHeight > 0 ? rawHeight : (Number(style.fixedHeight) || 0),
            widthFactor: (Number(style.widthFactor) || 1) * entityWidth,
            oblique: Number(source.obliqueAngle ?? style.oblique) || 0,
            styleName,
        };
    }

    function normalizeText(value) {
        return String(value ?? '').replace(/\r\n|\r/g, '\n')
            .replace(/%%d/gi, '°').replace(/%%p/gi, '±').replace(/%%c/gi, 'Ø')
            .replace(/\\P/gi, '\n').replace(/\\~/g, ' ')
            .replace(/\\S([^;^\\]+)[\^#/]([^;]+);/g, '$1/$2')
            .replace(/\\[HhWwFfCcQqAa][^;]*;/g, '')
            .replace(/\\[LOKlo]/g, '').replace(/[{}]/g, '');
    }

    const ACI = ['#000000', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffffff'];
    function parseInline(value, baseHeight = 1, aci7Color = '#ffffff') {
        const input = String(value ?? '').replace(/\r\n|\r/g, '\n');
        const out = [], stack = [];
        let state = { heightScale: 1, widthScale: 1, font: '', bold: false, italic: false,
            color: '', underline: false };
        const emit = ch => out.push({ ch, ...state });
        for (let i = 0; i < input.length; i++) {
            const ch = input[i];
            if (ch === '{') { stack.push({ ...state }); continue; }
            if (ch === '}') { state = stack.pop() || state; continue; }
            if (ch !== '\\') { emit(ch); continue; }
            const code = input[++i];
            if (!code) break;
            if (code === 'P') { emit('\n'); continue; }
            if (code === '~') { emit(' '); continue; }
            if (code === '\\' || code === '{' || code === '}') { emit(code); continue; }
            if (code === 'L') { state.underline = true; if (input[i + 1] === ';') i++; continue; }
            if (code === 'l') { state.underline = false; if (input[i + 1] === ';') i++; continue; }
            if (/[HhWwFfCcAaQqSs]/.test(code)) {
                const end = input.indexOf(';', i + 1);
                const arg = input.slice(i + 1, end < 0 ? input.length : end);
                i = end < 0 ? input.length : end;
                if (code === 'H' || code === 'h') {
                    const n = parseFloat(arg);
                    if (n > 0) state.heightScale = /x$/i.test(arg) ? state.heightScale * n : n / baseHeight;
                } else if (code === 'W' || code === 'w') {
                    const n = parseFloat(arg);
                    if (n > 0) state.widthScale = n;
                } else if (code === 'f' || code === 'F') {
                    const [fontFile, ...flags] = arg.split('|');
                    const shx = /\.shx$/i.test(fontFile.trim());
                    state.font = fontFamily(fontFile.trim());
                    state.bold = !shx && flags.some(flag => /^b1$/i.test(flag.trim()));
                    state.italic = !shx && flags.some(flag => /^i1$/i.test(flag.trim()));
                } else if (code === 'C' || code === 'c') {
                    const n = Number(arg);
                    if (Number.isInteger(n) && ACI[n]) state.color = n === 7 ? aci7Color : ACI[n];
                } else if (code === 'S' || code === 's') {
                    for (const part of arg.replace(/[\^#]/g, '/')) emit(part);
                }
                continue;
            }
            // Unknown formatting controls do not appear as literal glyphs.
        }
        return out;
    }

    function capHeight(ctx, font) {
        const key = `${ctx.font}|${font}`;
        if (!capCache.has(key)) {
            const m = ctx.measureText('H');
            capCache.set(key, Math.max(1, m.actualBoundingBoxAscent || parseFloat(ctx.font) * 0.72));
        }
        return capCache.get(key);
    }

    function wrapLines(ctx, text, maxPx) {
        const out = [];
        for (const paragraph of normalizeText(text).split('\n')) {
            if (!Number.isFinite(maxPx) || maxPx <= 0) { out.push(paragraph); continue; }
            let line = '';
            for (const word of paragraph.split(/(\s+)/)) {
                if (line && ctx.measureText(line + word).width > maxPx && word.trim()) {
                    out.push(line.trimEnd()); line = word.trimStart();
                } else line += word;
            }
            out.push(line);
        }
        return out.length ? out : [''];
    }

    function wrapGlyphs(ctx, glyphs, maxPx, fontPx, defaultFont) {
        const width = glyph => {
            ctx.font = inlineFont(glyph, fontPx, defaultFont);
            return ctx.measureText(glyph.ch).width * glyph.widthScale;
        };
        const paragraphs = [[]];
        glyphs.forEach(g => g.ch === '\n' ? paragraphs.push([]) : paragraphs.at(-1).push(g));
        const result = [];
        for (const paragraph of paragraphs) {
            let line = [], lineWidth = 0;
            const chunks = [];
            for (const glyph of paragraph) {
                if (/\s/.test(glyph.ch)) {
                    if (chunks.length && chunks.at(-1).space) chunks.at(-1).glyphs.push(glyph);
                    else chunks.push({ space: true, glyphs: [glyph] });
                } else if (chunks.length && !chunks.at(-1).space) chunks.at(-1).glyphs.push(glyph);
                else chunks.push({ space: false, glyphs: [glyph] });
            }
            for (const chunk of chunks) {
                const chunkWidth = chunk.glyphs.reduce((sum, g) => sum + width(g), 0);
                if (line.length && !chunk.space && lineWidth + chunkWidth > maxPx) {
                    result.push(line); line = []; lineWidth = 0;
                }
                for (const glyph of chunk.glyphs) {
                    const w = width(glyph);
                    if (line.length && lineWidth + w > maxPx && !chunk.space) {
                        result.push(line); line = []; lineWidth = 0;
                    }
                    if (!line.length && /\s/.test(glyph.ch)) continue;
                    line.push({ ...glyph, advance: w }); lineWidth += w;
                }
            }
            result.push(line);
        }
        return result;
    }

    function inlineFont(run, fontPx, defaultFont) {
        return `${run.italic ? 'italic ' : ''}${run.bold ? 'bold ' : ''}${fontPx * run.heightScale}px ${run.font || defaultFont}`;
    }

    function groupRuns(ctx, glyphs, fontPx, defaultFont) {
        const runs = [];
        for (const glyph of glyphs) {
            const previous = runs.at(-1);
            if (previous && previous.heightScale === glyph.heightScale &&
                previous.widthScale === glyph.widthScale && previous.font === glyph.font &&
                previous.bold === glyph.bold && previous.italic === glyph.italic &&
                previous.color === glyph.color && previous.underline === glyph.underline) {
                previous.text += glyph.ch;
            } else runs.push({ ...glyph, text: glyph.ch });
        }
        runs.forEach(run => {
            ctx.font = inlineFont(run, fontPx, defaultFont);
            run.advance = ctx.measureText(run.text).width * run.widthScale;
        });
        return runs;
    }

    function layout(ctx, node, options = {}) {
        const fontPx = Number(options.fontPx) || 72;
        const font = options.font || FONT_STACKS.Sans;
        ctx.font = `${fontPx}px ${font}`;
        ctx.textBaseline = 'alphabetic';
        const capPx = capHeight(ctx, font);
        const height = Math.abs(Number(node.height)) || 1;
        const widthFactor = Number(node.widthFactor) || 1;
        const unit = height / capPx;
        const isMText = !!node.isMText;
        const referenceWidth = Number(node.width) || 0;
        const maxPx = isMText && referenceWidth > 0 ? referenceWidth / (unit * widthFactor) : Infinity;
        const glyphLines = isMText ? wrapGlyphs(ctx, parseInline(node.text, height, options.aci7Color), maxPx, fontPx, font) : null;
        const runLines = glyphLines ? glyphLines.map(g => groupRuns(ctx, g, fontPx, font)) : null;
        ctx.font = `${fontPx}px ${font}`;
        const lines = glyphLines ? glyphLines.map(g => g.map(c => c.ch).join('')) : wrapLines(ctx, node.text, maxPx);
        const advances = runLines ? runLines.map(g => g.reduce((sum, c) => sum + c.advance, 0))
            : lines.map(line => ctx.measureText(line).width);
        const blockWidth = isMText && Number.isFinite(maxPx)
            ? Math.max(maxPx, 1, ...advances) : Math.max(1, ...advances);
        const lineFactor = isMText ? (5 / 3) * (Number(node.lineSpacingFactor) || 1) : 1.22;
        const lineStep = capPx * lineFactor;
        const oblique = Math.max(-85, Math.min(85, Number(node.oblique) || 0));
        const skew = Math.tan(oblique * Math.PI / 180);
        const halo = !!options.halo;
        const pad = Math.ceil(fontPx * (halo ? 0.09 : 0.025) + Math.abs(skew) * (capPx + fontPx * 0.3));
        const firstAscent = ctx.measureText(lines[0] || 'H').actualBoundingBoxAscent || capPx;
        const baseline = pad + Math.max(capPx, firstAscent);
        const capTop = baseline - capPx;
        let inkTop = baseline;
        let inkBottom = baseline;
        for (let i = 0; i < lines.length; i++) {
            if (runLines) {
                runLines[i].forEach(g => {
                    ctx.font = inlineFont(g, fontPx, font);
                    const m = ctx.measureText(g.text);
                    inkTop = Math.min(inkTop, baseline + i * lineStep - (m.actualBoundingBoxAscent || capPx));
                    inkBottom = Math.max(inkBottom, baseline + i * lineStep + (m.actualBoundingBoxDescent || 0));
                });
            } else {
                const m = ctx.measureText(lines[i] || ' ');
                inkTop = Math.min(inkTop, baseline + i * lineStep - (m.actualBoundingBoxAscent || capPx));
                inkBottom = Math.max(inkBottom, baseline + i * lineStep + (m.actualBoundingBoxDescent || 0));
            }
        }
        const contentHeight = Math.max(capPx, inkBottom - Math.min(capTop, inkTop));
        const cssWidth = Math.max(2, Math.ceil(blockWidth + pad * 2));
        const cssHeight = Math.max(2, Math.ceil(baseline + (contentHeight - capPx) + pad));
        const h = Number(node.halign) || 0, v = Number(node.valign) || 0;
        const anchorX = pad + ((h === 1 || h === 4) ? blockWidth / 2 : h === 2 ? blockWidth : 0);
        const anchorY = node.__inkAnchor
            ? (v === 3 ? inkTop : v === 1 ? inkBottom : (inkTop + inkBottom) / 2)
            : (v === 3 ? capTop : v === 1 ? inkBottom
                : h === 4 ? (inkTop + inkBottom) / 2
                : v === 2 ? (isMText ? (capTop + inkBottom) / 2 : (capTop + baseline) / 2)
                : baseline);
        return { fontPx, font, capPx, unit, widthFactor, lines, runLines, advances, blockWidth,
            lineStep, baseline, capTop, inkTop, inkBottom, cssWidth, cssHeight, pad, skew,
            anchorX, anchorY, worldWidth: cssWidth * unit * widthFactor,
            worldHeight: cssHeight * unit, advanceWorld: blockWidth * unit * widthFactor,
            centerX: anchorX / cssWidth, centerY: (cssHeight - anchorY) / cssHeight };
    }

    function rasterize(node, options = {}) {
        const canvas = document.createElement('canvas');
        let ctx = canvas.getContext('2d');
        const m = layout(ctx, node, options);
        const ratio = Math.min(Number(options.pixelRatio) || 1, 2);
        canvas.width = Math.ceil(m.cssWidth * ratio);
        canvas.height = Math.ceil(m.cssHeight * ratio);
        ctx = canvas.getContext('2d');
        ctx.scale(ratio, ratio);
        ctx.font = `${m.fontPx}px ${m.font}`;
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = options.color || '#000000';
        if (options.halo) {
            ctx.strokeStyle = options.haloColor || 'rgba(0,0,0,0.72)';
            ctx.lineWidth = Math.max(2, m.fontPx * 0.045);
        }
        m.lines.forEach((line, i) => {
            const h = Number(node.halign) || 0;
            const offset = h === 1 || h === 4 ? (m.blockWidth - m.advances[i]) / 2 : h === 2 ? m.blockWidth - m.advances[i] : 0;
            const x = m.pad + offset, y = m.baseline + i * m.lineStep;
            if (m.runLines) {
                let cursor = x;
                m.runLines[i].forEach(g => {
                    ctx.save();
                    ctx.font = inlineFont(g, m.fontPx, m.font);
                    ctx.fillStyle = g.color || options.color || '#000000';
                    ctx.translate(cursor, y);
                    ctx.transform(g.widthScale, 0, m.skew, 1, 0, 0);
                    if (options.halo) ctx.strokeText(g.text, 0, 0);
                    ctx.fillText(g.text, 0, 0);
                    if (g.underline) {
                        ctx.beginPath(); ctx.moveTo(0, m.fontPx * 0.08);
                        ctx.lineTo(g.advance / g.widthScale, m.fontPx * 0.08);
                        ctx.lineWidth = Math.max(1, m.fontPx * 0.025);
                        ctx.strokeStyle = ctx.fillStyle; ctx.stroke();
                    }
                    ctx.restore();
                    cursor += g.advance;
                });
                return;
            }
            ctx.save();
            if (m.skew) { ctx.translate(x, y); ctx.transform(1, 0, m.skew, 1, 0, 0); }
            if (options.halo) ctx.strokeText(line, m.skew ? 0 : x, m.skew ? 0 : y);
            ctx.fillText(line, m.skew ? 0 : x, m.skew ? 0 : y);
            ctx.restore();
        });
        return { canvas, ...m };
    }

    function positionedRuns(node, layoutInfo) {
        const m = layoutInfo;
        const angle = (Number(node.rotation) || 0) * Math.PI / 180;
        const rc = Math.cos(angle), rs = Math.sin(angle);
        const align = Number(node.halign) || 0;
        const result = [];
        m.lines.forEach((line, lineIndex) => {
            if (!line.trim()) return;
            const justify = align === 1 || align === 4
                ? (m.blockWidth - m.advances[lineIndex]) / 2
                : align === 2 ? m.blockWidth - m.advances[lineIndex] : 0;
            const runs = m.runLines?.[lineIndex] || [{ text: line, advance: m.advances[lineIndex],
                heightScale: 1, widthScale: 1, font: m.font, bold: false, italic: false }];
            let cursor = 0;
            for (const run of runs) {
                const lx = (m.pad + justify + cursor - m.anchorX) * m.unit * m.widthFactor;
                const ly = -(m.baseline + lineIndex * m.lineStep - m.anchorY) * m.unit;
                result.push({ text: run.text, x: node.x + lx * rc - ly * rs,
                    y: node.y + lx * rs + ly * rc, height: m.fontPx * run.heightScale * m.unit,
                    advance: run.advance * m.unit * m.widthFactor,
                    font: run.font || m.font, bold: !!run.bold, italic: !!run.italic,
                    color: run.color || '', angle: Number(node.rotation) || 0 });
                cursor += run.advance;
            }
        });
        return result;
    }

    function getTexture(THREE, node, options = {}) {
        const cache = options.cache;
        const fontPx = Number(options.fontPx) || 72;
        const rasterOptions = { font: node.font, fontPx, color: options.color, aci7Color: options.aci7Color,
            pixelRatio: options.pixelRatio, halo: options.halo, haloColor: options.haloColor };
        const key = JSON.stringify([node.text, node.height, node.width, node.halign, node.valign,
            node.isMText, node.lineSpacingFactor, node.font, node.widthFactor, node.oblique,
            options.color, options.aci7Color, options.halo, options.haloColor, fontPx, options.pixelRatio]);
        let entry = cache?.get(key);
        if (!entry) {
            const raster = rasterize(node, rasterOptions);
            const texture = new THREE.CanvasTexture(raster.canvas);
            texture.needsUpdate = true;
            entry = { ...raster, texture };
            if (cache) {
                // Active sprites can still reference evicted textures; leave disposal
                // to scene cleanup rather than invalidating their material maps.
                const limit = Number(options.cacheLimit) || 2000;
                if (cache.size >= limit) cache.delete(cache.keys().next().value);
                cache.set(key, entry);
            }
        }
        return entry;
    }

    function prepareNode(node) {
        if ((node.halign !== 3 && node.halign !== 5) ||
            !Number.isFinite(node.endX) || !Number.isFinite(node.endY)) return node;
        const dx = node.endX - node.x, dy = node.endY - node.y;
        const distance = Math.hypot(dx, dy);
        if (distance <= 1e-9 || typeof document === 'undefined') return node;
        const ctx = document.createElement('canvas').getContext('2d');
        const m = layout(ctx, node, { font: node.font, fontPx: 72 });
        if (m.advanceWorld <= 1e-9) return node;
        const ratio = distance / m.advanceWorld;
        return { ...node, height: node.halign === 3 ? node.height * ratio : node.height,
            widthFactor: node.halign === 5 ? (Number(node.widthFactor) || 1) * ratio : node.widthFactor,
            rotation: Math.atan2(dy, dx) * 180 / Math.PI, halign: 0, valign: 0 };
    }

    function makeSprite(THREE, rawNode, options = {}) {
        const node = prepareNode(rawNode);
        const entry = getTexture(THREE, node, options);
        const material = new THREE.SpriteMaterial({ map: entry.texture, transparent: true,
            depthTest: false, depthWrite: false, opacity: options.opacity ?? 1 });
        material.rotation = THREE.MathUtils.degToRad(Number(node.rotation) || 0);
        const sprite = new THREE.Sprite(material);
        sprite.renderOrder = 10;
        sprite.center.set(entry.centerX, entry.centerY);
        sprite.scale.set(entry.worldWidth, entry.worldHeight, 1);
        sprite.position.set(node.x, node.y, 0.05);
        sprite.userData.__dxfText = true;
        sprite.userData.__textWorldHeight = Math.abs(Number(node.height)) || 1;
        sprite.userData.__layout = entry;
        sprite.userData.__resolvedNode = node;
        const rc = Math.cos(material.rotation), rs = Math.sin(material.rotation);
        const skewReach = Math.abs(entry.skew) * entry.capPx;
        const lx0 = (entry.pad - entry.anchorX - skewReach) * entry.unit * entry.widthFactor;
        const lx1 = (entry.pad + entry.blockWidth - entry.anchorX + skewReach) * entry.unit * entry.widthFactor;
        const ly0 = (entry.anchorY - entry.inkBottom) * entry.unit;
        const ly1 = (entry.anchorY - entry.inkTop) * entry.unit;
        const toWorld = (lx, ly) => ({ x: node.x + lx * rc - ly * rs,
            y: node.y + lx * rs + ly * rc });
        const corners = [toWorld(lx0, ly0), toWorld(lx1, ly0), toWorld(lx1, ly1), toWorld(lx0, ly1)];
        sprite.userData.__worldCorners = corners;
        sprite.userData.__textFrame = { x: node.x, y: node.y, cos: rc, sin: rs, lx0, lx1, ly0, ly1 };
        sprite.userData.__worldRect = { minX: Math.min(...corners.map(p => p.x)),
            maxX: Math.max(...corners.map(p => p.x)), minY: Math.min(...corners.map(p => p.y)),
            maxY: Math.max(...corners.map(p => p.y)) };
        return sprite;
    }

    return { FONT_STACKS, rotationDegrees, parseStyles, applyRawTextProps, fontFamily, resolve, normalizeText, parseInline, layout, rasterize, positionedRuns, getTexture, prepareNode, makeSprite };
});
