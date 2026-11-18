// One page-lifetime rail. Tools retain their own menu actions and selected/
// disabled state; only the active menu is attached to the shared navigation.
window.DxfSidebar = (() => {
    const modes = new Map();
    let rail, nav, brand, toggle, active, expanded = false, resizeTimer;
    function labels(container) {
        container.querySelectorAll('.sidebar-text').forEach(label => {
            label.classList.toggle('opacity-0', !expanded);
            label.classList.toggle('opacity-100', expanded);
        });
    }
    function register(mode, root, host) {
        if (modes.has(mode)) return;
        const source = root.querySelector('#app-sidebar');
        const sourceNav = source.querySelector('#sidebar-nav');
        const menu = document.createElement('div');
        menu.className = 'space-y-2';
        menu.dataset.dxfNavigation = mode;
        menu.append(...sourceNav.children);
        modes.set(mode, { menu, icon: source.firstElementChild.firstElementChild.cloneNode(true) });
        if (!rail) {
            rail = source; nav = sourceNav; brand = rail.firstElementChild;
            toggle = rail.querySelector('#sidebar-toggle');
            toggle.setAttribute('aria-expanded', 'false');
            toggle.setAttribute('aria-label', 'Toggle navigation');
            toggle.addEventListener('click', () => {
                expanded = !expanded;
                rail.classList.toggle('w-64', expanded);
                rail.classList.toggle('w-[72px]', !expanded);
                toggle.setAttribute('aria-expanded', String(expanded));
                rail.querySelector('#sidebar-toggle-icon-wrapper').style.transform = expanded ? 'rotate(180deg)' : '';
                labels(rail);
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => modes.get(active)?.resize?.(), 300);
            });
            if (host) host.prepend(rail);
        } else source.remove();
        if (!active) show(mode);
    }
    function show(mode) {
        const entry = modes.get(mode);
        if (!entry || active === mode) return;
        active = mode;
        // Apply label visibility while detached: switching never animates width.
        labels(entry.menu);
        nav.replaceChildren(entry.menu);
        brand.firstElementChild.replaceWith(entry.icon);
        brand.querySelector('[data-i18n="appName"]').textContent = mode === 'editor' ? 'CADScope' : 'CADCompare';
        labels(brand);
    }
    function connect(mode, root, resize) {
        register(mode, root); // Standalone Compare uses the same controller.
        modes.get(mode).resize = resize;
    }
    return { register, show, connect, navigation: mode => modes.get(mode)?.menu,
        busy: value => { if (nav) nav.inert = value; } };
})();
