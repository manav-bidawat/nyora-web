// core/store.js — observable prefs (localStorage-backed) + a hash router.
//
//  store  : appearance / accent / reader prefs persisted to 'nyora.prefs',
//           deep-merged via set(), with subscribe() + applyTheme(); plus
//           store.source — the current Source object shared across screens.
//  router : hash router. navigate(name, params) -> '#/name?k=v'; onChange(cb);
//           current() -> {name, params}; back(); start(routesMap, defaultName).

const STORAGE_KEY = 'nyora.prefs';

// Accent palette offered by Settings.
export const ACCENT_PALETTE = [
  '#ffffff', // White
  '#88ce02', // GSAP Green
  '#ff0040', // Anime Red
  '#ef4444', // Red
  '#f97316', // Orange
  '#f59e0b', // Amber
  '#84cc16', // Lime
  '#10b981', // Emerald
  '#14b8a6', // Teal
  '#06b6d4', // Cyan
  '#0ea5e9', // Sky
  '#3b82f6', // Blue
  '#6366f1', // Indigo
  '#8b5cf6', // Violet
  '#7c3aed', // Deep Purple
  '#ec4899', // Pink
  '#f43f5e', // Rose
];

const FALLBACK_ACCENT = '#ef4444'; // Use Red as fallback

const DEFAULT_PREFS = {
  appearance: 'DARK', // 'DARK' | 'LIGHT'
  accent: '#ef4444',    // Default to Red
  showNsfw: false,
  reader: {
    mode: 'WEBTOON', // 'WEBTOON' | 'PAGED' | 'PAGED_RTL'
    fit: 'WIDTH', // 'WIDTH' | 'HEIGHT'
    prefetch: true,
    webtoonWidth: 880,
  },
};

// ---- browser accent detection -----------------------------------------

function rgbToHex(rgb) {
  const m = /rgba?\(([^)]+)\)/.exec(rgb || '');
  if (!m) return null;
  const [r, g, b] = m[1].split(',').map((v) => parseInt(v.trim(), 10));
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  const h = (n) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

let _browserAccent; // memoized
export function detectBrowserAccent() {
  if (_browserAccent !== undefined) return _browserAccent;
  _browserAccent = null;
  try {
    if (window.CSS && CSS.supports && CSS.supports('color', 'AccentColor')) {
      const probe = document.createElement('span');
      probe.style.cssText = 'color:AccentColor;position:absolute;opacity:0;pointer-events:none';
      (document.body || document.documentElement).appendChild(probe);
      const hex = rgbToHex(getComputedStyle(probe).color);
      probe.remove();
      // Some platforms report pure white/black for AccentColor — treat as no signal.
      if (hex && hex !== '#ffffff' && hex !== '#000000') _browserAccent = hex;
    }
  } catch {
    _browserAccent = null;
  }
  return _browserAccent;
}

/** Resolve the effective accent hex from a pref value ('auto' or a hex). */
export function resolveAccent(pref) {
  if (pref && pref !== 'auto' && /^#[0-9a-fA-F]{6}$/.test(pref)) return pref;
  if (pref === 'auto') return detectBrowserAccent() || FALLBACK_ACCENT;
  return pref || FALLBACK_ACCENT;
}

// ---- deep helpers ------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Recursively clone so callers can't mutate our internal state by reference. */
function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
    return out;
  }
  return v;
}

/** Deep-merge `patch` into `target` in place. Arrays/scalars overwrite. */
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = deepClone(v);
    }
  }
  return target;
}

function loadPrefs() {
  const base = deepClone(DEFAULT_PREFS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) deepMerge(base, JSON.parse(raw));
  } catch {
    /* corrupt storage — fall back to defaults */
  }
  return base;
}

// ---- the store ---------------------------------------------------------

function createStore() {
  let prefs = loadPrefs();
  const subscribers = new Set();
  // Display-field cache (cover/title) keyed by manga url. Populated by the
  // card() grid helper so a details view reached by navigation can still show
  // the cover when a source's /manga/details omits it (e.g. AsuraScans returns
  // an empty coverUrl — the cover only ever comes from the list entry).
  const mangaCache = new Map();

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* storage full / disabled — ignore, state still lives in memory */
    }
  }

  function notify() {
    const snapshot = deepClone(prefs);
    for (const cb of subscribers) {
      try {
        cb(snapshot);
      } catch (e) {
        /* ignore subscriber error */
      }
    }
  }

  const store = {
    // current Source object shared across screens (not persisted).
    source: null,

    /** Returns a deep clone of the current prefs (safe to read freely). */
    get() {
      return deepClone(prefs);
    },

    /** Deep-merge a patch, persist, apply theme, and notify subscribers. */
    set(patch) {
      if (!patch || typeof patch !== 'object') return store.get();
      deepMerge(prefs, patch);
      persist();
      applyTheme();
      notify();
      return store.get();
    },

    /** Subscribe to changes. Returns an unsubscribe fn. */
    subscribe(cb) {
      if (typeof cb !== 'function') return () => {};
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },

    /** Remember a manga's display fields (cover/title) keyed by its url. */
    cacheManga(m) {
      if (m && m.url) {
        mangaCache.set(m.url, {
          coverUrl: m.coverUrl || '',
          largeCoverUrl: m.largeCoverUrl || '',
          title: m.title || '',
          isNsfw: m.isNsfw === true,
        });
      }
    },

    /** Recall cached display fields for a manga url (or null). */
    cachedManga(url) {
      return (url && mangaCache.get(url)) || null;
    },
  };

  /** Toggle body/root data-theme + set the --accent CSS variable. */
  function applyTheme() {
    const root = document.documentElement;
    const theme = prefs.appearance === 'LIGHT' ? 'LIGHT' : 'DARK';
    root.setAttribute('data-theme', theme);
    if (document.body) document.body.setAttribute('data-theme', theme);
    const accent = resolveAccent(prefs.accent);
    root.style.setProperty('--accent', accent);
    
    // Calculate contrast for --on-accent
    const rgb = hexToRgb(accent);
    const brightness = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
    const onAccent = brightness > 180 ? '#000000' : '#ffffff';
    root.style.setProperty('--on-accent', onAccent);

    // theme-color for mobile browser chrome / PWA: tint with the accent on dark.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'LIGHT' ? '#ffffff' : '#000000');
  }

  store.applyTheme = applyTheme;
  return store;
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

export const store = createStore();
export const applyTheme = () => store.applyTheme();

// ---- hash router -------------------------------------------------------

/** Encode a params object into a query string (no leading '?'). */
function encodeParams(params) {
  if (!params) return '';
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.join('&');
}

/** Decode a query string (no leading '?') into a plain string-valued object. */
function decodeParams(query) {
  const out = {};
  if (!query) return out;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    if (idx < 0) {
      out[decodeURIComponent(pair)] = '';
    } else {
      const k = decodeURIComponent(pair.slice(0, idx));
      const v = decodeURIComponent(pair.slice(idx + 1));
      out[k] = v;
    }
  }
  return out;
}

/** Parse a raw hash ('#/name?k=v') into {name, params}. */
function parseHash(hash, defaultName) {
  let h = (hash || '').replace(/^#/, '');
  if (h.startsWith('/')) h = h.slice(1);
  if (!h) return { name: defaultName, params: {} };
  const qIdx = h.indexOf('?');
  const name = qIdx < 0 ? h : h.slice(0, qIdx);
  const query = qIdx < 0 ? '' : h.slice(qIdx + 1);
  return { name: name || defaultName, params: decodeParams(query) };
}

function createRouter() {
  const listeners = new Set();
  let routes = {};
  let defaultName = 'explore';
  let started = false;

  function current() {
    return parseHash(location.hash, defaultName);
  }

  function emit() {
    const route = current();
    for (const cb of listeners) {
      try {
        cb(route);
      } catch (e) {
        /* ignore listener error */
      }
    }
  }

  function navigate(name, params) {
    const query = encodeParams(params);
    const target = '#/' + name + (query ? '?' + query : '');
    if (location.hash === target) {
      // Same hash — fire manually so re-navigation still re-renders.
      emit();
    } else {
      location.hash = target;
    }
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function back() {
    history.back();
  }

  function start(routesMap, fallbackName) {
    routes = routesMap || {};
    if (fallbackName) defaultName = fallbackName;
    if (!started) {
      window.addEventListener('hashchange', emit);
      started = true;
    }
    if (!location.hash || location.hash === '#' || location.hash === '#/') {
      navigate(defaultName);
    } else {
      emit();
    }
  }

  return {
    routes: () => routes,
    current,
    navigate,
    onChange,
    back,
    start,
  };
}

export const router = createRouter();

export default { store, router, applyTheme, ACCENT_PALETTE };
