/* Shared site shell for the DXF pages. Load as a classic script before app modules. */
(function () {
    const { dxfRefresh, dxfIcons } = document.currentScript.dataset;

    window.BASE_PAGE = JSON.parse(JSON.stringify(window.PAGE_I18N || {}));

    // Resolve the callback on each language change: the app module loads later.
    window.updateToolDynamicUI = function (dictionary) {
        if (typeof window[dxfRefresh] === 'function') window[dxfRefresh](dictionary);
    };

    // Keep the injected footer inside the upload view so view switching hides it.
    function placeFooter() {
        const footer = document.querySelector('footer') || document.getElementById('app-footer');
        const uploadView = document.getElementById('view-upload');
        if (!footer || !uploadView) return;

        footer.id = 'app-footer';
        footer.classList.remove('sticky', 'bottom-0', 'fixed', 'absolute', 'z-[60]');
        footer.classList.add('w-full', 'shrink-0', 'relative', 'mt-auto');
        uploadView.appendChild(footer);
    }

    // Detect language before creating the site shell, then load page translations.
    function bootApp() {
        autoDetectLanguage();
        window.injectUI({
            showNav: true,
            linkTarget: '',
            transparentNav: false,
            showSignIn: false,
            showCategories: true,
            showNews: false,
            showHelp: true,
            showFooter: true,
            showFooterLinks: false,
        });
        window.injectCookieBanner();
        placeFooter();
        window.loadLanguage(currentLang, window.pageScriptPrefix);
        if (dxfIcons === 'true' && window.lucide) window.lucide.createIcons();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootApp);
    } else {
        bootApp();
    }
})();
