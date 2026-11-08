/**
 * dxf-ocs.js — mirrored (negative-extrusion) entities.
 *
 * Some entity types store their coordinates in an Object Coordinate System
 * (OCS) whose plane normal is the extrusion direction (codes 210/220/230).
 * With the normal (0,0,-1) — what mirroring tools and many converters write —
 * the OCS X axis points the other way: world x = -ocs x, and arcs sweep
 * clockwise on screen. dxf-parser keeps the raw OCS values (and does not read
 * the extrusion of CIRCLE or ELLIPSE at all), so such entities render mirrored.
 *
 * This module rewrites those entities, in memory, into the equivalent
 * world-aligned form (normal +Z) and returns the raw patches that make the
 * saved file agree with memory. Pure: no DOM. window.DxfOcs + Node exports.
 *
 *   scanExtrusions(rawText) → { byKey: Map, byHandle: Map }   (only non-default normals)
 *       keys follow the editor's raw indexing: "E:<n>" in ENTITIES,
 *       "B:<block>:<n>" in BLOCKS (BLOCK/ENDBLK not counted).
 *   normalizeEntity(entity, normal) → { ops } | null
 *       mutates `entity`; ops are geometry patches for the editor's save path.
 *       null = not handled (type left as is).
 *   normalizeDrawing(dxf, rawText) → { normalized, unsupported:{TYPE:n} }
 *       read-only callers (DXF Compare): normalize by handle, no patches kept.
 *
 * Handled: CIRCLE, ARC, LWPOLYLINE, ELLIPSE, INSERT with a normal of exactly (0,0,-1).
 * Reported as unsupported: TEXT, ATTRIB, ATTDEF, HATCH, SOLID, TRACE,
 * POLYLINE (2D), and any tilted normal on an OCS type. LINE, POINT, SPLINE,
 * MTEXT and DIMENSION store world coordinates and need nothing.
 */
(function (root) {
    'use strict';

    const TAU = Math.PI * 2;
    const AXIS_EPS = 1e-9;

    const HANDLED = new Set(['CIRCLE', 'ARC', 'LWPOLYLINE', 'ELLIPSE', 'INSERT']);
    // OCS types this module does not rewrite yet; counted so the UI can say so.
    const OCS_UNSUPPORTED = new Set(['TEXT', 'ATTRIB', 'ATTDEF', 'HATCH', 'SOLID', 'TRACE', 'POLYLINE', 'SHAPE']);

    const typeOf = (e) => String(e && e.type || '').toUpperCase();
    const fin = Number.isFinite;

    /** True for the plain mirrored normal (0,0,-1). */
    function isFlippedZ(n) {
        return !!n && Math.abs(n.x || 0) < AXIS_EPS && Math.abs(n.y || 0) < AXIS_EPS && n.z < 0;
    }

    /** Any normal other than (0,0,1). */
    function isNonDefault(n) {
        return !!n && (Math.abs(n.x || 0) > AXIS_EPS || Math.abs(n.y || 0) > AXIS_EPS || !(n.z > 0) || Math.abs(n.z - 1) > 1e-9);
    }

    function normAngle(a) { return ((a % TAU) + TAU) % TAU; }
    const deg = (r) => r * 180 / Math.PI;
    const round = (v) => Math.round(v * 1e12) / 1e12;   // keep "-0" and float dust out of patches

    // ------------------------------------------------------------ raw scan

    /**
     * Walk the raw DXF and collect every entity whose extrusion is not +Z.
     * The indexing mirrors the editor's assignRawEntityIndices exactly, so the
     * keys line up with each parsed entity's __rawKey.
     */
    function scanExtrusions(rawText) {
        const byKey = new Map(), byHandle = new Map();
        if (!rawText) return { byKey, byHandle };
        const lines = String(rawText).replace(/\r\n/g, '\n').split('\n');
        let i = 0, section = null, entityIdx = 0, blockName = null, blockIdx = 0;
        while (i < lines.length) {
            const code = (lines[i] ?? '').trim();
            const value = (lines[i + 1] ?? '').trim();
            if (code === '0' && value.toUpperCase() === 'SECTION') {
                const c2 = (lines[i + 2] ?? '').trim();
                section = c2 === '2' ? (lines[i + 3] ?? '').trim().toUpperCase() : null;
                entityIdx = 0; blockName = null;
                i += 4; continue;
            }
            if (code === '0' && value.toUpperCase() === 'ENDSEC') { section = null; blockName = null; i += 2; continue; }
            const inEntities = section === 'ENTITIES', inBlocks = section === 'BLOCKS';
            if ((inEntities || inBlocks) && code === '0') {
                const type = value.toUpperCase();
                let j = i + 2, handle = '', name = null;
                let nx = 0, ny = 0, nz = 1, sawNormal = false;
                while (j < lines.length) {
                    const c = (lines[j] ?? '').trim();
                    if (c === '0') break;
                    const v = (lines[j + 1] ?? '').trim();
                    if (c === '5' && !handle) handle = v.toUpperCase();
                    else if (type === 'BLOCK' && c === '2' && name === null) name = v;
                    else if (c === '210') { nx = Number(v); sawNormal = true; }
                    else if (c === '220') { ny = Number(v); sawNormal = true; }
                    else if (c === '230') { nz = Number(v); sawNormal = true; }
                    j += 2;
                }
                let key = null;
                if (inBlocks) {
                    if (type === 'BLOCK') { blockName = name; blockIdx = 0; }
                    else if (type === 'ENDBLK') { blockName = null; }
                    else if (blockName !== null) { key = `B:${blockName}:${blockIdx}`; blockIdx++; }
                } else {
                    key = `E:${entityIdx}`; entityIdx++;
                }
                if (key && sawNormal) {
                    const n = { x: fin(nx) ? nx : 0, y: fin(ny) ? ny : 0, z: fin(nz) ? nz : 1, type };
                    if (isNonDefault(n)) {
                        byKey.set(key, n);
                        if (handle) byHandle.set(handle, n);
                    }
                }
                i = j; continue;
            }
            i++;
        }
        return { byKey, byHandle };
    }

    // ------------------------------------------------------- normalization

    function setNormalUp(e) {
        if ('extrusionDirectionX' in e) e.extrusionDirectionX = 0;
        if ('extrusionDirectionY' in e) e.extrusionDirectionY = 0;
        e.extrusionDirectionZ = 1;
        if (e.extrusionDirection && typeof e.extrusionDirection === 'object') {
            e.extrusionDirection = { x: 0, y: 0, z: 1 };
        }
    }

    /**
     * Rewrite one mirrored entity into world-aligned form.
     * Returns { ops } with the raw patches, or null when not handled.
     *   CIRCLE      center.x → -x
     *   ARC         center.x → -x; CCW start/end in OCS become CCW (π-end)..(π-start)
     *   LWPOLYLINE  every x → -x, every bulge → -bulge (vertex order kept)
     *   ELLIPSE     world center/axis unchanged; parameters run the other way:
     *               [s, e] → [2π-e, 2π-s]
     * OCS elevation (z) flips sign along with the normal.
     */
    function normalizeEntity(e, normal) {
        const t = typeOf(e);
        if (!HANDLED.has(t) || !isFlippedZ(normal)) return null;
        const up = { '230': 1 };

        if (t === 'INSERT') {
            const p = e.position;
            if (!p || !fin(p.x) || !fin(p.y)) return null;
            // Reflect the entire INSERT transform, including its origin:
            // F * T(p) * R(a) * S = T(Fp) * R(-a) * F * S.
            // Keep the block definition/base point in its own coordinates.
            p.x = round(-p.x);
            e.rotation = round(-(Number(e.rotation) || 0));
            e.xScale = -(e.xScale ?? 1);
            e.zScale = -(e.zScale ?? 1);
            const patch = { '10': p.x, '41': e.xScale, '43': e.zScale, '50': e.rotation, ...up };
            if (fin(p.z) && p.z !== 0) { p.z = round(-p.z); patch['30'] = p.z; }
            setNormalUp(e);
            return { ops: [patch] };
        }

        if (t === 'CIRCLE' || t === 'ARC') {
            const c = e.center;
            if (!c || !fin(c.x) || !fin(c.y)) return null;
            c.x = round(-c.x);
            const patch = { '10': c.x };
            if (fin(c.z) && c.z !== 0) { c.z = round(-c.z); patch['30'] = c.z; }
            if (t === 'ARC') {
                const s = Number(e.startAngle) || 0, en = Number(e.endAngle) || 0;
                const ns = normAngle(Math.PI - en), ne = normAngle(Math.PI - s);
                e.startAngle = ns;
                e.endAngle = ne;
                if ('angleLength' in e) e.angleLength = normAngle(ne - ns) || TAU;
                patch['50'] = round(deg(ns));
                patch['51'] = round(deg(ne));
            }
            setNormalUp(e);
            return { ops: [Object.assign(patch, up)] };
        }

        if (t === 'LWPOLYLINE') {
            const vs = e.vertices;
            if (!Array.isArray(vs) || !vs.length) return null;
            for (const v of vs) {
                if (fin(v.x)) v.x = round(-v.x);
                if (fin(v.bulge) && v.bulge) v.bulge = -v.bulge;
            }
            const extra = Object.assign({}, up);
            if (fin(e.elevation) && e.elevation !== 0) { e.elevation = round(-e.elevation); extra['38'] = e.elevation; }
            setNormalUp(e);
            return {
                ops: [
                    {
                        type: 'polyline',
                        closed: !!(e.shape || e.closed),
                        vertices: vs.map(v => ({ x: v.x, y: v.y, bulge: Number(v.bulge) || 0, startWidth: v.startWidth, endWidth: v.endWidth })),
                    },
                    extra,
                ],
            };
        }

        if (t === 'ELLIPSE') {
            const s = fin(e.startAngle) ? Number(e.startAngle) : 0;
            const en = fin(e.endAngle) ? Number(e.endAngle) : TAU;
            const full = Math.abs(Math.abs(en - s) - TAU) < 1e-9 || Math.abs(en - s) < 1e-12;
            if (!full) {
                let ns = normAngle(TAU - en), ne = normAngle(TAU - s);
                if (ne <= ns) ne += TAU;
                e.startAngle = ns;
                e.endAngle = ne;
                setNormalUp(e);
                return { ops: [Object.assign({ '41': round(ns), '42': round(ne) }, up)] };
            }
            setNormalUp(e);
            return { ops: [Object.assign({}, up)] };
        }
        return null;
    }

    /** True when an entity of this type with this normal would display wrong. */
    function isUnsupportedMirror(type, normal) {
        const t = String(type || '').toUpperCase();
        if (OCS_UNSUPPORTED.has(t)) return true;
        return HANDLED.has(t) && !isFlippedZ(normal);   // tilted plane
    }

    /**
     * Read-only normalization for a parsed drawing (DXF Compare): matches by
     * handle, rewrites what it can, counts the rest.
     */
    function normalizeDrawing(dxf, rawText) {
        const out = { normalized: 0, unsupported: {} };
        if (!dxf) return out;
        const { byHandle } = scanExtrusions(rawText);
        if (!byHandle.size) return out;
        const visit = (list) => {
            for (const e of list || []) {
                if (!e) continue;
                const h = typeof e.handle === 'string' ? e.handle.toUpperCase() : '';
                const n = h && byHandle.get(h);
                if (!n) continue;
                if (normalizeEntity(e, n)) out.normalized++;
                else if (isUnsupportedMirror(e.type, n)) out.unsupported[typeOf(e)] = (out.unsupported[typeOf(e)] || 0) + 1;
            }
        };
        visit(dxf.entities);
        for (const b of Object.values(dxf.blocks || {})) visit(b && b.entities);
        return out;
    }

    const DxfOcs = { scanExtrusions, normalizeEntity, normalizeDrawing, isFlippedZ, isUnsupportedMirror };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfOcs;
    if (root) root.DxfOcs = DxfOcs;
})(typeof window !== 'undefined' ? window : null);
