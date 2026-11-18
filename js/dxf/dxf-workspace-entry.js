// Compatibility URLs enter the canonical native page with handoff parameters.
// Standalone Compare diagnostics retain their existing document.
(function () {
    const url = new URL(location.href);
    if (window.parent !== window || url.searchParams.get('standalone') === '1') return;
    const mode = document.currentScript.dataset.mode;
    url.pathname = url.pathname.replace(/(?:dxf-(?:workspace|compare)|dxfscope)\.html$/, 'cadscope.html');
    if (!['editor', 'compare'].includes(url.searchParams.get('mode'))) url.searchParams.set('mode', mode || 'editor');
    location.replace(url.href);
})();
