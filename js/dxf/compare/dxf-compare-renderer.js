/* Compare scenes, camera/controls, builders, text cache and GPU operations. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfCompareRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    function create(THREE, host, pixelRatio = 1) {
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(host.clientWidth || 2, host.clientHeight || 2);
        renderer.setPixelRatio(Math.min(pixelRatio || 1, 1.75));
        host.appendChild(renderer.domElement);
        return renderer;
    }
    function resize(camera, activeHost, targets) {
        const aspect = Math.max(activeHost.clientWidth, 2) / Math.max(activeHost.clientHeight, 2);
        const halfHeight = (camera.top - camera.bottom) / 2;
        camera.left = -halfHeight * aspect;
        camera.right = halfHeight * aspect;
        camera.updateProjectionMatrix();
        for (const [renderer, host] of targets) renderer.setSize(Math.max(host.clientWidth, 2), Math.max(host.clientHeight, 2));
    }
    function swipe(renderer, camera, sceneA, sceneB, sceneTop, splitFraction, size) {
        renderer.getSize(size);
        const split = Math.round(size.x * splitFraction);
        renderer.setScissorTest(true);
        renderer.setScissor(0, 0, split, size.y);
        renderer.render(sceneA, camera);
        renderer.setScissor(split, 0, size.x - split, size.y);
        renderer.render(sceneB, camera);
        renderer.setScissorTest(false);
        renderer.autoClear = false;
        renderer.render(sceneTop, camera);
        renderer.autoClear = true;
    }
    function renderFrame(mode, camera, renderers, scenes, split, size) {
        if (mode === 'overlay') renderers.main.render(scenes.overlay, camera);
        else if (mode === 'swipe') swipe(renderers.main, camera, scenes.a, scenes.b, scenes.top, split, size);
        else { renderers.a.render(scenes.a, camera); renderers.b.render(scenes.b, camera); }
    }
    function clearScenes(scenes, textureCache) {
        const cached = new Set();
        textureCache.forEach(entry => cached.add(entry.texture));
        for (const scene of scenes) {
            if (!scene) continue;
            scene.traverse(child => {
                child.geometry?.dispose();
                if (child.material) {
                    const dispose = material => {
                        if (material?.map && !cached.has(material.map)) material.map.dispose();
                        material?.dispose?.();
                    };
                    Array.isArray(child.material) ? child.material.forEach(dispose) : dispose(child.material);
                }
            });
            while (scene.children.length) scene.remove(scene.children[0]);
        }
    }
    // Geometry and session policy stay in the app; GPU objects and text cache live here.
    function createSceneBuilder(THREE, window, dependencies) {
        const { settings, forEachRenderableEntity, getDrawingHexColor, getTextInsertionPoint,
            getEntityText, projectIntoViewport, pointInViewportRect, entityToSegments,
            clipSegToViewportRect, spaceContentBounds, isEffectiveDarkMode,
            getHatchLoops, hatchShapes, getDimTextHeight } = dependencies;
        const textTextureCache = new Map();
        const TEXT_TEXTURE_CACHE_LIMIT = 1500;
        const textSprites = [];

        function updateTextLOD(camera, hostHeight) {
            const worldPerPixel = Math.abs(camera.top - camera.bottom) / Math.max(camera.zoom || 1, 0.0001) / Math.max(hostHeight, 1);
            for (const sprite of textSprites) {
                let parent = sprite.parent, visible = !!parent;
                while (parent) { if (!parent.visible) { visible = false; break; } parent = parent.parent; }
                if (!visible) continue;
                const screenPx = (sprite.userData.__textWorldHeight || 0) / worldPerPixel;
                sprite.visible = screenPx >= 2;
                if (!sprite.visible) continue;
                const bucket = screenPx > 288 ? 576 : screenPx > 144 ? 288 : screenPx > 72 ? 144 : 72;
                if (bucket === sprite.userData.__fontBucket) continue;
                const { texture } = window.DxfText.getTexture(THREE, sprite.userData.__resolvedNode, {
                    ...sprite.userData.__texParams, cache: textTextureCache, cacheLimit: TEXT_TEXTURE_CACHE_LIMIT, fontPx: bucket,
                });
                sprite.material.map = texture;
                sprite.material.needsUpdate = true;
                sprite.userData.__fontBucket = bucket;
            }
        }
        function addPortalContentToBucket(bucket, ctx, viewports, items, colorOverride, opacity) {
            if (!settings.showPortals) return;
            if (!viewports.length || !items.length) return;
            const layerDict = {};
            for (const { entity } of items) {
                forEachRenderableEntity(ctx, (e) => {
                    let segments;
                    for (const vp of viewports) {
                        if (vp.frozenLayers?.includes(e.layer || '0')) continue;
                        const layerName = e.layer || '0';
                        if (!layerDict[layerName]) layerDict[layerName] = { pts: [], colors: [], textNodes: [], fills: [] };
                        const ld = layerDict[layerName];
                        const colorHex = colorOverride != null ? colorOverride : getDrawingHexColor(ctx, e);
                        if (e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTRIB' || e.type === 'ATTDEF') {
                            const style = window.DxfText.resolve(e, ctx.textStyles);
                            const pt = e.__textPoint || getTextInsertionPoint(e);
                            const text = e.type === 'MTEXT' ? (e.__textSourceEntity?.text ?? e.text ?? e.__text) : (e.__text ?? getEntityText(e));
                            if (!pt || !text) continue;
                            const pr = projectIntoViewport(pt, vp);
                            if (!pointInViewportRect(pr, vp)) continue;
                            ld.textNodes.push({
                                text, x: pr.x, y: pr.y, color: colorHex,
                                rotation: (e.__textRotation || 0) - (vp.twistDeg || 0),
                                height: Math.max((e.__textHeight || style.height || 0) * pr.scale, 0.001),
                                halign: e.type === 'MTEXT' ? ((Number(e.attachmentPoint) || 1) - 1) % 3 : (e.halign || 0),
                                valign: e.type === 'MTEXT' ? [3, 2, 1][Math.floor(((Number(e.attachmentPoint) || 1) - 1) / 3)] : (e.valign || 0),
                                width: (e.__textWidth || 0) * pr.scale, isMText: e.type === 'MTEXT',
                                font: style.font, widthFactor: style.widthFactor, oblique: style.oblique,
                                lineSpacingFactor: e.lineSpacingFactor || 1,
                            });
                            continue;
                        }
                        // Reuse model geometry across frames; only projection and
                        // clipping depend on the viewport. Keep this local to e.
                        if (!segments) segments = entityToSegments(ctx, e);
                        for (const s of segments) {
                            const pa = projectIntoViewport({ x: s.x1, y: s.y1 }, vp);
                            const pb = projectIntoViewport({ x: s.x2, y: s.y2 }, vp);
                            const c = clipSegToViewportRect(pa.x, pa.y, pb.x, pb.y, vp);
                            if (!c) continue;
                            const r = ((colorHex >> 16) & 255) / 255, g = ((colorHex >> 8) & 255) / 255, b = (colorHex & 255) / 255;
                            ld.pts.push(c.x1, c.y1, 0, c.x2, c.y2, 0);
                            ld.colors.push(r, g, b, r, g, b);
                        }
                    }
                }, [entity]);
            }
            appendLayerDictToGroup(bucket, layerDict, opacity);
        }

        function appendLayerDictToGroup(bucket, layerDict, opacity) {
            const bounds = layerDictBounds(layerDict);
            const maxDim = bounds ? Math.max(bounds.width, bounds.height, 1) : 1;
            const fallbackTextHeight = Math.max(maxDim / 120, 0.001);
            for (const [layerName, ldata] of Object.entries(layerDict)) {
                const group = new THREE.Group();
                group.name = layerName;
                if (ldata.pts.length > 0) {
                    const geom = new THREE.BufferGeometry();
                    geom.setAttribute('position', new THREE.Float32BufferAttribute(ldata.pts, 3));
                    geom.setAttribute('color', new THREE.Float32BufferAttribute(ldata.colors, 3));
                    const mat = new THREE.LineBasicMaterial({
                        vertexColors: true,
                        transparent: opacity != null,
                        opacity: opacity != null ? opacity : 1,
                    });
                    group.add(new THREE.LineSegments(geom, mat));
                }
                for (const fill of (settings.showFills ? ldata.fills : [])) {
                    if (fill.tris?.length) {
                        const pos = new Float32Array(fill.tris.length / 2 * 3);
                        for (let i = 0, j = 0; i < fill.tris.length; i += 2, j += 3) { pos[j] = fill.tris[i]; pos[j + 1] = fill.tris[i + 1]; }
                        const geom = new THREE.BufferGeometry();
                        geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
                        const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
                            color: new THREE.Color(fill.colorHex), side: THREE.DoubleSide,
                            transparent: opacity != null, opacity: opacity != null ? opacity : 1,
                        }));
                        mesh.position.z = -0.04;
                        mesh.renderOrder = -1;
                        group.add(mesh);
                        continue;
                    }
                    if (!fill.shapes.length) continue;
                    const geom = new THREE.ShapeGeometry(fill.shapes);
                    const mat = new THREE.MeshBasicMaterial({
                        color: new THREE.Color(fill.colorHex), side: THREE.DoubleSide,
                        transparent: true, opacity: (opacity != null ? opacity : 1) * 0.55,
                    });
                    const mesh = new THREE.Mesh(geom, mat);
                    mesh.position.z = -0.05;
                    mesh.renderOrder = -1;
                    group.add(mesh);
                }
                if (settings.showText) ldata.textNodes.forEach(t => {
                    const sprite = makeTextSprite(t, fallbackTextHeight, opacity);
                    if (sprite) group.add(sprite);
                });
                bucket.add(group);
            }
        }

        function buildSheetGroup(ctxs, key) {
            const group = new THREE.Group();
            group.name = '__paper_sheet__';
            let w = 0, h = 0;
            for (const ctx of ctxs) {
                const lay = ctx.layouts.find(l => l.name.toLowerCase() === key);
                if (lay?.paperWidth > 0 && lay?.paperHeight > 0) { w = lay.paperWidth; h = lay.paperHeight; break; }
            }
            let bounds;
            if (w > 0 && h > 0) {
                bounds = { minX: 0, minY: 0, maxX: w, maxY: h };
                // Content wildly outside the positive sheet: center on it instead.
                const cb = spaceContentBounds(ctxs, key);
                if (cb && !(cb.minX >= -0.01 && cb.minY >= -0.01 && cb.maxX <= w + 0.01 && cb.maxY <= h + 0.01)) {
                    const cx = (cb.minX + cb.maxX) / 2, cy = (cb.minY + cb.maxY) / 2;
                    bounds = { minX: cx - w / 2, minY: cy - h / 2, maxX: cx + w / 2, maxY: cy + h / 2 };
                }
            } else {
                const cb = spaceContentBounds(ctxs, key);
                if (!cb) return group;
                const pad = Math.max(cb.maxX - cb.minX, cb.maxY - cb.minY) * 0.025;
                bounds = { minX: cb.minX - pad, minY: cb.minY - pad, maxX: cb.maxX + pad, maxY: cb.maxY + pad };
            }
            const bw = bounds.maxX - bounds.minX, bh = bounds.maxY - bounds.minY;
            const plane = new THREE.Mesh(
                new THREE.PlaneGeometry(bw, bh),
                new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthWrite: false })
            );
            plane.position.set(bounds.minX + bw / 2, bounds.minY + bh / 2, -0.08);
            plane.renderOrder = -2;
            group.add(plane);
            const edgeGeom = new THREE.BufferGeometry();
            edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute([
                bounds.minX, bounds.minY, -0.05, bounds.maxX, bounds.minY, -0.05,
                bounds.maxX, bounds.minY, -0.05, bounds.maxX, bounds.maxY, -0.05,
                bounds.maxX, bounds.maxY, -0.05, bounds.minX, bounds.maxY, -0.05,
                bounds.minX, bounds.maxY, -0.05, bounds.minX, bounds.minY, -0.05,
            ], 3));
            group.add(new THREE.LineSegments(edgeGeom, new THREE.LineBasicMaterial({ color: 0x94a3b8, depthTest: false })));
            group.userData.__sheetBounds = bounds;
            return group;
        }

        function toHexString(colorNumber) {
            return '#' + colorNumber.toString(16).padStart(6, '0').toUpperCase();
        }

        function makeTextSprite(tNode, fallbackHeight, opacity) {
            if (!String(tNode?.text ?? '').trim()) return null;
            const node = { ...tNode, height: Math.abs(Number(tNode.height)) || fallbackHeight || 1,
                font: tNode.font || window.DxfText.fontFamily('', tNode.fontFamily) };
            const params = {
                cache: textTextureCache, cacheLimit: TEXT_TEXTURE_CACHE_LIMIT,
                fontPx: 72, color: toHexString(tNode.color), aci7Color: isEffectiveDarkMode() ? '#ffffff' : '#000000', opacity,
                pixelRatio: Math.min(window.devicePixelRatio || 1, 2), halo: settings.textHalo,
                haloColor: isEffectiveDarkMode() ? 'rgba(0,0,0,0.72)' : 'rgba(255,255,255,0.88)',
            };
            const sprite = window.DxfText.makeSprite(THREE, node, params);
            sprite.userData.__texParams = params;
            sprite.userData.__fontBucket = 72;
            textSprites.push(sprite);
            return sprite;
        }

        function addEntityToBucket(ctx, entity, layerDict, colorOverride) {
            const layerName = entity.layer || '0';
            if (!layerDict[layerName]) layerDict[layerName] = { pts: [], colors: [], textNodes: [], fills: [] };
            const layerData = layerDict[layerName];
            const colorHex = colorOverride != null ? colorOverride : getDrawingHexColor(ctx, entity);
            const push = (x1, y1, x2, y2) => {
                if (![x1, y1, x2, y2].every(Number.isFinite)) return;
                const r = ((colorHex >> 16) & 255) / 255, g = ((colorHex >> 8) & 255) / 255, b = (colorHex & 255) / 255;
                layerData.pts.push(x1, y1, 0, x2, y2, 0);
                layerData.colors.push(r, g, b, r, g, b);
            };

            if (entity.type === 'ACAD_TABLE') {
                if (!window.DxfHatch?.acadTableGeometry) return;
                const geo = window.DxfHatch.acadTableGeometry(entity);
                geo.segments.forEach(s => push(s.x1, s.y1, s.x2, s.y2));
                for (const cell of geo.cells) {
                    if (cell.covered) continue;
                    const data = entity.cells?.[cell.index];
                    if (!data || !String(data.text).trim()) continue;
                    layerData.textNodes.push({
                        text: String(data.text), x: cell.cx, y: cell.cy, color: colorHex,
                        rotation: Number(entity.rotation) || 0,
                        height: Math.max(Number(data.textHeight) || cell.h * 0.42, 1e-6),
                        halign: 1, valign: 2,
                    });
                }
            } else if (['LINE', 'POLYLINE', 'LWPOLYLINE', 'CIRCLE', 'ARC', 'ELLIPSE', 'SPLINE', 'POINT', 'VIEWPORT'].includes(entity.type)) {
                // Diff view renders solid lines linetypes intentionally skipped.
                for (const s of entityToSegments(ctx, entity)) push(s.x1, s.y1, s.x2, s.y2);
                // Wide polylines (and MULTILEADER arrowheads): filled band.
                if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && window.DxfWide?.hasWidth(entity)) {
                    const tris = window.DxfWide.wideTriangles(entity.vertices, !!(entity.shape || entity.closed), entity.width);
                    if (tris) layerData.fills.push({ shapes: [], tris, colorHex });
                }
            } else if (entity.type === 'WIPEOUT') {
                const vs = entity.vertices || [];
                for (let i = 0; i < vs.length; i++) {
                    const a = vs[i], b = vs[(i + 1) % vs.length];
                    push(a.x, a.y, b.x, b.y);
                }
            } else if (entity.type === 'HATCH') {
                const loops = getHatchLoops(ctx, entity);
                if (!loops.length) return;
                if (entity.solid || entity.gradient) {
                    layerData.fills.push({ shapes: hatchShapes(loops), colorHex });
                    for (const ring of loops) {
                        for (let i = 0; i < ring.length - 1; i++) push(ring[i].x, ring[i].y, ring[i + 1].x, ring[i + 1].y);
                    }
                } else {
                    for (const s of window.DxfHatch.patternSegments(entity, loops)) push(s.x1, s.y1, s.x2, s.y2);
                }
            } else if (entity.type === 'DIMENSION') {
                const D = window.DxfDim;
                const dimSrc = entity.__sourceEntity || entity;
                const synth = D ? D.synthesizeFromEntity(dimSrc, getDimTextHeight(ctx), 2) : null;
                if (!synth) return;
                synth.segments.forEach(s => push(s.x1, s.y1, s.x2, s.y2));
                for (const pl of synth.polylines || []) {
                    const vs = pl.vertices;
                    for (let i = 0; i < vs.length; i++) {
                        const a = vs[i], b = vs[(i + 1) % vs.length];
                        if (i === vs.length - 1 && !pl.closed) break;
                        push(a.x, a.y, b.x, b.y);
                    }
                }
                layerData.textNodes.push({
                    text: synth.text.value, x: synth.text.x, y: synth.text.y, color: colorHex,
                    rotation: synth.text.rotationDeg, height: synth.text.height,
                    halign: 1, valign: synth.text.valign || 1,
                });
            } else if (entity.type === 'LEADER') {
                for (const s of entityToSegments(ctx, entity)) push(s.x1, s.y1, s.x2, s.y2);
            } else if (entity.type === 'TEXT' || entity.type === 'MTEXT' || entity.type === 'ATTRIB' || entity.type === 'ATTDEF') {
                const style = window.DxfText.resolve(entity, ctx.textStyles);
                const isMText = !!entity.__isMText || entity.type === 'MTEXT';
                const attachment = Number(entity.attachmentPoint) || 1;
                const mtCol = entity.type === 'MTEXT' && entity.attachmentPoint ? ((Number(entity.attachmentPoint) - 1) % 3) : null;
                const aligned = ![3, 5].includes(Number(entity.halign)) && (entity.halign || entity.valign) ? (entity.__textAlignPoint || entity.endPoint) : null;
                const point = aligned || entity.__textPoint || getTextInsertionPoint(entity);
                const end = entity.__textAlignPoint || entity.endPoint;
                const text = isMText ? (entity.__textSourceEntity?.text ?? entity.text ?? entity.__text) : (entity.__text ?? getEntityText(entity));
                if (!point || !text) return;
                layerData.textNodes.push({
                    text, x: point.x, y: point.y, color: colorHex,
                    rotation: entity.__textRotation || 0,
                    height: entity.__textHeight || style.height || 0,
                    width: entity.__textWidth || 0,
                    isMText,
                    halign: mtCol !== null ? mtCol : (entity.halign || 0),
                    valign: isMText ? (Math.floor((attachment - 1) / 3) === 0 ? 3 : Math.floor((attachment - 1) / 3) === 1 ? 2 : 1) : (entity.valign || 0),
                    font: style.font, widthFactor: style.widthFactor, oblique: style.oblique,
                    lineSpacingFactor: entity.lineSpacingFactor || 1,
                    endX: end?.x, endY: end?.y,
                });
            }
        }

        function buildBucketGroup(name, items, colorOverride, opacity) {
            // items: [{ ctx, entity }] top-level model entities to explode + render.
            const layerDict = {};
            for (const { ctx, entity } of items) {
                forEachRenderableEntity(ctx, e => addEntityToBucket(ctx, e, layerDict, colorOverride), [entity]);
            }
            const bucket = new THREE.Group();
            bucket.name = name;
            appendLayerDictToGroup(bucket, layerDict, opacity);
            return bucket;
        }

        function layerDictBounds(layerDict) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const data of Object.values(layerDict || {})) {
                const pts = data?.pts || [];
                for (let i = 0; i < pts.length; i += 3) {
                    const x = pts[i], y = pts[i + 1];
                    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                }
                for (const t of (data?.textNodes || [])) {
                    if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
                    if (t.x < minX) minX = t.x; if (t.x > maxX) maxX = t.x;
                    if (t.y < minY) minY = t.y; if (t.y > maxY) maxY = t.y;
                }
            }
            if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
            return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
        }
        return { buildBucketGroup, buildSheetGroup, addPortalContentToBucket, textTextureCache,
            updateTextLOD, clearTextSprites: () => { textSprites.length = 0; } };
    }
    function createSession(THREE, OrbitControls, hosts, pixelRatio, requestRender) {
        const aspect = Math.max((hosts.main.clientWidth || 2) / (hosts.main.clientHeight || 2), 0.01);
        const camera = new THREE.OrthographicCamera(-50 * aspect, 50 * aspect, 50, -50, 0.1, 2000);
        camera.position.set(0, 0, 100);
        const scenes = { overlay: new THREE.Scene(), a: new THREE.Scene(), b: new THREE.Scene(), top: new THREE.Scene() };
        for (const scene of [scenes.overlay, scenes.a, scenes.b]) scene.background = new THREE.Color(0x2a2e37);
        const renderers = Object.fromEntries(Object.entries(hosts).map(([key, host]) => [key, create(THREE, host, pixelRatio)]));
        // Each control shares the camera and mirrors its target to prevent zoom-to-cursor tilt.
        const allControls = [];
        let zoomSpeed = 4.4;
        try {
            const savedZoomSpeed = Number(localStorage.getItem('dxf-zoom-speed'));
            if ([2.8, 4.4, 6.4].includes(savedZoomSpeed)) zoomSpeed = savedZoomSpeed;
        } catch { /* storage optional */ }
        function makeControls(r) {
            const c = new OrbitControls(camera, r.domElement);
            c.zoomToCursor = true;
            c.enableRotate = false;
            c.enableDamping = false;
            c.screenSpacePanning = true;
            c.zoomSpeed = zoomSpeed;
            c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
            // Top-down 2D lock: polar pinned to pi/2, azimuth pinned to 0.
            c.minPolarAngle = Math.PI / 2;
            c.maxPolarAngle = Math.PI / 2;
            c.minAzimuthAngle = 0;
            c.maxAzimuthAngle = 0;
            c.addEventListener('change', () => {
                for (const o of allControls) if (o !== c) o.target.copy(c.target);
                requestRender();
            });
            allControls.push(c);
            return c;
        }

        const controlsMain = makeControls(renderers.main), controlsA = makeControls(renderers.a), controlsB = makeControls(renderers.b);
        function syncControlsToCamera() {
            if (!camera) return;
            camera.up.set(0, 1, 0);
            camera.position.z = 100;
            const tx = camera.position.x, ty = camera.position.y;
            for (const c of [controlsMain, controlsA, controlsB]) {
                if (!c) continue;
                c.target.set(tx, ty, 0);
            }
            camera.lookAt(tx, ty, 0);
            for (const c of [controlsMain, controlsA, controlsB]) {
                if (c && c.enabled) c.update();
            }
        }

            const hlMat = new THREE.LineBasicMaterial({ color: 0xfacc15, depthTest: false, transparent: true, opacity: 0.98 });
            const highlightLine = new THREE.LineSegments(new THREE.BufferGeometry(), hlMat);
            highlightLine.frustumCulled = false;
            highlightLine.renderOrder = 999;
            highlightLine.visible = false;


        return { camera, scenes, renderers, highlightLine,
            controls: { main: controlsMain, a: controlsA, b: controlsB }, syncControlsToCamera };
    }
    // Own scheduling and subscriptions; UI overlays are refreshed after a rendered frame.
    function createLifecycle(environment, hosts, draw, resizeView) {
        let running = false, dirty = true, frame = null, observer = null;
        function requestRender() { dirty = true; }
        function tick() {
            if (!running) return;
            frame = environment.requestAnimationFrame(tick);
            if (!dirty) return;
            dirty = false;
            draw();
        }
        function onResize() { resizeView(); requestRender(); }
        function start() {
            if (running) return;
            running = true;
            dirty = true;
            environment.addEventListener('resize', onResize);
            if (environment.ResizeObserver) {
                observer = new environment.ResizeObserver(onResize);
                hosts.forEach(host => observer.observe(host));
            }
            tick();
        }
        function stop() {
            if (!running) return;
            running = false;
            environment.cancelAnimationFrame(frame);
            frame = null;
            environment.removeEventListener('resize', onResize);
            observer?.disconnect();
            observer = null;
        }
        return { start, stop, requestRender, resize: onResize };
    }
    return { create, resize, swipe, renderFrame, clearScenes, createSceneBuilder, createSession, createLifecycle };
});
