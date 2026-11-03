/**
 * dxf_autosave.js — crash recovery for the DXF editor.
 *
 * While a drawing has unsaved edits, the full edited DXF text is written to
 * IndexedDB a few seconds after the last change (and when the tab is hidden).
 * Saving, opening another file or discarding the edits deletes the snapshot.
 * Every tab has its own session id and a heartbeat in localStorage; on start
 * the editor offers to recover snapshots whose tab is gone (closed, crashed,
 * browser restarted), the way AutoCAD's drawing recovery does.
 *
 *   const AS = DxfAutosave.create({
 *     storage,            // { put(rec), get(id), del(id), list() } (promises)
 *     alive,              // localStorage-like { getItem, setItem, removeItem }
 *     serialize,          // () => { name, text } of the edited drawing
 *     isDirty,            // () => bool
 *     onStatus,           // (state: 'saving'|'saved'|'cleared'|'error', rec?) => void
 *     debounceMs, now, sessionId,
 *   });
 *   AS.schedule() after edits, AS.clear() after save/discard,
 *   AS.listOrphans() / AS.take(id) / AS.discard(id) on start.
 *   DxfAutosave.idbStorage(dbName) → storage over IndexedDB.
 *
 * window.DxfAutosave + Node exports.
 */
(function (root) {
    'use strict';

    const ALIVE_PREFIX = 'liteaeco.dxfEditor.alive.';
    const STALE_MS = 20000;          // a tab silent this long is gone
    const BEAT_MS = 5000;

    function create(cfg) {
        const now = cfg.now || (() => Date.now());
        const id = cfg.sessionId || (Math.random().toString(36).slice(2) + now().toString(36));
        const debounceMs = cfg.debounceMs ?? 4000;
        const status = cfg.onStatus || (() => {});
        let timer = null, beat = null, writing = null, hasRecord = false, disabled = false;

        const aliveKey = (sid) => ALIVE_PREFIX + sid;
        function heartbeat() {
            try { cfg.alive && cfg.alive.setItem(aliveKey(id), String(now())); } catch (e) { /* storage blocked */ }
        }

        const api = {
            sessionId: id,
            get enabled() { return !disabled; },
            setEnabled(on) {
                disabled = !on;
                if (disabled) { clearTimeout(timer); return api.clear(); }
                if (cfg.isDirty()) api.schedule();
                return Promise.resolve();
            },
            startHeartbeat(setIntervalFn) {
                heartbeat();
                const si = setIntervalFn || (typeof setInterval === 'function' ? setInterval : null);
                if (si && !beat) beat = si(heartbeat, BEAT_MS);
            },
            /** Clean close: this tab no longer counts as alive. Its snapshot (if
             *  any) is then offered for recovery next time — on purpose. */
            leave() {
                try { cfg.alive && cfg.alive.removeItem(aliveKey(id)); } catch (e) { /* ignore */ }
            },
            schedule() {
                if (disabled) return;
                clearTimeout(timer);
                timer = setTimeout(() => { api.flush(); }, debounceMs);
            },
            async flush() {
                clearTimeout(timer);
                if (disabled) return null;
                if (!cfg.isDirty()) return api.clear();
                if (writing) await writing;
                writing = (async () => {
                    try {
                        status('saving');
                        const { name, text } = cfg.serialize();
                        if (typeof text !== 'string' || !text) return null;
                        const rec = { id, name: name || 'drawing.dxf', savedAt: now(), size: text.length, text };
                        await cfg.storage.put(rec);
                        hasRecord = true;
                        heartbeat();
                        status('saved', rec);
                        return rec;
                    } catch (e) {
                        status('error');
                        return null;
                    } finally {
                        writing = null;
                    }
                })();
                return writing;
            },
            async clear() {
                clearTimeout(timer);
                if (writing) await writing;
                if (!hasRecord) { status('cleared'); return null; }
                try { await cfg.storage.del(id); } catch (e) { /* ignore */ }
                hasRecord = false;
                status('cleared');
                return null;
            },
            /** Snapshots of tabs that are gone, newest first (without the text). */
            async listOrphans() {
                const all = await cfg.storage.list();
                const t = now();
                return all.filter(r => {
                    if (!r || r.id === id) return false;
                    let last = 0;
                    try { last = Number(cfg.alive && cfg.alive.getItem(aliveKey(r.id))) || 0; } catch (e) { last = 0; }
                    return !(last && t - last < STALE_MS);
                }).map(r => ({ id: r.id, name: r.name, savedAt: r.savedAt, size: r.size }))
                    .sort((a, b) => b.savedAt - a.savedAt);
            },
            /** Recover: returns the record and removes it (this tab re-saves it). */
            async take(rid) {
                const rec = await cfg.storage.get(rid);
                if (rec) await cfg.storage.del(rid);
                try { cfg.alive && cfg.alive.removeItem(aliveKey(rid)); } catch (e) { /* ignore */ }
                return rec || null;
            },
            async discard(rid) {
                await cfg.storage.del(rid);
                try { cfg.alive && cfg.alive.removeItem(aliveKey(rid)); } catch (e) { /* ignore */ }
            },
        };
        return api;
    }

    /** IndexedDB storage: one object store keyed by session id. */
    function idbStorage(dbName) {
        let dbp = null;
        const open = () => dbp || (dbp = new Promise((res, rej) => {
            const req = indexedDB.open(dbName, 1);
            req.onupgradeneeded = () => req.result.createObjectStore('snaps', { keyPath: 'id' });
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
        }));
        const tx = async (mode, fn) => {
            const db = await open();
            return new Promise((res, rej) => {
                const t = db.transaction('snaps', mode);
                const out = fn(t.objectStore('snaps'));
                t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
                t.onerror = () => rej(t.error);
                t.onabort = () => rej(t.error);
            });
        };
        return {
            put: (rec) => tx('readwrite', s => { s.put(rec); }),
            get: (id) => tx('readonly', s => s.get(id)),
            del: (id) => tx('readwrite', s => { s.delete(id); }),
            list: () => tx('readonly', s => s.getAll()),
        };
    }

    const DxfAutosave = { create, idbStorage, STALE_MS };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfAutosave;
    if (root) root.DxfAutosave = DxfAutosave;
})(typeof window !== 'undefined' ? window : null);
