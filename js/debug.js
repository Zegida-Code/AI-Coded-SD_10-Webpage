// Debug report: one file with what is needed to understand a problem without screenshots – a journal of what the app
// did (actions, settings changed, messages shown, errors, measurements and results), what the screen showed, the
// stored data and settings, the device and the browser.
//
// The journal is kept in this browser (localStorage 'sd10.debugJournal', the newest 1500 entries), so it survives a
// reload – a problem from earlier in the day is still in the report.
import { loadJson, saveJson } from './storage.js';

const JOURNAL_KEY = 'sd10.debugJournal';
const MAX_ENTRIES = 1500;
/** The release, from this module's own versioned URL (see the import map in index.html). */
export const APP_VERSION = new URL(import.meta.url).searchParams.get('v') || 'development';

const journal = loadJson(JOURNAL_KEY, []);
let saveTimer = null;
const persist = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveJson(JOURNAL_KEY, journal), 500); // (storage full or blocked: the journal still lives for the session)
};
/**
 * Data as plain JSON: numbers rounded to 4 decimals, 64-bit values (the device's error bits) as hex; anything that still
 * cannot be serialised (e.g. a cycle) becomes text.
 */
function plain(data) {
  const replace = (_, v) => (typeof v === 'bigint' ? `0x${v.toString(16)}` : typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v);
  try { return JSON.parse(JSON.stringify(data, replace) ?? 'null'); } catch { return String(data); }
}

/** Add an entry to the journal: kind (e.g. 'click', 'toast', 'measure'), a short message and optional data. */
export function debugLog(kind, msg, data) {
  journal.push({ t: new Date().toISOString(), kind, msg: String(msg).slice(0, 500), ...(data === undefined ? {} : { data: plain(data) }) });
  if (journal.length > MAX_ENTRIES) journal.splice(0, journal.length - MAX_ENTRIES);
  persist();
}

/** An element as the journal names it: tag#id[data-…] "its text". */
function describe(el) {
  const data = Object.entries(el.dataset).map(([k, v]) => `[${k}=${v}]`).join('');
  const label = (el.getAttribute('aria-label') || el.textContent || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${data}${label ? ` "${label}"` : ''}`;
}
const fmtArg = (a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : typeof a === 'object' ? JSON.stringify(plain(a)) : String(a));

/**
 * Start recording: script errors, failed promises, console errors and warnings, and the user's actions – buttons and
 * links pressed, inputs changed (with their value), files picked or dropped.
 */
export function installDebugCapture() {
  addEventListener('error', (e) => debugLog('error', e.message, { source: e.filename, line: e.lineno, column: e.colno, stack: e.error?.stack }));
  addEventListener('unhandledrejection', (e) => debugLog('error', `Unhandled: ${e.reason?.message ?? e.reason}`, { stack: e.reason?.stack }));
  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { debugLog(`console.${level}`, args.map(fmtArg).join(' ')); original(...args); };
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('button, a, summary, [role=button]');
    if (el) debugLog('click', describe(el));
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.matches?.('input, select, textarea')) return;
    const value = el.type === 'checkbox' ? el.checked : el.type === 'file' ? [...el.files].map((f) => `${f.name} (${f.size} bytes)`) : el.value;
    debugLog('change', describe(el).replace(/ ".*"$/, ''), { value });
  }, true);
  addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files ?? [])].map((f) => `${f.name} (${f.size} bytes)`);
    if (files.length) debugLog('drop', `${files.length} file(s) dropped`, { files });
  }, true);
  debugLog('start', 'page loaded', { version: APP_VERSION, url: location.href });
}

/**
 * What the visible view shows: each card's heading and text (as rendered, hidden parts left out), and the last message.
 * Cards that only wrap other cards are left out (their cards are listed); a dialog styled as a card does not count.
 */
function screenText() {
  const view = [...document.querySelectorAll('main')].find((m) => !m.classList.contains('hidden'));
  const cards = view ? [...view.querySelectorAll('.card, section')].filter((c) => c.offsetParent !== null && !c.querySelector('.card:not(dialog)')) : [];
  const toastEl = document.getElementById('toast');
  const labelOf = (el) => ((el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) || el.closest('label')?.textContent || el.getAttribute('aria-label') || el.id).replace(/\s+/g, ' ').trim();
  return {
    view: view?.id ?? null,
    cards: cards.map((c) => {
      // form fields as "label: value"; their option lists are left out of the text
      const controls = [...c.querySelectorAll('select, input, textarea')].filter((el) => el.type !== 'file' && el.type !== 'hidden' && el.getClientRects().length);
      const fields = Object.fromEntries(controls.map((el) => [labelOf(el) || el.tagName.toLowerCase(),
        el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.selectedOptions[0]?.textContent ?? '' : el.value]));
      const selects = [...c.querySelectorAll('select')].map((el) => [el, el.style.display]);
      for (const [el] of selects) el.style.display = 'none';
      const text = c.innerText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
      for (const [el, display] of selects) el.style.display = display;
      return { title: (c.querySelector('h2, h3, summary')?.textContent ?? '').replace(/\s+/g, ' ').trim(), fields, text };
    }),
    lastMessage: toastEl && !toastEl.classList.contains('hidden') ? toastEl.textContent : null,
  };
}

/**
 * The report as an object: { format, created, note, app (version, view and anything the app adds), browser, screen,
 * journal, storage (every 'sd10.' entry of this browser's storage) }.
 */
export function buildDebugReport({ note = '', app = {} } = {}) {
  const storage = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith('sd10.') || k === JOURNAL_KEY) continue;
      const v = localStorage.getItem(k);
      try { storage[k] = JSON.parse(v); } catch { storage[k] = v; }
    }
  } catch { /* storage blocked */ }
  return {
    format: 'sd10-debug-report',
    version: 1,
    created: new Date().toISOString(),
    note,
    app: { version: APP_VERSION, url: location.href, ...Object.fromEntries(Object.entries(app).map(([k, v]) => [k, plain(v)])) },
    browser: {
      userAgent: navigator.userAgent,
      platform: navigator.userAgentData?.platform ?? navigator.platform,
      language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      viewport: `${innerWidth} × ${innerHeight}`,
      screen: `${screen.width} × ${screen.height} @${devicePixelRatio}x`,
      darkMode: matchMedia('(prefers-color-scheme: dark)').matches,
      webBluetooth: !!navigator.bluetooth,
    },
    screen: screenText(),
    journal: [...journal],
    storage,
  };
}
