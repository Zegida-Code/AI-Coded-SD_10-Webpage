// SD-10 Web Console — UI controller.
import { BleTransport } from './transport.js';
import { MockTransport, SAMPLES } from './mock.js';
import { SD10Session, DeviceError } from './session.js';
import {
  AUTO_POWER_OFF, BUZZER, DIFF_FORMULAS, EVENT, LANGUAGES, LIGHT_SOURCES, LIGHT_SOURCE_NAME, METHOD, PANEL_DIRECTION,
  WAVELENGTHS, hex,
} from './protocol.js';
import { deltaE, deltaE2000, describeSpectrum, meanSpectrum, medianLab, spectrumToLab, wavelengthColor, labToLch, labD50ToSrgb, rgbHex, srgbToLabD50 } from './color.js';
import { history as historyStore, prefs as prefStore } from './storage.js';
import { CMYK_PROFILES, CUSTOM_PREFIX, PRINTER_PREFIX, customProfiles, loadProfile, printerProfiles } from './icc.js';
import { DESIGNS, DE_FORMULAS, MEDIA, MODES, analyseRound, averageReadings, buildSheetPdf, buildSheetPng, designPatches, metamerism, nextStep, patchSpotName, sheetLayout } from './match.js';
import { RIP_EXPORTS, readLibrary } from './rip-export.js';
import { printSpectrum } from './printer-sim.js';

const $ = (id) => document.getElementById(id);
/** Demo page (?demo): the Connect button drives the simulated SD-10 instead of Web Bluetooth. */
const DEMO = new URLSearchParams(location.search).has('demo');

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
  prefs: prefStore.load({ mFactor: 1, lightSource: 0, observer: 2, readings: 1, formula: 0, threshold: 1, patches: 6, mode: 'spot', cmykProfile: 'EpsonWideCMYK_Ver2', cmykIntent: 0 }),
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
    // the profile list is filled asynchronously (custom profiles live in IndexedDB): keep the saved choice until then
    cmykProfile: ($('cmykProfile').options.length && $('cmykProfile').value) || state.prefs.cmykProfile || 'EpsonWideCMYK_Ver2',
    cmykIntent: +$('cmykIntent').value || 0,
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
  $('logCount').textContent = `(${logCount})`;
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
  $('btnConnectMenu').disabled = on || state.busy || !BleTransport.supported;
  if (DEMO) $('btnConnect').disabled = on || state.busy; // the simulator works without Web Bluetooth
  $('btnDisconnect').disabled = !on;
  for (const id of ['btnRefresh', 'btnCalibrate', 'btnReloadSettings', 'btnApply', 'btnReadGroups', 'btnSyncHistory', 'btnResyncAll', 'btnMeasure']) $(id).disabled = !idle;
  $('btnWriteGroup').disabled = !idle || !state.checked.size;
  $('btnMeasure').textContent = busyLabel ? `${busyLabel}…` : measureAction() === 'calibrate' ? 'Calibrate' : 'Measure';
  $('measureHint').textContent = !on ? 'Connect a device to start.' : busyLabel ? '' : hintText();
  matchControls(busyLabel);
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
      if (state.mode === 'compare' && !state.reference) return 'No reference yet – this measurement will become the reference.';
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
  // In Compare mode without a reference, this measurement becomes the reference (measured as a plain spot).
  const capturingReference = state.mode === 'compare' && !state.reference;
  const compare = state.mode === 'compare' && !capturingReference;
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
  const item = addHistory({ spectrum, labOverride: lab, mode: capturingReference ? 'reference' : compare ? 'compare' : 'spot', record: lastRec, readings: spectra.length });
  if (capturingReference) {
    state.reference = { spectrum, id: item.id };
    renderHistory();
    showResult({ spectrum, lab, item });
    toast('Reference captured – now measure the sample to compare against it.', 'ok');
    return;
  }
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
  } else if (code === EVENT.BUTTON && !state.busy && state.view === 'match') {
    // In the Print match view the device button measures the next patch (or the reference if no sheet yet).
    if (sheetPatches().length) measurePatch(); else measureMatchTarget();
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

function showResult({ spectrum, lab, strip, item }) {
  const p = settingsFromUI();
  const d = describeSpectrum(spectrum, p.lightSource, p.observer);
  if (lab) { d.lab = lab; d.lch = labToLch(lab); }
  state.last = { spectrum, lab: d.lab, d, strip, itemId: item?.id ?? null };
  state.lastLabD50 = spectrumToLab(spectrum, 0, 2); // newest colour on screen, for "Use last measurement" in Print match
  state.lastSpectrum = spectrum;
  $('resultArea').classList.remove('hidden');
  $('swatch').style.background = d.hex;
  $('swatch').title = d.hex;
  $('swatchHex').textContent = d.hex;

  const ill = LIGHT_SOURCE_NAME[p.lightSource];
  const chip = (t) => `<span class="chip bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">${t}</span>`;
  $('conditions').innerHTML = [chip(`${ill} · ${p.observer}°`), chip(`M${p.mFactor}`), p.readings > 1 && state.mode !== 'line' ? chip(`median of ${p.readings}`) : '']
    .join('');

  renderValues(d, null);
  updateCmyk(spectrum);

  const verdict = $('verdict');
  const ref = state.mode === 'compare' ? state.reference : null;
  $('refBox').classList.toggle('hidden', !ref);
  if (ref) {
    const refLab = spectrumToLab(ref.spectrum, p.lightSource, p.observer);
    const dE = deltaE(refLab, d.lab, p.formula);
    const pass = dE <= p.threshold;
    const refHex = describeSpectrum(ref.spectrum).hex;
    $('refSwatch').style.background = refHex;
    $('refSwatch').title = refHex;
    $('refHex').textContent = refHex;
    verdict.className = `flex items-center gap-3 rounded-xl px-3 py-2 ${pass ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200' : 'bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-200'}`;
    verdict.innerHTML = `<span class="rounded-md px-2 py-0.5 text-xs font-bold tracking-wide text-white ${pass ? 'bg-emerald-600' : 'bg-rose-600'}">${pass ? 'PASS' : 'FAIL'}</span>
      <span class="text-2xl font-semibold tabular-nums leading-none">${dE.toFixed(2)}</span>
      <span class="text-xs leading-tight">${DIFF_FORMULAS[p.formula]}<br><span class="opacity-75">tolerance ${p.threshold}</span></span>`;
  } else verdict.className = 'hidden';

  const stripEl = $('strip');
  stripEl.classList.toggle('hidden', !strip);
  if (strip) stripEl.innerHTML = strip.map((sp, i) => `<div class="text-center"><div class="h-10 rounded-md ring-1 ring-black/10 dark:ring-white/10" style="background:${describeSpectrum(sp).hex}"></div><span class="text-[10px] text-slate-500">${i + 1}</span></div>`).join('');

  drawChart(spectrum, ref?.spectrum);
}

/** One row of the values table: label + labelled numbers. */
function valueRow(label, items, extra = '') {
  // Every row uses the same 4-column grid so numbers line up down the table (CMYK fills all 4).
  const cells = items.map(([k, v, span]) => `<div class="min-w-0 ${span ? 'col-span-' + span : ''}"><div class="text-[10px] tracking-wide text-slate-500">${k}</div><div class="font-mono text-sm tabular-nums truncate">${v}</div></div>`).join('');
  return `<div class="grid grid-cols-[3.75rem,1fr] sm:grid-cols-[5rem,1fr] items-center gap-2 px-3 py-2">
    <div class="text-xs font-medium text-slate-500">${label}</div>
    <div class="grid grid-cols-4 gap-x-3 items-end">${cells}${extra}</div></div>`;
}

function renderValues(d, cmyk) {
  const cmykItems = cmyk?.values
    ? [['C', fmt(cmyk.values[0], 1)], ['M', fmt(cmyk.values[1], 1)], ['Y', fmt(cmyk.values[2], 1)], ['K', fmt(cmyk.values[3], 1)]]
    : [['', cmyk?.error ? `<span class="text-rose-600 text-xs">${escapeHtml(cmyk.error)}</span>` : '<span class="text-slate-400 text-xs">computing…</span>', 4]];
  const copyBtn = `<button data-copy="${d.hex}" class="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">copy</button>`;
  $('resultValues').innerHTML = [
    valueRow('CIE Lab', [['L*', fmt(d.lab[0])], ['a*', fmt(d.lab[1])], ['b*', fmt(d.lab[2])]]),
    valueRow('LCh', [['L*', fmt(d.lch[0])], ['C*', fmt(d.lch[1])], ['h°', fmt(d.lch[2], 1)]]),
    valueRow('HEX', [['sRGB', `<span class="inline-flex items-center gap-1.5"><span class="h-3 w-3 rounded-sm ring-1 ring-black/10" style="background:${d.hex}"></span>${d.hex}</span>`, 2]],
      `<div class="col-span-2 flex items-center gap-3 pb-0.5">${copyBtn}${d.inGamut ? '' : '<span class="text-[11px] text-amber-600" title="Outside the sRGB gamut – clipped">out of gamut</span>'}</div>`),
    valueRow('RGB', [['R', d.rgb[0]], ['G', d.rgb[1]], ['B', d.rgb[2]]]),
    valueRow('CMYK', cmykItems),
    valueRow('LRV', [['D65 · 10°', fmt(d.lrv, 1), 2]]),
  ].join('');
}

/** CMYK through the selected ICC profile, from Lab D50/2° as the app does (P0.a.a()). */
async function updateCmyk(spectrum) {
  const p = settingsFromUI();
  const token = (updateCmyk.token = (updateCmyk.token || 0) + 1);
  let cmyk;
  try {
    const profile = await loadProfile(p.cmykProfile);
    cmyk = { values: profile.fromLab(spectrumToLab(spectrum, 0, 2), p.cmykIntent) };
  } catch (e) {
    cmyk = { error: e.message };
  }
  if (token !== updateCmyk.token || !state.last || state.last.spectrum !== spectrum) return;
  state.last.cmyk = cmyk;
  renderValues(state.last.d, cmyk);
}

function copyValues() {
  const l = state.last;
  if (!l) return;
  const p = settingsFromUI();
  const c = l.cmyk?.values;
  const text = [
    `Conditions: ${LIGHT_SOURCE_NAME[p.lightSource]} / ${p.observer}° / M${p.mFactor}`,
    `L*a*b*: ${l.d.lab.map((v) => v.toFixed(2)).join(', ')}`,
    `LCh: ${l.d.lch[0].toFixed(2)}, ${l.d.lch[1].toFixed(2)}, ${l.d.lch[2].toFixed(1)}`,
    `HEX: ${l.d.hex}`, `RGB: ${l.d.rgb.join(', ')}`,
    c ? `CMYK (${p.cmykProfile.replace(CUSTOM_PREFIX, '')}): ${c.map((v) => v.toFixed(1)).join(', ')}` : '',
    `LRV: ${l.d.lrv.toFixed(1)}`,
  ].filter(Boolean).join('\n');
  navigator.clipboard?.writeText(text).then(() => toast('Values copied', 'ok'), () => toast('Clipboard not available', 'error'));
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
      <td class="py-1.5"><button data-act="show" class="flex items-center gap-2"><span class="h-6 w-6 rounded border border-slate-200 dark:border-slate-700" style="background:${hexc}"></span><span class="text-xs text-slate-500">${it.mode}${it.source === 'device' ? ' · device' : ''}</span>${state.reference?.id === it.id ? '<span class="chip bg-indigo-600 text-white !px-1.5 !py-0 text-[10px]" title="Current comparison reference">REF</span>' : ''}</button></td>
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
    case 'show': showResult({ spectrum: item.spectrum, lab: labFor(item), item }); break;
    case 'ref': setReference(item.spectrum, { id: item.id, compareCurrent: true }); break;
    case 'del':
      state.history = state.history.filter((h) => h.id !== id); state.checked.delete(id);
      historyStore.save(state.history); renderHistory(); break;
  }
}

/**
 * Make this colour the comparison reference and switch to the Compare tab.
 * compareCurrent: re-compare the sample currently on screen against the new reference (used from History).
 */
function setReference(spectrum, { id = null, compareCurrent = false } = {}) {
  state.reference = { spectrum, id };
  setMode('compare');
  renderHistory();
  const sample = compareCurrent && state.last && state.last.spectrum !== spectrum && state.last.itemId !== id ? state.last : null;
  if (sample) {
    showResult({ spectrum: sample.spectrum, strip: sample.strip, item: { id: sample.itemId } });
    toast('Reference changed – the current sample is now compared against it.', 'ok');
  } else {
    showResult({ spectrum, item: id ? { id } : undefined });
    toast('Reference set – measure a sample to compare against it.', 'ok');
  }
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

// ================================================================== Print match view
// Persisted job (localStorage 'sd10.match'):
//   settings: mode, media ('a4' … | 'custom'), mediaW/mediaH (mm), patchMm, design ('full' | 'compact'), mf, tol, reads, ripFormat
//   formula (DE_FORMULAS key), printerProfile (name of a stored printer profile for the gamut check, '' = none)
//   colours: [{ id, name, target, targetSpectrum, refReads, refSpectra, accepted,
//               rounds: [{ round, sheet, mode, centre, step, kFixed, design,
//                          patches: [{ n, offset, x, name?, reads, spectra, lab, spread, spectrum }], result }] }]
//   active (index of the colour being edited), sheet (number of the current sheet), jobId, next ({ c: colour id, i: patch index })
// Every sheet holds the latest round of each colour still being matched; each colour keeps its own model and rounds.
const MATCH_KEY = 'sd10.match';
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const newColour = () => ({ id: newId(), name: '', target: null, targetSpectrum: null, refReads: [], refSpectra: [], accepted: false, rounds: [] });
const match = (() => {
  let m = {};
  try { m = JSON.parse(localStorage.getItem(MATCH_KEY)) || {}; } catch { /* ignore */ }
  if (!m.colours && (m.target || m.rounds?.length)) {
    // single-colour job saved by an earlier version: becomes the first colour
    const id = newId();
    m.colours = [{ id, name: m.spotName ?? '', target: m.target ?? null, refReads: m.refReads ?? [], accepted: false,
      rounds: (m.rounds ?? []).map((r) => ({ ...r, sheet: r.round })) }];
    m.sheet = m.rounds?.length ? m.rounds[m.rounds.length - 1].round : 0;
    m.next = { c: id, i: m.next ?? 0 };
    if (m.paper) m.media = m.paper;
    for (const k of ['target', 'rounds', 'spotName', 'refReads', 'paper']) delete m[k];
  }
  const out = { mode: 'spot', media: 'a4', mediaW: 210, mediaH: 297, patchMm: 20, design: 'full', mf: 1, tol: 1, reads: 1,
    formula: 'de00', printerProfile: '', ripFormat: 'cxf', jobId: null, colours: [], active: 0, sheet: 0, next: null, ...m };
  if (!out.colours.length) out.colours = [newColour()];
  return out;
})();
// Spot library: { name, colours: [{ name, lab, target, predictedDeltaE, mf, time }] } – independent of the current job.
const LIB_KEY = 'sd10.spotLibrary';
const spotLib = (() => {
  let l = {};
  try { l = JSON.parse(localStorage.getItem(LIB_KEY)) || {}; } catch { /* ignore */ }
  return { name: 'SD-10 spot colours', colours: [], ...l };
})();
const saveLib = () => { try { localStorage.setItem(LIB_KEY, JSON.stringify(spotLib)); } catch { /* ignore */ } };
const saveMatch = () => { try { localStorage.setItem(MATCH_KEY, JSON.stringify(match)); } catch { /* ignore */ } };
const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

const activeColour = () => match.colours[match.active] ?? match.colours[0];
/** The colour difference formula chosen for judging matches: { label, name, fn(ref, sample), lWeight }. */
const DE = () => DE_FORMULAS[match.formula] ?? DE_FORMULAS.de00;
const roundSpectrum = (s) => s.map((v) => Math.round(v * 1e5) / 1e5);

// ---- gamut check against the printer profile (computed asynchronously, cached per profile and reference)
const gamutCache = new Map();
let gamutBusy = false;
const gamutKey = (c) => `${match.printerProfile}|${c.target.join()}`;
const gamutFor = (c) => (match.printerProfile && c.target ? gamutCache.get(gamutKey(c)) ?? null : null);
/** 'inside' (profile round trip ≤ 1.5), 'edge' (≤ 3) or 'outside'. */
const gamutClass = (g) => (!g || g.error ? null : g.dE <= 1.5 ? 'inside' : g.dE <= 3 ? 'edge' : 'outside');
async function updateGamut() {
  if (!match.printerProfile || gamutBusy) return;
  const need = match.colours.filter((c) => c.target && !gamutCache.has(gamutKey(c)));
  if (!need.length) return;
  gamutBusy = true;
  try {
    const profile = await loadProfile(PRINTER_PREFIX + match.printerProfile);
    for (const c of need) gamutCache.set(gamutKey(c), profile.gamut(c.target));
  } catch (e) {
    for (const c of need) gamutCache.set(gamutKey(c), { error: e.message });
  }
  gamutBusy = false;
  renderMatch();
}
function gamutHtml(c) {
  if (!c.target) return '';
  if (!match.printerProfile) return '<span class="text-slate-500">Add your printer / media ICC profile below to check whether this colour is printable.</span>';
  const g = gamutFor(c);
  if (!g) return '<span class="text-slate-500">Checking the printer gamut…</span>';
  if (g.error) return `<span class="text-rose-600">Gamut check failed: ${escapeHtml(g.error)}</span>`;
  const closest = `<span class="font-mono">L ${fmt1(g.closest[0])} a ${fmt1(g.closest[1])} b ${fmt1(g.closest[2])}</span>`;
  return {
    inside: `<span class="text-emerald-600">Inside the printer gamut</span> <span class="text-slate-500">(profile round trip ΔE00 ${g.dE.toFixed(2)})</span>`,
    edge: `<span class="text-amber-600">At the edge of the printer gamut – the closest printable colour is ${closest}, ΔE00 ${g.dE.toFixed(2)} away.</span>`,
    outside: `<span class="text-rose-600"><b>Outside the printer gamut.</b> The closest printable colour is ${closest}, ΔE00 ${g.dE.toFixed(2)} away – no amount of matching gets much closer with this printer, ink and media.</span>`,
  }[gamutClass(g)];
}
const latest = (c) => c.rounds[c.rounds.length - 1] ?? null;
const colourLabel = (c) => c.name || `Colour ${match.colours.indexOf(c) + 1}`;
/** Colours on the current sheet, each with its round on that sheet. */
const sheetItems = () => (match.sheet ? match.colours.map((c) => ({ c, r: latest(c) })).filter(({ r }) => r && r.sheet === match.sheet) : []);
/** All patches of the current sheet in scan order: [{ c, r, p, i }]. */
const sheetPatches = () => sheetItems().flatMap(({ c, r }) => r.patches.map((p, i) => ({ c, r, p, i })));
function nextIndex(all = sheetPatches()) {
  const k = all.findIndex((e) => e.c.id === match.next?.c && e.i === match.next?.i);
  return k >= 0 ? k : Math.max(0, all.findIndex((e) => !e.p.lab));
}
const mediaMm = () => (match.media === 'custom' ? [match.mediaW, match.mediaH] : MEDIA[match.media] ?? MEDIA.a4);
const mediaName = () => (match.media === 'custom' ? `${match.mediaW} × ${match.mediaH} mm` : { a4: 'A4', letter: 'Letter', a3: 'A3', tabloid: 'Tabloid' }[match.media] ?? 'A4');

// Print match is a desktop / tablet workflow (PDFs, spot libraries, RIP software): phones only get the Console.
const WIDE = window.matchMedia('(min-width: 768px)');

function setView(view) {
  state.view = view === 'match' && WIDE.matches ? 'match' : 'console';
  $('viewConsole').classList.toggle('hidden', state.view !== 'console');
  $('viewMatch').classList.toggle('hidden', state.view !== 'match');
  for (const b of document.querySelectorAll('[data-view]')) {
    if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  const hash = state.view === 'match' ? '#match' : '';
  if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
  if (state.view === 'match') renderMatch();
}

function displayHex(lab) { return rgbHex(labD50ToSrgb(lab).rgb); }
function cmykPreviewHex([c, m, y], k) {
  const ch = (v) => Math.round(255 * (1 - v / 100) * (1 - k / 100));
  return rgbHex([ch(c), ch(m), ch(y)]);
}
function formatValues(mode, x, k) {
  if (mode === 'cmyk') return [['C', fmt1(x[0])], ['M', fmt1(x[1])], ['Y', fmt1(x[2])], ['K', fmt1(k)]];
  if (mode === 'rgb') return [['R', String(x[0])], ['G', String(x[1])], ['B', String(x[2])], ['HEX', rgbHex(x)]];
  return [['L*', fmt1(x[0])], ['a*', fmt1(x[1])], ['b*', fmt1(x[2])]];
}
function patchPreviewHex(mode, x, k) {
  return mode === 'cmyk' ? cmykPreviewHex(x, k) : mode === 'rgb' ? rgbHex(x) : displayHex(x);
}
const isLabMode = (mode) => mode === 'spot' || mode === 'lab';
const MODE_NAME = { spot: 'named spot colour', lab: 'L*a*b*', cmyk: 'CMYK', rgb: 'RGB' };
const newJobId = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

function modeHelp(mode) {
  const profile = escapeHtml(settingsFromUI().cmykProfile.replace(CUSTOM_PREFIX, ''));
  return {
    spot: 'For RIPs and workflows that colour named spot colours from an L*a*b* library. Every patch is a uniquely named spot colour with its L*a*b* value as the alternate, so the RIP handles the sheet like the spot colours in your artwork. Enter the result as the L*a*b* value of your named colour in the RIP.',
    lab: 'Patches are plain CIE L*a*b* objects. This only matches a spot colour workflow if the RIP converts Lab objects with the same profile and rendering intent as named colours – otherwise use spot colours.',
    cmyk: `For documents that send CMYK numbers to the printer. The starting values come from the CMYK profile selected in the Console (${profile}); K is kept fixed.`,
    rgb: 'For software that only accepts raster images. The sheet is an sRGB PNG and the result is an sRGB value / hex for your artwork – keep the artwork in sRGB like the sheet.',
  }[mode] + ' Colours are measured at D50 / 2°. Several colours can be matched on the same sheets; 8 patches per colour need less media, 16 are more robust on noisy or uneven prints.';
}

function printTips(mode) {
  const tips = ['<b>Print it exactly like the final job:</b> same printer, media, quality and colour settings, at 100% / actual size (not "fit to page"). Let the ink dry before scanning.',
    '<b>Transferred, cured or finished prints:</b> process the sheet exactly like production (pressing, curing, laminating …) and scan the finished product, not the raw print. On textured or uneven surfaces use 3 or more readings per patch.',
    '<b>Patch size:</b> each patch must cover the SD-10’s whole measuring area with some room to spare – if readings of the same patch jump around, use larger patches.'];
  if (mode === 'spot') tips.push('<b>Spot library:</b> if your RIP imports spot colour libraries (CxF3 is the common standard; Adobe Color Book, Edge Print and VersaWorks files are also offered), import the sheet library and enable it before printing, so the patches take the named-colour path. Otherwise unknown spot colours normally print from their L*a*b* alternate – check that the RIP does not substitute or reject them.');
  if (mode === 'rgb') tips.push('<b>Substrate:</b> print on the same substrate colour, with the same underlayers or pre-treatment, as the final job.');
  return tips.map((t) => `<p>${t}</p>`).join('');
}

function matchControls(busyLabel) {
  if (!$('btnMatchMeasure')) return;
  const on = !!state.session?.connected, idle = on && !state.busy;
  const all = sheetPatches();
  const e = all[nextIndex(all)];
  const c = activeColour();
  $('btnMatchTarget').disabled = !idle;
  $('btnMatchUseLast').disabled = !(state.lastLabD50 || state.last) || state.busy;
  $('btnMatchSheet').disabled = !match.colours.some((x) => x.target) || state.busy;
  $('btnMatchMeasure').disabled = !idle || !all.length;
  $('btnMatchAnalyse').disabled = state.busy || !sheetItems().some(({ r }) => r.patches.filter((p) => p.lab).length >= 5);
  $('btnMatchRefine').disabled = state.busy || !match.colours.some((x) => x.target && !x.accepted);
  const reading = (n) => (match.reads > 1 ? ` (reading ${n + 1}/${match.reads})` : '');
  $('btnMatchMeasure').textContent = busyLabel ? `${busyLabel}…`
    : !e ? 'Measure patch' : `Measure patch #${e.p.n}${match.colours.length > 1 ? ` – ${colourLabel(e.c)}` : ''}${reading(e.p.lab ? 0 : e.p.reads?.length ?? 0)}`;
  $('btnMatchTarget').textContent = `Measure reference${c.refReads.length ? reading(c.refReads.length) : ''}`;
}

function colourStatus(c) {
  if (!c.target) return 'no reference yet';
  if (c.accepted) return 'accepted';
  const r = latest(c);
  if (!r) return match.sheet ? 'joins the next sheet' : 'ready';
  if (r.result) return `round ${r.round} · predicted ${DE().label} ${r.result.predictedDeltaE.toFixed(2)}`;
  return r.sheet === match.sheet ? `round ${r.round} · scanning` : `round ${r.round}`;
}

function renderMatch() {
  const c = activeColour();
  const t = c.target;
  // colour list
  $('mColourCount').textContent = match.colours.length > 1 ? `(${match.colours.length})` : '';
  $('mColourList').innerHTML = match.colours.map((x, i) => `<li data-colour="${i}" class="flex items-center gap-2 rounded-lg px-2 py-1.5 ring-1 ${i === match.active ? 'ring-2 ring-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30' : 'ring-slate-200 dark:ring-slate-800'}">
      <button type="button" data-colour-act="select" class="flex flex-1 min-w-0 items-center gap-2 text-left">
        <span class="h-6 w-6 flex-none rounded ring-1 ring-black/10 ${x.target ? '' : 'bg-slate-200 dark:bg-slate-700'}" ${x.target ? `style="background:${displayHex(x.target)}"` : ''}></span>
        <span class="font-medium truncate">${escapeHtml(colourLabel(x))}</span>
        <span class="text-xs font-mono text-slate-500 hidden sm:inline">${x.target ? x.target.map((v) => v.toFixed(1)).join(' / ') : ''}</span>
        ${gamutClass(gamutFor(x)) === 'outside' ? '<span class="chip bg-rose-600 text-white !px-1.5 !py-0 text-[10px]" title="Outside the printer gamut">OUT OF GAMUT</span>' : ''}
        <span class="ml-auto text-xs ${x.accepted ? 'text-emerald-600' : 'text-slate-500'} whitespace-nowrap">${colourStatus(x)}</span></button>
      ${match.colours.length > 1 ? '<button type="button" data-colour-act="remove" class="text-xs text-rose-600 hover:underline px-1" title="Remove this colour">remove</button>' : ''}</li>`).join('');
  // editor for the selected colour
  for (const [id, i] of [['mL', 0], ['mA', 1], ['mB', 2]]) if (document.activeElement !== $(id)) $(id).value = t ? t[i].toFixed(2) : '';
  if (document.activeElement !== $('mSpotName')) $('mSpotName').value = c.name;
  $('mTargetSwatch').style.background = t ? displayHex(t) : '';
  $('mStatusTarget').textContent = c.refReads.length ? `– reading ${c.refReads.length}/${match.reads}, measure another spot` : t ? `– ${displayHex(t)}` : '– not set';
  $('mGamut').innerHTML = gamutHtml(c);
  $('matchFormula').value = match.formula in DE_FORMULAS ? match.formula : 'de00';
  $('mPrinterProfile').value = match.printerProfile;
  $('btnPrinterIccRemove').classList.toggle('hidden', !match.printerProfile);
  // settings
  $('mMode').value = match.mode; $('mPaper').value = match.media; $('matchMf').value = match.mf; $('mTol').value = match.tol;
  $('mReads').value = match.reads; $('mPatchMm').value = match.patchMm; $('mDesign').value = match.design;
  $('mCustomWrap').classList.toggle('hidden', match.media !== 'custom');
  if (document.activeElement !== $('mMediaW')) $('mMediaW').value = match.mediaW;
  if (document.activeElement !== $('mMediaH')) $('mMediaH').value = match.mediaH;
  $('mRipFormatWrap').classList.toggle('hidden', !isLabMode(match.mode));
  if (!RIP_EXPORTS[match.ripFormat]) match.ripFormat = 'cxf';
  $('mRipFormat').value = match.ripFormat;
  const fmtLabel = ` (${RIP_EXPORTS[match.ripFormat].label})`;
  $('btnMatchRipSheet').textContent = `Sheet library${fmtLabel}`;
  $('btnLibDownload').textContent = `Download library${fmtLabel}`;
  $('mModeHelp').innerHTML = modeHelp(match.mode);
  $('mPrintTips').innerHTML = printTips(match.mode);

  // sheet
  const items = sheetItems();
  const all = sheetPatches();
  const per = DESIGNS[match.design] ?? 16;
  const ready = match.colours.filter((x) => x.target);
  $('mRoundLabel').textContent = match.sheet ? `· sheet ${match.sheet}` : '';
  $('btnMatchSheet').textContent = match.sheet ? 'New first sheet' : 'Create sheet';
  $('mSheetActions').classList.toggle('hidden', !items.length);
  $('btnMatchPdf').textContent = `${match.mode === 'rgb' ? 'Download PNG' : 'Download PDF'}${items.length > 1 ? 's' : ''}`;
  $('btnMatchRipSheet').classList.toggle('hidden', !items.some(({ r }) => r.mode === 'spot'));
  if (!ready.length) $('mSheetInfo').textContent = 'Set a reference colour first.';
  else if (!items.length) $('mSheetInfo').textContent = `Creates a sheet with ${per} ${MODE_NAME[match.mode]} patches for each of the ${ready.length} colour(s) with a reference (${ready.length * per} patches), around a first estimate of each reference.`;
  else {
    let pages = '';
    try {
      const n = sheetGroups().reduce((s, g) => s + sheetLayout({ mode: match.mode, groups: [g], round: match.sheet, media: mediaMm(), patchMm: match.patchMm }).pages.length, 0);
      pages = ` · ${items.length > 1 ? `one ${match.mode === 'rgb' ? 'image set' : 'PDF'} per colour, ` : ''}${n} page${n > 1 ? 's' : ''} of ${mediaName()} with ${match.patchMm} mm patches`;
    } catch (e) { pages = ` · <span class="text-rose-600">${escapeHtml(e.message)}</span>`; }
    const lines = items.map(({ c: x, r }) => {
      const vals = formatValues(r.mode, r.centre, r.kFixed).map(([k, v]) => `${k} ${v}`).join('  ');
      const steps = r.step.map((v, k) => `${MODES[r.mode].axes[k]} ±${fmt1(v)}`).join(', ');
      return `<li><b>${escapeHtml(colourLabel(x))}</b> (round ${r.round}): centre <span class="font-mono">${vals}</span> · steps ${steps}</li>`;
    }).join('');
    $('mSheetInfo').innerHTML = `${items.length} colour${items.length > 1 ? 's' : ''} · ${all.length} patches${pages}. Download, print and scan the patches below.
      <ul class="mt-1 text-xs space-y-0.5">${lines}</ul>` +
      (items.some(({ r }) => r.mode === 'spot') ? `<p class="text-xs mt-1">Spot names <span class="font-mono">${escapeHtml(all[0].p.name ?? '')}</span> … <span class="font-mono">${escapeHtml(all[all.length - 1].p.name ?? '')}</span>.</p>` : '');
  }

  // patch grid, grouped by colour
  const grid = $('mPatchGrid');
  if (!all.length) grid.innerHTML = '<p class="text-sm text-slate-500">No sheet yet.</p>';
  else {
    const nx = nextIndex(all);
    let k = 0;
    grid.innerHTML = items.map(({ c: x, r }) => `<div>
      ${items.length > 1 ? `<div class="flex items-center gap-2 text-xs font-medium mb-1"><span class="h-3 w-3 rounded-sm ring-1 ring-black/10" style="background:${displayHex(x.target)}"></span>${escapeHtml(colourLabel(x))} <span class="text-slate-500 font-normal">round ${r.round}</span></div>` : ''}
      <div class="grid grid-cols-4 sm:grid-cols-8 gap-2">${r.patches.map((p) => {
        const idx = k++;
        const done = !!p.lab;
        const bg = done ? displayHex(p.lab) : patchPreviewHex(r.mode, p.x, r.kFixed);
        const dE = done && x.target ? DE().fn(x.target, p.lab) : null;
        const partial = !done && p.reads?.length ? `${p.reads.length}/${match.reads}` : '';
        const uneven = done && p.spread > 1.5; // readings disagree – textured / uneven print
        const title = `Patch #${p.n} · ${colourLabel(x)}${p.name ? ' · ' + p.name : ''}${done && p.spread != null && p.reads?.length > 1 ? ` · ${p.reads.length} readings, spread ΔE00 ${p.spread.toFixed(2)}` : ''}${done ? ' – tap to re-measure' : ''}`;
        return `<button type="button" data-patch="${idx}" class="text-left rounded-lg p-1.5 ring-1 ${idx === nx ? 'ring-2 ring-indigo-500' : 'ring-slate-200 dark:ring-slate-800'}" title="${escapeHtml(title)}">
          <div class="h-10 rounded-md ${done ? '' : 'opacity-40'}" style="background:${bg}"></div>
          <div class="flex justify-between text-[11px] mt-1"><b>#${p.n}${uneven ? ' <span class="text-amber-600" title="Readings differ by more than 1.5 ΔE00">!</span>' : ''}</b><span class="font-mono ${dE != null && dE <= match.tol ? 'text-emerald-600' : 'text-slate-500'}">${dE != null ? 'ΔE ' + dE.toFixed(1) : partial}</span></div>
        </button>`;
      }).join('')}</div></div>`).join('');
  }
  $('mProgress').textContent = all.length ? `${all.filter((e) => e.p.lab).length} / ${all.length} measured` : '';
  renderMatchResult();
  renderLibrary();
  updateControls();
  updateGamut();
}

/** How the best printed patch holds up under other lights, from the measured spectra. */
function metamerismHtml(c, r) {
  const res = r.result;
  const p = r.patches.find((q) => q.n === res.best.n);
  if (!c.targetSpectrum || !p?.spectrum) {
    return `<p class="text-xs text-slate-500">Metamerism check: ${!c.targetSpectrum ? 'measure the reference with the SD-10 (a typed-in reference has no spectrum)' : 'measure the patches again'} to see how this match holds up under other lights.</p>`;
  }
  const m = metamerism(c.targetSpectrum, p.spectrum, match.formula);
  const limit = Math.max(1, match.tol);
  const bad = m.worst.mi > limit;
  const rows = m.lights.map((l) => `<tr class="border-t border-slate-200 dark:border-slate-800"><td class="py-1">${l.name}</td>
    <td class="text-right font-mono tabular-nums">${l.dE.toFixed(2)}</td><td class="text-right font-mono tabular-nums ${l.mi > limit ? 'text-rose-600 font-semibold' : ''}">${l.mi.toFixed(2)}</td></tr>`).join('');
  return `<details class="text-xs" ${bad ? 'open' : ''}><summary class="cursor-pointer ${bad ? 'text-rose-600 font-medium' : 'text-slate-500'}">Metamerism check (best patch #${p.n} vs reference) – ${bad
    ? `the match changes under other lights: up to ${DE().label} ${m.worst.mi.toFixed(2)} under ${m.worst.key}`
    : `holds up under other lights (metamerism ≤ ${m.worst.mi.toFixed(2)})`}</summary>
    <table class="w-full mt-2"><thead class="text-slate-500"><tr><th class="text-left font-normal">Light</th><th class="text-right font-normal">${DE().label}</th><th class="text-right font-normal">Metamerism index</th></tr></thead><tbody>
    <tr><td class="py-1">Viewing booth D50 (the match)</td><td class="text-right font-mono tabular-nums">${m.d50.toFixed(2)}</td><td class="text-right">–</td></tr>${rows}</tbody></table>
    <p class="mt-1 text-slate-500">The metamerism index is how far the two colours drift apart under that light once the D50 difference is taken out. ${bad
      ? 'The ink and the reference reflect light differently across the spectrum, so a match under every light may not be possible with these inks – check the colour under the light the product will be seen in, and match for that light if it matters most.'
      : 'Values up to about 1 are hard to see.'}${m.d50 > 3 ? ' The patch is still far from the reference under D50, so treat this as a first indication – it becomes reliable as the match gets close.' : ''}</p></details>`;
}

/** One colour's result block. */
function resultBlock(c) {
  const r = latest(c);
  const res = r.result;
  const within = res.predictedDeltaE <= match.tol && !res.extrapolated;
  const verified = r.round > 1 && res.centreDE != null && res.centreDE <= match.tol;
  const cells = formatValues(r.mode, res.x, r.kFixed)
    .map(([k, v]) => `<div class="rounded-lg bg-slate-100 dark:bg-slate-800 px-3 py-2 text-center"><div class="text-[10px] text-slate-500">${k}</div><div class="font-mono text-xl tabular-nums">${v}</div></div>`).join('');
  const prevVals = formatValues(r.mode, r.centre, r.kFixed).map(([k, v]) => `${k} ${v}`).join(' ');
  return `<section data-res="${c.id}" class="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <span class="h-5 w-5 rounded ring-1 ring-black/10" style="background:${displayHex(c.target)}"></span>
      <h4 class="font-semibold">${escapeHtml(colourLabel(c))}</h4><span class="text-xs text-slate-500">round ${r.round}</span>
      ${c.accepted ? '<span class="chip bg-emerald-600 text-white">ACCEPTED</span>' : ''}
    </div>
    ${verified ? `<div class="rounded-lg bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 p-3 text-sm"><b>Done.</b> The previous round's values (<span class="font-mono">${prevVals}</span>) printed within tolerance – centre patch ${DE().label} ${res.centreDE.toFixed(2)}. Use those, or the refined values below.</div>` : ''}
    <p class="text-sm text-slate-500">${{
    spot: `Enter these L*a*b* values for the named colour${c.name ? ` <b>${escapeHtml(c.name)}</b>` : ''} in the RIP’s spot colour library:`,
    lab: 'Use these L*a*b* values for the colour in your document:',
    cmyk: 'Use these CMYK values for the colour in your document:',
    rgb: 'Use this sRGB colour in your artwork:',
  }[r.mode]}</p>
    <div class="grid ${isLabMode(r.mode) ? 'grid-cols-3' : 'grid-cols-4'} gap-2">${cells}</div>
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="rounded-md px-2 py-0.5 text-xs font-bold text-white ${within ? 'bg-emerald-600' : 'bg-amber-500'}">${within ? 'EXPECTED MATCH' : 'NEEDS ANOTHER ROUND'}</span>
      <span>predicted ${DE().label} <b class="tabular-nums">${res.predictedDeltaE.toFixed(2)}</b>${res.extrapolated ? ' (rough estimate)' : ''} (tolerance ${match.tol})</span>
    </div>
    ${res.source === 'best-patch' ? `<p class="text-xs text-amber-600">No values are predicted to print closer than the best patch you measured (#${res.best.n}), so these are its values.</p>` : ''}
    ${res.extrapolated ? '<p class="text-xs text-amber-600">The answer lies outside this sheet’s patch range, so the prediction is only a rough estimate. The next sheet is centred on it and will confirm.</p>' : ''}
    ${res.trustLimited ? '<p class="text-xs text-amber-600">This round moves as far as the sheet’s measurements can be trusted; the next sheet continues in that direction.</p>' : ''}
    ${res.gamutLimited && res.predictedDeltaE > match.tol ? `<p class="text-xs text-rose-600"><b>The reference looks outside what this printer and media can reproduce.</b> Nothing within reach is predicted closer than ${DE().label} ${res.predictedDeltaE.toFixed(2)} – more rounds will not get much closer. Use these values as the closest match, or check the media, ink limits and colour settings.</p>` : ''}
    ${gamutClass(gamutFor(c)) === 'outside' || gamutClass(gamutFor(c)) === 'edge' ? `<p class="text-xs">${gamutHtml(c)}</p>` : ''}
    ${res.clamped ? '<p class="text-xs text-amber-600">Some values reached their limit – the reference may be outside the colours this printer and paper can produce. These are the closest reachable values.</p>' : ''}
    <dl class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
      <div><dt class="text-slate-500">Centre patch</dt><dd class="font-mono">${DE().label} ${res.centreDE != null ? res.centreDE.toFixed(2) : '–'}</dd></div>
      <div><dt class="text-slate-500">Best patch</dt><dd class="font-mono">#${res.best.n} · ${DE().label} ${res.best.dE.toFixed(2)}</dd></div>
      <div><dt class="text-slate-500">Model fit (rms)</dt><dd class="font-mono">${res.rms.toFixed(2)} ΔE</dd></div>
      <div><dt class="text-slate-500">Repeatability</dt><dd class="font-mono">${res.repeatability != null ? DE().label + ' ' + res.repeatability.toFixed(2) : '–'}</dd></div>
    </dl>
    ${metamerismHtml(c, r)}
    <div class="flex flex-wrap gap-2">
      <button type="button" data-res-act="accept" class="btn ${c.accepted ? 'btn-primary' : 'btn-ghost'}" title="Accepted colours are left off the next sheets">${c.accepted ? 'Accepted ✓' : 'Accept – no more rounds'}</button>
      <button type="button" data-res-act="copy" class="btn btn-ghost">Copy values</button>
      ${isLabMode(r.mode) ? '<button type="button" data-res-act="add" class="btn btn-ghost" title="Add the matched colour to your spot library under its name">Add to spot library</button>' : ''}
    </div>
    <details class="text-xs"><summary class="cursor-pointer text-slate-500">Rounds</summary>
      <table class="w-full mt-2"><thead class="text-slate-500"><tr><th class="text-left">Round</th><th class="text-left">Sheet centre</th><th class="text-left">Centre ${DE().label}</th><th class="text-left">Predicted ${DE().label}</th></tr></thead><tbody>
      ${c.rounds.map((rr) => `<tr class="border-t border-slate-200 dark:border-slate-800"><td class="py-1">${rr.round}</td><td class="font-mono">${formatValues(rr.mode, rr.centre, rr.kFixed).map(([k, v]) => `${k}${v}`).join(' ')}</td><td class="font-mono">${rr.result?.centreDE != null ? rr.result.centreDE.toFixed(2) : '–'}</td><td class="font-mono">${rr.result ? rr.result.predictedDeltaE.toFixed(2) : '–'}</td></tr>`).join('')}
      </tbody></table></details>
  </section>`;
}

function renderMatchResult() {
  const withResult = match.colours.filter((c) => latest(c)?.result);
  $('mResultCard').classList.toggle('hidden', !withResult.length);
  if (!withResult.length) return;
  $('mResult').innerHTML = withResult.map(resultBlock).join('');
  $('btnMatchRefine').textContent = match.colours.some((c) => c.target && !c.accepted) ? 'Make next sheet' : 'All colours accepted';
}

function renderLibrary() {
  const ex = RIP_EXPORTS[match.ripFormat] ?? RIP_EXPORTS.cxf;
  const n = spotLib.colours.length;
  $('mLibCount').textContent = n ? `(${n})` : '';
  if (document.activeElement !== $('mLibName')) $('mLibName').value = spotLib.name;
  $('btnLibDownload').disabled = !n;
  $('btnLibClear').disabled = !n;
  $('mLibList').innerHTML = !n
    ? '<p class="text-sm text-slate-500">No colours yet – finish a match in an L*a*b* sheet type and press <b>Add to spot library</b>, add one below, or import a library.</p>'
    : `<table class="w-full text-sm"><thead class="text-xs text-slate-500"><tr><th class="text-left font-normal">Name</th><th class="text-right font-normal">L*</th><th class="text-right font-normal">a*</th><th class="text-right font-normal">b*</th><th class="text-right font-normal">Pred. ΔE00</th><th></th></tr></thead><tbody>
      ${spotLib.colours.map((c, i) => `<tr class="border-t border-slate-200 dark:border-slate-800" data-lib="${i}">
        <td class="py-1.5"><button data-lib-act="rename" class="flex items-center gap-2 text-left hover:underline" title="Rename"><span class="h-5 w-5 flex-none rounded ring-1 ring-black/10" style="background:${displayHex(c.lab)}"></span><span class="font-medium">${escapeHtml(c.name)}</span></button></td>
        <td class="text-right font-mono tabular-nums">${c.lab[0].toFixed(2)}</td><td class="text-right font-mono tabular-nums">${c.lab[1].toFixed(2)}</td><td class="text-right font-mono tabular-nums">${c.lab[2].toFixed(2)}</td>
        <td class="text-right font-mono tabular-nums">${c.predictedDeltaE != null ? c.predictedDeltaE.toFixed(2) : '–'}</td>
        <td class="text-right"><button data-lib-act="del" class="text-xs text-rose-600 hover:underline px-1" title="Remove from the library">remove</button></td></tr>`).join('')}
      </tbody></table>`;
  // Formats with reduced Lab precision round the values: say what that costs for this library when it matters.
  let note = '', worst = 0;
  if (n && ex.quantize) {
    worst = Math.max(...spotLib.colours.map((c) => deltaE2000(c.lab, ex.quantize(c.lab))));
    if (worst >= 0.1) note = `${ex.label} stores ${ex.precision} – the largest rounding in this library is ΔE00 ${worst.toFixed(2)}. For full precision use CxF3 or type the values into the RIP.`;
  }
  $('mLibNote').textContent = note;
  $('mLibNote').className = `text-xs ${note && worst > match.tol / 2 ? 'text-amber-600' : 'text-slate-500'}`;
}

/** Add a colour's result to the spot library under its name (replacing a colour with the same name). */
function addResultToLibrary(c) {
  const r = latest(c);
  if (!r?.result || !isLabMode(r.mode)) return;
  let name = c.name.trim();
  if (!name) {
    name = (prompt('Spot colour name – exactly as it is named in your artwork and the RIP:') ?? '').trim();
    if (!name) return;
    c.name = name; saveMatch();
  }
  if (putInLibrary({ name, lab: r.result.x, target: c.target, predictedDeltaE: r.result.predictedDeltaE, mf: match.mf })) {
    $('mLibraryCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/** Add or (after asking) replace a colour by name. Returns true if the library changed. */
function putInLibrary(c) {
  const entry = { predictedDeltaE: null, ...c, lab: c.lab.map((v) => Math.round(v * 100) / 100), time: new Date().toISOString() };
  const i = spotLib.colours.findIndex((o) => o.name === c.name);
  if (i >= 0) {
    if (!confirm(`“${c.name}” is already in the spot library. Replace it with the new values?`)) return false;
    spotLib.colours[i] = entry;
  } else spotLib.colours.push(entry);
  saveLib(); renderMatch();
  toast(`“${c.name}” ${i >= 0 ? 'updated in' : 'added to'} the spot library`, 'ok');
  return true;
}

function addLibraryColourByHand(e) {
  e.preventDefault();
  const name = $('libNewName').value.trim();
  const lab = ['libNewL', 'libNewA', 'libNewB'].map((id) => parseFloat($(id).value));
  if (!name) { toast('Enter the spot colour name – exactly as it is named in your artwork and the RIP.', 'error'); $('libNewName').focus(); return; }
  if (!lab.every(Number.isFinite) || lab[0] < 0 || lab[0] > 100 || Math.abs(lab[1]) > 128 || Math.abs(lab[2]) > 128) { toast('Enter L* (0–100), a* and b* (−128–127).', 'error'); return; }
  if (putInLibrary({ name, lab })) for (const id of ['libNewName', 'libNewL', 'libNewA', 'libNewB']) $(id).value = '';
}

async function importLibraryFile(file) {
  if (file.size > 20 * 1024 * 1024) { toast('That file is too large for a spot colour library.', 'error'); return; }
  let lib;
  try { lib = readLibrary(new Uint8Array(await file.arrayBuffer()), file.name); } catch (e) { toast(e.message, 'error'); return; }
  if (!lib.colours.length) { toast(`No usable L*a*b* (D50 / 2°) colours in ${file.name}${lib.skipped.length ? ` (${lib.skipped.length} colour(s) without L*a*b*, e.g. CMYK)` : ''}.`, 'error'); return; }
  const names = new Set(spotLib.colours.map((c) => c.name));
  const clashes = lib.colours.filter((c) => names.has(c.name));
  const replace = clashes.length ? confirm(`${clashes.length} of the ${lib.colours.length} colours in ${file.name} are already in the spot library (${clashes.slice(0, 3).map((c) => `“${c.name}”`).join(', ')}${clashes.length > 3 ? ' …' : ''}).\n\nOK = replace them with the imported values, Cancel = keep the library's values.`) : false;
  if (!spotLib.colours.length && lib.library) spotLib.name = lib.library.slice(0, 60);
  let added = 0, replaced = 0;
  for (const c of lib.colours) {
    const entry = { name: c.name, lab: c.lab.map((v) => Math.round(v * 100) / 100), predictedDeltaE: null, imported: file.name, time: new Date().toISOString() };
    const i = spotLib.colours.findIndex((o) => o.name === c.name);
    if (i < 0) { spotLib.colours.push(entry); added++; } else if (replace) { spotLib.colours[i] = entry; replaced++; }
  }
  saveLib(); renderMatch();
  toast(`Imported ${file.name}: ${added} added${replaced ? `, ${replaced} replaced` : ''}${clashes.length && !replace ? `, ${clashes.length} kept` : ''}${lib.skipped.length ? ` – ${lib.skipped.length} skipped (no D50 / 2° L*a*b*)` : ''}`, 'ok');
}

function onLibraryClick(e) {
  const b = e.target.closest('[data-lib-act]');
  if (!b) return;
  const i = +b.closest('[data-lib]').dataset.lib;
  const c = spotLib.colours[i];
  if (b.dataset.libAct === 'del') {
    if (!confirm(`Remove “${c.name}” from the spot library?`)) return;
    spotLib.colours.splice(i, 1);
  } else {
    const name = (prompt('Spot colour name – exactly as it is named in your artwork and the RIP:', c.name) ?? '').trim();
    if (!name || name === c.name) return;
    if (spotLib.colours.some((o) => o.name === name)) { toast(`“${name}” is already in the library.`, 'error'); return; }
    c.name = name;
  }
  saveLib(); renderMatch();
}

async function measureLabD50() {
  const s = await state.session.getStatus();
  if (s.shutterStatus === 1) { await doCalibrate(); return null; }
  if (s.calibrationStatus !== 2) { toast('Calibration needed: close the shutter, then calibrate.', 'error'); return null; }
  const [rec] = await state.session.measure({ method: METHOD.SPOT, saveResult: false, mFactor: match.mf, lightSource: 0, viewingAngle: 2 });
  const lab = spectrumToLab(rec.spectrum, 0, 2);
  state.lastLabD50 = lab;
  state.lastSpectrum = rec.spectrum;
  return { lab, spectrum: rec.spectrum };
}

/**
 * Set a colour's reference (spectrum: its measured reflectance, for the metamerism check – none when typed in);
 * with measurements already made for it, asks first and starts that colour over.
 */
function setColourTarget(c, lab, spectrum = null) {
  if (c.rounds.some((r) => r.patches.some((p) => p.lab)) && !confirm(`Changing the reference of ${colourLabel(c)} starts its matching over. Continue?`)) { renderMatch(); return false; }
  c.target = lab.map((v) => Math.round(v * 100) / 100);
  c.targetSpectrum = spectrum ? roundSpectrum(spectrum) : null;
  c.rounds = []; c.accepted = false; c.refReads = []; c.refSpectra = [];
  saveMatch(); renderMatch();
  return true;
}

function measureMatchTarget() {
  const c = activeColour();
  return task('Measuring reference', async () => {
    const m = await measureLabD50();
    if (!m) return;
    c.refReads = [...c.refReads, m.lab];
    c.refSpectra = [...(c.refSpectra ?? []), roundSpectrum(m.spectrum)];
    if (c.refReads.length < match.reads) {
      saveMatch(); renderMatch();
      toast(`Reading ${c.refReads.length}/${match.reads} – move the SD-10 to another spot on the reference and measure again.`);
      return;
    }
    const { lab, spread } = averageReadings(c.refReads);
    const spectrum = meanSpectrum(c.refSpectra);
    c.refReads = []; c.refSpectra = [];
    if (setColourTarget(c, lab, spectrum)) toast(`Reference colour measured${match.reads > 1 ? ` – mean of ${match.reads} readings, spread ΔE00 ${spread.toFixed(2)}` : ''}`, 'ok');
    else saveMatch();
  });
}

/** First sheet centre for a colour (CMYK: from the selected profile, K kept fixed). */
async function initialCentre(c) {
  if (match.mode === 'cmyk') {
    const cmyk = (await loadProfile(settingsFromUI().cmykProfile)).fromLab(c.target, 0).map((v) => Math.round(Math.min(v, 100) * 10) / 10);
    return { centre: cmyk.slice(0, 3), kFixed: cmyk[3], step: [...MODES.cmyk.step0] };
  }
  if (match.mode === 'rgb') return { centre: labD50ToSrgb(c.target).rgb, kFixed: 0, step: [...MODES.rgb.step0] };
  return { centre: [...c.target], kFixed: 0, step: [...MODES[match.mode].step0] };
}

/** New sheet with one round per planned colour: [{ c, centre, step, kFixed }]. Patches are numbered across the sheet. */
function createSheet(plan) {
  const sheet = match.sheet + 1;
  match.jobId ??= newJobId();
  let n = 0;
  for (const { c, centre, step, kFixed } of plan) {
    const patches = designPatches(match.mode, centre, step, match.design).map((p) => {
      n++;
      return { ...p, n, ...(match.mode === 'spot' ? { name: patchSpotName(match.jobId, sheet, n) } : {}) };
    });
    c.rounds.push({ round: (latest(c)?.round ?? 0) + 1, sheet, mode: match.mode, centre, step, kFixed, design: match.design, patches, result: null });
  }
  match.sheet = sheet;
  match.next = { c: plan[0].c.id, i: 0 };
  saveMatch(); renderMatch();
}

async function startFirstSheet() {
  const ready = match.colours.filter((c) => c.target);
  if (!ready.length) return;
  if (match.sheet && !confirm('Start again with a new first sheet? All sheets and measurements are discarded.')) return;
  try {
    const plan = [];
    for (const c of ready) plan.push({ c, ...(await initialCentre(c)) });
    for (const c of match.colours) { c.rounds = []; c.accepted = false; }
    match.sheet = 0;
    match.jobId = newJobId(); // fresh spot names, so libraries imported for an earlier job cannot clash
    createSheet(plan);
    toast('Sheet created – download and print it.', 'ok');
  } catch (e) {
    toast(`Could not create the sheet: ${e.message}`, 'error');
  }
}

/** Next sheet: every colour that is not accepted – refined from its result, or its first round if it is new. */
async function makeNextSheet() {
  const plan = [], waiting = [];
  try {
    for (const c of match.colours) {
      if (!c.target || c.accepted) continue;
      const r = latest(c);
      if (!r) plan.push({ c, ...(await initialCentre(c)) });
      else if (!r.result) waiting.push(colourLabel(c));
      else plan.push({ c, centre: r.result.x, step: nextStep(r.mode, r.step, r.result.correction), kFixed: r.kFixed });
    }
  } catch (e) { toast(`Could not create the sheet: ${e.message}`, 'error'); return; }
  if (!plan.length) { toast(waiting.length ? `Scan ${waiting.join(', ')} first.` : 'All colours are accepted – nothing left to match.', 'error'); return; }
  createSheet(plan);
  toast(`Sheet ${match.sheet} created – download and print it.${waiting.length ? ` Not on it (no result yet): ${waiting.join(', ')}.` : ''}`, 'ok');
  $('mSheetInfo').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function downloadFile(data, type, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const sheetGroups = () => sheetItems().map(({ c, r }) => ({ label: colourLabel(c), target: c.target, patches: r.patches, kFixed: r.kFixed }));

/** One file per colour (its own PDF, or PNG pages for raster workflows), named after the colour and sheet. */
async function downloadSheet() {
  if (!match.sheet || !sheetItems().length) return;
  try {
    for (const g of sheetGroups()) {
      const opts = { mode: match.mode, groups: [g], round: match.sheet, media: mediaMm(), patchMm: match.patchMm };
      const base = safeFileName(`${g.label} - sheet ${match.sheet}`);
      if (match.mode === 'rgb') {
        const pages = await buildSheetPng(opts);
        pages.forEach(({ png }, i) => downloadFile(png, 'image/png', `${base}${pages.length > 1 ? ` - page ${i + 1}` : ''}.png`));
        if (pages[0].dpi < 300) toast(`Large media: the PNG is ${pages[0].dpi} dpi (still printed at actual size).`);
      } else downloadFile(buildSheetPdf(opts), 'application/pdf', `${base}.pdf`);
    }
  } catch (e) { toast(e.message, 'error'); }
}

const safeFileName = (s) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'spot';

/** Spot colour library for the RIP: the current sheet's patch colours ('sheet') or the collected spot library ('library'). */
function downloadRipLibrary(what, rip = match.ripFormat) {
  const ex = RIP_EXPORTS[rip];
  if (!ex) return;
  if (what === 'sheet' && match.sheet) {
    const colours = sheetPatches().filter((e) => e.p.name).map((e) => ({ name: e.p.name, lab: e.p.x }));
    if (!colours.length) return;
    const text = ex.build({ library: `SD10 ${match.jobId} sheet ${match.sheet}`, description: 'Print match test sheet patches, CIE L*a*b* D50/2°', colours });
    downloadFile(text, ex.mime, `sd10-${match.jobId}-sheet${match.sheet}.${ex.ext}`);
  } else if (what === 'library' && spotLib.colours.length) {
    const library = spotLib.name.trim() || 'SD-10 spot colours';
    const description = `${spotLib.colours.length} colour(s) matched with SD-10 Print match, CIE L*a*b* D50/2°`;
    downloadFile(ex.build({ library, description, colours: spotLib.colours.map((c) => ({ name: c.name, lab: c.lab })) }), ex.mime, `${safeFileName(library)}.${ex.ext}`);
  }
}

function measurePatch() {
  const all = sheetPatches();
  if (!all.length) return;
  const k = nextIndex(all);
  const { c, r, p } = all[k];
  return task(`Measuring #${p.n}`, async () => {
    // Demo: the simulated SD-10 "sees" what a simulated printer would print for this patch.
    if (DEMO && state.transport?.setSpectrumOverride) {
      const lab = r.mode === 'rgb' ? srgbToLabD50(p.x) : p.x;
      const cmyk = r.mode === 'cmyk' ? [...p.x, r.kFixed] : (await loadProfile(settingsFromUI().cmykProfile)).fromLab(lab, 0);
      state.transport.setSpectrumOverride(printSpectrum(cmyk));
    }
    let m;
    try { m = await measureLabD50(); } finally { state.transport?.setSpectrumOverride?.(null); }
    if (!m) return;
    if (p.lab) { p.lab = null; p.reads = []; p.spectra = []; p.spread = null; p.spectrum = null; } // measuring a finished patch again starts it over
    p.reads = [...(p.reads ?? []), m.lab];
    p.spectra = [...(p.spectra ?? []), roundSpectrum(m.spectrum)];
    r.result = null;
    if (p.reads.length < match.reads) {
      saveMatch(); renderMatch();
      toast(`Reading ${p.reads.length}/${match.reads} – move the SD-10 to another spot on patch #${p.n}.`);
      return;
    }
    Object.assign(p, averageReadings(p.reads));
    p.spectrum = roundSpectrum(meanSpectrum(p.spectra));
    delete p.spectra; // the mean is enough – keeps the saved job small
    const after = all.findIndex((e, j) => j > k && !e.p.lab);
    const any = all.findIndex((e) => !e.p.lab);
    const nx = all[after >= 0 ? after : any >= 0 ? any : k];
    match.next = { c: nx.c.id, i: nx.i };
    if (r.patches.every((q) => q.lab)) analyseColour(c, r);
    saveMatch();
    renderMatch();
    if (all.every((e) => e.p.lab)) $('mResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function analyseColour(c, r = latest(c)) {
  try {
    const a = analyseRound(r, c.target, match.formula);
    r.result = { x: a.x, predicted: a.predicted, predictedDeltaE: a.predictedDeltaE, clamped: a.clamped, correction: a.correction, extrapolated: a.extrapolated,
      source: a.source, trustLimited: a.trustLimited, gamutLimited: a.gamutLimited,
      best: { n: a.best.n, dE: a.best.dE }, centreDE: a.centreDE, repeatability: a.repeatability, rms: a.model.rms };
    return true;
  } catch (e) {
    toast(`${colourLabel(c)}: ${e.message}`, 'error');
    return false;
  }
}

/** "Calculate now": every colour on the sheet with enough measured patches. */
function analyseMatch() {
  let any = false;
  for (const { c, r } of sheetItems()) if (r.patches.filter((p) => p.lab).length >= 5 && analyseColour(c, r)) any = true;
  saveMatch(); renderMatch();
  if (any) $('mResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function copyMatchValues(c) {
  const r = latest(c);
  if (!r?.result) return;
  const text = `${colourLabel(c)} – ${{ spot: 'L*a*b*', lab: 'L*a*b*', cmyk: 'CMYK', rgb: 'sRGB' }[r.mode]}: ` + formatValues(r.mode, r.result.x, r.kFixed).map(([k, v]) => `${k} ${v}`).join(', ') +
    ` (predicted ${DE().label} ${r.result.predictedDeltaE.toFixed(2)} to reference L*a*b* ${c.target.map((v) => v.toFixed(2)).join(' / ')})`;
  navigator.clipboard?.writeText(text).then(() => toast('Values copied', 'ok'), () => toast('Clipboard not available', 'error'));
}

async function refreshPrinterProfiles() {
  const names = await printerProfiles.list();
  if (match.printerProfile && !names.includes(match.printerProfile)) match.printerProfile = '';
  $('mPrinterProfile').innerHTML = '<option value="">None</option>' + names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  $('mPrinterProfile').value = match.printerProfile;
}

function resetMatching() {
  for (const c of match.colours) { c.rounds = []; c.accepted = false; }
  match.sheet = 0; match.next = null;
}

function initMatch() {
  for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => setView(b.dataset.view);
  $('btnMatchTarget').onclick = measureMatchTarget;
  $('btnMatchUseLast').onclick = () => {
    const lab = state.lastLabD50 ?? (state.last && spectrumToLab(state.last.spectrum, 0, 2));
    if (lab) setColourTarget(activeColour(), lab, state.lastSpectrum ?? state.last?.spectrum ?? null);
  };
  for (const id of ['mL', 'mA', 'mB']) {
    $(id).addEventListener('change', () => {
      const v = ['mL', 'mA', 'mB'].map((k) => parseFloat($(k).value));
      if (v.every(Number.isFinite)) setColourTarget(activeColour(), [Math.min(Math.max(v[0], 0), 100), Math.min(Math.max(v[1], -128), 127), Math.min(Math.max(v[2], -128), 127)]);
    });
  }
  $('mSpotName').onchange = () => { activeColour().name = $('mSpotName').value.trim(); saveMatch(); renderMatch(); };
  $('btnColourAdd').onclick = () => {
    match.colours.push(newColour());
    match.active = match.colours.length - 1;
    saveMatch(); renderMatch();
    $('mSpotName').focus();
  };
  $('mColourList').onclick = (e) => {
    const b = e.target.closest('[data-colour-act]');
    if (!b) return;
    const i = +b.closest('[data-colour]').dataset.colour;
    const c = match.colours[i];
    if (b.dataset.colourAct === 'remove') {
      if (c.rounds.length && !confirm(`Remove ${colourLabel(c)} and its measurements?`)) return;
      match.colours.splice(i, 1);
      if (match.active >= match.colours.length) match.active = match.colours.length - 1;
      if (!sheetItems().length) match.sheet = 0;
    } else match.active = i;
    saveMatch(); renderMatch();
  };
  $('mMode').onchange = () => {
    if (match.sheet && !confirm('Changing the sheet type starts the matching over. Continue?')) { $('mMode').value = match.mode; return; }
    match.mode = $('mMode').value; resetMatching(); saveMatch(); renderMatch();
  };
  $('mPaper').onchange = () => { match.media = $('mPaper').value; saveMatch(); renderMatch(); };
  for (const [id, key, lo, hi] of [['mMediaW', 'mediaW', 50, 3000], ['mMediaH', 'mediaH', 50, 10000]]) {
    $(id).onchange = () => { match[key] = Math.min(Math.max(Math.round(+$(id).value) || match[key], lo), hi); saveMatch(); renderMatch(); };
  }
  $('mPatchMm').onchange = () => { match.patchMm = +$('mPatchMm').value; saveMatch(); renderMatch(); };
  $('mDesign').onchange = () => { match.design = $('mDesign').value; saveMatch(); renderMatch(); };
  $('matchMf').onchange = () => { match.mf = +$('matchMf').value; saveMatch(); };
  $('mReads').onchange = () => { match.reads = Math.min(Math.max(+$('mReads').value || 1, 1), 9); for (const c of match.colours) c.refReads = []; saveMatch(); renderMatch(); };
  $('mRipFormat').onchange = () => { match.ripFormat = $('mRipFormat').value; saveMatch(); renderMatch(); };
  $('btnMatchRipSheet').onclick = () => downloadRipLibrary('sheet');
  $('mResult').onclick = (e) => {
    const b = e.target.closest('[data-res-act]');
    if (!b) return;
    const c = match.colours.find((x) => x.id === b.closest('[data-res]').dataset.res);
    if (!c) return;
    if (b.dataset.resAct === 'accept') { c.accepted = !c.accepted; saveMatch(); renderMatch(); }
    else if (b.dataset.resAct === 'copy') copyMatchValues(c);
    else if (b.dataset.resAct === 'add') addResultToLibrary(c);
  };
  $('btnLibDownload').onclick = () => downloadRipLibrary('library');
  $('btnLibClear').onclick = () => { if (confirm('Remove all colours from the spot library?')) { spotLib.colours = []; saveLib(); renderMatch(); } };
  $('mLibName').onchange = () => { spotLib.name = $('mLibName').value.trim() || 'SD-10 spot colours'; saveLib(); renderMatch(); };
  $('mLibList').onclick = onLibraryClick;
  $('btnLibImport').onclick = () => $('libFile').click();
  $('libFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importLibraryFile(f); };
  $('libAddForm').onsubmit = addLibraryColourByHand;
  $('btnLibFromLast').onclick = () => {
    if (!state.lastLabD50) { toast('Measure a colour first (in the Console or here in Print match).', 'error'); return; }
    state.lastLabD50.forEach((v, i) => { $(['libNewL', 'libNewA', 'libNewB'][i]).value = v.toFixed(2); });
    $('libNewName').focus();
  };
  $('mTol').onchange = () => { match.tol = Math.min(Math.max(+$('mTol').value || 1, 0.1), 20); saveMatch(); renderMatch(); };
  $('matchFormula').onchange = () => {
    match.formula = $('matchFormula').value;
    // re-judge every result with the new formula (the measurements stay)
    for (const c of match.colours) { const r = latest(c); if (r?.result) analyseColour(c, r); }
    saveMatch(); renderMatch();
  };
  $('mPrinterProfile').onchange = () => { match.printerProfile = $('mPrinterProfile').value; saveMatch(); renderMatch(); };
  $('btnPrinterIcc').onclick = () => $('printerIccFile').click();
  $('printerIccFile').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 30 * 1024 * 1024) { toast('That file is too large to be a printer profile.', 'error'); return; }
    try {
      const r = await printerProfiles.add(f);
      match.printerProfile = r.name;
      await refreshPrinterProfiles();
      saveMatch(); renderMatch();
      toast(`Printer profile “${r.name}” added (${r.channels} ink channels)${r.saved ? '' : ' – for this session only (browser storage is unavailable)'}`, 'ok');
    } catch (err) { toast(`Could not use ${f.name}: ${err.message}`, 'error'); }
  };
  $('btnPrinterIccRemove').onclick = async () => {
    if (!match.printerProfile || !confirm(`Remove the printer profile “${match.printerProfile}” from this browser?`)) return;
    await printerProfiles.remove(match.printerProfile).catch(() => {});
    match.printerProfile = '';
    await refreshPrinterProfiles();
    saveMatch(); renderMatch();
  };
  refreshPrinterProfiles().then(() => { if (state.view === 'match') renderMatch(); });
  $('btnMatchSheet').onclick = startFirstSheet;
  $('btnMatchPdf').onclick = downloadSheet;
  $('btnMatchRestart').onclick = () => { if (confirm('Discard all sheets and measurements (the reference colours are kept)?')) { resetMatching(); saveMatch(); renderMatch(); } };
  $('btnMatchMeasure').onclick = measurePatch;
  $('btnMatchAnalyse').onclick = analyseMatch;
  $('btnMatchRefine').onclick = makeNextSheet;
  $('mPatchGrid').onclick = (e) => {
    const b = e.target.closest('[data-patch]');
    if (!b) return;
    const en = sheetPatches()[+b.dataset.patch];
    if (en) { match.next = { c: en.c.id, i: en.i }; saveMatch(); renderMatch(); }
  };
  setView(location.hash === '#match' ? 'match' : 'console');
  WIDE.addEventListener('change', () => { if (!WIDE.matches && state.view === 'match') setView('console'); });
}

// ------------------------------------------------------------------ CMYK profiles
async function refreshProfileList(selected) {
  const custom = await customProfiles.list();
  const opt = (v, t) => `<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`;
  $('cmykProfile').innerHTML =
    `<optgroup label="App profiles">${Object.keys(CMYK_PROFILES).map((k) => opt(k, k + (k === 'EpsonWideCMYK_Ver2' ? ' (app default)' : ''))).join('')}</optgroup>` +
    (custom.length ? `<optgroup label="Your profiles">${custom.map((n) => opt(CUSTOM_PREFIX + n, n)).join('')}</optgroup>` : '');
  const ok = [...$('cmykProfile').options].some((o) => o.value === selected);
  $('cmykProfile').value = ok ? selected : 'EpsonWideCMYK_Ver2';
  $('btnRemoveIcc').classList.toggle('hidden', !$('cmykProfile').value.startsWith(CUSTOM_PREFIX));
  if (state.last) updateCmyk(state.last.spectrum);
}

async function addIccProfile(file) {
  if (file.size > 20 * 1024 * 1024) { toast('That file is too large to be a CMYK profile (over 20 MB).', 'error'); return; }
  try {
    const { name, saved } = await customProfiles.add(file);
    await refreshProfileList(CUSTOM_PREFIX + name);
    savePrefs();
    toast(saved ? `Added CMYK profile “${name}”` : `Added “${name}” for this session only (browser storage is unavailable)`, 'ok');
  } catch (e) {
    toast(`Could not use ${file.name}: ${e.message}`, 'error');
  }
}

async function removeIccProfile() {
  const v = $('cmykProfile').value;
  if (!v.startsWith(CUSTOM_PREFIX)) return;
  const name = v.slice(CUSTOM_PREFIX.length);
  if (!confirm(`Remove the CMYK profile “${name}” from this browser?`)) return;
  await customProfiles.remove(name).catch(() => {});
  await refreshProfileList('EpsonWideCMYK_Ver2');
  savePrefs();
}

function setLogOpen(open) {
  $('logBody').classList.toggle('hidden', !open);
  $('logTools').classList.toggle('hidden', !open);
  $('logTools').classList.toggle('flex', open);
  $('logChevron').classList.toggle('rotate-90', open);
  $('btnToggleLog').setAttribute('aria-expanded', String(open));
  try { localStorage.setItem('sd10.logOpen', open ? '1' : '0'); } catch { /* ignore */ }
  if (open && $('logAutoscroll').checked) logEl.scrollTop = logEl.scrollHeight;
}

function init() {
  fill($('mIll'), Object.fromEntries(Object.entries(LIGHT_SOURCES).map(([k, v]) => [v, k])));
  fill($('mFormula'), DIFF_FORMULAS);
  fill($('setBuzzer'), BUZZER); fill($('setApo'), AUTO_POWER_OFF); fill($('setLang'), LANGUAGES); fill($('setPanel'), PANEL_DIRECTION);
  fill($('demoSample'), Object.fromEntries(Object.keys(SAMPLES).map((k) => [k, k])));

  const p = state.prefs;
  $('mMf').value = p.mFactor; $('mIll').value = p.lightSource; $('mObs').value = p.observer; $('mReadings').value = p.readings;
  $('mFormula').value = p.formula; $('mThr').value = p.threshold; $('mPatches').value = p.patches;
  $('cmykIntent').value = p.cmykIntent ?? 0;
  refreshProfileList(p.cmykProfile);
  setMode(p.mode || 'spot');

  if (!BleTransport.supported) { $('bleWarning').classList.remove('hidden'); $('btnConnect').disabled = true; $('btnConnectMenu').disabled = true; }

  $('btnConnect').onclick = () => connect(DEMO);
  // Connection options menu (device filter switch), remembered in this browser
  const menu = $('connectMenu');
  const setMenu = (open) => { menu.classList.toggle('hidden', !open); $('btnConnectMenu').setAttribute('aria-expanded', String(open)); };
  $('btnConnectMenu').onclick = (e) => { e.stopPropagation(); setMenu(menu.classList.contains('hidden')); };
  menu.onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => setMenu(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
  try { $('acceptAll').checked = localStorage.getItem('sd10.acceptAll') === '1'; } catch { /* ignore */ }
  const syncDot = () => $('acceptAllDot').classList.toggle('hidden', !$('acceptAll').checked);
  syncDot();
  $('acceptAll').onchange = () => { syncDot(); try { localStorage.setItem('sd10.acceptAll', $('acceptAll').checked ? '1' : '0'); } catch { /* ignore */ } };
  $('btnDisconnect').onclick = disconnect;
  $('btnRefresh').onclick = () => task('Refreshing', async () => { await state.session.getStatus(); await loadSettings(); });
  $('btnCalibrate').onclick = () => task('Calibrating', doCalibrate);
  $('btnMeasure').onclick = onMeasureButton;
  $('btnReloadSettings').onclick = () => task('Loading settings', loadSettings);
  $('settingsForm').onsubmit = applySettings;
  $('btnReadGroups').onclick = () => task('Reading palettes', readGroups);
  $('btnWriteGroup').onclick = writeGroup;
  $('groupList').onclick = (e) => { const b = e.target.closest('[data-delslot]'); if (b) deleteGroup(+b.dataset.delslot); };
  $('btnSetRef').onclick = () => state.last && setReference(state.last.spectrum, { id: state.last.itemId });
  $('btnCopyValues').onclick = copyValues;
  $('resultValues').onclick = (e) => {
    const b = e.target.closest('[data-copy]');
    if (b) navigator.clipboard?.writeText(b.dataset.copy).then(() => toast(`${b.dataset.copy} copied`, 'ok'));
  };
  for (const id of ['cmykProfile', 'cmykIntent']) {
    $(id).addEventListener('change', () => {
      $('btnRemoveIcc').classList.toggle('hidden', !$('cmykProfile').value.startsWith(CUSTOM_PREFIX));
      savePrefs();
      if (state.last) updateCmyk(state.last.spectrum);
    });
  }
  $('btnAddIcc').onclick = () => $('iccFile').click();
  $('iccFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) addIccProfile(f); };
  $('btnRemoveIcc').onclick = removeIccProfile;
  $('histBody').onclick = onHistoryClick;
  $('btnExport').onclick = exportCsv;
  $('btnClearHistory').onclick = clearHistory;
  $('btnSyncHistory').onclick = syncHistory;
  $('btnResyncAll').onclick = () => syncHistory({ shiftKey: true });
  for (const t of document.querySelectorAll('[role=tab]')) t.onclick = () => setMode(t.dataset.mode);
  for (const id of ['mMf', 'mIll', 'mObs', 'mReadings', 'mFormula', 'mThr', 'mPatches']) {
    $(id).addEventListener('change', () => { savePrefs(); renderHistory(); if (state.last) showResult({ spectrum: state.last.spectrum }); });
  }
  $('btnClearLog').onclick = () => { logEl.innerHTML = ''; logCount = 0; $('logCount').textContent = ''; };
  $('btnToggleLog').onclick = () => setLogOpen($('logBody').classList.contains('hidden'));
  let logOpen = false;
  try { logOpen = localStorage.getItem('sd10.logOpen') === '1'; } catch { /* ignore */ }
  setLogOpen(logOpen);
  // The simulated device is a developer/test aid: only offered when the page is opened with ?demo
  if (DEMO) {
    // Demo page: the main button connects to the simulated SD-10; Bluetooth options don't apply.
    $('btnConnect').querySelector('[data-label-short]').textContent = 'Connect demo';
    $('btnConnect').querySelector('[data-label-long]').textContent = 'Connect demo device';
    $('btnConnect').classList.remove('!rounded-r-none');
    $('btnConnectMenu').classList.add('hidden');
    $('bleWarning').classList.add('hidden');
  }
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
  initMatch();
  updateControls();
}

init();
