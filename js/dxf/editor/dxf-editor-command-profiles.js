/* Profile loading and preference orchestration; drawing state is supplied by callbacks. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfEditorCommandProfiles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const KEY = 'dxfEditorCommandLanguage';
    function validateManifest(value) {
        if (!value || value.schemaVersion !== 1 || Object.keys(value).sort().join() !== 'profiles,schemaVersion'
            || !Array.isArray(value.profiles) || !value.profiles.length || value.profiles[0]?.id !== 'en') throw Error('Invalid command profile manifest.');
        const ids = new Set();
        for (const entry of value.profiles) {
            if (!entry || Object.keys(entry).sort().join() !== 'file,id,name' || typeof entry.id !== 'string'
                || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(entry.id) || entry.id.length > 64
                || entry.file !== entry.id + '.json' || typeof entry.name !== 'string' || !entry.name.trim()
                || entry.name.length > 128 || ids.has(entry.id)) throw Error('Invalid command profile entry.');
            ids.add(entry.id);
        }
        return value.profiles.map(entry => ({ ...entry }));
    }
    function create({ registry, loadJson, storage, isIdle, changed = () => {} }) {
        let entries = [{ id: 'en', name: 'English', file: 'en.json' }], loading = false, message = '', request = 0;
        const english = { schemaVersion: 1, id: 'en', name: 'English',
            commands: Object.fromEntries(registry.canonicalCommands.map(c => [c.tool, [...c.aliases]])) };
        function state() { return { entries: entries.map(e => ({ ...e })), loading, message, activeId: registry.profile.id }; }
        function notify() { changed(state()); }
        async function select(id, { startup = false } = {}) {
            const token = ++request;
            loading = false;
            if (!isIdle()) { message = 'Finish the current tool or input before changing command language.'; notify(); return false; }
            loading = true; message = 'Loading command profile…'; notify();
            try {
                const entry = entries.find(e => e.id === id);
                if (!entry) throw Error('Command profile is not registered.');
                const profile = id === 'en' ? english : await loadJson(entry.file);
                if (token !== request) return false;
                if (!isIdle()) throw Error('Drawing is busy; command language was not changed.');
                if (profile.name !== entry.name) throw Error('Command profile name does not match the manifest.');
                const result = registry.activateProfile(profile, { expectedId: id });
                if (!result.ok) throw Error(result.errors.map(e => [e.code, e.commandId, e.normalized, e.conflictingOwner].filter(Boolean).join(': ')).join('; '));
                message = '';
                try { storage.setItem(KEY, id); } catch (_) { message = 'Command language changed for this session; preference could not be saved.'; }
                return true;
            } catch (error) {
                if (token !== request) return false;
                message = error.message || 'Command profile could not be loaded.';
                if (startup) message += ' Using built-in English.';
                return false;
            } finally {
                if (token === request) { loading = false; notify(); }
            }
        }
        async function init() {
            const token = ++request;
            loading = true; notify();
            try {
                const manifest = validateManifest(await loadJson('manifest.json'));
                if (token !== request) return;
                entries = manifest;
            } catch (_) {
                if (token !== request) return;
                loading = false; message = 'Profile list unavailable. Using built-in English.'; notify(); return;
            }
            let saved = 'en';
            try { saved = storage.getItem(KEY) || 'en'; } catch (_) { /* English works without storage. */ }
            if (token !== request) return;
            await select(saved, { startup: true });
        }
        return { init, select, state };
    }
    return { create, validateManifest, preferenceKey: KEY };
});
