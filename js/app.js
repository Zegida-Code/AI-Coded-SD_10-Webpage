// SD-10 Web Console — UI controller.
import { BleTransport } from './transport.js';
import { MockTransport, SAMPLES } from './mock.js';
import { SD10Session, DeviceError } from './session.js';
import {
  AUTO_POWER_OFF, BUZZER, DIFF_FORMULAS, EVENT, LANGUAGES, LIGHT_SOURCES, LIGHT_SOURCE_NAME, METHOD, PANEL_DIRECTION,
  WAVELENGTHS, hex,
} from './protocol.js';
import { deltaE, describeSpectrum, meanSpectrum, medianLab, spectrumToLab, wavelengthColor, labToLch, labD50ToSrgb, rgbHex } from './color.js';
import { history as historyStore, prefs as prefStore } from './storage.js';

const $ = (id) => document.getElementById(id);

const state = {
  session: null,
  transport: null,
  demo: false,
  busy: false,
  status: null,
  settings: null,
  mode: 'spot',
  last: null, // { spectrum, records, lab, ... }
  reference: null, // { spectrum, label }
  history: historyStore.load(),
  checked: new Set(),
  prefs: prefStore.load({ mFactor: 1, lightSource: 0, observer: 2, readings: 1, formula: 0, threshold: 3, patches: 6, mode: 'spot' }),
};

// ------------------------------------------------------------------ helpers
function fill(select, map) {
  select.innerHTML = Object.entries(map).map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
}

function toast(msg, kind = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'fixed bottom-4 left-4 right-4 sm:left-auto z-20 sm:max-w-sm rounded-lg px-4 py-3 text-sm shadow-lg ' +
    (kind === 'error' ? 'bg-rose-600 text-white' : kind === 'ok' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-white');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 7000 : 3500);
}

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

function settingsFromUI() {
  return {
    mFactor: +$('mMf').value, lightSource: +$('mIll').value, observer: +$('mObs').value, readings: +$('mReadings').value,
    formula: +$('mFormula').value, threshold: Math.min(Math.max(+$('mThr').value || 0, 0), 20),
    patches: Math.min(Math.max(Math.round(+$('mPatches').value || 1), 1), 18), mode: state.mode,
  };
}

function savePrefs() { state.prefs = settingsFromUI(); prefStore.save(state.prefs); }

async function task(label, fn) {
  if (state.busy) { toast('Device is busy…'); return; }
  state.busy = true;
  updateControls(label);
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    logLine('err', `${label}: ${e.message}`);
    toast(e instanceof DeviceError || e instanceof RangeError ? e.message : `${label} failed: ${e.message}`, 'error');
  } finally {
    state.busy = false;
    updateControls();
    flushStatusRefresh();
  }
}

/** A status-changed event (C4) that arrived while busy is applied once the device is idle again. */
function flushStatusRefresh() {
  if (!state.statusDirty || !state.session?.connected) return;
  state.statusDirty = false;
  state.session.getStatus().catch(() => {});
}

// ------------------------------------------------------------------ log
const logEl = $('log');
let logCount = 0;
function logLine(cls, text) {
  const t = new Date();
  const ts = `${t.toLocaleTimeString([], { hour12: false })}.${String(t.getMilliseconds()).padStart(3, '0')}`;
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = `${ts}  ${text}`;
  logEl.appendChild(line);
  if (++logCount > 3000) { logEl.firstChild.remove(); logCount--; }
  if ($('logAutoscroll').checked) logEl.scrollTop = logEl.scrollHeight;
}

function attachLog(session) {
  session.addEventListener('log', (e) => {
    const { dir, bytes, note } = e.detail;
    const isEvent = dir === 'rx' && bytes.length === 1;
    logLine(isEvent ? 'ev' : dir, `${dir === 'tx' ? 'TX →' : isEvent ? 'EV ←' : 'RX ←'}  ${hex(bytes)}${note ? '   ; ' + note : ''}`);
  });
  session.addEventListener('raw', (e) => { if ($('logRaw').checked) logLine('raw', `   chunk ← ${hex(e.detail.bytes)}`); });
}

// ------------------------------------------------------------------ connection
async function connect(demo) {
  if (state.session?.connected) return;
  state.demo = demo;
  const transport = demo ? new MockTransport() : new BleTransport({ acceptAll: $('acceptAll').checked });
  const session = new SD10Session(transport);
  state.transport = transport;
  state.session = session;
  attachLog(session);
  session.addEventListener('status', (e) => renderStatus(e.detail));
  session.addEventListener('device-event', (e) => onDeviceEvent(e.detail.code));
  session.addEventListener('disconnected', onDisconnected);
  setPill('connecting');
  logLine('raw', `--- connecting (${demo ? 'simulator' : 'Web Bluetooth'})`);
  try {
    state.busy = true;
    await session.connect();
    setPill('connected', transport.name);
    $('demoCard').classList.toggle('hidden', !demo);
    const info = await session.getInfo();
    state.info = info;
    $('devModel').textContent = info.model; $('devSerial').textContent = info.serial || '—'; $('devFw').textContent = info.firmware || '—';
    await session.getStatus();
    await loadSettings();
    await readGroups().catch((e) => logLine('err', `palettes: ${e.message}`));
    toast('Connected', 'ok');
  } catch (e) {
    console.error(e);
    logLine('err', `connect: ${e.message}`);
    if (e.name !== 'NotFoundError') toast(`Connection failed: ${e.message}`, 'error');
    try { await session.disconnect(); } catch { /* ignore */ }
    state.session = null;
    setPill('disconnected');
  } finally {
    state.busy = false;
    updateControls();
    flushStatusRefresh();
  }
}

async function disconnect() {
  if (!state.session) return;
  await state.session.disconnect().catch(() => {});
}

function onDisconnected() {
  logLine('raw', '--- disconnected');
  setPill('disconnected');
  state.session = null;
  state.status = null;
  state.busy = false;
  $('demoCard').classList.add('hidden');
  renderStatus(null);
  updateControls();
}

function setPill(kind, name = '') {
  const el = $('connPill');
  const map = {
    disconnected: ['● Disconnected', 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'],
    connecting: ['● Connecting…', 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'],
    connected: [`● ${name || 'Connected'}`, 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'],
  };
  el.textContent = map[kind][0];
  el.className = 'chip ' + map[kind][1];
}

function updateControls(busyLabel) {
  const on = !!state.session?.connected;
  const idle = on && !state.busy;
  $('btnConnect').disabled = on || state.busy;
  $('btnDemo').disabled = on || state.busy;
  $('btnDisconnect').disabled = !on;
  for (const id of ['btnRefresh', 'btnCalibrate', 'btnReloadSettings', 'btnApply', 'btnReadGroups', 'btnSyncHistory', 'btnResyncAll', 'btnMeasure']) $(id).disabled = !idle;
  $('btnWriteGroup').disabled = !idle || !state.checked.size;
  $('btnMeasure').textContent = busyLabel ? `${busyLabel}…` : measureAction() === 'calibrate' ? 'Calibrate' : 'Measure';
  $('measureHint').textContent = !on ? 'Connect a device to start.' : busyLabel ? '' : hintText();
}

function measureAction() {
  const s = state.status;
  if (!s) return 'measure';
  if (s.shutterStatus === 1) return 'calibrate';
  if (s.calibrationStatus !== 2) return 'need-calibration';
  return 'measure';
}

function hintText() {
  switch (measureAction()) {
    case 'calibrate': return 'Shutter is closed – the button runs a white calibration.';
    case 'need-calibration': return 'Calibration needed: close the shutter, then press Calibrate.';
    default:
      if (state.mode === 'compare' && !state.reference) return 'Measure a reference first, then click “Use as reference”.';
      if (state.mode === 'line') return 'Press, then drag the device across the strip.';
      return 'Ready. You can also press the button on the device.';
  }
}

// ------------------------------------------------------------------ status & settings
function renderStatus(s) {
  state.status = s;
  const chips = $('statusChips');
  const errors = $('errorList');
  if (!s) {
    chips.innerHTML = ''; errors.innerHTML = '';
    $('battBar').style.width = '0'; $('battText').textContent = '—';
    for (const id of ['devName', 'devModel', 'devSerial', 'devFw']) $(id).textContent = '—';
    return;
  }
  $('battBar').style.width = `${s.battery}%`;
  $('battBar').className = `h-full transition-all ${s.battery <= 25 ? 'bg-rose-500' : s.battery <= 50 ? 'bg-amber-500' : 'bg-emerald-500'}`;
  $('battText').textContent = `${s.battery}%${s.chargingStatus ? ' ⚡ charging' : ''}`;
  const chip = (text, good) => `<span class="chip ${good ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200' : 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'}">${text}</span>`;
  chips.innerHTML = [
    chip(s.deviceStatus === 4 ? 'Idle' : s.deviceStatus === 0 ? 'Device error' : `State ${s.deviceStatus}`, s.deviceStatus === 4),
    chip(s.calibrationStatus === 2 ? 'Calibrated' : s.calibrationStatus === 0 ? 'Needs calibration' : 'Calibration ?', s.calibrationStatus === 2),
    chip(s.shutterStatus === 1 ? 'Shutter closed' : 'Shutter open', true),
  ].join('');
  errors.innerHTML = s.errors.map((e) => `<li>⚠ ${e.text} <span class="text-slate-400">(bit ${e.bit})</span></li>`).join('');
  $('demoShutter').textContent = s.shutterStatus === 1 ? 'Open shutter' : 'Close shutter';
  updateControls();
}

async function loadSettings() {
  const s = await state.session.getSettings();
  state.settings = s;
  $('devName').textContent = s.name || '—';
  $('setName').value = s.name;
  $('setBuzzer').value = s.buzzer; $('setApo').value = s.autoPowerOff; $('setLang').value = s.language; $('setPanel').value = s.panelDirection;
}

async function applySettings(ev) {
  ev.preventDefault();
  await task('Saving settings', async () => {
    const next = { name: $('setName').value, buzzer: +$('setBuzzer').value, autoPowerOff: +$('setApo').value, language: +$('setLang').value, panelDirection: +$('setPanel').value };
    await state.session.applySettings(next, state.settings);
    await loadSettings();
    toast('Settings saved to device', 'ok');
  });
}

// ------------------------------------------------------------------ measuring
async function onMeasureButton() {
  await task('Working', async () => {
    const s = await state.session.getStatus();
    if (s.shutterStatus === 1) return doCalibrate();
    if (s.calibrationStatus !== 2) { toast('Calibration needed: close the shutter, then calibrate.', 'error'); return; }
    if (state.mode === 'line') return doLineScan();
    return doSpot();
  });
}

async function doCalibrate() {
  await state.session.calibrate();
  toast('Calibration complete', 'ok');
}

function baseSettings() {
  const p = settingsFromUI();
  return { mFactor: p.mFactor, lightSource: p.lightSource, viewingAngle: p.observer };
}

async function doSpot() {
  const p = settingsFromUI();
  const compare = state.mode === 'compare';
  if (compare && !state.reference) { toast('Set a reference colour first.', 'error'); return; }
  const settings = compare
    ? { method: METHOD.SPOT_COMPARISON, saveResult: true, ...baseSettings(), colorDiffFormula: p.formula, threshold: p.threshold }
    : { method: METHOD.SPOT, saveResult: true, ...baseSettings() };
  const spectra = [];
  let lastRec = null;
  for (let i = 0; i < p.readings; i++) {
    if (i) $('measureHint').textContent = `Reading ${i + 1} of ${p.readings}…`;
    [lastRec] = await state.session.measure(settings);
    spectra.push(lastRec.spectrum);
  }
  const spectrum = meanSpectrum(spectra);
  const lab = spectra.length > 1 ? medianLab(spectra.map((sp) => spectrumToLab(sp, p.lightSource, p.observer))) : null;
  const item = addHistory({ spectrum, labOverride: lab, mode: compare ? 'compare' : 'spot', record: lastRec, readings: spectra.length });
  showResult({ spectrum, lab, item });
}

async function doLineScan() {
  const p = settingsFromUI();
  const records = await state.session.measure({
    method: METHOD.SCAN, saveResult: false, ...baseSettings(), patchNum: p.patches, patchBorder: false, labs: [], lineNo: 1,
  });
  await state.session.notifyResult(true).catch(() => {});
  const items = records.map((r, i) => addHistory({ spectrum: r.spectrum, mode: `line #${i + 1}`, record: r }, false));
  renderHistory();
  showResult({ spectrum: records[0].spectrum, item: items[0], strip: records.map((r) => r.spectrum) });
}

async function onDeviceEvent(code) {
  if (code === EVENT.STATUS_CHANGED) {
    state.statusDirty = true;
    if (!state.busy) flushStatusRefresh();
  } else if (code === EVENT.BUTTON && !state.busy) {
    // Device button: the app reads the device's mode; group modes come from the device, otherwise use the UI mode.
    const mode = await state.session.getMode().catch(() => null);
    if (mode?.method === METHOD.CALIBRATION) return task('Calibrating', doCalibrate);
    onMeasureButton();
  }
}

// ------------------------------------------------------------------ results
function labFor(item, p = settingsFromUI()) {
  if (item.labOverride && item.lightSource === p.lightSource && item.observer === p.observer) return item.labOverride;
  return spectrumToLab(item.spectrum, p.lightSource, p.observer);
}

function showResult({ spectrum, lab, strip }) {
  const p = settingsFromUI();
  const d = describeSpectrum(spectrum, p.lightSource, p.observer);
  if (lab) { d.lab = lab; d.lch = labToLch(lab); }
  state.last = { spectrum, lab: d.lab };
  $('resultArea').classList.remove('hidden');
  $('swatch').style.background = d.hex;
  const ill = LIGHT_SOURCE_NAME[p.lightSource];
  const values = [
    ['L*', fmt(d.lab[0])], ['a*', fmt(d.lab[1])], ['b*', fmt(d.lab[2])],
    ['C*', fmt(d.lch[1])], ['h°', fmt(d.lch[2], 1)], ['LRV', fmt(d.lrv, 1)],
    ['HEX', d.hex + (d.inGamut ? '' : ' *')], ['sRGB', d.rgb.join(', ')], ['Conditions', `${ill} / ${p.observer}° · M${p.mFactor}`],
  ];
  $('resultValues').innerHTML = values.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  const verdict = $('verdict');
  const ref = state.mode === 'compare' ? state.reference : null;
  $('refBox').classList.toggle('hidden', !ref);
  if (ref) {
    const refLab = spectrumToLab(ref.spectrum, p.lightSource, p.observer);
    const dE = deltaE(refLab, d.lab, p.formula);
    const pass = dE <= p.threshold;
    $('refSwatch').style.background = describeSpectrum(ref.spectrum).hex;
    verdict.className = `mb-2 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold ${pass ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200' : 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200'}`;
    verdict.textContent = `${pass ? 'PASS' : 'FAIL'} · ${DIFF_FORMULAS[p.formula]} = ${dE.toFixed(2)} (tolerance ${p.threshold})`;
  } else verdict.className = 'hidden';

  const stripEl = $('strip');
  stripEl.classList.toggle('hidden', !strip);
  if (strip) stripEl.innerHTML = strip.map((sp, i) => `<div class="text-center"><div class="h-10 rounded border border-slate-200 dark:border-slate-700" style="background:${describeSpectrum(sp).hex}"></div><span class="text-[10px] text-slate-500">${i + 1}</span></div>`).join('');

  drawChart(spectrum, ref?.spectrum);
}

function drawChart(spectrum, refSpectrum) {
  // Size the coordinate space to the rendered width so axis labels stay readable on phones.
  const W = Math.round(Math.min(Math.max($('chart').clientWidth || 640, 300), 640));
  const H = W < 480 ? 200 : 220, L = 36, R = 8, T = 10, B = 28;
  $('chart').setAttribute('viewBox', `0 0 ${W} ${H}`);
  state.chartArgs = [spectrum, refSpectrum];
  const maxY = Math.max(1, ...spectrum, ...(refSpectrum ?? []));
  const x = (i) => L + (i / 30) * (W - L - R);
  const y = (v) => T + (1 - v / maxY) * (H - T - B);
  const path = (sp) => sp.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const stops = WAVELENGTHS.map((nm, i) => `<stop offset="${(i / 30) * 100}%" stop-color="${wavelengthColor(nm)}"/>`).join('');
  let grid = '';
  for (let v = 0; v <= maxY + 1e-9; v += maxY > 1 ? 0.5 : 0.25) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="stroke-slate-200 dark:stroke-slate-800"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="fill-slate-500" font-size="10">${(v * 100).toFixed(0)}%</text>`;
  for (let nm = 400; nm <= 700; nm += W < 480 ? 100 : 50) grid += `<text x="${x((nm - 400) / 10)}" y="${H - 8}" text-anchor="middle" class="fill-slate-500" font-size="10">${nm}</text>`;
  $('chart').innerHTML = `
    <defs><linearGradient id="spec" x1="0" x2="1">${stops}</linearGradient></defs>
    ${grid}
    <path d="${path(spectrum)} L${x(30)},${y(0)} L${x(0)},${y(0)} Z" fill="url(#spec)" opacity="0.35"/>
    <path d="${path(spectrum)}" fill="none" stroke="url(#spec)" stroke-width="2.5"/>
    ${refSpectrum ? `<path d="${path(refSpectrum)}" fill="none" class="stroke-slate-500" stroke-width="1.5" stroke-dasharray="5 4"/>` : ''}
    <text x="${W - R}" y="${T + 10}" text-anchor="end" class="fill-slate-500" font-size="10">${W < 480 ? 'nm' : 'reflectance vs wavelength (nm)'}${refSpectrum ? ' · dashed = ref' : ''}</text>`;
}

// ------------------------------------------------------------------ history
function addHistory({ spectrum, labOverride = null, mode, record, readings = 1, source = 'app' }, render = true) {
  const p = settingsFromUI();
  const item = {
    id: crypto.randomUUID(), time: (record?.date && !isNaN(record.date) ? record.date : new Date()).toISOString(), mode, source,
    spectrum: spectrum.map((v) => +v.toFixed(5)), labOverride, lightSource: p.lightSource, observer: p.observer,
    mFactor: record?.mFactor ?? p.mFactor, identifier: record?.identifier ?? null, readings,
  };
  state.history.unshift(item);
  historyStore.save(state.history);
  if (render) renderHistory();
  return item;
}

function renderHistory() {
  const p = settingsFromUI();
  $('histCount').textContent = state.history.length ? `(${state.history.length})` : '';
  $('histEmpty').classList.toggle('hidden', state.history.length > 0);
  $('histBody').innerHTML = state.history.map((it) => {
    const lab = labFor(it, p);
    const hexc = rgbHex(labD50ToSrgb(spectrumToLab(it.spectrum, 0, 2)).rgb);
    const when = new Date(it.time);
    return `<tr class="border-t border-slate-100 dark:border-slate-800" data-id="${it.id}">
      <td><input type="checkbox" data-act="check" ${state.checked.has(it.id) ? 'checked' : ''} aria-label="select"></td>
      <td class="py-1.5"><button data-act="show" class="flex items-center gap-2"><span class="h-6 w-6 rounded border border-slate-200 dark:border-slate-700" style="background:${hexc}"></span><span class="text-xs text-slate-500">${it.mode}${it.source === 'device' ? ' · device' : ''}</span></button></td>
      <td class="font-mono tabular-nums">${fmt(lab[0])}</td><td class="font-mono tabular-nums">${fmt(lab[1])}</td><td class="font-mono tabular-nums">${fmt(lab[2])}</td>
      <td class="font-mono hidden sm:table-cell">${hexc}</td>
      <td class="text-xs text-slate-500 hidden md:table-cell">${when.toLocaleString()}</td>
      <td class="text-right whitespace-nowrap"><button data-act="ref" class="text-xs text-indigo-600 hover:underline mr-2 py-1" title="Use as reference">ref</button><button data-act="del" class="text-xs text-rose-600 hover:underline py-1" title="Delete">del</button></td>
    </tr>`;
  }).join('');
  updateControls();
}

function onHistoryClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  const item = state.history.find((h) => h.id === id);
  if (!item) return;
  switch (btn.dataset.act) {
    case 'check': btn.checked ? state.checked.add(id) : state.checked.delete(id); updateControls(); break;
    case 'show': showResult({ spectrum: item.spectrum, lab: labFor(item) }); break;
    case 'ref': setReference(item.spectrum, item.mode); break;
    case 'del':
      state.history = state.history.filter((h) => h.id !== id); state.checked.delete(id);
      historyStore.save(state.history); renderHistory(); break;
  }
}

function setReference(spectrum) {
  state.reference = { spectrum };
  toast('Reference set – switch to Compare to measure against it.', 'ok');
  if (state.mode === 'compare' && state.last) showResult({ spectrum: state.last.spectrum });
  updateControls();
}

function exportCsv() {
  const p = settingsFromUI();
  const head = ['time', 'mode', 'source', 'illuminant', 'observer', 'L', 'a', 'b', 'C', 'h', 'hex', 'LRV', ...WAVELENGTHS.map((w) => `R${w}`)];
  const rows = state.history.map((it) => {
    const lab = labFor(it, p);
    const d = describeSpectrum(it.spectrum, p.lightSource, p.observer);
    const lch = labToLch(lab);
    return [it.time, it.mode, it.source, LIGHT_SOURCE_NAME[p.lightSource], p.observer, ...lab.map((v) => v.toFixed(3)), lch[1].toFixed(3), lch[2].toFixed(2), d.hex, d.lrv.toFixed(2), ...it.spectrum.map((v) => v.toFixed(5))];
  });
  const csv = [head, ...rows].map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `sd10-measurements-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Like the app's device.last_color_info_id: per-serial cursor of the newest record imported from the device.
// It starts at 0 (= everything) and only advances on imports, never on measurements taken in this app.
const cursorKey = () => `sd10.historyCursor.${state.info?.serial || 'unknown'}`;
function loadCursor() { try { return Number(localStorage.getItem(cursorKey())) || 0; } catch { return 0; } }
function saveCursor(v) { try { localStorage.setItem(cursorKey(), String(v)); } catch { /* ignore */ } }
/** Forget every device's sync position, so the next sync re-imports everything still stored on the device. */
function resetCursors() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('sd10.historyCursor.')) localStorage.removeItem(k);
  } catch { /* ignore */ }
}

function clearHistory() {
  if (!confirm('Delete all saved measurements from this browser?\n(Measurements stored on the SD-10 are not affected and can be synced again.)')) return;
  state.history = [];
  state.checked.clear();
  historyStore.save([]);
  resetCursors();
  renderHistory();
}

async function syncHistory(ev) {
  const full = ev?.shiftKey;
  await task('Syncing history', async () => {
    const from = full ? 0 : loadCursor();
    logLine('raw', `--- history sync from identifier ${from}${full ? ' (full re-import)' : ''}`);
    const records = await state.session.readHistory(from);
    const known = new Set(state.history.filter((h) => h.identifier != null).map((h) => h.identifier));
    let added = 0;
    for (const r of [...records].sort((a, b) => a.identifier - b.identifier)) {
      if (known.has(r.identifier)) continue;
      addHistory({ spectrum: r.spectrum, mode: 'spot', record: r, source: 'device' }, false);
      known.add(r.identifier);
      added++;
    }
    if (records.length) saveCursor(Math.max(from, ...records.map((r) => r.identifier)));
    renderHistory();
    toast(records.length
      ? `Device returned ${records.length} record(s); imported ${added} new` + (added < records.length ? ` (${records.length - added} already in history)` : '')
      : 'No new measurements on the device', 'ok');
  });
}

// ------------------------------------------------------------------ palettes
async function readGroups() {
  const groups = await state.session.getGroups();
  const bySlot = Object.fromEntries(groups.filter((g) => g.control === 2).map((g) => [g.slot, g]));
  $('groupList').innerHTML = [1, 2, 3, 4].map((slot) => {
    const g = bySlot[slot];
    if (!g) return `<li class="flex items-center justify-between rounded-md border border-dashed border-slate-300 dark:border-slate-700 px-3 py-2"><span class="text-slate-500">Slot ${slot} · empty</span></li>`;
    const sw = g.labs.slice(0, 12).map((lab) => `<span class="h-4 w-4 rounded-sm border border-slate-200 dark:border-slate-700" style="background:${rgbHex(labD50ToSrgb(lab).rgb)}"></span>`).join('');
    return `<li class="rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2">
      <div class="flex items-center justify-between"><span class="font-medium">Slot ${slot} · ${escapeHtml(g.name || '(unnamed)')}</span>
      <button class="text-xs text-rose-600 hover:underline" data-delslot="${slot}">delete</button></div>
      <div class="flex flex-wrap gap-1 mt-1">${sw}${g.labs.length > 12 ? `<span class="text-xs text-slate-500">+${g.labs.length - 12}</span>` : ''}</div>
      <p class="text-xs text-slate-500 mt-1">${g.labs.length} colours · ${LIGHT_SOURCE_NAME[g.lightSource] ?? g.lightSource}/${g.viewingAngle}° · M${g.mFactor} · ${DIFF_FORMULAS[g.colorDiffFormula] ?? ''} ≤ ${fmt(g.threshold, 1)}</p></li>`;
  }).join('');
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function writeGroup() {
  const items = state.history.filter((h) => state.checked.has(h.id));
  if (!items.length) return;
  if (items.length > 80) { toast('A device palette holds at most 80 colours.', 'error'); return; }
  await task('Writing palette', async () => {
    const p = settingsFromUI();
    const slot = +$('groupSlot').value;
    await state.session.setGroups([{
      control: 2, slot, hardwareId: 1 + Math.floor(Math.random() * 65534), name: $('groupName').value || `Palette ${slot}`,
      patchBorder: true, mFactor: p.mFactor, lightSource: p.lightSource, viewingAngle: p.observer, colorDiffFormula: p.formula,
      threshold: p.threshold, labs: items.map((it) => labFor(it, p)),
    }]);
    await readGroups();
    toast(`Palette written to slot ${slot}`, 'ok');
  });
}

async function deleteGroup(slot) {
  await task('Deleting palette', async () => {
    await state.session.setGroups([{ control: 1, slot }]);
    await readGroups();
  });
}

// ------------------------------------------------------------------ init
function setMode(mode) {
  state.mode = mode;
  for (const t of document.querySelectorAll('[role=tab]')) t.setAttribute('aria-selected', String(t.dataset.mode === mode));
  for (const el of document.querySelectorAll('[data-show]')) el.classList.toggle('hidden', !el.dataset.show.split(' ').includes(mode));
  savePrefs();
  updateControls();
}

function init() {
  fill($('mIll'), Object.fromEntries(Object.entries(LIGHT_SOURCES).map(([k, v]) => [v, k])));
  fill($('mFormula'), DIFF_FORMULAS);
  fill($('setBuzzer'), BUZZER); fill($('setApo'), AUTO_POWER_OFF); fill($('setLang'), LANGUAGES); fill($('setPanel'), PANEL_DIRECTION);
  fill($('demoSample'), Object.fromEntries(Object.keys(SAMPLES).map((k) => [k, k])));

  const p = state.prefs;
  $('mMf').value = p.mFactor; $('mIll').value = p.lightSource; $('mObs').value = p.observer; $('mReadings').value = p.readings;
  $('mFormula').value = p.formula; $('mThr').value = p.threshold; $('mPatches').value = p.patches;
  setMode(p.mode || 'spot');

  if (!BleTransport.supported) { $('bleWarning').classList.remove('hidden'); $('btnConnect').disabled = true; }

  $('btnConnect').onclick = () => connect(false);
  $('btnDemo').onclick = () => connect(true);
  $('btnDisconnect').onclick = disconnect;
  $('btnRefresh').onclick = () => task('Refreshing', async () => { await state.session.getStatus(); await loadSettings(); });
  $('btnCalibrate').onclick = () => task('Calibrating', doCalibrate);
  $('btnMeasure').onclick = onMeasureButton;
  $('btnReloadSettings').onclick = () => task('Loading settings', loadSettings);
  $('settingsForm').onsubmit = applySettings;
  $('btnReadGroups').onclick = () => task('Reading palettes', readGroups);
  $('btnWriteGroup').onclick = writeGroup;
  $('groupList').onclick = (e) => { const b = e.target.closest('[data-delslot]'); if (b) deleteGroup(+b.dataset.delslot); };
  $('btnSetRef').onclick = () => state.last && setReference(state.last.spectrum);
  $('histBody').onclick = onHistoryClick;
  $('btnExport').onclick = exportCsv;
  $('btnClearHistory').onclick = clearHistory;
  $('btnSyncHistory').onclick = syncHistory;
  $('btnResyncAll').onclick = () => syncHistory({ shiftKey: true });
  for (const t of document.querySelectorAll('[role=tab]')) t.onclick = () => setMode(t.dataset.mode);
  for (const id of ['mMf', 'mIll', 'mObs', 'mReadings', 'mFormula', 'mThr', 'mPatches']) {
    $(id).addEventListener('change', () => { savePrefs(); renderHistory(); if (state.last) showResult({ spectrum: state.last.spectrum }); });
  }
  $('btnClearLog').onclick = () => { logEl.innerHTML = ''; logCount = 0; };
  $('btnCopyLog').onclick = () => navigator.clipboard?.writeText(logEl.innerText).then(() => toast('Log copied'));

  $('demoSample').onchange = (e) => state.transport?.setSample?.(e.target.value);
  $('demoShutter').onclick = () => state.transport?.setShutter?.(state.status?.shutterStatus !== 1);
  $('demoButton').onclick = () => state.transport?.pressButton?.();
  $('demoDrop').onclick = () => state.transport?.dropLink?.();

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.chartArgs && drawChart(...state.chartArgs), 150);
  });
  window.addEventListener('beforeunload', () => { if (state.session?.connected) state.session.disconnect(); });
  renderHistory();
  updateControls();
}

init();
