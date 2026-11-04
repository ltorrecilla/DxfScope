/* Shared, opt-in theme controller. Load synchronously in the head before styles. */
(function () {
    'use strict';
    const root = document.documentElement;
    const key = 'liteAECOTheme';
    const system = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const valid = value => value === 'light' || value === 'dark';
    let preference = null;
    try {
        const saved = localStorage.getItem(key);
        if (valid(saved)) preference = saved;
    } catch (_) { /* The current page still supports a theme choice without storage. */ }

    root.dataset.themeEnabled = 'true';

    function refreshControls() {
        const dark = root.classList.contains('dark');
        const labelKey = dark ? 'themeSwitchLight' : 'themeSwitchDark';
        const fallback = dark ? 'Switch to light theme' : 'Switch to dark theme';
        const label = typeof window.t === 'function' ? window.t(labelKey, fallback) : fallback;
        document.querySelectorAll('[data-theme-toggle], #theme-toggle').forEach(button => {
            button.setAttribute('aria-label', label);
            button.title = label;
        });
    }

    function apply() {
        const dark = preference ? preference === 'dark' : !!(system && system.matches);
        root.classList.toggle('dark', dark);
        root.style.colorScheme = dark ? 'dark' : 'light';
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = dark ? '#171717' : '#ffffff';
        refreshControls();
        document.dispatchEvent(new CustomEvent('liteaeco:themechange', { detail: { theme: dark ? 'dark' : 'light' } }));
    }

    function toggle() {
        preference = root.classList.contains('dark') ? 'light' : 'dark';
        try { localStorage.setItem(key, preference); } catch (_) { }
        apply();
    }

    function installControls(nav) {
        if (nav.querySelector('[data-theme-toggle]')) return;
        const makeButton = (classes) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.themeToggle = '';
            button.className = 'theme-toggle ' + classes;
            button.innerHTML = '<i data-lucide="moon" class="w-[18px] h-[18px] dark:hidden" aria-hidden="true"></i><i data-lucide="sun" class="w-[18px] h-[18px] hidden dark:block" aria-hidden="true"></i>';
            button.addEventListener('click', toggle);
            return button;
        };
        const desktopAnchor = nav.querySelector('#dynamic-help-btn') || nav.querySelector('#langToggleWrap');
        if (desktopAnchor) desktopAnchor.before(makeButton('hidden md:inline-flex'));
        const mobileAnchor = nav.querySelector('#mobile-menu-toggle');
        const mobileButton = makeButton('inline-flex md:hidden ml-auto mr-2');
        if (mobileAnchor) mobileAnchor.before(mobileButton);
        else if (desktopAnchor) desktopAnchor.parentElement.after(mobileButton);
        refreshControls();
        if (window.lucide) window.lucide.createIcons();
    }

    window.LiteAECOTheme = { toggle, refreshControls, installControls };
    // Preserve the landing-page button's existing handler.
    window.toggleTheme = toggle;
    apply();
    if (system && system.addEventListener) system.addEventListener('change', () => { if (!preference) apply(); });
    window.addEventListener('storage', event => {
        if (event.key !== key && event.key !== null) return;
        preference = valid(event.newValue) ? event.newValue : null;
        apply();
    });
    document.addEventListener('DOMContentLoaded', refreshControls);
    document.addEventListener('languageLoaded', refreshControls);
})();
