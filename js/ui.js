// Small DOM and formatting helpers shared by the Console (app.js), Print match (match-view.js) and the Color space view
// (space-view.js).
import { labD50ToSrgb, rgbHex } from './color.js';
import { debugLog } from './debug.js';

export const $ = (id) => document.getElementById(id);
/** Demo page (?demo): the Connect button drives the simulated SD-10 instead of Web Bluetooth. */
export const DEMO = new URLSearchParams(location.search).has('demo');

export function toast(msg, kind = 'info') {
  debugLog('toast', msg, { kind });
  const el = $('toast');
  el.textContent = msg;
  el.className = 'fixed bottom-4 left-4 right-4 sm:left-auto z-20 sm:max-w-sm rounded-lg px-4 py-3 text-sm shadow-lg ' +
    (kind === 'error' ? 'bg-rose-600 text-white' : kind === 'ok' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-white');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 7000 : 3500);
}

export const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
export const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
/** L*a*b* as short text: "L 40.8 a 52.7 b 27.6". */
export const labText = (lab) => `L ${fmt1(lab[0])} a ${fmt1(lab[1])} b ${fmt1(lab[2])}`;
/** A sheet type's input values as [label, text] pairs (CMYK with its K, RGB with its hex). */
export function formatValues(mode, x, k) {
  if (mode === 'cmyk') return [['C', fmt1(x[0])], ['M', fmt1(x[1])], ['Y', fmt1(x[2])], ['K', fmt1(k)]];
  if (mode === 'rgb') return [['R', String(x[0])], ['G', String(x[1])], ['B', String(x[2])], ['HEX', rgbHex(x)]];
  return [['L*', fmt1(x[0])], ['a*', fmt1(x[1])], ['b*', fmt1(x[2])]];
}
/** …as one line: "L* 34.7 a* 71.3 b* 46.7", "C 40.0 M 60.0 Y 10.0 K 5.0", "R 12 G 34 B 56". */
export const valuesText = (mode, x, k) => formatValues(mode, x, k).filter(([key]) => key !== 'HEX').map(([key, v]) => `${key} ${v}`).join(' ');
export const round2 = (v) => Math.round(v * 100) / 100;
export const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** sRGB hex of a Lab D50 color, for swatches. */
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
