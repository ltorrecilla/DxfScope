/**
 * dxf_region.js — "pick an internal point" boundary detection for HATCH.
 *
 * Builds a planar arrangement from lines and arcs (exact splits, arcs stay
 * arcs), walks its faces and returns the smallest closed face around a point,
 * plus the islands inside it, as HATCH polyline paths (bulges for arcs).
 *
 *   buildArrangement(prims, opts) → arrangement (reuse it for several picks)
 *       prims: { kind:'line', a:{x,y}, b:{x,y} }
 *            | { kind:'arc', c:{x,y}, r, a0, a1 }      radians, CCW from a0 to a1
 *            | { kind:'circle', c:{x,y}, r }
 *            (bulgeArc(p, q, bulge) turns a polyline bulge span into an arc)
 *       opts.gap      gap tolerance (drawing units); 0 = boundaries must close
 *                     exactly, like AutoCAD's HPGAPTOL default
 *   regionAt(arr, point, opts) →
 *       { ok:true, paths:[hatch path], rings:[[{x,y}]], area, face }
 *     | { ok:false, reason:'notClosed'|'empty', looseEnds:[{x,y}] }
 *       opts.islands  (default true) include closed shapes inside the region
 *       opts.exclude  face ids already used (a second click in the same face)
 *   Each primitive may carry a .src tag; every returned path lists the tags of
 *   the primitives its loop uses in path.sources (associative hatches).
 *
 * Pure, no DOM. window.DxfRegion + Node exports.
 */
(function (root) {
    'use strict';

    const TAU = Math.PI * 2;
    const fin = Number.isFinite;
    const normAng = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };

    // ------------------------------------------------------------ primitives
    // Internal form: line {k:'L', ax, ay, bx, by, len}
    //                arc  {k:'A', cx, cy, r, s, sw, len, full}  (CCW, 0 < sw ≤ TAU)

    function bulgeArc(p, q, bulge) {
        const b = Number(bulge) || 0;
        const dx = q.x - p.x, dy = q.y - p.y;
        const chord = Math.hypot(dx, dy);
        if (Math.abs(b) < 1e-12 || !(chord > 0)) return { kind: 'line', a: { x: p.x, y: p.y }, b: { x: q.x, y: q.y } };
        const theta = 4 * Math.atan(b);                 // signed sweep, + = CCW from p to q
        const r = Math.abs(chord / (2 * Math.sin(theta / 2)));
        const h = r * Math.cos(theta / 2);
        const cx = (p.x + q.x) / 2 - (dy / chord) * h * Math.sign(theta);
        const cy = (p.y + q.y) / 2 + (dx / chord) * h * Math.sign(theta);
        const ap = Math.atan2(p.y - cy, p.x - cx), aq = Math.atan2(q.y - cy, q.x - cx);
        // Stored CCW: from p to q when the bulge is positive, else from q to p.
        return theta > 0 ? { kind: 'arc', c: { x: cx, y: cy }, r, a0: ap, a1: aq }
            : { kind: 'arc', c: { x: cx, y: cy }, r, a0: aq, a1: ap };
    }

    function toInternal(p) {
        if (!p) return null;
        if (p.kind === 'line') {
            const ax = +p.a.x, ay = +p.a.y, bx = +p.b.x, by = +p.b.y;
            if (![ax, ay, bx, by].every(fin)) return null;
            return { k: 'L', ax, ay, bx, by, len: Math.hypot(bx - ax, by - ay), src: p.src };
        }
        if (p.kind === 'circle' || p.kind === 'arc') {
            const cx = +p.c.x, cy = +p.c.y, r = Math.abs(+p.r);
            if (![cx, cy, r].every(fin) || !(r > 0)) return null;
            let s = 0, sw = TAU;
            if (p.kind === 'arc') {
                s = normAng(+p.a0 || 0);
                sw = normAng((+p.a1 || 0) - s);
                if (sw < 1e-12) sw = TAU;
            }
            return { k: 'A', cx, cy, r, s, sw, len: r * sw, full: sw >= TAU - 1e-12, src: p.src };
        }
        return null;
    }

    function pointAt(g, t) {
        if (g.k === 'L') return { x: g.ax + (g.bx - g.ax) * t, y: g.ay + (g.by - g.ay) * t };
        const a = g.s + g.sw * t;
        return { x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) };
    }

    /** Parameter of a point known to be on (or very near) the primitive. */
    function paramOf(g, x, y) {
        if (g.k === 'L') {
            const dx = g.bx - g.ax, dy = g.by - g.ay, L2 = dx * dx + dy * dy;
            return L2 > 0 ? ((x - g.ax) * dx + (y - g.ay) * dy) / L2 : 0;
        }
        const d = normAng(Math.atan2(y - g.cy, x - g.cx) - g.s);
        if (g.full) return d / TAU;
        if (d <= g.sw) return d / g.sw;
        // Past the end: whichever end is closer in angle.
        return (d - g.sw) < (TAU - d) ? 1 : 0;
    }

    function closestOn(g, x, y) {
        if (g.k === 'L') {
            const t = Math.max(0, Math.min(1, paramOf(g, x, y)));
            const p = pointAt(g, t);
            return { t, x: p.x, y: p.y, d: Math.hypot(p.x - x, p.y - y) };
        }
        let t = paramOf(g, x, y);
        const d0 = normAng(Math.atan2(y - g.cy, x - g.cx) - g.s);
        if (!g.full && d0 > g.sw) t = (d0 - g.sw) < (TAU - d0) ? 1 : 0;
        const p = pointAt(g, t);
        return { t, x: p.x, y: p.y, d: Math.hypot(p.x - x, p.y - y) };
    }

    function bbox(g) {
        if (g.k === 'L') return [Math.min(g.ax, g.bx), Math.min(g.ay, g.by), Math.max(g.ax, g.bx), Math.max(g.ay, g.by)];
        return [g.cx - g.r, g.cy - g.r, g.cx + g.r, g.cy + g.r];
    }

    function angleOnArc(g, ang, tolA) {
        if (g.full) return true;
        const d = normAng(ang - g.s);
        return d <= g.sw + tolA || d >= TAU - tolA;
    }

    // ---------------------------------------------------------- intersections

    function intersect(g, h, eps) {
        const out = [];
        if (g.k === 'L' && h.k === 'L') {
            const rx = g.bx - g.ax, ry = g.by - g.ay, sx = h.bx - h.ax, sy = h.by - h.ay;
            const d = rx * sy - ry * sx;
            if (Math.abs(d) <= 1e-14 * (g.len * h.len || 1)) return out;    // parallel: ends handled separately
            const qx = h.ax - g.ax, qy = h.ay - g.ay;
            const t = (qx * sy - qy * sx) / d, u = (qx * ry - qy * rx) / d;
            const tt = eps / (g.len || 1), tu = eps / (h.len || 1);
            if (t >= -tt && t <= 1 + tt && u >= -tu && u <= 1 + tu) out.push({ x: g.ax + rx * t, y: g.ay + ry * t });
            return out;
        }
        if (g.k === 'A' && h.k === 'L') return intersect(h, g, eps);
        if (g.k === 'L' && h.k === 'A') {
            const dx = g.bx - g.ax, dy = g.by - g.ay, L = g.len;
            if (!(L > 0)) return out;
            const ux = dx / L, uy = dy / L;
            const fx = g.ax - h.cx, fy = g.ay - h.cy;
            const along = -(fx * ux + fy * uy);                 // foot of the centre on the line
            const px = g.ax + ux * along, py = g.ay + uy * along;
            const dist = Math.hypot(px - h.cx, py - h.cy);
            if (dist > h.r + eps) return out;
            const pts = [];
            if (Math.abs(dist - h.r) <= eps) pts.push({ x: px, y: py, s: along });
            else {
                const k = Math.sqrt(Math.max(0, h.r * h.r - dist * dist));
                pts.push({ x: px - ux * k, y: py - uy * k, s: along - k }, { x: px + ux * k, y: py + uy * k, s: along + k });
            }
            const tolA = eps / h.r;
            for (const p of pts) {
                if (p.s < -eps || p.s > L + eps) continue;
                if (!angleOnArc(h, Math.atan2(p.y - h.cy, p.x - h.cx), tolA)) continue;
                out.push({ x: p.x, y: p.y });
            }
            return out;
        }
        // arc / arc
        const dx = h.cx - g.cx, dy = h.cy - g.cy, d = Math.hypot(dx, dy);
        if (d < eps) return out;                                 // concentric: ends handled separately
        if (d > g.r + h.r + eps || d < Math.abs(g.r - h.r) - eps) return out;
        const a = (g.r * g.r - h.r * h.r + d * d) / (2 * d);
        const h2 = g.r * g.r - a * a;
        const hh = h2 > 0 ? Math.sqrt(h2) : 0;
        const mx = g.cx + dx * a / d, my = g.cy + dy * a / d;
        const pts = hh * hh <= eps * eps ? [{ x: mx, y: my }]
            : [{ x: mx - dy * hh / d, y: my + dx * hh / d }, { x: mx + dy * hh / d, y: my - dx * hh / d }];
        for (const p of pts) {
            if (!angleOnArc(g, Math.atan2(p.y - g.cy, p.x - g.cx), eps / g.r)) continue;
            if (!angleOnArc(h, Math.atan2(p.y - h.cy, p.x - h.cx), eps / h.r)) continue;
            out.push(p);
        }
        return out;
    }

    function ends(g) {
        if (g.k === 'A' && g.full) return [];
        return [pointAt(g, 0), pointAt(g, 1)];
    }

    // Uniform grid over primitive boxes → candidate pairs.
    function makeGrid(items, boxOf, cellHint) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const boxes = items.map(boxOf);
        for (const b of boxes) { minX = Math.min(minX, b[0]); minY = Math.min(minY, b[1]); maxX = Math.max(maxX, b[2]); maxY = Math.max(maxY, b[3]); }
        const span = Math.max(maxX - minX, maxY - minY, 1e-9);
        const cell = Math.max(cellHint || span / Math.max(1, Math.sqrt(items.length)), span / 2048);
        const map = new Map();
        const cx = (x) => Math.floor((x - minX) / cell), cy = (y) => Math.floor((y - minY) / cell);
        boxes.forEach((b, i) => {
            const x0 = cx(b[0]), x1 = cx(b[2]), y0 = cy(b[1]), y1 = cy(b[3]);
            if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { (map.get('big') || map.set('big', []).get('big')).push(i); return; }
            for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
                const k = x + ',' + y;
                (map.get(k) || map.set(k, []).get(k)).push(i);
            }
        });
        return {
            near(b) {
                const set = new Set(map.get('big') || []);
                const x0 = cx(b[0]), x1 = cx(b[2]), y0 = cy(b[1]), y1 = cy(b[3]);
                if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { boxes.forEach((_, i) => set.add(i)); return set; }
                for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (const i of map.get(x + ',' + y) || []) set.add(i);
                return set;
            },
        };
    }

    // ------------------------------------------------------------ arrangement

    function buildArrangement(primsIn, opts) {
        const o = opts || {};
        let prims = (primsIn || []).map(toInternal).filter(Boolean);
        if (!prims.length) return { empty: true, faces: [], looseEnds: [] };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const g of prims) { const b = bbox(g); minX = Math.min(minX, b[0]); minY = Math.min(minY, b[1]); maxX = Math.max(maxX, b[2]); maxY = Math.max(maxY, b[3]); }
        const S = Math.max(maxX - minX, maxY - minY, Math.abs(minX), Math.abs(minY), Math.abs(maxX), Math.abs(maxY), 1e-9);
        const eps = Math.max(S * 1e-9, 1e-10);                  // "same point"
        prims = prims.filter(g => g.len > eps);
        const pad = (b, e) => [b[0] - e, b[1] - e, b[2] + e, b[3] + e];

        // Free ends: an end touching nothing else.
        const freeEnds = (list) => {
            const grid = makeGrid(list, g => pad(bbox(g), eps));
            const free = [];
            list.forEach((g, i) => {
                for (const [ei, p] of ends(g).entries()) {
                    let touched = false;
                    for (const j of grid.near([p.x - eps, p.y - eps, p.x + eps, p.y + eps])) {
                        if (j === i) continue;
                        if (closestOn(list[j], p.x, p.y).d <= eps * 4) { touched = true; break; }
                    }
                    if (!touched) free.push({ i, end: ei, x: p.x, y: p.y });
                }
            });
            return free;
        };

        // Gap tolerance: bridge each free end to the nearest free end (or curve) within reach.
        const gap = fin(o.gap) && o.gap > 0 ? o.gap : 0;
        if (gap > 0) {
            const free = freeEnds(prims);
            const grid = makeGrid(prims, g => pad(bbox(g), gap));
            const used = new Set();
            const bridges = [];
            for (const f of free) {
                if (used.has(f)) continue;
                let best = null, bestD = gap;
                for (const g of free) {
                    if (g === f || g.i === f.i || used.has(g)) continue;
                    const d = Math.hypot(g.x - f.x, g.y - f.y);
                    if (d <= bestD) { bestD = d; best = { x: g.x, y: g.y, other: g }; }
                }
                if (!best) {
                    for (const j of grid.near([f.x - gap, f.y - gap, f.x + gap, f.y + gap])) {
                        if (j === f.i) continue;
                        const c = closestOn(prims[j], f.x, f.y);
                        if (c.d <= bestD) { bestD = c.d; best = { x: c.x, y: c.y }; }
                    }
                }
                if (best && bestD > eps) {
                    used.add(f); if (best.other) used.add(best.other);
                    bridges.push({ k: 'L', ax: f.x, ay: f.y, bx: best.x, by: best.y, len: bestD, bridge: true });
                }
            }
            prims = prims.concat(bridges);
        }

        // Split parameters: crossings, plus any end lying on another curve (T-joints, overlaps).
        const params = prims.map(() => [0, 1]);
        const grid = makeGrid(prims, g => pad(bbox(g), eps));
        prims.forEach((g, i) => {
            for (const j of grid.near(pad(bbox(g), eps))) {
                if (j <= i) continue;
                const h = prims[j];
                for (const p of intersect(g, h, eps)) {
                    params[i].push(paramOf(g, p.x, p.y));
                    params[j].push(paramOf(h, p.x, p.y));
                }
                for (const p of ends(g)) { const c = closestOn(h, p.x, p.y); if (c.d <= eps * 4) params[j].push(c.t); }
                for (const p of ends(h)) { const c = closestOn(g, p.x, p.y); if (c.d <= eps * 4) params[i].push(c.t); }
            }
        });

        // Vertices (merged within eps) and edge pieces.
        const vx = [], vy = [];
        const vmap = new Map();
        const cell = eps * 8;
        const vertexAt = (x, y) => {
            const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
            for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
                for (const id of vmap.get((gx + a) + ',' + (gy + b)) || []) {
                    if (Math.hypot(vx[id] - x, vy[id] - y) <= eps * 4) return id;
                }
            }
            const id = vx.length;
            vx.push(x); vy.push(y);
            const k = gx + ',' + gy;
            (vmap.get(k) || vmap.set(k, []).get(k)).push(id);
            return id;
        };

        const edges = [];       // { u, v, g (piece, oriented u→v forward), len }
        const seen = new Map();
        prims.forEach((g, i) => {
            let ts = params[i].map(t => Math.max(0, Math.min(1, t))).sort((a, b) => a - b);
            const keep = [ts[0]];
            for (const t of ts) if ((t - keep[keep.length - 1]) * g.len > eps * 2) keep.push(t);
            if ((1 - keep[keep.length - 1]) * g.len <= eps * 2) keep[keep.length - 1] = 1; else keep.push(1);
            ts = keep;
            if (g.k === 'A' && g.full && ts.length < 3) ts = [0, 0.5, 1];
            for (let k = 0; k < ts.length - 1; k++) {
                const t0 = ts[k], t1 = ts[k + 1];
                const p0 = pointAt(g, t0), p1 = pointAt(g, t1);
                const u = vertexAt(p0.x, p0.y), v = vertexAt(p1.x, p1.y);
                const piece = g.k === 'L'
                    ? { k: 'L', ax: vx[u], ay: vy[u], bx: vx[v], by: vy[v], len: Math.hypot(vx[v] - vx[u], vy[v] - vy[u]) }
                    : { k: 'A', cx: g.cx, cy: g.cy, r: g.r, s: g.s + g.sw * t0, sw: g.sw * (t1 - t0), len: g.r * g.sw * (t1 - t0) };
                if (u === v) continue;                           // collapsed sliver
                // Overlapping duplicates (same ends, same midpoint) count once.
                const m = pointAt(piece, 0.5);
                const key = Math.min(u, v) + ':' + Math.max(u, v);
                const list = seen.get(key) || seen.set(key, []).get(key);
                if (list.some(q => Math.hypot(q.x - m.x, q.y - m.y) <= eps * 8)) continue;
                list.push(m);
                piece.src = g.src;
                edges.push({ u, v, g: piece, bridge: !!g.bridge });
            }
        });

        // Degrees; loose ends = degree-1 vertices (open boundary ends).
        const deg = new Array(vx.length).fill(0);
        for (const e of edges) { deg[e.u]++; deg[e.v]++; }
        const looseEnds = [];
        for (let i = 0; i < vx.length; i++) if (deg[i] === 1) looseEnds.push({ x: vx[i], y: vy[i] });
        // Prune dangling chains: they never bound a face.
        const alive = edges.map(() => true);
        const inc = vx.map(() => []);
        edges.forEach((e, i) => { inc[e.u].push(i); inc[e.v].push(i); });
        const stack = [];
        for (let i = 0; i < vx.length; i++) if (deg[i] === 1) stack.push(i);
        while (stack.length) {
            const v = stack.pop();
            if (deg[v] !== 1) continue;
            for (const ei of inc[v]) {
                if (!alive[ei]) continue;
                alive[ei] = false;
                const e = edges[ei];
                deg[e.u]--; deg[e.v]--;
                const w = e.u === v ? e.v : e.u;
                if (deg[w] === 1) stack.push(w);
                break;
            }
        }

        // Half-edges: 2i forward (u→v), 2i+1 backward.
        const H = [];
        const out = vx.map(() => []);
        edges.forEach((e, i) => {
            if (!alive[i]) return;
            const g = e.g;
            let fa, ba, fk, bk;
            if (g.k === 'L') {
                fa = Math.atan2(g.by - g.ay, g.bx - g.ax); ba = normAng(fa + Math.PI); fk = bk = 0;
            } else {
                fa = g.s + Math.PI / 2;                          // CCW tangent at start
                ba = g.s + g.sw - Math.PI / 2;                   // CW tangent at end
                fk = 1 / g.r; bk = -1 / g.r;
            }
            H[2 * i] = { id: 2 * i, from: e.u, to: e.v, e: i, fwd: true, ang: normAng(fa), curv: fk };
            H[2 * i + 1] = { id: 2 * i + 1, from: e.v, to: e.u, e: i, fwd: false, ang: normAng(ba), curv: bk };
            out[e.u].push(2 * i); out[e.v].push(2 * i + 1);
        });
        // CCW order around each vertex; equal tangents: the curve bending right first.
        const pos = new Map();
        for (let v = 0; v < out.length; v++) {
            const list = out[v];
            list.sort((a, b) => {
                const da = H[a].ang - H[b].ang;
                if (Math.abs(da) > 1e-10 && Math.abs(Math.abs(da) - TAU) > 1e-10) return da;
                return H[a].curv - H[b].curv;
            });
            list.forEach((h, k) => pos.set(h, k));
        }
        const twin = (h) => h ^ 1;
        const next = (h) => {
            const t = twin(h), v = H[h].to, list = out[v];
            const k = pos.get(t);
            return list[(k - 1 + list.length) % list.length];   // clockwise neighbour of the twin
        };

        // Face walk.
        const faceOf = new Map();
        const faces = [];
        for (const h0 of H) {
            if (!h0 || faceOf.has(h0.id)) continue;
            const loop = [];
            let h = h0.id, guard = 0;
            while (!faceOf.has(h) && guard++ < 1e6) { faceOf.set(h, faces.length); loop.push(h); h = next(h); }
            faces.push({ id: faces.length, loop });
        }

        const arr = { eps, vx, vy, edges, H, faces, looseEnds, comp: null };
        // Components (vertices joined by live edges).
        const parent = vx.map((_, i) => i);
        const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
        edges.forEach((e, i) => { if (alive[i]) parent[find(e.u)] = find(e.v); });
        for (const f of faces) {
            f.comp = find(H[f.loop[0]].from);
            f.area = loopArea(arr, f.loop);
            f.ring = loopRing(arr, f.loop);
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const p of f.ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
            f.box = [x0, y0, x1, y1];
        }
        // Outer (unbounded) face per component: the most negative one.
        arr.outerOf = new Map();
        for (const f of faces) {
            const cur = arr.outerOf.get(f.comp);
            if (f.area < 0 && (!cur || f.area < cur.area)) arr.outerOf.set(f.comp, f);
        }
        return arr;
    }

    // Geometry of a half-edge, in travel direction.
    function heGeom(arr, h) {
        const he = arr.H[h], g = arr.edges[he.e].g;
        return { g, fwd: he.fwd, p: { x: arr.vx[he.from], y: arr.vy[he.from] }, q: { x: arr.vx[he.to], y: arr.vy[he.to] } };
    }

    function loopArea(arr, loop) {
        let a = 0;
        for (const h of loop) {
            const { g, fwd, p, q } = heGeom(arr, h);
            a += (p.x * q.y - q.x * p.y) / 2;
            if (g.k === 'A') {
                const seg = g.r * g.r / 2 * (g.sw - Math.sin(g.sw));
                a += fwd ? seg : -seg;
            }
        }
        return a;
    }

    function loopRing(arr, loop) {
        const ring = [];
        for (const h of loop) {
            const { g, fwd, p } = heGeom(arr, h);
            ring.push(p);
            if (g.k === 'A') {
                const n = Math.max(2, Math.ceil(g.sw / (Math.PI / 36)));
                for (let k = 1; k < n; k++) {
                    const t = fwd ? k / n : 1 - k / n;
                    ring.push(pointAt(g, t));
                }
            }
        }
        if (ring.length) ring.push({ x: ring[0].x, y: ring[0].y });
        return ring;
    }

    function pointInRing(pt, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
            const yi = ring[i].y, yj = ring[j].y;
            if ((yi > pt.y) !== (yj > pt.y)) {
                const x = ring[i].x + (pt.y - yi) / (yj - yi) * (ring[j].x - ring[i].x);
                if (pt.x < x) inside = !inside;
            }
        }
        return inside;
    }

    // Loop → HATCH polyline path. Back-and-forth spikes (a bridge walked both
    // ways) cancel out first.
    function loopToPath(arr, loop, flags) {
        const st = [];
        for (const h of loop) {
            if (st.length && st[st.length - 1] === (h ^ 1)) st.pop();
            else st.push(h);
        }
        while (st.length > 1 && st[0] === (st[st.length - 1] ^ 1)) { st.shift(); st.pop(); }
        if (st.length < 2) return null;
        const vertices = [];
        let hasBulge = false;
        for (const h of st) {
            const { g, fwd, p } = heGeom(arr, h);
            let bulge = 0;
            if (g.k === 'A') { bulge = Math.tan(g.sw / 4) * (fwd ? 1 : -1); hasBulge = true; }
            vertices.push({ x: p.x, y: p.y, bulge });
        }
        // Which input primitives (their .src tags) this loop was built from.
        const tags = st.map(h => arr.edges[arr.H[h].e].g.src);
        const sources = [...new Set(tags.filter(v => v !== undefined && v !== null))];
        // partial: some piece came from an untagged primitive (or a gap bridge).
        return { flags, polyline: true, closed: true, hasBulge, vertices, sources, partial: tags.some(v => v === undefined || v === null) };
    }

    function regionAt(arr, point, opts) {
        const o = opts || {};
        if (!arr || arr.empty) return { ok: false, reason: 'empty', looseEnds: [] };
        if (!arr.faces.length) return { ok: false, reason: 'notClosed', looseEnds: arr.looseEnds || [] };
        const P = { x: +point.x, y: +point.y };
        let best = null;
        for (const f of arr.faces) {
            if (!(f.area > arr.eps * arr.eps)) continue;
            const b = f.box;
            if (P.x < b[0] || P.x > b[2] || P.y < b[1] || P.y > b[3]) continue;
            if (!pointInRing(P, f.ring)) continue;
            if (!best || f.area < best.area) best = f;
        }
        if (!best) return { ok: false, reason: 'notClosed', looseEnds: arr.looseEnds };
        if (o.exclude && o.exclude.has && o.exclude.has(best.id)) return { ok: false, reason: 'already', face: best.id, looseEnds: [] };
        const paths = [], rings = [best.ring];
        const outer = loopToPath(arr, best.loop, 1);
        if (outer) paths.push(outer);
        let area = best.area;
        if (o.islands !== false) {
            for (const [comp, f] of arr.outerOf) {
                if (comp === best.comp) continue;
                const b = f.box, B = best.box;
                if (b[0] < B[0] || b[1] < B[1] || b[2] > B[2] || b[3] > B[3]) continue;
                const probe = { x: arr.vx[arr.H[f.loop[0]].from], y: arr.vy[arr.H[f.loop[0]].from] };
                if (!pointInRing(probe, best.ring)) continue;
                const p = loopToPath(arr, f.loop, 16);
                if (p) { paths.push(p); rings.push(f.ring); }
                area += f.area;                                   // negative: islands cut area
            }
        }
        return { ok: true, paths, rings, area, face: best.id };
    }

    const DxfRegion = { buildArrangement, regionAt, bulgeArc, pointInRing };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfRegion;
    if (root) root.DxfRegion = DxfRegion;
})(typeof window !== 'undefined' ? window : null);
