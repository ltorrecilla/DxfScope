/**
 * dxf_tool_draw.js — drawing tool state machine.
 *
 * DOM-free: the host injects callbacks. Exposes window.DxfDrawTools.
 *
 * Usage:
 *   const tools = DxfDrawTools.create({
 *     onPreview(points, closed)  — update the rubber-band preview polyline
 *                                  (points = [{x,y}], empty array hides it)
 *     onCommit(spec)             — a shape is finished; spec is one of:
 *                                  {kind:'line',   p1, p2}
 *                                  {kind:'polyline', verts, closed}
 *                                  {kind:'polygon', verts}       (closed)
 *                                  {kind:'donut',  center, inside, outside} (diameters)
 *                                  {kind:'xline',  base, dir}    (dir = unit vector)
 *                                  {kind:'ray',    base, dir}
 *                                  {kind:'circle', center, radius}
 *                                  {kind:'arc',    p1, p2, p3}   (3-point)
 *                                  {kind:'text',   pos}          (host opens editor)
 *     onHint(text)               — status hint for the user ('' clears)
 *     onExit()                   — tool deactivated (back to Select)
 *     previewReach()             — optional: length to extend xline/ray
 *                                  previews by (host: view size); default 1e4
 *   });
 *   Donut preview: two circles in one point list, separated by a null.
 *
 *   tools.start('line') / handleClick({x,y}) / handleMove({x,y}) /
 *   handleEnter() / handleKey('I') / cancel() / isActive() / activeTool()
 */
(function (root) {
    'use strict';

    const CIRCLE_PREVIEW_SEGMENTS = 48;
    const POLYGON_MIN_SIDES = 3;
    const POLYGON_MAX_SIDES = 1024;
    const XLINE_KEYS = { H: 'H', HOR: 'H', HORIZONTAL: 'H', V: 'V', VER: 'V', VERTICAL: 'V', A: 'A', ANG: 'A', ANGLE: 'A' };

    // Smooth preview through the given points (centripetal Catmull–Rom — a
    // close visual stand-in for the interpolated B-spline the commit creates).
    function splinePreviewPoints(pts) {
        if (!pts || pts.length < 2) return pts || [];
        if (pts.length === 2) return [pts[0], pts[1]];
        const out = [];
        const P = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
        const SAMPLES = 12;
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
            for (let j = 0; j < SAMPLES; j++) {
                const t = j / SAMPLES, t2 = t * t, t3 = t2 * t;
                out.push({
                    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
                    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
                });
            }
        }
        out.push(pts[pts.length - 1]);
        return out;
    }

    // Sampled outline of the ellipse defined by center, ABSOLUTE major-axis end
    // point and minor/major ratio. Shared by the live preview and the host.
    function ellipsePreviewPoints(c, majorEnd, ratio) {
        const mx = majorEnd.x - c.x, my = majorEnd.y - c.y;
        const majorLen = Math.hypot(mx, my);
        if (!(majorLen > 1e-9)) return [];
        const r = Math.max(1e-4, Math.min(1, Math.abs(ratio) || 1));
        const ux = mx / majorLen, uy = my / majorLen;
        const vx = -uy, vy = ux;
        const minorLen = majorLen * r;
        const pts = [];
        const N = 64;
        for (let i = 0; i <= N; i++) {
            const t = (i / N) * Math.PI * 2;
            pts.push({
                x: c.x + ux * Math.cos(t) * majorLen + vx * Math.sin(t) * minorLen,
                y: c.y + uy * Math.cos(t) * majorLen + vy * Math.sin(t) * minorLen,
            });
        }
        return pts;
    }

    // Ratio implied by a third pick: its perpendicular distance from the major
    // axis over the major half-length, clamped to a valid DXF ratio (0, 1].
    function ellipseRatioFromPick(c, majorEnd, pick) {
        const mx = majorEnd.x - c.x, my = majorEnd.y - c.y;
        const majorLen = Math.hypot(mx, my);
        if (!(majorLen > 1e-9)) return 1;
        const perp = Math.abs((pick.x - c.x) * (-my / majorLen) + (pick.y - c.y) * (mx / majorLen));
        return Math.max(1e-4, Math.min(1, perp / majorLen));
    }

    function circlePreviewPoints(c, r) {
        const pts = [];
        for (let i = 0; i <= CIRCLE_PREVIEW_SEGMENTS; i++) {
            const a = (i / CIRCLE_PREVIEW_SEGMENTS) * Math.PI * 2;
            pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
        }
        return pts;
    }

    // ===== Polygon geometry =====

    /** Valid side count, or null. */
    function polygonSides(n) {
        const v = Math.round(Number(n));
        return Number.isFinite(v) && v >= POLYGON_MIN_SIDES && v <= POLYGON_MAX_SIDES ? v : null;
    }

    /**
     * Regular polygon around `center`, sized and oriented by `cursor`.
     *   mode 'I' (inscribed)     — a CORNER sits on the cursor (circumradius = distance)
     *   mode 'C' (circumscribed) — an EDGE MIDPOINT sits on the cursor (apothem = distance)
     * Vertices run counter-clockwise. Returns [] for a zero radius or bad side count.
     */
    function polygonVertices(center, cursor, sides, mode) {
        const n = polygonSides(sides);
        if (!n || !center || !cursor) return [];
        const dx = cursor.x - center.x, dy = cursor.y - center.y;
        const d = Math.hypot(dx, dy);
        if (!(d > 1e-9)) return [];
        const a0 = Math.atan2(dy, dx);
        const step = (Math.PI * 2) / n;
        const circ = mode === 'C';
        const R = circ ? d / Math.cos(Math.PI / n) : d;
        const start = circ ? a0 + step / 2 : a0;
        const out = [];
        for (let k = 0; k < n; k++) {
            const a = start + k * step;
            out.push({ x: center.x + Math.cos(a) * R, y: center.y + Math.sin(a) * R });
        }
        return out;
    }

    /**
     * Regular polygon whose first edge runs p1 → p2. The polygon is built on the
     * LEFT of that edge, so the vertices run counter-clockwise from p1.
     */
    function polygonFromEdge(p1, p2, sides) {
        const n = polygonSides(sides);
        if (!n || !p1 || !p2) return [];
        const ex = p2.x - p1.x, ey = p2.y - p1.y;
        const s = Math.hypot(ex, ey);
        if (!(s > 1e-9)) return [];
        const apothem = s / (2 * Math.tan(Math.PI / n));
        const cx = (p1.x + p2.x) / 2 - (ey / s) * apothem;
        const cy = (p1.y + p2.y) / 2 + (ex / s) * apothem;
        const step = (Math.PI * 2) / n;
        const out = [{ x: p1.x, y: p1.y }];
        const rx = p1.x - cx, ry = p1.y - cy;
        for (let k = 1; k < n; k++) {
            const c = Math.cos(k * step), sn = Math.sin(k * step);
            out.push({ x: cx + rx * c - ry * sn, y: cy + rx * sn + ry * c });
        }
        return out;
    }

    // Approximate a 3-point arc for preview using DxfEmit.arcFrom3Points if present.
    function arcPreviewPoints(p1, p2, p3) {
        const solver = root && root.DxfEmit && root.DxfEmit.arcFrom3Points;
        const arc = solver ? solver(p1, p2, p3) : null;
        if (!arc) return [p1, p3];
        const a1 = arc.startDeg * Math.PI / 180;
        let a2 = arc.endDeg * Math.PI / 180;
        while (a2 < a1) a2 += Math.PI * 2;
        const steps = 40;
        const pts = [];
        for (let i = 0; i <= steps; i++) {
            const a = a1 + (a2 - a1) * (i / steps);
            pts.push({ x: arc.center.x + Math.cos(a) * arc.radius, y: arc.center.y + Math.sin(a) * arc.radius });
        }
        return pts;
    }

    function create(hooks) {
        const noop = () => {};
        const onPreview = hooks.onPreview || noop;
        const onCommit = hooks.onCommit || noop;
        const onHint = hooks.onHint || noop;
        const onExit = hooks.onExit || noop;
        const previewReach = typeof hooks.previewReach === 'function' ? hooks.previewReach : () => 1e4;

        let tool = null;        // 'line' | 'polyline' | 'circle' | 'arc' | 'text' | null
        let points = [];        // collected click points for the current shape
        let hover = null;       // current cursor position
        let dimChainOffset = null; // continued-dimension mode: fixed dim-line point
        // Polygon settings persist between uses, as in AutoCAD.
        let polySides = 4;
        let polyMode = 'I';     // 'I' inscribed | 'C' circumscribed | 'E' edge
        // DONUT: diameters persist; typed numbers set inside, then outside.
        let donutInside = 0.5, donutOutside = 1;
        let donutNext = 'inside';
        // XLINE: '' (two points) | 'H' | 'V' | 'A' (fixed angle, degrees).
        let xlMode = '', xlAngle = 0;

        const HINTS = {
            line:     ['Click start point', 'Click end point — or type a length  •  Esc to stop'],
            polyline: ['Click first vertex', 'Click next vertex — or type a length  •  Enter to finish  •  C to close  •  Esc to cancel'],
            rect:     ['Click first corner', 'Click opposite corner'],
            viewport: ['Click first corner of the frame', 'Click opposite corner'],
            circle:   ['Click center', 'Click to set radius — or type it'],
            ellipse:  ['Click center', 'Click the end of the major axis', 'Click to set the minor axis'],
            spline:   ['Click the first fit point', 'Click the next fit point — Enter to finish (3+ points)  •  Esc to cancel'],
            leader:   ['Click the arrow point (what the note points at)', 'Click the landing — more clicks add bends  •  Enter to finish and type the note'],
            wipeout:  ['Click the first corner of the masking area', 'Click the next corner — Enter to finish (3+ points)  •  Esc to cancel'],
            arc:      ['Click arc start', 'Click arc end', 'Click a point on the arc'],
            text:     ['Click text insertion point'],
            dim:      ['Click first point to measure', 'Click second point', 'Click to place the dimension line'],
            'dim-aligned': ['Click first point to measure', 'Click second point', 'Click to place the dimension line'],
            dimChain: ['Click the next point to continue the chain — Enter for a new dimension, Esc to exit'],
            'dim-radial':   ['Click a circle or arc', 'Click to place the dimension'],
            'dim-diameter': ['Click a circle or arc', 'Click to place the dimension'],
            'dim-ordinate': ['Click the feature point to measure', 'Click the leader end — drag up/down measures X, left/right measures Y'],
        };

        const POLY_MODE_LABEL = { I: 'inscribed', C: 'circumscribed', E: 'edge' };

        function polygonHint() {
            const head = `Polygon · ${polySides} sides · ${POLY_MODE_LABEL[polyMode]}`;
            let step;
            if (polyMode === 'E') {
                step = points.length === 0 ? 'Click the first edge point' : 'Click the second edge point';
            } else {
                step = points.length === 0 ? 'Click the center' : 'Click a point — or type the radius';
            }
            const keys = points.length === 0 ? 'type sides, I/C/E' : 'I/C/E';
            return `${head}  •  ${step}  •  ${keys}  •  Esc to stop`;
        }

        const fmt = (v) => String(Math.round(v * 1e6) / 1e6);

        function donutHint() {
            return `Donut · inside ${fmt(donutInside)} · outside ${fmt(donutOutside)}  •  Click the center  •  type the ${donutNext} diameter  •  Esc to stop`;
        }

        function xlineHint() {
            if (tool === 'ray') {
                return points.length === 0 ? 'Ray · Click the start point  •  Esc to stop'
                    : 'Ray · Click a point it passes through (more clicks add rays)  •  Esc to stop';
            }
            const keys = 'H/V/A';
            if (xlMode === 'H' || xlMode === 'V') {
                return `Xline · ${xlMode === 'H' ? 'horizontal' : 'vertical'}  •  Click a point it passes through  •  ${keys}  •  Esc to stop`;
            }
            if (xlMode === 'A') {
                return `Xline · angle ${fmt(xlAngle)}°  •  type an angle or click a point it passes through  •  ${keys}  •  Esc to stop`;
            }
            return points.length === 0
                ? `Xline · Click a point  •  ${keys}  •  Esc to stop`
                : `Xline · Click a point it passes through (more clicks add lines)  •  ${keys}  •  Esc to stop`;
        }

        function xlineFixedDir() {
            if (xlMode === 'H') return { x: 1, y: 0 };
            if (xlMode === 'V') return { x: 0, y: 1 };
            if (xlMode === 'A') { const a = xlAngle * Math.PI / 180; return { x: Math.cos(a), y: Math.sin(a) }; }
            return null;
        }

        function unitDir(a, b) {
            const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
            return L > 1e-9 ? { x: dx / L, y: dy / L } : null;
        }

        function infinitePreview(base, dir, ray) {
            const R = Math.max(Number(previewReach()) || 0, 1);
            const a = ray ? base : { x: base.x - dir.x * R, y: base.y - dir.y * R };
            return [a, { x: base.x + dir.x * R, y: base.y + dir.y * R }];
        }

        function donutPreview(c) {
            const ro = donutOutside / 2, ri = donutInside / 2;
            const out = circlePreviewPoints(c, ro);
            if (ri > 1e-12) { out.push(null); out.push(...circlePreviewPoints(c, ri)); }
            return out;
        }

        function rectPoints(a, b) {
            return [
                { x: a.x, y: a.y }, { x: b.x, y: a.y },
                { x: b.x, y: b.y }, { x: a.x, y: b.y },
                { x: a.x, y: a.y },
            ];
        }

        function hint() {
            if (!tool) { onHint(''); return; }
            if (tool === 'polygon') { onHint(polygonHint()); return; }
            if (tool === 'donut') { onHint(donutHint()); return; }
            if (tool === 'xline' || tool === 'ray') { onHint(xlineHint()); return; }
            if ((tool === 'dim' || tool === 'dim-aligned') && dimChainOffset) { onHint(HINTS.dimChain[0]); return; }
            const list = HINTS[tool] || [];
            onHint(list[Math.min(points.length, list.length - 1)] || '');
        }

        // Current polygon outline for the pending points + a cursor/point.
        function polygonFor(pt) {
            if (points.length !== 1 || !pt) return [];
            return polyMode === 'E'
                ? polygonFromEdge(points[0], pt, polySides)
                : polygonVertices(points[0], pt, polySides, polyMode);
        }

        function refreshPreview() {
            if (tool === 'donut') { onPreview(hover ? donutPreview(hover) : [], false); return; }
            if (tool === 'xline') {
                const fixed = xlineFixedDir();
                const base = fixed ? hover : points[0];
                const dir = fixed || (points.length && hover ? unitDir(points[0], hover) : null);
                onPreview(base && dir ? infinitePreview(base, dir, false) : [], false);
                return;
            }
            if (tool === 'ray') {
                const dir = points.length && hover ? unitDir(points[0], hover) : null;
                onPreview(dir ? infinitePreview(points[0], dir, true) : [], false);
                return;
            }
            if (!tool || points.length === 0) { onPreview([], false); return; }
            const pts = hover ? [...points, hover] : [...points];
            if (tool === 'polygon') {
                const verts = polygonFor(hover);
                onPreview(verts.length ? [...verts, verts[0]] : [], false);
                return;
            }
            if (tool === 'circle' && points.length === 1 && hover) {
                const r = Math.hypot(hover.x - points[0].x, hover.y - points[0].y);
                onPreview(circlePreviewPoints(points[0], r), false);
                return;
            }
            if (tool === 'spline' && points.length >= 1) {
                onPreview(splinePreviewPoints(pts), false);
                return;
            }
            if (tool === 'ellipse' && points.length === 2 && hover) {
                const ratio = ellipseRatioFromPick(points[0], points[1], hover);
                onPreview(ellipsePreviewPoints(points[0], points[1], ratio), false);
                return;
            }
            if ((tool === 'rect' || tool === 'viewport') && points.length === 1 && hover) {
                onPreview(rectPoints(points[0], hover), false);
                return;
            }
            if (tool === 'arc') {
                if (points.length === 2 && hover) { onPreview(arcPreviewPoints(points[0], hover, points[1]), false); return; }
                onPreview(pts, false);
                return;
            }
            if (tool === 'dim' || tool === 'dim-aligned') {
                // The host renders the full dimension graphic once 2 points are set;
                // before that, show the simple rubber band.
                if (dimChainOffset && points.length === 1 && hover) {
                    onPreview([points[0], hover, dimChainOffset], false);
                    return;
                }
                onPreview(pts, false);
                return;
            }
            onPreview(pts, false);
        }

        function resetShape() {
            points = [];
            dimChainOffset = null;
            onPreview([], false);
            hint();
        }

        // Commit the polygon defined by the pending point and `pt`, then stay in
        // the tool for the next one.
        function commitPolygon(pt) {
            const verts = polygonFor(pt);
            if (verts.length >= POLYGON_MIN_SIDES) onCommit({ kind: 'polygon', verts });
            resetShape();
        }

        // Remove consecutive (near-)duplicate points — a double-click to finish
        // registers two clicks at the same spot before Enter fires.
        function dedupe(pts) {
            const out = [];
            for (const p of pts) {
                const last = out[out.length - 1];
                if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) out.push(p);
            }
            return out;
        }

        return {
            isActive() { return tool !== null; },
            activeTool() { return tool; },
            pendingPointCount() { return points.length; },
            lastPoint() { return points.length ? points[points.length - 1] : null; },
            dimChainActive() { return dimChainOffset !== null; },
            polygonState() { return { sides: polySides, mode: polyMode }; },
            donutState() { return { inside: donutInside, outside: donutOutside, next: donutNext }; },
            xlineState() { return { mode: xlMode, angle: xlAngle }; },

            start(name) {
                tool = name || null;
                if (tool === 'xline') xlMode = '';
                points = [];
                hover = null;
                onPreview([], false);
                hint();
            },

            // Cancel current in-progress shape; if none, exit the tool entirely.
            cancel() {
                if (points.length > 0) {
                    resetShape();
                    return true; // stayed in tool
                }
                if (tool) {
                    tool = null;
                    onPreview([], false);
                    onHint('');
                    onExit();
                }
                return false;
            },

            handleMove(pt) {
                if (!tool) return;
                hover = pt;
                refreshPreview();
            },

            /**
             * Tool keywords typed while a tool runs (AutoCAD-style options).
             * Returns true when the key/word was consumed, so the host does not
             * treat it as a command alias or a shortcut.
             *   polygon: I (inscribed), C (circumscribed), E (edge)
             */
            handleKey(key) {
                if (tool === 'xline') {
                    const w = XLINE_KEYS[String(key || '').trim().toUpperCase()];
                    if (!w) return false;
                    xlMode = w;
                    points = [];
                    hint();
                    refreshPreview();
                    return true;
                }
                if (tool === 'donut') {
                    const w = { I: 'inside', INSIDE: 'inside', O: 'outside', OUTSIDE: 'outside' }[String(key || '').trim().toUpperCase()];
                    if (!w) return false;
                    donutNext = w;
                    hint();
                    return true;
                }
                if (tool !== 'polygon') return false;
                const k = String(key || '').trim().toUpperCase();
                const word = { I: 'I', INSCRIBED: 'I', C: 'C', CIRCUMSCRIBED: 'C', E: 'E', EDGE: 'E' }[k];
                if (!word) return false;
                // Edge mode reads its first click differently (edge start, not
                // center), so a half-placed shape is dropped when switching in or out.
                if ((word === 'E') !== (polyMode === 'E') && points.length) points = [];
                polyMode = word;
                hint();
                refreshPreview();
                return true;
            },

            // Enter / double-click: finish an open polyline.
            handleEnter() {
                if (tool === 'dim' || tool === 'dim-aligned') { resetShape(); return; }
                // LINE: Enter ends the chain (AutoCAD), the tool waits for a new first point.
                if (tool === 'line') { resetShape(); return; }
                if (tool === 'polyline') {
                    const verts = dedupe(points);
                    if (verts.length >= 2) {
                        onCommit({ kind: 'polyline', verts, closed: false });
                    }
                    resetShape();
                }
                if (tool === 'spline') {
                    const verts = dedupe(points);
                    if (verts.length >= 3) {
                        onCommit({ kind: 'spline', points: verts });
                    }
                    resetShape();
                }
                if (tool === 'leader') {
                    const verts = dedupe(points);
                    if (verts.length >= 2) {
                        onCommit({ kind: 'leader', points: verts });
                    }
                    resetShape();
                }
                if (tool === 'wipeout') {
                    const verts = dedupe(points);
                    if (verts.length >= 3) {
                        onCommit({ kind: 'wipeout', verts });
                    }
                    resetShape();
                }
            },

            // 'c' key: close and finish the polyline.
            handleClose() {
                if (tool === 'polyline') {
                    const verts = dedupe(points);
                    if (verts.length >= 3) {
                        onCommit({ kind: 'polyline', verts, closed: true });
                        resetShape();
                    }
                }
            },

            // Whether a typed number would be consumed right now.
            acceptsNumeric() {
                if (!tool) return false;
                const n = points.length;
                if (tool === 'circle') return n === 1;
                if (tool === 'line' || tool === 'polyline') return n >= 1;
                if (tool === 'polygon') return n === 0 || (n === 1 && polyMode !== 'E');
                if (tool === 'donut') return true;
                if (tool === 'xline') return xlMode === 'A';
                return false;
            },

            // Numeric entry: the user typed a distance instead of clicking.
            // line/polyline → next point at `value` along the cursor direction from the
            // last point; circle → radius; polygon → side count (before the first
            // click) or radius (after the center). Returns true if the value was consumed.
            handleNumeric(value) {
                const v = Number(value);
                if (tool === 'xline' && xlMode === 'A' && Number.isFinite(v)) {
                    xlAngle = ((v % 360) + 360) % 360;
                    hint();
                    refreshPreview();
                    return true;
                }
                if (tool === 'donut' && Number.isFinite(v)) {
                    // Inside may be 0 (a filled dot); outside must be larger.
                    if (donutNext === 'inside') {
                        if (v < 0) return true;
                        donutInside = v;
                        if (donutOutside <= v) donutOutside = v > 0 ? v * 2 : 1;
                        donutNext = 'outside';
                    } else {
                        if (!(v > donutInside)) {
                            onHint(`Outside diameter must be larger than ${fmt(donutInside)}  •  ${donutHint()}`);
                            return true;
                        }
                        donutOutside = v;
                        donutNext = 'inside';
                    }
                    hint();
                    refreshPreview();
                    return true;
                }
                if (!tool || !Number.isFinite(v) || v <= 0) return false;
                if (tool === 'polygon') {
                    if (points.length === 0) {
                        const n = polygonSides(v);
                        if (!n || n !== v) {
                            onHint(`Sides must be a whole number from ${POLYGON_MIN_SIDES} to ${POLYGON_MAX_SIDES}  •  ${polygonHint()}`);
                            return true;
                        }
                        polySides = n;
                        hint();
                        return true;
                    }
                    if (points.length === 1 && polyMode !== 'E') {
                        // Radius toward the cursor (default +X), like a click at that distance.
                        const c = points[0];
                        let dx = 1, dy = 0;
                        if (hover) {
                            const hx = hover.x - c.x, hy = hover.y - c.y;
                            const len = Math.hypot(hx, hy);
                            if (len > 1e-9) { dx = hx / len; dy = hy / len; }
                        }
                        commitPolygon({ x: c.x + dx * v, y: c.y + dy * v });
                        return true;
                    }
                    return false;
                }
                if (points.length === 0) return false;
                const last = points[points.length - 1];
                if (tool === 'circle' && points.length === 1) {
                    onCommit({ kind: 'circle', center: points[0], radius: v });
                    resetShape();
                    return true;
                }
                if (tool === 'line' || tool === 'polyline') {
                    // Direction from the anchor toward the cursor (default +X).
                    let dx = 1, dy = 0;
                    if (hover) {
                        const hx = hover.x - last.x, hy = hover.y - last.y;
                        const len = Math.hypot(hx, hy);
                        if (len > 1e-9) { dx = hx / len; dy = hy / len; }
                    }
                    this.handleClick({ x: last.x + dx * v, y: last.y + dy * v });
                    return true;
                }
                return false;
            },

            handleClick(pt) {
                if (!tool) return;
                switch (tool) {
                    case 'line': {
                        points.push(pt);
                        if (points.length === 2) {
                            onCommit({ kind: 'line', p1: points[0], p2: points[1] });
                            // Chain: next line starts where this one ended.
                            points = [points[1]];
                        }
                        break;
                    }
                    case 'polyline':
                    case 'spline':
                    case 'leader':
                    case 'wipeout': {
                        points.push(pt);
                        break;
                    }
                    case 'polygon': {
                        if (points.length === 0) { points.push(pt); break; }
                        commitPolygon(pt);
                        return;
                    }
                    case 'donut': {
                        onCommit({ kind: 'donut', center: { x: pt.x, y: pt.y }, inside: donutInside, outside: donutOutside });
                        return;
                    }
                    case 'xline':
                    case 'ray': {
                        const fixed = tool === 'xline' ? xlineFixedDir() : null;
                        if (fixed) { onCommit({ kind: 'xline', base: { x: pt.x, y: pt.y }, dir: fixed }); return; }
                        if (points.length === 0) { points.push(pt); break; }
                        const dir = unitDir(points[0], pt);
                        // Base stays: each further click adds another line through it.
                        if (dir) onCommit({ kind: tool, base: { x: points[0].x, y: points[0].y }, dir });
                        hint();
                        return;
                    }
                    case 'rect':
                    case 'viewport': {
                        points.push(pt);
                        if (points.length === 2) {
                            const [a, b] = points;
                            if (Math.abs(a.x - b.x) > 1e-9 && Math.abs(a.y - b.y) > 1e-9) {
                                onCommit({ kind: tool, p1: a, p2: b });
                            }
                            resetShape();
                            return;
                        }
                        break;
                    }
                    case 'circle': {
                        points.push(pt);
                        if (points.length === 2) {
                            const r = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
                            if (r > 1e-9) onCommit({ kind: 'circle', center: points[0], radius: r });
                            resetShape();
                            return;
                        }
                        break;
                    }
                    case 'ellipse': {
                        points.push(pt);
                        if (points.length === 3) {
                            const [c, majorEnd, pick] = points;
                            const majorLen = Math.hypot(majorEnd.x - c.x, majorEnd.y - c.y);
                            if (majorLen > 1e-9) {
                                onCommit({ kind: 'ellipse', center: c, majorEnd,
                                    ratio: ellipseRatioFromPick(c, majorEnd, pick) });
                            }
                            resetShape();
                            return;
                        }
                        break;
                    }
                    case 'dim-radial':
                    case 'dim-diameter': {
                        points.push(pt);
                        if (points.length === 2) {
                            onCommit({ kind: 'dimradial', tool, p1: points[0], p2: points[1] });
                            resetShape();
                            return;
                        }
                        break;
                    }
                    case 'dim-ordinate': {
                        points.push(pt);
                        if (points.length === 2) {
                            onCommit({ kind: 'dimordinate', p1: points[0], p2: points[1] });
                            resetShape();
                            return;
                        }
                        break;
                    }
                    case 'dim':
                    case 'dim-aligned': {
                        // Continued dimensions: after the first placement, each click
                        // measures from the previous point on the same dimension line.
                        if (dimChainOffset) {
                            const prev = points[0];
                            onCommit({ kind: 'dim', tool, p1: prev, p2: pt, p3: dimChainOffset, chained: true });
                            points = [pt];
                            hint();
                            break;
                        }
                        points.push(pt);
                        if (points.length === 3) {
                            const [p1, p2, p3] = points;
                            onCommit({ kind: 'dim', tool, p1, p2, p3, chained: false });
                            dimChainOffset = p3;
                            points = [p2];
                            hint();
                            return;
                        }
                        break;
                    }
                    case 'arc': {
                        points.push(pt);
                        if (points.length === 3) {
                            // Clicks are start / end / on-arc; the solver wants the
                            // through-point in the middle.
                            onCommit({ kind: 'arc', p1: points[0], p2: points[2], p3: points[1] });
                            resetShape();
                            return;
                        }
                        break;
                    }
                    case 'text': {
                        onCommit({ kind: 'text', pos: pt });
                        resetShape();
                        return;
                    }
                }
                hint();
                refreshPreview();
            },
        };
    }

    const DxfDrawTools = { create, polygonVertices, polygonFromEdge, polygonSides };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfDrawTools;
    if (root) root.DxfDrawTools = DxfDrawTools;
})(typeof window !== 'undefined' ? window : null);
