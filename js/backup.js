// Backups of everything the app keeps in this browser – the Print match job, color spaces, measurement history,
// settings and the ICC profiles you added. Clearing a browser's site data deletes all of it; a copy outside the browser
// survives that:
//   - automatically, to a folder you choose (File System Access API: Chrome / Edge on a computer). After changes the
//     app writes 'SD-10 backup.json' there plus one dated copy per day (the newest DAILY_COPIES are kept), and the
//     profiles as .icc files in a 'profiles' folder;
//   - as one file to download (profiles included), and restore from.
// It also asks the browser to keep the storage when the disk runs low (navigator.storage.persist).
import { getStoredFile, onStorageError, onStoredChange, replaceStored, setStoredFile, storedEntries, whenSaved } from './storage.js';
import { restoreProfiles, storedProfiles } from './icc.js';
import { $, closableDialog, downloadFile, toast } from './ui.js';
import { APP_VERSION, debugLog } from './debug.js';

const FORMAT = 'sd10-backup';
const LAST_KEY = 'sd10.lastBackup';
/** Not part of a backup: the debug journal and the backup's own bookkeeping. */
const EXCLUDED = ['sd10.debugJournal', LAST_KEY];
const LATEST = 'SD-10 backup.json', PROFILES_DIR = 'profiles';
const DAILY = /^SD-10 backup \d{4}-\d{2}-\d{2}\.json$/;
const DAILY_COPIES = 30;
const DELAY = 15000; // ms after the last change before the folder backup is written
const STALE_DAYS = 7; // a downloaded backup older than this is flagged

const canUseFolder = typeof window.showDirectoryPicker === 'function';
const state = { folder: null, permission: null, persisted: null, timer: null, writing: null, error: '' };

// ---------------------------------------------------------------- what a backup holds
const two = (v) => String(v).padStart(2, '0');
const day = (d = new Date()) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; // local date
const fileNameFor = (key) => `${key.replace(/[\\/:*?"<>|]+/g, '_')}.icc`;

/** The stored values as { key: parsed value }, without the excluded ones. */
function currentData() {
  const data = {};
  for (const [k, text] of Object.entries(storedEntries())) {
    if (EXCLUDED.includes(k)) continue;
    try { data[k] = JSON.parse(text); } catch { data[k] = text; }
  }
  return data;
}

/** What a backup's data holds, in counts; `any` – there is something worth keeping. */
function summarize(data, profiles) {
  const colors = (data['sd10.match']?.colors ?? []).filter((c) => c?.target || c?.rounds?.length).length;
  const spaces = (data['sd10.colorSpaces'] ?? []).length, history = (data['sd10.history'] ?? []).length;
  const sizes = (data['sd10.mediaSizes'] ?? []).length;
  return { colors, spaces, history, profiles, any: colors + spaces + history + sizes + profiles > 0 };
}
const plural = (n, word) => (n ? `${n} ${word}${n === 1 ? '' : 's'}` : '');
const summaryText = (s) => [plural(s.colors, 'color'), plural(s.spaces, 'color space'), plural(s.history, 'measurement'), plural(s.profiles, 'ICC profile')]
  .filter(Boolean).join(', ') || 'settings only';

const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer;

/**
 * A backup object, and the stored profiles it lists ({ key, data }). `embed` – the profiles' bytes go in the backup (a
 * downloaded file), else only their file names (a folder keeps them as .icc files).
 */
async function buildBackup({ embed }) {
  const profiles = await storedProfiles();
  profileCount = profiles.length;
  const backup = {
    format: FORMAT, version: 1, created: new Date().toISOString(), app: APP_VERSION,
    data: currentData(),
    profiles: profiles.map((p) => ({ key: p.key, file: fileNameFor(p.key), size: p.data.byteLength, ...(embed ? { data: toBase64(p.data) } : {}) })),
  };
  return { backup, profiles };
}

let profileCount = 0, hasDataCache = null;
/** Whether this browser holds anything worth backing up (worked out again only after the data changed). */
const hasData = () => (hasDataCache ??= summarize(currentData(), profileCount).any);

function noteBackup(where) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify({ time: Date.now(), where })); } catch { /* ignore */ }
  render();
}
const lastBackup = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY)); } catch { return null; } };

// ---------------------------------------------------------------- download / restore a file
async function downloadBackup(label = '') {
  const { backup } = await buildBackup({ embed: true });
  downloadFile(JSON.stringify(backup), 'application/json', `SD-10 backup ${day()}${label ? ` (${label})` : ''}.json`);
  debugLog('backup', 'backup downloaded', { label, profiles: backup.profiles.length });
}

/** Parse a backup file; throws a readable error. */
function parseBackup(text, name) {
  let o;
  try { o = JSON.parse(text); } catch { throw new Error(`${name} is not a backup file (not valid JSON)`); }
  if (o?.format !== FORMAT || typeof o.data !== 'object' || !o.data) throw new Error(`${name} is not an SD-10 backup file`);
  return o;
}

/**
 * Replace this browser's data with a backup (after asking), then reload. `profileFile(name)`: the bytes of a profile the
 * backup only names (a folder backup keeps them as separate files), or null.
 */
async function restore(b, where, profileFile) {
  const profiles = [], missing = [];
  for (const p of Array.isArray(b.profiles) ? b.profiles : []) {
    const data = p.data ? fromBase64(p.data) : await profileFile(p.file);
    if (data) profiles.push({ key: String(p.key), data }); else missing.push(p.file);
  }
  const s = summarize(b.data, profiles.length);
  const current = summarize(currentData(), (await storedProfiles()).length);
  const when = Number.isNaN(Date.parse(b.created)) ? 'an unknown date' : new Date(b.created).toLocaleString();
  if (!confirm(`Restore the backup from ${when} (${summaryText(s)}) ${where}?\n\nEverything stored in this browser is replaced${current.any ? ' – what is here now is downloaded first as a backup' : ''}.${missing.length ? `\n\nNot found, add them again afterwards: ${missing.join(', ')}` : ''}`)) return;
  if (current.any) await downloadBackup('before restore');
  const entries = Object.fromEntries(Object.entries(b.data).filter(([k]) => k.startsWith('sd10.') && !EXCLUDED.includes(k)).map(([k, v]) => [k, JSON.stringify(v)]));
  await replaceStored(entries, EXCLUDED);
  await restoreProfiles(profiles).catch((e) => toast(`The ICC profiles could not be restored: ${e.message}`, 'error'));
  await whenSaved();
  debugLog('backup', 'backup restored', { from: where, created: b.created, ...s });
  location.reload();
}

async function restoreFromFiles(files) {
  const json = files.find((f) => /\.json$/i.test(f.name)) ?? files[0];
  try {
    const b = parseBackup(await json.text(), json.name);
    const icc = Object.fromEntries(files.filter((f) => f !== json).map((f) => [f.name, f]));
    await restore(b, `from ${json.name}`, async (name) => (icc[name] ? icc[name].arrayBuffer() : null));
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------- automatic folder backup
async function writeFile(dir, name, data) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

async function readJsonFile(dir, name) {
  try { return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()); } catch { return null; }
}

/** Write the backup to the folder: the latest, today's copy, and any profile not there yet. Never an empty one. */
async function writeFolder() {
  const dir = state.folder;
  if (!dir || state.permission !== 'granted') return;
  const { backup, profiles } = await buildBackup({ embed: false });
  if (!summarize(backup.data, profiles.length).any) return; // nothing worth keeping – never overwrite a backup with it
  const text = JSON.stringify(backup);
  await writeFile(dir, LATEST, text);
  await writeFile(dir, `SD-10 backup ${day()}.json`, text);
  if (profiles.length) {
    const pdir = await dir.getDirectoryHandle(PROFILES_DIR, { create: true });
    for (const p of profiles) {
      const name = fileNameFor(p.key);
      const have = await pdir.getFileHandle(name).then((h) => h.getFile()).catch(() => null);
      if (!have || have.size !== p.data.byteLength) await writeFile(pdir, name, p.data);
    }
  }
  // keep the newest daily copies
  const daily = [];
  for await (const [name] of dir.entries()) if (DAILY.test(name)) daily.push(name);
  for (const name of daily.sort().reverse().slice(DAILY_COPIES)) await dir.removeEntry(name).catch(() => {});
  noteBackup('folder');
}

function backupSoon(delay = DELAY) {
  if (!state.folder || state.permission !== 'granted') return;
  clearTimeout(state.timer);
  state.timer = setTimeout(backupNow, delay);
}

/** Write the folder backup now (one at a time). */
function backupNow() {
  clearTimeout(state.timer);
  state.timer = null;
  state.writing = (state.writing ?? Promise.resolve()).then(writeFolder).then(() => { state.error = ''; }, (e) => {
    state.error = e.message;
    debugLog('error', 'folder backup failed', { message: e.message });
    // the folder was moved or deleted, or access was taken back
    if (e.name === 'NotFoundError' || e.name === 'NotAllowedError') state.permission = 'prompt';
  }).finally(render);
  return state.writing;
}

async function chooseFolder() {
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'sd10-backup', mode: 'readwrite', startIn: 'documents' }); } catch { return; } // cancelled
  state.folder = dir;
  state.permission = 'granted';
  await setStoredFile('backupFolder', dir);
  persist();
  // the folder already holds a backup: restore it here (a new browser or computer), or keep it next to this one's
  const existing = await readJsonFile(dir, LATEST);
  const mine = summarize(currentData(), (await storedProfiles()).length);
  if (existing?.format === FORMAT) {
    const theirs = summarize(existing.data ?? {}, existing.profiles?.length ?? 0);
    if (!mine.any && theirs.any) {
      const pdir = await dir.getDirectoryHandle(PROFILES_DIR).catch(() => null);
      await restore(existing, 'from this folder', async (name) => (pdir ? pdir.getFileHandle(name).then((h) => h.getFile()).then((f) => f.arrayBuffer()).catch(() => null) : null));
      // (restoring reloads the page – here it was declined)
    }
    if (theirs.any) await writeFile(dir, `SD-10 backup ${String(existing.created).slice(0, 10)} (kept).json`, JSON.stringify(existing));
  }
  debugLog('backup', 'backup folder chosen', { name: dir.name });
  await backupNow();
  toast(`Backing up to the folder “${dir.name}” automatically.`, 'ok');
}

async function allowAgain() {
  try { state.permission = await state.folder.requestPermission({ mode: 'readwrite' }); } catch { state.permission = 'denied'; }
  render();
  if (state.permission === 'granted') backupNow();
}

async function stopFolder() {
  if (!confirm(`Stop backing up to “${state.folder.name}”? The backups already there are kept.`)) return;
  state.folder = null;
  state.permission = null;
  clearTimeout(state.timer);
  await setStoredFile('backupFolder', null);
  render();
}

// ---------------------------------------------------------------- browser storage
async function persist() {
  try {
    state.persisted = await navigator.storage?.persisted?.() ?? null;
    // Chromium decides without asking; other browsers would show a prompt, so they are only asked from a click
    if (state.persisted === false) state.persisted = await navigator.storage.persist();
  } catch { /* not supported */ }
  render();
}

// ---------------------------------------------------------------- status
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function render() {
  const last = lastBackup();
  const status = $('backupStatus');
  const stale = !last || Date.now() - last.time > STALE_DAYS * 864e5;
  let text, tone;
  if (state.folder && state.permission === 'granted' && !state.error) {
    text = `Backed up automatically to the folder “${state.folder.name}”${last ? ` · ${ago(last.time)}` : ''}.`; tone = 'ok';
  } else if (state.folder) {
    text = state.error ? `The backup to “${state.folder.name}” failed – open Backups.` : `Automatic backup to “${state.folder.name}” is paused until you allow access again.`; tone = 'warn';
  } else if (last) {
    text = `Your data is kept in this browser – last backup downloaded ${ago(last.time)}.`; tone = stale ? 'warn' : '';
  } else {
    text = hasData() ? 'Your data is kept in this browser only and isn’t backed up yet.' : 'Your data is kept in this browser.'; tone = hasData() ? 'warn' : '';
  }
  status.textContent = text;
  status.className = tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : '';

  $('bkPersist').textContent = state.persisted ? '✓ The browser keeps this data even when the disk runs low.'
    : state.persisted === false ? 'The browser may clear this data on its own when the disk runs low – keep a backup.' : '';
  $('bkFolderInfo').textContent = !canUseFolder
    ? 'This browser can’t write to a folder – download a backup file instead (Chrome or Edge on a computer can back up automatically).'
    : state.folder
      ? `${state.permission === 'granted' ? 'Backing up' : 'Paused – allow access to back up'} to “${state.folder.name}”: the latest backup (${LATEST}), one copy per day (the last ${DAILY_COPIES} are kept) and your ICC profiles. ${last?.where === 'folder' ? `Last written ${ago(last.time)}.` : ''}${state.error ? ` Last attempt failed: ${state.error}` : ''}`
      : 'Choose a folder once – ideally one synced to the cloud (OneDrive, Google Drive, Dropbox …) – and the app keeps a backup there after every change. Choosing a folder that already holds a backup offers to restore it.';
  $('btnBkFolder').classList.toggle('hidden', !canUseFolder);
  $('btnBkFolder').textContent = state.folder ? 'Change folder…' : 'Choose folder…';
  $('btnBkFolder').classList.toggle('btn-primary', !state.folder);
  $('btnBkFolder').classList.toggle('btn-ghost', !!state.folder);
  $('btnBkAllow').classList.toggle('hidden', !state.folder || state.permission === 'granted');
  $('btnBkNow').classList.toggle('hidden', !state.folder || state.permission !== 'granted');
  $('btnBkStop').classList.toggle('hidden', !state.folder);
}

// ---------------------------------------------------------------- start-up
export async function initBackup() {
  const dialog = $('backupDialog');
  $('btnBackups').onclick = () => { render(); dialog.showModal(); };
  closableDialog(dialog);
  $('btnBkFolder').onclick = chooseFolder;
  $('btnBkAllow').onclick = allowAgain;
  $('btnBkNow').onclick = () => backupNow().then(() => !state.error && toast('Backed up.', 'ok'));
  $('btnBkStop').onclick = stopFolder;
  $('btnBkDownload').onclick = () => downloadBackup().then(() => { noteBackup('file'); persist(); });
  $('btnBkRestore').onclick = () => $('bkRestoreFile').click();
  $('bkRestoreFile').onchange = (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) restoreFromFiles(files);
  };

  onStoredChange((key) => {
    if (EXCLUDED.includes(key)) return;
    // until there is data the status says so; once there is, that does not change in a session (no need to look again)
    if (hasDataCache !== true) { hasDataCache = null; render(); }
    backupSoon();
  });
  // leaving the page: write what is waiting now
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && state.timer) backupNow(); });
  let warned = false;
  onStorageError((e) => {
    debugLog('error', 'saving to browser storage failed', { message: e.message });
    if (!warned) toast('Your work could not be saved in this browser – download a backup (Backups, at the bottom of the page) to keep it.', 'error');
    warned = true;
  });

  render();
  storedProfiles().then((p) => { profileCount = p.length; hasDataCache = null; render(); }).catch(() => {});
  if (navigator.userAgentData) persist(); // Chromium: no prompt
  if (canUseFolder) {
    const dir = await getStoredFile('backupFolder');
    if (dir) {
      state.folder = dir;
      state.permission = await dir.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
      render();
      const last = lastBackup();
      if (state.permission === 'granted' && (!last || last.where !== 'folder' || day(new Date(last.time)) !== day())) backupSoon(2000); // today's copy
    }
  }
  setInterval(render, 60000); // keep "… min ago" current
}
