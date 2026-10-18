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
import { CMYK_PROFILES, CUSTOM_PREFIX, customProfiles, loadProfile } from './icc.js';
import { MODES, analyseRound, averageReadings, buildSheetPdf, buildSheetPng, designPatches, nextStep, patchSpotName } from './match.js';
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
    if (currentRound()) measurePatch(); else measureMatchTarget();
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
// Persisted job: { target, mode, paper, mf, tol, reads, spotName, jobId, refReads,
//                  rounds: [{ round, mode, centre, step, kFixed, patches: [{ n, offset, x, name?, reads, lab, spread }], result }], next }
const MATCH_KEY = 'sd10.match';
const match = (() => {
  let m = {};
  try { m = JSON.parse(localStorage.getItem(MATCH_KEY)) || {}; } catch { /* ignore */ }
  return { target: null, mode: 'spot', paper: 'a4', mf: 1, tol: 1, reads: 1, spotName: '', ripFormat: 'cxf', jobId: null, refReads: [], rounds: [], next: 0, ...m };
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
const currentRound = () => match.rounds[match.rounds.length - 1] ?? null;
const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

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
    rgb: 'For software that only accepts raster images. The sheet is a 300 dpi sRGB PNG and the result is an sRGB value / hex for your artwork – keep the artwork in sRGB like the sheet.',
  }[mode] + ' Colours are measured at D50 / 2°.';
}

function printTips(mode) {
  const tips = ['<b>Print it exactly like the final job:</b> same printer, media, quality and colour settings, at 100% / actual size (not "fit to page"). Let the ink dry before scanning.',
    '<b>Transferred, cured or finished prints:</b> process the sheet exactly like production (pressing, curing, laminating …) and scan the finished product, not the raw print. On textured or uneven surfaces use 3 or more readings per patch.'];
  if (mode === 'spot') tips.push('<b>Spot library:</b> if your RIP imports spot colour libraries (CxF3 is the common standard; Adobe Color Book .acb and VersaWorks .spot are also offered), import the sheet library and enable it before printing, so the patches take the named-colour path. Otherwise unknown spot colours normally print from their L*a*b* alternate – check that the RIP does not substitute or reject them.');
  if (mode === 'rgb') tips.push('<b>Substrate:</b> print on the same substrate colour, with the same underlayers or pre-treatment, as the final job.');
  return tips.map((t) => `<p>${t}</p>`).join('');
}

function matchControls(busyLabel) {
  if (!$('btnMatchMeasure')) return;
  const on = !!state.session?.connected, idle = on && !state.busy;
  const r = currentRound();
  const measured = r ? r.patches.filter((p) => p.lab).length : 0;
  $('btnMatchTarget').disabled = !idle;
  $('btnMatchUseLast').disabled = !state.last || state.busy;
  $('btnMatchSheet').disabled = !match.target || state.busy;
  $('btnMatchMeasure').disabled = !idle || !r;
  $('btnMatchAnalyse').disabled = !r || measured < 5 || state.busy;
  const p = r?.patches[match.next];
  const reading = (n) => (match.reads > 1 ? ` (reading ${n + 1}/${match.reads})` : '');
  $('btnMatchMeasure').textContent = busyLabel ? `${busyLabel}…`
    : !p ? 'Measure patch' : `Measure patch #${p.n}${reading(p.lab ? 0 : p.reads?.length ?? 0)}`;
  $('btnMatchTarget').textContent = `Measure reference${match.refReads.length ? reading(match.refReads.length) : ''}`;
}

function renderMatch() {
  const t = match.target;
  for (const [id, i] of [['mL', 0], ['mA', 1], ['mB', 2]]) if (document.activeElement !== $(id)) $(id).value = t ? t[i].toFixed(2) : '';
  $('mTargetSwatch').style.background = t ? displayHex(t) : '';
  $('mStatusTarget').textContent = t ? displayHex(t) : 'not set';
  $('mMode').value = match.mode; $('mPaper').value = match.paper; $('matchMf').value = match.mf; $('mTol').value = match.tol;
  $('mReads').value = match.reads;
  if (document.activeElement !== $('mSpotName')) $('mSpotName').value = match.spotName;
  $('mSpotNameWrap').classList.toggle('hidden', !isLabMode(match.mode));
  $('mRipFormatWrap').classList.toggle('hidden', !isLabMode(match.mode));
  if (!RIP_EXPORTS[match.ripFormat]) match.ripFormat = 'cxf';
  $('mRipFormat').value = match.ripFormat;
  const fmtLabel = ` (${RIP_EXPORTS[match.ripFormat].label})`;
  $('btnMatchRipSheet').textContent = `Sheet library${fmtLabel}`;
  $('btnLibDownload').textContent = `Download library${fmtLabel}`;
  $('mModeHelp').innerHTML = modeHelp(match.mode);
  $('mPrintTips').innerHTML = printTips(match.mode);
  if (match.refReads.length) $('mStatusTarget').textContent = `reading ${match.refReads.length}/${match.reads} – measure another spot`;

  const r = currentRound();
  $('mRoundLabel').textContent = r ? `· round ${r.round}` : '';
  $('btnMatchSheet').textContent = r ? 'New first sheet' : 'Create sheet';
  $('mSheetActions').classList.toggle('hidden', !r);
  $('btnMatchPdf').textContent = r?.mode === 'rgb' ? 'Download PNG' : 'Download PDF';
  $('btnMatchRipSheet').classList.toggle('hidden', r?.mode !== 'spot');
  if (!t) $('mSheetInfo').textContent = 'Set a reference colour first.';
  else if (!r) $('mSheetInfo').textContent = `Creates a sheet of 16 ${MODE_NAME[match.mode]} patches around a first estimate of the reference.`;
  else {
    const vals = formatValues(r.mode, r.centre, r.kFixed).map(([k, v]) => `${k} ${v}`).join('  ');
    const steps = r.step.map((v, k) => `${MODES[r.mode].axes[k]} ±${fmt1(v)}`).join(', ');
    $('mSheetInfo').innerHTML = `Centre <span class="font-mono">${vals}</span> · steps ${steps}. Download, print and scan the patches below.` +
      (r.mode === 'spot' ? ` Spot names <span class="font-mono">${escapeHtml(r.patches[0].name)}</span> … <span class="font-mono">-16</span>.` : '');
  }

  // patch grid
  const grid = $('mPatchGrid');
  if (!r) grid.innerHTML = '<p class="col-span-4 text-sm text-slate-500">No sheet yet.</p>';
  else {
    grid.innerHTML = r.patches.map((p, i) => {
      const done = !!p.lab;
      const bg = done ? displayHex(p.lab) : patchPreviewHex(r.mode, p.x, r.kFixed);
      const dE = done && t ? deltaE2000(t, p.lab) : null;
      const isNext = i === match.next;
      const partial = !done && p.reads?.length ? `${p.reads.length}/${match.reads}` : '';
      const uneven = done && p.spread > 1.5; // readings disagree – textured / uneven print
      const title = `Patch #${p.n}${p.name ? ' · ' + p.name : ''}${done && p.spread != null && p.reads?.length > 1 ? ` · ${p.reads.length} readings, spread ΔE00 ${p.spread.toFixed(2)}` : ''}${done ? ' – tap to re-measure' : ''}`;
      return `<button type="button" data-patch="${i}" class="text-left rounded-lg p-1.5 ring-1 ${isNext ? 'ring-2 ring-indigo-500' : 'ring-slate-200 dark:ring-slate-800'}" title="${escapeHtml(title)}">
        <div class="h-10 rounded-md ${done ? '' : 'opacity-40'}" style="background:${bg}"></div>
        <div class="flex justify-between text-[11px] mt-1"><b>#${p.n}${uneven ? ' <span class="text-amber-600" title="Readings differ by more than 1.5 ΔE00">!</span>' : ''}</b><span class="font-mono ${dE != null && dE <= match.tol ? 'text-emerald-600' : 'text-slate-500'}">${dE != null ? 'ΔE ' + dE.toFixed(1) : partial}</span></div>
      </button>`;
    }).join('');
  }
  const measured = r ? r.patches.filter((p) => p.lab).length : 0;
  $('mProgress').textContent = r ? `${measured} / ${r.patches.length} measured` : '';
  renderMatchResult();
  renderLibrary();
  updateControls();
}

function renderMatchResult() {
  const r = currentRound();
  const res = r?.result;
  $('mResultCard').classList.toggle('hidden', !res);
  if (!res) return;
  const within = res.predictedDeltaE <= match.tol && !res.extrapolated;
  const verified = r.round > 1 && res.centreDE != null && res.centreDE <= match.tol;
  $('btnMatchAddLib').classList.toggle('hidden', !isLabMode(r.mode));
  const cells = formatValues(r.mode, res.x, r.kFixed)
    .map(([k, v]) => `<div class="rounded-lg bg-slate-100 dark:bg-slate-800 px-3 py-2 text-center"><div class="text-[10px] text-slate-500">${k}</div><div class="font-mono text-xl tabular-nums">${v}</div></div>`).join('');
  const prevVals = formatValues(r.mode, r.centre, r.kFixed).map(([k, v]) => `${k} ${v}`).join(' ');
  $('mResult').innerHTML = `
    ${verified ? `<div class="rounded-lg bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 p-3 text-sm"><b>Done.</b> The previous round's values (<span class="font-mono">${prevVals}</span>) printed within tolerance – centre patch ΔE00 ${res.centreDE.toFixed(2)}. Use those, or the refined values below.</div>` : ''}
    <p class="text-sm text-slate-500">${{
    spot: `Enter these L*a*b* values for the named colour${match.spotName ? ` <b>${escapeHtml(match.spotName)}</b>` : ''} in the RIP’s spot colour library:`,
    lab: 'Use these L*a*b* values for the colour in your document:',
    cmyk: 'Use these CMYK values for the colour in your document:',
    rgb: 'Use this sRGB colour in your artwork:',
  }[r.mode]}</p>
    <div class="grid ${isLabMode(r.mode) ? 'grid-cols-3' : 'grid-cols-4'} gap-2">${cells}</div>
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="rounded-md px-2 py-0.5 text-xs font-bold text-white ${within ? 'bg-emerald-600' : 'bg-amber-500'}">${within ? 'EXPECTED MATCH' : 'NEEDS ANOTHER ROUND'}</span>
      <span>predicted ΔE00 <b class="tabular-nums">${res.predictedDeltaE.toFixed(2)}</b>${res.extrapolated ? ' (rough estimate)' : ''} (tolerance ${match.tol})</span>
    </div>
    ${res.extrapolated ? '<p class="text-xs text-amber-600">The answer lies outside this sheet’s patch range, so the prediction is only a rough estimate. The refinement sheet is centred on it and will confirm.</p>' : ''}
    ${res.clamped ? '<p class="text-xs text-amber-600">Some values reached their limit – the reference may be outside the colours this printer and paper can produce. These are the closest reachable values.</p>' : ''}
    <dl class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
      <div><dt class="text-slate-500">Centre patch</dt><dd class="font-mono">ΔE00 ${res.centreDE != null ? res.centreDE.toFixed(2) : '–'}</dd></div>
      <div><dt class="text-slate-500">Best patch</dt><dd class="font-mono">#${res.best.n} · ΔE00 ${res.best.dE.toFixed(2)}</dd></div>
      <div><dt class="text-slate-500">Model fit (rms)</dt><dd class="font-mono">${res.rms.toFixed(2)} ΔE</dd></div>
      <div><dt class="text-slate-500">Repeatability</dt><dd class="font-mono">${res.repeatability != null ? 'ΔE00 ' + res.repeatability.toFixed(2) : '–'}</dd></div>
    </dl>
    <p class="text-xs text-slate-500">${within ? 'Print the colour with these values to confirm – or make a refinement sheet: its centre patch uses them and verifies the result.' : 'Make a refinement sheet: it is centred on these values with smaller steps.'}</p>`;
  $('mHistory').innerHTML = `
    <table class="w-full text-xs mt-2"><thead class="text-slate-500"><tr><th class="text-left">Round</th><th class="text-left">Sheet centre</th><th class="text-left">Centre ΔE00</th><th class="text-left">Predicted ΔE00</th></tr></thead><tbody>
    ${match.rounds.map((rr) => `<tr class="border-t border-slate-200 dark:border-slate-800"><td class="py-1">${rr.round}</td><td class="font-mono">${formatValues(rr.mode, rr.centre, rr.kFixed).map(([k, v]) => `${k}${v}`).join(' ')}</td><td class="font-mono">${rr.result?.centreDE != null ? rr.result.centreDE.toFixed(2) : '–'}</td><td class="font-mono">${rr.result ? rr.result.predictedDeltaE.toFixed(2) : '–'}</td></tr>`).join('')}
    </tbody></table>`;
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
  // Formats with 8-bit Lab (Adobe Color Book) round the values: say what that costs for this library.
  let note = '';
  if (n && ex.quantize) {
    const worst = Math.max(...spotLib.colours.map((c) => deltaE2000(c.lab, ex.quantize(c.lab))));
    note = `${ex.label} stores L* in steps of 0.4 and a*/b* as whole numbers – the largest rounding in this library is ΔE00 ${worst.toFixed(2)}. For full precision use CxF3 or type the values into the RIP.`;
  }
  $('mLibNote').textContent = note;
  $('mLibNote').className = `text-xs ${note && /ΔE00 ([\d.]+)/.exec(note)[1] > match.tol / 2 ? 'text-amber-600' : 'text-slate-500'}`;
}

/** Add the current result to the spot library under the spot colour name (replacing a colour with the same name). */
function addResultToLibrary() {
  const r = currentRound();
  if (!r?.result || !isLabMode(r.mode)) return;
  let name = match.spotName.trim();
  if (!name) {
    name = (prompt('Spot colour name – exactly as it is named in your artwork and the RIP:') ?? '').trim();
    if (!name) return;
    match.spotName = name; saveMatch();
  }
  if (putInLibrary({ name, lab: r.result.x, target: match.target, predictedDeltaE: r.result.predictedDeltaE, mf: match.mf })) {
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
  if (!lib.colours.length) { toast(`No usable L*a*b* (D50 / 2°) colours in ${file.name}.`, 'error'); return; }
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
  return { lab, spectrum: rec.spectrum };
}

function setMatchTarget(lab) {
  const hasWork = match.rounds.some((r) => r.patches.some((p) => p.lab));
  if (hasWork && !confirm('Changing the reference colour starts the matching over. Continue?')) { renderMatch(); return false; }
  match.target = lab.map((v) => Math.round(v * 100) / 100);
  match.rounds = []; match.next = 0; match.refReads = [];
  saveMatch(); renderMatch();
  return true;
}

function measureMatchTarget() {
  return task('Measuring reference', async () => {
    const m = await measureLabD50();
    if (!m) return;
    match.refReads = [...match.refReads, m.lab];
    if (match.refReads.length < match.reads) {
      saveMatch(); renderMatch();
      toast(`Reading ${match.refReads.length}/${match.reads} – move the SD-10 to another spot on the reference and measure again.`);
      return;
    }
    const { lab, spread } = averageReadings(match.refReads);
    match.refReads = [];
    if (setMatchTarget(lab)) toast(`Reference colour measured${match.reads > 1 ? ` – mean of ${match.reads} readings, spread ΔE00 ${spread.toFixed(2)}` : ''}`, 'ok');
    else saveMatch();
  });
}

function createSheet(centre, step, kFixed) {
  const round = (currentRound()?.round ?? 0) + 1;
  match.jobId ??= newJobId();
  const patches = designPatches(match.mode, centre, step)
    .map((p) => (match.mode === 'spot' ? { ...p, name: patchSpotName(match.jobId, round, p.n) } : p));
  match.rounds.push({ round, mode: match.mode, centre, step, kFixed, patches, result: null });
  match.next = 0;
  saveMatch(); renderMatch();
}

async function startFirstSheet() {
  if (!match.target) return;
  if (currentRound() && !confirm('Start again with a new first sheet? Measurements of the current sheets are discarded.')) return;
  match.rounds = [];
  match.jobId = newJobId(); // fresh spot names, so libraries imported for an earlier job cannot clash
  try {
    if (match.mode === 'cmyk') {
      const profile = await loadProfile(settingsFromUI().cmykProfile);
      const cmyk = profile.fromLab(match.target, 0).map((v) => Math.round(Math.min(v, 100) * 10) / 10);
      createSheet(cmyk.slice(0, 3), [...MODES.cmyk.step0], cmyk[3]);
    } else if (match.mode === 'rgb') {
      createSheet(labD50ToSrgb(match.target).rgb, [...MODES.rgb.step0], 0);
    } else {
      createSheet([...match.target], [...MODES[match.mode].step0], 0);
    }
    toast('Sheet created – download and print it.', 'ok');
  } catch (e) {
    toast(`Could not create the sheet: ${e.message}`, 'error');
  }
}

function downloadFile(data, type, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function downloadSheet() {
  const r = currentRound();
  if (!r) return;
  const opts = { mode: r.mode, patches: r.patches, target: match.target, round: r.round, paper: match.paper, kFixed: r.kFixed };
  if (r.mode === 'rgb') {
    try { downloadFile(await buildSheetPng(opts), 'image/png', `sd10-print-match-round${r.round}.png`); } catch (e) { toast(e.message, 'error'); }
  } else downloadFile(buildSheetPdf(opts), 'application/pdf', `sd10-print-match-round${r.round}.pdf`);
}

const safeFileName = (s) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'spot';

/** Spot colour library for the RIP: the current sheet's patch colours ('sheet') or the collected spot library ('library'). */
function downloadRipLibrary(what, rip = match.ripFormat) {
  const r = currentRound();
  const ex = RIP_EXPORTS[rip];
  if (!ex) return;
  if (what === 'sheet' && r) {
    const text = ex.build({ library: `SD10 ${match.jobId} round ${r.round}`, description: 'Print match test sheet patches, CIE L*a*b* D50/2°',
      colours: r.patches.map((p) => ({ name: p.name, lab: p.x })) });
    downloadFile(text, ex.mime, `sd10-${match.jobId}-round${r.round}.${ex.ext}`);
  } else if (what === 'library' && spotLib.colours.length) {
    const library = spotLib.name.trim() || 'SD-10 spot colours';
    const description = `${spotLib.colours.length} colour(s) matched with SD-10 Print match, CIE L*a*b* D50/2°`;
    downloadFile(ex.build({ library, description, colours: spotLib.colours.map((c) => ({ name: c.name, lab: c.lab })) }), ex.mime, `${safeFileName(library)}.${ex.ext}`);
  }
}

function measurePatch() {
  const r = currentRound();
  if (!r) return;
  const idx = match.next;
  return task(`Measuring #${r.patches[idx].n}`, async () => {
    // Demo: the simulated SD-10 "sees" what a simulated printer would print for this patch.
    if (DEMO && state.transport?.setSpectrumOverride) {
      const p = r.patches[idx];
      const lab = r.mode === 'rgb' ? srgbToLabD50(p.x) : p.x;
      const cmyk = r.mode === 'cmyk' ? [...p.x, r.kFixed] : (await loadProfile(settingsFromUI().cmykProfile)).fromLab(lab, 0);
      state.transport.setSpectrumOverride(printSpectrum(cmyk));
    }
    let m;
    try { m = await measureLabD50(); } finally { state.transport?.setSpectrumOverride?.(null); }
    if (!m) return;
    const p = r.patches[idx];
    if (p.lab) { p.lab = null; p.reads = []; p.spread = null; } // measuring a finished patch again starts it over
    p.reads = [...(p.reads ?? []), m.lab];
    r.result = null;
    if (p.reads.length < match.reads) {
      saveMatch(); renderMatch();
      toast(`Reading ${p.reads.length}/${match.reads} – move the SD-10 to another spot on patch #${p.n}.`);
      return;
    }
    Object.assign(p, averageReadings(p.reads));
    const after = r.patches.findIndex((p, i) => i > idx && !p.lab);
    const any = r.patches.findIndex((p) => !p.lab);
    match.next = after >= 0 ? after : any >= 0 ? any : idx;
    saveMatch();
    if (r.patches.every((p) => p.lab)) analyseMatch(); else renderMatch();
  });
}

function analyseMatch() {
  const r = currentRound();
  try {
    const a = analyseRound(r, match.target);
    r.result = { x: a.x, predicted: a.predicted, predictedDeltaE: a.predictedDeltaE, clamped: a.clamped, correction: a.correction, extrapolated: a.extrapolated,
      best: { n: a.best.n, dE: a.best.dE }, centreDE: a.centreDE, repeatability: a.repeatability, rms: a.model.rms };
    saveMatch();
    renderMatch();
    $('mResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    toast(e.message, 'error');
  }
}

function refineMatch() {
  const r = currentRound();
  if (!r?.result) return;
  createSheet(r.result.x, nextStep(r.mode, r.step, r.result.correction), r.kFixed);
  toast(`Round ${r.round + 1} sheet created – download and print it.`, 'ok');
  $('mSheetInfo').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function copyMatchValues() {
  const r = currentRound();
  if (!r?.result) return;
  const text = (r.mode === 'spot' && match.spotName ? `${match.spotName} – ` : '') + `${{ spot: 'L*a*b*', lab: 'L*a*b*', cmyk: 'CMYK', rgb: 'sRGB' }[r.mode]}: ` + formatValues(r.mode, r.result.x, r.kFixed).map(([k, v]) => `${k} ${v}`).join(', ') +
    ` (predicted ΔE00 ${r.result.predictedDeltaE.toFixed(2)} to reference L*a*b* ${match.target.map((v) => v.toFixed(2)).join(' / ')})`;
  navigator.clipboard?.writeText(text).then(() => toast('Values copied', 'ok'), () => toast('Clipboard not available', 'error'));
}

function initMatch() {
  for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => setView(b.dataset.view);
  $('btnMatchTarget').onclick = measureMatchTarget;
  $('btnMatchUseLast').onclick = () => { if (state.last) setMatchTarget(spectrumToLab(state.last.spectrum, 0, 2)); };
  for (const id of ['mL', 'mA', 'mB']) {
    $(id).addEventListener('change', () => {
      const v = ['mL', 'mA', 'mB'].map((k) => parseFloat($(k).value));
      if (v.every(Number.isFinite)) setMatchTarget([Math.min(Math.max(v[0], 0), 100), Math.min(Math.max(v[1], -128), 127), Math.min(Math.max(v[2], -128), 127)]);
    });
  }
  $('mMode').onchange = () => {
    if (currentRound() && !confirm('Changing the sheet type starts the matching over. Continue?')) { $('mMode').value = match.mode; return; }
    match.mode = $('mMode').value; match.rounds = []; match.next = 0; saveMatch(); renderMatch();
  };
  $('mPaper').onchange = () => { match.paper = $('mPaper').value; saveMatch(); };
  $('matchMf').onchange = () => { match.mf = +$('matchMf').value; saveMatch(); };
  $('mReads').onchange = () => { match.reads = Math.min(Math.max(+$('mReads').value || 1, 1), 9); match.refReads = []; saveMatch(); renderMatch(); };
  $('mSpotName').onchange = () => { match.spotName = $('mSpotName').value.trim(); saveMatch(); renderMatch(); };
  $('mRipFormat').onchange = () => { match.ripFormat = $('mRipFormat').value; saveMatch(); renderMatch(); };
  $('btnMatchRipSheet').onclick = () => downloadRipLibrary('sheet');
  $('btnMatchAddLib').onclick = addResultToLibrary;
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
  $('btnMatchSheet').onclick = startFirstSheet;
  $('btnMatchPdf').onclick = downloadSheet;
  $('btnMatchRestart').onclick = () => { if (confirm('Discard all sheets and measurements for this reference?')) { match.rounds = []; match.next = 0; saveMatch(); renderMatch(); } };
  $('btnMatchMeasure').onclick = measurePatch;
  $('btnMatchAnalyse').onclick = analyseMatch;
  $('btnMatchRefine').onclick = refineMatch;
  $('btnMatchCopy').onclick = copyMatchValues;
  $('mPatchGrid').onclick = (e) => {
    const b = e.target.closest('[data-patch]');
    if (!b) return;
    match.next = +b.dataset.patch; saveMatch(); renderMatch();
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
