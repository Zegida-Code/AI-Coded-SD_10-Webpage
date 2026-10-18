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

export const prefs = {
  load: (defaults) => ({ ...defaults, ...read(PREFS_KEY, {}) }),
  save: (p) => write(PREFS_KEY, p),
};
