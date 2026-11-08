/* Pure command-profile validation and compilation. No activation or browser state. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfEditorCommandLanguage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const record = value => value !== null && typeof value === 'object'
        && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
    const normalize = value => typeof value === 'string' ? value.trim().normalize('NFC').toUpperCase().normalize('NFC') : '';
    const validAlias = value => /^[\p{L}][\p{L}\p{M}\p{Nd}]*$/u.test(value)
        && !/\p{Default_Ignorable_Code_Point}/u.test(value) && [...value].length <= 64;

    // Returns no candidate on failure, so callers cannot accidentally activate a partial map.
    function compile(profile, commands, { expectedId } = {}) {
        const errors = [];
        const error = (code, commandId = null, alias = null, normalized = null, conflictingOwner = null) => {
            errors.push({ code, profileId: typeof profile?.id === 'string' ? profile.id : null,
                commandId, alias, normalized, conflictingOwner });
        };
        const base = new Map(), byId = new Map();
        if (!Array.isArray(commands) || !commands.length) error('invalid-registry');
        else for (const command of commands) {
            if (!command || typeof command.tool !== 'string' || !command.tool || byId.has(command.tool)
                || !Array.isArray(command.aliases) || !command.aliases.length) {
                error('invalid-registry'); continue;
            }
            byId.set(command.tool, command);
            for (const alias of command.aliases) {
                const token = normalize(alias);
                if (!validAlias(token) || base.has(token)) error('invalid-registry-alias', command.tool, alias, token, base.get(token) ?? null);
                else base.set(token, command.tool);
            }
        }
        if (!record(profile)) error('invalid-profile');
        else {
            for (const key of Object.keys(profile)) if (!['schemaVersion', 'id', 'name', 'commands'].includes(key)) error('unknown-field', null, key);
            if (profile.schemaVersion !== 1) error('unsupported-schema');
            if (typeof profile.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(profile.id) || profile.id.length > 64) error('invalid-id');
            if (expectedId !== undefined && profile.id !== expectedId) error('id-mismatch');
            if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 128) error('invalid-name');
            if (!record(profile.commands)) error('invalid-commands');
        }
        if (errors.length) return { ok: false, errors };

        const local = new Map(), localized = new Map();
        for (const [id, aliases] of Object.entries(profile.commands)) {
            if (!byId.has(id)) { error('unknown-command', id); continue; }
            if (!Array.isArray(aliases) || !aliases.length) { error('invalid-alias-list', id); continue; }
            const tokens = [];
            for (const alias of aliases) {
                const token = normalize(alias);
                if (!validAlias(token)) { error('invalid-alias', id, alias, token); continue; }
                if (local.has(token)) {
                    error(local.get(token) === id ? 'duplicate-alias' : 'local-conflict', id, alias, token, local.get(token));
                    continue;
                }
                local.set(token, id);
                if (base.has(token) && base.get(token) !== id) error('english-conflict', id, alias, token, base.get(token));
                tokens.push(token);
            }
            localized.set(id, tokens);
        }
        // The shipped base profile must exactly describe the built-in English aliases.
        if (profile.id === 'en') for (const [id, command] of byId) {
            const tokens = localized.get(id) || [];
            const english = command.aliases.map(normalize);
            if (tokens.length !== english.length || english.some(token => !tokens.includes(token))) error('english-parity', id);
        }
        if (errors.length) return { ok: false, errors };
        const aliasMap = new Map(base);
        for (const [token, id] of local) aliasMap.set(token, id);
        const effectiveCommands = commands.map(command => ({ ...command,
            aliases: [...new Set([...(localized.get(command.tool) || []), ...command.aliases.map(normalize)])] }));
        return { ok: true, errors: [], profile: { schemaVersion: 1, id: profile.id, name: profile.name },
            aliasMap, commands: effectiveCommands };
    }
    function validate(profile, commands, options) {
        const { ok, errors } = compile(profile, commands, options);
        return { ok, errors };
    }
    // Input classification is shared with validation; tool/numeric priority stays in the app.
    const isCommandWord = value => typeof value === 'string' && validAlias(normalize(value));
    const hasCommandLetter = value => typeof value === 'string' && /\p{L}/u.test(value);
    const isLetterKey = value => typeof value === 'string' && /^\p{L}\p{M}*$/u.test(value.normalize('NFC'))
        && !/\p{Default_Ignorable_Code_Point}/u.test(value);
    const isComposing = event => !!event.isComposing || event.keyCode === 229 || ['Process', 'Dead'].includes(event.key);
    const hasCommandModifier = event => !!(event.ctrlKey || event.metaKey || event.altKey);
    const isTypingTarget = element => !!element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable === true);
    return { normalize, validate, compile, isCommandWord, hasCommandLetter, isLetterKey,
        isComposing, hasCommandModifier, isTypingTarget };
});
