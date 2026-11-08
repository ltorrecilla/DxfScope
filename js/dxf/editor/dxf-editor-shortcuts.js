/* Editor Shortcuts reference. Reads the command registry; never executes drawing actions. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfEditorShortcuts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    function create(document, registry, tr) {
        // ===== Shortcuts page (sidebar > Shortcuts) =====
        // Non-alias bindings. Rendered together with COMMAND_ALIASES so the
        // page always matches what the keydown handlers actually do.
        // Binding descriptions are audited against the keyboard and pointer handlers.
        // Command aliases below still come directly from COMMAND_ALIASES.
        const GENERAL_SHORTCUTS = [
            { keys: ['F3'], label: 'Toggle object snap', context: 'Drawing view. Enables the active snap modes.' },
            { keys: ['F8'], label: 'Toggle ortho', context: 'Constrain applicable point input to horizontal or vertical.' },
            { keys: ['F10'], label: 'Toggle polar tracking', context: 'Drawing view. Track the configured angles.' },
            { keys: ['F11'], label: 'Toggle object snap tracking', context: 'Hover snap points to acquire references, then move along their guides.' },
            { keys: ['Ctrl/Cmd', 'Z'], label: 'Undo', context: 'Outside text inputs. Undo the last drawing edit.' },
            { keys: ['Ctrl/Cmd', 'Y'], label: 'Redo', context: 'Outside text inputs. Ctrl/Cmd + Shift + Z also works.' },
            { keys: ['Ctrl/Cmd', 'S'], label: 'Save drawing', context: 'Requires an open drawing. Saves pending changes.' },
            { keys: ['Ctrl/Cmd', 'P'], label: 'Plot or print', context: 'Drawing view, outside text inputs.' },
            { keys: ['Ctrl/Cmd', 'C'], label: 'Copy selected objects', context: 'Select objects first. Copies geometry to the drawing clipboard.' },
            { keys: ['Ctrl/Cmd', 'V'], label: 'Paste objects', context: 'No draw or transform tool running. Paste at original coordinates, then use Move.' },
            { keys: ['Ctrl/Cmd', 'G'], label: 'Group selection', context: 'Select objects in the drawing first.' },
            { keys: ['Ctrl/Cmd', 'U'], label: 'Ungroup selection', context: 'Select grouped objects first.' },
            { keys: ['Space'], label: 'Repeat last command', context: 'Idle drawing view, outside inputs and placement modes.' },
            { keys: ['Enter'], label: 'Confirm input or finish a draw tool', context: 'In the console, run the typed command or confirm a value. During drawing, Space also confirms.' },
            { keys: ['C'], label: 'Close the current polyline', context: 'While drawing a polyline. At idle, C is the Circle command alias. Other tools may use C as an option.' },
            { keys: ['Delete / Backspace'], label: 'Delete selection', context: 'Outside text inputs. Select objects first.' },
            { keys: ['Esc'], label: 'Cancel or clear selection', context: 'Cancels the current interaction first. Inputs and open menus can consume Escape.' },
        ];
        const SHORTCUT_CATS = [
            ['keyboard', 'scCatKeyboard', 'Keyboard shortcuts'],
            ['pointer', 'scCatPointer', 'Mouse and selection'],
            ['input', 'scCatInput', 'Coordinates and numeric input'],
            ['general', 'scCatGeneralCommands', 'Commands: selection and view'],
            ['draw', 'scCatDrawCommands', 'Commands: draw'],
            ['dims', 'scCatDimsCommands', 'Commands: dimensions'],
            ['ops', 'scCatOpsCommands', 'Commands: move and transform'],
            ['modify', 'scCatModifyCommands', 'Commands: modify'],
            ['blocks', 'scCatBlockCommands', 'Commands: blocks and attributes'],
            ['workflow', 'scCatWorkflows', 'Properties and workflows'],
        ];
        const SHORTCUT_GUIDES = [
            { cat: 'pointer', keys: ['Wheel'], label: 'Zoom', context: 'Over the drawing. Hold Shift for twice the zoom speed.' },
            { cat: 'pointer', keys: ['Middle / right drag'], label: 'Pan', context: 'Drag the drawing view. A stationary right-click opens object actions.' },
            { cat: 'pointer', keys: ['Ctrl/Cmd + click'], label: 'Add to selection', context: 'In normal selection mode. Shift + click removes from selection.' },
            { cat: 'pointer', keys: ['Two corner clicks'], label: 'Window or crossing selection', context: 'Start in empty space. Left to right selects enclosed objects; right to left includes crossing objects. Ctrl/Cmd adds, Shift removes.' },
            { cat: 'pointer', keys: ['Double-click'], label: 'Inspect or edit an object', context: 'Opens Properties or the relevant text/table editor for the object.' },
            { cat: 'pointer', keys: ['Grip click'], label: 'Move a control point', context: 'Select an editable object, click a grip, move, then click to place. Object snaps and tracking apply; Escape cancels.' },
            { cat: 'pointer', keys: ['Shift + grip click'], label: 'Isolate a dimension-chain member', context: 'On a dimension grip, edit one member instead of the connected chain.' },
            { cat: 'input', keys: ['25'], label: 'Distance or radius', context: 'During a supported draw or transform tool. Aim the pointer for direction, type a value, then Enter.' },
            { cat: 'input', keys: ['10,20'], label: 'Absolute coordinates', context: 'Enter X,Y in drawing units during point input. Use a decimal point, for example 10.5,20.25.' },
            { cat: 'input', keys: ['@10,0'], label: 'Relative coordinates', context: 'Offset from the previous point or operation base. Example: 10 units along X.' },
            { cat: 'input', keys: ['0,0,0'], label: 'Coordinates with Z', context: 'This is a 2D editor: optional Z must be zero. Use commas between coordinates and decimal points within numbers.' },
            { cat: 'workflow', keys: ['Properties'], label: 'Edit block attribute values', context: 'Select a block, expand Attributes, edit values, then Apply values. Missing definitions show defaults for that insertion.' },
            { cat: 'workflow', keys: ['Block Edit > Properties'], label: 'Add or edit attribute definitions', context: 'Use Add attribute or Edit. Set tag, prompt, default and height inline. Place in drawing chooses a new definition position. This control has no global alias.' },
            { cat: 'workflow', keys: ['Properties > Explode'], label: 'Explode a selected block', context: 'Explode appears above the Block header. X or EXPLODE performs the same action.' },
            { cat: 'workflow', keys: ['Block Library'], label: 'Insert a block', context: 'Choose a block, set scale and rotation, then place its preview in the drawing. INSERT opens the library.' },
            { cat: 'workflow', keys: ['Copy between drawings'], label: 'Use the drawing clipboard', context: 'Open two DXF Editor tabs on the same site. Copy selection, switch tabs, and paste. Layers and blocks come along. A matching block name uses the target drawing definition.' },
        ];
        function shortcutCommandContext(command) {
            if (command.tool === 'attedit') return 'Select one block. Opens editable attribute values in Properties.';
            if (command.tool === 'qselect') return 'Open Selection filters to choose objects by type, layer, color and other properties.';
            if (command.tool === 'insert-block') return 'Open the Block Library, choose a block, then place it.';
            if (command.tool === 'create-block') return 'Select the objects to include in the new block first.';
            if (command.tool === 'explode') return 'Select one or more block insertions first.';
            if (command.kind === 'ops' || ['array', 'join', 'select-similar', 'pedit'].includes(command.tool))
                return 'Select applicable objects first, then follow the console prompts.';
            if (command.kind === 'draw') return 'Start from the drawing view, then follow the point and option prompts.';
            if (command.kind === 'modify') return 'Follow the console prompts for object selection and tool options.';
            return 'Type an alias in the drawing console and confirm with Enter or Space.';
        }

        function renderShortcutsPage() {
            const host = document.getElementById('shortcuts-sections');
            if (!host) return;
            const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const rows = { keyboard: GENERAL_SHORTCUTS.map(s => ({ ...s, plus: true })) };
            for (const guide of SHORTCUT_GUIDES) (rows[guide.cat] ||= []).push(guide);
            for (const c of registry.commands) {
                (rows[c.cat] ||= []).push({
                    keys: c.aliases, label: tr('cmd_' + c.tool, registry.labels[c.tool] || c.tool),
                    context: shortcutCommandContext(c), aliases: true,
                });
            }
            let html = '';
            for (const [cat, key, fallback] of SHORTCUT_CATS) {
                const list = rows[cat];
                if (!list?.length) continue;
                const category = tr(key, fallback);
                html += '<section class="sc-card" data-sc-cat="' + cat + '"><h3>' + esc(category) + '</h3>';
                for (const r of list) {
                    const sep = r.aliases ? '<span class="text-slate-400 text-xs">or</span>'
                        : r.plus ? '<span class="text-slate-400 text-xs">+</span>' : ' ';
                    const kbds = r.keys.map(k => '<span class="sc-kbd">' + esc(k) + '</span>').join(sep);
                    const filter = esc((r.keys.join(' ') + ' ' + r.label + ' ' + r.context + ' ' + category).toLowerCase());
                    html += '<div class="sc-row" data-sc-filter="' + filter + '"><span class="sc-keys">' + kbds
                        + '</span><span class="sc-label">' + esc(r.label)
                        + '<span class="sc-context">' + esc(r.context) + '</span></span></div>';
                }
                html += '</section>';
            }
            host.innerHTML = html;
            applyShortcutsFilter();
        }

        function applyShortcutsFilter() {
            const q = (document.getElementById('shortcuts-search')?.value || '').trim().toLowerCase();
            let any = false;
            document.querySelectorAll('#shortcuts-sections .sc-row').forEach(row => {
                const hit = !q || (row.dataset.scFilter || '').includes(q);
                row.classList.toggle('hidden', !hit);
                if (hit) any = true;
            });
            document.querySelectorAll('#shortcuts-sections .sc-card').forEach(card => {
                const visible = card.querySelector('.sc-row:not(.hidden)');
                card.classList.toggle('hidden', !visible);
            });
            document.getElementById('shortcuts-no-results')?.classList.toggle('hidden', any);
        }

        let bound = false;
        let unsubscribe = null;
        const search = document.getElementById('shortcuts-search');
        const tab = document.getElementById('tab-shortcuts');
        function bind() {
            if (bound) return;
            search?.addEventListener('input', applyShortcutsFilter);
            tab?.addEventListener('click', renderShortcutsPage);
            unsubscribe = registry.subscribe?.(renderShortcutsPage) || null;
            bound = true;
        }
        function dispose() {
            if (!bound) return;
            search?.removeEventListener('input', applyShortcutsFilter);
            tab?.removeEventListener('click', renderShortcutsPage);
            unsubscribe?.();
            unsubscribe = null;
            bound = false;
        }
        return { render: renderShortcutsPage, filter: applyShortcutsFilter, bind, dispose };
    }
    return { create };
});
