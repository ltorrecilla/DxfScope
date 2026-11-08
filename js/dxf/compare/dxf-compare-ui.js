/* Compare panel presentation. Session state and drawing actions are supplied by the app. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfCompareUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    function create(document, window, dependencies) {
        const { getState, setLayerVisible, cleanDxfText, getSpaceEntities,
            applyLayerVisibility, tr, zoomToEntity, spaceKeysUnion, switchSpace, getSettings, settingsChanged } = dependencies;
        let resultLimit = 300;
        let selectedLayers = new Set();
        let layerAnchor = null;
        let selectionDrawings = [];

        function selectLayer(name, event, orderedNames) {
            if (event.shiftKey && orderedNames.includes(layerAnchor)) {
                const a = orderedNames.indexOf(layerAnchor), b = orderedNames.indexOf(name);
                if (!event.ctrlKey && !event.metaKey) selectedLayers.clear();
                orderedNames.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(n => selectedLayers.add(n));
            } else if (event.ctrlKey || event.metaKey) {
                if (!selectedLayers.delete(name)) selectedLayers.add(name);
                layerAnchor = name;
            } else {
                selectedLayers = new Set([name]);
                layerAnchor = name;
            }
            renderLayerList();
        }
        function entityLabel(entity) {
            const type = entity?.type || '?';
            const layer = entity?.layer || '0';
            const h = (typeof entity?.handle === 'string') ? entity.handle : '';
            const extra = entity?.type === 'INSERT' ? ` "${entity.name || ''}"`
                : (entity?.text ? ` "${String(cleanDxfText(entity.text)).slice(0, 18)}"` : '');
            return `${type}${extra} · ${layer}${h ? ' · #' + h : ''}`;
        }

        function renderCounts() {
            const { compareResult, spaceResults, currentSpace, ctxA, ctxB } = getState();
            let c = compareResult?.counts || { added: 0, deleted: 0, modified: 0, unchanged: 0 };
            const sr = spaceResults[currentSpace];
            if (sr && sr.status !== 'matched') {
                const ctx = sr.status === 'missingA' ? ctxB : ctxA;
                const n = (getSpaceEntities(ctx, currentSpace) || []).length;
                c = { added: sr.status === 'missingA' ? n : 0, deleted: sr.status === 'missingB' ? n : 0, modified: 0, unchanged: 0 };
            }
            document.getElementById('count-added').textContent = c.added.toLocaleString();
            document.getElementById('count-deleted').textContent = c.deleted.toLocaleString();
            document.getElementById('count-modified').textContent = c.modified.toLocaleString();
            document.getElementById('count-unchanged').textContent = c.unchanged.toLocaleString();
        }

        function layerSwatchColor(name) {
            const { ctxA, ctxB } = getState();
            // Display-only colour: prefer B's layer table, then A's.
            for (const ctx of [ctxB, ctxA]) {
                const lay = ctx.dxf?.tables?.layer?.layers?.[name];
                if (lay && typeof lay.color === 'number' && lay.color > 0) return lay.color;
            }
            return 0x94a3b8;
        }

        function layerPresence(name) {
            const { ctxA, ctxB } = getState();
            const inA = !!ctxA.dxf?.tables?.layer?.layers?.[name];
            const inB = !!ctxB.dxf?.tables?.layer?.layers?.[name];
            return { inA, inB };
        }

        function renderLayerList() {
            const { compareResult, ctxA, ctxB, groups, layerVisibility, singleFileMode } = getState();
            const listEl = document.getElementById('layer-list');
            const scrollTop = listEl.scrollTop;
            if (selectionDrawings[0] !== ctxA.dxf || selectionDrawings[1] !== ctxB.dxf) {
                selectedLayers.clear(); layerAnchor = null;
                selectionDrawings = [ctxA.dxf, ctxB.dxf];
            }
            const filter = (document.getElementById('layer-filter').value || '').trim().toLowerCase();
            listEl.innerHTML = '';
            const breakdown = compareResult ? window.DxfCompare.layerBreakdown(compareResult) : {};
            const names = new Set(Object.keys(breakdown));
            for (const ctx of [ctxA, ctxB]) {
                for (const n of Object.keys(ctx.dxf?.tables?.layer?.layers || {})) names.add(n);
            }
            if (groups) for (const bucket of Object.values(groups)) for (const g of bucket.children) if (g.name !== '__paper_sheet__') names.add(g.name);
            const sorted = Array.from(names).filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            const filtered = sorted.filter(name => !filter || name.toLowerCase().includes(filter));
            selectedLayers = new Set([...selectedLayers].filter(name => names.has(name)));

            // "Toggle all" header row (editor pattern)
            const allRow = document.createElement('div');
            allRow.className = 'dxf-layer-row dxf-layer-row-all';
            const allCb = document.createElement('input');
            allCb.type = 'checkbox';
            allCb.className = 'layer-checkbox';
            const visStates = filtered.map(n => layerVisibility[n] !== false);
            allCb.checked = visStates.every(Boolean);
            allCb.indeterminate = !allCb.checked && visStates.some(Boolean);
            allCb.addEventListener('change', () => {
                for (const n of filtered) setLayerVisible(n, allCb.checked);
                applyLayerVisibility();
                renderLayerList();
            });
            allCb.id = 'compare-layer-toggle-all';
            allCb.disabled = !filtered.length;
            const allLabel = document.createElement('label');
            allLabel.htmlFor = allCb.id;
            allLabel.style.gridColumn = '2 / 4';
            allLabel.className = 'dxf-layer-name';
            allLabel.textContent = tr('toggleAllLayers', 'Toggle all');
            allRow.append(allCb, allLabel, document.createElement('span'));
            listEl.appendChild(allRow);

            for (const name of filtered) {
                const stats = breakdown[name] || { added: 0, deleted: 0, modified: 0, unchanged: 0 };
                const visible = layerVisibility[name] !== false;
                const { inA, inB } = layerPresence(name);
                const row = document.createElement('div');
                row.className = 'dxf-layer-row hover:bg-slate-50 rounded transition-colors';
                row.title = name;
                row.classList.toggle('is-layer-selected', selectedLayers.has(name));
                row.addEventListener('click', event => {
                    if (!event.target.closest('input, button')) selectLayer(name, event, filtered);
                });

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'layer-checkbox';
                cb.checked = visible;
                cb.setAttribute('aria-label', tr('toggleLayerAria', 'Toggle layer {layer}', { layer: name }));
                cb.addEventListener('change', () => {
                    for (const target of selectedLayers.has(name) ? selectedLayers : [name]) setLayerVisible(target, cb.checked);
                    applyLayerVisibility();
                    renderLayerList();
                });

                const dot = document.createElement('span');
                dot.className = 'dxf-layer-color';
                dot.style.background = '#' + layerSwatchColor(name).toString(16).padStart(6, '0');

                const label = document.createElement('span');
                label.className = 'dxf-layer-name';
                label.textContent = name;
                label.tabIndex = 0;
                label.setAttribute('role', 'button');
                label.setAttribute('aria-pressed', String(selectedLayers.has(name)));
                label.addEventListener('keydown', event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault(); event.stopPropagation();
                    selectLayer(name, event, filtered);
                    const index = filtered.indexOf(name);
                    listEl.children[index + 1]?.children[2]?.focus();
                });

                const meta = document.createElement('span');
                meta.className = 'shrink-0 flex items-center gap-1 font-mono text-[10px] justify-self-end pr-1';
                let metaHtml = '';
                if (!singleFileMode && (inA || inB)) {
                    if (!inA) metaHtml += `<span class="text-[9px] font-bold text-emerald-600 uppercase font-sans">${escapeHtml(tr('missingInA', 'missing in A'))}</span>`;
                    else if (!inB) metaHtml += `<span class="text-[9px] font-bold text-red-500 uppercase font-sans">${escapeHtml(tr('missingInB', 'missing in B'))}</span>`;
                }
                if (stats.added) metaHtml += `<span class="text-emerald-600">+${stats.added}</span>`;
                if (stats.deleted) metaHtml += `<span class="text-red-500">−${stats.deleted}</span>`;
                if (stats.modified) metaHtml += `<span class="text-orange-500">~${stats.modified}</span>`;
                meta.innerHTML = metaHtml;

                row.append(cb, dot, label, meta);
                listEl.appendChild(row);
            }
            listEl.scrollTop = scrollTop;
            if (window.lucide) window.lucide.createIcons({ nameAttr: 'data-lucide' });
        }

        function escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
        }

        function renderResultList() {
            const { spaceResults, currentSpace, compareResult, ctxA, ctxB } = getState();
            const listEl = document.getElementById('result-list');
            listEl.innerHTML = '';
            const sr = spaceResults[currentSpace];
            if (sr && sr.status !== 'matched') {
                const note = document.createElement('div');
                note.className = 'text-slate-400 italic py-2';
                note.textContent = sr.status === 'missingA'
                    ? tr('layoutOnlyInB', 'This layout only exists in Version B, all entities counted as added.')
                    : tr('layoutOnlyInA', 'This layout only exists in Version A, all entities counted as deleted.');
                listEl.appendChild(note);
                return;
            }
            if (!compareResult) return;
            const r = compareResult;
            const rows = [];
            const { categoryVisibility = {}, layerVisibility = {} } = getState();
            r.added.forEach((p, i) => rows.push({ cat: 'added', ctx: ctxB, entity: p.b, i }));
            r.deleted.forEach((p, i) => rows.push({ cat: 'deleted', ctx: ctxA, entity: p.a, i }));
            r.modified.forEach((p, i) => rows.push({ cat: 'modified', ctx: ctxB, entity: p.b, reason: p.reason, i }));
            const total = rows.length;
            if (!total) {
                const empty = document.createElement('div');
                empty.className = 'text-slate-400 italic py-2';
                empty.textContent = tr('noChanges', 'No differences found at this tolerance.');
                listEl.appendChild(empty);
                return;
            }
            const catColor = { added: '#22c55e', deleted: '#ef4444', modified: '#f97316' };
            const filtered = rows.filter(row => categoryVisibility[row.cat] !== false && layerVisibility[row.entity.layer || '0'] !== false);
            const shown = filtered.slice(0, resultLimit);
            if (!filtered.length) {
                const note = document.createElement('div');
                note.className = 'text-slate-400 italic py-2';
                note.textContent = 'No changes match the current category and layer filters.';
                listEl.appendChild(note);
                return;
            }
            const frag = document.createDocumentFragment();
            shown.forEach((row, idx) => {
                const el = document.createElement('div');
                el.className = 'result-row flex items-center gap-2 py-1 px-1.5 rounded';
                el.dataset.idx = String(idx);
                el.innerHTML = `
                    <span class="cat-dot shrink-0" style="background:${catColor[row.cat]}"></span>
                    <span class="flex-1 truncate">${escapeHtml(entityLabel(row.entity))}</span>
                    ${row.reason === 'block' ? `<span class="shrink-0 text-[9px] font-bold text-orange-500 uppercase">${escapeHtml(tr('reasonBlock', 'block def'))}</span>` : ''}`;
                el.addEventListener('click', () => {
                    listEl.querySelectorAll?.('.result-row').forEach(item => item.classList.remove('active'));
                    el.classList.add('active');
                    zoomToEntity(row.ctx, row.entity);
                    setStatus(tr('statusZoomed', 'Zoomed to {label}', { label: entityLabel(row.entity) }));
                });
                if (row.cat === 'modified') {
                    const pair = r.modified[row.i];
                    for (const [label, ctx, entity] of [['Before', ctxA, pair.a], ['After', ctxB, pair.b]]) {
                        const button = document.createElement('button');
                        button.className = 'text-blue-600 px-1'; button.textContent = label;
                        button.title = label + ': zoom to this version';
                        button.addEventListener('click', event => { event.stopPropagation(); zoomToEntity(ctx, entity); setStatus(label + ': ' + entityLabel(entity)); });
                        el.appendChild(button);
                    }
                }
                frag.appendChild(el);
            });
            listEl.appendChild(frag);
            if (filtered.length > shown.length) {
                const more = document.createElement('button');
                more.className = 'text-slate-400 italic py-1.5';
                more.textContent = `Show more (${shown.length} of ${filtered.length})`;
                more.addEventListener('click', () => { resultLimit += 300; renderResultList(); });
                listEl.appendChild(more);
            }
        }

        function renderPapersList() {
            const { singleFileMode, ctxB, spaceResults, currentSpace } = getState();
            const listEl = document.getElementById('papers-list');
            listEl.innerHTML = '';
            const frag = document.createDocumentFragment();
            const entries = singleFileMode
                ? [{ key: 'model', name: tr('spaceModel', 'Model') },
                   ...ctxB.layouts.map(l => ({ key: l.name.toLowerCase(), name: l.name }))]
                : spaceKeysUnion().filter(s => spaceResults[s.key]);
            for (const s of entries) {
                const sr = spaceResults[s.key];
                const row = document.createElement('div');
                const active = s.key === currentSpace;
                row.className = 'result-row flex items-center gap-2 py-1.5 px-2 rounded ' + (active ? 'bg-blue-50 font-bold text-blue-700' : '');
                let badge = '';
                if (!singleFileMode && sr) {
                    if (sr.status === 'missingA') badge = `<span class="shrink-0 text-[9px] font-bold text-emerald-600 uppercase">${escapeHtml(tr('missingInA', 'missing in A'))}</span>`;
                    else if (sr.status === 'missingB') badge = `<span class="shrink-0 text-[9px] font-bold text-red-500 uppercase">${escapeHtml(tr('missingInB', 'missing in B'))}</span>`;
                    else {
                        const c = sr.result.counts;
                        const parts = [];
                        if (c.added) parts.push(`<span class="text-emerald-600">+${c.added}</span>`);
                        if (c.deleted) parts.push(`<span class="text-red-500">−${c.deleted}</span>`);
                        if (c.modified) parts.push(`<span class="text-orange-500">~${c.modified}</span>`);
                        badge = `<span class="shrink-0 flex items-center gap-1 font-mono text-[10px]">${parts.join('')}</span>`;
                    }
                }
                row.innerHTML = `<i data-lucide="${s.key === 'model' ? 'box' : 'file'}" class="w-3.5 h-3.5 shrink-0 ${active ? 'text-blue-600' : 'text-slate-400'}"></i>
                    <span class="flex-1 truncate" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>${badge}`;
                row.addEventListener('click', () => switchSpace(s.key));
                frag.appendChild(row);
            }
            listEl.appendChild(frag);
            if (window.lucide) window.lucide.createIcons({ nameAttr: 'data-lucide' });
        }

        function setStatus(msg) {
            const el = document.getElementById('status-msg');
            if (el) el.textContent = msg;
        }

        let rightTab = 'comparison';
        function setPapersOpen(open) {
            const p = document.getElementById('papers-panel');
            p.classList.toggle('-translate-x-full', !open);
            document.getElementById('btn-papers').classList.toggle('active', open);
        }
        function papersOpen() { return !document.getElementById('papers-panel').classList.contains('-translate-x-full'); }
        function setRightOpen(open) {
            const p = document.getElementById('right-panel');
            p.classList.toggle('translate-x-full', !open);
            syncRightButtons();
        }
        function rightOpen() { return !document.getElementById('right-panel').classList.contains('translate-x-full'); }
        function setRightTab(tab) {
            rightTab = tab;
            document.getElementById('rp-tab-comparison').classList.toggle('active', tab === 'comparison');
            document.getElementById('rp-tab-layers').classList.toggle('active', tab === 'layers');
            const cc = document.getElementById('rp-content-comparison');
            const cl = document.getElementById('rp-content-layers');
            cc.classList.toggle('hidden', tab !== 'comparison');
            cc.classList.toggle('flex', tab === 'comparison');
            cl.classList.toggle('hidden', tab !== 'layers');
            cl.classList.toggle('flex', tab === 'layers');
            syncRightButtons();
        }
        function syncRightButtons() {
            const open = rightOpen();
            document.getElementById('btn-panel').classList.toggle('active', open && rightTab === 'comparison');
            document.getElementById('btn-layers-tab').classList.toggle('active', open && rightTab === 'layers');
        }
        function applyThemeButton() {
            const settings = getSettings();
            const button = document.getElementById('btn-theme');
            button.innerHTML = '<i data-lucide="contrast" class="w-3.5 h-3.5"></i>';
            button.setAttribute('aria-pressed', String(settings.darkMode));
            button.setAttribute('aria-label', button.title);
            if (window.lucide) window.lucide.createIcons({ nameAttr: 'data-lucide' });
        }
        let settingsTab = 'viewer';
        function renderSettings() {
            const settings = getSettings();
            const el = document.getElementById('settings-content');
            for (const tab of ['viewer', 'help']) {
                const button = document.getElementById('settings-tab-' + tab);
                button.classList.toggle('active', settingsTab === tab);
                button.setAttribute('aria-selected', String(settingsTab === tab));
            }
            if (settingsTab === 'help') {
                const help = [
                    ['layers-2', 'Overlay', 'Superimpose both drawings. Difference colors identify added, removed, and changed objects.'],
                    ['columns-2', 'Side by side', 'View A and B in separate panes with synchronized navigation.'],
                    ['move-horizontal', 'Swipe', 'Drag the divider to reveal either revision.'],
                    ['maximize', 'Fit drawing', 'Fit the drawing to the available view.'],
                    ['layers', 'CAD Layers', 'Ctrl-click names to select layers; Shift-click for a range. Toggle a selected checkbox to show or hide the group.'],
                    ['layout', 'Layouts', 'Switch between model space and drawing sheets.'],
                    ['ruler', 'Measure', 'Click two points for distance. A live preview follows the pointer. Turn the tool off or press Escape to clear measurements.'],
                    ['scan', 'Room dimensions', 'Click inside a closed room to measure its horizontal and vertical spans.'],
                    ['crosshair', 'Object snap · F3', 'Enable snapping in Settings and choose the snap modes. Perpendicular uses the first measurement point.'],
                    ['move', 'Alignment', 'Pick matching points in A and B, or move B in overlay mode. Reset alignment restores the original position.'],
                    ['contrast', 'Background', 'Switch the model background between light and dark. Paper layouts stay light.'],
                ];
                el.innerHTML = `<div class="settings-section-title">${escapeHtml(tr('settingsTabHelp', 'Help'))}</div><ul class="settings-help-list">${help.map(([icon, label, hint]) => `<li class="settings-help-row"><i data-lucide="${icon}" aria-hidden="true"></i><span class="settings-help-key">${escapeHtml(label)}</span><span>${escapeHtml(hint)}</span></li>`).join('')}</ul>`;
                window.lucide?.createIcons({ nameAttr: 'data-lucide' });
                return;
            }
            const row = (label, hint, control) => `
                <div class="settings-row">
                    <div><div class="settings-row-label">${label}</div>${hint ? `<div class="settings-row-hint">${hint}</div>` : ''}</div>
                    <div class="settings-row-control">${control}</div>
                </div>`;
            const check = (id, on) => `<label class="settings-check"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}></label>`;
            const snapModes = [
                ['endpoint', 'snapEndpoint', 'snapEnd', 'Endpoint'],
                ['midpoint', 'snapMidpoint', 'snapMid', 'Midpoint'],
                ['center', 'snapCenter', 'snapCen', 'Center'],
                ['quadrant', 'snapQuadrant', 'snapQua', 'Quadrant'],
                ['intersection', 'snapIntersection', 'snapIntersection', 'Intersection'],
                ['perpendicular', 'snapPerpendicular', 'snapPerp', 'Perpendicular'],
                ['tangent', 'snapTangent', 'snapTan', 'Tangent'],
                ['node', 'snapNode', 'snapNode', 'Node'],
                ['insertion', 'snapInsertion', 'snapIns', 'Insertion'],
                ['edge', 'snapEdge', 'snapEdge', 'Edge'],
            ];
            el.innerHTML = `
                <div class="settings-section-title settings-section-title--first">${escapeHtml(tr('settingsDisplay', 'Display'))}</div>
                ${row(escapeHtml(tr('darkDrawingBackground', 'Dark drawing background')), escapeHtml(tr('darkModeHint', 'Drawing area only. Paper layouts are always light.')), check('set-dark', settings.darkMode))}
                ${row(escapeHtml(tr('setShowText', 'Show text')), '', check('set-text', settings.showText))}
                ${row(escapeHtml(tr('textHaloLabel', 'Text halo')), '', check('set-text-halo', settings.textHalo))}
                ${row(escapeHtml(tr('setShowFills', 'Show hatch fills')), '', check('set-fills', settings.showFills))}
                ${row(escapeHtml(tr('setShowPortals', 'Show model through viewports')), escapeHtml(tr('setShowPortalsHint', 'Render model content inside paper layout frames.')), check('set-portals', settings.showPortals))}
                ${row(escapeHtml(tr('osnapModeLabel', 'Object snap (F3)')), '', check('setting-osnap', settings.snapEnabled !== false))}
                <div class="settings-row" style="display:block;"><div class="osnap-modes">
                    ${snapModes.map(([mode, key, labelKey, label]) => `<label class="measure-snap-option"><input id="setting-snap-${mode}" type="checkbox" ${settings[key] !== false ? 'checked' : ''}><span class="dxf-snap-option-icon" aria-hidden="true" style="--dxf-snap-icon: url(../img/dxf/snaps/dxf-snap-${mode}.svg)"></span><span>${escapeHtml(tr(labelKey, label))}</span></label>`).join('')}
                </div></div>
                <div class="settings-section-title">${escapeHtml(tr('settingsMeasure', 'Measurement'))}</div>
                ${row(escapeHtml(tr('setPrecision', 'Decimals')), '', `<select id="set-precision" class="settings-select">${[0,1,2,3,4].map(n => `<option value="${n}" ${settings.measurePrecision === n ? 'selected' : ''}>${n}</option>`).join('')}</select>`)}
                ${row(escapeHtml(tr('setUnitLabel', 'Unit label')), escapeHtml(tr('setUnitHint', 'Appended to distances, e.g. m or mm.')), `<input id="set-unit" class="settings-select" style="width:70px" value="${escapeHtml(settings.unitLabel)}">`)}`;
            const rebuild = () => settingsChanged(true);
            el.querySelector('#setting-osnap').addEventListener('change', e => { settings.snapEnabled = e.target.checked; settingsChanged(false); });
            for (const [mode, key] of snapModes) el.querySelector('#setting-snap-' + mode).addEventListener('change', e => {
                settings[key] = e.target.checked; settingsChanged(false);
            });
            el.querySelector('#set-dark').addEventListener('change', e => { settings.darkMode = e.target.checked; applyThemeButton(); rebuild(); });
            el.querySelector('#set-text').addEventListener('change', e => { settings.showText = e.target.checked; rebuild(); });
            el.querySelector('#set-text-halo').addEventListener('change', e => { settings.textHalo = e.target.checked; rebuild(); });
            el.querySelector('#set-fills').addEventListener('change', e => { settings.showFills = e.target.checked; rebuild(); });
            el.querySelector('#set-portals').addEventListener('change', e => { settings.showPortals = e.target.checked; rebuild(); });
            el.querySelector('#set-precision').addEventListener('change', e => { settings.measurePrecision = Number(e.target.value); settingsChanged(false); });
            el.querySelector('#set-unit').addEventListener('input', e => { settings.unitLabel = e.target.value.trim(); settingsChanged(false); });
        }
        let controlsBound = false;
        function bindControls() {
            if (controlsBound) return;
            controlsBound = true;
            // ---- Sliding side panels (editor pattern: translate, canvas untouched) ----

            document.getElementById('btn-papers').addEventListener('click', () => setPapersOpen(!papersOpen()));
            document.getElementById('papers-close').addEventListener('click', () => setPapersOpen(false));

            document.getElementById('rp-tab-comparison').addEventListener('click', () => setRightTab('comparison'));
            document.getElementById('rp-tab-layers').addEventListener('click', () => setRightTab('layers'));
            document.getElementById('right-panel-close').addEventListener('click', () => setRightOpen(false));
            document.getElementById('btn-panel').addEventListener('click', () => {
                if (rightOpen() && rightTab === 'comparison') setRightOpen(false);
                else { setRightTab('comparison'); setRightOpen(true); }
            });
            document.getElementById('btn-layers-tab').addEventListener('click', () => {
                if (rightOpen() && rightTab === 'layers') setRightOpen(false);
                else { setRightTab('layers'); setRightOpen(true); }
            });

            document.getElementById('btn-settings').addEventListener('click', () => {
                const p = document.getElementById('settings-popup');
                const opening = p.classList.contains('closed');
                if (opening) { setPapersOpen(false); renderSettings(); }
                p.classList.toggle('closed', !opening);
                document.getElementById('btn-settings').classList.toggle('active', opening);
            });
            document.getElementById('settings-close').addEventListener('click', () => {
                document.getElementById('settings-popup').classList.add('closed');
                document.getElementById('btn-settings').classList.remove('active');
            });
            for (const tab of ['viewer', 'help']) document.getElementById('settings-tab-' + tab).addEventListener('click', () => {
                settingsTab = tab; renderSettings();
            });

        }
        return { entityLabel, renderCounts, layerSwatchColor, layerPresence, renderLayerList, escapeHtml, renderResultList, renderPapersList, setStatus, setPapersOpen, setRightOpen, setRightTab, applyThemeButton, renderSettings, bindControls };
    }
        function translate(window, key, fallback, params) {
            const d = (typeof window.getTranslations === 'function' ? window.getTranslations() : null) || window.PAGE_I18N || {};
            let s = d[key] || fallback || key;
            if (params) for (const [k, v] of Object.entries(params)) s = s.split('{' + k + '}').join(String(v));
            return s;
        }
    // Browser events delegate parsing, comparison and interaction policy to app actions.
    function createSessionUI(document, window, dependencies) {
        const { getFiles, selectFile, tr, onResize, requestRender, renderLayerList, actions, toggleCategory, changeTolerance } = dependencies;
        function wireDropZone(zoneId, inputId, nameId, slot) {
            const zone = document.getElementById(zoneId);
            const input = document.getElementById(inputId);
            const nameEl = document.getElementById(nameId);
            // Same interaction pattern as the viewer's drop-zone: the zone is
            // clickable except on the native file input inside it.
            zone.addEventListener('click', (e) => {
                if (e.target === input || input.contains(e.target)) return;
                input.click();
            });
            input.addEventListener('change', () => { if (input.files[0]) setFile(input.files[0]); });
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }));
            ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, () => zone.classList.add('dragover')));
            ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, () => zone.classList.remove('dragover')));
            zone.addEventListener('drop', e => { if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
            function setFile(f) {
                selectFile(slot, f);
                nameEl.textContent = f.name;
                nameEl.classList.remove('text-slate-500');
                nameEl.classList.add('text-blue-600');
                updateOpenButton();
            }
        }
        function updateOpenButton() {
            const fileState = getFiles();
            const btn = document.getElementById('btn-open');
            btn.disabled = !fileState.a && !fileState.b;
            const label = btn.querySelector('span');
            if (fileState.a && fileState.b) label.textContent = tr('openCompareBtn', 'Compare');
            else label.textContent = tr('openViewBtn', 'View drawing');
            const fmt = f => f ? `${f.name} (${(f.size / 1024).toFixed(1)} KB)` : '-';
            document.getElementById('info-file-a').textContent = fmt(fileState.a);
            document.getElementById('info-file-b').textContent = fmt(fileState.b);
            const fmtDate = f => (f && f.lastModified) ? new Date(f.lastModified).toLocaleString() : '-';
            document.getElementById('info-date-a').textContent = fmtDate(fileState.a);
            document.getElementById('info-date-b').textContent = fmtDate(fileState.b);
        }
        wireDropZone('drop-a', 'input-a', 'file-a-name', 'a');
        wireDropZone('drop-b', 'input-b', 'file-b-name', 'b');

        const appSidebar = document.getElementById('app-sidebar');
        const sidebarTexts = document.querySelectorAll('.sidebar-text');
        let isSidebarExpanded = false;
        document.getElementById('sidebar-toggle').addEventListener('click', () => {
            isSidebarExpanded = !isSidebarExpanded;
            const toggleWrapper = document.getElementById('sidebar-toggle-icon-wrapper');
            if (isSidebarExpanded) {
                appSidebar.classList.replace('w-[72px]', 'w-64');
                toggleWrapper.style.transform = 'rotate(180deg)';
                sidebarTexts.forEach(t => t.classList.replace('opacity-0', 'opacity-100'));
            } else {
                appSidebar.classList.replace('w-64', 'w-[72px]');
                toggleWrapper.style.transform = 'rotate(0deg)';
                sidebarTexts.forEach(t => t.classList.replace('opacity-100', 'opacity-0'));
            }
            window.setTimeout(onResize, 300);
        });
        const tabs = document.querySelectorAll('.tab-btn[data-target]');
        const panels = document.querySelectorAll('.view-panel');
        function switchTab(targetId) {
            tabs.forEach(t => t.classList.remove('active'));
            document.querySelector(`[data-target="${targetId}"]`)?.classList.add('active');
            panels.forEach(p => {
                if (p.id === targetId) { p.classList.remove('hidden'); p.classList.add('flex'); p.style.zIndex = '10'; }
                else { p.classList.add('hidden'); p.classList.remove('flex'); p.style.zIndex = '1'; }
            });
            if (targetId === 'view-compare') {
                window.setTimeout(() => { onResize(); requestRender(); }, 50);
            }
        }
        tabs.forEach(tab => tab.addEventListener('click', () => { if (!tab.disabled) switchTab(tab.dataset.target); }));


        for (const [id, action] of Object.entries(actions)) {
            document.getElementById(id).addEventListener('click', action);
        }
        document.getElementById('layer-filter').addEventListener('input', renderLayerList);
        document.querySelectorAll('#cat-chips .cat-chip').forEach(chip => {
            chip.addEventListener('click', () => chip.classList.toggle('off', !toggleCategory(chip.dataset.cat)));
        });
        const slider = document.getElementById('tol-slider');
        slider.addEventListener('input', () => {
            document.getElementById('tol-value').textContent = '1e' + slider.value;
            changeTolerance(slider.value);
        });
        return { updateOpenButton, switchTab };
    }
    return { create, translate, createSessionUI };
});
