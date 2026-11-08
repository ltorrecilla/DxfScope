
        import * as THREE from 'three';
        import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

        // ==================================================================
        //  Diff palette
        // ==================================================================
        const COLORS = {
            added: 0x22c55e,
            deleted: 0xef4444,
            modified: 0xf97316,
            unchanged: 0x6b7280,
        };
        const UNCHANGED_OPACITY = 0.35;

        // ---- persisted settings (editor-style) ----
        const SETTINGS_KEY = 'liteaeco_dxf_compare_settings';
        const settings = Object.assign({
            darkMode: true,
            measurePrecision: 2,
            unitLabel: '',
            showText: true,
            textHalo: false,
            showFills: true,
            showPortals: true,
            snapEnabled: true,
            snapCenter: true,
            snapQuadrant: true,
            snapTangent: true,
            snapNode: true,
            snapInsertion: true,
            snapEndpoint: true,
            snapMidpoint: true,
            snapEdge: true,
            snapIntersection: true,
            snapPerpendicular: true,
        }, (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })());
        function saveSettings() {
            try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
        }
        function isEffectiveDarkMode() {
            // Paper space is always light, like the editor.
            return settings.darkMode && currentSpace === 'model';
        }

        // Drawing lookup belongs to each context; adapters supply the shared layout rules.
        const ctxA = window.DxfCompareContext.create('A');
        const ctxB = window.DxfCompareContext.create('B');
        function getSpaceEntities(ctx, key) {
            return window.DxfCompareContext.getSpaceEntities(ctx, key, window.DxfLayout);
        }

        // ==================================================================
        //  Geometry helpers (lifted from DXF_Viewer, ctx-parameterized)
        // ==================================================================
        function makeMatrix(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) { return { a, b, c, d, e, f }; }
        function multiplyMatrix(m1, m2) {
            return makeMatrix(
                m1.a * m2.a + m1.c * m2.b, m1.b * m2.a + m1.d * m2.b,
                m1.a * m2.c + m1.c * m2.d, m1.b * m2.c + m1.d * m2.d,
                m1.a * m2.e + m1.c * m2.f + m1.e, m1.b * m2.e + m1.d * m2.f + m1.f,
            );
        }
        function translationMatrix(x = 0, y = 0) { return makeMatrix(1, 0, 0, 1, x, y); }
        function scaleMatrix(x = 1, y = 1) { return makeMatrix(x, 0, 0, y, 0, 0); }
        function rotationMatrix(deg = 0) {
            const rad = Number(deg || 0) * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            return makeMatrix(cos, sin, -sin, cos, 0, 0);
        }
        function getPointCandidate(...points) {
            for (const pt of points) {
                if (!pt) continue;
                const x = Number(pt.x), y = Number(pt.y);
                if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, z: Number(pt.z || 0) };
            }
            return null;
        }
        function transformPoint2D(pt, matrix = makeMatrix()) {
            const s = getPointCandidate(pt);
            if (!s) return null;
            return { x: matrix.a * s.x + matrix.c * s.y + matrix.e, y: matrix.b * s.x + matrix.d * s.y + matrix.f, z: s.z || 0 };
        }
        function transformVector2D(vec, matrix = makeMatrix()) {
            const s = getPointCandidate(vec);
            if (!s) return null;
            return { x: matrix.a * s.x + matrix.c * s.y, y: matrix.b * s.x + matrix.d * s.y, z: s.z || 0 };
        }
        function getMatrixRotation(m = makeMatrix()) { return Math.atan2(m.b, m.a) * 180 / Math.PI; }
        function getMatrixScale(m = makeMatrix()) {
            const sx = Math.hypot(m.a, m.b) || 1, sy = Math.hypot(m.c, m.d) || 1;
            return (sx + sy) / 2;
        }
        function getEntityRotationDegrees(entity) {
            return window.DxfText.rotationDegrees(entity);
        }
        function degToRad(deg) { return Number(deg || 0) * Math.PI / 180; }
        function angleToRadians(value, fallback = 0) {
            const n = Number(value);
            if (!Number.isFinite(n)) return fallback;
            return Math.abs(n) > Math.PI * 2 + 0.0001 ? n * Math.PI / 180 : n;
        }
        function normalizeArcEnd(start, end) { while (end < start) end += Math.PI * 2; return end; }

        function getTextInsertionPoint(entity) {
            return getPointCandidate(
                entity?.startPoint, entity?.position, entity?.insertPoint, entity?.insertionPoint,
                entity?.location, entity?.alignmentPoint, entity?.endPoint, entity?.vertices?.[0],
                entity?.x !== undefined && entity?.y !== undefined ? { x: entity.x, y: entity.y, z: entity.z || 0 } : null,
            );
        }
        function cleanDxfText(rawText) {
            let text = String(rawText ?? '');
            if (!text) return '';
            return text
                .replace(/%%d/gi, '°').replace(/%%p/gi, '±').replace(/%%c/gi, 'Ø')
                .replace(/\\P/gi, '\n').replace(/\\~/g, ' ')
                .replace(/\\[LOKlo]/g, '')
                .replace(/\\A\d+;/gi, '').replace(/\\C\d+;/gi, '')
                .replace(/\\H[^;]+;/gi, '').replace(/\\W[^;]+;/gi, '')
                .replace(/\\Q[^;]+;/gi, '').replace(/\\f[^;]+;/gi, '').replace(/\\F[^;]+;/gi, '')
                .replace(/\\S([^;^\\]+)[\^#/]([^;]+);/g, '$1/$2')
                .replace(/[{}]/g, '').trim();
        }
        function getEntityText(entity) {
            const v = entity?.text ?? entity?.string ?? entity?.value ?? entity?.content ?? entity?.contents ?? entity?.rawText ?? entity?.plainText ?? '';
            return cleanDxfText(v);
        }

        function getBlockByName(ctx, name) {
            return window.DxfCompareContext.getBlockByName(ctx, name);
        }

        // ---- curve tessellation (fixed quality no interactive smoothness UI) ----
        const TESS = { maxAngleRad: Math.PI / 72, minSegments: 32, maxSegments: 512, radiusFactor: 8 };
        function getCurveSegmentCount(radius = 1, sweep = Math.PI * 2) {
            const absSweep = Math.max(Math.abs(Number(sweep) || 0), 0);
            if (absSweep <= 1e-9) return 0;
            const sweepRatio = Math.min(1, Math.max(absSweep / (Math.PI * 2), 0.001));
            const safeRadius = Math.max(Math.abs(Number(radius) || 1), 1);
            const byAngle = Math.ceil(absSweep / TESS.maxAngleRad);
            const byRadius = Math.ceil(Math.sqrt(safeRadius) * TESS.radiusFactor * sweepRatio);
            const minForSweep = Math.max(4, Math.ceil(TESS.minSegments * sweepRatio));
            return Math.max(minForSweep, Math.min(TESS.maxSegments, Math.max(byAngle, byRadius)));
        }
        function addPointIfDistinct(points, pt) {
            if (!pt || !Number.isFinite(Number(pt.x)) || !Number.isFinite(Number(pt.y))) return;
            const next = { x: Number(pt.x), y: Number(pt.y), z: Number(pt.z || 0) };
            const last = points[points.length - 1];
            if (!last || Math.hypot(last.x - next.x, last.y - next.y) > 1e-9) points.push(next);
        }
        function getCircleCenter(entity) {
            return entity.__center || getPointCandidate(entity.center, entity.centerPoint, entity.position, entity.startPoint);
        }
        function getCircleRadius(entity) {
            const raw = entity.__radius ?? entity.radius ?? entity.r ?? (Number(entity.diameter) / 2);
            const radius = Math.abs(Number(raw));
            return Number.isFinite(radius) ? radius : 0;
        }
        function getArcPoints(center, radius, startRad, endRad, closed = false) {
            const points = [];
            if (!center || !(radius > 0)) return points;
            let sweep = closed ? Math.PI * 2 : normalizeArcEnd(startRad, endRad) - startRad;
            if (!closed && sweep <= 0) sweep += Math.PI * 2;
            const n = getCurveSegmentCount(radius, sweep);
            for (let i = 0; i <= n; i++) {
                const t = startRad + sweep * (i / n);
                addPointIfDistinct(points, { x: center.x + Math.cos(t) * radius, y: center.y + Math.sin(t) * radius, z: center.z || 0 });
            }
            return points;
        }
        function getBulgeArcPoints(start, end, bulge) {
            const p1 = getPointCandidate(start), p2 = getPointCandidate(end);
            const b = Number(bulge || 0);
            if (!p1 || !p2 || !Number.isFinite(b) || Math.abs(b) < 1e-9) return [p1, p2].filter(Boolean);
            const dx = p2.x - p1.x, dy = p2.y - p1.y;
            const chord = Math.hypot(dx, dy);
            if (!(chord > 0)) return [p1];
            const theta = 4 * Math.atan(b);
            const radius = Math.abs(chord / (2 * Math.sin(theta / 2)));
            const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
            const ux = dx / chord, uy = dy / chord;
            const h = radius * Math.cos(Math.abs(theta) / 2) * (b >= 0 ? 1 : -1);
            const center = { x: mid.x - uy * h, y: mid.y + ux * h, z: p1.z || 0 };
            const startAng = Math.atan2(p1.y - center.y, p1.x - center.x);
            const n = getCurveSegmentCount(radius, Math.abs(theta));
            const points = [];
            for (let i = 0; i <= n; i++) {
                const t = startAng + theta * (i / n);
                addPointIfDistinct(points, { x: center.x + Math.cos(t) * radius, y: center.y + Math.sin(t) * radius, z: p1.z || 0 });
            }
            addPointIfDistinct(points, p2);
            return points;
        }
        function getEllipsePoints(entity) {
            const center = entity.__center || getPointCandidate(entity.center, entity.centerPoint, entity.position);
            const major = entity.__majorAxisEndPoint || getPointCandidate(entity.majorAxisEndPoint, entity.majorAxis, entity.axis, entity.endPoint);
            if (!center || !major) return [];
            const majorLen = Math.hypot(Number(major.x), Number(major.y));
            if (!(majorLen > 0)) return [];
            const ratio = Math.abs(Number(entity.__axisRatio ?? entity.axisRatio ?? entity.ratio ?? entity.minorToMajorRatio ?? 1)) || 1;
            const minorLen = majorLen * ratio;
            const ux = major.x / majorLen, uy = major.y / majorLen;
            const vx = -uy, vy = ux;
            const start = angleToRadians(entity.startAngle ?? entity.startangle ?? entity.parameterStart ?? 0, 0);
            let end = angleToRadians(entity.endAngle ?? entity.endangle ?? entity.parameterEnd ?? Math.PI * 2, Math.PI * 2);
            const full = Math.abs(end - start) < 1e-9 || Math.abs(Math.abs(end - start) - Math.PI * 2) < 1e-6;
            if (!full) end = normalizeArcEnd(start, end);
            const sweep = full ? Math.PI * 2 : end - start;
            const n = getCurveSegmentCount(majorLen, sweep);
            const points = [];
            for (let i = 0; i <= n; i++) {
                const t = start + sweep * (i / n);
                addPointIfDistinct(points, {
                    x: center.x + ux * Math.cos(t) * majorLen + vx * Math.sin(t) * minorLen,
                    y: center.y + uy * Math.cos(t) * majorLen + vy * Math.sin(t) * minorLen,
                    z: center.z || 0,
                });
            }
            return points;
        }
        function getInterpolatedSplinePoints(points) {
            if (!points || points.length < 3) return points || [];
            const samplesPerSpan = 16;
            const result = [];
            const getPt = i => points[Math.max(0, Math.min(points.length - 1, i))];
            for (let i = 0; i < points.length - 1; i++) {
                const p0 = getPt(i - 1), p1 = getPt(i), p2 = getPt(i + 1), p3 = getPt(i + 2);
                for (let j = 0; j < samplesPerSpan; j++) {
                    const t = j / samplesPerSpan, t2 = t * t, t3 = t2 * t;
                    addPointIfDistinct(result, {
                        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
                        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
                        z: 0,
                    });
                }
            }
            addPointIfDistinct(result, points[points.length - 1]);
            return result;
        }

        function entityToPolylinePoints(entity) {
            if (!entity) return [];
            const type = entity.type;
            if (type === 'LINE') return (entity.vertices || []).slice(0, 2).map(getPointCandidate).filter(Boolean);
            if (type === 'POLYLINE' || type === 'LWPOLYLINE') {
                const vertices = (entity.vertices || []).map(getPointCandidate).filter(Boolean);
                if (vertices.length < 2) return vertices;
                const src = entity.vertices || [];
                const points = [];
                addPointIfDistinct(points, vertices[0]);
                for (let i = 0; i < vertices.length - 1; i++) {
                    const arcPts = getBulgeArcPoints(vertices[i], vertices[i + 1], Number(src[i]?.bulge || 0));
                    arcPts.slice(1).forEach(pt => addPointIfDistinct(points, pt));
                }
                if (entity.shape && vertices.length > 2) {
                    const arcPts = getBulgeArcPoints(vertices[vertices.length - 1], vertices[0], Number(src[vertices.length - 1]?.bulge || 0));
                    arcPts.slice(1).forEach(pt => addPointIfDistinct(points, pt));
                }
                return points;
            }
            if (type === 'CIRCLE') {
                if (entity.__curveMatrix) {
                    return getArcPoints(getPointCandidate(entity.center, entity.centerPoint, entity.position, entity.startPoint),
                        Math.abs(Number(entity.radius ?? entity.r ?? 0)), 0, Math.PI * 2, true)
                        .map(p => transformPoint2D(p, entity.__curveMatrix));
                }
                return getArcPoints(getCircleCenter(entity), getCircleRadius(entity), 0, Math.PI * 2, true);
            }
            if (type === 'ARC') {
                if (entity.__curveMatrix) {
                    const start = angleToRadians(entity.startAngle ?? entity.startangle ?? 0);
                    const end = angleToRadians(entity.endAngle ?? entity.endangle ?? 0);
                    return getArcPoints(getPointCandidate(entity.center, entity.centerPoint, entity.position, entity.startPoint),
                        Math.abs(Number(entity.radius ?? entity.r ?? 0)), start, end, false)
                        .map(p => transformPoint2D(p, entity.__curveMatrix));
                }
                const offset = degToRad(entity.__angleOffsetDeg || 0);
                const start = angleToRadians(entity.startAngle ?? entity.startangle ?? 0) + offset;
                const end = angleToRadians(entity.endAngle ?? entity.endangle ?? 0) + offset;
                return getArcPoints(getCircleCenter(entity), getCircleRadius(entity), start, end, false);
            }
            if (type === 'ELLIPSE') return getEllipsePoints(entity);
            if (type === 'SPLINE') {
                if (entity.__splinePoints?.length) return entity.__splinePoints.map(getPointCandidate).filter(Boolean);
                const sampled = window.DxfSpline.sample(entity, { samplesPerSpan: 16 });
                if (sampled) return sampled;
                const pts = (entity.fitPoints || entity.controlPoints || []).map(getPointCandidate).filter(Boolean);
                return getInterpolatedSplinePoints(pts);
            }
            if (type === 'VIEWPORT') {
                const c = getPointCandidate(entity.center, entity.position);
                const w = Math.abs(Number(entity.width)) || 0, h = Math.abs(Number(entity.height)) || 0;
                if (!c || !(w > 0) || !(h > 0)) return [];
                return [
                    { x: c.x - w / 2, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y - h / 2 },
                    { x: c.x + w / 2, y: c.y + h / 2 }, { x: c.x - w / 2, y: c.y + h / 2 },
                    { x: c.x - w / 2, y: c.y - h / 2 },
                ];
            }
            // Like the editor, POINT entities supply snap locations, not linework.

            return [];
        }

        function getHatchLoops(ctx, hatchIn) {
            if (!window.DxfHatch) return [];
            const hatch = hatchIn.__hatchSourceEntity || hatchIn.__sourceEntity || hatchIn;
            const key = hatchIn.__hatchMatrix ? hatchIn : hatch;
            let loops = ctx.hatchLoopCache.get(key);
            if (!loops) {
                let local = ctx.hatchLoopCache.get(hatch);
                if (!local) {
                    local = window.DxfHatch.buildHatchLoops(hatch, {
                        bulgePoints: (a, b, bulge) => getBulgeArcPoints(a, b, bulge),
                        curveSegments: (radius, sweep) => getCurveSegmentCount(radius, sweep),
                    });
                    ctx.hatchLoopCache.set(hatch, local);
                }
                loops = window.DxfHatch.renderLoops(local, hatchIn.__hatchMatrix);
                ctx.hatchLoopCache.set(key, loops);
            }
            return loops;
        }
        function hatchShapes(loops) {
            const out = [];
            for (const outer of window.DxfHatch.classifyLoops(loops)) {
                const shape = new THREE.Shape(outer.ring.map(p => new THREE.Vector2(p.x, p.y)));
                for (const hole of outer.holes) shape.holes.push(new THREE.Path(hole.map(p => new THREE.Vector2(p.x, p.y))));
                out.push(shape);
            }
            return out;
        }

        function getDimTextHeight(ctx) {
            if (ctx.dimTextHeightCache !== null) return ctx.dimTextHeightCache;
            const hdr = ctx.dxf?.header || {};
            const t = Number(hdr.$DIMTXT), s = Number(hdr.$DIMSCALE);
            if (t > 0) { ctx.dimTextHeightCache = t * (s > 0 ? s : 1); return ctx.dimTextHeightCache; }
            ctx.dimTextHeightCache = 2.5;
            return 2.5;
        }

        // entityToSegments: flat line segments for bounds and zoom targets.
        // MULTILEADER display: child renderables from dxf-mleader.js (cached).
        function mleaderChildren(ctx, e) {
            if (!window.DxfMLeader) return [];
            if (!e.__mlChildren) {
                e.__mlChildren = window.DxfMLeader.children(e, {
                    blockNameByHandle: ctx.mleaderBlockNames || new Map(),
                    getBlock: (name) => getBlockByName(ctx, name),
                });
            }
            return e.__mlChildren;
        }

        // Classic LEADER path as AutoCAD shows it (spline, hook line).
        function leaderPathPoints(ctx, entity) {
            const x = entity?.__leaderExtras;
            if (!x || !window.DxfMLeader) return entity?.vertices || [];
            const h = ctx.dxf?.header || {};
            const st = {};
            for (const k of ['DIMTAD', 'DIMGAP', 'DIMSCALE', 'DIMASZ']) if (Number.isFinite(Number(h['$' + k]))) st[k] = Number(h['$' + k]);
            Object.assign(st, ctx.leaderDimStyles?.get(String(x.dimstyle || '').toUpperCase()) || {});
            return window.DxfMLeader.leaderDisplayPoints(entity.vertices, x, st);
        }

        function entityToSegments(ctx, entity) {
            if (entity?.type === 'MULTILEADER') {
                const segs = [];
                for (const c of mleaderChildren(ctx, entity)) {
                    if (c.type === 'MTEXT') continue;
                    for (const sg of entityToSegments(ctx, c)) segs.push(sg);
                }
                return segs;
            }
            if (entity?.type === 'ACAD_TABLE') {
                return window.DxfHatch?.acadTableGeometry ? window.DxfHatch.acadTableGeometry(entity).segments : [];
            }
            if (entity?.type === 'INSERT') {
                const segs = [];
                const block = getBlockByName(ctx, entity.name || entity.block || entity.blockName);
                if (block?.entities?.length) {
                    const matrix = getInsertMatrix(ctx, entity, makeMatrix());
                    const walk = (ents, mtx, depth) => {
                        if (!Array.isArray(ents) || depth > 12) return;
                        for (const child of ents) {
                            if (!child) continue;
                            if (child.type === 'INSERT') {
                                const b2 = getBlockByName(ctx, child.name || child.block || child.blockName);
                                if (b2?.entities?.length) walk(b2.entities, getInsertMatrix(ctx, child, mtx), depth + 1);
                                continue;
                            }
                            const baked = transformRenderableEntity(child, mtx, entity.layer);
                            if (baked) for (const s of entityToSegments(ctx, baked)) segs.push(s);
                        }
                    };
                    walk(block.entities, matrix, 0);
                }
                return segs;
            }
            if (entity?.type === 'HATCH') {
                const segs = [];
                for (const ring of getHatchLoops(ctx, entity)) {
                    for (let i = 0; i < ring.length - 1; i++) {
                        segs.push({ x1: ring[i].x, y1: ring[i].y, x2: ring[i + 1].x, y2: ring[i + 1].y });
                    }
                }
                return segs;
            }
            if (entity?.type === 'DIMENSION') {
                // Tier 1: the dimension's anonymous block already holds world-space graphics.
                const block = getBlockByName(ctx, entity.block);
                if (block?.entities?.length) {
                    const segs = [];
                    for (const child of block.entities) {
                        if (!child || child.type === 'INSERT' || child.type === 'DIMENSION') continue;
                        for (const s of entityToSegments(ctx, child)) segs.push(s);
                    }
                    if (segs.length) return segs;
                }
                const D = window.DxfDim;
                const synth = D ? D.synthesizeFromEntity(entity, getDimTextHeight(ctx), 2) : null;
                if (!synth) return [];
                const segs = [...synth.segments];
                for (const pl of synth.polylines || []) {
                    const vs = pl.vertices;
                    for (let i = 0; i < vs.length; i++) {
                        const a = vs[i], b = vs[(i + 1) % vs.length];
                        if (i === vs.length - 1 && !pl.closed) break;
                        segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
                    }
                }
                return segs;
            }
            if (entity?.type === 'WIPEOUT') {
                const vs = entity.vertices || [];
                const segs = [];
                for (let i = 0; i < vs.length; i++) {
                    const a = vs[i], b = vs[(i + 1) % vs.length];
                    segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
                }
                return segs;
            }
            if (entity?.type === 'LEADER') {
                const D = window.DxfDim;
                const g = D ? D.leaderGeometry(leaderPathPoints(ctx, entity), entity.textHeight || getDimTextHeight(ctx)) : null;
                if (!g) return [];
                const segs = [...g.segments];
                for (const pl of g.polylines) {
                    const vs = pl.vertices;
                    for (let i = 0; i < vs.length; i++) {
                        const a = vs[i], b = vs[(i + 1) % vs.length];
                        if (i === vs.length - 1 && !pl.closed) break;
                        segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
                    }
                }
                return segs;
            }
            if (entity?.type === 'TEXT' || entity?.type === 'MTEXT' || entity?.type === 'ATTRIB' || entity?.type === 'ATTDEF') {
                // Approximate glyph box → good enough for bounds and zoom.
                const p = entity.__textPoint || getTextInsertionPoint(entity);
                if (!p) return [];
                const h = Math.abs(Number(entity.__textHeight ?? entity.textHeight ?? entity.height ?? 1)) || 1;
                const w = h * Math.max(String(getEntityText(entity)).length * 0.6, 1);
                return [
                    { x1: p.x, y1: p.y, x2: p.x + w, y2: p.y },
                    { x1: p.x + w, y1: p.y, x2: p.x + w, y2: p.y + h },
                    { x1: p.x + w, y1: p.y + h, x2: p.x, y2: p.y + h },
                    { x1: p.x, y1: p.y + h, x2: p.x, y2: p.y },
                ];
            }
            const points = entityToPolylinePoints(entity);
            const segments = [];
            for (let i = 0; i < points.length - 1; i++) {
                const a = points[i], b = points[i + 1];
                if (!a || !b) continue;
                if (Math.hypot(b.x - a.x, b.y - a.y) <= 1e-9) continue;
                segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
            }
            return segments;
        }

        function getInsertMatrix(ctx, entity, parentMatrix = makeMatrix()) {
            const block = getBlockByName(ctx, entity?.name || entity?.block || entity?.blockName);
            return window.DxfBlockTransform.getInsertMatrix(entity, block, parentMatrix, getEntityRotationDegrees(entity));
        }

        function resolveEntityLayer(entity, inheritedLayer) { return window.DxfBlockTransform.resolveEntityLayer(entity,inheritedLayer); }

        function transformRenderableEntity(entity, matrix = makeMatrix(), inheritedLayer = null) {
            const layerName = resolveEntityLayer(entity, inheritedLayer);
            const transformed = { ...entity, layer: layerName };
            transformed.__sourceEntity = entity.__sourceEntity || entity;
            if (entity.type === 'POINT') transformed.__point = transformPoint2D(getPointCandidate(entity.position, entity.startPoint), matrix);
            const matrixScale = getMatrixScale(matrix);
            const matrixRotation = getMatrixRotation(matrix);
            if (entity?.type === 'HATCH') {
                transformed.__hatchSourceEntity = entity;
                const nonIdentity = matrix.a !== 1 || matrix.b !== 0 || matrix.c !== 0 || matrix.d !== 1 || matrix.e !== 0 || matrix.f !== 0;
                if (nonIdentity) {
                    transformed.__hatchMatrix = matrix;
                    transformed.patternLines = window.DxfHatch.renderPatternLines(entity, matrix);
                }
            }
            if (entity?.vertices?.length) {
                const det = matrix.a * matrix.d - matrix.b * matrix.c;
                const bulgeSign = det < 0 ? -1 : 1;
                transformed.vertices = entity.vertices.map(v => {
                    const p = transformPoint2D(v, matrix);
                    if (!p) return null;
                    const bulge = Number(v?.bulge) || 0;
                    if (bulge) p.bulge = bulge * bulgeSign;
                    if (Number.isFinite(v?.startWidth)) p.startWidth = v.startWidth * matrixScale;
                    if (Number.isFinite(v?.endWidth)) p.endWidth = v.endWidth * matrixScale;
                    return p;
                }).filter(Boolean);
                if (Number.isFinite(entity.width)) transformed.width = entity.width * matrixScale;
            }
            if (entity?.type === 'CIRCLE' || entity?.type === 'ARC') {
                transformed.__center = transformPoint2D(getPointCandidate(entity.center, entity.centerPoint, entity.position, entity.startPoint), matrix);
                transformed.__radius = Math.abs(Number(entity.radius ?? entity.r ?? 0)) * matrixScale;
                transformed.__angleOffsetDeg = matrixRotation;
                transformed.__curveMatrix = matrix;
            }
            if (entity?.type === 'ELLIPSE') {
                transformed.__center = transformPoint2D(getPointCandidate(entity.center, entity.centerPoint, entity.position), matrix);
                transformed.__majorAxisEndPoint = transformVector2D(entity.majorAxisEndPoint || entity.majorAxis || entity.axis || entity.endPoint, matrix);
                transformed.__axisRatio = Number(entity.axisRatio ?? entity.ratio ?? entity.minorToMajorRatio ?? 1) || 1;
                transformed.__angleOffsetDeg = 0;
            }
            if (entity?.type === 'SPLINE') {
                const pts = entity.__splinePoints || window.DxfSpline.sample(entity, { samplesPerSpan: 16 })
                    || (entity.fitPoints?.length ? entity.fitPoints : entity.controlPoints);
                if (pts?.length) transformed.__splinePoints = pts.map(pt => transformPoint2D(pt, matrix)).filter(Boolean);
            }
            if (entity?.type === 'TEXT' || entity?.type === 'MTEXT' || entity?.type === 'ATTRIB' || entity?.type === 'ATTDEF') {
                transformed.__textSourceEntity = entity.__textSourceEntity || entity;
                transformed.__textPoint = transformPoint2D(getTextInsertionPoint(entity), matrix);
                if ((entity.halign || entity.valign) && entity.endPoint) {
                    transformed.__textAlignPoint = transformPoint2D(entity.endPoint, matrix);
                }
                transformed.__text = getEntityText(entity);
                transformed.__textRotation = getEntityRotationDegrees(entity) + matrixRotation;
                transformed.__textHeight = Number(entity?.textHeight ?? entity?.height ?? entity?.nominalTextHeight ?? entity?.textSize ?? 0) * matrixScale;
                transformed.__textWidth = Number(entity?.width ?? entity?.rectWidth ?? entity?.maxLineWidth ?? entity?.columnWidth ?? 0) * matrixScale;
                transformed.__isMText = entity?.type === 'MTEXT';
            }
            return transformed;
        }

        // Walk root entities, exploding INSERTs / DIMENSION anonymous blocks,
        // and hand each renderable (world-space) copy to the callback.
        function forEachRenderableEntity(ctx, callback, rootEntities, onInsertion) {
            const visit = (entities, matrix = makeMatrix(), inheritedLayer = null, depth = 0, sourceOverride = null, inheritedColor = null) => {
                if (!Array.isArray(entities) || depth > 12) return;
                entities.forEach(entity => {
                    if (!entity) return;
                    if (entity.type === 'ATTRIB' && entity.invisible) return;
                    const sourceColor = window.DxfColor.resolve(entity, {
                        getLayer: name => ctx.dxf?.tables?.layer?.layers?.[name], inheritedLayer, inheritedColor,
                    });
                    if (entity.type === 'MULTILEADER') {
                        visit(mleaderChildren(ctx, entity), matrix, resolveEntityLayer(entity, inheritedLayer), depth + 1, sourceOverride || entity, sourceColor);
                        return;
                    }
                    if (entity.type === 'INSERT') {
                        const insertLayer = resolveEntityLayer(entity, inheritedLayer);
                        onInsertion?.(transformPoint2D(entity.position || entity.startPoint || { x: 0, y: 0 }, matrix), insertLayer);
                        const block = getBlockByName(ctx, entity.name || entity.block || entity.blockName);
                        const insertMatrix = getInsertMatrix(ctx, entity, matrix);
                        const insSource = sourceOverride || entity;
                        // MULTILEADER block content: attribute values replace the ATTDEF tags.
                        const assignedTags = new Set((entity.attributes || []).map(a => String(a.tag || '').toUpperCase()));
                        const blockEnts = entity.__skipAttdefs
                            ? (block?.entities || []).filter(c => c?.type !== 'ATTDEF')
                            : assignedTags.size
                                ? (block?.entities || []).filter(c => c?.type !== 'ATTDEF' || !assignedTags.has(String(c.tag || '').toUpperCase()))
                                : block?.entities;
                        if (blockEnts?.length) visit(blockEnts, insertMatrix, insertLayer, depth + 1, insSource, sourceColor);
                        if (Array.isArray(entity.attributes)) visit(entity.attributes, matrix, insertLayer, depth + 1, insSource, sourceColor);
                        return;
                    }
                    if (entity.type === 'DIMENSION') {
                        const dimLayer = resolveEntityLayer(entity, inheritedLayer);
                        const block = getBlockByName(ctx, entity.block);
                        if (block?.entities?.length) {
                            visit(block.entities, matrix, dimLayer, depth + 1, sourceOverride || entity, sourceColor);
                            return;
                        }
                        // fall through synthesized by DxfDim in addEntityToBucket
                    }
                    const transformed = transformRenderableEntity(entity, matrix, inheritedLayer);
                    if (sourceOverride && transformed) transformed.__sourceEntity = sourceOverride;
                    if (transformed) transformed.__sourceColor = sourceColor;
                    callback(transformed, sourceOverride || entity);
                });
            };
            visit(rootEntities);
        }

        // ==================================================================
        //  Paper-space viewport portals (ported from DXF_Viewer)
        //  Model content is projected into each viewport frame and clipped to
        //  its rectangle, so a layout renders like the printed sheet.
        // ==================================================================
        function getSpaceViewports(ctx, key) {
            return window.DxfCompareContext.getSpaceViewports(ctx, key, window.DxfLayout);
        }
        // Model point -> paper coordinates through a viewport (viewer math).
        function projectIntoViewport(p, vp) {
            return window.DxfViewport.project(p, { center: { x: vp.cx, y: vp.cy }, viewCenter: { x: vp.viewCenterX, y: vp.viewCenterY }, paperHeight: vp.height, modelHeight: vp.viewHeight, twist: (vp.twistDeg || 0) * Math.PI / 180 });
        }
        // Liang-Barsky segment clip to the viewport rectangle (viewer port).
        function clipSegToViewportRect(x1, y1, x2, y2, vp) {
            return window.DxfViewport.clipRect({ x:x1, y:y1 }, { x:x2, y:y2 }, { minX:vp.cx-vp.width/2, maxX:vp.cx+vp.width/2, minY:vp.cy-vp.height/2, maxY:vp.cy+vp.height/2 });
        }
        function pointInViewportRect(p, vp) {
            return window.DxfViewport.pointInRect(p, { minX:vp.cx-vp.width/2, maxX:vp.cx+vp.width/2, minY:vp.cy-vp.height/2, maxY:vp.cy+vp.height/2 });
        }

        // Project model-space top-level entities through every viewport of a
        // layout and append the result as per-layer groups inside `bucket`,
        // so category chips and layer toggles keep working unchanged.
        function addPortalContentToBucket(...args) { return sceneBuilder.addPortalContentToBucket(...args); }

        // Shared tail of buildBucketGroup: layerDict -> per-layer THREE groups.


        // White sheet backdrop with a gray edge (viewer's __paper_sheet__).
        function buildSheetGroup(...args) { return sceneBuilder.buildSheetGroup(...args); }

        function spaceContentBounds(ctxs, key) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false;
            for (const ctx of ctxs) {
                for (const e of (getSpaceEntities(ctx, key) || [])) {
                    for (const s of alignedSegments(ctx, e, key)) {
                        if (![s.x1, s.y1, s.x2, s.y2].every(Number.isFinite)) continue;
                        minX = Math.min(minX, s.x1, s.x2); maxX = Math.max(maxX, s.x1, s.x2);
                        minY = Math.min(minY, s.y1, s.y2); maxY = Math.max(maxY, s.y1, s.y2);
                        found = true;
                    }
                }
                for (const originalVp of getSpaceViewports(ctx, key)) {
                    const offset = ctx === ctxB ? alignmentOffset(key) : { x: 0, y: 0 };
                    const vp = { ...originalVp, cx: originalVp.cx + offset.x, cy: originalVp.cy + offset.y };
                    minX = Math.min(minX, vp.cx - vp.width / 2); maxX = Math.max(maxX, vp.cx + vp.width / 2);
                    minY = Math.min(minY, vp.cy - vp.height / 2); maxY = Math.max(maxY, vp.cy + vp.height / 2);
                    found = true;
                }
            }
            return found ? { minX, minY, maxX, maxY } : null;
        }

        // ==================================================================
        //  Colors (single-file viewer mode uses drawing colors)
        // ==================================================================
        function getDrawingHexColor(ctx, entity) {
            return window.DxfColor.display(entity?.__sourceColor || window.DxfColor.resolve(entity, {
                getLayer: name => ctx.dxf?.tables?.layer?.layers?.[name],
            }), isEffectiveDarkMode());
        }

        // ==================================================================
        //  Text sprites (simplified lift: shared texture cache, no LOD rebuckets)
        // ==================================================================
        const sceneBuilder = window.DxfCompareRenderer.createSceneBuilder(THREE, window, {
            settings, forEachRenderableEntity, getDrawingHexColor, getTextInsertionPoint,
            getEntityText, projectIntoViewport, pointInViewportRect, entityToSegments,
            clipSegToViewportRect, spaceContentBounds, isEffectiveDarkMode,
            getHatchLoops, hatchShapes, getDimTextHeight,
        });
        const textTextureCache = sceneBuilder.textTextureCache;




        // ==================================================================
        //  Bucket scene building
        //  bucket = { colorHex|null, opacity, entities:[{ctx, entity}] }
        //  Structure: bucketGroup > per-layer THREE.Group (name = layer)
        // ==================================================================


        function buildBucketGroup(...args) { return sceneBuilder.buildBucketGroup(...args); }



        // ==================================================================
        //  Three.js setup: one camera drives three renderers
        // ==================================================================
        const hostMain = document.getElementById('host-main');
        const hostA = document.getElementById('host-a');
        const hostB = document.getElementById('host-b');

        let camera = null;
        let sceneOverlay = null, sceneA = null, sceneB = null;
        // Swipe view: measure + highlight live here, drawn full width on
        // top of both halves (sceneA left / sceneB right are scissored).
        let sceneTop = null;
        let rMain = null, rA = null, rB = null;
        let controlsMain = null, controlsA = null, controlsB = null;
        let viewMode = 'overlay'; // 'overlay' | 'sbs' | 'swipe'
        let swipeSplit = 0.5;     // divider position, fraction of host-main width
        let renderLifecycle = null;
        // host-main renders overlay AND swipe; host-a/host-b only sbs
        const usesMainHost = () => viewMode !== 'sbs';

        // Bucket groups (built after compare; re-parented on mode switch)
        let groups = null; // { unchangedA, unchangedB, deleted, added, modifiedA, modifiedB }
        let highlightLine = null;

        let rendererSession = null;
        function requestRender() { renderLifecycle?.requestRender(); }
        function syncControlsToCamera() { rendererSession?.syncControlsToCamera(); }

        function initThree() {
            if (camera) return;
            rendererSession = window.DxfCompareRenderer.createSession(THREE, OrbitControls,
                { main: hostMain, a: hostA, b: hostB }, window.devicePixelRatio, requestRender);
            ({ camera, highlightLine } = rendererSession);
            ({ overlay: sceneOverlay, a: sceneA, b: sceneB, top: sceneTop } = rendererSession.scenes);
            ({ main: rMain, a: rA, b: rB } = rendererSession.renderers);
            ({ main: controlsMain, a: controlsA, b: controlsB } = rendererSession.controls);
            wireToolEvents(hostMain);
            wireToolEvents(hostA);
            wireToolEvents(hostB);
            [hostMain, hostA, hostB].forEach(wireAlignmentEvents);

            renderLifecycle = window.DxfCompareRenderer.createLifecycle(window,
                [hostMain, hostA, hostB], () => {
                    sceneBuilder.updateTextLOD(camera, (usesMainHost() ? hostMain : hostA).clientHeight);
                    window.DxfCompareRenderer.renderFrame(viewMode, camera, rendererSession.renderers,
                        rendererSession.scenes, swipeSplit, swipeSize);
                    if (measureLabels.length) positionMeasureLabels();
                    rescaleSnapMarker();
                }, () => {
                    measureToolbarHeight();
                    window.DxfCompareRenderer.resize(camera, usesMainHost() ? hostMain : hostA,
                        [[rMain, hostMain], [rA, hostA], [rB, hostB]]);
                });
            renderLifecycle.start();
        }

        function measureToolbarHeight() {
            const tb = document.getElementById('cmp-toolbar');
            const stage = document.getElementById('compare-stage');
            if (tb && stage) stage.style.setProperty('--draw-toolbar-h', tb.offsetHeight + 'px');
        }

        function onResize() {
            if (renderLifecycle) renderLifecycle.resize();
            else measureToolbarHeight();
        }

        const swipeSize = new THREE.Vector2();

        function clearScenes() {
            sceneBuilder.clearTextSprites();
            window.DxfCompareRenderer.clearScenes([sceneOverlay, sceneA, sceneB, sceneTop], textTextureCache);
        }

        function applySpaceBackground() {
            const paper = currentSpace !== 'model';
            const bg = paper ? 0xcbd5e1 : (isEffectiveDarkMode() ? 0x2a2e37 : 0xf1f5f9);
            for (const scene of [sceneOverlay, sceneA, sceneB]) {
                if (scene) scene.background = new THREE.Color(bg);
            }
            const btn = document.getElementById('btn-theme');
            if (btn) {
                btn.disabled = paper;
                btn.title = paper ? tr('paperLightLocked', 'Paper space is always light mode') : tr('toggleDarkMode', 'Toggle drawing background');
                btn.setAttribute('aria-label', btn.title);
            }
        }

        function parentGroupsForMode() {
            if (!groups) return;
            positionAlignedGroups();
            applySpaceBackground();
            // Detach everything first (a group lives in exactly one scene).
            for (const g of Object.values(groups)) g.parent?.remove(g);
            highlightLine.parent?.remove(highlightLine);
            if (viewMode === 'overlay') {
                sceneOverlay.add(groups.unchangedB, groups.deleted, groups.added, groups.modifiedB);
                sceneOverlay.add(groups.modifiedA);
                if (colorMode === 'files' || alignmentMode === 'drag') sceneOverlay.add(groups.unchangedA);
                sceneOverlay.add(highlightLine);
            } else {
                // sbs and swipe share the same A / B scenes
                sceneA.add(groups.unchangedA, groups.deleted, groups.modifiedA);
                sceneB.add(groups.unchangedB, groups.added, groups.modifiedB);
                (viewMode === 'swipe' ? sceneTop : sceneB).add(highlightLine);
            }
            applyCategoryVisibility();
            applyLayerVisibility();
            requestRender();
        }

        // ==================================================================
        //  Compare orchestration
        // ==================================================================
        let compareResult = null;
        let layerVisibility = {};   // layer name -> bool
        let categoryVisibility = { added: true, deleted: true, modified: true, unchanged: true };
        let tolerance = 1e-4;
        let singleFileMode = false;
        let colorMode = 'changes'; // 'changes' | 'files'
        const fileDisplay = { a: '#f59e0b', b: '#10b981', showA: true, showB: true, balance: 50 };
        let changeIndex = -1;
        let currentSpace = 'model'; // 'model' | layout name lower-case
        let spaceResults = {};      // key -> { status:'matched'|'missingA'|'missingB', name, result? }

        const alignments = new Map();
        let alignmentMode = null, alignmentAnchor = null, alignmentDrag = null;
        const alignmentOffset = (key = currentSpace) => alignments.get(key) || { x: 0, y: 0 };
        function alignedSegments(ctx, entity, key = currentSpace) {
            const offset = ctx === ctxB ? alignmentOffset(key) : { x: 0, y: 0 };
            return entityToSegments(ctx, entity).map(s => ({ ...s,
                x1: s.x1 + offset.x, y1: s.y1 + offset.y,
                x2: s.x2 + offset.x, y2: s.y2 + offset.y }));
        }
        function positionAlignedGroups(offset = alignmentOffset()) {
            for (const key of ['unchangedB', 'added', 'modifiedB'])
                groups?.[key]?.position.set(offset.x, offset.y, 0);
            requestRender();
        }

        function spaceKeysUnion() {
            const keys = [{ key: 'model', name: tr('spaceModel', 'Model'), order: -1 }];
            const seen = {};
            const push = (l) => {
                const k = l.name.toLowerCase();
                if (seen[k]) return;
                seen[k] = true;
                keys.push({ key: k, name: l.name, order: l.tabOrder });
            };
            for (const l of ctxA.layouts) push(l);
            for (const l of ctxB.layouts) push(l);
            keys.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
            return keys;
        }

        function runCompare() {
            // Compare every space (model + union of layout names).
            spaceResults = {};
            const blocksA = ctxA.dxf?.blocks || {}, blocksB = ctxB.dxf?.blocks || {};
            for (const s of spaceKeysUnion()) {
                const entsA = getSpaceEntities(ctxA, s.key);
                const entsB = getSpaceEntities(ctxB, s.key);
                if (entsA === null && entsB === null) continue;
                if (entsA === null || entsB === null) {
                    spaceResults[s.key] = { status: entsA === null ? 'missingA' : 'missingB', name: s.name };
                    continue;
                }
                const result = window.DxfCompare.compare(
                    { entities: entsA, blocks: blocksA, tables: ctxA.dxf?.tables },
                    { entities: entsB, blocks: blocksB, tables: ctxB.dxf?.tables },
                    { tolerance, filterPaperSpace: s.key === 'model', offsetB: alignmentOffset(s.key) });
                spaceResults[s.key] = { status: 'matched', name: s.name, result };
            }
            if (!spaceResults[currentSpace]) currentSpace = 'model';
            compareResult = spaceResults[currentSpace]?.result || null;
        }

        function rebuildDiffScene() {
            clearScenes();
            if (colorMode === 'files') { rebuildFileScene(); return; }
            const sr = spaceResults[currentSpace];
            if (sr && sr.status !== 'matched') {
                // Layout exists on one side only: everything is added or deleted.
                const missingA = sr.status === 'missingA';
                const ctx = missingA ? ctxB : ctxA;
                const ents = getSpaceEntities(ctx, currentSpace) || [];
                const orig1 = colorMode === 'original';
                const oneColor = orig1 ? null : (missingA ? COLORS.added : COLORS.deleted);
                const g = buildBucketGroup(missingA ? 'added' : 'deleted', ents.map(e => ({ ctx, entity: e })), oneColor, null);
                const vps = getSpaceViewports(ctx, currentSpace);
                addPortalContentToBucket(g, ctx, vps, (ctx.modelEntities || []).map(e => ({ entity: e })), oneColor, null);
                g.add(buildSheetGroup([ctx], currentSpace));
                const empty = () => new THREE.Group();
                groups = {
                    unchangedA: empty(), unchangedB: empty(),
                    deleted: missingA ? empty() : g,
                    added: missingA ? g : empty(),
                    modifiedA: empty(), modifiedB: empty(),
                };
                parentGroupsForMode();
                return;
            }
            const r = compareResult;
            if (!r) return;
            const orig = colorMode === 'original';
            const paper = currentSpace !== 'model';
            // 'changes': diff palette, unchanged dimmed.
            // 'original': every entity in its drawing color, full opacity.
            const col = k => orig ? null : COLORS[k];
            const dim = orig ? null : UNCHANGED_OPACITY;
            groups = {
                unchangedA: buildBucketGroup('unchangedA', r.unchanged.map(p => ({ ctx: ctxA, entity: p.a })), col('unchanged'), dim),
                unchangedB: buildBucketGroup('unchangedB', r.unchanged.map(p => ({ ctx: ctxB, entity: p.b })), col('unchanged'), dim),
                deleted: buildBucketGroup('deleted', r.deleted.map(p => ({ ctx: ctxA, entity: p.a })), col('deleted'), null),
                added: buildBucketGroup('added', r.added.map(p => ({ ctx: ctxB, entity: p.b })), col('added'), null),
                modifiedA: buildBucketGroup('modifiedA', r.modified.map(p => ({ ctx: ctxA, entity: p.a })), col('modified'), null),
                modifiedB: buildBucketGroup('modifiedB', r.modified.map(p => ({ ctx: ctxB, entity: p.b })), col('modified'), null),
            };
            if (paper) {
                // The printed plan: model content projected through the frames,
                // coloured by the MODEL-space diff status of each entity.
                const vpsA = getSpaceViewports(ctxA, currentSpace);
                const vpsB = getSpaceViewports(ctxB, currentSpace);
                const mr = spaceResults['model']?.result;
                if (mr) {
                    addPortalContentToBucket(groups.unchangedA, ctxA, vpsA, mr.unchanged.map(p => ({ entity: p.a })), col('unchanged'), dim);
                    addPortalContentToBucket(groups.unchangedB, ctxB, vpsB, mr.unchanged.map(p => ({ entity: p.b })), col('unchanged'), dim);
                    addPortalContentToBucket(groups.deleted, ctxA, vpsA, mr.deleted.map(p => ({ entity: p.a })), col('deleted'), null);
                    addPortalContentToBucket(groups.added, ctxB, vpsB, mr.added.map(p => ({ entity: p.b })), col('added'), null);
                    addPortalContentToBucket(groups.modifiedA, ctxA, vpsA, mr.modified.map(p => ({ entity: p.a })), col('modified'), null);
                    addPortalContentToBucket(groups.modifiedB, ctxB, vpsB, mr.modified.map(p => ({ entity: p.b })), col('modified'), null);
                }
                groups.unchangedA.add(buildSheetGroup([ctxA], currentSpace));
                groups.unchangedB.add(buildSheetGroup([ctxB], currentSpace));
            }
            parentGroupsForMode();
        }

        function rebuildFileScene() {
            const build = (ctx, side) => {
                const opacity = Math.min(1, side === 'a' ? 2 * (1 - fileDisplay.balance / 100) : 2 * fileDisplay.balance / 100);
                const color = parseInt(fileDisplay[side].slice(1), 16);
                const g = buildBucketGroup('file-' + side, (getSpaceEntities(ctx, currentSpace) || []).map(entity => ({ ctx, entity })), color, opacity);
                if (currentSpace !== 'model') {
                    addPortalContentToBucket(g, ctx, getSpaceViewports(ctx, currentSpace), (ctx.modelEntities || []).map(entity => ({ entity })), color, opacity);
                    g.add(buildSheetGroup([ctx], currentSpace));
                }
                return g;
            };
            groups = { unchangedA: build(ctxA, 'a'), unchangedB: build(ctxB, 'b'),
                deleted: new THREE.Group(), added: new THREE.Group(), modifiedA: new THREE.Group(), modifiedB: new THREE.Group() };
            parentGroupsForMode();
        }

        function rebuildViewerScene() {
            clearScenes();
            const ents = getSpaceEntities(ctxB, currentSpace) || ctxB.modelEntities;
            const drawingGroup = buildBucketGroup('drawing', ents.map(e => ({ ctx: ctxB, entity: e })), null, null);
            if (currentSpace !== 'model') {
                const vps = getSpaceViewports(ctxB, currentSpace);
                addPortalContentToBucket(drawingGroup, ctxB, vps, (ctxB.modelEntities || []).map(e => ({ entity: e })), null, null);
                drawingGroup.add(buildSheetGroup([ctxB], currentSpace));
            }
            groups = {
                unchangedA: new THREE.Group(), // placeholders keep mode switching trivial
                unchangedB: drawingGroup,
                deleted: new THREE.Group(), added: new THREE.Group(),
                modifiedA: new THREE.Group(), modifiedB: new THREE.Group(),
            };
            parentGroupsForMode();
        }

        function applyCategoryVisibility() {
            if (!groups) return;
            if (colorMode === 'files' && !singleFileMode) {
                groups.unchangedA.visible = fileDisplay.showA;
                groups.unchangedB.visible = fileDisplay.showB;
                requestRender(); return;
            }
            groups.added.visible = categoryVisibility.added;
            groups.deleted.visible = categoryVisibility.deleted;
            groups.modifiedA.visible = categoryVisibility.modified;
            groups.modifiedB.visible = categoryVisibility.modified;
            groups.unchangedA.visible = categoryVisibility.unchanged;
            groups.unchangedB.visible = categoryVisibility.unchanged;
            requestRender();
        }
        function applyLayerVisibility() {
            if (!groups) return;
            for (const bucket of Object.values(groups)) {
                for (const layerGroup of bucket.children) {
                    layerGroup.visible = layerVisibility[layerGroup.name] !== false;
                }
            }
            if (toolMode) buildMeasureSegCache();
            renderResultList();
            requestRender();
        }

        // ==================================================================
        //  Camera fit / zoom-to-entity
        // ==================================================================
        function overallBounds() {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false;
            const expand = (ctx, entity) => {
                for (const s of alignedSegments(ctx, entity)) {
                    if (![s.x1, s.y1, s.x2, s.y2].every(Number.isFinite)) continue;
                    minX = Math.min(minX, s.x1, s.x2); maxX = Math.max(maxX, s.x1, s.x2);
                    minY = Math.min(minY, s.y1, s.y2); maxY = Math.max(maxY, s.y1, s.y2);
                    found = true;
                }
            };
            for (const e of (getSpaceEntities(ctxA, currentSpace) || [])) expand(ctxA, e);
            for (const e of (getSpaceEntities(ctxB, currentSpace) || [])) expand(ctxB, e);
            if (!found) return null;
            return { minX, minY, maxX, maxY };
        }
        function fitCameraTo(b, paddingFactor = 1.1) {
            if (!b || !camera) return;
            const host = usesMainHost() ? hostMain : hostA;
            const aspect = Math.max((host.clientWidth || 2) / (host.clientHeight || 2), 0.01);
            const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
            let w = Math.max(b.maxX - b.minX, 1e-6) * paddingFactor;
            let h = Math.max(b.maxY - b.minY, 1e-6) * paddingFactor;
            if (w / h > aspect) h = w / aspect; else w = h * aspect;
            camera.left = -w / 2; camera.right = w / 2;
            camera.top = h / 2; camera.bottom = -h / 2;
            camera.zoom = 1;
            camera.up.set(0, 1, 0);
            camera.position.set(cx, cy, 100);
            camera.lookAt(cx, cy, 0);
            camera.updateProjectionMatrix();
            for (const c of [controlsMain, controlsA, controlsB]) {
                if (!c) continue;
                c.target.set(cx, cy, 0);
                c.update();
            }
            requestRender();
        }
        function zoomToFit() {
            if (currentSpace !== 'model') {
                const b = spaceContentBounds(singleFileMode ? [ctxB] : [ctxA, ctxB], currentSpace);
                if (b) { fitCameraTo(b); return; }
            }
            fitCameraTo(overallBounds());
        }

        function zoomToEntity(ctx, entity) {
            const segs = alignedSegments(ctx, entity);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false;
            for (const s of segs) {
                if (![s.x1, s.y1, s.x2, s.y2].every(Number.isFinite)) continue;
                minX = Math.min(minX, s.x1, s.x2); maxX = Math.max(maxX, s.x1, s.x2);
                minY = Math.min(minY, s.y1, s.y2); maxY = Math.max(maxY, s.y1, s.y2);
                found = true;
            }
            if (!found) {
                const rawPoint = getTextInsertionPoint(entity);
                const offset = ctx === ctxB ? alignmentOffset() : { x: 0, y: 0 };
                const p = rawPoint ? { x: rawPoint.x + offset.x, y: rawPoint.y + offset.y } : null;
                if (!p) return;
                minX = p.x - 5; maxX = p.x + 5; minY = p.y - 5; maxY = p.y + 5;
            }
            // Keep some context around a tiny entity.
            const span = Math.max(maxX - minX, maxY - minY, 1e-6);
            const pad = span * 2;
            fitCameraTo({ minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }, 1);
            // Flash highlight.
            const pts = [];
            for (const s of segs) pts.push(s.x1, s.y1, 0.1, s.x2, s.y2, 0.1);
            if (!pts.length) pts.push(minX, minY, 0.1, maxX, maxY, 0.1);
            highlightLine.geometry.dispose();
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
            highlightLine.geometry = geom;
            highlightLine.visible = true;
            requestRender();
            setTimeout(() => { highlightLine.visible = false; requestRender(); }, 1600);
        }

        // ==================================================================
        //  UI: results panel
        // ==================================================================
        const compareUi = window.DxfCompareUI.create(document, window, {
            getState: () => ({ compareResult, spaceResults, currentSpace, ctxA, ctxB,
                groups, layerVisibility, categoryVisibility, singleFileMode }),
            setLayerVisible: (name, visible) => { layerVisibility[name] = visible; },
            cleanDxfText, getSpaceEntities, applyLayerVisibility, tr, zoomToEntity,
            spaceKeysUnion, switchSpace,
            getSettings: () => settings,
            settingsChanged: rebuild => {
                saveSettings();
                if (!settings.snapEnabled) updateSnapMarker(null);
                if (!settings.snapEnabled) updateSnapMarker(null);
                if (!rebuild) return;
                if (singleFileMode) rebuildViewerScene(); else if (spaceResults[currentSpace]) rebuildDiffScene();
                requestRender();
            },
        });


        function renderCounts(...args) { return compareUi.renderCounts(...args); }

        function renderLayerList(...args) { return compareUi.renderLayerList(...args); }

        function escapeHtml(...args) { return compareUi.escapeHtml(...args); }

        function renderResultList(...args) { return compareUi.renderResultList(...args); }

        function renderPapersList(...args) { return compareUi.renderPapersList(...args); }

        function switchSpace(key) {
            if (key === currentSpace) return;
            stopAlignment();
            currentSpace = key;
            clearMeasurements();
            if (toolMode) buildMeasureSegCache();
            syncControlsToCamera();
            if (singleFileMode) {
                rebuildViewerScene();
            } else {
                compareResult = spaceResults[key]?.result || null;
                rebuildDiffScene();
            }
            refreshPanel();
            zoomToFit();
        }

        function refreshPanel() {
            syncAlignmentUi();
            renderCounts();
            renderLayerList();
            renderResultList();
            renderPapersList();
        }

        function setStatus(...args) { return compareUi.setStatus(...args); }

        // tr() shim mirroring the viewer: PAGE_I18N lookup + {placeholders}.
        function tr(key, fallback, params) { return window.DxfCompareUI.translate(window, key, fallback, params); }
        window.refreshCompareTranslations = function () { if (compareResult || singleFileMode) refreshPanel(); };

        // ==================================================================
        //  Measure distance + quick room dimensions (read-only overlays)
        // ==================================================================
        // ---- Snap marker gizmos (ported from DXF_Editor) ----
        const GIZMO_COLOR = 0xfb923c;          // marker orange
        const GIZMO_THICKNESS = 0.16;          // stroke fraction of gizmo size
        const GIZMO_SCREEN_FRACTION = 0.0067;  // constant on-screen size
        const gizmoGeometries = {};

        function quadsToGeometry(quads) {
            const positions = [], indices = [];
            let base = 0;
            for (const q of quads) {
                positions.push(q[0], q[1], 0, q[2], q[3], 0, q[4], q[5], 0, q[6], q[7], 0);
                indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
                base += 4;
            }
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geom.setIndex(indices);
            return geom;
        }
        function buildSquareOutlineGeometry(t = GIZMO_THICKNESS) {
            const o = 1, i = 1 - t;
            return quadsToGeometry([
                [-o, o, o, o, o, i, -o, i],
                [-o, -i, o, -i, o, -o, -o, -o],
                [-o, i, -i, i, -i, -i, -o, -i],
                [i, i, o, i, o, -i, i, -i],
            ]);
        }
        function buildTriangleOutlineGeometry(t = GIZMO_THICKNESS) {
            const A = [0, 1.15], B = [1.0, -0.7], C = [-1.0, -0.7];
            const quads = [];
            for (const [p, q] of [[A, B], [B, C], [C, A]]) {
                const dx = q[0] - p[0], dy = q[1] - p[1];
                const len = Math.hypot(dx, dy) || 1;
                const nx = -dy / len * t, ny = dx / len * t;
                quads.push([p[0] + nx, p[1] + ny, q[0] + nx, q[1] + ny, q[0] - nx, q[1] - ny, p[0] - nx, p[1] - ny]);
            }
            return quadsToGeometry(quads);
        }
        function buildXGeometry(t = GIZMO_THICKNESS) {
            const quads = [];
            for (const [p, q] of [[[-1, -1], [1, 1]], [[-1, 1], [1, -1]]]) {
                const dx = q[0] - p[0], dy = q[1] - p[1];
                const len = Math.hypot(dx, dy) || 1;
                const nx = -dy / len * t, ny = dx / len * t;
                quads.push([p[0] + nx, p[1] + ny, q[0] + nx, q[1] + ny, q[0] - nx, q[1] - ny, p[0] - nx, p[1] - ny]);
            }
            return quadsToGeometry(quads);
        }
        function getGizmoGeometry(shape) {
            if (!gizmoGeometries[shape]) {
                gizmoGeometries[shape] =
                    shape === 'triangle' ? buildTriangleOutlineGeometry() :
                    shape === 'x' ? buildXGeometry() :
                    buildSquareOutlineGeometry();
            }
            return gizmoGeometries[shape];
        }
        function getGizmoWorldSize() {
            const visibleHeight = Math.abs(camera.top - camera.bottom) / Math.max(camera.zoom || 1, 0.0001);
            return visibleHeight * GIZMO_SCREEN_FRACTION;
        }
        // Editor mapping: EDGE -> x, MID -> triangle, END (and others) -> square.
        function snapTypeToGizmoShape(snapType) {
            if (snapType === 'EDGE' || snapType === 'INT') return 'x';
            if (snapType === 'MID') return 'triangle';
            return 'square';
        }
        let snapMarker = null;
        function updateSnapMarker(snap) {
            if (!snap || !snap.snapped) {
                if (snapMarker) { snapMarker.parent?.remove(snapMarker); snapMarker.material?.dispose(); snapMarker = null; requestRender(); }
                return;
            }
            const shape = snapTypeToGizmoShape(snap.type);
            if (!snapMarker || snapMarker.userData.__shape !== shape) {
                if (snapMarker) { snapMarker.parent?.remove(snapMarker); snapMarker.material?.dispose(); }
                snapMarker = new THREE.Mesh(getGizmoGeometry(shape), new THREE.MeshBasicMaterial({
                    color: GIZMO_COLOR, depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide,
                }));
                snapMarker.userData.__shape = shape;
                snapMarker.renderOrder = 1000;
                ensureMeasureGroup().add(snapMarker);
            } else if (snapMarker.parent !== measureGroup) {
                ensureMeasureGroup().add(snapMarker);
            }
            snapMarker.position.set(snap.x, snap.y, 0.3);
            rescaleSnapMarker();
            requestRender();
        }
        function rescaleSnapMarker() {
            if (!snapMarker || !camera) return;
            const s = getGizmoWorldSize();
            snapMarker.scale.set(s, s, 1);
        }

        let toolMode = null; // null | 'measure' | 'roomdim'
        let measureFirstPoint = null;
        let measureSegCache = null;   // [{x1,y1,x2,y2}] for the current space
        let measureGroup = null;      // persistent overlay lines
        let measurePreview = null;
        let measurePreviewLabel = null;
        let measureHost = null;
        let measureSide = null;
        const measureGroups = new Map();
        const measureLabels = [];     // DOM label elements

        function selectMeasureView(event, host) {
            const rect = host.getBoundingClientRect();
            const side = singleFileMode ? ctxB : viewMode === 'sbs' ? (host === hostA ? ctxA : ctxB)
                : viewMode === 'swipe' ? ((event.clientX - rect.left) / rect.width < swipeSplit ? ctxA : ctxB) : null;
            if (measureHost !== host) {
                measureFirstPoint = null;
                clearMeasurePreview();
                if (snapMarker) { snapMarker.parent?.remove(snapMarker); snapMarker.material?.dispose(); snapMarker = null; }
                measureHost = host;
                measureGroup = null;
                setMeasureHint(tr('measureHintFirstPoint', 'Click first point'));
            }
            if (measureSide !== side || !measureSegCache) { measureSide = side; buildMeasureSegCache(); }
        }

        function clearMeasurePreview() {
            if (measurePreview) {
                measurePreview.parent?.remove(measurePreview);
                measurePreview.geometry?.dispose(); measurePreview.material?.dispose(); measurePreview = null;
            }
            if (measurePreviewLabel) {
                measurePreviewLabel.remove();
                const index = measureLabels.indexOf(measurePreviewLabel);
                if (index >= 0) measureLabels.splice(index, 1);
                measurePreviewLabel = null;
            }
        }

        function fmtDist(v) {
            const s = v.toFixed(settings.measurePrecision);
            return settings.unitLabel ? s + ' ' + settings.unitLabel : s;
        }
        function buildMeasureSegCache() {
            const segs = [];
            const sides = singleFileMode ? [ctxB] : measureSide ? [measureSide] : [ctxA, ctxB];
            for (const ctx of sides) {
                for (const e of (getSpaceEntities(ctx, currentSpace) || [])) {
                    if (layerVisibility[e.layer || '0'] === false) continue;
                    for (const s of alignedSegments(ctx, e)) segs.push(s);
                }
            }
            segs.points = [];
            segs.curves = [];
            for (const ctx of sides) {
                const offset = ctx === ctxB ? alignmentOffset() : { x: 0, y: 0 };
                const point = (p, type, layer) => {
                    if (p && layerVisibility[layer || '0'] !== false) segs.points.push({ x: p.x + offset.x, y: p.y + offset.y, type });
                };
                const roots = (getSpaceEntities(ctx, currentSpace) || []).filter(e => layerVisibility[e.layer || '0'] !== false);
                forEachRenderableEntity(ctx, e => {
                    if (layerVisibility[e.layer || '0'] === false) return;
                    if (e.type === 'POINT') point(e.__point || e.vertices?.[0], 'NOD', e.layer);
                    if (['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'].includes(e.type)) point(e.__textPoint, 'INS', e.layer);
                    if (!['CIRCLE', 'ARC', 'ELLIPSE'].includes(e.type)) return;
                    const c = e.__center;
                    if (!c) return;
                    let u, v;
                    if (e.type === 'ELLIPSE') {
                        u = e.__majorAxisEndPoint;
                        if (!u) return;
                        v = { x: -u.y * e.__axisRatio, y: u.x * e.__axisRatio };
                    } else {
                        const m = e.__curveMatrix || makeMatrix(), r = Number(e.radius ?? e.r);
                        u = { x: m.a * r, y: m.b * r }; v = { x: m.c * r, y: m.d * r };
                    }
                    const start = e.type === 'CIRCLE' ? 0 : angleToRadians(e.startAngle ?? e.startangle ?? e.parameterStart ?? 0);
                    const end = e.type === 'CIRCLE' ? Math.PI * 2 : angleToRadians(e.endAngle ?? e.endangle ?? e.parameterEnd ?? Math.PI * 2);
                    let sweep = end - start;
                    while (sweep <= 0) sweep += Math.PI * 2;
                    segs.curves.push({ x: c.x + offset.x, y: c.y + offset.y, u, v, start, sweep });
                }, roots, (p, layer) => point(p, 'INS', layer));
            }
            measureSegCache = segs;
        }
        function ensureMeasureGroup() {
            const target = viewMode === 'overlay' ? sceneOverlay : viewMode === 'swipe' ? sceneTop : measureHost === hostA ? sceneA : sceneB;
            measureGroup = measureGroups.get(target) || null;
            if (!measureGroup) {
                measureGroup = new THREE.Group();
                measureGroup.name = '__measure__';
                measureGroup.renderOrder = 998;
                measureGroups.set(target, measureGroup);
            }
            // swipe: full-width top layer, so both halves show the measurement
            if (measureGroup.parent !== target) { measureGroup.parent?.remove(measureGroup); target.add(measureGroup); }
            return measureGroup;
        }
        function measureColor() { return 0x2563eb; }
        function addMeasureLine(p1, p2) {
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute([p1.x, p1.y, 0.2, p2.x, p2.y, 0.2], 3));
            const line = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: measureColor(), depthTest: false }));
            line.renderOrder = 998;
            ensureMeasureGroup().add(line);
            return line;
        }
        function activeHost() { return usesMainHost() ? hostMain : (measureHost || hostB); }
        function worldToScreen(p, host) {
            const v = new THREE.Vector3(p.x, p.y, 0).project(camera);
            return { x: (v.x + 1) / 2 * host.clientWidth, y: (1 - v.y) / 2 * host.clientHeight };
        }
        function addMeasureLabel(text, wp) {
            const host = activeHost();
            const el = document.createElement('div');
            el.className = 'measure-label';
            el.textContent = text;
            host.appendChild(el);
            el.__wp = { x: wp.x, y: wp.y };
            el.__host = host;
            measureLabels.push(el);
            positionMeasureLabels();
            return el;
        }
        function positionMeasureLabels() {
            for (const el of measureLabels) {
                const host = el.__host || activeHost();
                const s = worldToScreen(el.__wp, host);
                el.style.left = s.x + 'px';
                el.style.top = s.y + 'px';
            }
        }
        function clearMeasurements() {
            measureFirstPoint = null;
            if (snapMarker) { snapMarker.parent?.remove(snapMarker); snapMarker.material?.dispose(); snapMarker = null; }
            clearMeasurePreview();
            for (const group of measureGroups.values()) {
                group.traverse(c => { c.geometry?.dispose(); c.material?.dispose(); });
                group.parent?.remove(group);
            }
            measureGroups.clear(); measureGroup = null; measureHost = null; measureSide = null; measureSegCache = null;
            for (const el of measureLabels) el.remove();
            measureLabels.length = 0;
            setMeasureHint(tr('measureHintFirstPoint', 'Click first point'));
            requestRender();
        }
        function setMeasureHint(msg) {
            if (toolMode === 'measure') setStatus(msg);
        }
        function setToolMode(mode) {
            stopAlignment();
            toolMode = toolMode === mode ? null : mode;
            clearMeasurements();
            document.getElementById('btn-measure').classList.toggle('active', toolMode === 'measure');
            document.getElementById('btn-roomdim').classList.toggle('active', toolMode === 'roomdim');
            measureToolbarHeight();
            for (const h of [hostMain, hostA, hostB]) h.classList.toggle('measure-active', !!toolMode);
            if (toolMode === 'measure') {
                buildMeasureSegCache();
                setMeasureHint(tr('measureHintFirstPoint', 'Click first point'));
            } else if (toolMode === 'roomdim') {
                buildMeasureSegCache();
                setStatus(tr('roomDimHint', 'Click inside a room'));
            }
        }
        function screenToWorld(ev, host) {
            const rect = host.getBoundingClientRect();
            const nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
            const ny = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
            const v = new THREE.Vector3(nx, ny, 0).unproject(camera);
            return { x: v.x, y: v.y };
        }
        function pxToWorld(px, host) {
            const rect = host.getBoundingClientRect();
            return (camera.right - camera.left) / camera.zoom / Math.max(rect.width, 1) * px;
        }
        function findSnap(p, host) {
            const tolerance = measureSegCache && settings.snapEnabled !== false ? pxToWorld(12, host) : 0;
            return window.DxfCompareSnap.find(p, measureSegCache, settings, tolerance, measureFirstPoint);
        }
        function snapPoint(p, host) { return findSnap(p, host); }
        function handleMeasureClick(ev, host) {
            selectMeasureView(ev, host);
            const p = snapPoint(screenToWorld(ev, host), host);
            if (!measureFirstPoint) {
                measureFirstPoint = p;
                setMeasureHint(tr('measureHintSecondPoint', 'Click second point'));
                return;
            }
            const a = measureFirstPoint, b = p;
            measureFirstPoint = null;
            clearMeasurePreview();
            addMeasureLine(a, b);
            addMeasureLabel(fmtDist(Math.hypot(b.x - a.x, b.y - a.y)), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
            setMeasureHint(tr('measureHintFirstPoint', 'Click first point'));
            requestRender();
        }
        function castRay(p, dx, dy) {
            // Nearest intersection of a ray from p with the segment cache.
            let best = Infinity;
            for (const s of measureSegCache) {
                const rX = dx, rY = dy;
                const sX = s.x2 - s.x1, sY = s.y2 - s.y1;
                const denom = rX * sY - rY * sX;
                if (Math.abs(denom) < 1e-12) continue;
                const t = ((s.x1 - p.x) * sY - (s.y1 - p.y) * sX) / denom;
                const u = ((s.x1 - p.x) * rY - (s.y1 - p.y) * rX) / denom;
                if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) best = t;
            }
            return best === Infinity ? null : best;
        }
        function handleRoomDimClick(ev, host) {
            selectMeasureView(ev, host);
            const p = screenToWorld(ev, host);
            const left = castRay(p, -1, 0), right = castRay(p, 1, 0);
            const down = castRay(p, 0, -1), up = castRay(p, 0, 1);
            if (left === null || right === null || down === null || up === null) {
                setStatus(tr('roomDimNotClosed', 'No closed room found here'));
                return;
            }
            const x1 = p.x - left, x2 = p.x + right;
            const y1 = p.y - down, y2 = p.y + up;
            addMeasureLine({ x: x1, y: p.y }, { x: x2, y: p.y });
            addMeasureLine({ x: p.x, y: y1 }, { x: p.x, y: y2 });
            addMeasureLabel(fmtDist(x2 - x1), { x: (x1 + x2) / 2, y: p.y });
            addMeasureLabel(fmtDist(y2 - y1), { x: p.x, y: (y1 + y2) / 2 });
            setStatus(tr('roomDimHint', 'Click inside a room'));
            requestRender();
        }
        function handleToolPointerMove(ev, host) {
            if (toolMode !== 'measure') return;
            selectMeasureView(ev, host);
            const snap = findSnap(screenToWorld(ev, host), host);
            updateSnapMarker(snap);
            const snapNames = { END: 'Endpoint', MID: 'Midpoint', EDGE: 'Edge', INT: 'Intersection', PERP: 'Perpendicular' };
            const prompt = measureFirstPoint ? tr('measureHintSecondPoint', 'Click second point') : tr('measureHintFirstPoint', 'Click first point');
            setMeasureHint(prompt + (snap.snapped ? ' · ' + snapNames[snap.type] : ''));
            if (!measureFirstPoint) return;
            const p = snap;
            if (!measurePreview) {
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.Float32BufferAttribute(6, 3));
                measurePreview = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: measureColor(), depthTest: false, transparent: true, opacity: 0.6 }));
                measurePreview.renderOrder = 999;
                ensureMeasureGroup().add(measurePreview);
            }
            const pos = measurePreview.geometry.getAttribute('position');
            pos.setXYZ(0, measureFirstPoint.x, measureFirstPoint.y, 0.2);
            pos.setXYZ(1, p.x, p.y, 0.2);
            pos.needsUpdate = true;
            const midpoint = { x: (measureFirstPoint.x + p.x) / 2, y: (measureFirstPoint.y + p.y) / 2 };
            const distance = fmtDist(Math.hypot(p.x - measureFirstPoint.x, p.y - measureFirstPoint.y));
            if (!measurePreviewLabel) measurePreviewLabel = addMeasureLabel(distance, midpoint);
            else { measurePreviewLabel.textContent = distance; measurePreviewLabel.__wp = midpoint; }
            positionMeasureLabels();
            requestRender();
        }
        function wireToolEvents(host) {
            host.addEventListener('click', ev => {
                if (!toolMode || ev.target.closest('.measure-label')) return;
                if (toolMode === 'measure') handleMeasureClick(ev, host);
                else handleRoomDimClick(ev, host);
            });
            host.addEventListener('pointermove', ev => handleToolPointerMove(ev, host));
        }

        document.getElementById('btn-roomdim').addEventListener('click', () => setToolMode('roomdim'));

        window.addEventListener('keydown', ev => {
            if (ev.key === 'F3') {
                ev.preventDefault();
                settings.snapEnabled = !settings.snapEnabled;
                saveSettings();
                if (!settings.snapEnabled) updateSnapMarker(null);
                if (!document.getElementById('settings-popup').classList.contains('closed')) renderSettings();
                return;
            }
            if (ev.key !== 'Escape') return;
            clearMeasurements();
            if (toolMode) setToolMode(toolMode); // exits the active tool
        });

        function syncAlignmentUi() {
            const available = !singleFileMode && !!compareResult && spaceResults[currentSpace]?.status === 'matched';
            for (const id of ['btn-align', 'btn-move-b', 'btn-reset-align'])
                document.getElementById(id).classList.toggle('hidden', singleFileMode);
            document.getElementById('btn-align').disabled = !available;
            document.getElementById('btn-move-b').disabled = !available;
            document.getElementById('btn-reset-align').disabled = !available || (!alignments.has(currentSpace) && !alignmentMode);
            for (const [id, active] of [['btn-align', alignmentMode === 'pick-b' || alignmentMode === 'pick-a'], ['btn-move-b', alignmentMode === 'drag']]) {
                const button = document.getElementById(id);
                button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
            }
            for (const host of [hostMain, hostA, hostB]) host.style.cursor = alignmentMode === 'drag' ? 'move' : alignmentMode ? 'crosshair' : '';
            const hint = document.getElementById('alignment-hint');
            hint.classList.toggle('hidden', !alignmentMode);
            hint.textContent = alignmentMode === 'pick-b' ? tr('alignPickB', 'Select a point on B.') :
                alignmentMode === 'pick-a' ? tr('alignPickA', 'Select the matching point on A.') : tr('alignDragHint', 'Drag B to align drawings.');
        }
        function stopAlignment() {
            if (!alignmentMode) { syncAlignmentUi(); return; }
            alignmentMode = null; alignmentAnchor = null; alignmentDrag = null;
            positionAlignedGroups();
            if (camera && groups) parentGroupsForMode();
            measureSegCache = null;
            if (camera) updateSnapMarker(null);
            syncAlignmentUi();
        }
        function alignmentSnapCache(side) {
            const ctx = side === 'a' ? ctxA : ctxB;
            measureSegCache = (getSpaceEntities(ctx, currentSpace) || [])
                .filter(e => layerVisibility[e.layer || '0'] !== false)
                .flatMap(e => alignedSegments(ctx, e));
            if (currentSpace !== 'model') {
                // Paper layouts also contain projected model geometry. Use the
                // displayed lines so viewport scales and clipping match picks.
                measureSegCache = [];
                const keys = side === 'a' ? ['unchangedA', 'deleted', 'modifiedA'] : ['unchangedB', 'added', 'modifiedB'];
                for (const key of keys) {
                    const group = groups?.[key];
                    if (!group) continue;
                    group.updateWorldMatrix(true, true);
                    group.traverse(child => {
                        if (!child.isLineSegments) return;
                        for (let parent = child; parent; parent = parent.parent) if (!parent.visible) return;
                        const positions = child.geometry?.getAttribute('position');
                        if (!positions) return;
                        for (let i = 0; i + 1 < positions.count; i += 2) {
                            const a = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(child.matrixWorld);
                            const b = new THREE.Vector3().fromBufferAttribute(positions, i + 1).applyMatrix4(child.matrixWorld);
                            measureSegCache.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
                        }
                    });
                }
            }
        }
        function startAlignment(mode) {
            if (singleFileMode || spaceResults[currentSpace]?.status !== 'matched') return;
            const cancel = alignmentMode === mode || (mode === 'pick-b' && alignmentMode === 'pick-a');
            stopAlignment();
            if (cancel) return;
            if (toolMode) setToolMode(toolMode);
            clearMeasurements();
            colorMode = 'files';
            syncDisplayControls();
            rebuildDiffScene();
            alignmentMode = mode;
            setRightOpen(false); setPapersOpen(false);
            setViewMode(mode === 'drag' ? 'overlay' : 'sbs');
            if (mode !== 'drag') alignmentSnapCache('b');
            syncAlignmentUi();
            requestAnimationFrame(() => { onResize(); zoomToFit(); });
        }
        function applyAlignment(offset, reset = false) {
            stopAlignment(); clearMeasurements();
            if (reset) alignments.delete(currentSpace); else alignments.set(currentSpace, offset);
            runCompare(); rebuildDiffScene(); refreshPanel();
            document.getElementById('mode-badge').textContent = compareResult?.mode === 'handle'
                ? tr('modeHandle', 'matched by handle') : tr('modeFingerprint', 'matched by geometry');
            setStatus(reset ? tr('alignmentReset', 'Original alignment restored.') : tr('alignmentApplied', 'Manual alignment applied.'));
            setViewMode('overlay');
            requestAnimationFrame(() => { onResize(); zoomToFit(); });
        }
        function wireAlignmentEvents(host) {
            host.addEventListener('pointerdown', ev => {
                if (!alignmentMode || ev.button !== 0) return;
                ev.preventDefault(); ev.stopPropagation();
                if (alignmentDrag) return;
                const p = screenToWorld(ev, host);
                if (alignmentMode === 'drag') {
                    host.setPointerCapture(ev.pointerId);
                    alignmentDrag = { pointerId: ev.pointerId, start: p, offset: { ...alignmentOffset() }, current: { ...alignmentOffset() } };
                    return;
                }
                const side = alignmentMode === 'pick-b' ? 'b' : 'a';
                if (host !== (side === 'b' ? hostB : hostA)) return;
                const point = findSnap(p, host);
                if (alignmentMode === 'pick-b') {
                    alignmentAnchor = point; alignmentMode = 'pick-a';
                    updateSnapMarker({ ...point, snapped: true, type: 'END' });
                    alignmentSnapCache('a'); syncAlignmentUi();
                } else {
                    const offset = alignmentOffset();
                    applyAlignment({ x: offset.x + point.x - alignmentAnchor.x, y: offset.y + point.y - alignmentAnchor.y });
                }
            }, true);
            host.addEventListener('pointermove', ev => {
                if (!alignmentDrag || ev.pointerId !== alignmentDrag.pointerId) return;
                ev.preventDefault(); ev.stopPropagation();
                const p = screenToWorld(ev, host), drag = alignmentDrag;
                drag.current = { x: drag.offset.x + p.x - drag.start.x, y: drag.offset.y + p.y - drag.start.y };
                positionAlignedGroups(drag.current);
            }, true);
            const end = ev => {
                if (!alignmentDrag || ev.pointerId !== alignmentDrag.pointerId) return;
                ev.preventDefault(); ev.stopPropagation();
                const offset = alignmentDrag.current;
                if (ev.type === 'pointercancel') stopAlignment(); else applyAlignment(offset);
            };
            host.addEventListener('pointerup', end, true);
            host.addEventListener('pointercancel', end, true);
            host.addEventListener('wheel', ev => {
                if (alignmentDrag) { ev.preventDefault(); ev.stopPropagation(); }
            }, { capture: true, passive: false });
        }



        window.addEventListener('keydown', ev => { if (ev.key === 'Escape' && alignmentMode) stopAlignment(); });

        // ==================================================================
        //  File selection UI
        // ==================================================================
        const fileState = { a: null, b: null };

        function updateOpenButton() { sessionUi.updateOpenButton(); }

        const sessionUi = window.DxfCompareUI.createSessionUI(document, window, {
            getFiles: () => fileState,
            selectFile: (slot, file) => { fileState[slot] = file; },
            tr, onResize, requestRender, renderLayerList, toggleCategory, changeTolerance,
            actions: {
                'btn-open': openDrawings,
                'btn-theme': toggleTheme,
                'btn-display': toggleDisplay,
                'btn-view-overlay': () => setViewMode('overlay'),
                'btn-view-sbs': () => setViewMode('sbs'),
                'btn-view-swipe': () => setViewMode('swipe'),
                'btn-fit': zoomToFit,
                'btn-align': () => startAlignment('pick-b'),
                'btn-move-b': () => startAlignment('drag'),
                'btn-reset-align': () => applyAlignment({ x: 0, y: 0 }, true),
                'btn-measure': () => setToolMode('measure'),
            },
        });

        const loader = document.getElementById('loader');
        const loaderMsg = document.getElementById('loader-msg');
        const importCancel = document.getElementById('compare-import-cancel');
        const importClient = new window.DxfImportClient(new URL('../js/dxf/dxf-import-worker.js?v=compare-import-1', document.baseURI));
        const pairLoader = window.DxfCompareImport.create(importClient, window.DxfCompareContext);
        function cancelImport() {
            if (importCancel.classList.contains('hidden')) return;
            pairLoader.cancel();
            importCancel.classList.add('hidden'); loader.classList.add('hidden');
            setStatus('Import cancelled. The open comparison is unchanged.');
        }
        importCancel.addEventListener('click', cancelImport);
        window.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !importCancel.classList.contains('hidden')) { event.preventDefault(); cancelImport(); }
        });


        async function openDrawings() {
            const labels = { read: 'Reading drawing…', converter: 'Loading DWG converter…', convert: 'Converting DWG…', modules: 'Loading drawing readers…', recover: 'Preparing drawing…' };
            const job = pairLoader.begin(fileState, (file, event) => {
                loaderMsg.textContent = `${file.name} · ${labels[event.stage] || 'Preparing drawing…'}`;
            });
            const { isCurrent } = job;
            importCancel.classList.remove('hidden');
            importCancel.disabled = false;
            loader.classList.remove('hidden');
            loaderMsg.textContent = tr('loaderParsing', 'Parsing…');
            document.getElementById('error-box').classList.add('hidden');
            try {
                const next = await job.load();
                if (!isCurrent()) return;
                // Commit only when both imports succeed; cancellation keeps the old pair.
                importCancel.classList.add('hidden');
                stopAlignment(); alignments.clear();
                singleFileMode = next.singleFileMode;
                window.DxfCompareContext.replace(ctxA, next.a);
                window.DxfCompareContext.replace(ctxB, next.b);

                // One file = viewer mode: side-by-side and swipe have no second
                // drawing, so their buttons are hidden and we force overlay.
                ['btn-view-sbs', 'btn-view-swipe'].forEach(id => {
                    const b = document.getElementById(id);
                    if (b) b.classList.toggle('hidden', singleFileMode);
                });
                // Same for the comparison panel and the display filter:
                // both act on diff results, which viewer mode never has.
                ['btn-panel', 'btn-display', 'btn-blend'].forEach(id => {
                    const b = document.getElementById(id);
                    if (b) b.classList.toggle('hidden', singleFileMode);
                });
                document.getElementById('info-ents-a').textContent = singleFileMode ? '-' : ctxA.modelEntities.length.toLocaleString();
                document.getElementById('info-ents-b').textContent = ctxB.modelEntities.length.toLocaleString();
                document.getElementById('tab-compare').disabled = false;
                document.getElementById('btn-papers').disabled = false;
                switchTab('view-compare');
                requestAnimationFrame(() => { measureToolbarHeight(); applyThemeButton(); setRightTab('comparison'); setRightOpen(false); });

                initThree();
                onResize();
                // Viewer scenes only live in the overlay scene.
                if (singleFileMode && viewMode !== 'overlay') setViewMode('overlay');

                currentSpace = 'model';
                // hub compare link: start colors (before the first diff build)
                const startView = window.__cdeStartView || null;
                window.__cdeStartView = null;
                if (startView && !singleFileMode && startView.colors === 'original' && colorMode !== 'files') {
                    colorMode = 'files';
                    syncDisplayControls();
                }
                if (singleFileMode) {
                    compareResult = null;
                    spaceResults = {};
                    document.getElementById('compare-title').textContent = ctxB.fileName;
                    document.getElementById('mode-badge').textContent = tr('viewerOnly', 'viewer');
                    rebuildViewerScene();
                    setStatus(tr('viewerLoaded', 'Loaded {a} viewer mode (load a second file to compare).', { a: ctxB.fileName }));
                } else {
                    loaderMsg.textContent = tr('loaderComparing', 'Comparing…');
                    runCompare();
                    syncDisplayControls();
                    document.getElementById('compare-title').textContent = ctxA.fileName + '  →  ' + ctxB.fileName;
                    document.getElementById('mode-badge').textContent = compareResult?.mode === 'handle'
                        ? tr('modeHandle', 'matched by handle') : tr('modeFingerprint', 'matched by geometry');
                    rebuildDiffScene();
                    setStatus(tr('compareDone', 'Compared {a} vs {b}: {added} added, {deleted} deleted, {modified} modified.', {
                        a: ctxA.fileName, b: ctxB.fileName,
                        added: compareResult.counts.added, deleted: compareResult.counts.deleted, modified: compareResult.counts.modified,
                    }));
                }
                refreshPanel();
                // Mirrored objects the OCS pass could not rewrite (text, blocks,
                // hatches) are drawn unmirrored: say so once, after the summary.
                const mirrorLeft = {};
                for (const c of singleFileMode ? [ctxB] : [ctxA, ctxB]) {
                    for (const [k, n] of Object.entries(c.mirror?.unsupported || {})) mirrorLeft[k] = (mirrorLeft[k] || 0) + n;
                }
                const mirrorList = Object.entries(mirrorLeft).map(([k, n]) => `${n} ${k}`).join(', ');
                if (mirrorList) {
                    setStatus(document.getElementById('status-msg').textContent + '  ' +
                        tr('mirrorUnsupported', '{list} mirrored in the file may display unmirrored.', { list: mirrorList }));
                }
                // Start comparisons in Swipe, unless a hub link explicitly requests another view.
                const wantView = singleFileMode ? 'overlay' : (VIEW_MODES.includes(startView?.view) ? startView.view : 'swipe');
                if (wantView && VIEW_MODES.includes(wantView) && wantView !== viewMode) {
                    setViewMode(wantView);
                    // refit once the hosts have their size (after setViewMode's resize)
                    requestAnimationFrame(() => requestAnimationFrame(zoomToFit));
                }
                zoomToFit();
            } catch (err) {
                if (!isCurrent() || err.name === 'AbortError') return;
                console.error(err);
                const box = document.getElementById('error-box');
                document.getElementById('error-text').textContent = (err && err.message) || tr('errorParsingDxf', 'Error parsing DXF.');
                box.classList.remove('hidden');
                if (window.lucide) lucide.createIcons({ nameAttr: 'data-lucide' });
            } finally {
                if (isCurrent()) { loader.classList.add('hidden'); importCancel.classList.add('hidden'); }
            }
        }

        // ==================================================================
        //  Toolbar wiring
        // ==================================================================
        // ---- Sidebar (viewer pattern: collapsible rail + tab switching) ----
        function switchTab(targetId) { sessionUi.switchTab(targetId); }

        const VIEW_MODES = ['overlay', 'sbs', 'swipe'];
        function setViewMode(mode) {
            if (alignmentMode && ((alignmentMode === 'drag' && mode !== 'overlay') || (alignmentMode !== 'drag' && mode !== 'sbs'))) stopAlignment();
            viewMode = mode;
            clearMeasurements();
            const main = mode !== 'sbs'; // overlay + swipe render in host-main
            document.getElementById('btn-view-overlay').classList.toggle('active', mode === 'overlay');
            document.getElementById('btn-view-sbs').classList.toggle('active', mode === 'sbs');
            document.getElementById('btn-view-swipe').classList.toggle('active', mode === 'swipe');
            document.getElementById('canvas-wrap').classList.toggle('swipe', mode === 'swipe');
            hostMain.classList.toggle('hidden', !main);
            hostA.classList.toggle('hidden', main);
            hostB.classList.toggle('hidden', main);
            controlsMain.enabled = main;
            controlsA.enabled = !main;
            controlsB.enabled = !main;
            syncControlsToCamera();
            parentGroupsForMode();
            // Resize after layout settles.
            requestAnimationFrame(() => { onResize(); requestRender(); });
        }





        // ---- Swipe divider: fraction of the canvas width; drag = redraw only ----
        function setSplit(f) {
            swipeSplit = Math.min(Math.max(f, 0), 1);
            document.getElementById('canvas-wrap').style.setProperty('--split', (swipeSplit * 100) + '%');
            requestRender();
        }
        (function wireSwipe() {
            const bar = document.getElementById('swipe-bar');
            let drag = false;
            bar.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                drag = true;
                bar.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            bar.addEventListener('pointermove', (e) => {
                if (!drag) return;
                const r = hostMain.getBoundingClientRect();
                if (r.width > 0) setSplit((e.clientX - r.left) / r.width);
            });
            const end = () => { drag = false; };
            bar.addEventListener('pointerup', end);
            bar.addEventListener('pointercancel', end);
            bar.addEventListener('dblclick', () => setSplit(0.5));
            // wheel over the divider still zooms the drawing
            bar.addEventListener('wheel', (e) => {
                e.preventDefault();
                if (rMain) rMain.domElement.dispatchEvent(new WheelEvent('wheel', e));
            }, { passive: false });
        })();
        setSplit(0.5);

        function setPapersOpen(...args) { return compareUi.setPapersOpen(...args); }
        function setRightOpen(...args) { return compareUi.setRightOpen(...args); }
        function setRightTab(...args) { return compareUi.setRightTab(...args); }
        compareUi.bindControls();

        // ---- Dark mode ----
        function applyThemeButton(...args) { return compareUi.applyThemeButton(...args); }
        function toggleTheme() {
            if (currentSpace !== 'model') return;
            settings.darkMode = !settings.darkMode;
            saveSettings();
            applyThemeButton();
            if (singleFileMode) rebuildViewerScene(); else if (compareResult || spaceResults[currentSpace]) rebuildDiffScene();
            requestRender();
        }

        // ---- Settings popup ----
        function renderSettings(...args) { return compareUi.renderSettings(...args); }
        function syncDisplayControls() {
            const files = colorMode === 'files';
            document.getElementById('btn-display').classList.toggle('active', !files);
            document.getElementById('btn-blend').classList.toggle('active', files);
            document.getElementById('btn-blend').setAttribute('aria-pressed', String(files));
            document.getElementById('btn-display').setAttribute('aria-pressed', String(!files));
            document.getElementById('display-mode').value = colorMode;
            document.getElementById('file-display-controls').classList.toggle('hidden', !files);
            document.getElementById('change-display-controls').classList.toggle('hidden', files);
            for (const [side, ctx] of [['a', ctxA], ['b', ctxB]]) document.getElementById('file-label-' + side).textContent = ctx.fileName || ('Version ' + side.toUpperCase());
        }
        function setDisplayMode(mode) {
            stopAlignment(); colorMode = mode;
            syncDisplayControls();
            if (!singleFileMode && spaceResults[currentSpace]) rebuildDiffScene();
        }
        function toggleDisplay() { setDisplayMode('changes'); }
        document.getElementById('btn-blend').addEventListener('click', () => setDisplayMode('files'));
        document.getElementById('display-mode').addEventListener('change', e => setDisplayMode(e.target.value));
        for (const side of ['a', 'b']) {
            document.getElementById('file-color-' + side).addEventListener('input', e => { fileDisplay[side] = e.target.value; rebuildDiffScene(); });
            document.getElementById('file-visible-' + side).addEventListener('change', e => { fileDisplay[side === 'a' ? 'showA' : 'showB'] = e.target.checked; applyCategoryVisibility(); });
        }
        document.getElementById('file-balance').addEventListener('input', e => { fileDisplay.balance = Number(e.target.value); rebuildDiffScene(); });
        function navigateChange(step) {
            const rows = document.querySelectorAll('#result-list .result-row');
            if (!rows.length) return;
            changeIndex = (changeIndex + step + rows.length) % rows.length;
            rows[changeIndex].click(); rows[changeIndex].scrollIntoView({ block: 'nearest' });
        }
        document.getElementById('change-prev').addEventListener('click', () => navigateChange(-1));
        document.getElementById('change-next').addEventListener('click', () => navigateChange(1));

        function toggleCategory(cat) {
            categoryVisibility[cat] = !categoryVisibility[cat];
            applyCategoryVisibility();
            refreshPanel();
            return categoryVisibility[cat];
        }

        // Tolerance slider (log scale 1e-6 … 1)
        let tolDebounce = null;
        function changeTolerance(value) {
            tolerance = Math.pow(10, Number(value));
            if (singleFileMode || !ctxA.dxf) return;
            clearTimeout(tolDebounce);
            tolDebounce = setTimeout(() => {
                loader.classList.remove('hidden');
                loaderMsg.textContent = tr('loaderComparing', 'Comparing…');
                setTimeout(() => {
                    try {
                        runCompare();
                    syncDisplayControls();
                        document.getElementById('mode-badge').textContent = compareResult?.mode === 'handle'
                            ? tr('modeHandle', 'matched by handle') : tr('modeFingerprint', 'matched by geometry');
                        rebuildDiffScene();
                        refreshPanel();
                    } finally { loader.classList.add('hidden'); }
                }, 30);
            }, 250);
        }

        // Layer filter


        // Console triage for real files: window.__cmpDebug
        Object.defineProperty(window, '__cmpDebug', {
            get() {
                const side = (ctx) => ({
                    file: ctx.fileName,
                    layouts: ctx.layouts,
                    viewports: ctx.viewports?.map(v => ({
                        handle: v.handle, block: v.blockName, fromEntities: v.fromEntities,
                        cx: v.cx, cy: v.cy, w: v.width, h: v.height,
                        viewH: v.viewHeight, status: v.status, viewId: v.viewId,
                    })),
                    modelCount: ctx.modelEntities?.length,
                    paperActiveCount: ctx.paperActive?.length,
                });
                return {
                    currentSpace, viewMode, colorMode, swipeSplit,
                    A: side(ctxA), B: side(ctxB),
                    spaces: Object.fromEntries(Object.entries(spaceResults).map(([k, v]) =>
                        [k, { status: v.status, name: v.name, counts: v.result?.counts }])),
                };
            }
        });

        /* ==================== CDE project handoff ====================
         * ?project=<guid>&open=<relPath>. The hub hands over a .dxf/.dwg
         * inside the linked project folder. READ-ONLY: the file lands in
         * slot A and the normal open pipeline runs (viewer mode). Slot B
         * stays manual, so compare still works. No save-back, so the
         * Autosave/write-back machinery of the xlsx apps is NOT ported.
         * Permission lapsed (new window, browser restart): one banner,
         * one click, requestAccess needs the gesture.
         * Start view: &view=overlay|sbs|swipe (default: swipe), &colors=original. */
        (function cdeAutoOpen() {
            let params = null;
            try {
                const q = new URLSearchParams(window.location.search);
                const guid = q.get('project'), open = q.get('open');
                if (guid && open) params = {
                    guid: guid, open: open,
                    va: q.get('va') || '', la: q.get('la') || '',
                    vb: q.get('vb') || '', lb: q.get('lb') || ''
                };
                // start view for hub links (read by the btn-open handler);
                // swipe is the hub default, a &view= link still wins
                if (params) {
                    const view = q.get('view'), colors = q.get('colors');
                    window.__cdeStartView = {
                        view: ['overlay', 'sbs', 'swipe'].includes(view) ? view : 'swipe',
                        colors: colors,
                    };
                }
            } catch (e) { /* no params: normal standalone page */ }
            if (!params) return;

            const cde = window.liteAECO && window.liteAECO.cde;
            if (!cde) {
                cdeFail(tr('cdeMissing', 'Project sync is not available. Update js/liteaeco-cde.js and reload.'));
                return;
            }

            function cdeFail(msg) {
                const box = document.getElementById('error-box');
                document.getElementById('error-text').textContent = msg;
                box.classList.remove('hidden');
                if (window.lucide) lucide.createIcons({ nameAttr: 'data-lucide' });
            }

            async function readAsFile(handle, relPath) {
                const parts = String(relPath).split('/').filter(Boolean);
                const fname = parts.pop();
                let dir = handle;
                for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: false });
                const fh = await dir.getFileHandle(fname, { create: false });
                return fh.getFile();   // real File: name + lastModified come free
            }

            async function loadIntoSlotA(info) {
                let f;
                try { f = await readAsFile(info.handle, params.open); }
                catch (err) {
                    console.error('CDE FILE READ ERROR:', err);
                    cdeFail(tr('cdeFileMissing', 'The drawing was not found in the project folder. It may have been moved or renamed - open the Projects page and rescan.'));
                    return;
                }
                // Compare mode (&va=/&vb= paths, older -> A, newer -> B).
                // Read-only; archive names become "<name> (vN)".
                const setName = (id, file) => {
                    const el = document.getElementById(id);
                    el.textContent = file.name;
                    el.classList.remove('text-slate-500');
                    el.classList.add('text-blue-600');
                };
                let fa = null, fb = null;
                if (params.va && params.vb) {
                    const m = /^(.*?)(\.[^.]+)$/.exec(f.name) || [f.name, f.name, ''];
                    const named = (raw, lbl) => new File([raw], m[1] + ' (' + lbl + ')' + m[2], { lastModified: raw.lastModified });
                    try {
                        const ra = params.va === params.open ? f : await readAsFile(info.handle, params.va);
                        const rb = params.vb === params.open ? f : await readAsFile(info.handle, params.vb);
                        fa = named(ra, params.la || 'A');
                        fb = named(rb, params.lb || 'B');
                    } catch (err) {
                        console.error('CDE ARCHIVE READ ERROR:', err);
                        window.__cdeStartView = null;
                        cdeFail(tr('cdeArchiveMissing', 'A selected version is no longer in the archive. Showing the current drawing only.'));
                    }
                }
                if (fa && fb) {
                    fileState.a = fa; setName('file-a-name', fa);
                    fileState.b = fb; setName('file-b-name', fb);
                } else {
                    fileState.a = f; setName('file-a-name', f);
                }
                updateOpenButton();
                // Reuse the WHOLE open pipeline (loader, DWG convert, parse,
                // viewer scene) instead of duplicating it here.
                document.getElementById('btn-open').click();
            }

            function showRegrantBanner() {
                const host = document.getElementById('view-upload');
                if (!host) return;
                const banner = document.createElement('div');
                banner.id = 'cde-regrant';
                banner.className = 'mx-auto w-full max-w-5xl mt-4 px-4';
                banner.innerHTML =
                    '<div class="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded p-3">' +
                    '<i data-lucide="folder-lock" class="w-5 h-5 text-blue-600 shrink-0"></i>' +
                    '<span class="text-sm text-blue-900 flex-1">' + tr('cdeRegrantMsg', 'The browser needs one click to re-open the project folder.') + '</span>' +
                    '<button id="cde-regrant-btn" class="shrink-0 py-1.5 px-4 text-[13px] font-bold text-white bg-slate-900 hover:bg-slate-800 rounded transition">' + tr('cdeRegrantBtn', 'Open drawing') + '</button>' +
                    '</div>';
                host.insertBefore(banner, host.firstChild);
                if (window.lucide) lucide.createIcons({ nameAttr: 'data-lucide' });
                document.getElementById('cde-regrant-btn').addEventListener('click', async () => {
                    try {
                        const info = await cde.requestAccess(params.guid);
                        if (info && info.permission === 'granted') {
                            banner.remove();
                            loadIntoSlotA(info);
                        } else {
                            cdeFail(tr('cdeNoAccess', 'Folder access was not granted.'));
                        }
                    } catch (err) {
                        console.error('CDE REQUEST ACCESS ERROR:', err);
                        cdeFail(tr('cdeNoAccess', 'Folder access was not granted.'));
                    }
                });
            }

            (async () => {
                let info = null;
                try { info = await cde.openProject(params.guid); } catch (e) { }
                if (!info) {
                    cdeFail(tr('cdeNoHandle', 'This project has no linked folder on this machine. Open the Projects page and link it first.'));
                    return;
                }
                if (info.permission === 'granted') loadIntoSlotA(info);
                else showRegrantBanner();
            })();
        })();
    
