/**
 * dxf-dim.js — linear/aligned DIMENSION support: geometry, synthesis, emission.
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
    function buildDimGeometry(p1, p2, dimPoint, angleDeg, aligned, h, textOverride, decimals, tickLength, textGapLen, flip, rot180, style, textPoint) {
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

        const scale = Number(style?.DIMSCALE) > 0 ? Number(style.DIMSCALE) : 1;
        const gap = Number.isFinite(style?.DIMEXO) ? style.DIMEXO * scale : 0.25 * h;
        const beyond = Number.isFinite(style?.DIMEXE) ? style.DIMEXE * scale : 0.5 * h;
        // 0 is a legitimate value for both: it means "no gap" / "no ticks".
        // Only a missing or negative value falls back to the default.
        const textGap = Number.isFinite(textGapLen) && textGapLen >= 0 ? textGapLen : 0.3 * h;
        const tick = Number.isFinite(style?.DIMTSZ) ? Math.max(0, style.DIMTSZ * scale / 2)
            : Number.isFinite(tickLength) && tickLength >= 0 ? tickLength : 0.5 * h;
        const dp = Number.isFinite(style?.DIMDEC) ? style.DIMDEC : Number.isFinite(decimals) ? decimals : 2;
        const value = resolveDimTextOverride(textOverride, formatDimMeasurement(measurement, dp, style, ''));
        const textWidth = value.length * h * 0.6;
        const markerSize = tick > 0 ? tick * 2 : (Number(style?.DIMASZ) > 0 ? style.DIMASZ * scale : h);
        const manual = Number.isFinite(textPoint?.x) && Number.isFinite(textPoint?.y);
        const length = Math.hypot(e2.x - e1.x, e2.y - e1.y);
        const autoOutside = !manual && value.trim() && textWidth + 2 * textGap + 2 * markerSize > length;
        const at1 = e1.x * dir.x + e1.y * dir.y, at2 = e2.x * dir.x + e2.y * dir.y;
        const textAt = manual ? textPoint.x * dir.x + textPoint.y * dir.y : 0;
        const manualOutside = manual && (textAt < Math.min(at1, at2) || textAt > Math.max(at1, at2));
        const segments = [];
        const seg = (a, b) => segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });

        // Extension lines: from just off the measured point to just past the dim line.
        for (const [index, [p, e]] of [[p1, e1], [p2, e2]].entries()) {
            if (style?.[index === 0 ? 'DIMSE1' : 'DIMSE2']) continue;
            const s = Math.sign(e.off) || 1;
            seg({ x: p.x + n.x * gap * s, y: p.y + n.y * gap * s },
                { x: e.x + n.x * beyond * s, y: e.y + n.y * beyond * s });
        }
        // Dimension line.
        const dimLineIndex = segments.length;
        seg(e1, e2);
        // Architectural ticks: 45° slashes across the dim line at each end.
        // A tick length of 0 draws none rather than a degenerate segment.
        if (tick > 0) {
            const tdir = { x: (dir.x - n.x) * Math.SQRT1_2, y: (dir.y - n.y) * Math.SQRT1_2 };
            for (const e of [e1, e2]) {
                seg({ x: e.x - tdir.x * tick, y: e.y - tdir.y * tick },
                    { x: e.x + tdir.x * tick, y: e.y + tdir.y * tick });
            }
        } else if (style) {
            const size = Number(style.DIMASZ) > 0 ? style.DIMASZ * scale : h;
            const sign = (Math.sign((e2.x - e1.x) * dir.x + (e2.y - e1.y) * dir.y) || 1) * (autoOutside || manualOutside ? -1 : 1);
            for (const [tip, s] of [[e1, sign], [e2, -sign]]) {
                const a = { x: tip.x + dir.x * size * s + n.x * size * 0.17, y: tip.y + dir.y * size * s + n.y * size * 0.17 };
                const b = { x: tip.x + dir.x * size * s - n.x * size * 0.17, y: tip.y + dir.y * size * s - n.y * size * 0.17 };
                seg(tip, a); seg(a, b); seg(b, tip);
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
        if (style?.DIMTAD === 4) {
            text.x = mid.x - up.x * textGap;
            text.y = mid.y - up.y * textGap;
            text.valign = text.valign === 3 ? 1 : 3;
        }
        if (style?.DIMTAD === 0) {
            text.x = mid.x; text.y = mid.y; text.valign = 2;
        }
        if (autoOutside) {
            const far = at2 >= at1 ? e2 : e1;
            const distance = markerSize + textGap + textWidth / 2;
            text.x += far.x + dir.x * distance - mid.x;
            text.y += far.y + dir.y * distance - mid.y;
            segments.push({ x1: far.x, y1: far.y,
                x2: far.x + dir.x * (markerSize + textGap), y2: far.y + dir.y * (markerSize + textGap) });
        }
        if (manual) {
            text.x = textPoint.x; text.y = textPoint.y; text.valign = 2;
            const offset = (text.x - mid.x) * n.x + (text.y - mid.y) * n.y;
            if (manualOutside || Math.abs(offset) > h + textGap) {
                const start = manualOutside ? (textAt > Math.max(at1, at2) ? (at2 > at1 ? e2 : e1) : (at2 < at1 ? e2 : e1)) : mid;
                const dx = start.x - text.x, dy = start.y - text.y;
                const edge = Math.max(Math.abs(dx * dir.x + dy * dir.y) / Math.max(textWidth / 2 + textGap, 1e-9),
                    Math.abs(dx * n.x + dy * n.y) / Math.max(h / 2 + textGap, 1e-9));
                if (edge > 1) segments.push({ x1: start.x, y1: start.y, x2: text.x + dx / edge, y2: text.y + dy / edge });
            }
        }
        if (text.valign === 2 && !autoOutside && value.trim()
            && Math.abs((text.x - mid.x) * n.x + (text.y - mid.y) * n.y) < h / 2 + textGap) {
            const direction = Math.sign(at2 - at1) || 1;
            const along = ((text.x - e1.x) * dir.x + (text.y - e1.y) * dir.y) * direction;
            const lo = Math.max(0, along - textWidth / 2 - textGap), hi = Math.min(length, along + textWidth / 2 + textGap);
            if (hi > lo) {
                const pieces = [];
                if (lo > 1e-9) pieces.push({ x1:e1.x, y1:e1.y, x2:e1.x + dir.x * lo * direction, y2:e1.y + dir.y * lo * direction });
                if (hi < length - 1e-9) pieces.push({ x1:e1.x + dir.x * hi * direction, y1:e1.y + dir.y * hi * direction, x2:e2.x, y2:e2.y });
                segments.splice(dimLineIndex, 1, ...pieces);
            }
        }
        return { segments, text, measurement, anchor: { x: e2.x, y: e2.y }, linear: true,
            dimensionLine: { start: { x: e1.x, y: e1.y }, end: { x: e2.x, y: e2.y } },
            textOutside: !!(autoOutside || manualOutside), automaticTextOutside: !!autoOutside };
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
            const g = buildDimGeometry(p1, p2, p3, o.forceAngleDeg, false, h, null, o.decimals, o.tickLength, o.textGap, o.flipText, o.rot180Text, o.style);
            return { ...g, dimensionType: 32, angle: o.forceAngleDeg, aligned: false, p1, p2 };
        }
        if (o.aligned) {
            const g = buildDimGeometry(p1, p2, p3, 0, true, h, null, o.decimals, o.tickLength, o.textGap, o.flipText, o.rot180Text, o.style);
            return { ...g, dimensionType: 33, angle: 0, aligned: true, p1, p2 };
        }
        // Outside distance from the points' bbox decides the orientation.
        const minX = Math.min(p1.x, p2.x), maxX = Math.max(p1.x, p2.x);
        const minY = Math.min(p1.y, p2.y), maxY = Math.max(p1.y, p2.y);
        const dxOut = p3.x < minX ? p3.x - minX : (p3.x > maxX ? p3.x - maxX : 0);
        const dyOut = p3.y < minY ? p3.y - minY : (p3.y > maxY ? p3.y - maxY : 0);
        const horizontal = Math.abs(dyOut) >= Math.abs(dxOut);
        const angle = horizontal ? 0 : 90;
        const g = buildDimGeometry(p1, p2, p3, angle, false, h, null, o.decimals, o.tickLength, o.textGap, o.flipText, o.rot180Text, o.style);
        return { ...g, dimensionType: 32, angle, aligned: false, p1, p2 };
    }

    /** Code-1 text override: '' / '<>' keep the measured value; any other
     *  string replaces it, with '<>' inside expanding to the measurement. */
    function resolveDimTextOverride(override, measuredStr) {
        if (!override || override === '<>') return measuredStr;
        return String(override).replace(/<>/g, measuredStr);
    }

    function formatDimMeasurement(measurement, decimals, style, symbol) {
        const factor = Number.isFinite(style?.DIMLFAC) ? style.DIMLFAC : 1;
        let value = measurement * factor;
        if (Number(style?.DIMRND) > 0) value = Math.round(value / style.DIMRND) * style.DIMRND;
        const precision = Math.max(0, Math.min(8,
            Number.isFinite(style?.DIMDEC) ? style.DIMDEC : Number.isFinite(decimals) ? decimals : 2));
        let formatted = style ? value.toFixed(precision) : String(Number(value.toFixed(precision)));
        if ((Number(style?.DIMZIN) || 0) & 8) formatted = formatted.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        formatted = (symbol || '') + formatted;
        return style?.DIMPOST ? resolveDimTextOverride(style.DIMPOST, formatted) : formatted;
    }

    /** Tier-2 fallback: synthesize graphics from a parsed DIMENSION entity. */
    function synthesizeFromEntity(entity, textHeight, decimals, tickLength, textGap, arrowSize) {
        const style = entity.__resolvedDimStyle;
        if (style) {
            const scale = Number(style.DIMSCALE) > 0 ? Number(style.DIMSCALE) : 1;
            if (Number(style.DIMTXT) > 0) textHeight = Number(style.DIMTXT) * scale;
            if (Number.isFinite(style.DIMDEC)) decimals = style.DIMDEC;
            if (Number.isFinite(style.DIMTSZ)) tickLength = style.DIMTSZ * scale;
            if (Number.isFinite(style.DIMGAP)) textGap = style.DIMGAP * scale;
            if (Number.isFinite(style.DIMASZ)) arrowSize = style.DIMASZ * scale;
        }
        decimals = Math.max(0, Math.min(8, Number.isFinite(decimals) ? decimals : 2));
        const g = synthesizeGeometry(entity, textHeight, decimals, tickLength, textGap, arrowSize);
        if (!g) return null;
        const bt = (Number(entity.dimensionType) || 0) & 15;
        if (style && bt !== 2 && bt !== 5) {
            const factor = Number.isFinite(style.DIMLFAC) ? style.DIMLFAC : 1;
            let value = g.measurement * factor;
            if (style.DIMRND > 0) value = Math.round(value / style.DIMRND) * style.DIMRND;
            const precision = Math.max(0, Math.min(8, Number.isFinite(style.DIMDEC) ? style.DIMDEC : (decimals ?? 2)));
            let formatted = value.toFixed(precision);
            if ((Number(style.DIMZIN) || 0) & 8) formatted = formatted.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
            if (bt === 3) formatted = 'Ø' + formatted;
            if (bt === 4) formatted = 'R' + formatted;
            if (style.DIMPOST) formatted = resolveDimTextOverride(style.DIMPOST, formatted);
            g.text.value = resolveDimTextOverride(entity.text, formatted);
        }
        if (((Number(entity.dimensionType) || 0) & 128) && entity.middleOfText) {
            if (!g.linear && !g.radial && Math.hypot(g.text.x - entity.middleOfText.x, g.text.y - entity.middleOfText.y) > (g.text.height || 1)) {
                const start = g.ordinate ? g.p2 : { x: g.text.x, y: g.text.y };
                g.segments.push({ x1: start.x, y1: start.y, x2: entity.middleOfText.x, y2: entity.middleOfText.y });
            }
            g.text.x = entity.middleOfText.x;
            g.text.y = entity.middleOfText.y;
            g.text.valign = 2;
        }
        return g;
    }

    function synthesizeGeometry(entity, textHeight, decimals, tickLength, textGap, arrowSize) {
        const flip = !!entity.__dimTextFlip;
        const rot180 = !!entity.__dimTextRot180;
        const baseType = (Number(entity.dimensionType) || 0) & 15;
        if (baseType === 5) {
            const center = entity.diameterOrRadiusPoint;
            const p1 = entity.linearOrAngularPoint1, p2 = entity.linearOrAngularPoint2;
            if (!center || !p1 || !p2 || !entity.anchorPoint) return null;
            const g = buildAngularDimGeometry(center, p1, center, p2, entity.anchorPoint,
                textHeight > 0 ? textHeight : 1, decimals, textGap, arrowSize, entity.__resolvedDimStyle, true);
            if (g) { g.dimensionType = entity.dimensionType; g.text.value = resolveDimTextOverride(entity.text, g.text.value); }
            return g;
        }
        if (![0, 1, 2, 3, 4, 6].includes(baseType)) return null;
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
            const g = buildRadialDimGeometry(center, radius, ang, diameter, h2, decimals, tickLength, textGap, arrowSize, entity.__resolvedDimStyle, entity.middleOfText);
            if (!g) return null;
            g.dimensionType = entity.dimensionType;
            if (entity.text && entity.text !== '<>') {
                g.text.value = resolveDimTextOverride(entity.text, g.text.value);
                g.textOverride = entity.text;
            }
            return g;
        }
        if (baseType === 2) {
            // 2-line angular: 13,14 = line 1, 15,10 = line 2, 16 = arc point.
            const g = buildAngularDimGeometry(entity.linearOrAngularPoint1, entity.linearOrAngularPoint2,
                entity.diameterOrRadiusPoint, entity.anchorPoint, entity.arcPoint,
                textHeight > 0 ? textHeight : 1, decimals, textGap, arrowSize, entity.__resolvedDimStyle);
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
            const g = buildOrdinateDimGeometry(feature, leaderEnd, xDatum, h6, decimals, textGap, entity.__resolvedDimStyle,
                { origin: entity.anchorPoint, angle: -(Number(entity.horizontalDirection) || 0) * DEG });
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
            entity.angle || 0, aligned, h, entity.text || null, decimals, tickLength, textGap, flip, rot180, entity.__resolvedDimStyle,
            ((Number(entity.dimensionType) || 0) & 128) ? entity.middleOfText : null
        );
        g.dimensionType = entity.dimensionType;
        g.angle = entity.angle || 0;
        g.aligned = aligned;
        g.p1 = { x: p1.x, y: p1.y };
        g.p2 = { x: p2.x, y: p2.y };
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
    function dimensionDefinitionPoints(entity) {
        const type = Number(entity.dimensionType) & 15;
        const fields = type === 3 || type === 4 ? ['anchorPoint', 'diameterOrRadiusPoint']
            : type === 2 ? ['linearOrAngularPoint1','linearOrAngularPoint2','diameterOrRadiusPoint','anchorPoint']
            : type === 5 ? ['diameterOrRadiusPoint','linearOrAngularPoint1','linearOrAngularPoint2']
            : ['linearOrAngularPoint1','linearOrAngularPoint2'];
        return fields.map((field, index) => ({ field, index, point: entity[field] }))
            .filter(d => Number.isFinite(d.point?.x) && Number.isFinite(d.point?.y));
    }
    function resetDimensionText(entity) {
        const automatic = { ...entity, dimensionType: Number(entity.dimensionType) & ~128 };
        delete automatic.middleOfText;
        return automatic;
    }
    function moveDimensionText(entity, position, automaticGeometry, tolerance = 0) {
        if (automaticGeometry?.dimensionLine && tolerance > 0) {
            const targets = [automaticGeometry.text];
            const line = automaticGeometry.dimensionLine;
            if (line) targets.push({ x: (line.start.x + line.end.x) / 2, y: (line.start.y + line.end.y) / 2 });
            if (targets.some(p => p && Math.hypot(position.x - p.x, position.y - p.y) <= tolerance))
                return resetDimensionText(entity);
        }
        if ([3, 4].includes(Number(entity.dimensionType) & 15)) return moveRadialText(entity, position);
        return { ...entity, dimensionType: Number(entity.dimensionType) | 128,
            middleOfText: { x: position.x, y: position.y, z: 0 } };
    }
    function moveDimensionLine(entity, offset, field = 'anchorPoint') {
        const moved = { ...entity, [field]: { ...entity[field],
            x: entity[field].x + offset.x, y: entity[field].y + offset.y } };
        if ((Number(entity.dimensionType) & 128) && entity.middleOfText)
            moved.middleOfText = { ...entity.middleOfText,
                x: entity.middleOfText.x + offset.x, y: entity.middleOfText.y + offset.y };
        return moved;
    }
    function moveRadialText(entity, position) {
        const diameter = ((Number(entity.dimensionType) || 0) & 15) === 3;
        const a = entity.anchorPoint, b = entity.diameterOrRadiusPoint;
        if (!a || !b) return entity;
        const center = diameter ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a;
        const radius = Math.hypot(b.x - a.x, b.y - a.y) / (diameter ? 2 : 1);
        const angle = Math.atan2(position.y - center.y, position.x - center.x);
        const dx = radius * Math.cos(angle), dy = radius * Math.sin(angle);
        return { ...entity, dimensionType: Number(entity.dimensionType) | 128,
            middleOfText: { x: position.x, y: position.y, z: 0 },
            anchorPoint: diameter ? { x: center.x + dx, y: center.y + dy, z: 0 } : { ...a },
            diameterOrRadiusPoint: diameter ? { x: center.x - dx, y: center.y - dy, z: 0 }
                : { x: center.x + dx, y: center.y + dy, z: 0 } };
    }

    function buildRadialDimGeometry(center, radius, angleRad, diameter, h, decimals, tickLength, textGap, arrowSize, style, textPoint) {
        if (!(radius > 0)) return null;
        const dir = { x: Math.cos(angleRad), y: Math.sin(angleRad) };
        const n = { x: -dir.y, y: dir.x };
        const edge = { x: center.x + dir.x * radius, y: center.y + dir.y * radius };
        const start = diameter
            ? { x: center.x - dir.x * radius, y: center.y - dir.y * radius }
            : { x: center.x, y: center.y };

        const tGap = Number.isFinite(textGap) && textGap >= 0 ? textGap : 0.3 * h;
        const scale = Number(style?.DIMSCALE) > 0 ? Number(style.DIMSCALE) : 1;
        const tick = Number.isFinite(style?.DIMTSZ) ? Math.max(0, style.DIMTSZ * scale / 2)
            : Number.isFinite(tickLength) ? Math.max(0, tickLength) : 0;
        const aLen = arrowSize > 0 ? arrowSize : h;
        const aHalf = aLen / 3;
        const segments = [{ x1: start.x, y1: start.y, x2: edge.x, y2: edge.y }];
        const explicit = Number.isFinite(textPoint?.x) && Number.isFinite(textPoint?.y);
        const outside = explicit && (textPoint.x - center.x) * dir.x + (textPoint.y - center.y) * dir.y > radius + 1e-9;
        const polylines = [];
        // The DIMTSZ tick replaces arrowheads at the measured circle points.
        if (tick > 0) {
            const tdir = { x: (dir.x - n.x) * Math.SQRT1_2, y: (dir.y - n.y) * Math.SQRT1_2 };
            for (const tip of diameter ? [edge, start] : [edge]) {
                segments.push({ x1: tip.x - tdir.x * tick, y1: tip.y - tdir.y * tick,
                    x2: tip.x + tdir.x * tick, y2: tip.y + tdir.y * tick });
            }
        } else {
            // Arrow tip ON the arc, pointing at the curve (body runs inward).
            polylines.push(arrowheadPolyline(edge, (outside ? 1 : -1) * dir.x, (outside ? 1 : -1) * dir.y, aLen, aHalf));
        }
        if (diameter) {
            if (tick === 0) polylines.push(arrowheadPolyline(start, dir.x, dir.y, aLen, aHalf));
        } else {
            // Radius: cross mark at the circle center.
            const cm = 0.5 * h;
            segments.push({ x1: center.x - cm, y1: center.y, x2: center.x + cm, y2: center.y });
            segments.push({ x1: center.x, y1: center.y - cm, x2: center.x, y2: center.y + cm });
        }

        const measurement = diameter ? 2 * radius : radius;
        const value = formatDimMeasurement(measurement, decimals, style, diameter ? 'Ø' : 'R');

        // Readable text along the dimension line, offset to one side — the same
        // flip rule the linear builder uses.
        let rot = Math.atan2(dir.y, dir.x) * 180 / Math.PI;
        let up = { x: n.x, y: n.y };
        if (rot > 90 + 1e-9 || rot <= -90 + 1e-9) { rot += 180; up = { x: -n.x, y: -n.y }; }
        rot = ((rot % 360) + 360) % 360;
        const mid = { x: (start.x + edge.x) / 2, y: (start.y + edge.y) / 2 };
        const placement = Number(style?.DIMTAD);
        const offset = placement === 0 ? 0 : placement === 4 ? -tGap : tGap;
        const text = {
            value,
            x: mid.x + up.x * offset,
            y: mid.y + up.y * offset,
            rotationDeg: rot,
            height: h,
            valign: placement === 0 ? 2 : placement === 4 ? 3 : 1,
        };
        if (explicit) {
            text.x = textPoint.x; text.y = textPoint.y;
            text.valign = 2; text.halign = 1;
        }
        if (outside) {
            // Keep the arrow radial even for an imported off-axis text point.
            const distance = (textPoint.x - center.x) * dir.x + (textPoint.y - center.y) * dir.y;
            const halfText = value.length * h * 0.3 + tGap;
            const endDistance = Math.max(radius + aLen, distance - halfText);
            const end = { x: center.x + dir.x * endDistance, y: center.y + dir.y * endDistance };
            if (!diameter) segments.splice(0, 1);
            segments.push({ x1: edge.x, y1: edge.y, x2: end.x, y2: end.y });
            const offAxis = (textPoint.x - center.x) * n.x + (textPoint.y - center.y) * n.y;
            if (Math.abs(offAxis) > 1e-9) segments.push({ x1: end.x, y1: end.y,
                x2: textPoint.x - dir.x * halfText, y2: textPoint.y - dir.y * halfText });
        } else if ((placement === 0 || explicit) && value.trim()) {
            const halfGap = Math.min(radius * (diameter ? 0.9 : 0.45), value.length * h * 0.3 + tGap);
            const location = explicit ? Math.max(diameter ? -radius : 0, Math.min(radius,
                (text.x - center.x) * dir.x + (text.y - center.y) * dir.y)) : diameter ? 0 : radius / 2;
            const lower = Math.max(diameter ? -radius : 0, location - halfGap);
            const upper = Math.min(radius, location + halfGap);
            const before = { x: center.x + dir.x * lower, y: center.y + dir.y * lower };
            const after = { x: center.x + dir.x * upper, y: center.y + dir.y * upper };
            segments.splice(0, 1,
                { x1: start.x, y1: start.y, x2: before.x, y2: before.y },
                { x1: after.x, y1: after.y, x2: edge.x, y2: edge.y });
        }
        return {
            segments, polylines, text, measurement,
            radial: true, diameter: !!diameter,
            center: { x: center.x, y: center.y },
            leaderLength: outside ? Math.max(0, Math.hypot(text.x - center.x, text.y - center.y) - radius) : 0,
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
    function buildOrdinateDimGeometry(feature, leaderEnd, xDatum, h, decimals, textGap, style, datum) {
        if (!feature || !leaderEnd) return null;
        if (datum) {
            const origin = datum.origin || { x: 0, y: 0 }, angle = Number(datum.angle) || 0;
            const c = Math.cos(angle), s = Math.sin(angle);
            const local = p => ({ x: (p.x - origin.x) * c + (p.y - origin.y) * s,
                y: -(p.x - origin.x) * s + (p.y - origin.y) * c });
            const world = p => ({ x: origin.x + p.x * c - p.y * s, y: origin.y + p.x * s + p.y * c });
            const g = buildOrdinateDimGeometry(local(feature), local(leaderEnd), xDatum, h, decimals, textGap, style);
            if (!g) return null;
            g.segments = g.segments.map(seg => {
                const a = world({ x: seg.x1, y: seg.y1 }), b = world({ x: seg.x2, y: seg.y2 });
                return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
            });
            Object.assign(g.text, world(g.text));
            g.text.rotationDeg = ((g.text.rotationDeg + angle / DEG) % 360 + 360) % 360;
            if (g.text.rotationDeg > 90 && g.text.rotationDeg <= 270) g.text.rotationDeg = (g.text.rotationDeg + 180) % 360;
            g.p1 = { ...feature }; g.p2 = { ...leaderEnd }; g.anchor = { ...origin };
            g.horizontalDirection = -angle / DEG;
            return g;
        }
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
        const value = formatDimMeasurement(measurement, decimals, style, '');
        const placement = Number(style?.DIMTAD);
        const side = placement === 0 ? 0 : placement === 4 ? -tGap : tGap;
        const readableNormal = { x: -Math.sin(rot * DEG), y: Math.cos(rot * DEG) };
        const text = {
            value,
            x: e.x + up.x * tGap * 2 + readableNormal.x * side,
            y: e.y + up.y * tGap * 2 + readableNormal.y * side,
            rotationDeg: rot,
            height: h,
            valign: placement === 0 ? 2 : placement === 4 ? 3 : 1,
            halign: 1,
        };
        return {
            segments, polylines: [], text, measurement,
            ordinate: true, xDatum: !!xDatum,
            // The generic (non-radial) regenerate/patch path uses these:
            anchor: { x: 0, y: 0 },
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
            '70', String(32 | 6 | (dim.xDatum ? 64 : 0) | ((Number(dim.dimensionType) || 0) & 128)),
            '1', dim.textOverride ? String(dim.textOverride) : '',
            '71', '5',
            '42', n(dim.measurement),
            '51', n(dim.horizontalDirection || 0),
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
            '70', String(32 | (diameter ? 3 : 4) | ((Number(dim.dimensionType) || 0) & 128)),
            '1', dim.textOverride ? String(dim.textOverride) : '',
            '71', '5',
            '42', n(dim.measurement),
            '100', diameter ? 'AcDbDiametricDimension' : 'AcDbRadialDimension',
            '15', n(p15.x), '25', n(p15.y), '35', '0',
            '40', n(dim.leaderLength || 0),
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
    function parseRawDxfLeaders(rawText, preparedLines = null) {
        const out = [];
        if (!rawText) return out;
        const lines = preparedLines || String(rawText).replace(/\r\n/g, '\n').split('\n');
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

    // ===================== Angular (2-line) =====================
    const TAU = Math.PI * 2;
    const normAng = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };

    /**
     * Geometry for a 2-line ANGULAR dimension (DIMANGULAR).
     *  l1a,l1b / l2a,l2b — the two lines (codes 13,14 / 15,10)
     *  arcPt             — where the dimension arc passes (code 16); its
     *                      quadrant picks which of the four angles is measured
     * Arc with arrows at both ends, extension lines when the arc lies beyond
     * a line's end, text (degrees) at the arc middle, outside.
     */
    function buildAngularDimGeometry(l1a, l1b, l2a, l2b, arcPt, h, decimals, textGap, arrowSize, style, threePoint = false) {
        if (!l1a || !l1b || !l2a || !l2b || !arcPt) return null;
        const d1x = l1b.x - l1a.x, d1y = l1b.y - l1a.y, d2x = l2b.x - l2a.x, d2y = l2b.y - l2a.y;
        const L1 = Math.hypot(d1x, d1y), L2 = Math.hypot(d2x, d2y);
        if (!(L1 > 0) || !(L2 > 0)) return null;
        const den = d1x * d2y - d1y * d2x;
        if (Math.abs(den) < 1e-12 * L1 * L2) return null;           // parallel lines
        const t = ((l2a.x - l1a.x) * d2y - (l2a.y - l1a.y) * d2x) / den;
        const C = { x: l1a.x + d1x * t, y: l1a.y + d1y * t };
        const r = Math.hypot(arcPt.x - C.x, arcPt.y - C.y);
        if (!(r > 0)) return null;
        const u1 = { x: d1x / L1, y: d1y / L1 }, u2 = { x: d2x / L2, y: d2y / L2 };
        const ap = Math.atan2(arcPt.y - C.y, arcPt.x - C.x);
        let a0 = 0, sweep = 0, ray1 = null, ray2 = null;
        for (const s1 of (threePoint ? [1] : [1, -1])) for (const s2 of (threePoint ? [1] : [1, -1])) {
            const r1 = { x: u1.x * s1, y: u1.y * s1 }, r2 = { x: u2.x * s2, y: u2.y * s2 };
            const b1 = Math.atan2(r1.y, r1.x), b2 = Math.atan2(r2.y, r2.x);
            // Two-line dimensions choose the clicked quadrant (<180 degrees).
            // Three-point dimensions keep their endpoint rays, so the arc point
            // can select either the minor or major angle.
            for (const [s, e, ra, rb] of [[b1, b2, r1, r2], [b2, b1, r2, r1]]) {
                const sw = normAng(e - s);
                if (sw > 1e-12 && (threePoint || sw < Math.PI + 1e-12)
                    && normAng(ap - s) <= sw + 1e-12 && !ray1) { a0 = s; sweep = sw; ray1 = ra; ray2 = rb; }
            }
        }
        if (!ray1) return null;
        const scale = Number(style?.DIMSCALE) > 0 ? Number(style.DIMSCALE) : 1;
        const gap = Number.isFinite(style?.DIMEXO) ? style.DIMEXO * scale : 0.25 * h;
        const beyond = Number.isFinite(style?.DIMEXE) ? style.DIMEXE * scale : 0.5 * h;
        const tGap = Number.isFinite(textGap) && textGap >= 0 ? textGap : 0.3 * h;
        const aLen = arrowSize > 0 ? arrowSize : h;
        const tick = Number.isFinite(style?.DIMTSZ) ? Math.max(0, style.DIMTSZ * scale) : 0;
        const segments = [], polylines = [], arcs = [];
        const P = (a, rad = r) => ({ x: C.x + Math.cos(a) * rad, y: C.y + Math.sin(a) * rad });
        // Extension line along a ray when its line stops short of the arc.
        const ext = (ray, la, lb) => {
            const pa = (la.x - C.x) * ray.x + (la.y - C.y) * ray.y, pb = (lb.x - C.x) * ray.x + (lb.y - C.y) * ray.y;
            const far = Math.max(pa, pb), near = Math.min(pa, pb);
            if (far >= r - 1e-9 && near <= r + 1e-9) return;           // the line reaches the arc
            const from = far < r ? far + gap : near - gap, to = far < r ? r + beyond : r - beyond;
            segments.push({ x1: C.x + ray.x * from, y1: C.y + ray.y * from, x2: C.x + ray.x * to, y2: C.y + ray.y * to });
        };
        const line1IsRay1 = Math.abs(ray1.x * u1.y - ray1.y * u1.x) < 1e-9;
        if (!style?.[line1IsRay1 ? 'DIMSE1' : 'DIMSE2'])
            ext(ray1, line1IsRay1 ? l1a : l2a, line1IsRay1 ? l1b : l2b);
        if (!style?.[line1IsRay1 ? 'DIMSE2' : 'DIMSE1'])
            ext(ray2, line1IsRay1 ? l2a : l1a, line1IsRay1 ? l2b : l1b);
        const deg = sweep * 180 / Math.PI;
        const angularDecimals = Number.isFinite(style?.DIMADEC) && style.DIMADEC >= 0 ? style.DIMADEC
            : Number.isFinite(style?.DIMDEC) ? style.DIMDEC : decimals;
        const dp = Math.max(0, Math.min(8, Number.isFinite(angularDecimals) ? angularDecimals : 0));
        const rounded = Number(style?.DIMRND) > 0 ? Math.round(deg / style.DIMRND) * style.DIMRND : deg;
        const unit = Number(style?.DIMAUNIT) || 0;
        const azin = Number(style?.DIMAZIN) || 0;
        const format = n => {
            let s = style ? n.toFixed(dp) : String(Number(n.toFixed(dp)));
            if (azin & 2) s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
            if (azin & 1) s = s.replace(/^0\./, '.');
            return s;
        };
        let value;
        if (unit === 1) {
            const wholeSeconds = Math.round(rounded * 3600 * 10 ** dp) / 10 ** dp;
            const d = Math.floor(wholeSeconds / 3600);
            const m = Math.floor((wholeSeconds - d * 3600) / 60);
            const sec = wholeSeconds - d * 3600 - m * 60;
            value = `${d}d${String(m).padStart(2, '0')}'${format(sec).padStart(dp ? 3 + dp : 2, '0')}\"`;
        } else if (unit === 2) value = `${format(rounded * 10 / 9)}g`;
        else if (unit === 3) value = `${format(rounded * Math.PI / 180)}r`;
        else value = `${format(rounded)}\u00B0`;
        if (style?.DIMPOST) value = resolveDimTextOverride(style.DIMPOST, value);
        const mid = a0 + sweep / 2;
        const centered = style?.DIMTAD === 0;
        const below = style?.DIMTAD === 4;
        let rot = (mid * 180 / Math.PI) - 90;
        if (Math.sin(mid) < -1e-9) rot += 180;   // readable below the centre
        rot = ((rot % 360) + 360) % 360;
        const tp = P(mid, r + (centered ? 0 : below ? -tGap : tGap));
        const text = {
            value, x: tp.x, y: tp.y, rotationDeg: rot, height: h,
            valign: centered ? 2 : below ? (Math.sin(mid) < -1e-9 ? 1 : 3)
                : (Math.sin(mid) < -1e-9 ? 3 : 1),
        };
        // Centered text interrupts the dimension arc at its measured position.
        const halfBreak = centered && value.trim()
            ? Math.min(sweep * 0.4, (value.length * h * 0.3 + tGap) / r) : 0;
        const ranges = halfBreak > 0
            ? [[a0, mid - halfBreak], [mid + halfBreak, a0 + sweep]]
            : [[a0, a0 + sweep]];
        for (const [from, to] of ranges) {
            arcs.push({ c: C, r, a0: from, a1: to });
            const n = Math.max(2, Math.ceil((to - from) / (Math.PI / 48)));
            for (let k = 0; k < n; k++) {
                const p = P(from + (to - from) * k / n), q = P(from + (to - from) * (k + 1) / n);
                segments.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, arc: true });
            }
        }
        // End markers follow the named style.
        const s0 = P(a0, r), s1 = P(a0 + sweep, r);
        if (tick > 0) {
            for (const [tip, angle] of [[s0, a0], [s1, a0 + sweep]]) {
                const dx = (-Math.sin(angle) - Math.cos(angle)) * Math.SQRT1_2 * tick / 2;
                const dy = (Math.cos(angle) - Math.sin(angle)) * Math.SQRT1_2 * tick / 2;
                segments.push({ x1: tip.x - dx, y1: tip.y - dy, x2: tip.x + dx, y2: tip.y + dy });
            }
        } else {
            polylines.push(arrowheadPolyline(s0, -Math.sin(a0), Math.cos(a0), aLen, aLen / 3));
            polylines.push(arrowheadPolyline(s1, Math.sin(a0 + sweep), -Math.cos(a0 + sweep), aLen, aLen / 3));
        }
        return {
            segments, polylines, text, measurement: sweep, angular: true,
            arcs,
            center: C, anchor: { x: tp.x, y: tp.y },
            l1a: { ...l1a }, l1b: { ...l1b }, l2a: { ...l2a }, l2b: { ...l2b }, arcPt: { x: arcPt.x, y: arcPt.y },
            dimensionType: 32 | (threePoint ? 5 : 2),
        };
    }

    /** 2-line ANGULAR DIMENSION pairs (type 2, block-ref flag set). 42 is in radians. */
    function emitAngularDimensionPairs(dim, handle, layer, blockName) {
        const n = (v) => String(Math.round(Number(v) * 1e9) / 1e9);
        if ((dim.dimensionType & 15) === 5) return [
            '0', 'DIMENSION', '5', String(handle), '8', layer || '0',
            '100', 'AcDbEntity', '100', 'AcDbDimension',
            '2', blockName,
            '10', n(dim.arcPt.x), '20', n(dim.arcPt.y), '30', '0',
            '11', n(dim.text.x), '21', n(dim.text.y), '31', '0',
            '70', String(32 | 5 | ((Number(dim.dimensionType) || 0) & 128)),
            '1', dim.textOverride ? String(dim.textOverride) : '',
            '71', '5', '42', n(dim.measurement),
            '100', 'AcDb3PointAngularDimension',
            '13', n(dim.l1b.x), '23', n(dim.l1b.y), '33', '0',
            '14', n(dim.l2b.x), '24', n(dim.l2b.y), '34', '0',
            '15', n(dim.l1a.x), '25', n(dim.l1a.y), '35', '0',
        ];
        return [
            '0', 'DIMENSION', '5', String(handle), '8', layer || '0',
            '100', 'AcDbEntity', '100', 'AcDbDimension',
            '2', blockName,
            '10', n(dim.l2b.x), '20', n(dim.l2b.y), '30', '0',
            '11', n(dim.text.x), '21', n(dim.text.y), '31', '0',
            '70', String(32 | 2 | ((Number(dim.dimensionType) || 0) & 128)),
            '1', dim.textOverride ? String(dim.textOverride) : '',
            '71', '5',
            '42', n(dim.measurement),
            '100', 'AcDb2LineAngularDimension',
            '13', n(dim.l1a.x), '23', n(dim.l1a.y), '33', '0',
            '14', n(dim.l1b.x), '24', n(dim.l1b.y), '34', '0',
            '15', n(dim.l2a.x), '25', n(dim.l2a.y), '35', '0',
            '16', n(dim.arcPt.x), '26', n(dim.arcPt.y), '36', '0',
        ];
    }

    /** DIMENSION entity pairs for the raw serializer. */
    function emitDimensionGeometryPairs(dim, handle, layer, blockName) {
        if (dim && dim.angular) return emitAngularDimensionPairs(dim, handle, layer, blockName);
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
            '1', dim.textOverride ? String(dim.textOverride) : '',
            '71', String(dim.text.valign === 1 ? 8 : dim.text.valign === 3 ? 2 : 5),
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

    function emitDimensionPairs(dim, handle, layer, blockName) {
        const pairs = emitDimensionGeometryPairs(dim, handle, layer, blockName);
        // All dimension kinds use the same attachment convention as their text graphics.
        const attachment = pairs.indexOf('71');
        if (attachment >= 0) pairs[attachment + 1] = String(dim.text.valign === 1 ? 8 : dim.text.valign === 3 ? 2 : 5);
        const commonStart = pairs.indexOf('AcDbDimension');
        let nextSubclass = pairs.length;
        for (let i = commonStart + 1; i < pairs.length; i += 2) {
            if (pairs[i] === '100') { nextSubclass = i; break; }
        }
        pairs.splice(nextSubclass, 0, '3', dim.styleName || 'STANDARD');
        const overrides = dim.styleOverrides;
        if (overrides) {
            pairs.push('1001', 'ACAD', '1000', 'DSTYLE', '1002', '{');
            for (const [code, value] of Object.entries(overrides)) {
                if (code !== '3' && !Number.isFinite(Number(value))) continue;
                pairs.push('1070', code, code === '3' ? '1000' : Number(code) >= 70 && Number(code) < 80 || Number(code) >= 170 ? '1070' : '1040', String(value));
            }
            pairs.push('1002', '}');
        }
        return pairs;
    }

    // Find a run of ordinary linear/aligned dimensions sharing one dimension line.
    // DXF stores these as independent entities, so this is a geometric convenience
    // for the editor's explicit chain-move grip action, not a persistent group.
    function continuedDimensionChain(seed, entities) {
        const base = (e) => {
            if (e?.type !== 'DIMENSION' || ![0, 1].includes((Number(e.dimensionType) || 0) & 15)) return null;
            const p1 = e.linearOrAngularPoint1, p2 = e.linearOrAngularPoint2, anchor = e.anchorPoint;
            if (!p1 || !p2 || !anchor) return null;
            const angle = ((Number(e.dimensionType) || 0) & 15) === 1
                ? Math.atan2(p2.y - p1.y, p2.x - p1.x)
                : (Number(e.angle) || 0) * Math.PI / 180;
            return { e, p1, p2, anchor, u: { x: Math.cos(angle), y: Math.sin(angle) } };
        };
        const start = base(seed);
        if (!start) return [];
        const scale = Math.max(1, Math.hypot(start.p2.x - start.p1.x, start.p2.y - start.p1.y));
        const tol = scale * 1e-6;
        const normal = { x: -start.u.y, y: start.u.x };
        const lineOffset = start.anchor.x * normal.x + start.anchor.y * normal.y;
        const close = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;
        const candidates = (entities || []).map(base).filter(b => b && b.e !== seed
            && Math.abs(start.u.x * b.u.y - start.u.y * b.u.x) <= 1e-6
            && Math.abs(b.anchor.x * normal.x + b.anchor.y * normal.y - lineOffset) <= tol);
        const chain = [start];
        const found = new Set([seed]);
        for (let i = 0; i < chain.length; i++) {
            const b = chain[i];
            for (const c of candidates) {
                if (found.has(c.e)) continue;
                if (close(b.p1, c.p1) || close(b.p1, c.p2) || close(b.p2, c.p1) || close(b.p2, c.p2)) {
                    found.add(c.e);
                    chain.push(c);
                }
            }
        }
        return chain.map(b => b.e);
    }

    const DxfDim = { buildDimGeometry, computeDimFromClicks, synthesizeFromEntity, emitDimensionPairs,
        continuedDimensionChain, dimensionDefinitionPoints, resetDimensionText, moveDimensionText, moveDimensionLine,
        buildRadialDimGeometry, emitRadialDimensionPairs, moveRadialText,
        buildOrdinateDimGeometry, emitOrdinateDimensionPairs,
        buildAngularDimGeometry, emitAngularDimensionPairs,
        leaderGeometry, parseRawDxfLeaders };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfDim;
    if (root) root.DxfDim = DxfDim;
})(typeof window !== 'undefined' ? window : null);
