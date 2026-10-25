// Local persistence (browser storage): JSON values for the views, the measurement history and the Console's
// preferences. Storage can be full or blocked (private windows, site data off): reads then give the fallback and
// writes report false, so callers keep working for the session.
const HISTORY_KEY = 'sd10.history';
const PREFS_KEY = 'sd10.prefs';
const MAX_HISTORY = 500;

/** A stored JSON value, or `fallback` when there is none (or it cannot be read). */
export function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

/** Store a value as JSON; false when the browser storage is full or blocked. */
export function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/** Remove a stored value (nothing happens when storage is blocked). */
export function removeStored(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export const history = {
  load: () => loadJson(HISTORY_KEY, []),
  save: (items) => saveJson(HISTORY_KEY, items.slice(0, MAX_HISTORY)),
};

const PREFS_VERSION = 2; // v2: default tolerance changed from 3 to 1

export const prefs = {
  load(defaults) {
    const saved = loadJson(PREFS_KEY, {});
    // One-time migration: a stored tolerance of 3 was the old default, so move it to the new default.
    if ((saved._v ?? 1) < 2 && saved.threshold === 3) saved.threshold = defaults.threshold;
    return { ...defaults, ...saved, _v: PREFS_VERSION };
  },
  save: (p) => saveJson(PREFS_KEY, { ...p, _v: PREFS_VERSION }),
};
