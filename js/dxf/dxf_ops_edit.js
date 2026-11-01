/**
 * dxf_ops_edit.js — selection transform operations: move, rotate, scale, mirror.
 *
 * Two parts, both DOM-free (classic script, window.DxfOpsEdit + Node exports):
 *
 * 1. Pure entity transforms — mutate an entity object in memory:
 *      translateEntity(e, dx, dy)
 *      rotateEntity(e, cx, cy, angleRad)
 *      scaleEntity(e, cx, cy, factor)
 *      mirrorEntityCopy(e, p1, p2)  → returns a NEW mirrored plain-object copy
 *
 * 2. Interaction state machine — mirrors DxfDrawTools:
 *      DxfOpsEdit.create({ onPreview(params), onCommit(op), onHint, onExit })
 *      .start('move'|'rotate'|'scale'|'mirror') / handleClick / handleMove /
 *      .handleNumeric(v) / cancel() / isActive() / activeTool() / acceptsNumeric()
 *
 *    Commit specs:
 *      { kind:'move',   dx, dy }
 *      { kind:'rotate', cx, cy, angle }        (radians)
 *      { kind:'scale',  cx, cy, factor }
 *      { kind:'mirror', p1, p2 }               (axis through two points)
 */
(function (root) {
    'use strict';

    // ===== Point helpers =====

    function rotatePoint(x, y, cx, cy, ang) {
        const cos = Math.cos(ang), sin = Math.sin(ang);
        const dx = x - cx, dy = y - cy;
        return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    }

    function scalePoint(x, y, cx, cy, f) {
        return { x: cx + (x - cx) * f, y: cy + (y - cy) * f };
    }

    // Reflect (x,y) across the line through p1→p2.
    function mirrorPoint(x, y, p1, p2) {
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-18) return { x, y };
        const t = ((x - p1.x) * dx + (y - p1.y) * dy) / len2;
        const px = p1.x + t * dx, py = p1.y + t * dy; // foot of perpendicular
        return { x: 2 * px - x, y: 2 * py - y };
    }

    function mirrorLineAngle(p1, p2) {
        return Math.atan2(p2.y - p1.y, p2.x - p1.x);
    }

    // Apply fn(x, y) → {x, y} to every 2D point-bearing field of an entity.
    const POINT_FIELDS = ['startPoint', 'position', 'endPoint', 'alignmentPoint', 'center',
        // DIMENSION definition points — moving a dim moves what it measures FROM.
        'anchorPoint', 'diameterOrRadiusPoint', 'linearOrAngularPoint1', 'linearOrAngularPoint2', 'middleOfText'];
    // Point arrays: polyline/leader/wipeout vertices, SPLINE control + fit points.
    const POINT_ARRAYS = ['vertices', 'controlPoints', 'fitPoints'];
    function forEachEntityPoint(e, fn) {
        for (const arr of POINT_ARRAYS) {
            if (!Array.isArray(e[arr])) continue;
            for (const v of e[arr]) {
                if (!v || !Number.isFinite(v.x)) continue;
                const p = fn(v.x, v.y);
                v.x = p.x; v.y = p.y;
            }
        }
        for (const f of POINT_FIELDS) {
            if (e[f] && Number.isFinite(e[f].x)) {
                const p = fn(e[f].x, e[f].y);
                e[f].x = p.x; e[f].y = p.y;
            }
        }
    }

    // ===== Entity transforms (mutate in place) =====

    function translateEntity(e, dx, dy) {
        forEachEntityPoint(e, (x, y) => ({ x: x + dx, y: y + dy }));
    }

    // Direction vectors (relative, not positions): rotate/scale/mirror about the origin.
    function mapVector(v, fn) {
        if (!v || !Number.isFinite(v.x)) return;
        const p = fn(v.x, v.y);
        v.x = p.x; v.y = p.y;
    }

    function rotateEntity(e, cx, cy, ang) {
        forEachEntityPoint(e, (x, y) => rotatePoint(x, y, cx, cy, ang));
        const t = String(e.type || '').toUpperCase();
        if (t === 'ELLIPSE') {
            mapVector(e.majorAxisEndPoint, (x, y) => rotatePoint(x, y, 0, 0, ang));
        } else if (t === 'DIMENSION') {
            // Rotated (linear) dimensions carry their direction in code 50 (degrees);
            // aligned/radial flavors derive it from the definition points.
            if ((Number(e.dimensionType) & 7) === 0) e.angle = (Number(e.angle) || 0) + ang * 180 / Math.PI;
        } else if (t === 'ARC') {
            // Parsed arc angles are radians; rotation shifts both.
            if (Number.isFinite(e.startAngle)) e.startAngle += ang;
            if (Number.isFinite(e.endAngle)) e.endAngle += ang;
        } else if (t === 'TEXT' || t === 'MTEXT' || t === 'ATTRIB' || t === 'ATTDEF') {
            // Parsed text rotation is degrees (matches DXF code 50).
            e.rotation = (Number(e.rotation) || 0) + ang * 180 / Math.PI;
        } else if (t === 'INSERT') {
            // A block reference rotates about its insertion point as a whole.
            e.rotation = (Number(e.rotation) || 0) + ang * 180 / Math.PI;
        }
    }

    function scaleEntity(e, cx, cy, f) {
        forEachEntityPoint(e, (x, y) => scalePoint(x, y, cx, cy, f));
        const t = String(e.type || '').toUpperCase();
        if (t === 'ELLIPSE') {
            mapVector(e.majorAxisEndPoint, (x, y) => ({ x: x * f, y: y * f }));
        } else if (t === 'CIRCLE' || t === 'ARC') {
            if (Number.isFinite(e.radius)) e.radius *= f;
        } else if (t === 'TEXT' || t === 'MTEXT' || t === 'ATTRIB' || t === 'ATTDEF') {
            if (Number.isFinite(e.textHeight)) e.textHeight *= f;
            if (Number.isFinite(e.height)) e.height *= f;
        } else if (t === 'INSERT') {
            // Scale the block reference's own scale factors.
            e.xScale = (Number(e.xScale ?? 1) || 1) * f;
            e.yScale = (Number(e.yScale ?? 1) || 1) * f;
        }
    }

    // Deep-ish clone of the plain data of an entity (drops __-prefixed internals).
    function cloneEntityData(e) {
        const out = {};
        for (const [k, v] of Object.entries(e)) {
            if (k.startsWith('__')) continue;
            if (v === null || v === undefined) { out[k] = v; continue; }
            if (Array.isArray(v)) {
                out[k] = v.map(item => (item && typeof item === 'object') ? { ...item } : item);
            } else if (typeof v === 'object') {
                out[k] = { ...v };
            } else {
                out[k] = v;
            }
        }
        return out;
    }

    // Return a NEW mirrored copy of the entity (original untouched).
    function mirrorEntityCopy(e, p1, p2) {
        const copy = cloneEntityData(e);
        forEachEntityPoint(copy, (x, y) => mirrorPoint(x, y, p1, p2));
        const t = String(copy.type || '').toUpperCase();
        const theta = mirrorLineAngle(p1, p2);
        if (t === 'ARC' && Number.isFinite(copy.startAngle) && Number.isFinite(copy.endAngle)) {
            // Reflection maps angle a → 2θ - a and reverses direction, so the CCW
            // arc from a1..a2 becomes the CCW arc from (2θ - a2)..(2θ - a1).
            const a1 = copy.startAngle, a2 = copy.endAngle;
            copy.startAngle = 2 * theta - a2;
            copy.endAngle = 2 * theta - a1;
        }
        if (t === 'LWPOLYLINE' && Array.isArray(copy.vertices)) {
            // Bulges flip sign under reflection.
            for (const v of copy.vertices) {
                if (Number.isFinite(v.bulge) && v.bulge) v.bulge = -v.bulge;
            }
        }
        if (t === 'ELLIPSE') {
            // Axis vector reflects about the origin; the parameterization runs the
            // other way round, so [s, e] becomes [-e, -s].
            mapVector(copy.majorAxisEndPoint, (x, y) => mirrorPoint(x, y, { x: 0, y: 0 }, { x: Math.cos(theta), y: Math.sin(theta) }));
            const s = Number(copy.startAngle) || 0, en = Number.isFinite(copy.endAngle) ? Number(copy.endAngle) : Math.PI * 2;
            const full = Math.abs((en - s) - Math.PI * 2) < 1e-9;
            if (!full) {
                const TAU = Math.PI * 2;
                copy.startAngle = ((-en) % TAU + TAU) % TAU;
                copy.endAngle = ((-s) % TAU + TAU) % TAU;
                if (copy.endAngle <= copy.startAngle) copy.endAngle += TAU;
            }
        }
        if (t === 'INSERT') {
            // Ref_theta · R(r) · S = R(2theta - r) · diag(sx, -sy): the block keeps its
            // x scale, flips its y scale and its rotation reflects about the axis.
            const thetaDeg = theta * 180 / Math.PI;
            copy.rotation = 2 * thetaDeg - (Number(copy.rotation) || 0);
            copy.yScale = -(Number(copy.yScale ?? 1) || 1);
        }
        if (t === 'DIMENSION' && (Number(copy.dimensionType) & 7) === 0) {
            const thetaDeg = theta * 180 / Math.PI;
            copy.angle = 2 * thetaDeg - (Number(copy.angle) || 0);
        }
        // Text: mirror the insertion point only, keep it readable (no rotation flip).
        return copy;
    }

    // ===== Array helpers =====

    // First point-bearing coordinate of an entity (reference for non-rotated copies).
    function firstEntityPoint(e) {
        if (Array.isArray(e.vertices) && e.vertices.length && Number.isFinite(e.vertices[0].x)) {
            return { x: e.vertices[0].x, y: e.vertices[0].y };
        }
        for (const f of POINT_FIELDS) {
            if (e[f] && Number.isFinite(e[f].x)) return { x: e[f].x, y: e[f].y };
        }
        return null;
    }

    // Grid offsets for a rectangular array, excluding the origin cell.
    // Columns advance along +X by dx; rows along +Y by dy (negative values allowed).
    function rectArrayOffsets(rows, cols, dx, dy) {
        const R = Math.max(1, Math.floor(Number(rows) || 1));
        const C = Math.max(1, Math.floor(Number(cols) || 1));
        const out = [];
        for (let r = 0; r < R; r++) {
            for (let c = 0; c < C; c++) {
                if (r === 0 && c === 0) continue;
                out.push({ dx: c * dx, dy: r * dy });
            }
        }
        return out;
    }

    // Angular offsets (radians) for a polar array, excluding the original (0).
    // `count` includes the original. A full 360 fill spaces count items evenly;
    // a partial fill puts the first and last item on the fill boundaries.
    function polarArraySteps(count, totalDeg) {
        const n = Math.max(2, Math.floor(Number(count) || 2));
        const total = Number.isFinite(Number(totalDeg)) ? Number(totalDeg) : 360;
        const full = Math.abs(Math.abs(total) - 360) < 1e-9;
        const step = (total * Math.PI / 180) / (full ? n : (n - 1));
        const out = [];
        for (let i = 1; i < n; i++) out.push(i * step);
        return out;
    }

    // One polar-array copy of `e`, rotated `ang` radians about (cx, cy).
    // rotateItems=false keeps each copy's orientation: the shared reference
    // point `ref` (e.g. the selection centroid) is swung around the center and
    // the copy is translated by that delta, so multi-entity selections stay rigid.
    function polarArrayEntityCopy(e, cx, cy, ang, rotateItems, ref) {
        const copy = cloneEntityData(e);
        if (rotateItems) {
            rotateEntity(copy, cx, cy, ang);
        } else {
            const r = ref || firstEntityPoint(copy);
            if (r) {
                const p = rotatePoint(r.x, r.y, cx, cy, ang);
                translateEntity(copy, p.x - r.x, p.y - r.y);
            }
        }
        return copy;
    }

    // ===== STRETCH =====

    function pointInBox(p, box) {
        return p && Number.isFinite(p.x)
            && p.x >= box.minX - 1e-9 && p.x <= box.maxX + 1e-9
            && p.y >= box.minY - 1e-9 && p.y <= box.maxY + 1e-9;
    }

    /**
     * STRETCH one entity: vertices inside `box` move by (dx, dy), the rest
     * stay. Whole-body entities (circle, arc, text, insert) move when their
     * defining point is inside. Mutates `e`. Returns:
     *   'none'    — untouched
     *   'partial' — some vertices moved (shape changed)
     *   'whole'   — the entity moved rigidly (a plain translation)
     */
    function stretchEntity(e, box, dx, dy) {
        const t = String(e.type || '').toUpperCase();
        if (t === 'LINE' || t === 'LWPOLYLINE' || t === 'POLYLINE') {
            const verts = Array.isArray(e.vertices) ? e.vertices : [];
            let moved = 0;
            for (const v of verts) {
                if (pointInBox(v, box)) { v.x += dx; v.y += dy; moved++; }
            }
            if (!moved) return 'none';
            return moved === verts.length ? 'whole' : 'partial';
        }
        if (t === 'CIRCLE' || t === 'ARC') {
            const c = e.center || e.centerPoint;
            if (!pointInBox(c, box)) return 'none';
            translateEntity(e, dx, dy);
            return 'whole';
        }
        if (t === 'TEXT' || t === 'MTEXT' || t === 'ATTRIB' || t === 'INSERT' || t === 'ACAD_TABLE' || t === 'POINT') {
            const anchor = e.position || e.startPoint || e.insertPoint;
            if (!pointInBox(anchor, box)) return 'none';
            translateEntity(e, dx, dy);
            return 'whole';
        }
        if (t === 'ELLIPSE') {
            if (!pointInBox(e.center, box)) return 'none';
            translateEntity(e, dx, dy);
            return 'whole';
        }
        if (t === 'SPLINE') {
            // Rigid only: a spline with some points inside would need re-fitting.
            const pts = [...(e.controlPoints || []), ...(e.fitPoints || [])];
            if (!pts.length || !pts.every(p => pointInBox(p, box))) return 'none';
            translateEntity(e, dx, dy);
            return 'whole';
        }
        return 'none';
    }

    function boxFromCorners(a, b) {
        return {
            minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
            minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
        };
    }

    // ===== Interaction state machine =====

    const HINTS = {
        move:   ['Click base point', 'Click destination — or type a distance toward the cursor'],
        copy:   ['Click base point', 'Click destination for the copy — or type a distance toward the cursor'],
        rotate: ['Click rotation center', 'Click to set angle — or type degrees'],
        scale:  ['Click base point', 'Click reference point (defines distance = 1×)', 'Click new distance — or type a scale factor'],
        mirror: ['Click first point of mirror axis', 'Click second axis point (copies are created; originals kept)'],
        arraypolar: ['Click the array center point'],
        stretch: ['Click first corner of the crossing box', 'Click opposite corner',
                  'Click base point', 'Click destination — or type a distance toward the cursor'],
    };

    function create(hooks) {
        const noop = () => {};
        const onPreview = hooks.onPreview || noop;
        const onCommit = hooks.onCommit || noop;
        const onHint = hooks.onHint || noop;
        const onExit = hooks.onExit || noop;

        let tool = null;
        let points = [];
        let hover = null;

        function hint() {
            if (!tool) { onHint(''); return; }
            const list = HINTS[tool] || [];
            onHint(list[Math.min(points.length, list.length - 1)] || '');
        }

        // Live preview parameters for the host to render the transformed selection.
        function previewParams() {
            if (!tool || !hover) return null;
            if (tool === 'arraypolar') {
                return { kind: 'arraypolar', cx: hover.x, cy: hover.y };
            }
            if (points.length === 0) return null;
            const base = points[0];
            if (tool === 'move' || tool === 'copy') {
                return { kind: tool, dx: hover.x - base.x, dy: hover.y - base.y };
            }
            if (tool === 'rotate') {
                const ang = Math.atan2(hover.y - base.y, hover.x - base.x);
                return { kind: 'rotate', cx: base.x, cy: base.y, angle: ang };
            }
            if (tool === 'scale') {
                if (points.length === 1) return null; // waiting for reference point
                const ref = points[1];
                const d1 = Math.hypot(ref.x - base.x, ref.y - base.y);
                const d2 = Math.hypot(hover.x - base.x, hover.y - base.y);
                if (d1 < 1e-12) return null;
                return { kind: 'scale', cx: base.x, cy: base.y, factor: d2 / d1 };
            }
            if (tool === 'mirror') {
                return { kind: 'mirror', p1: base, p2: hover };
            }
            if (tool === 'stretch' && points.length === 1) {
                return { kind: 'stretchbox', a: points[0], b: hover };
            }
            if (tool === 'stretch' && points.length === 2) {
                return { kind: 'stretchbox', a: points[0], b: points[1] };
            }
            if (tool === 'stretch' && points.length >= 3) {
                return {
                    kind: 'stretch',
                    a: points[0], b: points[1],
                    box: boxFromCorners(points[0], points[1]),
                    dx: hover.x - points[2].x,
                    dy: hover.y - points[2].y,
                };
            }
            return null;
        }

        function refreshPreview() { onPreview(previewParams()); }

        function reset() {
            points = [];
            onPreview(null);
            hint();
        }

        return {
            isActive() { return tool !== null; },
            activeTool() { return tool; },
            pendingPointCount() { return points.length; },
            lastPoint() { return points.length ? points[points.length - 1] : null; },

            // Whether typed numeric input would be consumed right now.
            acceptsNumeric() {
                if (!tool) return false;
                if (tool === 'stretch' && points.length === 3) return true;   // distance
                if ((tool === 'move' || tool === 'copy') && points.length === 1) return true; // distance
                if (tool === 'rotate' && points.length === 1) return true;  // degrees
                if (tool === 'scale' && points.length >= 1) return true;    // factor
                return false;
            },

            start(name) {
                tool = name || null;
                points = [];
                hover = null;
                onPreview(null);
                hint();
            },

            cancel() {
                if (points.length > 0) { reset(); return true; }
                if (tool) {
                    tool = null;
                    onPreview(null);
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

            handleClick(pt) {
                if (!tool) return;
                points.push(pt);
                if (tool === 'arraypolar' && points.length === 1) {
                    onCommit({ kind: 'arraypolar', cx: pt.x, cy: pt.y });
                    reset(); return;
                }
                const base = points[0];
                if ((tool === 'move' || tool === 'copy') && points.length === 2) {
                    onCommit({ kind: tool, dx: pt.x - base.x, dy: pt.y - base.y });
                    reset(); return;
                }
                if (tool === 'rotate' && points.length === 2) {
                    const ang = Math.atan2(pt.y - base.y, pt.x - base.x);
                    onCommit({ kind: 'rotate', cx: base.x, cy: base.y, angle: ang });
                    reset(); return;
                }
                if (tool === 'scale' && points.length === 3) {
                    const ref = points[1];
                    const d1 = Math.hypot(ref.x - base.x, ref.y - base.y);
                    const d2 = Math.hypot(pt.x - base.x, pt.y - base.y);
                    if (d1 > 1e-12 && d2 > 1e-12) {
                        onCommit({ kind: 'scale', cx: base.x, cy: base.y, factor: d2 / d1 });
                    }
                    reset(); return;
                }
                if (tool === 'mirror' && points.length === 2) {
                    if (Math.hypot(pt.x - base.x, pt.y - base.y) > 1e-12) {
                        onCommit({ kind: 'mirror', p1: base, p2: pt });
                    }
                    reset(); return;
                }
                if (tool === 'stretch' && points.length === 4) {
                    onCommit({
                        kind: 'stretch',
                        box: boxFromCorners(points[0], points[1]),
                        dx: pt.x - points[2].x,
                        dy: pt.y - points[2].y,
                    });
                    reset(); return;
                }
                hint();
                refreshPreview();
            },

            // Typed value: move = distance toward cursor; rotate = degrees; scale = factor.
            handleNumeric(value) {
                const v = Number(value);
                if (!tool || !Number.isFinite(v) || points.length === 0) return false;
                const base = points[0];
                if (tool === 'stretch' && points.length === 3 && v > 0) {
                    const b = points[2];
                    let dx = 1, dy = 0;
                    if (hover) {
                        const hx = hover.x - b.x, hy = hover.y - b.y;
                        const len = Math.hypot(hx, hy);
                        if (len > 1e-9) { dx = hx / len; dy = hy / len; }
                    }
                    onCommit({
                        kind: 'stretch',
                        box: boxFromCorners(points[0], points[1]),
                        dx: dx * v, dy: dy * v,
                    });
                    reset(); return true;
                }
                if ((tool === 'move' || tool === 'copy') && points.length === 1 && v > 0) {
                    let dx = 1, dy = 0;
                    if (hover) {
                        const hx = hover.x - base.x, hy = hover.y - base.y;
                        const len = Math.hypot(hx, hy);
                        if (len > 1e-9) { dx = hx / len; dy = hy / len; }
                    }
                    onCommit({ kind: tool, dx: dx * v, dy: dy * v });
                    reset(); return true;
                }
                if (tool === 'rotate' && points.length === 1) {
                    onCommit({ kind: 'rotate', cx: base.x, cy: base.y, angle: v * Math.PI / 180 });
                    reset(); return true;
                }
                if (tool === 'scale' && points.length >= 1 && v > 0) {
                    onCommit({ kind: 'scale', cx: base.x, cy: base.y, factor: v });
                    reset(); return true;
                }
                return false;
            },
        };
    }

    const DxfOpsEdit = {
        create,
        translateEntity, rotateEntity, scaleEntity, mirrorEntityCopy, cloneEntityData,
        rotatePoint, scalePoint, mirrorPoint,
        firstEntityPoint, rectArrayOffsets, polarArraySteps, polarArrayEntityCopy,
        stretchEntity, pointInBox, boxFromCorners,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = DxfOpsEdit;
    if (root) root.DxfOpsEdit = DxfOpsEdit;
})(typeof window !== 'undefined' ? window : null);
