/* Workspace boundary only: document state and resource ownership stay in each app. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfWorkspace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Lifecycle callbacks must finish cleanup before resolving. Missing callbacks
    // are unavailable capabilities, never successful no-op suspension/disposal.
    // On failure, the owner must restore its previous resource state before throwing.
    function create({ mode, readState, lifecycle = null, snapshot = null, receiveSnapshot = null }) {
        if (!['editor', 'compare'].includes(mode) || typeof readState !== 'function')
            throw new TypeError('A workspace requires a mode and live state reader');
        let phase = 'active'; // Standalone entry modules initialize their own app.
        let pending = false;
        const supported = action => typeof lifecycle?.[action] === 'function';
        function getState() {
            const state = readState();
            return Object.freeze({
                mode, phase, transitioning: pending,
                hasDocument: !!state.hasDocument, dirty: !!state.dirty,
                hasInputs: !!state.hasInputs,
                busyReason: state.busyReason || null,
                documentName: String(state.documentName || ''),
                capabilities: Object.freeze({ activate: supported('activate'),
                    suspend: supported('suspend'), dispose: supported('dispose'), snapshot: typeof snapshot === 'function',
                    receiveSnapshot: typeof receiveSnapshot === 'function' }),
            });
        }
        async function transition(action, next) {
            if (pending) return { status: 'blocked', reason: 'transition-in-progress' };
            if (phase === next) return { status: 'unchanged' };
            if (phase === 'disposed') return { status: 'blocked', reason: 'disposed' };
            const state = getState();
            if (state.busyReason) return { status: 'blocked', reason: state.busyReason };
            if (action === 'dispose' && state.dirty) return { status: 'blocked', reason: 'unsaved-changes' };
            if (!supported(action)) return { status: 'unavailable', reason: 'lifecycle-not-connected' };
            pending = true;
            try {
                await lifecycle[action]();
                phase = next;
                return { status: 'completed' };
            } finally { pending = false; }
        }
        async function operate(callback, payload, needsDocument) {
            if (pending) return { status: 'blocked', reason: 'transition-in-progress' };
            if (phase === 'disposed') return { status: 'blocked', reason: 'disposed' };
            const state = getState();
            if (state.busyReason) return { status: 'blocked', reason: state.busyReason };
            if (needsDocument && !state.hasDocument) return { status: 'blocked', reason: 'no-document' };
            if (!needsDocument && phase !== 'active') return { status: 'blocked', reason: 'inactive' };
            if (typeof callback !== 'function') return { status: 'unavailable' };
            pending = true;
            try { return await callback(payload); } finally { pending = false; }
        }
        return Object.freeze({ getState,
            snapshot: () => operate(snapshot, null, true),
            receiveSnapshot: payload => operate(receiveSnapshot, payload, false),
            activate: () => transition('activate', 'active'),
            suspend: () => transition('suspend', 'suspended'),
            dispose: () => transition('dispose', 'disposed'),
        });
    }
    return { create };
});
