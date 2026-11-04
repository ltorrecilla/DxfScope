/*
 * Copyright 2026 Luis Torrecilla (liteAECO)
 * * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * * http://www.apache.org/licenses/LICENSE-2.0
 * * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// ==========================================
// SITE CONFIG (js/config.js, git-ignored)
// ------------------------------------------
// Private IDs live in js/config.js (template: js/config.example.js).
// It is injected automatically from the same folder as this file, so
// pages need no extra <script> tag. A page may still include config.js
// manually before common.js; then it is used directly.
// No config file -> analytics stay off, everything else works.
// ==========================================

// ==========================================
// GOOGLE ANALYTICS (GA4)
// ==========================================
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }

// Active GA measurement ID, set once config.js is loaded (null = analytics off)
window.LITEAECO_GA_ID = null;

function initAnalytics(cfg) {
    const gaId = cfg && typeof cfg.gaId === 'string' ? cfg.gaId.trim() : '';
    if (!gaId || window.LITEAECO_GA_ID) return;
    window.LITEAECO_GA_ID = gaId;

    // Respect a previous opt-out before anything is sent
    if (localStorage.getItem('cookieConsent') === 'declined') {
        window['ga-disable-' + gaId] = true;
    }

    gtag('js', new Date());
    gtag('config', gaId);

    const gaScript = document.createElement('script');
    gaScript.async = true;
    gaScript.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(gaId);
    document.head.appendChild(gaScript);
}

(function loadSiteConfig() {
    // Already provided (config.js included manually before common.js)
    if (window.LITEAECO_CONFIG) {
        initAnalytics(window.LITEAECO_CONFIG);
        return;
    }

    // Resolve config.js next to this file (works from root and subfolders)
    const self = document.currentScript;
    const src = (self && self.src)
        ? self.src.replace(/common\.js(\?.*)?$/, 'config.js')
        : (window.SITE_ROOT || './') + 'js/config.js';

    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => initAnalytics(window.LITEAECO_CONFIG);
    s.onerror = () => console.info('liteAECO: js/config.js not found, analytics disabled.');
    document.head.appendChild(s);
})();

// ==========================================
// MINIMAL COOKIE NOTIFICATION
// ==========================================
window.injectCookieBanner = function () {
    // If the user has already made a choice, don't show the banner
    if (localStorage.getItem('cookieConsent')) {
        return;
    }

    // Create the minimal toast container
    const banner = document.createElement('div');
    banner.id = 'cookie-banner';

    // Floating bottom-left, max-width to keep the paragraph readable, stacked layout
    banner.className = 'fixed bottom-4 left-4 right-4 md:left-auto md:max-w-sm z-[999] bg-white rounded border border-slate-200 shadow-lg p-4 flex flex-col gap-3 transition-opacity duration-300';

    banner.innerHTML = `
        <span class="text-xs text-slate-600 leading-relaxed text-center">
            We use third-party cookies that help us analyze and understand how you use this website. These will be stored locally, but you still have the option to opt-out.
        </span>
        <div class="flex items-center justify-center gap-4 pt-1">
            <button onclick="window.handleCookieChoice('declined')" class="text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-800 transition-colors">
                Opt-out
            </button>
            <button onclick="window.handleCookieChoice('accepted')" class="text-[10px] font-bold uppercase tracking-widest text-blue-600 hover:text-blue-800 transition-colors">
                Accept
            </button>
        </div>
    `;

    // Inject it into the page
    document.body.appendChild(banner);
};

// Global handler for the cookie buttons (single definition)
window.handleCookieChoice = function (choice) {
    localStorage.setItem('cookieConsent', choice);
    const banner = document.getElementById('cookie-banner');
    if (banner) banner.remove();

    // GA opt-out / opt-in. If config is not loaded yet, initAnalytics()
    // reads the stored choice when it runs.
    const gaId = window.LITEAECO_GA_ID;
    if (gaId) window['ga-disable-' + gaId] = (choice === 'declined');

    // Legacy Matomo opt-out (kept in case it is still used elsewhere)
    if (choice === 'declined' && window._paq) {
        _paq.push(['forgetConsentGiven']);
        _paq.push(['optUserOut']);
    }
};

// ==========================================
// liteAECO - GLOBAL ENGINE (common.js)
// ==========================================

// Detect PC
window.isHighPerformance = function () {
    let isHighPerf = true;

    // 1. Check RAM: Devices with less than 8GB might struggle with heavy backdrop-blurs
    // Note: deviceMemory is largely a Chromium feature, will be undefined on Safari/Firefox
    if (navigator.deviceMemory && navigator.deviceMemory < 8) {
        isHighPerf = false;
    }

    // 2. Check CPU Cores: Devices with less than 4 logical cores are usually low-end or older mobile devices
    if (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4) {
        isHighPerf = false;
    }

    // 3. Accessibility Check: Respect OS-level "Reduce Motion" or "Reduce Transparency" settings
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
        isHighPerf = true;
    }

    return isHighPerf;
};

// ==========================================
// liteAECO - GLOBAL ENGINE (common.js)
// ==========================================

// --- NEW: Auto-detect Page Script Prefix ---
function getAutoPagePrefix() {
    const path = window.location.pathname;
    const filename = path.split('/').pop();

    // If it's the root or index, return empty
    if (!filename || !filename.endsWith('.html') || filename.toLowerCase() === 'index.html') {
        return '';
    }

    // Strip '.html', remove any "liteAECO-" branding prefixes if they exist, and lowercase it
    let cleanName = filename.replace('.html', '');
    cleanName = cleanName.replace(/^LiteAEC-/i, '').replace(/^liteAECO-/i, '');

    return cleanName.toLowerCase();
}

// Automatically set the prefix for the whole app
window.pageScriptPrefix = getAutoPagePrefix();

const BASE_GLOBAL = JSON.parse(JSON.stringify(window.GLOBAL_I18N || {}));
const LANGS = ['en', 'de', 'es', 'fr', 'pt', 'it', 'ko', 'ja', 'zh']; //more-here
let currentLang = 'en';
currentLang = readPreferredLanguage();

const CATEGORIES = [
    { id: 'all', label: 'ALL' },
    { id: 'pm', label: 'PM' },
    { id: 'data', label: 'DATA' },
    { id: 'bim', label: 'VDC / BIM' },
    { id: 'ops', label: 'OPERATIONS' },
];

// icon:    Lucide name (always set; fallback when svgIcon is missing)
// svgIcon: optional custom SVG file. Rendered as a CSS mask filled with
//          currentColor, so it follows the same text-* colours as Lucide.
const APPS = [
    { id: 2, skipModal: false, icon: 'calendars', categories: ['ops', 'pm'], url: window.SITE_ROOT + 'tools/project-portfolio.html' },
    { id: 26, skipModal: false, icon: 'file-text', categories: ['ops'], url: window.SITE_ROOT + 'tools/pdf-viewer.html' },
    { id: 11, skipModal: false, icon: 'box', svgIcon: window.SITE_ROOT + 'img/tools/liteaeco-ifc-viewer.svg', categories: ['bim'], url: window.SITE_ROOT + 'tools/ifc-viewer-audit.html' },
    { id: 3, skipModal: false, icon: 'file-badge', categories: ['data', 'bim'], url: window.SITE_ROOT + 'tools/ids-generator.html' },

    { id: 1, skipModal: false, icon: 'chart-bar', categories: ['pm', 'ops'], url: window.SITE_ROOT + 'tools/project-timeline.html', imageUrl: window.SITE_ROOT + 'img/tools/timeline.webp' },
    { id: 17, skipModal: false, icon: 'user-group', categories: ['pm', 'ops'], url: window.SITE_ROOT + 'tools/organizational-chart.html', imageUrl: window.SITE_ROOT + 'img/tools/org-chart.webp' },
    { id: 12, skipModal: false, icon: 'list-todo', categories: ['pm'], url: window.SITE_ROOT + 'tools/meetings.html', imageUrl: window.SITE_ROOT + 'img/tools/meetings.webp' },
    { id: 13, skipModal: false, icon: 'table-2', categories: ['pm'], url: window.SITE_ROOT + 'tools/responsibility-matrix.html' },

    { id: 21, skipModal: false, icon: 'file-search', categories: ['ops'], url: window.SITE_ROOT + 'tools/contract-obligations.html' },
    { id: 20, skipModal: false, icon: 'triangle-alert', categories: ['ops'], url: window.SITE_ROOT + 'tools/incident-rca.html' },
    { id: 18, skipModal: false, icon: 'zap', categories: ['bim'], url: window.SITE_ROOT + 'tools/ifc-optimizer.html' },
    { id: 4, skipModal: false, icon: 'merge', rotation: 90, categories: ['bim'], url: window.SITE_ROOT + 'tools/ifc-merger.html' },
    
    { id: 22, skipModal: false, icon: 'chart-spline', categories: ['pm'], url: window.SITE_ROOT + 'tools/monte-carlo-simulator.html' },
    { id: 28, skipModal: false, icon: 'blocks', categories: ['data', 'bim'], url: window.SITE_ROOT + 'tools/ifc-property-manager.html' },
    { id: 8, skipModal: false, icon: 'square-arrow-right-exit', categories: ['data'], url: window.SITE_ROOT + 'tools/ifc-pset-export.html' },
    { id: 9, skipModal: false, icon: 'square-arrow-right-enter', rotation: 180, categories: ['data'], url: window.SITE_ROOT + 'tools/ifc-inject-properties.html' },
    { id: 16, skipModal: false, icon: 'combine', rotation: 180, categories: ['data'], url: window.SITE_ROOT + 'tools/data-merger.html' },
    
    { id: 6, skipModal: false, icon: 'spell-check-2', categories: ['bim'], url: window.SITE_ROOT + 'tools/ifc-pset-renamer.html' },
    { id: 7, skipModal: false, icon: 'shredder', categories: ['bim'], url: window.SITE_ROOT + 'tools/ifc-pset-delete.html' },
    { id: 5, skipModal: false, icon: 'app-window-mac', categories: ['bim'], url: window.SITE_ROOT + 'tools/ifc-application-changer.html' },
    { id: 10, skipModal: false, icon: 'map-pin', categories: ['bim'], url: window.SITE_ROOT + 'tools/ifc-reposition.html' },

    { id: 24, skipModal: false, icon: 'drafting-compass', categories: ['ops'], url: window.SITE_ROOT + 'tools/dxf-editor.html' },
    { id: 25, skipModal: false, icon: 'columns-2', categories: ['ops'], url: window.SITE_ROOT + 'tools/dxf-compare.html' },
    { id: 27, skipModal: false, icon: 'file-diff', categories: ['ops'], url: window.SITE_ROOT + 'tools/pdf-compare.html' },
    { id: 23, skipModal: false, icon: 'equal-not', categories: ['bim'], url: window.SITE_ROOT + 'tools/ifc-compare.html' }, 
    // { id: 19, skipModal: false, icon: 'building', categories: ['ops'], url: window.SITE_ROOT + 'tools/COBIE_CMMS.html' },
    // { id: 14, skipModal: false, icon: 'arrow-down-up', categories: ['bim'], url: window.SITE_ROOT + 'tools/ifc-schema-changer.html' },
];

// ==========================================
// APP ICON HELPER (shared by nav, cards and modal)
// ------------------------------------------
// renderAppIcon(app, 'w-5 h-5', 'stroke-[1.5] transition-transform')
// -> Lucide <i> or, when app.svgIcon is set, a masked <span> filled with
//    currentColor. Both inherit the parent's text-* colour and hover states.
// ==========================================
window.appRotationClass = function (app) {
    if (!app) return '';
    if (app.rotation == 90) return 'rotate-90';
    if (app.rotation == -90) return '-rotate-90';
    if (app.rotation == 180) return 'rotate-180';
    return '';
};

window.renderAppIcon = function (app, sizeClass = 'w-4 h-4', extraClass = '') {
    const rot = window.appRotationClass(app);
    if (app && app.svgIcon) {
        const url = String(app.svgIcon).replace(/'/g, '%27');
        return `<span aria-hidden="true" class="inline-block shrink-0 bg-current ${sizeClass} ${rot} ${extraClass}"
            style="-webkit-mask: url('${url}') center / contain no-repeat; mask: url('${url}') center / contain no-repeat;"></span>`;
    }
    return `<i data-lucide="${app ? app.icon : 'box'}" class="${sizeClass} ${rot} ${extraClass}"></i>`;
};

let activeCategory = 'all';

// Language selector. Supported codes are defined beside currentLang.
const LANG_NAMES = {
    en: 'English', de: 'German', es: 'Spanish', fr: 'French',
    pt: 'Portuguese', it: 'Italian', ko: 'Korean', ja: 'Japanese', zh: 'Chinese'
};

// Collapsed button always shows the 2-letter code, so its width never changes.
function setLangLabel(code) {
    const label = document.getElementById('langToggleLabel');
    if (label) label.textContent = (code || 'en').toUpperCase();
    const select = document.getElementById('langToggle');
    if (select && select.tagName === 'SELECT') select.value = code;
    renderLangMenu();
}

// Build the floating option list: "English (EN)".
function renderLangMenu() {
    const menu = document.getElementById('langMenu');
    if (!menu) return;
    menu.innerHTML = LANGS.map(code => {
        const upper = code.toUpperCase();
        const name = LANG_NAMES[code] || upper;
        const selected = code === currentLang;
        return `<li role="option" data-value="${code}" aria-selected="${selected}"
            class="px-3 py-1.5 text-[12px] font-semibold text-slate-700 cursor-pointer hover:bg-blue-50 whitespace-nowrap flex items-center justify-between gap-4 ${selected ? 'bg-blue-50 text-blue-700' : ''}">
            <span><span class="text-slate-400">${upper}</span> - ${name}</span>
        </li>`;
    }).join('');
}

function openLangMenu() {
    const btn = document.getElementById('langToggle');
    const menu = document.getElementById('langMenu');
    if (!btn || !menu) return;
    renderLangMenu();
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
}

function closeLangMenu() {
    const btn = document.getElementById('langToggle');
    const menu = document.getElementById('langMenu');
    if (!menu || menu.classList.contains('hidden')) return;
    menu.classList.add('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

function selectLang(code) {
    if (!code || !LANGS.includes(code)) return;
    closeLangMenu();
    savePreferredLanguage(code);
    if (code === currentLang) return;
    currentLang = code;
    setLangLabel(code);
    window.loadLanguage(code, window.pageScriptPrefix);
}

// --- Dynamically Load Language Files ---
// Race guard: only the newest switch is allowed to apply.
let langRequestSeq = 0;
// Last correctly-applied dictionaries. Used to heal a stale, late-executing
// language file that clobbers the globals after a newer switch already ran.
let activeGlobalSnapshot = null;
let activePageSnapshot = null;

window.loadLanguage = function (lang, pageScriptPrefix) {
    // Tag this switch. Any older in-flight switch becomes stale.
    const seq = ++langRequestSeq;

    // 1. PREVENT TRANSLATION BLEED-THROUGH
    // EN_PAGE (opt-in): a page that loads its English file statically and
    // freezes it as window.EN_PAGE always falls back to English, never to
    // the previously shown language.
    window.GLOBAL_I18N = { ...BASE_GLOBAL, categories: { ...BASE_GLOBAL.categories }, apps: { ...BASE_GLOBAL.apps } };
    const resetPage = window.EN_PAGE || window.BASE_PAGE;
    if (resetPage) window.PAGE_I18N = { ...resetPage };

    // Remove old dynamic scripts
    ['dynamic-global-lang', 'dynamic-page-lang'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.remove();
    });

    // 2. FORGIVING SCRIPT LOADER
    // Snapshot the dictionary each file assigns the moment it executes, so a
    // later stale file overwriting window[key] can't corrupt this request.
    const loadScript = (id, src, key) => new Promise((resolve) => {
        const script = document.createElement('script');
        script.id = id;
        script.src = src;
        script.onload = () => resolve({ ok: true, key, snapshot: window[key] });
        script.onerror = () => {
            console.warn(`Translation file missing: ${src} (Falling back to English for these strings)`);
            resolve({ ok: false, key });
        };
        document.body.appendChild(script);
    });

    // --- CHANGED: Use language subfolder, drop language suffix from filename ---
    // Use window.SITE_ROOT to ensure correct relative pathing across root and subdirectories
    const rootPath = window.SITE_ROOT || './';
    const scriptsToLoad = [loadScript('dynamic-global-lang', `${rootPath}lang/${lang}/global.js`, 'GLOBAL_I18N')];
    if (pageScriptPrefix) {
        scriptsToLoad.push(loadScript('dynamic-page-lang', `${rootPath}lang/${lang}/${pageScriptPrefix}.js`, 'PAGE_I18N'));
    }
    // -------------------------------------------------------------------------

    Promise.all(scriptsToLoad).then((results) => {
        // A newer switch started while these files were loading. Drop this
        // result, and restore the good dictionaries in case a file from this
        // stale request just overwrote the globals.
        if (seq !== langRequestSeq) {
            if (activeGlobalSnapshot) window.GLOBAL_I18N = activeGlobalSnapshot;
            if (activePageSnapshot) window.PAGE_I18N = activePageSnapshot;
            return;
        }

        // Re-assign from this request's own snapshots to heal any clobbering
        // by a stale file that executed between load and now.
        results.forEach(r => {
            if (r.ok && r.snapshot) window[r.key] = r.snapshot;
        });

        const anySuccess = results.some(res => res.ok === true);

        if (anySuccess) {
            activeGlobalSnapshot = window.GLOBAL_I18N;
            activePageSnapshot = window.PAGE_I18N;
            applyLanguage();
        } else {
            console.warn(`No translation files found for ${lang}. Using English without changing the saved preference.`);
            if (lang !== 'en') {
                window.loadLanguage('en', pageScriptPrefix);
            } else {
                activeGlobalSnapshot = window.GLOBAL_I18N;
                activePageSnapshot = window.PAGE_I18N;
                applyLanguage();
            }
        }
    });
};

// Read again on activation: another page may have changed the preference.
function readPreferredLanguage() {
    try {
        const saved = localStorage.getItem('liteAECOLang');
        if (LANGS.includes(saved)) return saved;
    } catch (_) {
        return currentLang;
    }
    const browserLang = (navigator.language || 'en').split('-')[0].toLowerCase();
    return LANGS.includes(browserLang) ? browserLang : 'en';
}

function savePreferredLanguage(code) {
    try {
        if (localStorage.getItem('liteAECOLang') !== code) {
            localStorage.setItem('liteAECOLang', code);
        }
    } catch (_) { /* Keep the current page usable when storage is unavailable. */ }
}

function autoDetectLanguage() {
    currentLang = readPreferredLanguage();
    savePreferredLanguage(currentLang);
    setLangLabel(currentLang);
}

function syncPreferredLanguage() {
    // Each page's boot loads its own dictionary after its UI is ready.
    if (document.readyState === 'loading') return;
    const code = readPreferredLanguage();
    if (code === currentLang) return;
    currentLang = code;
    setLangLabel(code);
    window.loadLanguage(code, window.pageScriptPrefix);
}

window.addEventListener('storage', event => {
    if (event.key !== 'liteAECOLang' && event.key !== null) return;
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    syncPreferredLanguage();
});
// Cover restored history entries and tabs that were suspended while hidden.
window.addEventListener('pageshow', syncPreferredLanguage);
window.addEventListener('focus', syncPreferredLanguage);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncPreferredLanguage();
});

function getTranslations() {
    const curGlobal = window.GLOBAL_I18N || {};
    const curPage = window.PAGE_I18N || {};
    // EN_PAGE (opt-in, see loadLanguage) is the fallback layer when present
    const basePage = window.EN_PAGE || window.BASE_PAGE || {};

    const merged = {
        ...BASE_GLOBAL,
        ...basePage,
        ...curGlobal,
        ...curPage,
        categories: { ...BASE_GLOBAL.categories, ...(curGlobal.categories || {}) }
    };

    merged.apps = {};
    for (const appId in BASE_GLOBAL.apps) {
        merged.apps[appId] = {
            ...BASE_GLOBAL.apps[appId],
            ...curGlobal.apps?.[appId]
        };
    }
    return merged;
}

// --- Translation Helper for Dynamic Strings ---
//   t(key)                 -> text, or the key itself (original behaviour)
//   t(key, fallback)       -> text, or fallback when the key is missing
//   t(key, fallback, vars) -> {name} placeholders filled from vars
//                             ({ n: 3 } fills "{n} rows"); a dictionary entry
//                             that is a function is called with vars instead
window.t = function (key, fallback, vars) {
    const d = typeof getTranslations === 'function' ? getTranslations() : (window.PAGE_I18N || {});
    let v = d[key];
    if (v === undefined || v === null) v = fallback !== undefined ? fallback : key;
    if (typeof v === 'function') return v(...(Array.isArray(vars) ? vars : [vars]));
    if (vars && typeof v === 'string') {
        v = v.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
    }
    return v;
};

// --- Translate a DOM subtree ---
// Pass 1: data-i18n="key"          -> innerHTML (text-only elements: any
//                                     child icon or input would be replaced)
// Pass 2: id="ui-some-name"         -> key someName (same rule)
// Pass 3: data-i18n-title="key"     -> title attribute (tooltips)
//         data-i18n-placeholder="key" -> placeholder
//         data-i18n-aria="key"      -> aria-label
//         (only while the element has that attribute)
// Pass 4: data-i18n-soft="key"      -> innerHTML, only while the text is
//                                     still the translated default (code
//                                     that wrote a file name keeps it)
// A key missing from the dictionary leaves the element untouched.
// Pages that render HTML after load call window.applyI18n(container).
const I18N_ATTRS = [
    ['data-i18n-title', 'title'],
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-aria', 'aria-label'],
];
function i18nApplyTo(root, dict) {
    const d = dict || (typeof getTranslations === 'function' ? getTranslations() : window.PAGE_I18N);
    if (!d) return;
    const scope = root || document;
    const all = (sel) => {
        const list = [...scope.querySelectorAll(sel)];
        if (scope !== document && scope.matches && scope.matches(sel)) list.unshift(scope);
        return list;
    };

    // Helper: Convert kebab-case to camelCase (e.g. 'page-title' -> 'pageTitle')
    const kebabToCamel = (str) => str.replace(/-([a-z0-9])/ig, (g) => g[1].toUpperCase());

    // Helper: Apply the translated text to the element
    const applyTranslation = (el, dictKey) => {
        if (d[dictKey] !== undefined && typeof d[dictKey] !== 'function') {
            if (el.tagName === 'INPUT' && el.hasAttribute('placeholder')) {
                el.placeholder = d[dictKey];
            } else {
                el.innerHTML = d[dictKey];
            }
        }
    };

    // ---------------------------------------------------------
    // TRANSLATION PASS 1: Explicit 'data-i18n' attributes
    // ---------------------------------------------------------
    all('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        applyTranslation(el, key);
    });

    // ---------------------------------------------------------
    // TRANSLATION PASS 2: Automated 'ui-' IDs
    // ---------------------------------------------------------
    all('[id^="ui-"]').forEach(el => {
        if (!el.hasAttribute('data-i18n')) {
            const baseId = el.id.substring(3);
            const dictKey = kebabToCamel(baseId);
            applyTranslation(el, dictKey);
        }
    });

    // ---------------------------------------------------------
    // TRANSLATION PASS 3: attributes (tooltips, placeholders, aria)
    // Only while the element still HAS the attribute: code that removed a
    // tooltip on purpose (an enabled button) never gets it back.
    // ---------------------------------------------------------
    for (const [dataAttr, target] of I18N_ATTRS) {
        all('[' + dataAttr + ']').forEach(el => {
            const v = d[el.getAttribute(dataAttr)];
            if (v !== undefined && typeof v !== 'function' && el.hasAttribute(target)) el.setAttribute(target, v);
        });
    }

    // ---------------------------------------------------------
    // TRANSLATION PASS 4: 'data-i18n-soft' = default text the code may
    // replace (a file name, a count, a status). Translated only while the
    // element still shows the text i18n wrote last (at first: the English
    // default from EN_PAGE); anything the code wrote since stays.
    // ---------------------------------------------------------
    const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
    all('[data-i18n-soft]').forEach(el => {
        const key = el.getAttribute('data-i18n-soft');
        const v = d[key];
        if (v === undefined || typeof v === 'function') return;
        const cur = norm(el.innerHTML);
        let untouched;
        if (el.__i18nLast !== undefined) untouched = cur === el.__i18nLast;
        else if (window.EN_PAGE && window.EN_PAGE[key] !== undefined) untouched = cur === norm(window.EN_PAGE[key]);
        else untouched = true; // first pass on a page without EN_PAGE: markup default
        if (!untouched) return;
        el.innerHTML = v;
        el.__i18nLast = norm(el.innerHTML);
    });
}
// NOTE: a distinct name - a top-level function in a classic script IS
// window.<name>, so assigning window.applyI18n to a wrapper calling
// applyI18n() would call itself forever
window.applyI18n = function (root) { i18nApplyTo(root); };

function applyLanguage() {
    // 1. Get the current dictionary
    const d = typeof getTranslations === 'function' ? getTranslations() : window.PAGE_I18N;
    if (!d) return;

    document.documentElement.lang = currentLang;
    if (d.title) document.title = d.title;

    i18nApplyTo(document, d);

    if (typeof renderNav === 'function') renderNav();

    if (typeof window.updateToolDynamicUI === 'function') {
        window.updateToolDynamicUI(d);
    }

    document.dispatchEvent(new Event('languageLoaded'));

    // Add this line to re-render any icons inside dynamically updated blocks
    if (window.lucide) lucide.createIcons();
}

// --- Inject Global Navigation and Footer ---
// Opt-in per page: injectUI({ linkTarget: '_blank' }) makes every injected
// nav/footer link open in a new tab. Editors with unsaved work use this so a
// stray click on the bar cannot navigate away from the drawing. Links that
// already declare their own target keep it.
window._uiLinkTarget = null;
function applyUiLinkTarget(root) {
    if (!window._uiLinkTarget || !root) return;
    root.querySelectorAll('a[href]').forEach(a => {
        if (a.hasAttribute('target')) return;
        const href = a.getAttribute('href') || '';
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        a.target = window._uiLinkTarget;
        a.rel = 'noopener noreferrer';
    });
}

/* ---- CDE mode (app window opened from a project hub) ----
 * ?project=<guid>&open=<relPath> -> {guid, open}; else null.
 * Used by injectUI: logo "Home" -> the project, "All" -> liteaeco.com, and
 * app links open in their own window so the project app stays open. */
window.liteaecoCdeContext = function () {
    try {
        const q = new URLSearchParams(window.location.search);
        const guid = q.get('project'), open = q.get('open');
        return (guid && open) ? { guid, open } : null;
    } catch (e) { return null; }
};
// "All" category link: the public site in CDE mode, the local index otherwise
function cdeAllHref() { return window.liteaecoCdeContext() ? 'https://liteaeco.com' : `${window.SITE_ROOT}index.html`; }
// links that would leave the project app open in their own window in CDE mode
function cdeTarget() { return window.liteaecoCdeContext() ? ' target="_blank" rel="noopener"' : ''; }

window.injectUI = function (options = {}) {
    // Set default behaviors
    if (typeof options.linkTarget === 'string' && options.linkTarget) window._uiLinkTarget = options.linkTarget;
    const showSignIn = options.showSignIn !== false;
    const showCategories = options.showCategories !== false;
    const showNav = options.showNav !== false;
    const showHelp = options.showHelp !== false;
    const showNews = options.showNews !== false;
    const showDonation = options.showDonation !== true;
    window._showDonation = showDonation;

    // CDE mode: this app window was opened from a project hub
    // (?project=<guid>&open=<path>). The logo then reads "Home" and leads back
    // to the project; "All" goes to liteaeco.com and app links open in their
    // own window, so the project app stays open.
    const cdeCtx = window.liteaecoCdeContext();

    // Logo link: defaults to the hub index, overridable per app.
    // injectUI({ logoHref: 'https://example.com', logoTarget: '_blank' })
    // CDE mode: back to the project's Files tab. To return to the app's own
    // tab instead (meetings -> Meetings, ...), replace 'files' below with the
    // app's hub tab id (e.g. from an options.cdeTab the app passes in).
    const logoHref = (typeof options.logoHref === 'string' && options.logoHref)
        ? options.logoHref
        : cdeCtx
            ? `project-core.html?project=${encodeURIComponent(cdeCtx.guid)}&tab=files`
            : `${window.SITE_ROOT}index.html`;
    const logoTarget = (typeof options.logoTarget === 'string' && options.logoTarget)
        ? ` target="${options.logoTarget}" rel="noopener noreferrer"`
        : '';

    // Footer toggles
    const showFooter = options.showFooter !== false;
    const showFooterLinks = options.showFooterLinks !== false;
    const showFooterBottom = options.showFooterBottom !== false;

    // ==========================================
    // 1. INJECT NAVIGATION
    // ==========================================
    if (showNav) {
        const nav = document.createElement('nav');

        // --- NEW: Handle manual true/false override for transparency ---
        let useTransparency;
        if (typeof options.transparentNav === 'boolean') {
            useTransparency = options.transparentNav; // Use explicit true/false if provided
        } else {
            useTransparency = window.isHighPerformance(); // Otherwise, auto-detect hardware
        }

        const navBgClass = useTransparency
            ? "bg-white/80 backdrop-blur-md border-slate-50"
            : "bg-white border-slate-200"; // Solid fallback

        // Apply the dynamic class
        nav.className = `fixed top-0 left-0 right-0 z-[150] transition-all duration-300 border-b shadow-[0_4px_30px_rgba(0,0,0,0.03)] ${navBgClass}`;

        nav.innerHTML = `
            <div class="mx-auto px-4 md:px-8 h-12 flex items-center justify-between">
            <a id="ui-logo-link" href="${logoHref}"${logoTarget}${cdeCtx ? ' title="Back to project"' : ''} class="flex items-center gap-3 cursor-pointer group">
                    <svg class="w-6 h-6 shadow-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 62 62">
                        <defs>
                            <linearGradient id="b"><stop offset="0" stop-color="#b6b6f7" /><stop offset="1" stop-color="#487af2" /></linearGradient>
                            <linearGradient id="a"><stop offset="0" stop-color="#6266f1" /><stop offset="1" stop-color="#2763ec" /></linearGradient>
                            <linearGradient href="#a" id="c" x1="73.9" x2="128.9" y1="78.9" y2="144.5" gradientTransform="matrix(.8 0 0 .8 -45 -53)" gradientUnits="userSpaceOnUse" />
                            <linearGradient href="#b" id="d" x1="122.8" x2="122.8" y1="90.3" y2="133.1" gradientTransform="matrix(.8 0 0 .8 -45 -53)" gradientUnits="userSpaceOnUse" />
                        </defs>
                        <path fill="url(#c)" d="m0 0 66 66H33L0 33Z" />
                        <path fill="url(#d)" d="M33 33 66 0v66z" />
                    </svg>
                    <span class="font-semibold text-lg tracking-tight text-slate-900">${cdeCtx ? 'Home' : 'liteAECO'}</span>
                </a>

                ${showCategories ? `<div id="desktop-nav" class="hidden md:flex items-center h-full"></div>` : ''}

                <div class="hidden md:flex items-center gap-3 h-full">
    
                    ${showNews ? `
                    <a href="https://liteaeco.com/news/" target="_blank" rel="noopener noreferrer" class="text-[12px] font-bold uppercase tracking-widest text-slate-600 hover:text-blue-600 transition-colors px-2" id="ui-link-news">
                        News
                    </a>` : ''}
                    <div id="langToggleWrap" class="relative">
                        <button id="langToggle" type="button" aria-haspopup="listbox" aria-expanded="false"
                            class="flex items-center gap-1 bg-white/50 backdrop-blur-sm border border-slate-200 text-slate-700 text-[12px] rounded focus:outline-none focus:ring-2 focus:ring-blue-500/50 py-1 px-2 cursor-pointer font-semibold uppercase tracking-wide transition-colors hover:bg-white/80">
                            <span id="langToggleLabel">EN</span>
                            <svg class="w-3 h-3 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
                        </button>
                        <ul id="langMenu" role="listbox" tabindex="-1"
                            class="hidden absolute right-0 font-mono mt-1 min-w-[10rem] bg-white border border-slate-200 rounded shadow-xl py-1 z-[200] max-h-[60vh] overflow-auto"></ul>
                    </div>
                    ${showSignIn ? `
                    <div class="border-l border-slate-200 pl-3 ml-1">
                        <a href="${window.SITE_ROOT}info/login.html" id="ui-nav-signin" data-i18n="signIn" class="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold uppercase tracking-widest transition-all duration-300 rounded-none inline-block">Sign In</a>
                    </div>` : ''}
                </div>

                ${showCategories ? `
                <button id="mobile-menu-toggle" class="md:hidden p-2 text-slate-600 hover:bg-slate-100 rounded-none transition-colors">
                    <i data-lucide="menu"></i>
                </button>` : ''}
            </div>

            ${showCategories ? `
            <div id="mobile-menu" class="hidden md:hidden bg-white border-b border-slate-200 absolute top-full w-full left-0 shadow-lg max-h-[calc(100vh-3rem)] overflow-y-auto overscroll-contain">
                <div id="mobile-nav" class="flex flex-col"></div>
            </div>` : ''}
        `;

        document.body.insertBefore(nav, document.body.firstChild);

        // CDE mode: "Home" returns to the hub tab this window was opened from
        // (focus it and close this one) instead of loading a second hub here.
        // No opener (opened directly / hub closed): follow the link.
        if (cdeCtx && !options.logoHref) {
            const logo = nav.querySelector('#ui-logo-link');
            if (logo) logo.addEventListener('click', (e) => {
                try {
                    if (window.opener && !window.opener.closed && window.opener.location.origin === window.location.origin) {
                        e.preventDefault();
                        window.opener.focus();
                        window.close();
                    }
                } catch (err) { /* cross-origin opener: follow the link */ }
            });
        }

        // Setup Event Listeners for Nav Elements
        const langToggle = document.getElementById('langToggle');
        const langMenu = document.getElementById('langMenu');
        if (langToggle && langMenu) {
            setLangLabel(currentLang);

            langToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                langMenu.classList.contains('hidden') ? openLangMenu() : closeLangMenu();
            });

            langMenu.addEventListener('click', (e) => {
                const li = e.target.closest('[data-value]');
                if (li) selectLang(li.getAttribute('data-value'));
            });

            // Close on outside click or Escape.
            document.addEventListener('click', (e) => {
                if (!e.target.closest('#langToggleWrap')) closeLangMenu();
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') closeLangMenu();
            });
        }

        const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
        if (mobileMenuToggle) {
            // Change this line:
            // mobileMenuToggle.addEventListener('click', window.toggleMobileMenu);

            // To this:
            mobileMenuToggle.addEventListener('click', () => window.toggleMobileMenu());
        }

        if (showHelp && typeof setupHelpButton === 'function') {
            setupHelpButton();
        }

        // Theme controls are available only on pages that load the shared theme.
        if (window.LiteAECOTheme) window.LiteAECOTheme.installControls(nav);

        // ADD THIS LINE HERE: Render immediately with default labels
        if (typeof renderNav === 'function') renderNav();
        applyUiLinkTarget(nav);
    }

    window.toggleMobileMenu = function () {
        const mobileMenu = document.getElementById('mobile-menu');
        if (mobileMenu) {
            mobileMenu.classList.toggle('hidden');
            mobileMenu.classList.toggle('md:hidden');
        }
    };

    // ==========================================
    // 2. INJECT FOOTER
    // ==========================================
    if (showFooter) {
        const footer = document.createElement('footer');
        const ptClass = showFooterLinks ? "pt-4" : "pt-4";
        footer.className = `mt-auto relative z-10 border-t border-slate-200 bg-slate-50-50 pb-4 px-4 md:px-8 ${ptClass}`;

        let footerHTML = '';

        if (showFooterLinks) {
            footerHTML += `
            <div class="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-12 pt-4 pb-4 mb-4 border-b border-slate-200">
                <div class="col-span-1 md:col-span-2">
                    <div class="flex items-center gap-3 mb-6">
                        <svg class="w-6 h-6 shadow-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 62 62">
                            <defs>
                                <linearGradient id="b"><stop offset="0" stop-color="#b6b6f7" /><stop offset="1" stop-color="#487af2" /></linearGradient>
                                <linearGradient id="a"><stop offset="0" stop-color="#6266f1" /><stop offset="1" stop-color="#2763ec" /></linearGradient>
                                <linearGradient href="#a" id="c" x1="73.9" x2="128.9" y1="78.9" y2="144.5" gradientTransform="matrix(.8 0 0 .8 -45 -53)" gradientUnits="userSpaceOnUse" />
                                <linearGradient href="#b" id="d" x1="122.8" x2="122.8" y1="90.3" y2="133.1" gradientTransform="matrix(.8 0 0 .8 -45 -53)" gradientUnits="userSpaceOnUse" />
                            </defs>
                            <path fill="url(#c)" d="m0 0 66 66H33L0 33Z" />
                            <path fill="url(#d)" d="M33 33 66 0v66z" />
                        </svg>
                        <span class="font-semibold text-lg tracking-tight text-slate-900">liteAECO</span>
                    </div>
                    <p id="ui-footer-desc" data-i18n="footerDesc" class="text-slate-600 text-sm max-w-sm leading-relaxed">
                        Free tools for AEC project teams. Built with a focus on speed, utility, and operational clarity.
                    </p>
                </div>
                <div>
                    <h4 id="ui-footer-legal" data-i18n="footerLegal" class="font-semibold text-slate-900 text-sm mb-4 uppercase tracking-widest">Legal</h4>
                    <ul class="space-y-3 text-sm text-slate-600">
                        <li><a href="${window.SITE_ROOT}info/terms-of-service.html" id="ui-link-terms" data-i18n="linkTerms" class="hover:text-blue-600 transition-colors">Terms of Service</a></li>
                        <li><a href="${window.SITE_ROOT}info/privacy-policy.html" id="ui-link-privacy" data-i18n="linkPrivacy" class="hover:text-blue-600 transition-colors">Privacy Policy</a></li>
                        <li><a href="${window.SITE_ROOT}info/data-processing.html" id="ui-link-data" data-i18n="linkData" class="hover:text-blue-600 transition-colors">Data Processing</a></li>
                        <li><a href="${window.SITE_ROOT}info/fund.html" id="ui-link-media" data-i18n="linkDonate" class="hover:text-blue-600 transition-colors">Donate</a></li>
                    </ul>
                </div>
                <div>
                    <h4 id="ui-footer-info" data-i18n="footerInfo" class="font-semibold text-slate-900 text-sm mb-4 uppercase tracking-widest">Information</h4>
                    <ul class="space-y-3 text-sm text-slate-600">
                        <li><a href="${window.SITE_ROOT}info/contact.html" id="ui-link-contact" data-i18n="linkContact" class="hover:text-blue-600 transition-colors">Contact</a></li>
                        <li><a href="${window.SITE_ROOT}info/about.html" id="ui-link-about" data-i18n="linkAbout" class="hover:text-blue-600 transition-colors">About</a></li>
                        <li><a href="${window.SITE_ROOT}info/faqs.html" id="ui-link-faqs" data-i18n="linkFAQs" class="hover:text-blue-600 transition-colors">FaQs</a></li>
                        <li><a href="${window.SITE_ROOT}info/pricing.html" id="ui-link-pricing" data-i18n="linkPricing" class="hover:text-blue-600 transition-colors">Pricing</a></li>
                    </ul>
                </div>
            </div>`;
        }

        if (showFooterBottom) {
            footerHTML += `
            <div class="max-w-7xl mx-auto flex flex-col md:flex-row justify-center items-center text-[10px] text-slate-500 uppercase tracking-widest">
                <p>&copy; <span id="current-year"></span> liteAECO. All rights reserved.&nbsp;</p>
                <p class="mt-4 md:mt-0 flex items-center gap-2">
                    <span id="ui-footer-engineered" data-i18n="footerEngineered">Engineered in Switzerland</span>
                    <svg class="w-3 h-3 rounded-none" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
                        <path d="m0 0h32v32h-32z" fill="#f00" />
                        <path d="m13 6h6v7h7v6h-7v7h-6v-7h-7v-6h7z" fill="#fff" />
                    </svg>
                    <span id="ui-footer-nocloud" data-i18n="footerNoCloud">No Cloud Uploads. Processed Locally.</span>
                </p>
            </div>`;
        }

        footer.innerHTML = footerHTML;
        document.body.appendChild(footer);
        applyUiLinkTarget(footer);

        const yearElement = document.getElementById('current-year');
        if (yearElement) yearElement.textContent = new Date().getFullYear();
    }
};

// --- Updated renderNav (Handles the "ALL" redirect) ---
function renderNav() {
    // 1. Grab the DOM elements safely
    const desktopNav = document.getElementById('desktop-nav');
    const mobileNav = document.getElementById('mobile-nav');

    // If the Nav hasn't been injected into the DOM yet, abort to prevent errors
    if (!desktopNav || !mobileNav) return;

    // 2. Fetch the current translations
    const d = getTranslations();

    // Desktop Nav
    desktopNav.innerHTML = CATEGORIES.map(cat => {
        // Fetch translated category label
        const catLabel = (d.categories && d.categories[cat.id]) || cat.label;

        // Special case for 'all' to act as a link to Index
        if (cat.id === 'all') {
            return `
            <div class="relative group h-full flex items-center">
                <a href="${cdeAllHref()}"${cdeTarget()} class="h-full flex items-center px-6 text-xs font-bold uppercase tracking-widest border-b-2 transition-all duration-300 focus:outline-none ${activeCategory === cat.id ? 'border-blue-600 text-blue-700 bg-white' : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-white'}">
                    ${catLabel}
                </a>
            </div>`;
        }

        // Standard dropdown for other categories
        const appsInCat = APPS.filter(app => app.categories && app.categories.includes(cat.id));
        return `
            <div class="relative group h-full flex items-center">
                <button onclick="setCategory('${cat.id}')" class="h-full px-6 text-xs font-bold uppercase tracking-widest border-b-2 transition-all duration-300 focus:outline-none ${activeCategory === cat.id ? 'border-blue-600 text-blue-700 bg-white' : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-white'}">
                    ${catLabel}
                </button>
                <div class="absolute top-12 left-0 w-64 bg-white border border-slate-200 shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 transform translate-y-1 group-hover:translate-y-0 z-50">
                    <div class="p-2 space-y-1 max-h-[60vh] overflow-y-auto custom-scrollbar">
                        ${appsInCat.map(app => {

            // Fetch translated App Title (fallback to 'Unknown Tool' if missing)
            const appTitle = (d.apps && d.apps[app.id] && d.apps[app.id].title) || 'Unknown Tool';

            // URL Matching for active state
            const appFileName = app.url.split('/').pop();
            const isCurrentApp = window.location.pathname.includes(appFileName);

            return `
                                <a href="${app.url}"${cdeTarget()} class="flex items-center gap-3 p-2 hover:bg-blue-50 rounded-none transition-colors group/item block ${isCurrentApp ? 'bg-blue-50/50' : ''}">
                                    <div class="w-8 h-8 bg-white border flex items-center justify-center shrink-0 ${isCurrentApp ? 'border-blue-300 text-blue-600 shadow-sm' : 'border-slate-100 text-slate-500 group-hover/item:text-blue-600'}">
                                        ${window.renderAppIcon(app, 'w-4 h-4', 'transition-transform')}
                                    </div>
                                    <span class="text-sm ${isCurrentApp ? 'font-bold text-blue-700' : 'font-medium text-slate-700 group-hover/item:text-blue-700'}">${appTitle}</span>
                                </a>`
        }).join('')}
                    </div>
                </div>
            </div>`;
    }).join('');

    // Donate — sits in the middle nav, right after the last category (Operations)
    if (window._showDonation) {
        const donateLabel = d.linkDonate || 'Donate';
        desktopNav.innerHTML += `
            <div class="h-full flex items-center">
                <a href="${window.SITE_ROOT}info/fund.html" id="ui-link-donate"
                    class="h-full flex items-center px-6 text-xs font-bold uppercase tracking-widest border-b-2 border-transparent text-blue-600 hover:text-blue-700 hover:bg-white transition-all duration-300 focus:outline-none">
                    ${donateLabel}
                </a>
            </div>`;
    }

    // Mobile Nav — accordion: category row expands to its app list.
    const openCat = window._mobileOpenCat || null;
    mobileNav.innerHTML = CATEGORIES.map(cat => {
        const catLabel = (d.categories && d.categories[cat.id]) || cat.label;

        if (cat.id === 'all') {
            return `
            <a href="${cdeAllHref()}"${cdeTarget()} class="block text-left px-6 py-4 text-xs font-bold uppercase tracking-widest border-b border-slate-100 transition-colors focus:outline-none ${activeCategory === cat.id ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50'}">
                ${catLabel}
            </a>`;
        }

        const appsInCat = APPS.filter(app => app.categories && app.categories.includes(cat.id));
        const isOpen = openCat === cat.id;

        const appsHTML = appsInCat.map(app => {
            const appTitle = (d.apps && d.apps[app.id] && d.apps[app.id].title) || 'Unknown Tool';
            const appFileName = app.url.split('/').pop();
            const isCurrentApp = window.location.pathname.includes(appFileName);

            return `
                <a href="${app.url}"${cdeTarget()} class="flex items-center gap-3 px-6 py-3 border-b border-slate-100 last:border-b-0 transition-colors ${isCurrentApp ? 'bg-blue-50/70' : 'hover:bg-white'}">
                    <div class="w-7 h-7 bg-white border flex items-center justify-center shrink-0 ${isCurrentApp ? 'border-blue-300 text-blue-600 shadow-sm' : 'border-slate-100 text-slate-500'}">
                        ${window.renderAppIcon(app, 'w-4 h-4')}
                    </div>
                    <span class="text-sm ${isCurrentApp ? 'font-bold text-blue-700' : 'font-medium text-slate-700'}">${appTitle}</span>
                </a>`;
        }).join('');

        return `
            <div class="border-b border-slate-100">
                <button onclick="toggleMobileCat('${cat.id}')" aria-expanded="${isOpen}" class="w-full flex items-center justify-between gap-3 text-left px-6 py-4 text-xs font-bold uppercase tracking-widest transition-colors focus:outline-none ${isOpen || activeCategory === cat.id ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50'}">
                    <span>${catLabel}</span>
                    <i data-lucide="chevron-down" class="w-4 h-4 shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}"></i>
                </button>
                <div class="${isOpen ? '' : 'hidden'} bg-slate-50">
                    ${appsHTML || `<div class="px-6 py-3 text-sm text-slate-400">—</div>`}
                </div>
            </div>`;
    }).join('');

    applyUiLinkTarget(desktopNav);
    applyUiLinkTarget(mobileNav);
    if (window.lucide) lucide.createIcons();
}

// --- Mobile accordion: open one category at a time ---
window._mobileOpenCat = null;
window.toggleMobileCat = function (catId) {
    window._mobileOpenCat = (window._mobileOpenCat === catId) ? null : catId;

    // On the hub (index.html) keep the old filtering behaviour as well.
    if (window._mobileOpenCat && typeof renderCards === 'function') {
        window.setCategory(catId); // this re-renders the nav
    } else {
        renderNav();
    }
};

window.setCategory = function (catId) {
    activeCategory = catId;

    // Update the URL hash without reloading the page
    if (window.location.hash.replace('#', '') !== catId) {
        window.history.pushState(null, null, catId === 'all' ? ' ' : `#${catId}`);
    }

    renderNav();
    if (typeof renderCards === 'function') {
        renderCards();
    }
};

// --- Inject Dynamic Help Button ---
function setupHelpButton() {
    // 1. Get the current filename
    const fileNameFull = window.location.pathname.split('/').pop();
    if (!fileNameFull) return;

    const fileName = fileNameFull.toLowerCase();

    // 2. Skip adding the button if we are on Help, Index, or root
    if (fileName === 'help.html' || fileName === 'index.html' || fileName === '') return;

    // 3. Find the language toggle (its wrapper, so the help button sits outside it)
    const langToggle = document.getElementById('langToggleWrap') || document.getElementById('langToggle');
    if (!langToggle) return;

    // Prevent adding multiple buttons if this function runs twice
    if (document.getElementById('dynamic-help-btn')) return;

    // 4. Convert filename to Help ID (e.g., "ifc-viewer-audit.html" -> "ifc-viewer-audit")
    const helpId = fileNameFull.replace('.html', '').toLowerCase().replace(/_/g, '-');

    // 5. Create the Help Button
    const helpBtn = document.createElement('a');
    helpBtn.id = 'dynamic-help-btn';
    helpBtn.href = `${window.SITE_ROOT}info/help.html#${helpId}`;

    // Styling: Added 'mr-3' (margin-right) so it spaces nicely before the language toggle
    helpBtn.className = "mr-3 p-1.5 text-slate-500 hover:text-blue-600 hover:bg-slate-100 rounded transition-colors flex items-center justify-center";
    helpBtn.title = "Help & Documentation";
    helpBtn.target = "_blank";
    helpBtn.innerHTML = '<i data-lucide="circle-help" class="w-[18px] h-[18px]"></i>';

    // 6. KEY STEP: Insert the button BEFORE the language toggle
    langToggle.parentNode.insertBefore(helpBtn, langToggle);
}

// Global Boot Sequence
document.addEventListener('DOMContentLoaded', () => {
    const yearElement = document.getElementById('current-year');
    if (yearElement) yearElement.textContent = new Date().getFullYear();

    const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
    if (mobileMenuToggle) mobileMenuToggle.addEventListener('click', window.toggleMobileMenu);

    autoDetectLanguage();

    if (window.lucide) lucide.createIcons();
});


// ==========================================
// DISCIPLINES (shared by the Project Hub and the 3D viewer)
// ------------------------------------------
// One vocabulary for every liteAECO page. A model's discipline is a
// code from this list, recorded project-wide in the CDE log
// (model.discipline, core build 18). Role codes are for contacts and
// BCF only; model pickers use models().
//   liteAECO.disciplines.models()      model codes, A-Z
//   liteAECO.disciplines.roles()       role codes, A-Z
//   liteAECO.disciplines.all()         everything, inference order
//   liteAECO.disciplines.byCode(code)  entry or null
//   liteAECO.disciplines.isModelCode(code)
//   liteAECO.disciplines.normalize(v)  "arc " -> "ARC" (A-Z 0-9, max 12)
//   liteAECO.disciplines.infer(text)   best guess from a file or folder
//                                      name, "" when unsure
// Inference: a code as a whole token (plural allowed, so ARC_VOIDS is
// VOID), then keywords as whole tokens (multi-word keywords match the
// spaced name). Never inside a word: ARCHIVE is not ARC.
// ==========================================
(function () {
    var W = typeof window !== 'undefined' ? window : globalThis;
    // inference order: VOID first so ARC_VOIDS resolves to VOID
    var DEFS = [
        { code: 'VOID', label: 'Provisions / Voids', color: '#fdba74', keywords: ['VOID', 'VOIDS', 'PROVISION', 'PROVISIONS', 'OPENING', 'OPENINGS', 'PFV', 'SUD', 'DURCHBRUCH'] },
        { code: 'ARC', label: 'Architectural', color: '#d4d4d8', keywords: ['ARCH', 'ARCHITECTURE', 'ARCHITECTURAL', 'ARC', 'AA'] },
        { code: 'STR', label: 'Structural', color: '#fca5a5', keywords: ['STRUCT', 'STRUCTURE', 'STRUCTURAL', 'STR', 'ST'] },
        { code: 'ELE', label: 'Electrical', color: '#fcd34d', keywords: ['ELECT', 'ELECTRICAL', 'ELECTRICITY', 'ELE', 'EL'] },
        { code: 'HVAC', label: 'Heating, Ventilation, and Air Conditioning', color: '#a5f3fc', keywords: ['HVAC', 'HEATING', 'VENTILATION', 'AIR CONDITIONING', 'HLKS', 'HL'] },
        { code: 'SAN', label: 'Sanitary / Plumbing', color: '#93c5fd', keywords: ['SANITARY', 'SANITAER', 'SANIT\u00c4R', 'PLUMBING', 'SAN', 'SA'] },
        { code: 'MEP', label: 'Mechanical, Electrical, and Plumbing', color: '#ddd6fe', keywords: ['MEP', 'MECHANICAL ELECTRICAL PLUMBING'] },
        { code: 'FUR', label: 'Furniture', color: '#d9f99d', keywords: ['FURNITURE', 'FURNISHING', 'FURNISHINGS', 'FUR', 'FU', 'MOB'] },
        { code: 'INT', label: 'Interior design', color: '#c4b5fd', keywords: ['INTERIOR', 'INTERIOR DESIGN', 'INTERIORS', 'INT', 'IN'] },
        { code: 'FAC', label: 'Facade', color: '#bfdbfe', keywords: ['FACADE', 'FA\u00c7ADE', 'ENVELOPE', 'FAS', 'FA'] },
        { code: 'FND', label: 'Foundations', color: '#fecaca', keywords: ['FOUNDATION', 'FOUNDATIONS', 'SUBSTRUCTURE'] },
        { code: 'LAN', label: 'Landscape', color: '#6ee7b7', keywords: ['LANDSCAPE', 'LANDSCAPING', 'SITE', 'LAND', 'LAN'] },
        { code: 'PRO', label: 'Process', color: '#fde68a', keywords: ['PROCESS', 'PROCESSING', 'PRODUCTION', 'PRO', 'PR'] },
        { code: 'LAB', label: 'Laboratory', color: '#a7f3d0', keywords: ['LAB', 'LABORATORY', 'LABORATORIES', 'LB'] },
        { code: 'ICT', label: 'Telecommunications and data', color: '#93c5fd', keywords: ['ICT', 'DATA', 'TELECOM', 'TELECOMMUNICATIONS', 'NETWORK', 'IT', 'TEL'] },
        { code: 'SEC', label: 'Security and access control', color: '#bef264', keywords: ['SECURITY', 'ACCESS CONTROL', 'ACCESS', 'SEC', 'SE'] },
        // role codes: contacts and BCF only, never inferred, never a model discipline
        { code: 'BIM', label: 'BIM management', color: '#e5e7eb', keywords: [], role: true },
        { code: 'COO', label: 'Coordination', color: '#e5e7eb', keywords: [], role: true },
        { code: 'REFM', label: 'Real estate and facility management', color: '#e5e7eb', keywords: [], role: true },
        { code: 'VDC', label: 'Virtual design and construction', color: '#e5e7eb', keywords: [], role: true },
        { code: 'VIEWER', label: 'Viewer (read only)', color: '#e5e7eb', keywords: [], role: true }
    ];
    DEFS.forEach(function (d) { Object.freeze(d.keywords); Object.freeze(d); });
    var BY = {};
    DEFS.forEach(function (d) { BY[d.code] = d; });
    function az(a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; }
    function copy(d) { return { code: d.code, label: d.label, color: d.color, keywords: d.keywords.slice(), role: !!d.role }; }

    function normalize(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
    function byCode(code) { var c = normalize(code); return Object.prototype.hasOwnProperty.call(BY, c) ? copy(BY[c]) : null; }
    function isModelCode(code) { var c = normalize(code); return Object.prototype.hasOwnProperty.call(BY, c) && !BY[c].role; }

    function infer(text) {
        var name = String(text || '').split(/[\\/]/).pop().toUpperCase().replace(/\.(IFC|IFCZIP|IFCXML|FRAG)$/, '');
        var tokens = name.split(/[^A-Z0-9\u00c4\u00c7\u00d6\u00dc]+/).filter(Boolean);
        if (!tokens.length) return '';
        var spaced = ' ' + tokens.join(' ') + ' ';
        var i, d;
        for (i = 0; i < DEFS.length; i++) {
            d = DEFS[i];
            if (d.role) continue;
            if (tokens.indexOf(d.code) !== -1 || tokens.indexOf(d.code + 'S') !== -1) return d.code;
        }
        // multi-word keywords first: MECHANICAL ELECTRICAL PLUMBING is MEP, not ELE
        for (var pass = 0; pass < 2; pass++) {
            for (i = 0; i < DEFS.length; i++) {
                d = DEFS[i];
                if (d.role) continue;
                for (var k = 0; k < d.keywords.length; k++) {
                    var kw = d.keywords[k];
                    var multi = kw.indexOf(' ') !== -1;
                    if (pass === 0 && multi && spaced.indexOf(' ' + kw + ' ') !== -1) return d.code;
                    if (pass === 1 && !multi && tokens.indexOf(kw) !== -1) return d.code;
                }
            }
        }
        return '';
    }

    var api = {
        VERSION: 1,
        all: function () { return DEFS.map(copy); },
        models: function () { return DEFS.filter(function (d) { return !d.role; }).sort(az).map(copy); },
        roles: function () { return DEFS.filter(function (d) { return d.role; }).sort(az).map(copy); },
        byCode: byCode,
        isModelCode: isModelCode,
        normalize: normalize,
        infer: infer
    };
    W.liteAECO = W.liteAECO || {};
    W.liteAECO.disciplines = Object.freeze(api);
})();
