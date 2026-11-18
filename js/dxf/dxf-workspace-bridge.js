// Resolve the public adapter inside the owning document's module realm.
window.DxfWorkspaceReady = import(document.querySelector('script[type="module"][src]').src)
    .then(module => module.workspace);
// The host handles a rejected module; standalone pages retain normal error reporting.
window.DxfWorkspaceReady.catch(() => {});
if (window.parent !== window) {
    document.addEventListener('click', event => {
        const link = event.target.closest?.('a[href]');
        if (link && !link.hasAttribute('download') && !link.getAttribute('href').startsWith('#') && !link.target)
            link.target = '_top';
    }, true);
}
