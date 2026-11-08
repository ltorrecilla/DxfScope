/* Editor command registry and alias dispatch. Actions are supplied lazily by the app. */
(function (root, factory) {
    const api = factory(typeof module === 'object' && module.exports
        ? require('./dxf-editor-command-language.js') : root.DxfEditorCommandLanguage);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfEditorCommands = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (language) {
    'use strict';
    function create({ actions, tr, announce, startDraw, startOps, startModify, handleOption = () => false }) {
        const COMMAND_LABELS = {
            line: 'Line', polyline: 'Polyline', rect: 'Rectangle', circle: 'Circle',
            arc: 'Arc', ellipse: 'Ellipse', spline: 'Spline', text: 'Text', mtext: 'MTEXT',
            leader: 'Leader', wipeout: 'Wipeout', dim: 'Linear dimension',
            'dim-aligned': 'Aligned dimension', 'dim-radial': 'Radial dimension',
            'dim-diameter': 'Diameter dimension', 'dim-ordinate': 'Ordinate dimension',
            viewport: 'Viewport', move: 'Move', copy: 'Copy', rotate: 'Rotate',
            mirror: 'Mirror', scale: 'Scale', stretch: 'Stretch', array: 'Array',
            trim: 'Trim', extend: 'Extend',
            offset: 'Offset', fillet: 'Fillet', chamfer: 'Chamfer',
            break: 'Break', lengthen: 'Lengthen', hatch: 'Hatch', table: 'Table',
            'create-block': 'Create block', 'insert-block': 'Insert block', explode: 'Explode',
            clean: 'Clean geometry', polygon: 'Polygon', join: 'Join', attedit: 'Edit block attributes',
            donut: 'Donut', xline: 'Construction line', ray: 'Ray',
            regen: 'Regenerate drawing', matchprop: 'Match properties', 'select-similar': 'Select similar', 'select-previous': 'Previous selection', qselect: 'Selection filters', zoom: 'Zoom',
            purge: 'Purge', 'dim-angular': 'Angular dimension', 'dim-baseline': 'Baseline dimension', 'dim-continue': 'Continue dimension', pedit: 'Edit polyline',
        };

        // ===== AutoCAD-style command aliases (ENU) =====
        // Typed into the console and confirmed with Enter or Space, exactly like
        // the AutoCAD command line. One registry drives dispatch, the shortcuts
        // page and the help text. Categories: draw | dims | ops | modify | blocks | other.
        const COMMAND_ALIASES = [
            { aliases: ['L', 'LINE'],                    kind: 'draw',   tool: 'line',          cat: 'draw' },
            { aliases: ['PL', 'PLINE', 'POLYLINE'],      kind: 'draw',   tool: 'polyline',      cat: 'draw' },
            { aliases: ['REC', 'RECTANG', 'RECTANGLE'],  kind: 'draw',   tool: 'rect',          cat: 'draw' },
            { aliases: ['POL', 'POLYGON'],               kind: 'draw',   tool: 'polygon',       cat: 'draw' },
            { aliases: ['DO', 'DONUT'],                  kind: 'draw',   tool: 'donut',         cat: 'draw' },
            { aliases: ['XL', 'XLINE'],                  kind: 'draw',   tool: 'xline',         cat: 'draw' },
            { aliases: ['RAY'],                          kind: 'draw',   tool: 'ray',           cat: 'draw' },
            { aliases: ['C', 'CIRCLE'],                  kind: 'draw',   tool: 'circle',        cat: 'draw' },
            { aliases: ['A', 'ARC'],                     kind: 'draw',   tool: 'arc',           cat: 'draw' },
            { aliases: ['EL', 'ELLIPSE'],                kind: 'draw',   tool: 'ellipse',       cat: 'draw' },
            { aliases: ['SPL', 'SPLINE'],                kind: 'draw',   tool: 'spline',        cat: 'draw' },
            { aliases: ['MT', 'MTEXT'],                  kind: 'draw',   tool: 'mtext',         cat: 'draw' },
            { aliases: ['TEXT'],                         kind: 'draw',   tool: 'text',          cat: 'draw' },
            { aliases: ['LE', 'LEADER', 'MLEADER'],      kind: 'draw',   tool: 'leader',        cat: 'draw' },
            { aliases: ['WI', 'WIPEOUT'],                kind: 'draw',   tool: 'wipeout',       cat: 'draw' },
            { aliases: ['MV', 'MVIEW'],                  kind: 'draw',   tool: 'viewport',      cat: 'draw' },
            { aliases: ['DLI', 'DIMLINEAR'],             kind: 'draw',   tool: 'dim',           cat: 'dims' },
            { aliases: ['DAL', 'DIMALIGNED'],            kind: 'draw',   tool: 'dim-aligned',   cat: 'dims' },
            { aliases: ['DRA', 'DIMRADIUS'],             kind: 'draw',   tool: 'dim-radial',    cat: 'dims' },
            { aliases: ['DDI', 'DIMDIAMETER'],           kind: 'draw',   tool: 'dim-diameter',  cat: 'dims' },
            { aliases: ['DAN', 'DIMANGULAR'],            kind: 'action', tool: 'dim-angular',   cat: 'dims',   run: () => actions['dim-angular']() },
            { aliases: ['DBA', 'DIMBASELINE'],           kind: 'action', tool: 'dim-baseline',  cat: 'dims',   run: () => actions['dim-baseline']() },
            { aliases: ['DCO', 'DIMCONTINUE'],           kind: 'action', tool: 'dim-continue',  cat: 'dims',   run: () => actions['dim-continue']() },
            { aliases: ['DOR', 'DIMORDINATE'],           kind: 'draw',   tool: 'dim-ordinate',  cat: 'dims' },
            { aliases: ['M', 'MOVE'],                    kind: 'ops',    tool: 'move',          cat: 'ops' },
            { aliases: ['CO', 'CP', 'COPY'],             kind: 'ops',    tool: 'copy',          cat: 'ops' },
            { aliases: ['RO', 'ROTATE'],                 kind: 'ops',    tool: 'rotate',        cat: 'ops' },
            { aliases: ['SC', 'SCALE'],                  kind: 'ops',    tool: 'scale',         cat: 'ops' },
            { aliases: ['MI', 'MIRROR'],                 kind: 'ops',    tool: 'mirror',        cat: 'ops' },
            { aliases: ['S', 'STRETCH'],                 kind: 'ops',    tool: 'stretch',       cat: 'ops' },
            { aliases: ['AR', 'ARRAY'],                  kind: 'action', tool: 'array',         cat: 'ops',    run: () => actions['array']() },
            { aliases: ['TR', 'TRIM'],                   kind: 'modify', tool: 'trim',          cat: 'modify' },
            { aliases: ['EX', 'EXTEND'],                 kind: 'modify', tool: 'extend',        cat: 'modify' },
            { aliases: ['O', 'OFFSET'],                  kind: 'modify', tool: 'offset',        cat: 'modify' },
            { aliases: ['F', 'FILLET'],                  kind: 'modify', tool: 'fillet',        cat: 'modify' },
            { aliases: ['CHA', 'CHAMFER'],               kind: 'modify', tool: 'chamfer',       cat: 'modify' },
            { aliases: ['BR', 'BREAK'],                  kind: 'modify', tool: 'break',         cat: 'modify' },
            { aliases: ['LEN', 'LENGTHEN'],              kind: 'modify', tool: 'lengthen',      cat: 'modify' },
            { aliases: ['PE', 'PEDIT'],                  kind: 'action', tool: 'pedit',         cat: 'modify', run: () => actions['pedit']() },
            { aliases: ['J', 'JOIN'],                    kind: 'action', tool: 'join',          cat: 'modify', run: () => actions['join']() },
            { aliases: ['H', 'HATCH'],                   kind: 'action', tool: 'hatch',         cat: 'draw',   run: () => actions['hatch']() },
            { aliases: ['TB', 'TABLE'],                  kind: 'action', tool: 'table',         cat: 'draw',   run: () => actions['table']() },
            { aliases: ['B', 'BLOCK'],                   kind: 'action', tool: 'create-block',  cat: 'blocks', run: () => actions['create-block']() },
            { aliases: ['I', 'INSERT'],                  kind: 'action', tool: 'insert-block',  cat: 'blocks', run: () => actions['insert-block']() },
            { aliases: ['X', 'EXPLODE'],                 kind: 'action', tool: 'explode',       cat: 'blocks', run: () => actions['explode']() },
            { aliases: ['ATTEDIT'],                      kind: 'action', tool: 'attedit',       cat: 'blocks', run: () => actions['attedit']() },
            { aliases: ['OV', 'OVERKILL', 'CLEAN'],      kind: 'action', tool: 'clean',         cat: 'modify', run: () => actions['clean']() },
            { aliases: ['Z', 'ZOOM'],                    kind: 'action', tool: 'zoom',          cat: 'general', run: () => actions['zoom']() },
            { aliases: ['PLOT', 'PRINT'],                kind: 'action', tool: 'plot',          cat: 'general', run: () => actions['plot']() },
            { aliases: ['PU', 'PURGE'],                  kind: 'action', tool: 'purge',         cat: 'modify', run: () => actions['purge']() },
            { aliases: ['MA', 'MATCHPROP'],              kind: 'action', tool: 'matchprop',     cat: 'modify', run: () => actions['matchprop']() },
            { aliases: ['SELECTSIMILAR'],                kind: 'action', tool: 'select-similar', cat: 'general', run: () => actions['select-similar']() },
            { aliases: ['P', 'PREVIOUS', 'SELECTPREVIOUS'], kind: 'action', tool: 'select-previous', cat: 'general', run: () => actions['select-previous']() },
            { aliases: ['QSELECT'],                      kind: 'action', tool: 'qselect', cat: 'general', run: () => actions['qselect']() },
            { aliases: ['RE', 'RG', 'REGEN'],            kind: 'action', tool: 'regen',         cat: 'general', run: () => actions['regen']() },
        ];
        const canonical = Object.freeze(COMMAND_ALIASES.map(command => Object.freeze({
            ...command, aliases: Object.freeze([...command.aliases]),
        })));
        const byId = new Map(canonical.map(command => [command.tool, command]));
        const listeners = new Set();
        const english = { schemaVersion: 1, id: 'en', name: 'English',
            commands: Object.fromEntries(canonical.map(command => [command.tool, [...command.aliases]])) };
        const snapshot = candidate => ({
            aliasMap: new Map(candidate.aliasMap),
            commands: Object.freeze(candidate.commands.map(command => Object.freeze({
                ...command, aliases: Object.freeze([...command.aliases]),
            }))),
            profile: Object.freeze({ ...candidate.profile }),
        });
        let active = snapshot(language.compile(english, canonical));
        function activateProfile(profile, options) {
            const candidate = language.compile(profile, canonical, options);
            if (!candidate.ok) return candidate;
            // One assignment publishes dispatch and reference aliases together.
            active = snapshot(candidate);
            for (const listener of listeners) listener();
            return { ok: true, errors: [], profile: active.profile };
        }
        function subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }

        // Look up a typed alias and start the matching tool. Returns true when
        // the text was a known command (even if the tool then refuses to start
        // and replaces the announcement with its own explanation).
        function dispatchCommandAlias(raw) {
            const key = language.normalize(raw);
            if (!key) return false;
            // HATCH option: P = pick points while the hatch panel is open.
            if (handleOption(key)) return true;
            const cmd = byId.get(active.aliasMap.get(key));
            if (!cmd) return false;
            const label = tr('cmd_' + cmd.tool, COMMAND_LABELS[cmd.tool] || cmd.tool);
            announce(tr('consoleCommand', 'Command: {tool}', { tool: label }));
            if (cmd.kind === 'draw') startDraw(cmd.tool);
            else if (cmd.kind === 'ops') startOps(cmd.tool);
            else if (cmd.kind === 'modify') startModify(cmd.tool);
            else if (cmd.kind === 'action' && typeof cmd.run === 'function') cmd.run();
            return true;
        }

        return { labels: COMMAND_LABELS, get commands() { return active.commands; },
            get profile() { return active.profile; }, canonicalCommands: canonical,
            dispatch: dispatchCommandAlias, activateProfile, subscribe };
    }
    return { create };
});
