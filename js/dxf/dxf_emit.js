/**
 * dxf_emit.js — pure DXF entity emitters.
 *
 * Each emitter returns an array of code/value line pairs (flat array of strings)
 * ready to be spliced into the ENTITIES section of a raw DXF file.
 *
 * Loaded as a classic script (works over file://). Exposes window.DxfEmit.
 * Zero DOM dependencies — fully testable in Node (module.exports fallback).
 */
(function (root) {
    'use strict';

    // Format a coordinate value for DXF output.
    function num(v) {
        const n = Number(v) || 0;
        // Avoid scientific notation; trim trailing zeros but keep precision.
        return n.toFixed(9).replace(/\.?0+$/, '') || '0';
    }

    // Common leading pairs for every entity: type, handle, layer, optional
    // paper-space markers (code 67 = 1, code 410 = layout tab name), and the
    // per-entity style overrides. Group codes stay in the order AutoCAD writes
    // the AcDbEntity block: 67, 410, 8, 6, 62, 370, 420.
    function head(type, handle, layer, opts) {
        const pairs = ['0', type];
        if (handle) pairs.push('5', String(handle));
        if (opts && opts.paperSpace) {
            pairs.push('67', '1');
            if (opts.layoutName) pairs.push('410', String(opts.layoutName));
        }
        pairs.push('8', String(layer || '0'));
        if (!opts) return pairs;
        if (typeof opts.lineType === 'string' && opts.lineType) {
            pairs.push('6', opts.lineType);
        }
        if (Number.isFinite(opts.colorIndex)) {
            pairs.push('62', String(Math.round(opts.colorIndex)));
        }
        if (Number.isFinite(opts.lineweight)) {
            pairs.push('370', String(Math.round(opts.lineweight)));
        }
        // 420 is a 24-bit 0xRRGGBB value; it overrides 62 where both are present.
        if (Number.isFinite(opts.trueColor)) {
            pairs.push('420', String(Math.round(opts.trueColor) & 0xffffff));
        }
        return pairs;
    }

    /**
     * Fold an entity's own style onto the caller's opts, so every emitter picks
     * it up through head() without each one needing to know about colour.
     * BYLAYER (256) and BYBLOCK (0) are left out entirely — omitting the code is
     * how DXF spells "inherit".
     */
    function entityStyleOpts(opts, entity) {
        if (!entity) return opts;
        const out = { ...(opts || {}) };
        const ci = Number(entity.colorIndex ?? entity.color);
        if (Number.isFinite(ci) && ci > 0 && ci < 256) out.colorIndex = ci;
        const tc = Number(entity.trueColor ?? entity.trueColorNumber);
        if (Number.isFinite(tc)) out.trueColor = tc;
        const lw = Number(entity.lineweight ?? entity.lineWeight);
        if (Number.isFinite(lw)) out.lineweight = lw;
        const lt = entity.lineType ?? entity.linetype;
        if (typeof lt === 'string' && lt && lt !== 'BYLAYER') out.lineType = lt;
        return out;
    }

    /** LINE from p1 to p2. */
    function emitLine(p1, p2, layer, handle, opts) {
        return [
            ...head('LINE', handle, layer, opts),
            '10', num(p1.x), '20', num(p1.y), '30', '0',
            '11', num(p2.x), '21', num(p2.y), '31', '0',
        ];
    }

    /** LWPOLYLINE through verts [{x,y,bulge?}]; closed flag sets bit 1 of code 70. */
    function emitLwPolyline(verts, closed, layer, handle, opts) {
        const pairs = [
            ...head('LWPOLYLINE', handle, layer, opts),
            '100', 'AcDbPolyline',
            '90', String(verts.length),
            '70', closed ? '1' : '0',
        ];
        for (const v of verts) {
            pairs.push('10', num(v.x), '20', num(v.y));
            if (v.bulge) pairs.push('42', num(v.bulge));
        }
        return pairs;
    }

    /** CIRCLE with center c and radius r. */
    function emitCircle(c, r, layer, handle, opts) {
        return [
            ...head('CIRCLE', handle, layer, opts),
            '10', num(c.x), '20', num(c.y), '30', '0',
            '40', num(Math.abs(r)),
        ];
    }

    /** ARC with center c, radius r, start/end angles in DEGREES (CCW). */
    function emitArc(c, r, startDeg, endDeg, layer, handle, opts) {
        return [
            ...head('ARC', handle, layer, opts),
            '10', num(c.x), '20', num(c.y), '30', '0',
            '40', num(Math.abs(r)),
            '50', num(startDeg),
            '51', num(endDeg),
        ];
    }

    /**
     * TEXT at pos with a given height. Newlines are not valid in TEXT values —
     * the caller should use one TEXT per line or MTEXT; we sanitize defensively.
     */
    function emitText(pos, height, value, layer, handle, rotationDeg, opts) {
        const safe = String(value ?? '')
            .replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ');
        const pairs = [
            ...head('TEXT', handle, layer, opts),
            '10', num(pos.x), '20', num(pos.y), '30', '0',
            '40', num(Math.abs(height) || 1),
            '1', safe,
        ];
        if (rotationDeg) pairs.push('50', num(rotationDeg));
        return pairs;
    }

    /** MTEXT at pos; newlines become \P paragraph markers. */
    function emitMText(pos, height, value, layer, handle, opts) {
        const safe = String(value ?? '')
            .replace(/\r\n/g, '\\P').replace(/\n/g, '\\P').replace(/\r/g, '');
        return [
            ...head('MTEXT', handle, layer, opts),
            '100', 'AcDbMText',
            '10', num(pos.x), '20', num(pos.y), '30', '0',
            '40', num(Math.abs(height) || 1),
            '1', safe,
        ];
    }

    /**
     * Compute a 3-point arc (start, mid-on-arc, end) → {center, radius, startDeg, endDeg}
     * or null if the points are collinear.
     */
    function arcFrom3Points(p1, p2, p3) {
        const ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
        const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if (Math.abs(d) < 1e-12) return null; // collinear
        const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
        const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
        const r = Math.hypot(ax - ux, ay - uy);
        let a1 = Math.atan2(ay - uy, ax - ux);
        let aMid = Math.atan2(by - uy, bx - ux);
        let a3 = Math.atan2(cy - uy, cx - ux);
        // DXF arcs are CCW from startDeg to endDeg. Determine direction so the
        // arc passes through the mid point.
        const norm = (a) => (a < 0 ? a + Math.PI * 2 : a);
        a1 = norm(a1); aMid = norm(aMid); a3 = norm(a3);
        const ccwContains = (from, to, test) => {
            const span = (to - from + Math.PI * 2) % (Math.PI * 2);
            const t = (test - from + Math.PI * 2) % (Math.PI * 2);
            return t <= span + 1e-9;
        };
        let startRad, endRad;
        if (ccwContains(a1, a3, aMid)) { startRad = a1; endRad = a3; }
        else { startRad = a3; endRad = a1; }
        return {
            center: { x: ux, y: uy },
            radius: r,
            startDeg: startRad * 180 / Math.PI,
            endDeg: endRad * 180 / Math.PI,
        };
    }

    /**
     * Paper-space VIEWPORT: a frame at `center` (paper coords, w×h paper units)
     * showing model space around `viewCenter` with `viewHeight` model units visible.
     * `id` is the viewport id (code 69, must be ≥2 and unique per layout).
     * opts.layoutName tags the layout tab (code 410). Code 67=1 is implied for
     * viewports, so opts.paperSpace is forced on.
     */
    function emitViewport(center, w, h, viewCenter, viewHeight, id, layer, handle, opts) {
        const o = Object.assign({}, opts, { paperSpace: true });
        return [
            ...head('VIEWPORT', handle, layer, o),
            '100', 'AcDbViewport',
            '10', num(center.x), '20', num(center.y), '30', '0',
            '40', num(Math.abs(w)),
            '41', num(Math.abs(h)),
            '68', '1',
            '69', String(id),
            '12', num(viewCenter.x), '22', num(viewCenter.y),
            '13', '0', '23', '0',
            '14', '10', '24', '10',
            '15', '10', '25', '10',
            '16', '0', '26', '0', '36', '1',
            '17', '0', '27', '0', '37', '0',
            '42', '50',
            '43', '0',
            '44', '0',
            '45', num(Math.abs(viewHeight)),
            '50', '0',
            '51', '0',
            '72', '1000',
            '90', '16416',
        ];
    }

    /**
     * INSERT (block reference) at `pos` with optional uniform/non-uniform scale and
     * rotation (degrees). `blockName` is the block definition to reference.
     */
    function emitInsert(blockName, pos, sx, sy, rotationDeg, layer, handle, opts) {
        const pairs = [
            ...head('INSERT', handle, layer, opts),
            '100', 'AcDbBlockReference',
            '2', String(blockName),
            '10', num(pos.x), '20', num(pos.y), '30', '0',
        ];
        if (sx !== 1 && sx !== undefined) pairs.push('41', num(sx));
        if (sy !== 1 && sy !== undefined) pairs.push('42', num(sy));
        if (rotationDeg) pairs.push('50', num(rotationDeg));
        return pairs;
    }

    /** POINT at pos. */
    function emitPoint(pos, layer, handle, opts) {
        return [
            ...head('POINT', handle, layer, opts),
            '10', num(pos.x), '20', num(pos.y), '30', num(pos.z || 0),
        ];
    }

    /** ELLIPSE: center, majorEnd (relative to center), axisRatio, start/end params (rad). */
    function emitEllipse(center, majorEnd, ratio, startParam, endParam, layer, handle, opts) {
        return [
            ...head('ELLIPSE', handle, layer, opts),
            '100', 'AcDbEllipse',
            '10', num(center.x), '20', num(center.y), '30', '0',
            '11', num(majorEnd.x), '21', num(majorEnd.y), '31', '0',
            '40', num(ratio),
            '41', num(startParam ?? 0),
            '42', num(endParam ?? Math.PI * 2),
        ];
    }

    /**
     * LEADER: one real DXF leader entity. The arrowhead is NOT geometry — the
     * reading CAD generates it from the dimension style (71 = 1). 340 hard-
     * references the associated annotation (MTEXT) when present; without one
     * the creation flag (73) says 'no annotation'.
     */
    function emitLeader(vertices, textHeight, annotationHandle, layer, handle, opts) {
        const vs = (vertices || []).filter(v => Number.isFinite(v?.x) && Number.isFinite(v?.y));
        if (vs.length < 2) return [];
        const pairs = [
            ...head('LEADER', handle, layer, opts),
            '100', 'AcDbLeader',
            '3', 'STANDARD',                       // dimension style
            '71', '1',                             // arrowhead enabled
            '72', '0',                             // straight-line path
            '73', annotationHandle ? '0' : '3',    // 0 = mtext annotation, 3 = none
            '74', '0',
            '75', annotationHandle ? '1' : '0',    // hookline in text direction
            '40', num(textHeight || 0),
            '41', '0',
            '76', String(vs.length),
        ];
        for (const v of vs) pairs.push('10', num(v.x), '20', num(v.y), '30', '0');
        if (annotationHandle) pairs.push('340', String(annotationHandle));
        return pairs;
    }

    /**
     * WIPEOUT: a raster-image-derived entity with no image. The frame is the
     * polygon's bounding box (10 = insertion, 11/12 = full-extent u/v vectors,
     * 13 = unit image size); the polygon itself is the polygonal clip boundary
     * (71 = 2) in image coordinates: x' = (x-min)/w - 0.5, y' = 0.5 - (y-min)/h,
     * first vertex repeated to close. This is the form AutoCAD and ezdxf write.
     */
    function emitWipeout(vertices, layer, handle, opts) {
        const vs = (vertices || []).filter(v => Number.isFinite(v?.x) && Number.isFinite(v?.y));
        if (vs.length < 3) return [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const v of vs) {
            minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
            minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
        }
        const sx = Math.max(maxX - minX, 1e-9);
        const sy = Math.max(maxY - minY, 1e-9);
        const pairs = [
            ...head('WIPEOUT', handle, layer, opts),
            '100', 'AcDbWipeout',
            '90', '0',
            '10', num(minX), '20', num(minY), '30', '0',
            '11', num(sx), '21', '0', '31', '0',
            '12', '0', '22', num(sy), '32', '0',
            '13', '1', '23', '1',
            '340', '0',
            '70', '7',
            '280', '1',
            '281', '50', '282', '50', '283', '0',
            '360', '0',
            '71', '2',
            '91', String(vs.length + 1),
        ];
        const clip = (v) => [
            '14', num((v.x - minX) / sx - 0.5),
            '24', num(0.5 - (v.y - minY) / sy),
        ];
        for (const v of vs) pairs.push(...clip(v));
        pairs.push(...clip(vs[0]));   // closed boundary repeats the first vertex
        return pairs;
    }

    // ===== SPLINE: interpolation + emission =====

    /**
     * Global cubic B-spline interpolation through `fit` points (Piegl & Tiller
     * §9.2.1): chord-length parameters, averaged clamped knot vector, and a
     * linear solve for the control points so the curve passes EXACTLY through
     * every fit point. Returns { degree, knots, controlPoints } or null for
     * fewer than 2 distinct points. 2–3 points fall back to lower degree.
     */
    function interpolateBSpline(fit) {
        const pts = (fit || []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
        const n = pts.length;
        if (n < 2) return null;
        const degree = Math.min(3, n - 1);

        // Chord-length parameterization.
        const t = [0];
        let total = 0;
        for (let i = 1; i < n; i++) {
            total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
            t.push(total);
        }
        if (!(total > 0)) return null;
        for (let i = 0; i < n; i++) t[i] /= total;

        // Clamped knot vector with internal knots by averaging.
        const p = degree;
        const m = n + p + 1;
        const knots = new Array(m).fill(0);
        for (let i = m - p - 1; i < m; i++) knots[i] = 1;
        for (let j = 1; j <= n - p - 1; j++) {
            let s = 0;
            for (let i = j; i <= j + p - 1; i++) s += t[i];
            knots[j + p] = s / p;
        }

        // Cox–de Boor basis functions at parameter u.
        function basis(u) {
            const N = new Array(n).fill(0);
            // Find the knot span (clamp the end so u=1 lands in the last span).
            let span = m - p - 2;
            if (u < 1) {
                for (let i = p; i < m - p - 1; i++) {
                    if (u >= knots[i] && u < knots[i + 1]) { span = i; break; }
                }
            }
            const left = new Array(p + 1).fill(0);
            const right = new Array(p + 1).fill(0);
            const Nl = new Array(p + 1).fill(0);
            Nl[0] = 1;
            for (let j = 1; j <= p; j++) {
                left[j] = u - knots[span + 1 - j];
                right[j] = knots[span + j] - u;
                let saved = 0;
                for (let r = 0; r < j; r++) {
                    const denom = right[r + 1] + left[j - r];
                    const temp = denom !== 0 ? Nl[r] / denom : 0;
                    Nl[r] = saved + right[r + 1] * temp;
                    saved = left[j - r] * temp;
                }
                Nl[j] = saved;
            }
            for (let j = 0; j <= p; j++) N[span - p + j] = Nl[j];
            return N;
        }

        // Solve A · P = Q (A is n×n, banded; plain Gaussian elimination — fit
        // point counts here are small).
        const A = [];
        for (let i = 0; i < n; i++) A.push(basis(t[i]));
        const qx = pts.map(pt => pt.x), qy = pts.map(pt => pt.y);
        for (let col = 0; col < n; col++) {
            // Partial pivot.
            let piv = col;
            for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
            if (Math.abs(A[piv][col]) < 1e-12) return null;
            if (piv !== col) {
                [A[piv], A[col]] = [A[col], A[piv]];
                [qx[piv], qx[col]] = [qx[col], qx[piv]];
                [qy[piv], qy[col]] = [qy[col], qy[piv]];
            }
            for (let r = col + 1; r < n; r++) {
                const f = A[r][col] / A[col][col];
                if (!f) continue;
                for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
                qx[r] -= f * qx[col];
                qy[r] -= f * qy[col];
            }
        }
        const ctrl = new Array(n);
        for (let r = n - 1; r >= 0; r--) {
            let sx = qx[r], sy = qy[r];
            for (let c = r + 1; c < n; c++) { sx -= A[r][c] * ctrl[c].x; sy -= A[r][c] * ctrl[c].y; }
            ctrl[r] = { x: sx / A[r][r], y: sy / A[r][r] };
        }
        return { degree, knots, controlPoints: ctrl };
    }

    /**
     * SPLINE entity: emitted with BOTH the interpolated control-point form
     * (knots + control points — what strict readers require) and the original
     * fit points (what editors show as grips).
     */
    function emitSpline(fitPoints, layer, handle, opts) {
        const interp = interpolateBSpline(fitPoints);
        if (!interp) return [];
        const { degree, knots, controlPoints } = interp;
        const pairs = [
            ...head('SPLINE', handle, layer, opts),
            '100', 'AcDbSpline',
            '210', '0', '220', '0', '230', '1',
            '70', '8',                                  // planar
            '71', String(degree),
            '72', String(knots.length),
            '73', String(controlPoints.length),
            '74', String(fitPoints.length),
        ];
        for (const k of knots) pairs.push('40', num(k));
        for (const c of controlPoints) pairs.push('10', num(c.x), '20', num(c.y), '30', '0');
        for (const f of fitPoints) pairs.push('11', num(f.x), '21', num(f.y), '31', '0');
        return pairs;
    }

    /**
     * Emit ONE entity by inspecting its type. Returns [] for anything unsupported.
     * `entity` uses the viewer's in-memory shape (vertices arrays, center, radius…).
     * A shared handle allocator is passed so nested output stays unique.
     */
    function emitEntity(entity, layer, allocHandle, opts) {
        if (!entity) return [];
        const h = allocHandle();
        const L = layer || entity.layer || '0';
        opts = entityStyleOpts(opts, entity);
        switch (entity.type) {
            case 'LINE':
                if (entity.vertices?.length >= 2)
                    return emitLine(entity.vertices[0], entity.vertices[1], L, h, opts);
                return [];
            case 'LWPOLYLINE':
            case 'POLYLINE':
                if (entity.vertices?.length >= 2)
                    return emitLwPolyline(entity.vertices, !!(entity.shape || entity.closed), L, h, opts);
                return [];
            case 'CIRCLE':
                return emitCircle(entity.center, entity.radius, L, h, opts);
            case 'ARC': {
                const sd = (entity.startAngle ?? 0) * 180 / Math.PI;
                const ed = (entity.endAngle ?? 0) * 180 / Math.PI;
                return emitArc(entity.center, entity.radius, sd, ed, L, h, opts);
            }
            case 'POINT':
                return emitPoint(entity.position || entity.startPoint || { x: 0, y: 0 }, L, h, opts);
            case 'ELLIPSE': {
                const c = entity.center || { x: 0, y: 0 };
                const me = entity.majorAxisEndPoint || { x: 1, y: 0 };
                return emitEllipse(c, me, entity.axisRatio ?? entity.ratio ?? 1,
                    entity.startAngle ?? 0, entity.endAngle ?? Math.PI * 2, L, h, opts);
            }
            case 'SPLINE': {
                const fit = entity.fitPoints?.length ? entity.fitPoints : entity.controlPoints;
                return emitSpline(fit || [], L, h, opts);
            }
            case 'LEADER':
                return emitLeader(entity.vertices || [], entity.textHeight,
                    entity.__annotationHandle ?? entity.annotationHandle, L, h, opts);
            case 'WIPEOUT':
                return emitWipeout(entity.vertices || [], L, h, opts);
            case 'TEXT':
                return emitText(entity.startPoint || entity.position || { x: 0, y: 0 },
                    entity.textHeight || entity.height || 1, entity.text ?? entity.string ?? '',
                    L, h, (entity.rotation || 0) * (Math.abs(entity.rotation || 0) > Math.PI * 2 ? 1 : 180 / Math.PI), opts);
            case 'MTEXT':
                return emitMText(entity.position || entity.startPoint || { x: 0, y: 0 },
                    entity.textHeight || entity.height || 1, entity.text ?? '', L, h, opts);
            case 'INSERT':
                return emitInsert(entity.name || entity.block || entity.blockName,
                    entity.position || entity.insertPoint || { x: 0, y: 0 },
                    entity.xScale ?? 1, entity.yScale ?? 1,
                    (entity.rotation || 0), L, h, opts);
            case 'ACAD_TABLE':
                return emitAcadTable(entity, L, h, opts);
            default:
                return [];
        }
    }

    /**
     * A complete BLOCK…ENDBLK definition wrapping the given child entities.
     * handles: { blockHandle, endblkHandle } + an allocHandle() for children.
     * basePoint defaults to the origin.
     */
    function emitBlockDef(name, children, basePoint, handles, allocHandle) {
        const bp = basePoint || { x: 0, y: 0 };
        const out = [
            '0', 'BLOCK', '5', handles.blockHandle, '8', '0',
            '100', 'AcDbEntity', '100', 'AcDbBlockBegin',
            '2', name, '70', '0',
            '10', num(bp.x), '20', num(bp.y), '30', '0',
            '3', name, '1', '',
        ];
        for (const child of children || []) out.push(...emitEntity(child, child.layer || '0', allocHandle, null));
        out.push('0', 'ENDBLK', '5', handles.endblkHandle, '8', '0',
                 '100', 'AcDbEntity', '100', 'AcDbBlockEnd');
        return out;
    }

    /** A BLOCK_RECORD table entry (goes inside the BLOCK_RECORD table). */
    function emitBlockRecord(name, handle) {
        return [
            '0', 'BLOCK_RECORD', '5', String(handle),
            '100', 'AcDbSymbolTableRecord', '100', 'AcDbBlockTableRecord',
            '2', String(name), '70', '0',
        ];
    }

    /**
     * The AcDbTable subclass region of a table entity: everything from the
     * '100 AcDbTable' marker to the end of the entity, classic (pre-2007)
     * inline-cell layout. Shared by two writers: the full-entity emitter for
     * NEW tables, and the host's 'tableRewrite' raw patch, which replaces
     * exactly this region on IMPORTED tables after a structural edit
     * (add/remove row/column, column resize).
     * Cell order is row-major. A merge root carries its span in 175/176;
     * covered cells emit 173=1 with no text. Alignment (170) and per-cell
     * text height (140) are written only when set, so untouched cells stay
     * byte-minimal.
     */
    function acadTableSubclassPairs(e) {
        const rot = (Number(e.rotation) || 0) * Math.PI / 180;
        const pairs = ['100', 'AcDbTable'];
        if (e.tableStyleHandle) pairs.push('342', String(e.tableStyleHandle));
        pairs.push('90', '22');
        pairs.push('11', num(Math.cos(rot)), '21', num(Math.sin(rot)), '31', '0');
        pairs.push('92', String(e.cols || 0), '91', String(e.rows || 0));
        for (const cw of e.colWidths || []) pairs.push('142', num(cw));
        for (const rh of e.rowHeights || []) pairs.push('141', num(rh));
        for (const cell of e.cells || []) {
            const covered = !!cell.covered;
            const type = cell.type === 2 ? 2 : 1;
            pairs.push('171', String(type));
            pairs.push('172', '0');
            pairs.push('173', covered ? '1' : '0');
            pairs.push('174', '0');
            pairs.push('175', String(covered ? 1 : (cell.spanC || 1)));
            pairs.push('176', String(covered ? 1 : (cell.spanR || 1)));
            pairs.push('177', '0');
            pairs.push('178', '0');
            pairs.push('145', '0');
            // Covered cells keep their content too: it is invisible while the
            // merge stands, but unmerging (now or in AutoCAD) restores it.
            if (cell.align) pairs.push('170', String(cell.align));
            if (cell.textHeight) pairs.push('140', num(cell.textHeight));
            if (type === 1) pairs.push('1', String(cell.text ?? ''));
        }
        return pairs;
    }

    // Full ACAD_TABLE entity: header + AcDbBlockReference (name, insertion,
    // rotation) + the shared AcDbTable region. The referenced *T block must
    // exist in BLOCKS — the host registers a generated one for new tables.
    function emitAcadTable(e, layer, handle, opts) {
        const pairs = head('ACAD_TABLE', handle, layer, opts);
        pairs.push('100', 'AcDbBlockReference');
        if (e.blockName) pairs.push('2', String(e.blockName));
        const p = e.position || { x: 0, y: 0 };
        pairs.push('10', num(p.x), '20', num(p.y), '30', '0');
        if (Number(e.rotation)) pairs.push('50', num(Number(e.rotation)));
        return pairs.concat(acadTableSubclassPairs(e));
    }

    const DxfEmit = {
        num, emitLine, emitLwPolyline, entityStyleOpts, emitCircle, emitArc, emitText, emitMText,
        emitViewport, emitInsert, emitPoint, emitEllipse,
        emitEntity, emitBlockDef, emitBlockRecord,
        acadTableSubclassPairs, emitAcadTable,
        interpolateBSpline, emitSpline, emitLeader, emitWipeout,
        arcFrom3Points,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = DxfEmit;
    if (root) root.DxfEmit = DxfEmit;
})(typeof window !== 'undefined' ? window : null);
