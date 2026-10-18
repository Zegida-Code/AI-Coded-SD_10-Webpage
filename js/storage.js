// Local persistence (browser storage) for measurement history and UI preferences.
const HISTORY_KEY = 'sd10.history';
const PREFS_KEY = 'sd10.prefs';
const MAX_HISTORY = 500;

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export const history = {
  load: () => read(HISTORY_KEY, []),
  save: (items) => write(HISTORY_KEY, items.slice(0, MAX_HISTORY)),
};

const PREFS_VERSION = 2; // v2: default tolerance changed from 3 to 1

export const prefs = {
  load(defaults) {
    const saved = read(PREFS_KEY, {});
    // One-time migration: a stored tolerance of 3 was the old default, so move it to the new default.
    if ((saved._v ?? 1) < 2 && saved.threshold === 3) saved.threshold = defaults.threshold;
    return { ...defaults, ...saved, _v: PREFS_VERSION };
  },
  save: (p) => write(PREFS_KEY, { ...p, _v: PREFS_VERSION }),
};
