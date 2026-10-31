/**
 * dxf_dim.js — linear/aligned DIMENSION support: geometry, synthesis, emission.
 *
 * Style: architectural 45° ticks, text above the dimension line.
 * All lengths derive from the text height h:
 *   tick length = 0.5h · extension-line gap = 0.25h · overshoot = 0.5h · text gap = 0.3h
 * Those are defaults for an unset value; an explicit 0 is honoured as 0.
 *
 * window.DxfDim + Node exports.
 */
(function (root) {
    'use strict';

    const DEG = Math.PI / 180;

    /**
     * Core geometry for a rotated/aligned dimension.
     *  p1, p2   — measured points (def points 13/14)
     *  dimPoint — a point the dimension line passes through (code 10 / user's 3rd click)
     *  angleDeg — dimension direction for rotated dims (0=H, 90=V); ignored when aligned
     *  aligned  — dimension line parallel to p1→p2
     *  h        — text height
     *  textOverride — optional text (code 1); '' or '<>' means the measured value
     * Returns { segments, text: {value,x,y,rotationDeg,height}, measurement, anchor }
     */
    function buildDimGeometry(p1, p2, dimPoint, angleDeg, aligned, h, textOverride, decimals, tickLength, textGapLen, flip, rot180) {
        let dir;
        if (aligned) {
            const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
            dir = { x: (p2.x - p1.x) / len, y: (p2.y - p1.y) / len };
        } else {
            const a = (Number(angleDeg) || 0) * DEG;
            dir = { x: Math.cos(a), y: Math.sin(a) };
        }
        const n = { x: -dir.y, y: dir.x };
        const c = dimPoint.x * n.x + dimPoint.y * n.y;   // dim line: dot(p, n) = c
        const foot = (p) => {
            const d = c - (p.x * n.x + p.y * n.y);
            return { x: p.x + n.x * d, y: p.y + n.y * d, off: d };
        };
        const e1 = foot(p1), e2 = foot(p2);
        const measurement = Math.abs((p2.x - p1.x) * dir.x + (p2.y - p1.y) * dir.y);

        const gap = 0.25 * h, beyond = 0.5 * h;
        // 0 is a legitimate value for both: it means "no gap" / "no ticks".
        // Only a missing or negative value falls back to the default.
        const textGap = Number.isFinite(textGapLen) && textGapLen >= 0 ? textGapLen : 0.3 * h;
        const tick = Number.isFinite(tickLength) && tickLength >= 0 ? tickLength : 0.5 * h;
        const segments = [];
        const seg = (a, b) => segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });

        // Extension lines: from just off the measured point to just past the dim line.
        for (const [p, e] of [[p1, e1], [p2, e2]]) {
            const s = Math.sign(e.off) || 1;
            seg({ x: p.x + n.x * gap * s, y: p.y + n.y * gap * s },
                { x: e.x + n.x * beyond * s, y: e.y + n.y * beyond * s });
        }
        // Dimension line.
        seg(e1, e2);
        // Architectural ticks: 45° slashes across the dim line at each end.
        // A tick length of 0 draws none rather than a degenerate segment.
        if (tick > 0) {
            const tdir = { x: (dir.x - n.x) * Math.SQRT1_2, y: (dir.y - n.y) * Math.SQRT1_2 };
            for (const e of [e1, e2]) {
                seg({ x: e.x - tdir.x * tick, y: e.y - tdir.y * tick },
                    { x: e.x + tdir.x * tick, y: e.y + tdir.y * tick });
            }
        }

        // Text: centered on the dimension line, readable orientation, and placed on
        // the OUTWARD side — the side the user pulled the dimension line toward,
        // away from the measured geometry. flip=true toggles to the other side.
        let rot = Math.atan2(dir.y, dir.x) / DEG;
        let up = { x: n.x, y: n.y };
        if (rot > 90 + 1e-9 || rot <= -90 + 1e-9) { rot += 180; up = { x: -n.x, y: -n.y }; }
        rot = ((rot % 360) + 360) % 360;
        // e.off is the signed distance from a measured point to the line along n;
        // its sign says which side of the geometry the dimension line sits on.
        const outwardSign = Math.sign(e1.off + e2.off) || 1;
        const autoAway = (up.x * n.x + up.y * n.y) * outwardSign < 0;
        if (autoAway !== !!flip) up = { x: -up.x, y: -up.y };
        if (rot180) { rot = (rot + 180) % 360; }
        const mid = { x: (e1.x + e2.x) / 2, y: (e1.y + e2.y) / 2 };
        const dp = Number.isFinite(decimals) ? decimals : 2;
        const value = (textOverride && textOverride !== '<>')
            ? textOverride
            : String(Number(measurement.toFixed(dp)));
        const text = {
            value,
            x: mid.x + up.x * textGap,
            y: mid.y + up.y * textGap,
            rotationDeg: rot,
            height: h,
            // Anchor edge: the text edge facing the dimension line. Which physical
            // side we ended up on = whether `up` still equals the readable normal;
            // a 180° text rotation swaps the anchored edge again.
            valign: (((autoAway !== !!flip)) !== !!rot180) ? 3 : 1,
        };
        return { segments, text, measurement, anchor: { x: e2.x, y: e2.y } };
    }

    /**
     * From the interactive tool: p1, p2 measured; p3 places the dimension line.
     * Linear mode picks H/V from where p3 sits relative to the measured points;
     * aligned mode measures the true distance.
     */
    function computeDimFromClicks(p1, p2, p3, opts) {
        const o = opts || {};
        const h = o.textHeight > 0 ? o.textHeight : 1;
        if (Number.isFinite(o.forceAngleDeg)) {
            // Chained dimension: direction locked to the chain's initial vector.
            const g = buildDimGeometry(p1, p2, p3, o.forceAngleDeg, false, h, null, o.decimals, o.tickLength, o.textGap, o.flipText, o.rot180Text);
            return { ...g, dimensionType: 32, angle: o.forceAngleDeg, aligned: false, p1, p2 };
        }
        if (o.aligned) {
            const g = buildDimGeometry(p1, p2, p3, 0, true, h, null, o.decimals, o.tickLength, o.textGap, o.flipText, o.rot180Text);
            return { ...g, dimensionType: 33, angle: 0, aligned: true, p1, p2 };
        }
        // Outside distance from the points' bbox decides the orientation.
        const minX = Math.min(p1.x, p2.x), maxX = Math.max(p1.x, p2.x);
        const minY = Math.min(p1.y, p2.y), maxY = Math.max(p1.y, p2.y);
        const dxOut = p3.x < minX ? p3.x - minX : (p3.x > maxX ? p3.x - maxX : 0);
        const dyOut = p3.y < minY ? p3.y - minY : (p3.y > maxY ? p3.y - maxY : 0);
        const horizontal = Math.abs(dyOut) >= Math.abs(dxOut);
        const angle = horizontal ? 0 : 90;
        const g = buildDimGeometry(p1, p2, p3, angle, false, h, null, o.decimals, o.tickLength, o.textGap, o.flipText, o.rot180Text);
        return { ...g, dimensionType: 32, angle, aligned: false, p1, p2 };
    }

    /** Code-1 text override: '' / '<>' keep the measured value; any other
     *  string replaces it, with '<>' inside expanding to the measurement. */
    function resolveDimTextOverride(override, measuredStr) {
        if (!override || override === '<>') return measuredStr;
        return String(override).replace(/<>/g, measuredStr);
    }

    /** Tier-2 fallback: synthesize graphics from a parsed DIMENSION entity. */
    function synthesizeFromEntity(entity, textHeight, decimals, tickLength, textGap, arrowSize) {
        const flip = !!entity.__dimTextFlip;
        const rot180 = !!entity.__dimTextRot180;
        const baseType = (Number(entity.dimensionType) || 0) & 15;
        // RADIAL (4) / DIAMETRIC (3): rebuild from codes 10 + 15.
        //   radial:    10 = center,               15 = point on the circle
        //   diametric: 10 = point on the circle,  15 = the opposite point
        if (baseType === 3 || baseType === 4) {
            const p10 = entity.anchorPoint;
            const p15 = entity.diameterOrRadiusPoint;
            if (!p10 || !p15) return null;
            const diameter = baseType === 3;
            const center = diameter
                ? { x: (p10.x + p15.x) / 2, y: (p10.y + p15.y) / 2 }
                : { x: p10.x, y: p10.y };
            const edge = diameter ? { x: p10.x, y: p10.y } : { x: p15.x, y: p15.y };
            const radius = Math.hypot(edge.x - center.x, edge.y - center.y);
            if (!(radius > 0)) return null;
            const ang = Math.atan2(edge.y - center.y, edge.x - center.x);
            const h2 = textHeight > 0 ? textHeight : 1;
            const g = buildRadialDimGeometry(center, radius, ang, diameter, h2, decimals, tickLength, textGap, arrowSize);
            if (!g) return null;
            g.dimensionType = entity.dimensionType;
            if (entity.text && entity.text !== '<>') {
                g.text.value = resolveDimTextOverride(entity.text, g.text.value);
                g.textOverride = entity.text;
            }
            return g;
        }
        if (baseType === 6) {
            const feature = entity.linearOrAngularPoint1;
            const leaderEnd = entity.linearOrAngularPoint2;
            if (!feature || !leaderEnd) return null;
            const xDatum = ((Number(entity.dimensionType) || 0) & 64) !== 0;
            const h6 = textHeight > 0 ? textHeight : 1;
            const g = buildOrdinateDimGeometry(feature, leaderEnd, xDatum, h6, decimals, textGap);
            if (!g) return null;
            g.dimensionType = entity.dimensionType;
            if (entity.text && entity.text !== '<>') {
                g.text.value = resolveDimTextOverride(entity.text, g.text.value);
                g.textOverride = entity.text;
            }
            return g;
        }
        const p1 = entity.linearOrAngularPoint1, p2 = entity.linearOrAngularPoint2;
        const anchor = entity.anchorPoint;
        if (!p1 || !p2 || !anchor) return null;
        const aligned = baseType === 1;
        const h = textHeight > 0 ? textHeight : 1;
        const g = buildDimGeometry(
            { x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }, { x: anchor.x, y: anchor.y },
            entity.angle || 0, aligned, h, entity.text || null, decimals, tickLength, textGap, flip, rot180
        );
        g.dimensionType = entity.dimensionType;
        g.angle = entity.angle || 0;
        g.aligned = aligned;
        g.p1 = { x: p1.x, y: p1.y };
        g.p2 = { x: p2.x, y: p2.y };
        if (Number.isFinite(entity.actualMeasurement) && (!entity.text || entity.text === '<>')) {
            const dp = Number.isFinite(decimals) ? decimals : 2;
            g.text.value = String(Number(entity.actualMeasurement.toFixed(dp)));
        }
        return g;
    }

    /**
     * One arrowhead as a single closed polyline (tip + two base corners).
     * (dirX, dirY) is the unit direction FROM the tip toward the arrow body.
     */
    function arrowheadPolyline(tip, dirX, dirY, len, halfWidth) {
        const bx = tip.x + dirX * len, by = tip.y + dirY * len;
        const nx = -dirY, ny = dirX;
        return {
            closed: true,
            vertices: [
                { x: tip.x, y: tip.y },
                { x: bx + nx * halfWidth, y: by + ny * halfWidth },
                { x: bx - nx * halfWidth, y: by - ny * halfWidth },
            ],
        };
    }

    /**
     * Geometry for a RADIAL or DIAMETER dimension of a circle/arc.
     *  center, radius — the measured circle
     *  angleRad       — direction of the dimension line (toward the text pick)
     *  diameter       — true for a ⌀ dimension across the full circle
     *  h              — text height; ticks/gaps derive like the linear builder
     * Returns { segments, text, measurement, radial, diameter, center, edge,
     *           opposite } — edge/opposite are the circle points the DXF
     *           serializer writes into codes 10/15.
     */
    function buildRadialDimGeometry(center, radius, angleRad, diameter, h, decimals, tickLength, textGap, arrowSize) {
        if (!(radius > 0)) return null;
        const dir = { x: Math.cos(angleRad), y: Math.sin(angleRad) };
        const n = { x: -dir.y, y: dir.x };
        const edge = { x: center.x + dir.x * radius, y: center.y + dir.y * radius };
        const start = diameter
            ? { x: center.x - dir.x * radius, y: center.y - dir.y * radius }
            : { x: center.x, y: center.y };

        const tGap = Number.isFinite(textGap) && textGap >= 0 ? textGap : 0.3 * h;
        const aLen = arrowSize > 0 ? arrowSize : h;
        const aHalf = aLen / 3;
        const segments = [{ x1: start.x, y1: start.y, x2: edge.x, y2: edge.y }];
        const polylines = [];
        // Arrow tip ON the arc, pointing at the curve (body runs back inward).
        polylines.push(arrowheadPolyline(edge, -dir.x, -dir.y, aLen, aHalf));
        if (diameter) {
            // Second arrow on the opposite side of the circle.
            polylines.push(arrowheadPolyline(start, dir.x, dir.y, aLen, aHalf));
        } else {
            // Radius: cross mark at the circle center.
            const cm = 0.5 * h;
            segments.push({ x1: center.x - cm, y1: center.y, x2: center.x + cm, y2: center.y });
            segments.push({ x1: center.x, y1: center.y - cm, x2: center.x, y2: center.y + cm });
        }

        const measurement = diameter ? 2 * radius : radius;
        const dp = Number.isFinite(decimals) ? decimals : 2;
        const value = (diameter ? '\u2300' : 'R') + String(Number(measurement.toFixed(dp)));

        // Readable text along the dimension line, offset to one side — the same
        // flip rule the linear builder uses.
        let rot = Math.atan2(dir.y, dir.x) * 180 / Math.PI;
        let up = { x: n.x, y: n.y };
        if (rot > 90 + 1e-9 || rot <= -90 + 1e-9) { rot += 180; up = { x: -n.x, y: -n.y }; }
        rot = ((rot % 360) + 360) % 360;
        const mid = { x: (start.x + edge.x) / 2, y: (start.y + edge.y) / 2 };
        const text = {
            value,
            x: mid.x + up.x * tGap,
            y: mid.y + up.y * tGap,
            rotationDeg: rot,
            height: h,
            valign: 1,
        };
        return {
            segments, polylines, text, measurement,
            radial: true, diameter: !!diameter,
            center: { x: center.x, y: center.y },
            edge, opposite: start,
            anchor: { x: edge.x, y: edge.y },
        };
    }

    /**
     * Geometry for an ORDINATE dimension.
     *  feature   — the measured point (DXF code 13)
     *  leaderEnd — where the leader finishes and the text sits (code 14)
     *  xDatum    — true: measure the X coordinate (leader runs vertically);
     *              false: measure Y (leader runs horizontally)
     * Straight leader when feature and end are aligned on the datum axis,
     * otherwise the standard leg–diagonal–leg jog.
     */
    function buildOrdinateDimGeometry(feature, leaderEnd, xDatum, h, decimals, textGap) {
        if (!feature || !leaderEnd) return null;
        const f = { x: feature.x, y: feature.y };
        const e = { x: leaderEnd.x, y: leaderEnd.y };
        const gap = 0.35 * h;
        const tGap = Number.isFinite(textGap) && textGap >= 0 ? textGap : 0.3 * h;
        const segments = [];
        let textRot, up;

        if (xDatum) {
            const sign = e.y >= f.y ? 1 : -1;
            const runLen = Math.abs(e.y - f.y);
            if (runLen <= gap + 1e-9) return null;
            const p0 = { x: f.x, y: f.y + sign * gap };
            if (Math.abs(e.x - f.x) < 1e-9) {
                segments.push({ x1: p0.x, y1: p0.y, x2: e.x, y2: e.y });
            } else {
                const jog = Math.min(2 * h, runLen * 0.3);
                const p1 = { x: f.x, y: e.y - sign * 2 * jog };
                const p2 = { x: e.x, y: e.y - sign * jog };
                segments.push({ x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y });
                segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
                segments.push({ x1: p2.x, y1: p2.y, x2: e.x, y2: e.y });
            }
            // Text reads along the vertical leader.
            textRot = sign >= 0 ? 90 : 270;
            up = { x: 0, y: sign };
        } else {
            const sign = e.x >= f.x ? 1 : -1;
            const runLen = Math.abs(e.x - f.x);
            if (runLen <= gap + 1e-9) return null;
            const p0 = { x: f.x + sign * gap, y: f.y };
            if (Math.abs(e.y - f.y) < 1e-9) {
                segments.push({ x1: p0.x, y1: p0.y, x2: e.x, y2: e.y });
            } else {
                const jog = Math.min(2 * h, runLen * 0.3);
                const p1 = { x: e.x - sign * 2 * jog, y: f.y };
                const p2 = { x: e.x - sign * jog, y: e.y };
                segments.push({ x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y });
                segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
                segments.push({ x1: p2.x, y1: p2.y, x2: e.x, y2: e.y });
            }
            textRot = sign >= 0 ? 0 : 180;
            up = { x: sign, y: 0 };
        }

        // Readability flip (same rule as the other builders).
        let rot = textRot;
        if (rot > 90 + 1e-9 || rot <= -90 + 1e-9) rot = ((rot + 180) % 360);
        rot = ((rot % 360) + 360) % 360;

        const measurement = xDatum ? f.x : f.y;
        const dp = Number.isFinite(decimals) ? decimals : 2;
        const value = String(Number(measurement.toFixed(dp)));
        const text = {
            value,
            x: e.x + up.x * tGap * 2,
            y: e.y + up.y * tGap * 2,
            rotationDeg: rot,
            height: h,
            valign: 1,
            halign: 1,
        };
        return {
            segments, polylines: [], text, measurement,
            ordinate: true, xDatum: !!xDatum,
            // The generic (non-radial) regenerate/patch path uses these:
            anchor: { x: e.x, y: e.y },
            p1: { x: f.x, y: f.y },
            p2: { x: e.x, y: e.y },
        };
    }

    /** ORDINATE DIMENSION entity pairs (type 6, +64 for X-datum). */
    function emitOrdinateDimensionPairs(dim, handle, layer, blockName) {
        const n = (v) => String(Math.round(Number(v) * 1e9) / 1e9);
        return [
            '0', 'DIMENSION', '5', String(handle), '8', layer || '0',
            '100', 'AcDbEntity', '100', 'AcDbDimension',
            '2', blockName,
            '10', n(dim.anchor.x), '20', n(dim.anchor.y), '30', '0',
            '11', n(dim.text.x), '21', n(dim.text.y), '31', '0',
            '70', String(32 | 6 | (dim.xDatum ? 64 : 0)),
            '1', dim.textOverride ? String(dim.textOverride) : '',
            '71', '5',
            '42', n(dim.measurement),
            '100', 'AcDbOrdinateDimension',
            '13', n(dim.p1.x), '23', n(dim.p1.y), '33', '0',
            '14', n(dim.p2.x), '24', n(dim.p2.y), '34', '0',
        ];
    }

    /** RADIAL/DIAMETRIC DIMENSION entity pairs (types 4 / 3, block-ref flag set). */
    function emitRadialDimensionPairs(dim, handle, layer, blockName) {
        const n = (v) => String(Math.round(Number(v) * 1e9) / 1e9);
        const diameter = !!dim.diameter;
        // Diametric: 10 = first point on the circle, 15 = opposite point.
        // Radial:    10 = center,                    15 = point on the circle.
        const p10 = diameter ? dim.edge : dim.center;
        const p15 = diameter ? dim.opposite : dim.edge;
        return [
            '0', 'DIMENSION', '5', String(handle), '8', layer || '0',
            '100', 'AcDbEntity', '100', 'AcDbDimension',
            '2', blockName,
            '10', n(p10.x), '20', n(p10.y), '30', '0',
            '11', n(dim.text.x), '21', n(dim.text.y), '31', '0',
            '70', String(32 | (diameter ? 3 : 4)),
            '1', dim.textOverride ? String(dim.textOverride) : '',
            '71', '5',
            '42', n(dim.measurement),
            '100', diameter ? 'AcDbDiametricDimension' : 'AcDbRadialDimension',
            '15', n(p15.x), '25', n(p15.y), '35', '0',
            '40', '0',
        ];
    }

    /**
     * Drawable geometry for a LEADER entity: the vertex path as segments plus
     * ONE closed arrowhead polyline at the first vertex, pointing back along
     * the first segment. `h` sizes the arrow (defaults to the entity's text
     * height). Returns { segments, polylines } or null for < 2 vertices.
     */
    function leaderGeometry(vertices, h) {
        const vs = (vertices || []).filter(v => Number.isFinite(v?.x) && Number.isFinite(v?.y));
        if (vs.length < 2) return null;
        const size = h > 0 ? h : 2.5;
        const segments = [];
        for (let i = 0; i < vs.length - 1; i++) {
            segments.push({ x1: vs[i].x, y1: vs[i].y, x2: vs[i + 1].x, y2: vs[i + 1].y });
        }
        const dx = vs[1].x - vs[0].x, dy = vs[1].y - vs[0].y;
        const len = Math.hypot(dx, dy) || 1;
        const polylines = [arrowheadPolyline(vs[0], dx / len, dy / len, size, size / 3)];
        return { segments, polylines };
    }

    /**
     * Read LEADER entities straight from raw DXF text (dxf-parser skips them,
     * like HATCH). Returns parser-shaped objects the viewer can push into
     * currentDxf.entities: { type, handle, layer, colorIndex, trueColor,
     * lineType, textHeight, vertices, annotationHandle, inPaperSpace,
     * __rawKey } — __rawKey uses the same 'E:{index}' scheme as
     * assignRawEntityIndices, so raw-text patches on save find the block.
     */
    function parseRawDxfLeaders(rawText) {
        const out = [];
        if (!rawText) return out;
        const lines = String(rawText).replace(/\r\n/g, '\n').split('\n');
        let i = 0, section = null, entityIdx = 0;
        while (i < lines.length - 1) {
            const code = (lines[i] ?? '').trim();
            const value = (lines[i + 1] ?? '').trim();
            if (code === '0' && value.toUpperCase() === 'SECTION') {
                const c2 = (lines[i + 2] ?? '').trim();
                section = c2 === '2' ? (lines[i + 3] ?? '').trim().toUpperCase() : null;
                entityIdx = 0;
                i += 4; continue;
            }
            if (code === '0' && value.toUpperCase() === 'ENDSEC') { section = null; i += 2; continue; }
            if (section === 'ENTITIES' && code === '0') {
                const type = value.toUpperCase();
                let j = i + 2;
                const pairs = [];
                while (j < lines.length - 1) {
                    const c = (lines[j] ?? '').trim();
                    if (c === '0') break;
                    pairs.push([c, (lines[j + 1] ?? '').trim()]);
                    j += 2;
                }
                if (type === 'LEADER') {
                    const e = {
                        type: 'LEADER', handle: '', layer: '0',
                        colorIndex: undefined, trueColor: undefined, lineType: undefined,
                        textHeight: 0, vertices: [], annotationHandle: null,
                        inPaperSpace: false,
                    };
                    let cur = null;
                    for (const [c, v] of pairs) {
                        switch (c) {
                            case '5': e.handle = v; break;
                            case '8': e.layer = v; break;
                            case '6': e.lineType = v; break;
                            case '62': e.colorIndex = parseInt(v, 10); break;
                            case '420': e.trueColor = parseInt(v, 10); break;
                            case '67': e.inPaperSpace = parseInt(v, 10) === 1; break;
                            case '40': e.textHeight = parseFloat(v) || 0; break;
                            case '10': cur = { x: parseFloat(v), y: 0, z: 0 }; e.vertices.push(cur); break;
                            case '20': if (cur) cur.y = parseFloat(v); break;
                            case '30': if (cur) cur.z = parseFloat(v) || 0; break;
                            case '340': e.annotationHandle = v; break;
                        }
                    }
                    if (e.vertices.length >= 2) {
                        e.__rawKey = `E:${entityIdx}`;
                        out.push(e);
                    }
                }
                entityIdx++;
                i = j; continue;
            }
            i += 2;
        }
        return out;
    }

    /** DIMENSION entity pairs for the raw serializer. */
    function emitDimensionPairs(dim, handle, layer, blockName) {
        if (dim && dim.radial) return emitRadialDimensionPairs(dim, handle, layer, blockName);
        if (dim && dim.ordinate) return emitOrdinateDimensionPairs(dim, handle, layer, blockName);
        const n = (v) => String(Math.round(Number(v) * 1e9) / 1e9);
        const pairs = [
            '0', 'DIMENSION', '5', String(handle), '8', layer || '0',
            '100', 'AcDbEntity', '100', 'AcDbDimension',
            '2', blockName,
            '10', n(dim.anchor.x), '20', n(dim.anchor.y), '30', '0',
            '11', n(dim.text.x), '21', n(dim.text.y), '31', '0',
            '70', String(dim.dimensionType),
            '1', '',
            '71', '5',
            '42', n(dim.measurement),
            '100', 'AcDbAlignedDimension',
            '13', n(dim.p1.x), '23', n(dim.p1.y), '33', '0',
            '14', n(dim.p2.x), '24', n(dim.p2.y), '34', '0',
        ];
        if (!dim.aligned) {
            pairs.push('50', n(dim.angle || 0), '100', 'AcDbRotatedDimension');
        }
        return pairs;
    }

    const DxfDim = { buildDimGeometry, computeDimFromClicks, synthesizeFromEntity, emitDimensionPairs,
        buildRadialDimGeometry, emitRadialDimensionPairs,
        buildOrdinateDimGeometry, emitOrdinateDimensionPairs,
        leaderGeometry, parseRawDxfLeaders };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfDim;
    if (root) root.DxfDim = DxfDim;
})(typeof window !== 'undefined' ? window : null);
