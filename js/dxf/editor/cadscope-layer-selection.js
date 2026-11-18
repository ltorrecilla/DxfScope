/* Layer-list selection rules; never mutate drawing layers or the caller's selection. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfEditorLayerSelection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function select(selected, anchor, name, modifiers, orderedNames) {
        const names = new Set(selected);
        if (modifiers.shiftKey && orderedNames.includes(anchor)) {
            const a = orderedNames.indexOf(anchor), b = orderedNames.indexOf(name);
            if (!modifiers.ctrlKey && !modifiers.metaKey) names.clear();
            for (const layer of orderedNames.slice(Math.min(a, b), Math.max(a, b) + 1)) names.add(layer);
        } else if (modifiers.ctrlKey || modifiers.metaKey) {
            if (names.has(name)) names.delete(name);
            else names.add(name);
            anchor = name;
        } else {
            return { names: new Set([name]), anchor: name };
        }
        return { names, anchor };
    }

    function filter(names, text) {
        const query = text.trim().toLowerCase();
        return names.filter(name => !query || name.toLowerCase().includes(query));
    }

    return { select, filter };
});
