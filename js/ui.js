// Small DOM and formatting helpers shared by the Console (app.js) and the Print match view (match-view.js).
import { labD50ToSrgb, rgbHex } from './color.js';

export const $ = (id) => document.getElementById(id);
/** Demo page (?demo): the Connect button drives the simulated SD-10 instead of Web Bluetooth. */
export const DEMO = new URLSearchParams(location.search).has('demo');

export function toast(msg, kind = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'fixed bottom-4 left-4 right-4 sm:left-auto z-20 sm:max-w-sm rounded-lg px-4 py-3 text-sm shadow-lg ' +
    (kind === 'error' ? 'bg-rose-600 text-white' : kind === 'ok' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-white');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 7000 : 3500);
}

export const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
export const round2 = (v) => Math.round(v * 100) / 100;
export const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** sRGB hex of a Lab D50 colour, for swatches. */
export const displayHex = (lab) => rgbHex(labD50ToSrgb(lab).rgb);
export const safeFileName = (s) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'spot';
export const NEEDS_CALIBRATION = 'Calibration needed: close the shutter, then calibrate.';

/** Save `data` as a download named `name`. */
export function downloadFile(data, type, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Run handler(file) when a file is chosen in the file input `id`; the input is reset so the same file can be chosen again. */
export function onFilePicked(id, handler) {
  $(id).onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) handler(f);
  };
}

// Remembered on/off UI choices (best effort: storage may be blocked).
export function readFlag(key) { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
export function writeFlag(key, on) { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* ignore */ } }
