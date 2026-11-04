// Local persistence (browser storage): JSON values for the views, the measurement history and the Console's
// preferences. Storage can be full or blocked (private windows, site data off): reads then give the fallback and
// writes report false, so callers keep working for the session.
//
// The job, the color spaces and the measurement history (LARGE_KEYS) grow to several MB with their spectra – more than
// localStorage holds – so they live in IndexedDB. Reads stay synchronous: those values are loaded into memory before
// the app starts (top-level await) and every save is written through to IndexedDB. Values an older version kept in
// localStorage move over on the first start. Everything else stays in localStorage.
const HISTORY_KEY = 'sd10.history';
const PREFS_KEY = 'sd10.prefs';
const MAX_HISTORY = 500;

const LARGE_KEYS = ['sd10.match', 'sd10.colorSpaces', HISTORY_KEY];
const isLarge = (key) => LARGE_KEYS.includes(key);

const DB = 'sd10-data', VALUES = 'values', FILES = 'files'; // FILES: things that are not JSON (a backup folder handle)
let db = null;
const large = new Map(); // LARGE_KEYS -> JSON text, as stored
let lastWrite = Promise.resolve();
const errorHandlers = [], changeHandlers = [];

const lsGet = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const lsRemove = (key) => { try { localStorage.removeItem(key); } catch { /* ignore */ } };

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(VALUES); req.result.createObjectStore(FILES); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('storage is blocked by another page'));
  });
}

function request(store, mode, fn) {
  if (!db) return Promise.reject(new Error('IndexedDB is not available'));
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('storage transaction aborted'));
  });
}

/** Write a large value through to IndexedDB (in order – transactions on one store run in the order they start). */
function writeLarge(key, text) {
  const p = request(VALUES, 'readwrite', (s) => (text == null ? s.delete(key) : s.put(text, key)));
  lastWrite = p.catch((e) => { errorHandlers.forEach((fn) => fn(e)); });
  return p;
}

async function init() {
  try {
    db = await openDb();
    // another page deletes or upgrades the database: let it (this page keeps its values in memory)
    db.onversionchange = () => { db.close(); db = null; };
    const [keys, values] = await Promise.all([request(VALUES, 'readonly', (s) => s.getAllKeys()), request(VALUES, 'readonly', (s) => s.getAll())]);
    keys.forEach((k, i) => large.set(String(k), values[i]));
    // kept in localStorage by an older version: newer than anything here (later versions never write it there)
    for (const key of LARGE_KEYS) {
      const text = lsGet(key);
      if (text == null) continue;
      large.set(key, text);
      await writeLarge(key, text);
      lsRemove(key);
    }
  } catch {
    // no IndexedDB (blocked): what an older version left in localStorage is still read, but large values are not kept
    db = null;
    for (const key of LARGE_KEYS) { const text = lsGet(key); if (text != null) large.set(key, text); }
  }
}
await init();

/** Called with the error when a write to IndexedDB fails (the value is still in memory for this session). */
export const onStorageError = (fn) => errorHandlers.push(fn);
/** Called with the key after every save or removal. */
export const onStoredChange = (fn) => changeHandlers.push(fn);
const changed = (key) => changeHandlers.forEach((fn) => fn(key));

/** A stored JSON value, or `fallback` when there is none (or it cannot be read). */
export function loadJson(key, fallback) {
  try { return JSON.parse(isLarge(key) ? large.get(key) ?? null : lsGet(key)) ?? fallback; } catch { return fallback; }
}

/** Store a value as JSON; false when the browser storage is full or blocked. */
export function saveJson(key, value) {
  const text = JSON.stringify(value);
  if (isLarge(key)) {
    large.set(key, text);
    if (!db) return false;
    writeLarge(key, text).catch(() => {});
  } else {
    try { localStorage.setItem(key, text); } catch { return false; }
  }
  changed(key);
  return true;
}

/** Remove a stored value (nothing happens when storage is blocked). */
export function removeStored(key) {
  if (isLarge(key)) {
    large.delete(key);
    if (db) writeLarge(key, null).catch(() => {});
  } else lsRemove(key);
  changed(key);
}

/** Resolves once every save so far has reached IndexedDB (before a page reload). */
export const whenSaved = () => lastWrite;

/** Every 'sd10.' value stored in this browser as { key: JSON text } – the large ones and localStorage's. */
export function storedEntries() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith('sd10.')) out[k] = localStorage.getItem(k);
    }
  } catch { /* storage blocked */ }
  for (const [k, v] of large) out[k] = v;
  return out;
}

/**
 * Replace the stored values with `entries` ({ key: JSON text }); keys in `keep` stay as they are. Resolves once
 * IndexedDB has them.
 */
export async function replaceStored(entries, keep = []) {
  for (const k of Object.keys(storedEntries())) if (!keep.includes(k) && !(k in entries)) removeStored(k);
  for (const [k, text] of Object.entries(entries)) {
    if (keep.includes(k)) continue;
    if (isLarge(k)) { large.set(k, text); if (db) writeLarge(k, text).catch(() => {}); } else { try { localStorage.setItem(k, text); } catch { /* full */ } }
  }
  await lastWrite;
}

/** A value kept in IndexedDB as it is (not JSON) – the backup folder's handle. undefined when there is none. */
export const getStoredFile = (key) => request(FILES, 'readonly', (s) => s.get(key)).catch(() => undefined);
export const setStoredFile = (key, value) => request(FILES, 'readwrite', (s) => (value == null ? s.delete(key) : s.put(value, key))).catch(() => false);

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
