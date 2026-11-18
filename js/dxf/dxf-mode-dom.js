// Retained roots own element lookup even while detached. Browser services and
// page-lifetime events (visibility/recovery) still belong to the real document.
window.DxfModeDOM = (() => {
    const roots = new Map(), documents = new Map(), searches = new Map();
    function register(mode, root, search = '') { roots.set(mode, root); searches.set(mode, search); }
    function documentFor(mode) {
        if (!roots.has(mode)) return document; // Standalone diagnostic page.
        if (documents.has(mode)) return documents.get(mode);
        const root = roots.get(mode), bindings = new Map();
        const navigation = () => window.DxfSidebar?.navigation(mode);
        const query = selector => root.querySelector(selector) || navigation()?.querySelector(selector) || null;
        const scoped = new Proxy(document, {
            get(target, key) {
                if (key === 'modeRoot' || key === 'body') return root;
                if (key === 'modeSearch') return searches.get(mode);
                if (key === 'getElementById') return id => query('#' + CSS.escape(id));
                if (key === 'querySelector') return selector => query(selector);
                if (key === 'querySelectorAll') return selector => [...root.querySelectorAll(selector), ...(navigation()?.querySelectorAll(selector) || [])];
                if (key === 'addEventListener') return (type, listener, options) => {
                    if (type !== 'languageLoaded') return target.addEventListener(type, listener, options);
                    const wrapped = event => { if (root.isConnected) listener(event); };
                    bindings.set(listener, wrapped); target.addEventListener(type, wrapped, options);
                };
                if (key === 'removeEventListener') return (type, listener, options) => {
                    target.removeEventListener(type, bindings.get(listener) || listener, options);
                    bindings.delete(listener);
                };
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        documents.set(mode, scoped);
        return scoped;
    }
    return { register, documentFor };
})();
