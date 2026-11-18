// Native composition: retained roots, guarded navigation and explicit snapshots.
// Inactive roots are detached; app adapters keep drawing and recovery ownership.
(function () {
    'use strict';
    const initialURL = new URL(location.href);
    const initialMode = initialURL.searchParams.get('mode') === 'compare' ? 'compare' : 'editor';
    const stage = document.getElementById('workspace-stage');
    const status = document.getElementById('workspace-status');
    const retry = document.getElementById('workspace-retry');
    const sessions = new Map();
    const entries = { ...document.currentScript.dataset };
    const editorRoot = document.querySelector('[data-dxf-mode="editor"]');
    const roots = new Map([['editor', editorRoot]]);
    const styles = new Map([['editor', [document.querySelector('link[href*="/cadscope.css"]')]]]);
    const loadedScripts = new Set([...document.scripts].filter(s => s.src).map(s => new URL(s.src).pathname));
    const dictionaries = new Map([['editor', { ...window.BASE_PAGE }]]);
    DxfSidebar.register('editor', editorRoot, stage);
    DxfModeDOM.register('editor', editorRoot, initialMode === 'editor' ? initialURL.search : '');
    let sharedFooter;
    const attempts = new Map();
    async function script(src) {
        const url = new URL(src, location.href);
        if (loadedScripts.has(url.pathname)) return;
        await new Promise((resolve, reject) => {
            const element = document.createElement('script'); element.src = url.href;
            element.onload = resolve;
            element.onerror = () => { element.remove(); reject(new Error('Could not load ' + url.pathname)); };
            document.head.append(element);
        });
        loadedScripts.add(url.pathname);
    }
    function applyStyles(selected) {
        styles.forEach((links, name) => links.forEach(link => { link.disabled = name !== selected; }));
    }
    async function language(selected) {
        if (!dictionaries.has(selected)) {
            await script('../lang/en/dxf-compare.js?v=setup-parity-1');
            dictionaries.set(selected, { ...window.PAGE_I18N });
        }
        window.BASE_PAGE = dictionaries.get(selected);
        window.pageScriptPrefix = selected === 'editor' ? 'cadscope' : 'dxf-compare';
        window.EN_PAGE = dictionaries.get(selected);
        window.updateToolDynamicUI = () => {
            window[selected === 'editor' ? 'refreshDxfTranslations' : 'refreshCompareTranslations']?.();
        };
        await new Promise(resolve => {
            document.addEventListener('languageLoaded', resolve, { once: true });
            window.loadLanguage(document.documentElement.lang || 'en', window.pageScriptPrefix);
        });
    }
    let snapshotStamp = null;
    let mode = null, switching = false, traversing = false, message = '', failedMode = null;
    let position = 0, returning = null;
    const identity = crypto.randomUUID();
    const words = {
        es: ['Termina la operación actual antes de cambiar de espacio.', 'No se pudo abrir el espacio de trabajo. Inténtalo de nuevo.', 'Reintentar'],
        fr: ['Terminez l’opération en cours avant de changer d’espace.', 'Impossible d’ouvrir cet espace. Réessayez.', 'Réessayer'],
        de: ['Beenden Sie den aktuellen Vorgang vor dem Wechsel.', 'Der Arbeitsbereich konnte nicht geöffnet werden. Versuchen Sie es erneut.', 'Erneut versuchen'],
        it: ['Completa l’operazione prima di cambiare area di lavoro.', 'Impossibile aprire l’area di lavoro. Riprova.', 'Riprova'],
        pt: ['Conclua a operação atual antes de mudar de espaço.', 'Não foi possível abrir o espaço. Tente novamente.', 'Tentar novamente'],
        zh: ['请先完成当前操作，再切换工作区。', '无法打开工作区，请重试。', '重试'],
        ja: ['切り替える前に現在の操作を完了してください。', 'ワークスペースを開けませんでした。再試行してください。', '再試行'],
        ko: ['작업 공간을 전환하기 전에 현재 작업을 완료하세요.', '작업 공간을 열 수 없습니다. 다시 시도하세요.', '다시 시도'],
    };
    const transferErrors = {
        es: 'La transferencia falló. Se conserva la comparación anterior. Inténtalo de nuevo.',
        fr: 'Le transfert a échoué. La comparaison précédente est conservée. Réessayez.',
        de: 'Die Übertragung ist fehlgeschlagen. Der bisherige Vergleich bleibt erhalten. Versuchen Sie es erneut.',
        it: 'Trasferimento non riuscito. Il confronto precedente è conservato. Riprova.',
        pt: 'A transferência falhou. A comparação anterior é mantida. Tente novamente.',
        zh: '快照传输失败。已保留之前的比较，请重试。',
        ja: 'スナップショットの転送に失敗しました。以前の比較は保持されています。再試行してください。',
        ko: '스냅샷 전송에 실패했습니다. 이전 비교는 유지됩니다. 다시 시도하세요.',
    };
    function translate() {
        let lang = navigator.language.split('-')[0];
        try { lang = localStorage.getItem('liteAECOLang') || lang; } catch { /* Session-only preference. */ }
        document.documentElement.lang = lang;
        const text = ["workspaceFinishOperation","workspaceOpenFailed","workspaceRetry"].map((key, i) => window.PAGE_I18N?.[key] || words[lang]?.[i] || window.CADSCOPE_EN[key]);
        status.textContent = message === '' ? '' : message === 'transfer-error' ? window.PAGE_I18N?.workspaceTransferFailed || transferErrors[lang] || window.CADSCOPE_EN.workspaceTransferFailed : text[message];
        retry.textContent = text[2];
        status.parentElement.hidden = message === '' && retry.hidden;
    }
    function report(key) { message = key; translate(); }
    function show(selected) {
        const root = roots.get(selected);
        sharedFooter ||= document.getElementById('app-footer');
        roots.forEach((element, name) => { if (name !== selected) element.remove(); });
        if (root) {
            stage.append(root);
            if (sharedFooter) root.querySelector('#view-upload').append(sharedFooter);
        }
        stage.dataset.mode = selected;
        document.title = selected === 'compare' ? 'CADCompare - DXF & DWG Comparison | liteAECO'
            : 'CADScope - 2D DXF & DWG Viewer and Editor | liteAECO';
        DxfSidebar.show(selected);
        applyStyles(selected);
    }
    function updateTransfer() {
        const editor = sessions.get('editor'), compare = sessions.get('compare');
        compare?.controls.update({ available: !!editor?.workspace.getState().hasDocument,
            empty: !compare.workspace.getState().hasDocument && !compare.workspace.getState().hasInputs, stamp: snapshotStamp });
    }
    function setBusy(value) {
        switching = value;
        const busy = switching || traversing;
        stage.setAttribute('aria-busy', String(busy));
        DxfSidebar.busy(busy);
        sessions.forEach(session => session.controls.busy(busy));
    }
    // Handoff parameters belong only to their original mode. Switching to Editor
    // cannot replay a Compare project open; the retained Compare frame owns it.
    function urlFor(selected) {
        const url = new URL(initialURL);
        if (selected !== initialMode) url.search = '';
        url.searchParams.delete('standalone');
        url.searchParams.set('mode', selected);
        return url;
    }
    function historyState() { return { ...history.state, dxfWorkspace: { identity, position, mode } }; }
    async function load(selected) {
        if (sessions.has(selected)) return sessions.get(selected);
        if (!roots.has(selected)) {
            const response = await fetch('dxf-compare.html');
            if (!response.ok) throw new Error('Could not load Compare');
            const source = new DOMParser().parseFromString(await response.text(), 'text/html');
            const root = document.createElement('div');
            root.className = 'dxf-mode-root'; root.dataset.dxfMode = selected;
            // The standalone Compare page is also its markup/dependency source.
            root.append(document.importNode(source.querySelector('main'), true));
            const links = [];
            for (const item of styles.has(selected) ? [] : source.querySelectorAll('link[rel="stylesheet"]')) {
                if (!item.getAttribute('href').includes('/dxf-compare.css')) continue;
                const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = item.getAttribute('href');
                await new Promise((resolve, reject) => {
                    link.onload = resolve; link.onerror = () => { link.remove(); reject(new Error('Could not load Compare styles')); }; document.head.append(link);
                });
                links.push(link);
            }
            if (links.length) styles.set(selected, links);
            for (const item of source.querySelectorAll('script[src]:not([type="module"])')) {
                const src = item.getAttribute('src');
                if (/dxf-workspace-(entry|bridge)|dxf-page-bootstrap|\/common\.js|\/lang\//.test(src)) continue;
                await script(src);
            }
            DxfSidebar.register(selected, root, stage);
            roots.set(selected, root);
            DxfModeDOM.register(selected, root, selected === initialMode ? initialURL.search : '');
        }
        show(selected);
        await language(selected);
        const url = new URL(entries[selected + 'Module'], location.href);
        const attempt = attempts.get(selected) || 0;
        if (attempt) url.searchParams.set('retry', attempt);
        attempts.set(selected, attempt + 1);
        const module = await import(url.href);
        const workspace = module.workspace;
        const scoped = DxfModeDOM.documentFor(selected);
        const controls = DxfWorkspaceControls.install({ mode: selected, select: choose, transfer, document: scoped });
        const session = { root: roots.get(selected), workspace, controls };
        sessions.set(selected, session);
        return session;
    }
    async function select(selected) {
        if (switching) { report(0); return false; }
        if (mode === selected) return true;
        const previous = mode, outgoing = sessions.get(previous);
        setBusy(true); retry.hidden = true; failedMode = null;
        try {
            if (outgoing) {
                const result = await outgoing.workspace.suspend();
                if (!['completed', 'unchanged'].includes(result.status)) { report(0); return false; }
            }
            report('');
            const retained = sessions.has(selected);
            const incoming = await load(selected);
            show(selected);
            if (retained) await language(selected);
            const result = await incoming.workspace.activate();
            if (!['completed', 'unchanged'].includes(result.status)) throw new Error('Activation blocked');
            mode = selected; report(''); translate(); updateTransfer();
            return true;
        } catch (error) {
            console.error('DXF workspace switch failed:', error);
            if (outgoing) {
                show(previous);
                await language(previous);
                await outgoing.workspace.activate();
            }
            failedMode = selected; retry.hidden = false; report(1);
            return false;
        } finally { setBusy(false); }
    }
    async function choose(selected) {
        if (traversing || selected === mode) return;
        if (await select(selected)) {
            // Like PDFScope, selecting a tool keeps the opening screen visible.
            // The native Viewer rail action returns to the retained document.
            DxfModeDOM.documentFor(selected).getElementById('tab-upload').click();
            position++;
            history.pushState(historyState(), '', urlFor(mode));
        }
    }
    async function transfer() {
        if (switching || traversing || mode !== 'compare') return;
        const editor = sessions.get('editor'), compare = sessions.get('compare');
        if (!editor || !compare) return;
        setBusy(true); retry.hidden = true;
        try {
            const result = await editor.workspace.snapshot();
            if (result.status !== 'completed') { report(0); return; }
            const received = await compare.workspace.receiveSnapshot(result.snapshot);
            if (received.status === 'completed') { snapshotStamp = result.snapshot.createdAt; report(''); }
            else if (received.status === 'blocked') report(0);
            else if (received.status === 'cancelled') report('');
            else report('transfer-error');
        } catch (error) { console.error('Editor snapshot transfer failed:', error); report('transfer-error'); }
        finally { setBusy(false); updateTransfer(); }
    }
    retry.addEventListener('click', () => choose(failedMode || initialMode));
    // Restore the current history position before attempting a guarded transition.
    // A refused Back leaves its forward entry intact, so retrying after a command
    // finishes works without replaying imports or losing either retained session.
    const travel = delta => new Promise(resolve => { returning = resolve; history.go(delta); });
    addEventListener('popstate', async event => {
        if (returning) { const done = returning; returning = null; done(); return; }
        const target = event.state?.dxfWorkspace;
        if (!target || target.identity !== identity) { history.replaceState(historyState(), '', urlFor(mode || initialMode)); return; }
        const delta = target.position - position;
        if (!delta) return;
        const busy = switching || traversing;
        traversing = true;
        setBusy(switching);
        await travel(-delta);
        try {
            if (busy) { report(0); return; }
            if (await select(target.mode)) {
                await travel(delta); position = target.position;
            }
        } finally { traversing = false; setBusy(switching); }
    });
    addEventListener('storage', event => { if (event.key === 'liteAECOLang') translate(); });
    document.addEventListener('languageLoaded', translate);
    translate();
    window.DxfWorkspaceReady = select(initialMode).then(ok => {
        history.replaceState(historyState(), '', urlFor(ok ? mode : initialMode));
        if (!ok) throw new Error('DXF startup failed');
        return sessions.get(mode).workspace;
    });
    window.DxfWorkspaceReady.catch(() => {});
})();
