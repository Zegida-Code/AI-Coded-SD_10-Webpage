// SD-10 Web Console – Console view (device connection, measuring, history, palettes, settings, log) and start-up.
// The Print match view is in match-view.js (which also switches views), the 3-D Color space view in space-view.js,
// the debug report in debug.js; shared DOM helpers are in ui.js.
import { BleTransport } from './transport.js';
import { MockTransport, SAMPLES } from './mock.js';
import { SD10Session, DeviceError } from './session.js';
import {
  AUTO_POWER_OFF, BUZZER, DIFF_FORMULAS, EVENT, LANGUAGES, LIGHT_SOURCES, LIGHT_SOURCE_NAME, METHOD, PANEL_DIRECTION,
  WAVELENGTHS, hex,
} from './protocol.js';
import { deltaE, describeSpectrum, meanSpectrum, medianLab, spectrumToLab, wavelengthColor, labToLch } from './color.js';
import { history as historyStore, prefs as prefStore } from './storage.js';
import { CMYK_PROFILES, CUSTOM_PREFIX, customProfiles, loadProfile, printerProfiles } from './icc.js';
import { $, DEMO, NEEDS_CALIBRATION, displayHex, downloadFile, escapeHtml, fmt, onFilePicked, readFlag, toast, writeFlag } from './ui.js';
import { initMatch, matchControls, onMatchButton } from './match-view.js';
import { buildDebugReport, debugLog, installDebugCapture } from './debug.js';

installDebugCapture(); // before anything else, so start-up errors are in the debug report too

/** The app's default CMYK output profile (as in the Android app). */
const DEFAULT_CMYK_PROFILE = 'EpsonWideCMYK_Ver2';

const state = {
  session: null,
  transport: null,
  demo: false,
  busy: false,
  status: null, // last parsed device status
  statusDirty: false, // a status-changed event arrived while busy; refreshed once idle
  info: null, // { model, serial, firmware } from the handshake
  settings: null, // device settings as last read
  view: 'console', // 'console' | 'match' | 'space'
  mode: 'spot', // Console measuring mode: 'spot' | 'compare' | 'line'
  last: null, // result on screen: { spectrum, lab, d, strip, itemId, cmyk }
  lastLabD50: null, // newest color measured or shown (Lab D50/2°), for "Use last measurement" in Print match …
  lastSpectrum: null, // … and its spectrum
  reference: null, // Compare reference: { spectrum, id }
  chartArgs: null, // last drawChart() arguments, redrawn on resize
  history: historyStore.load(),
  checked: new Set(),
  prefs: prefStore.load({ mFactor: 1, lightSource: 0, observer: 2, readings: 1, formula: 0, threshold: 1, patches: 6, mode: 'spot', cmykProfile: DEFAULT_CMYK_PROFILE, cmykIntent: 0 }),
};

// ------------------------------------------------------------------ helpers
function fill(select, map) {
  select.innerHTML = Object.entries(map).map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
}

function settingsFromUI() {
  return {
    mFactor: +$('mMf').value, lightSource: +$('mIll').value, observer: +$('mObs').value, readings: +$('mReadings').value,
    formula: +$('mFormula').value, threshold: Math.min(Math.max(+$('mThr').value || 0, 0), 20),
    patches: Math.min(Math.max(Math.round(+$('mPatches').value || 1), 1), 18), mode: state.mode,
    // the profile list is filled asynchronously (custom profiles live in IndexedDB): keep the saved choice until then
    cmykProfile: ($('cmykProfile').options.length && $('cmykProfile').value) || state.prefs.cmykProfile || DEFAULT_CMYK_PROFILE,
    cmykIntent: +$('cmykIntent').value || 0,
  };
}

function savePrefs() { state.prefs = settingsFromUI(); prefStore.save(state.prefs); }

async function task(label, fn) {
  if (state.busy) { toast('Device is busy…'); return; }
  state.busy = true;
  updateControls(label);
  const started = performance.now();
  debugLog('task', `${label} started`);
  try {
    const result = await fn();
    debugLog('task', `${label} done`, { ms: Math.round(performance.now() - started) });
    return result;
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
  if (cls === 'err') debugLog('device', text);
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

/**
 * Save a debug report (see debug.js) with the Console's side of things: connection, device, its status and settings,
 * the result on screen, the stored ICC profiles and the protocol log.
 */
async function saveDebugReport() {
  const note = prompt('What happened, or what did you expect? (optional)\n\nThe report holds this page’s recent actions and messages, what it shows, its settings, measurements and color data, and the device and browser details – no passwords or personal details.', '');
  if (note === null) return;
  const names = async (store) => { try { return await store.list(); } catch { return []; } };
  const report = buildDebugReport({
    note: note.trim(),
    app: {
      view: state.view, demo: state.demo, connected: !!state.session?.connected, busy: state.busy, consoleMode: state.mode,
      device: state.info, deviceStatus: state.status, deviceSettings: state.settings, settings: settingsFromUI(),
      lastResult: state.last && { lab: state.last.lab, cmyk: state.last.cmyk, spectrum: state.last.spectrum },
      iccProfiles: { cmyk: await names(customProfiles), printer: await names(printerProfiles) },
      protocolLog: [...logEl.children].slice(-1500).map((l) => l.textContent),
    },
  });
  const now = new Date(), two = (v) => String(v).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`; // local time
  downloadFile(JSON.stringify(report, null, 1), 'application/json', `sd10-debug-${stamp}.json`);
  toast('Debug report saved – share the file to get help.', 'ok');
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
  // the simulator (?demo) works without Web Bluetooth
  $('btnConnect').disabled = on || state.busy || (!DEMO && !BleTransport.supported);
  $('btnConnectMenu').disabled = on || state.busy || !BleTransport.supported;
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
    if (s.calibrationStatus !== 2) { toast(NEEDS_CALIBRATION, 'error'); return; }
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
  }
  showResult({ spectrum, lab, item });
  if (capturingReference) toast('Reference captured – now measure the sample to compare against it.', 'ok');
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
    return;
  }
  if (code !== EVENT.BUTTON || state.busy) return;
  if (state.view !== 'console') { onMatchButton(); return; } // Print match / Color space
  // Console: the app reads the device's mode; group modes come from the device, otherwise use the UI mode.
  const mode = await state.session.getMode().catch(() => null);
  if (mode?.method === METHOD.CALIBRATION) return task('Calibrating', doCalibrate);
  onMeasureButton();
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
  state.lastLabD50 = spectrumToLab(spectrum, 0, 2); // newest color on screen, for "Use last measurement" in Print match
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
    const hexc = displayHex(spectrumToLab(it.spectrum, 0, 2));
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
 * Make this color the comparison reference and switch to the Compare tab.
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
  downloadFile(csv, 'text/csv', `sd10-measurements-${new Date().toISOString().slice(0, 10)}.csv`);
}

// Like the app's device.last_color_info_id: per-serial cursor of the newest record imported from the device.
// It starts at 0 (= everything) and only advances on imports, never on measurements taken in this app.
const CURSOR_PREFIX = 'sd10.historyCursor.';
const cursorKey = () => `${CURSOR_PREFIX}${state.info?.serial || 'unknown'}`;
function loadCursor() { try { return Number(localStorage.getItem(cursorKey())) || 0; } catch { return 0; } }
function saveCursor(v) { try { localStorage.setItem(cursorKey(), String(v)); } catch { /* ignore */ } }
/** Forget every device's sync position, so the next sync re-imports everything still stored on the device. */
function resetCursors() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(CURSOR_PREFIX)) localStorage.removeItem(k);
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
    const sw = g.labs.slice(0, 12).map((lab) => `<span class="h-4 w-4 rounded-sm border border-slate-200 dark:border-slate-700" style="background:${displayHex(lab)}"></span>`).join('');
    return `<li class="rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2">
      <div class="flex items-center justify-between"><span class="font-medium">Slot ${slot} · ${escapeHtml(g.name || '(unnamed)')}</span>
      <button class="text-xs text-rose-600 hover:underline" data-delslot="${slot}">delete</button></div>
      <div class="flex flex-wrap gap-1 mt-1">${sw}${g.labs.length > 12 ? `<span class="text-xs text-slate-500">+${g.labs.length - 12}</span>` : ''}</div>
      <p class="text-xs text-slate-500 mt-1">${g.labs.length} colors · ${LIGHT_SOURCE_NAME[g.lightSource] ?? g.lightSource}/${g.viewingAngle}° · M${g.mFactor} · ${DIFF_FORMULAS[g.colorDiffFormula] ?? ''} ≤ ${fmt(g.threshold, 1)}</p></li>`;
  }).join('');
}

async function writeGroup() {
  const items = state.history.filter((h) => state.checked.has(h.id));
  if (!items.length) return;
  if (items.length > 80) { toast('A device palette holds at most 80 colors.', 'error'); return; }
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

// ------------------------------------------------------------------ CMYK profiles
/** The remove button only applies to profiles the user added. */
function syncRemoveIccButton() {
  $('btnRemoveIcc').classList.toggle('hidden', !$('cmykProfile').value.startsWith(CUSTOM_PREFIX));
}

async function refreshProfileList(selected) {
  const custom = await customProfiles.list();
  const opt = (v, t) => `<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`;
  $('cmykProfile').innerHTML =
    `<optgroup label="App profiles">${Object.keys(CMYK_PROFILES).map((k) => opt(k, k + (k === DEFAULT_CMYK_PROFILE ? ' (app default)' : ''))).join('')}</optgroup>` +
    (custom.length ? `<optgroup label="Your profiles">${custom.map((n) => opt(CUSTOM_PREFIX + n, n)).join('')}</optgroup>` : '');
  const ok = [...$('cmykProfile').options].some((o) => o.value === selected);
  $('cmykProfile').value = ok ? selected : DEFAULT_CMYK_PROFILE;
  syncRemoveIccButton();
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
  await refreshProfileList(DEFAULT_CMYK_PROFILE);
  savePrefs();
}

function setLogOpen(open) {
  $('logBody').classList.toggle('hidden', !open);
  $('logTools').classList.toggle('hidden', !open);
  $('logTools').classList.toggle('flex', open);
  $('logChevron').classList.toggle('rotate-90', open);
  $('btnToggleLog').setAttribute('aria-expanded', String(open));
  writeFlag('sd10.logOpen', open);
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
  $('acceptAll').checked = readFlag('sd10.acceptAll');
  const syncDot = () => $('acceptAllDot').classList.toggle('hidden', !$('acceptAll').checked);
  syncDot();
  $('acceptAll').onchange = () => { syncDot(); writeFlag('sd10.acceptAll', $('acceptAll').checked); };
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
      syncRemoveIccButton();
      savePrefs();
      if (state.last) updateCmyk(state.last.spectrum);
    });
  }
  $('btnAddIcc').onclick = () => $('iccFile').click();
  onFilePicked('iccFile', addIccProfile);
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
  setLogOpen(readFlag('sd10.logOpen'));
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
  $('btnDebugReport').onclick = saveDebugReport;

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
  initMatch({ state, task, settingsFromUI, updateControls, doCalibrate });
  updateControls();
}

init();
