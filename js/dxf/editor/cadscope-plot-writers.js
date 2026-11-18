/* Render prepared millimeter plot jobs; layout selection and job construction stay app-owned. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfEditorPlotWriters = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function chainPlotSegments(segs) {
        const runs = [];
        let cur = null;
        for (let i = 0; i + 3 < segs.length; i += 4) {
            const ax = segs[i], ay = segs[i + 1], bx = segs[i + 2], by = segs[i + 3];
            if (cur && Math.abs(cur[cur.length - 2] - ax) < 1e-6 && Math.abs(cur[cur.length - 1] - ay) < 1e-6) cur.push(bx, by);
            else { cur = [ax, ay, bx, by]; runs.push(cur); }
        }
        return runs;
    }

    const plotHex = (c) => '#' + (c & 0xffffff).toString(16).padStart(6, '0');
    const plotNum = (v) => (Math.round(v * 1000) / 1000).toString();
    const plotEsc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');


    function drawPlotJobPdf(pdf, job, pdfFontFamily) {
        const { page } = job;
        const MM_TO_PT = 72 / 25.4;
        const rgb3 = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
        pdf.setLineCap('round');
        pdf.setLineJoin('round');
        const c = job.clip;
        const clipped = c && (c.x > 0.01 || c.y > 0.01 || c.x + c.w < page.width - 0.01 || c.y + c.h < page.height - 0.01);
        if (clipped) {
            try { pdf.saveGraphicsState(); pdf.rect(c.x, c.y, c.w, c.h, null); pdf.clip(); pdf.discardPath(); } catch (e) { /* no clip API */ }
        }
        for (const L of job.layers) {
            for (const f of L.fills) {
                try {
                    const ops = [];
                    if (f.tris) {
                        const t = f.tris;
                        for (let i = 0; i + 5 < t.length; i += 6) {
                            ops.push({ op: 'm', c: [t[i], t[i + 1]] }, { op: 'l', c: [t[i + 2], t[i + 3]] },
                                { op: 'l', c: [t[i + 4], t[i + 5]] }, { op: 'h', c: [] });
                        }
                    } else {
                        for (const r of f.rings) {
                            ops.push({ op: 'm', c: r[0] });
                            for (let i = 1; i < r.length; i++) ops.push({ op: 'l', c: r[i] });
                            ops.push({ op: 'h', c: [] });
                        }
                    }
                    if (!ops.length) continue;
                    pdf.setFillColor(...rgb3(f.rgb));
                    pdf.path(ops);
                    if (f.tris) pdf.fill(); else pdf.fillEvenOdd();
                } catch (e) { /* fill API missing: linework still plots */ }
            }
            for (const g of L.strokes) {
                pdf.setDrawColor(...rgb3(g.rgb));
                pdf.setLineWidth(Math.max(g.lw, 0.02));
                const ops = [];
                for (const run of chainPlotSegments(g.segs)) {
                    ops.push({ op: 'm', c: [run[0], run[1]] });
                    for (let i = 2; i + 1 < run.length; i += 2) ops.push({ op: 'l', c: [run[i], run[i + 1]] });
                }
                if (!ops.length) continue;
                try { pdf.path(ops); pdf.stroke(); }
                catch (e) { for (let i = 0; i + 3 < g.segs.length; i += 4) pdf.line(g.segs[i], g.segs[i + 1], g.segs[i + 2], g.segs[i + 3]); }
            }
            for (const t of L.texts) {
                pdf.setTextColor(...rgb3(t.rgb));
                const font = String(t.font || '');
                pdf.setFont(pdfFontFamily(font),
                    t.bold && t.italic ? 'bolditalic' : t.bold ? 'bold' : t.italic ? 'italic' : 'normal');
                pdf.setFontSize(t.hMm * MM_TO_PT);
                const opts = { angle: t.angle, align: t.align, baseline: t.baseline };
                if (t.multiline) {
                    t.str.split('\n').forEach((line, li) => { if (line.trim()) pdf.text(line, t.x, t.y + li * t.hMm * 1.3, opts); });
                } else pdf.text(t.str, t.x, t.y, opts);
            }
        }
        if (clipped) { try { pdf.restoreGraphicsState(); } catch (e) { /* ignore */ } }
        return pdf;
    }

    function writePlotSvg(job) {
        const { page, clip } = job;
        const out = [];
        out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${plotNum(page.width)}mm" height="${plotNum(page.height)}mm" viewBox="0 0 ${plotNum(page.width)} ${plotNum(page.height)}">`);
        out.push(`<defs><clipPath id="plotclip"><rect x="${plotNum(clip.x)}" y="${plotNum(clip.y)}" width="${plotNum(clip.w)}" height="${plotNum(clip.h)}"/></clipPath></defs>`);
        out.push(`<rect width="100%" height="100%" fill="#fff"/><g clip-path="url(#plotclip)" stroke-linecap="round" stroke-linejoin="round" font-family="Helvetica, Arial, sans-serif">`);
        for (const L of job.layers) {
            out.push(`<g data-layer="${plotEsc(L.name)}">`);
            for (const f of L.fills) {
                let d = '';
                if (f.tris) { const t = f.tris; for (let i = 0; i + 5 < t.length; i += 6) d += `M${plotNum(t[i])} ${plotNum(t[i + 1])}L${plotNum(t[i + 2])} ${plotNum(t[i + 3])}L${plotNum(t[i + 4])} ${plotNum(t[i + 5])}Z`; }
                else for (const r of f.rings) d += 'M' + r.map(p => plotNum(p[0]) + ' ' + plotNum(p[1])).join('L') + 'Z';
                if (d) out.push(`<path d="${d}" fill="${plotHex(f.rgb)}" fill-rule="${f.tris ? 'nonzero' : 'evenodd'}" stroke="none"/>`);
            }
            for (const g of L.strokes) {
                let d = '';
                for (const run of chainPlotSegments(g.segs)) {
                    d += 'M' + plotNum(run[0]) + ' ' + plotNum(run[1]);
                    for (let i = 2; i + 1 < run.length; i += 2) d += 'L' + plotNum(run[i]) + ' ' + plotNum(run[i + 1]);
                }
                if (d) out.push(`<path d="${d}" fill="none" stroke="${plotHex(g.rgb)}" stroke-width="${plotNum(Math.max(g.lw, 0.02))}"/>`);
            }
            for (const t of L.texts) {
                const anchor = t.align === 'center' ? ' text-anchor="middle"' : '';
                const base = t.baseline === 'top' ? ' dominant-baseline="hanging"' : t.baseline === 'middle' ? ' dominant-baseline="middle"' : '';
                const rot = t.angle ? ` transform="rotate(${plotNum(-t.angle)} ${plotNum(t.x)} ${plotNum(t.y)})"` : '';
                const lines = t.multiline ? t.str.split('\n') : [t.str];
                const body = lines.length > 1
                    ? lines.map((ln, i) => `<tspan x="${plotNum(t.x)}" y="${plotNum(t.y + i * t.hMm * 1.3)}">${plotEsc(ln)}</tspan>`).join('')
                    : plotEsc(t.str);
                out.push(`<text x="${plotNum(t.x)}" y="${plotNum(t.y)}" font-size="${plotNum(t.hMm)}" font-family="${plotEsc(t.font || 'Helvetica, Arial, sans-serif')}" font-weight="${t.bold ? 'bold' : 'normal'}" font-style="${t.italic ? 'italic' : 'normal'}" fill="${plotHex(t.rgb)}"${anchor}${base}${rot}>${body}</text>`);
            }
            out.push('</g>');
        }
        out.push('</g></svg>');
        return out.join('\n');
    }

    function drawPlotJob(ctx, job, pxPerMm, minPx = 0.6) {
        const { page, clip } = job;
        ctx.save();
        ctx.scale(pxPerMm, pxPerMm);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, page.width, page.height);
        ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip();
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const L of job.layers) {
            for (const f of L.fills) {
                ctx.fillStyle = plotHex(f.rgb);
                ctx.beginPath();
                if (f.tris) { const t = f.tris; for (let i = 0; i + 5 < t.length; i += 6) { ctx.moveTo(t[i], t[i + 1]); ctx.lineTo(t[i + 2], t[i + 3]); ctx.lineTo(t[i + 4], t[i + 5]); ctx.closePath(); } ctx.fill('nonzero'); }
                else { for (const r of f.rings) { ctx.moveTo(r[0][0], r[0][1]); for (let i = 1; i < r.length; i++) ctx.lineTo(r[i][0], r[i][1]); ctx.closePath(); } ctx.fill('evenodd'); }
            }
            for (const g of L.strokes) {
                ctx.strokeStyle = plotHex(g.rgb);
                ctx.lineWidth = Math.max(g.lw, minPx / pxPerMm);
                ctx.beginPath();
                for (const run of chainPlotSegments(g.segs)) { ctx.moveTo(run[0], run[1]); for (let i = 2; i + 1 < run.length; i += 2) ctx.lineTo(run[i], run[i + 1]); }
                ctx.stroke();
            }
            for (const t of L.texts) {
                ctx.save();
                ctx.translate(t.x, t.y);
                if (t.angle) ctx.rotate(-t.angle * Math.PI / 180);
                ctx.fillStyle = plotHex(t.rgb);
                ctx.font = `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${t.hMm}px ${t.font || 'Helvetica, Arial, sans-serif'}`;
                ctx.textAlign = t.align === 'center' ? 'center' : 'left';
                ctx.textBaseline = t.baseline === 'top' ? 'top' : t.baseline === 'middle' ? 'middle' : 'alphabetic';
                const lines = t.multiline ? t.str.split('\n') : [t.str];
                lines.forEach((ln, i) => ctx.fillText(ln, 0, i * t.hMm * 1.3));
                ctx.restore();
            }
        }
        ctx.restore();
    }

    return { pdf: drawPlotJobPdf, svg: writePlotSvg, canvas: drawPlotJob, hex: plotHex, number: plotNum, escape: plotEsc };
});
