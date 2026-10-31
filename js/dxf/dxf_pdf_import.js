/**
 * dxf_pdf_import.js — turn a PDF page's operator list into DXF entities.
 *
 * PDF.js is used only as a parser: `page.getOperatorList()` hands back the
 * content stream already tokenised, and this module walks it. Nothing here
 * renders, so no canvas, no fonts and no image decoding are involved.
 *
 * Loaded as a classic script. Exposes window.DxfPdfImport.
 * Zero DOM dependencies — fully testable in Node (module.exports fallback).
 *
 * ---------------------------------------------------------------------------
 * The operator list contract (verified against PDF.js v6.1.200)
 *
 *   { fnArray: [opId, ...], argsArray: [args, ...] }
 *
 * Path construction is NOT one operator per segment. The worker batches an
 * entire path into a single `constructPath`:
 *
 *   argsArray[i] = [ paintOpId, [drawOps], minMax ]
 *
 * where `drawOps` is a flat (typed) array of numbers:
 *
 *   0 x y                    moveTo
 *   1 x y                    lineTo
 *   2 x1 y1 x2 y2 x3 y3      cubic curveTo
 *   3 x1 y1 x2 y2            quadratic curveTo
 *   4                        closePath
 *
 * and `paintOpId` is the painting operator that consumed the path (stroke,
 * fill, eoFill, fillStroke…). A `re` in the source stream arrives here already
 * expanded into moveTo/lineTo/lineTo/lineTo/closePath.
 *
 * Colours arrive normalised to CSS hex strings on `setStrokeRGBColor` /
 * `setFillRGBColor`, whatever colour space the file used — gray and CMYK are
 * converted upstream, so this module never sees `g` or `k`.
 * ---------------------------------------------------------------------------
 */
(function (root) {
    'use strict';

    /**
     * PDF.js v6 operator numbering. The browser passes the live `OPS` object so
     * a renumbering in a future release is picked up automatically; this copy
     * exists so the module can be exercised in Node without loading PDF.js.
     */
    const DEFAULT_OPS = {
        dependency: 1, setLineWidth: 2, setLineCap: 3, setLineJoin: 4,
        setMiterLimit: 5, setDash: 6, setRenderingIntent: 7, setFlatness: 8,
        setGState: 9, save: 10, restore: 11, transform: 12,
        moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17,
        closePath: 18, rectangle: 19,
        stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24,
        eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27,
        endPath: 28, clip: 29, eoClip: 30,
        setStrokeRGBColor: 58, setFillRGBColor: 59,
        paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
        constructPath: 91,
    };

    /** Sub-operators inside a constructPath payload. */
    const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadTo: 3, closePath: 4 };

    const IDENTITY = [1, 0, 0, 1, 0, 0];

    // ---------------------------------------------------------------- matrix --
    // PDF matrices are [a b c d e f], applied to row vectors: p' = [x y 1] · M.
    // `cm` concatenates as CTM' = M · CTM, so the new matrix applies first.

    function matMul(m, n) {
        return [
            m[0] * n[0] + m[1] * n[2],
            m[0] * n[1] + m[1] * n[3],
            m[2] * n[0] + m[3] * n[2],
            m[2] * n[1] + m[3] * n[3],
            m[4] * n[0] + m[5] * n[2] + n[4],
            m[4] * n[1] + m[5] * n[3] + n[5],
        ];
    }

    function apply(m, x, y) {
        return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
    }

    /** Average scale a matrix applies, for converting line widths to output units. */
    function matScale(m) {
        const sx = Math.hypot(m[0], m[1]);
        const sy = Math.hypot(m[2], m[3]);
        return (sx + sy) / 2;
    }

    // ----------------------------------------------------------------- colour --

    /** '#rrggbb' → 0xrrggbb. PDF.js normalises every colour space to this form. */
    function parseColor(value) {
        if (typeof value !== 'string') return null;
        const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
        return m ? parseInt(m[1], 16) : null;
    }

    // -------------------------------------------------------------- flattening --

    const TAU = Math.PI * 2;
    const normAngle = (a) => ((a % TAU) + TAU) % TAU;

    function cubicAt(p0, p1, p2, p3, t) {
        const u = 1 - t;
        return {
            x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
            y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        };
    }

    /** Circle through three points, or null when they are collinear. */
    function circleThrough(a, b, c) {
        const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
        if (Math.abs(d) < 1e-12) return null;
        const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
        const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
        const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
        return { x: cx, y: cy, r: Math.hypot(a.x - cx, a.y - cy) };
    }

    /**
     * If a cubic is really a circular arc — which is what a CAD exporter writes
     * for every circle, fillet and rounded corner — recover it as a bulge rather
     * than flattening it into a hundred chords.
     *
     * The test is honest rather than clever: build the circle through the two
     * ends and the midpoint, then check that the curve stays on it. Returns the
     * bulge (tan of a quarter of the signed sweep) or null.
     */
    function fitArcBulge(p0, p1, p2, p3, tolerance) {
        const mid = cubicAt(p0, p1, p2, p3, 0.5);
        const circle = circleThrough(p0, mid, p3);
        if (!circle || !(circle.r > 0)) return null;
        // A radius far larger than the curve itself is a straight line pretending
        // to be an arc; the bulge would be meaningless and the maths ill-conditioned.
        const chord = Math.hypot(p3.x - p0.x, p3.y - p0.y);
        if (!(chord > 1e-12) || circle.r > chord * 1e4) return null;

        for (const t of [0.125, 0.25, 0.375, 0.625, 0.75, 0.875]) {
            const s = cubicAt(p0, p1, p2, p3, t);
            if (Math.abs(Math.hypot(s.x - circle.x, s.y - circle.y) - circle.r) > tolerance) return null;
        }

        const a0 = Math.atan2(p0.y - circle.y, p0.x - circle.x);
        const am = Math.atan2(mid.y - circle.y, mid.x - circle.x);
        const a3 = Math.atan2(p3.y - circle.y, p3.x - circle.x);
        // Whichever way round reaches the midpoint first is the way the arc goes.
        const ccwToEnd = normAngle(a3 - a0);
        const ccwToMid = normAngle(am - a0);
        const sweep = ccwToMid < ccwToEnd ? ccwToEnd : ccwToEnd - TAU;
        // One cubic cannot faithfully carry more than about a half turn.
        if (!(Math.abs(sweep) > 1e-9) || Math.abs(sweep) > Math.PI + 1e-9) return null;
        return Math.tan(sweep / 4);
    }

    /**
     * Sample a cubic Bézier densely enough that it reads as a curve.
     *
     * The control net is an upper bound on arc length, so it gives a cheap
     * segment count without measuring the curve itself. Flattening happens
     * after the points are transformed, so `tolerance` is in output units and
     * the result does not get coarser as the page is scaled up.
     */
    function flattenCubic(p0, p1, p2, p3, tolerance, out) {
        const net = Math.hypot(p1.x - p0.x, p1.y - p0.y)
                  + Math.hypot(p2.x - p1.x, p2.y - p1.y)
                  + Math.hypot(p3.x - p2.x, p3.y - p2.y);
        const steps = Math.max(2, Math.min(64, Math.ceil(net / Math.max(tolerance, 1e-9))));
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            out.push(cubicAt(p0, p1, p2, p3, t));
        }
    }

    /**
     * Add a cubic to a run of vertices, as a single bulged span where the curve
     * is circular and as chords where it is not.
     */
    function emitCubic(p0, p1, p2, p3, tolerance, out, arcs) {
        if (arcs) {
            const bulge = fitArcBulge(p0, p1, p2, p3, tolerance);
            if (bulge !== null) {
                if (out.length) out[out.length - 1].bulge = bulge;
                out.push({ x: p3.x, y: p3.y });
                return true;
            }
        }
        flattenCubic(p0, p1, p2, p3, tolerance, out);
        return false;
    }

    /** A quadratic raised to a cubic, so one flattener covers both. */
    function quadToCubic(p0, c, p1) {
        return [
            { x: p0.x + (2 / 3) * (c.x - p0.x), y: p0.y + (2 / 3) * (c.y - p0.y) },
            { x: p1.x + (2 / 3) * (c.x - p1.x), y: p1.y + (2 / 3) * (c.y - p1.y) },
        ];
    }

    /**
     * Walk one constructPath payload into subpaths of transformed points.
     * Returns [{ points: [{x,y}], closed }].
     */
    function buildSubpaths(drawOps, ctm, tolerance, arcs) {
        const subpaths = [];
        let current = null;
        let cursor = { x: 0, y: 0 };

        const open = (pt) => {
            current = { points: [pt], closed: false };
            subpaths.push(current);
        };

        const n = drawOps ? drawOps.length : 0;
        for (let i = 0; i < n;) {
            switch (drawOps[i++]) {
                case DRAW.moveTo: {
                    cursor = apply(ctm, drawOps[i++], drawOps[i++]);
                    open(cursor);
                    break;
                }
                case DRAW.lineTo: {
                    cursor = apply(ctm, drawOps[i++], drawOps[i++]);
                    if (!current) open(cursor); else current.points.push(cursor);
                    break;
                }
                case DRAW.curveTo: {
                    const c1 = apply(ctm, drawOps[i++], drawOps[i++]);
                    const c2 = apply(ctm, drawOps[i++], drawOps[i++]);
                    const end = apply(ctm, drawOps[i++], drawOps[i++]);
                    if (!current) open(cursor);
                    if (emitCubic(cursor, c1, c2, end, tolerance, current.points, arcs)) current.hasArc = true;
                    cursor = end;
                    break;
                }
                case DRAW.quadTo: {
                    const c = apply(ctm, drawOps[i++], drawOps[i++]);
                    const end = apply(ctm, drawOps[i++], drawOps[i++]);
                    if (!current) open(cursor);
                    const [c1, c2] = quadToCubic(cursor, c, end);
                    if (emitCubic(cursor, c1, c2, end, tolerance, current.points, arcs)) current.hasArc = true;
                    cursor = end;
                    break;
                }
                case DRAW.closePath: {
                    if (current) {
                        current.closed = true;
                        cursor = current.points[0];
                    }
                    break;
                }
                default:
                    return subpaths;      // unknown sub-op: stop rather than misread
            }
        }
        return subpaths;
    }

    // ------------------------------------------------------------- entity build --

    /** Drop consecutive duplicate points; they add nothing and upset area maths. */
    function dedupePoints(points, eps) {
        const out = [];
        for (const p of points) {
            const last = out[out.length - 1];
            if (last && Math.hypot(p.x - last.x, p.y - last.y) <= eps) {
                // Coincident points collapse, but a bulge on the one being dropped
                // describes a real arc and has to move onto the survivor.
                if (p.bulge && !last.bulge) last.bulge = p.bulge;
                continue;
            }
            out.push(p);
        }
        return out;
    }

    function makePolyline(points, closed, layer, color, lineWidth, eps) {
        const pts = dedupePoints(points, eps);
        // A closed run whose last point repeats the first carries the closing
        // span implicitly, so the duplicate is redundant.
        if (closed && pts.length > 2) {
            const a = pts[0], b = pts[pts.length - 1];
            if (Math.hypot(a.x - b.x, a.y - b.y) <= eps) pts.pop();
        }
        if (pts.length < 2) return null;
        const e = {
            type: 'LWPOLYLINE',
            layer,
            vertices: pts.map(p => ({ x: p.x, y: p.y, bulge: Number(p.bulge) || 0 })),
            shape: !!closed,
            closed: !!closed,
        };
        if (color !== null && color !== undefined) e.trueColor = color;
        if (Number.isFinite(lineWidth)) e.lineWidthPt = lineWidth;
        return e;
    }

    /** Signed area — used to tell a real region from a degenerate sliver. */
    function ringArea(points) {
        let a = 0;
        for (let i = 0, n = points.length; i < n; i++) {
            const p = points[i], q = points[(i + 1) % n];
            a += p.x * q.y - q.x * p.y;
        }
        return a / 2;
    }

    // ---------------------------------------------------------------- the walk --

    /**
     * Convert an operator list into DXF entity objects in the viewer's own shape.
     *
     *   opList   { fnArray, argsArray } from page.getOperatorList()
     *   options
     *     OPS         the live PDF.js OPS enum (defaults to the v6 numbering)
     *     view        page.view — [x0, y0, x1, y1]; its origin is subtracted so
     *                 the drawing starts at 0,0
     *     rotate      page.rotate in degrees (0/90/180/270)
     *     layer       layer name for everything produced
     *     tolerance   curve flattening tolerance, in points
     *     fills       'hatch' | 'outline' | 'skip'
     *     onProgress  called with (processed, total) every so often
     *
     * Returns { entities, hatchSeeds, stats, warnings }, where `hatchSeeds` are
     * closed boundaries the caller can hand to DxfHatch to build solid fills.
     */
    function extractEntities(opList, options) {
        const o = options || {};
        const OPS = o.OPS || DEFAULT_OPS;
        const layer = o.layer || 'PDF';
        const tolerance = Number.isFinite(o.tolerance) && o.tolerance > 0 ? o.tolerance : 0.05;
        const fills = o.fills || 'hatch';
        const arcs = o.arcs !== false;
        const eps = tolerance / 10;

        const fnArray = opList?.fnArray || [];
        const argsArray = opList?.argsArray || [];

        const base = pageBaseMatrix(o.view, o.rotate);

        const entities = [];
        const hatchSeeds = [];
        const warnings = [];
        const stats = { paths: 0, strokes: 0, fills: 0, arcs: 0, skipped: 0, unsupported: {} };

        let state = {
            ctm: base,
            strokeColor: 0x000000,
            fillColor: 0x000000,
            lineWidth: 1,
            dash: null,
        };
        const stack = [];

        const note = (name) => {
            stats.unsupported[name] = (stats.unsupported[name] || 0) + 1;
        };

        const PAINT = {
            [OPS.stroke]: { stroke: true, fill: false, close: false },
            [OPS.closeStroke]: { stroke: true, fill: false, close: true },
            [OPS.fill]: { stroke: false, fill: true, close: true },
            [OPS.eoFill]: { stroke: false, fill: true, close: true },
            [OPS.fillStroke]: { stroke: true, fill: true, close: false },
            [OPS.eoFillStroke]: { stroke: true, fill: true, close: false },
            [OPS.closeFillStroke]: { stroke: true, fill: true, close: true },
            [OPS.closeEOFillStroke]: { stroke: true, fill: true, close: true },
        };

        const total = fnArray.length;
        const progressEvery = Math.max(1, Math.floor(total / 50));

        for (let i = 0; i < total; i++) {
            const fn = fnArray[i];
            const args = argsArray[i];

            if (o.onProgress && i % progressEvery === 0) o.onProgress(i, total);

            switch (fn) {
                case OPS.save:
                    stack.push({ ...state });
                    break;

                case OPS.restore:
                    if (stack.length) state = stack.pop();
                    else warnings.push('restore without a matching save');
                    break;

                case OPS.transform:
                    if (args && args.length >= 6) {
                        state.ctm = matMul(
                            [args[0], args[1], args[2], args[3], args[4], args[5]],
                            state.ctm);
                    }
                    break;

                case OPS.setLineWidth:
                    state.lineWidth = Number(args?.[0]) || 0;
                    break;

                case OPS.setDash:
                    state.dash = Array.isArray(args?.[0]) && args[0].length ? [...args[0]] : null;
                    break;

                case OPS.setStrokeRGBColor: {
                    const c = parseColor(args?.[0]);
                    if (c !== null) state.strokeColor = c;
                    break;
                }

                case OPS.setFillRGBColor: {
                    const c = parseColor(args?.[0]);
                    if (c !== null) state.fillColor = c;
                    break;
                }

                case OPS.constructPath: {
                    // args = [paintOpId, [drawOps], minMax]
                    const paintOp = args?.[0];
                    const drawOps = args?.[1]?.[0];
                    const mode = PAINT[paintOp];
                    if (!drawOps || !mode) {
                        if (paintOp !== OPS.endPath && paintOp !== OPS.clip && paintOp !== OPS.eoClip) {
                            note('paint:' + paintOp);
                        }
                        break;
                    }
                    stats.paths++;
                    const subpaths = buildSubpaths(drawOps, state.ctm, tolerance, arcs);
                    const widthOut = state.lineWidth * matScale(state.ctm);

                    for (const sp of subpaths) {
                        if (sp.hasArc) stats.arcs++;
                        const closed = sp.closed || mode.close;

                        if (mode.fill && fills !== 'skip') {
                            const pts = dedupePoints(sp.points, eps);
                            if (pts.length >= 3 && Math.abs(ringArea(pts)) > eps * eps) {
                                stats.fills++;
                                if (fills === 'hatch') {
                                    hatchSeeds.push({ points: pts, color: state.fillColor, layer });
                                } else {
                                    const e = makePolyline(sp.points, true, layer, state.fillColor, null, eps);
                                    if (e) entities.push(e);
                                }
                            } else {
                                stats.skipped++;
                            }
                        }

                        if (mode.stroke) {
                            const e = makePolyline(sp.points, closed, layer, state.strokeColor, widthOut, eps);
                            if (e) { entities.push(e); stats.strokes++; }
                            else stats.skipped++;
                        }
                    }
                    break;
                }

                // Deliberately ignored: clipping is not representable in DXF, and
                // images have no vector equivalent at all.
                case OPS.clip:
                case OPS.eoClip:
                case OPS.endPath:
                case OPS.dependency:
                case OPS.setLineCap:
                case OPS.setLineJoin:
                case OPS.setMiterLimit:
                case OPS.setRenderingIntent:
                case OPS.setFlatness:
                case OPS.setGState:
                case OPS.paintFormXObjectBegin:
                case OPS.paintFormXObjectEnd:
                    break;

                default:
                    note(String(fn));
                    break;
            }
        }

        if (stack.length) warnings.push(`${stack.length} unbalanced save(s) at end of page`);
        if (o.onProgress) o.onProgress(total, total);

        return { entities, hatchSeeds, stats, warnings };
    }

    // ===================== Reassembly =====================
    // What comes out of a content stream is not a drawing, it is a pile of marks.
    // These passes turn it back into something a person can edit: identical marks
    // are dropped, straight runs collapse to single spans, and marks that touch
    // are welded into polylines.

    /** Style identity — geometry only welds to geometry that looks the same. */
    function styleKey(e) {
        return [e.layer, e.trueColor ?? '', Number(e.lineWidthPt || 0).toFixed(4)].join('|');
    }

    function quant(v, tol) {
        return Math.round(v / tol);
    }

    /**
     * Drop paths that are drawn more than once. Exporters routinely stroke the
     * same outline twice, and a duplicate is invisible on screen but doubles the
     * work of editing.
     *
     * Direction is normalised so a path and its reverse count as one; a closed
     * path drawn from a different starting vertex is left alone, since detecting
     * that is quadratic and the payoff is small.
     */
    function dedupeEntities(entities, tolerance) {
        const seen = new Set();
        const out = [];
        let removed = 0;
        for (const e of entities) {
            const v = e.vertices;
            const fwd = [], rev = [];
            for (let i = 0; i < v.length; i++) {
                const a = v[i], b = v[v.length - 1 - i];
                fwd.push(quant(a.x, tolerance), quant(a.y, tolerance));
                rev.push(quant(b.x, tolerance), quant(b.y, tolerance));
            }
            // Whichever direction sorts first stands for both.
            const fs = fwd.join(','), rs = rev.join(',');
            const key = styleKey(e) + '#' + (e.shape ? 'C' : 'O') + '#' + (fs < rs ? fs : rs);
            if (seen.has(key)) { removed++; continue; }
            seen.add(key);
            out.push(e);
        }
        return { entities: out, removed };
    }

    /** Perpendicular distance from p to the line through a and b. */
    function pointLineDistance(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
        return Math.abs(dx * (a.y - p.y) - dy * (a.x - p.x)) / len;
    }

    /**
     * Remove vertices that sit on the line between their neighbours. Curved spans
     * are left alone: a bulge describes the span leaving a vertex, so dropping
     * either end of one would silently change the arc.
     */
    function mergeCollinear(vertices, closed, tolerance) {
        const n = vertices.length;
        if (n < 3) return vertices;
        const keep = new Array(n).fill(true);
        const first = closed ? 0 : 1;
        const last = closed ? n - 1 : n - 2;
        let prev = closed ? n - 1 : 0;
        for (let i = first; i <= last; i++) {
            const a = vertices[prev], b = vertices[i], c = vertices[(i + 1) % n];
            if (a.bulge || b.bulge) { prev = i; continue; }
            if (pointLineDistance(b, a, c) <= tolerance) keep[i] = false;
            else prev = i;
        }
        const out = vertices.filter((_, i) => keep[i]);
        return out.length >= (closed ? 3 : 2) ? out : vertices;
    }

    /**
     * Weld chains that share an endpoint into longer polylines.
     *
     * Endpoints go into a grid of cells one tolerance wide; a partner is found by
     * probing the nine cells around a point, which bounds the search to a
     * neighbourhood rather than scanning every other chain. Only chains of
     * matching style are welded, so a red line never absorbs a black one.
     *
     * Where three or more chains meet, one continuation is taken and the rest are
     * left for their own turn — the same thing PEDIT Join does at a junction.
     */
    function weldChains(entities, tolerance) {
        const groups = new Map();
        const passthrough = [];
        for (const e of entities) {
            // Closed rings have no free end, and anything already curved at its
            // ends would need an arc solve to join cleanly.
            if (e.shape || e.closed || !e.vertices || e.vertices.length < 2) {
                passthrough.push(e);
                continue;
            }
            const k = styleKey(e);
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(e);
        }

        const out = [...passthrough];
        let welded = 0;

        for (const group of groups.values()) {
            const used = new Array(group.length).fill(false);
            const cells = new Map();
            const cellKey = (x, y) => quant(x, tolerance) + ':' + quant(y, tolerance);
            const addEnd = (i, which) => {
                const v = group[i].vertices;
                const p = which === 0 ? v[0] : v[v.length - 1];
                const k = cellKey(p.x, p.y);
                if (!cells.has(k)) cells.set(k, []);
                cells.get(k).push({ i, which });
            };
            for (let i = 0; i < group.length; i++) { addEnd(i, 0); addEnd(i, 1); }

            // Any chain with a free end within tolerance of (x, y).
            const findPartner = (x, y, skip) => {
                const cx = quant(x, tolerance), cy = quant(y, tolerance);
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        const bucket = cells.get((cx + dx) + ':' + (cy + dy));
                        if (!bucket) continue;
                        for (const cand of bucket) {
                            if (cand.i === skip || used[cand.i]) continue;
                            const v = group[cand.i].vertices;
                            const p = cand.which === 0 ? v[0] : v[v.length - 1];
                            if (Math.hypot(p.x - x, p.y - y) <= tolerance) return cand;
                        }
                    }
                }
                return null;
            };

            for (let i = 0; i < group.length; i++) {
                if (used[i]) continue;
                used[i] = true;
                let run = reverseCopy(group[i].vertices, false);   // a plain copy
                let joinedHere = 0;

                // Grow forwards from the tail, then backwards from the head.
                for (let dir = 0; dir < 2; dir++) {
                    for (;;) {
                        const tip = dir === 0 ? run[run.length - 1] : run[0];
                        const partner = findPartner(tip.x, tip.y, -1);
                        if (!partner) break;
                        used[partner.i] = true;
                        joinedHere++;
                        let piece = group[partner.i].vertices;
                        // Orient the piece so it continues away from the tip.
                        const startsAtTip = partner.which === 0;
                        if (dir === 0) {
                            piece = startsAtTip ? copyVerts(piece) : reverseCopy(piece, true);
                            run[run.length - 1].bulge = Number(piece[0].bulge) || 0;
                            for (let k = 1; k < piece.length; k++) run.push(piece[k]);
                        } else {
                            piece = startsAtTip ? reverseCopy(piece, true) : copyVerts(piece);
                            run = [...piece.slice(0, piece.length - 1), ...run];
                        }
                        if (run.length > 100000) break;   // pathological self-touching input
                    }
                }

                let closed = false;
                if (run.length > 2) {
                    const a = run[0], b = run[run.length - 1];
                    if (Math.hypot(a.x - b.x, a.y - b.y) <= tolerance) { run.pop(); closed = true; }
                }
                if (joinedHere) welded += joinedHere;
                const merged = { ...group[i], vertices: run, shape: closed, closed };
                out.push(merged);
            }
        }
        return { entities: out, welded };
    }

    function copyVerts(v) {
        return v.map(p => ({ x: p.x, y: p.y, bulge: Number(p.bulge) || 0 }));
    }

    /**
     * Reverse a vertex run. A bulge belongs to the span leaving its vertex, so on
     * reversal each one shifts back a vertex and flips sign — otherwise every arc
     * ends up on the wrong span, bowing the wrong way.
     */
    function reverseCopy(v, reverse) {
        if (!reverse) return copyVerts(v);
        const n = v.length;
        const out = [];
        for (let j = 0; j < n; j++) {
            const s = v[n - 1 - j];
            out.push({
                x: s.x, y: s.y,
                // `|| 0` also folds -0 back to 0, which negation would otherwise leave.
                bulge: (j < n - 1 ? -(Number(v[n - 2 - j].bulge) || 0) : 0) || 0,
            });
        }
        return out;
    }

    /**
     * Run the reassembly passes in the order that compounds best: drop duplicates
     * first so nothing is welded twice, collapse straight runs to cut the vertex
     * count, weld what touches, then collapse again — welding creates fresh
     * collinear joins at every seam.
     *
     *   tolerance  how close endpoints must be to count as touching, in output units
     */
    function optimizeEntities(entities, options) {
        const o = options || {};
        const tol = Number.isFinite(o.tolerance) && o.tolerance > 0 ? o.tolerance : 0.01;
        const stats = { before: entities.length, duplicates: 0, welded: 0, verticesBefore: 0, verticesAfter: 0 };
        for (const e of entities) stats.verticesBefore += e.vertices?.length || 0;

        // Text has no vertex run and nothing to weld; it passes straight through.
        const text = entities.filter(e => !Array.isArray(e.vertices) || e.vertices.length < 2);
        let list = entities.filter(e => Array.isArray(e.vertices) && e.vertices.length >= 2);
        if (o.dedupe !== false) {
            const r = dedupeEntities(list, tol);
            list = r.entities;
            stats.duplicates = r.removed;
        }
        const collapse = (arr) => arr.map(e => ({
            ...e,
            vertices: mergeCollinear(e.vertices, e.shape || e.closed, tol),
        }));
        if (o.mergeCollinear !== false) list = collapse(list);
        if (o.weld !== false) {
            const r = weldChains(list, tol);
            list = r.entities;
            stats.welded = r.welded;
            if (o.mergeCollinear !== false) list = collapse(list);
        }

        list = [...list, ...text];
        stats.after = list.length;
        for (const e of list) stats.verticesAfter += e.vertices?.length || 0;
        return { entities: list, stats };
    }

    /**
     * Page space → drawing space: shift the MediaBox origin to 0,0, then undo the
     * page's own /Rotate so the result sits the way the page reads. Text and
     * geometry share this, or they would land in different places.
     */
    function pageBaseMatrix(view, rotate) {
        const v = view || [0, 0, 0, 0];
        let base = [1, 0, 0, 1, -v[0], -v[1]];
        const w = v[2] - v[0], h = v[3] - v[1];
        const rot = ((Number(rotate) || 0) % 360 + 360) % 360;
        if (rot === 90) base = matMul(base, [0, 1, -1, 0, h, 0]);
        else if (rot === 180) base = matMul(base, [-1, 0, 0, -1, w, h]);
        else if (rot === 270) base = matMul(base, [0, -1, 1, 0, 0, w]);
        return base;
    }

    // ===================== Text =====================
    // Text is only recoverable when the PDF still holds it as text. Exporters
    // often convert it to outlines instead, and then it arrives as geometry and
    // stays geometry — there is nothing to recover.

    /**
     * DXF measures text by its capital letters; PDF measures it by the em box, so
     * a 12 pt line is nowhere near 12 units tall in DXF terms. The font's ascent
     * is the closest thing to a cap height that PDF.js reports, and for the
     * common text faces the two are within a percent of each other.
     */
    const DEFAULT_CAP_RATIO = 0.7;

    function capRatioFor(style) {
        const a = Number(style?.ascent);
        // A missing or nonsensical ascent falls back rather than distorting text.
        return Number.isFinite(a) && a > 0.3 && a < 1.2 ? a : DEFAULT_CAP_RATIO;
    }

    /**
     * Convert page.getTextContent() into DXF TEXT entities.
     *
     *   textContent  { items, styles } straight from PDF.js
     *   options
     *     view, rotate   the same page placement the geometry uses
     *     layer          layer name for the text
     *     minHeight      drop anything smaller than this, in points
     *
     * Each item carries a transform whose translation is the baseline origin and
     * whose scale is the effective font size — which is what DXF TEXT wants for
     * its insertion point, so the two line up without further work. Rotation
     * comes out of the same matrix.
     *
     * Returns { entities, stats }.
     */
    function textToEntities(textContent, options) {
        const o = options || {};
        const base = pageBaseMatrix(o.view, o.rotate);
        const layer = o.layer || 'PDF-TEXT';
        const minHeight = Number.isFinite(o.minHeight) ? o.minHeight : 0.1;
        const styles = textContent?.styles || {};
        const entities = [];
        const stats = { items: 0, skipped: 0, tiny: 0 };

        for (const item of textContent?.items || []) {
            const str = typeof item?.str === 'string' ? item.str : '';
            // PDF.js emits empty items as line-break markers; they carry no glyphs.
            if (!str.trim()) { stats.skipped++; continue; }
            const m = item.transform;
            if (!m || m.length < 6) { stats.skipped++; continue; }

            const full = matMul([m[0], m[1], m[2], m[3], m[4], m[5]], base);
            // The vertical scale of the combined matrix is the em size on the page.
            const emSize = Math.hypot(full[2], full[3]);
            const height = emSize * capRatioFor(styles[item.fontName]);
            if (!(height >= minHeight)) { stats.tiny++; continue; }

            entities.push({
                type: 'TEXT',
                layer,
                startPoint: { x: full[4], y: full[5], z: 0 },
                textHeight: height,
                text: str,
                // Degrees: that is what the viewer and the created-entity
                // serializer both expect on a TEXT entity.
                rotation: Math.atan2(full[1], full[0]) * 180 / Math.PI,
            });
            stats.items++;
        }
        return { entities, stats };
    }

    /** Bounding box of everything extracted, for zoom-to-fit and calibration. */
    function entitiesBounds(entities) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const add = (x, y) => {
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        };
        for (const e of entities || []) {
            for (const v of e.vertices || []) add(v.x, v.y);
            // Text has an insertion point instead of a vertex run.
            const p = e.startPoint || e.position;
            if (p) add(p.x, p.y);
        }
        return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
    }

    const DxfPdfImport = {
        DEFAULT_OPS,
        DRAW,
        matMul,
        apply,
        matScale,
        parseColor,
        flattenCubic,
        buildSubpaths,
        fitArcBulge,
        circleThrough,
        emitCubic,
        dedupeEntities,
        mergeCollinear,
        weldChains,
        reverseCopy,
        optimizeEntities,
        pageBaseMatrix,
        textToEntities,
        capRatioFor,
        extractEntities,
        entitiesBounds,
    };

    root.DxfPdfImport = DxfPdfImport;
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfPdfImport;
})(typeof window !== 'undefined' ? window : globalThis);
