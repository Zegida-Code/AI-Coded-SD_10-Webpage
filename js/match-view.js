// Print match view: find the values that make the user's printer reproduce reference colours – reference colours,
// test sheets (PDF / PNG), scanning the printed patches, per-colour results with metamerism and gamut checks, the
// printer's colour space (charts, predictions, learning) and the spot colour library. The maths is in match.js and
// colorspace.js, the library file formats in rip-export.js; this is the UI. It also owns the colour spaces that the
// 3-D Colour space view (space-view.js) shows, and switches between the views.
// It shares the Console's device session: app.js hands over its state and helpers once, through initMatch().
//
// Sections: stored data · what the cards work on · formatting · views · media sizes · printer profile (gamut check) ·
// rendering · measuring · sheets · spot library · colour space · start-up.
import { $, DEMO, NEEDS_CALIBRATION, displayHex, downloadFile, escapeHtml, onFilePicked, readFlag, round2, safeFileName, toast, writeFlag } from './ui.js';
import { METHOD } from './protocol.js';
import { deltaE2000, labD50ToSrgb, meanSpectrum, rgbHex, spectrumToLab, srgbToLabD50 } from './color.js';
import { CUSTOM_PREFIX, PRINTER_PREFIX, loadProfile, printerProfiles } from './icc.js';
import {
  DESIGNS, DE_FORMULAS, MEDIA, MODES, MODE_NAME, analyseRound, averageReadings, buildSheetPdf, buildSheetPng, designPatches,
  metamerism, minSheetHeight, nextStep, patchSpotName, sheetLayout,
} from './match.js';
import { RIP_EXPORTS, readLibrary } from './rip-export.js';
import {
  CHART_SIZES, SPACE_MIN_POINTS, chartSpotName, designChart, driftOf, invert, keepFrom, learn, newSpace, newSpaceId, pointX,
  readSpaceFile, removeSession, sessionSize, spaceStats, spaceToCgats, spaceToJson,
} from './colorspace.js';
import { printSpectrum } from './printer-sim.js';
import { debugLog } from './debug.js';
import { hideSpaceView, initSpaceView, showSpaceView } from './space-view.js';

// From the Console (set by initMatch): shared state, the busy-guarded task runner, the Console's settings (for the
// CMYK profile), the control refresh and white calibration.
let state, task, settingsFromUI, updateControls, doCalibrate;

// ---------------------------------------------------------------- stored data
function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}
/** Store a value; false when the browser storage is full or blocked. */
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

// Persisted job (localStorage 'sd10.match'):
//   settings: mode, media ('custom' | a preset 'a4' … | 'size:<name>' for a saved size), mediaW/mediaH (mm – the size
//             in use, also for presets), patchMm,
//             design ('full' | 'compact'), mf, tol, reads, ripFormat
//   formula (DE_FORMULAS key), printerProfile (name of a stored printer profile for the gamut check, '' = none)
//   space (id of the colour space in use, '' = none), learn (add scanned test-sheet patches to it),
//   chartActive (the sheet and scan cards show the colour space's chart instead of the selected colour)
//   colours: [{ id, code, name, target, targetSpectrum, refReads, refSpectra, accepted, next,
//               rounds: [{ round, mode, centre, step, kFixed, design,
//                          patches: [{ n, offset, x, name?, reads, spectra, lab, spread, spectrum }], result,
//                          fromSpace? ({ name, dE } – the first sheet started from the colour space's prediction) }] }]
//   active (index of the selected colour)
// Every colour is matched on its own: its own sheets (one per round), scan position (next = patch index) and result.
// The sheet, scan and result cards always work on the selected colour, so several colours can be in progress at once.
// code: 4 characters in the colour's patch spot names (SD10-<code>-R<round>-<n>), new for every fresh start.
const MATCH_KEY = 'sd10.match';
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const newCode = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const newColour = () => ({ id: newId(), code: newCode(), name: '', target: null, targetSpectrum: null, refReads: [], refSpectra: [], accepted: false, next: 0, rounds: [] });
const match = (() => {
  const m = loadJson(MATCH_KEY, {});
  if (!m.colours && (m.target || m.rounds?.length)) {
    // single-colour job saved by an earlier version: becomes the first colour
    m.colours = [{ id: newId(), name: m.spotName ?? '', target: m.target ?? null, refReads: m.refReads ?? [], accepted: false, next: m.next ?? 0, rounds: m.rounds ?? [] }];
    if (m.paper) m.media = m.paper;
    for (const k of ['target', 'rounds', 'spotName', 'refReads', 'paper']) delete m[k];
  }
  // jobs saved while all colours shared one sheet: give each colour its own code and scan position
  for (const c of m.colours ?? []) {
    c.code ??= m.jobId && c === m.colours[0] ? m.jobId : newCode();
    c.next ??= m.next?.c === c.id ? m.next.i : 0;
  }
  for (const k of ['sheet', 'next', 'jobId']) delete m[k];
  const out = { mode: 'spot', media: 'custom', mediaW: 210, mediaH: 297, patchMm: 20, design: 'full', mf: 1, tol: 1, reads: 1,
    formula: 'de00', printerProfile: '', ripFormat: 'cxf', space: '', learn: true, chartActive: false, colours: [], active: 0, ...m };
  if (!out.colours.length) out.colours = [newColour()];
  return out;
})();
const saveMatch = () => saveJson(MATCH_KEY, match);

// Media sizes the user saved: [{ name, w, h }] (mm) – kept in this browser, independent of the current job.
const SIZES_KEY = 'sd10.mediaSizes';
const SIZE_PREFIX = 'size:';
const PRESET_NAMES = { a4: 'A4', letter: 'Letter', a3: 'A3', tabloid: 'Tabloid' };
const savedSizes = loadJson(SIZES_KEY, []);
const saveSizes = () => saveJson(SIZES_KEY, savedSizes);
// the boxes show the size in use: a preset's or saved size's own; a deleted saved size becomes custom
if (match.media !== 'custom') {
  const size = mediaSizeOf(match.media);
  if (size) [match.mediaW, match.mediaH] = size; else match.media = 'custom';
}

// Spot library: { name, colours: [{ name, lab, target, predictedDeltaE, mf, time }] } – independent of the current job.
const LIB_KEY = 'sd10.spotLibrary';
const DEFAULT_LIBRARY_NAME = 'SD-10 spot colours';
const spotLib = { name: DEFAULT_LIBRARY_NAME, colours: [], ...loadJson(LIB_KEY, {}) };
const saveLib = () => saveJson(LIB_KEY, spotLib);

// Colour spaces (see colorspace.js): measured maps of what a printer, ink and media really print, independent of the
// current job. The one in use (match.space) predicts the first-sheet values for the sheet type it was measured with,
// and learns from every scanned patch. A chart being scanned (space.chart) has the shape of a colour with one round –
// { id, code, name, target: null, next, rounds: [{ round, mode, kind, kFixed, patches, chart: true }] } – so the sheet
// and scan cards handle it like a colour's sheet.
const SPACES_KEY = 'sd10.colourSpaces';
const spaces = loadJson(SPACES_KEY, []);
let spaceStorageWarned = false;
function saveSpaces() {
  if (saveJson(SPACES_KEY, spaces) || spaceStorageWarned) return;
  spaceStorageWarned = true;
  toast('The browser storage is full – colour space changes are kept for this session only. Export the colour space to keep it.', 'error');
}

/** Save the job – and the colour spaces, when they changed too – and redraw the view. */
function commit({ withSpaces = false } = {}) {
  saveMatch();
  if (withSpaces) saveSpaces();
  renderMatch();
}

// ---------------------------------------------------------------- what the cards work on
const activeColour = () => match.colours[match.active] ?? match.colours[0];
const latest = (c) => c.rounds[c.rounds.length - 1] ?? null;
const colourLabel = (c) => c.name || `Colour ${match.colours.indexOf(c) + 1}`;
const activeSpace = () => spaces.find((s) => s.id === match.space) ?? null;
/** The colour space that predicts for the current sheet type – null for none, or one measured with another sheet type. */
const usableSpace = () => { const s = activeSpace(); return s && s.mode === match.mode ? s : null; };
/** The colour space's chart while it is selected in the colour list, else null. */
const activeChart = () => (match.chartActive && activeSpace()?.chart) || null;
const isChart = (c) => !!c?.rounds?.[0]?.chart;
/** What the sheet and scan cards work on: the colour space's chart while it is selected, else the selected colour. */
const workItem = () => activeChart() ?? activeColour();
/** The work item and its current round (latest sheet) – what the sheet, scan and result cards work on – or null. */
const currentSheet = () => { const c = workItem(), r = latest(c); return r ? { c, r } : null; };
const scannedCount = (r) => r.patches.filter((p) => p.lab).length;
/** Index of the patch to measure next: the colour's scan position, or else its first unmeasured patch. */
const nextPatchIndex = (c, r) => (r.patches[c.next] ? c.next : Math.max(0, r.patches.findIndex((p) => !p.lab)));
/** A colour's (or the chart's) round as a sheet-layout group. */
const sheetGroup = (c, r) => ({ label: colourLabel(c), target: c.target, patches: r.patches, kFixed: r.kFixed });
/** Title printed on a sheet (the default for a colour's test sheet). */
const sheetTitle = (c) => (isChart(c) ? 'SD-10 colour space chart' : undefined);
/** The colour difference formula chosen for judging matches: { label, name, fn(ref, sample), lWeight }. */
const DE = () => DE_FORMULAS[match.formula] ?? DE_FORMULAS.de00;

// ---------------------------------------------------------------- formatting
const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const roundSpectrum = (s) => s.map((v) => Math.round(v * 1e5) / 1e5);
const isLabMode = (mode) => mode === 'spot' || mode === 'lab';

function cmykPreviewHex([c, m, y], k) {
  const ch = (v) => Math.round(255 * (1 - v / 100) * (1 - k / 100));
  return rgbHex([ch(c), ch(m), ch(y)]);
}
function patchPreviewHex(mode, x, k) {
  return mode === 'cmyk' ? cmykPreviewHex(x, k) : mode === 'rgb' ? rgbHex(x) : displayHex(x);
}
/** A sheet type's values as [label, text] pairs (CMYK with its K, RGB with its hex). */
function formatValues(mode, x, k) {
  if (mode === 'cmyk') return [['C', fmt1(x[0])], ['M', fmt1(x[1])], ['Y', fmt1(x[2])], ['K', fmt1(k)]];
  if (mode === 'rgb') return [['R', String(x[0])], ['G', String(x[1])], ['B', String(x[2])], ['HEX', rgbHex(x)]];
  return [['L*', fmt1(x[0])], ['a*', fmt1(x[1])], ['b*', fmt1(x[2])]];
}
/** Values as tiles – large in a result, smaller in the colour space prediction. */
function valueTilesHtml(mode, x, k, { large = false } = {}) {
  const tiles = formatValues(mode, x, k).map(([key, v]) => `<div class="rounded-lg bg-slate-100 dark:bg-slate-800 ${large ? 'px-3 py-2' : 'px-2 py-1.5'} text-center"><div class="text-[10px] text-slate-500">${key}</div><div class="font-mono ${large ? 'text-xl ' : ''}tabular-nums">${v}</div></div>`).join('');
  return `<div class="grid ${isLabMode(mode) ? 'grid-cols-3' : 'grid-cols-4'} gap-2${large ? '' : ' max-w-md'}">${tiles}</div>`;
}

function modeHelp(mode) {
  const profile = escapeHtml(settingsFromUI().cmykProfile.replace(CUSTOM_PREFIX, ''));
  return {
    spot: 'For RIPs and workflows that colour named spot colours from an L*a*b* library. Every patch is a uniquely named spot colour with its L*a*b* value as the alternate, so the RIP handles the sheet like the spot colours in your artwork. Enter the result as the L*a*b* value of your named colour in the RIP.',
    lab: 'Patches are plain CIE L*a*b* objects. This only matches a spot colour workflow if the RIP converts Lab objects with the same profile and rendering intent as named colours – otherwise use spot colours.',
    cmyk: `For documents that send CMYK numbers to the printer. The starting values come from the CMYK profile selected in the Console (${profile}); K is kept fixed.`,
    rgb: 'For software that only accepts raster images. The sheet is an sRGB PNG and the result is an sRGB value / hex for your artwork – keep the artwork in sRGB like the sheet.',
  }[mode] + ' Colours are measured at D50 / 2°. Several colours can be in progress at once, each with its own sheets; 8 patches per colour need less media, 16 are more robust on noisy or uneven prints.';
}

function printTips(mode) {
  const tips = ['<b>Print it exactly like the final job:</b> same printer, media, quality and colour settings, at 100% / actual size (not "fit to page"). Let the ink dry before scanning.',
    '<b>Transferred, cured or finished prints:</b> process the sheet exactly like production (pressing, curing, laminating …) and scan the finished product, not the raw print. On textured or uneven surfaces use 3 or more readings per patch.',
    '<b>Patch size:</b> each patch must cover the SD-10’s whole measuring area with some room to spare – if readings of the same patch jump around, use larger patches.'];
  if (mode === 'spot') tips.push('<b>Spot library:</b> if your RIP imports spot colour libraries (CxF3 is the common standard; Adobe Color Book, Edge Print and VersaWorks files are also offered), import the sheet library and enable it before printing, so the patches take the named-colour path. Otherwise unknown spot colours normally print from their L*a*b* alternate – check that the RIP does not substitute or reject them.');
  if (mode === 'rgb') tips.push('<b>Substrate:</b> print on the same substrate colour, with the same underlayers or pre-treatment, as the final job.');
  tips.push('<b>Colour space:</b> print and scan a chart of your printer once, and every colour’s first sheet starts from a prediction instead of a guess – often within tolerance straight away. Make one colour space per printer, ink, media and RIP setting, and print a check chart now and then to see whether the printer has changed.');
  return tips.map((t) => `<p>${t}</p>`).join('');
}

// ---------------------------------------------------------------- views
// Print match and the Colour space view are desktop / tablet workflows (PDFs, spot libraries, RIP software): phones
// only get the Console.
const WIDE = window.matchMedia('(min-width: 768px)');
const VIEWS = { console: 'viewConsole', match: 'viewMatch', space: 'viewSpace' };

function setView(view) {
  state.view = VIEWS[view] && view !== 'console' && WIDE.matches ? view : 'console';
  for (const [v, id] of Object.entries(VIEWS)) $(id).classList.toggle('hidden', state.view !== v);
  for (const b of document.querySelectorAll('[data-view]')) {
    if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  const hash = state.view === 'console' ? '' : `#${state.view}`;
  if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
  if (state.view === 'match') renderMatch();
  if (state.view === 'space') showSpaceView(); else hideSpaceView();
}

/** What the 3-D Colour space view shows: the colour spaces, the one in use, the reference colours and the last colour measured. */
const spaceViewData = () => ({
  spaces,
  active: match.space,
  refs: [
    ...match.colours.filter((c) => c.target).map((c) => ({ name: colourLabel(c), lab: c.target })),
    ...(state.lastLabD50 ? [{ name: 'Last measurement', lab: state.lastLabD50 }] : []),
  ],
});

// ---------------------------------------------------------------- media sizes
/** Width × height (mm) of a preset or saved size key, or null for 'custom' / a size that no longer exists. */
function mediaSizeOf(key) {
  if (MEDIA[key]) return MEDIA[key];
  const s = key.startsWith(SIZE_PREFIX) && savedSizes.find((x) => x.name === key.slice(SIZE_PREFIX.length));
  return s ? [s.w, s.h] : null;
}
const mediaMm = () => [match.mediaW, match.mediaH];
const mediaName = () => PRESET_NAMES[match.media] ?? (match.media.startsWith(SIZE_PREFIX) ? match.media.slice(SIZE_PREFIX.length) : `${match.mediaW} × ${match.mediaH} mm`);

/** The Media list: Custom size, the presets, then the user's saved sizes. */
function renderMediaOptions() {
  const opt = (v, t) => `<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`;
  $('mPaper').innerHTML = opt('custom', 'Custom size') + Object.entries(PRESET_NAMES).map(([k, n]) => opt(k, n)).join('') +
    (savedSizes.length ? `<optgroup label="Your sizes">${savedSizes.map((s) => opt(SIZE_PREFIX + s.name, `${s.name} (${s.w} × ${s.h} mm)`)).join('')}</optgroup>` : '');
}

/** Save the width and height in the boxes under a name (replacing a saved size of the same name after asking). */
function saveMediaSize() {
  const w = match.mediaW, h = match.mediaH;
  const name = (prompt('Name for this media size:', `${w} × ${h} mm`) ?? '').trim().slice(0, 40);
  if (!name) return;
  const i = savedSizes.findIndex((s) => s.name === name);
  if (i >= 0 && !confirm(`Replace the saved size “${name}” (${savedSizes[i].w} × ${savedSizes[i].h} mm) with ${w} × ${h} mm?`)) return;
  if (i >= 0) savedSizes[i] = { name, w, h }; else savedSizes.push({ name, w, h });
  saveSizes();
  match.media = SIZE_PREFIX + name;
  renderMediaOptions(); commit();
  toast(`Media size “${name}” saved`, 'ok');
}

function removeMediaSize() {
  if (!match.media.startsWith(SIZE_PREFIX)) return;
  const name = match.media.slice(SIZE_PREFIX.length);
  if (!confirm(`Remove the saved media size “${name}”? (The width and height stay as they are.)`)) return;
  savedSizes.splice(savedSizes.findIndex((s) => s.name === name), 1);
  saveSizes();
  match.media = 'custom';
  renderMediaOptions(); commit();
}

/**
 * Media heights for the chosen width, patch size and patches per colour (whole mm, null when the patches do not fit
 * across the width): min = one row of patches plus the sheet's text (the smallest usable height), onePage = each
 * colour on a single page.
 */
function heightLimits() {
  const cur = currentSheet();
  // the current sheet, or a stand-in colour with the chosen number of patches before there is one
  const group = cur ? sheetGroup(cur.c, cur.r) : { label: 'Colour 1', target: [50, 0, 0], kFixed: 0,
    patches: Array.from({ length: DESIGNS[match.design] ?? 16 }, (_, i) => ({ n: i + 1, offset: [0, 0, 0], x: [0, 0, 0], name: 'SD10-XXXX-R1-01' })) };
  const opts = { mode: match.mode, groups: [group], round: cur?.r.round ?? 1, media: [match.mediaW, 0], patchMm: match.patchMm };
  return { min: minSheetHeight(opts, { onePage: false }), onePage: minSheetHeight(opts) };
}

/** Under the media size: the least height (one row of patches plus the sheet's text) and the height for one page. */
function heightHint({ min, onePage }) {
  if (min == null) return `${match.patchMm} mm patches do not fit on ${match.mediaW} mm wide media.`;
  return `Minimum height ${min} mm at ${match.mediaW} mm wide${min === onePage ? '' : ` · ${onePage} mm fits a sheet on one page`}.`;
}

// ---------------------------------------------------------------- printer profile (gamut check)
// The gamut check runs asynchronously and is cached per profile and reference.
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
  if (!match.printerProfile) return ''; // the check is offered under Settings
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

async function refreshPrinterProfiles() {
  const names = await printerProfiles.list();
  if (match.printerProfile && !names.includes(match.printerProfile)) match.printerProfile = '';
  $('mPrinterProfile').innerHTML = '<option value="">None</option>' + names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  $('mPrinterProfile').value = match.printerProfile;
}

async function addPrinterProfile(file) {
  if (file.size > 30 * 1024 * 1024) { toast('That file is too large to be a printer profile.', 'error'); return; }
  try {
    const r = await printerProfiles.add(file);
    match.printerProfile = r.name;
    await refreshPrinterProfiles();
    commit();
    toast(`Printer profile “${r.name}” added (${r.channels} ink channels)${r.saved ? '' : ' – for this session only (browser storage is unavailable)'}`, 'ok');
  } catch (err) { toast(`Could not use ${file.name}: ${err.message}`, 'error'); }
}

async function removePrinterProfile() {
  if (!match.printerProfile || !confirm(`Remove the printer profile “${match.printerProfile}” from this browser?`)) return;
  await printerProfiles.remove(match.printerProfile).catch(() => {});
  match.printerProfile = '';
  await refreshPrinterProfiles();
  commit();
}

// ---------------------------------------------------------------- rendering
export function matchControls(busyLabel) {
  if (!state || !$('btnMatchMeasure')) return; // the Console refreshes its controls before initMatch() has run
  const on = !!state.session?.connected, idle = on && !state.busy;
  const colour = activeColour(), c = workItem(), chart = isChart(c);
  const cur = currentSheet();
  const p = cur && cur.r.patches[nextPatchIndex(c, cur.r)];
  $('btnMatchTarget').disabled = !idle;
  $('btnMatchUseLast').disabled = !(state.lastLabD50 || state.last) || state.busy;
  $('btnMatchSheet').disabled = chart || !c.target || state.busy;
  $('btnMatchMeasure').disabled = !idle || !cur;
  $('btnMatchAnalyse').disabled = state.busy || !cur || scannedCount(cur.r) < 5;
  $('btnMatchAnalyse').classList.toggle('hidden', chart);
  $('btnMatchRefine').disabled = state.busy || !c.target || c.accepted;
  $('btnSpaceChart').disabled = state.busy;
  $('vsMeasure').disabled = !idle;
  const reading = (n) => (match.reads > 1 ? ` (reading ${n + 1}/${match.reads})` : '');
  $('btnMatchMeasure').textContent = busyLabel ? `${busyLabel}…`
    : !p ? 'Measure patch' : `Measure patch #${p.n}${match.colours.length > 1 && !chart ? ` – ${colourLabel(c)}` : ''}${reading(p.lab ? 0 : p.reads?.length ?? 0)}`;
  $('btnMatchTarget').textContent = `Measure reference${colour.refReads.length ? reading(colour.refReads.length) : ''}`;
}

function colourStatus(c) {
  if (!c.target) return 'no reference yet';
  if (c.accepted) return 'accepted';
  const r = latest(c);
  if (!r) return 'no sheet yet';
  if (r.result) return `round ${r.round} · predicted ${DE().label} ${r.result.predictedDeltaE.toFixed(2)}`;
  return `round ${r.round} · ${scannedCount(r)}/${r.patches.length} scanned`;
}

/** The colour list, with the colour space's chart at the top while one is being scanned. */
function colourListHtml() {
  const selected = 'ring-2 ring-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30', unselected = 'ring-slate-200 dark:ring-slate-800';
  const chart = activeSpace()?.chart;
  const chartItem = !chart ? '' : `<li data-colour="chart" class="flex items-center gap-2 rounded-lg px-2 py-1.5 ring-1 ${activeChart() ? selected : unselected}">
      <button type="button" data-colour-act="select" class="flex flex-1 min-w-0 items-center gap-2 text-left">
        <span class="h-8 w-8 flex-none rounded ring-1 ring-black/10" style="background:conic-gradient(#e11d48,#f59e0b,#84cc16,#06b6d4,#6366f1,#d946ef,#e11d48)"></span>
        <span class="min-w-0 flex-1"><span class="block font-medium truncate">${escapeHtml(chart.name)}</span>
          <span class="block text-xs text-slate-500">colour space chart · ${scannedCount(chart.rounds[0])}/${chart.rounds[0].patches.length} scanned</span></span></button></li>`;
  return chartItem + match.colours.map((x, i) => `<li data-colour="${i}" class="flex items-center gap-2 rounded-lg px-2 py-1.5 ring-1 ${i === match.active && !activeChart() ? selected : unselected}">
      <button type="button" data-colour-act="select" class="flex flex-1 min-w-0 items-center gap-2 text-left">
        <span class="h-8 w-8 flex-none rounded ring-1 ring-black/10 ${x.target ? '' : 'bg-slate-200 dark:bg-slate-700'}" ${x.target ? `style="background:${displayHex(x.target)}"` : ''}></span>
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-2"><span class="font-medium truncate">${escapeHtml(colourLabel(x))}</span>
            ${gamutClass(gamutFor(x)) === 'outside' ? '<span class="chip bg-rose-600 text-white !px-1.5 !py-0 text-[10px]" title="Outside the printer gamut">OUT OF GAMUT</span>' : ''}</span>
          <span class="block text-xs ${x.accepted ? 'text-emerald-600' : 'text-slate-500'}">${x.target ? `<span class="font-mono">${x.target.map((v) => v.toFixed(1)).join(' / ')}</span> · ` : ''}${colourStatus(x)}</span>
        </span></button>
      ${match.colours.length > 1 ? '<button type="button" data-colour-act="remove" class="text-xs text-rose-600 hover:underline px-1" title="Remove this colour">remove</button>' : ''}</li>`).join('');
}

/** Draw the whole Print match view from the job. */
function renderMatch() {
  const c = activeColour();
  const t = c.target;
  $('mColourCount').textContent = match.colours.length > 1 ? `(${match.colours.length})` : '';
  $('mColourList').innerHTML = colourListHtml();
  // reference card (hidden while the chart is selected)
  $('mRefCard').classList.toggle('hidden', !!activeChart());
  for (const [id, i] of [['mL', 0], ['mA', 1], ['mB', 2]]) if (document.activeElement !== $(id)) $(id).value = t ? t[i].toFixed(2) : '';
  if (document.activeElement !== $('mSpotName')) $('mSpotName').value = c.name;
  $('mTargetSwatch').style.background = t ? displayHex(t) : '';
  $('mStatusTarget').textContent = c.refReads.length ? `– reading ${c.refReads.length}/${match.reads}, measure another spot` : t ? `– ${displayHex(t)}` : '– not set';
  $('mGamut').innerHTML = gamutHtml(c);
  const prediction = spacePredictionHtml(c);
  $('mSpacePred').innerHTML = prediction;
  $('mSpacePred').classList.toggle('hidden', !prediction);
  // settings
  $('matchFormula').value = match.formula in DE_FORMULAS ? match.formula : 'de00';
  $('mPrinterProfile').value = match.printerProfile;
  $('btnPrinterIccRemove').classList.toggle('hidden', !match.printerProfile);
  $('mMode').value = match.mode; $('matchMf').value = match.mf; $('mTol').value = match.tol;
  $('mReads').value = match.reads; $('mPatchMm').value = match.patchMm; $('mDesign').value = match.design;
  // the height always holds at least one row of patches plus the sheet's text: raise it (and say so) when the width,
  // patch size, patches per colour or sheet type ask for more
  const limits = heightLimits();
  if (limits.min != null && match.mediaH < limits.min) {
    const was = match.mediaH;
    match.mediaH = limits.min;
    match.media = 'custom';
    saveMatch();
    toast(`Height raised to ${limits.min} mm (was ${was} mm) – the least that holds a row of ${match.patchMm} mm patches and the sheet's text at ${match.mediaW} mm wide.`);
  }
  $('mPaper').value = match.media;
  $('btnMediaRemove').classList.toggle('hidden', !match.media.startsWith(SIZE_PREFIX));
  if (document.activeElement !== $('mMediaW')) $('mMediaW').value = match.mediaW;
  if (document.activeElement !== $('mMediaH')) $('mMediaH').value = match.mediaH;
  $('mMediaH').min = limits.min ?? 20;
  $('mCustomHint').textContent = heightHint(limits);
  $('mRipFormatWrap').classList.toggle('hidden', !isLabMode(match.mode));
  if (!RIP_EXPORTS[match.ripFormat]) match.ripFormat = 'cxf';
  $('mRipFormat').value = match.ripFormat;
  const ripLabel = RIP_EXPORTS[match.ripFormat].label;
  $('btnMatchRipSheet').title = `Spot colour library with this sheet's patch colours, in ${ripLabel} format (set under Settings) – import it into the RIP before printing`;
  $('btnLibDownload').textContent = `Download library (${ripLabel})`;
  $('mModeHelp').innerHTML = `<b>${escapeHtml($('mMode').selectedOptions[0]?.textContent ?? 'Sheet type')}:</b> ${modeHelp(match.mode)}`;
  $('mPrintTips').innerHTML = printTips(match.mode);
  // the folded "Measuring & matching" settings show their values on the closed line
  $('mMoreSummary').textContent = `${['M0', 'M1', 'M2'][match.mf] ?? 'M1'} · ${DE().label} ≤ ${match.tol}${match.reads > 1 ? ` · ${match.reads} readings` : ''}${match.printerProfile ? ' · gamut check' : ''}${isLabMode(match.mode) ? ` · ${ripLabel.replace(/ \(.*\)$/, '')}` : ''}`;
  // the cards
  renderSheet(workItem());
  renderPatchGrid(workItem());
  renderMatchResult();
  renderSpaceCard();
  renderLibrary();
  updateControls();
  updateGamut();
}

/** Card 2: the current sheet (the selected colour's, or the colour space chart) – what it holds, how it prints, the downloads. */
function renderSheet(c) {
  const r = latest(c), chart = isChart(c);
  $('mRoundLabel').textContent = `· ${colourLabel(c)}${r && !chart ? ` – sheet ${r.round}` : ''}`;
  $('btnMatchSheet').classList.toggle('hidden', chart);
  $('btnMatchSheet').textContent = r ? 'New first sheet' : 'Create sheet';
  $('mSheetActions').classList.toggle('hidden', !r);
  $('btnMatchPdf').textContent = (r?.mode ?? match.mode) === 'rgb' ? 'Download PNG' : 'Download PDF';
  $('btnMatchRipSheet').classList.toggle('hidden', r?.mode !== 'spot');
  $('btnMatchRestart').textContent = chart ? 'Close chart' : 'Start over';
  $('btnMatchRestart').title = chart ? 'Back to your colours – the patches scanned so far stay in the colour space' : "Discard this colour's sheets and measurements (its reference is kept)";
  if (!chart && !c.target) { $('mSheetInfo').textContent = `Set the reference of ${colourLabel(c)} first.`; return; }
  if (!r) {
    $('mSheetInfo').textContent = `Creates a sheet of ${DESIGNS[match.design] ?? 16} ${MODE_NAME[match.mode]} patches for ${colourLabel(c)}, around a first estimate of its reference.`;
    return;
  }
  let pages, layout = null;
  try {
    layout = sheetLayout({ mode: r.mode, groups: [sheetGroup(c, r)], round: r.round, media: mediaMm(), patchMm: match.patchMm, title: sheetTitle(c) });
    const n = layout.pages.length;
    pages = ` · ${n} page${n > 1 ? 's' : ''} of ${mediaName()} with ${match.patchMm} mm patches`;
  } catch (e) { pages = ` · <span class="text-rose-600">${escapeHtml(e.message)}</span>`; }
  const names = r.mode === 'spot'
    ? `<p class="text-xs mt-1">Spot names <span class="font-mono">${escapeHtml(r.patches[0].name ?? '')}</span> … <span class="font-mono">${escapeHtml(r.patches[r.patches.length - 1].name ?? '')}</span>.</p>`
    : '';
  const preview = layout ? sheetPreviewHtml(layout, r) : '';
  if (chart) {
    $('mSheetInfo').innerHTML = `<p>${r.patches.length} patches${pages}. ${scannedCount(r) === r.patches.length
      ? '<b class="text-emerald-600">All patches are scanned and in the colour space.</b> Close the chart to go back to your colours.'
      : 'Print it like the final job and scan the patches in number order – each goes into the colour space as you scan it.'}</p>${names}${preview}`;
  } else {
    const vals = formatValues(r.mode, r.centre, r.kFixed).map(([k, v]) => `${k} ${v}`).join('  ');
    const steps = r.step.map((v, k) => `${MODES[r.mode].axes[k]} ±${fmt1(v)}`).join(', ');
    const from = r.fromSpace ? `<p class="mt-1 text-xs">Starts from the colour space prediction (${escapeHtml(r.fromSpace.name)}, predicted ${DE().label} ${r.fromSpace.dE.toFixed(2)}).</p>` : '';
    $('mSheetInfo').innerHTML = `${r.patches.length} patches${pages}. Download, print and scan the patches below.
      <p class="mt-1 text-xs">Round ${r.round}: centre <span class="font-mono">${vals}</span> · steps ${steps}</p>${from}${names}${preview}`;
  }
  if (layout) wirePreview(`${c.id}|${r.round}|${layout.W}x${layout.H}`, Math.min(...layout.pages[0].boxes.map((b) => b.x)) / layout.W);
}

/**
 * A small to-scale drawing of the sheet's first page, from the same layout as the PDF: patches in their print colours
 * on the media's real proportions, text as grey lines. At most 200 px tall, so tall sheets fit. A very wide sheet
 * (a strip from a roll) is shown as the whole strip, small, plus a readable close-up that scrolls sideways; a frame on
 * the strip marks the part in the close-up (see wirePreview).
 */
function sheetPreviewHtml({ W, H, pages }, r) {
  const pct = (v, of) => `${((v / of) * 100).toFixed(3)}%`;
  const page = pages[0];
  const lines = page.texts.map((t) => `<div class="absolute rounded-full bg-slate-300" style="left:${pct(t.x, W)};top:${pct(H - t.y - t.size * 0.7, H)};width:${pct(Math.min(t.str.length * t.size * 0.5, W - t.x), W)};height:${pct(t.size * 0.55, H)}"></div>`).join('');
  const boxes = page.boxes.map((b) => `<div class="absolute ring-1 ring-black/20" style="left:${pct(b.x, W)};top:${pct(H - b.y - b.size, H)};width:${pct(b.size, W)};height:${pct(b.size, H)};background:${patchPreviewHex(r.mode, b.patch.x, b.kFixed)}"></div>`).join('');
  const drawing = `${lines}${boxes}`;
  const notes = [pages.length > 1 ? `page 1 of ${pages.length}` : '', escapeHtml(mediaName())].filter(Boolean).join(' · ');
  if (W / H <= 6) {
    return `<figure class="mt-3"><div class="relative mx-auto overflow-hidden rounded-sm bg-white shadow ring-1 ring-black/10" style="aspect-ratio:${W.toFixed(1)}/${H.toFixed(1)};max-width:min(100%, ${Math.round((200 * W) / H)}px)">${drawing}</div>
      <figcaption class="mt-1 text-center text-[11px] text-slate-500">Preview · ${notes}</figcaption></figure>`;
  }
  // a strip: the whole sheet small (with a frame marking the close-up), and a readable close-up below
  const label = 'text-[11px] text-slate-500';
  // the figure and the close-up stretch to fill the card's free height (at least 110 px); the drawing's width follows
  // its height through aspect-ratio, so a taller close-up stays to scale
  return `<figure class="mt-3 flex-1 flex flex-col gap-1.5">
    <div class="${label}">Whole sheet · ${notes}</div>
    <div id="mPreviewOverview" class="relative w-full cursor-pointer overflow-hidden rounded-sm bg-white ring-1 ring-black/10" style="aspect-ratio:${W.toFixed(1)}/${H.toFixed(1)}" title="Click to show this part in the close-up">${drawing}
      <div id="mPreviewWindow" class="pointer-events-none absolute inset-y-0 rounded-sm bg-indigo-500/10 ring-2 ring-indigo-500"></div></div>
    <div class="${label} pt-1">Close-up – scroll sideways, or click the whole sheet above</div>
    <div id="mPreviewZoom" class="relative flex-1 min-h-[124px] overflow-x-auto"><div class="absolute inset-y-0 left-0 rounded-sm bg-white ring-1 ring-black/10" style="aspect-ratio:${W.toFixed(1)}/${H.toFixed(1)}">${drawing}</div></div>
  </figure>`;
}

/**
 * Wide-sheet preview: keep the frame on the whole sheet in step with the close-up's scroll position, let a click on the
 * whole sheet move the close-up there, and start the close-up at the first patch (or where the user left it).
 * The position is kept as a fraction of the sheet, because the close-up grows with the card (its width follows its
 * height) after it is first drawn, and when the window is resized.
 */
let previewScroll = { key: null, frac: 0 };
let previewResize = null;
function wirePreview(key, firstPatch) {
  previewResize?.disconnect();
  const zoom = $('mPreviewZoom'), frame = $('mPreviewWindow'), overview = $('mPreviewOverview');
  if (!zoom) return;
  if (previewScroll.key !== key) previewScroll = { key, frac: Math.max(0, firstPatch - 0.01) };
  const showFrame = () => {
    frame.style.left = `${(zoom.scrollLeft / zoom.scrollWidth) * 100}%`;
    frame.style.width = `${(zoom.clientWidth / zoom.scrollWidth) * 100}%`;
  };
  // Our own positioning also fires a scroll event – possibly clamped while the close-up is still narrow – which must not
  // overwrite the remembered position; only the user's scrolling does.
  let placing = false;
  const place = () => {
    const want = Math.min(previewScroll.frac * zoom.scrollWidth, zoom.scrollWidth - zoom.clientWidth);
    placing = Math.abs(zoom.scrollLeft - want) >= 1; // no scroll event fires when nothing moves
    zoom.scrollLeft = want;
    showFrame();
  };
  // only a visible close-up has a size: Print match is drawn while still hidden at start-up
  zoom.onscroll = () => {
    if (!zoom.clientWidth) return;
    if (placing) placing = false; else previewScroll.frac = zoom.scrollLeft / zoom.scrollWidth;
    showFrame();
  };
  overview.onclick = (e) => {
    const box = overview.getBoundingClientRect();
    zoom.scrollLeft = ((e.clientX - box.left) / box.width) * zoom.scrollWidth - zoom.clientWidth / 2;
  };
  previewResize = new ResizeObserver(() => { if (zoom.clientWidth) place(); });
  previewResize.observe(zoom);
  if (zoom.clientWidth) place();
}

/** Card 3: the current sheet's patches – measured ones in their measured colour, the next one outlined. */
function renderPatchGrid(c) {
  const r = latest(c);
  if (!r) { $('mPatchGrid').innerHTML = '<p class="text-sm text-slate-500">No sheet yet.</p>'; $('mProgress').textContent = ''; return; }
  const next = nextPatchIndex(c, r);
  $('mProgress').textContent = `${scannedCount(r)} / ${r.patches.length} measured`;
  if (isChart(c)) {
    // hundreds of patches: small swatches in a scrolling box, kept scrolled to the next one
    $('mPatchGrid').innerHTML = `<div id="mChartGrid" class="relative grid grid-cols-[repeat(auto-fill,minmax(2rem,1fr))] gap-1 max-h-72 overflow-y-auto p-0.5">${r.patches.map((p, i) => `<button type="button" data-patch="${i}"
      class="relative h-8 rounded ring-1 ${i === next ? 'ring-2 ring-indigo-500' : 'ring-black/10'}" title="${escapeHtml(`Patch #${p.n}${p.name ? ' · ' + p.name : ''}${p.lab ? ' – tap to re-measure' : ''}`)}">
      <span class="absolute inset-0 rounded ${p.lab ? '' : 'opacity-40'}" style="background:${p.lab ? displayHex(p.lab) : patchPreviewHex(r.mode, p.x, p.k ?? r.kFixed)}"></span>
      <span class="absolute bottom-0 right-0 rounded-tl bg-white/80 px-0.5 text-[9px] leading-tight text-slate-700">${p.n}</span></button>`).join('')}</div>`;
    const grid = $('mChartGrid'), b = grid.children[next];
    if (b && grid.clientHeight) grid.scrollTop = b.offsetTop - grid.clientHeight / 2;
    return;
  }
  // 8 per row in a full-width scan card, 4 when it sits beside the sheet card (xl)
  $('mPatchGrid').innerHTML = `<div class="grid grid-cols-4 sm:grid-cols-8 xl:grid-cols-4 gap-2">${r.patches.map((p, i) => {
    const done = !!p.lab;
    const bg = done ? displayHex(p.lab) : patchPreviewHex(r.mode, p.x, r.kFixed);
    const dE = done && c.target ? DE().fn(c.target, p.lab) : null;
    const partial = !done && p.reads?.length ? `${p.reads.length}/${match.reads}` : '';
    const uneven = done && p.spread > 1.5; // readings disagree – textured / uneven print
    const title = `Patch #${p.n}${p.name ? ' · ' + p.name : ''}${done && p.spread != null && p.reads?.length > 1 ? ` · ${p.reads.length} readings, spread ΔE00 ${p.spread.toFixed(2)}` : ''}${done ? ' – tap to re-measure' : ''}`;
    return `<button type="button" data-patch="${i}" class="text-left rounded-lg p-1.5 ring-1 ${i === next ? 'ring-2 ring-indigo-500' : 'ring-slate-200 dark:ring-slate-800'}" title="${escapeHtml(title)}">
      <div class="h-10 rounded-md ${done ? '' : 'opacity-40'}" style="background:${bg}"></div>
      <div class="flex justify-between text-[11px] mt-1"><b>#${p.n}${uneven ? ' <span class="text-amber-600" title="Readings differ by more than 1.5 ΔE00">!</span>' : ''}</b><span class="font-mono ${dE != null && dE <= match.tol ? 'text-emerald-600' : 'text-slate-500'}">${dE != null ? 'ΔE ' + dE.toFixed(1) : partial}</span></div>
    </button>`;
  }).join('')}</div>`;
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

/** Card 4: one colour's result – the values to use, how close they should print, why, and the round history. */
function resultHtml(c) {
  const r = latest(c);
  const res = r.result;
  const within = res.predictedDeltaE <= match.tol && !res.extrapolated;
  const verified = r.round > 1 && res.centreDE != null && res.centreDE <= match.tol;
  const prevVals = formatValues(r.mode, r.centre, r.kFixed).map(([k, v]) => `${k} ${v}`).join(' ');
  const gamut = gamutClass(gamutFor(c));
  const bestElsewhere = res.bestEver && res.bestEver.round !== r.round;
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
    ${valueTilesHtml(r.mode, res.x, r.kFixed, { large: true })}
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="rounded-md px-2 py-0.5 text-xs font-bold text-white ${within ? 'bg-emerald-600' : 'bg-amber-500'}">${within ? 'EXPECTED MATCH' : 'NEEDS ANOTHER ROUND'}</span>
      <span>predicted ${DE().label} <b class="tabular-nums">${res.predictedDeltaE.toFixed(2)}</b>${res.extrapolated ? ' (rough estimate)' : ''} (tolerance ${match.tol})</span>
    </div>
    ${res.regressed ? `<p class="text-xs text-amber-600"><b>The last change made the colour worse</b> (this sheet's centre printed ${DE().label} ${res.centreDE.toFixed(2)}), so the search goes back to the best patch so far and continues in smaller steps.</p>` : ''}
    ${res.source === 'best-patch' ? `<p class="text-xs text-amber-600">No values are predicted to print closer than the best patch you measured (#${res.pickN ?? res.best.n}), so these are its values.</p>` : ''}
    ${res.source === 'best-earlier' ? `<p class="text-xs text-amber-600">Nothing on this sheet beats patch #${res.pickN} of sheet ${res.pickRound}, so these are its values; the next sheet looks for something better close to it.</p>` : ''}
    ${res.extrapolated ? '<p class="text-xs text-amber-600">The answer lies outside this sheet’s patch range, so the prediction is only a rough estimate. The next sheet is centred on it and will confirm.</p>' : ''}
    ${res.trustLimited ? '<p class="text-xs text-amber-600">This round moves as far as the sheet’s measurements can be trusted; the next sheet continues in that direction.</p>' : ''}
    ${res.gamutLimited && res.predictedDeltaE > match.tol ? (gamut === 'inside'
    ? `<p class="text-xs text-rose-600"><b>Your printer profile says this colour is printable, but the prints stop getting closer at ${DE().label} ${res.predictedDeltaE.toFixed(2)}.</b> The profile probably doesn't describe how this printer, ink and media really print – or the measuring conditions differ (M-factor, drying, lamination). Re-profiling the media, or checking the RIP's media and ink settings, will help more than further rounds.</p>`
    : `<p class="text-xs text-rose-600"><b>The reference looks outside what this printer and media can reproduce.</b> Nothing within reach is predicted closer than ${DE().label} ${res.predictedDeltaE.toFixed(2)} – more rounds will not get much closer. Use these values as the closest match. If your RIP shows the colour as printable, its media profile probably doesn't match the real prints – check the media, ink limits and colour settings.</p>`) : ''}
    ${gamut === 'outside' || gamut === 'edge' ? `<p class="text-xs">${gamutHtml(c)}</p>` : ''}
    ${res.clamped ? '<p class="text-xs text-amber-600">Some values reached their limit – the reference may be outside the colours this printer and paper can produce. These are the closest reachable values.</p>' : ''}
    <dl class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
      <div><dt class="text-slate-500">Centre patch</dt><dd class="font-mono">${DE().label} ${res.centreDE != null ? res.centreDE.toFixed(2) : '–'}</dd></div>
      <div><dt class="text-slate-500">${bestElsewhere ? 'Best so far' : 'Best patch'}</dt><dd class="font-mono">${bestElsewhere ? `sheet ${res.bestEver.round} #${res.bestEver.n} · ${DE().label} ${res.bestEver.dE.toFixed(2)}` : `#${res.best.n} · ${DE().label} ${res.best.dE.toFixed(2)}`}</dd></div>
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

/** The selected colour's result (other colours keep theirs – select them in the list). */
function renderMatchResult() {
  const c = activeColour();
  const shown = !activeChart() && !!latest(c)?.result;
  $('mResultCard').classList.toggle('hidden', !shown);
  if (!shown) return;
  $('mResult').innerHTML = resultHtml(c);
  $('btnMatchRefine').textContent = c.accepted ? 'Accepted – no more sheets' : 'Make next sheet';
}

// ---------------------------------------------------------------- measuring
/** One SD-10 reading as L*a*b* D50 / 2° (the job's M-factor); null when it calibrated instead or needs calibrating. */
async function measureLabD50() {
  const s = await state.session.getStatus();
  if (s.shutterStatus === 1) { await doCalibrate(); return null; }
  if (s.calibrationStatus !== 2) { toast(NEEDS_CALIBRATION, 'error'); return null; }
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
  if (c.rounds.some((r) => scannedCount(r)) && !confirm(`Changing the reference of ${colourLabel(c)} starts its matching over. Continue?`)) { renderMatch(); return false; }
  c.target = lab.map(round2);
  c.targetSpectrum = spectrum ? roundSpectrum(spectrum) : null;
  debugLog('match', `reference of ${colourLabel(c)} set`, { lab: c.target, measured: !!spectrum });
  c.rounds = []; c.accepted = false; c.refReads = []; c.refSpectra = [];
  commit();
  return true;
}

/** Measure the selected colour's reference (one reading of it, with several readings per reference). */
function measureMatchTarget() {
  const c = activeColour();
  return task('Measuring reference', async () => {
    const m = await measureLabD50();
    if (!m) return;
    c.refReads = [...c.refReads, m.lab];
    c.refSpectra = [...(c.refSpectra ?? []), roundSpectrum(m.spectrum)];
    if (c.refReads.length < match.reads) {
      commit();
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

/**
 * Measure the current sheet's next patch (one reading of it, with several readings per patch). A finished patch goes
 * into the colour space; a finished sheet is analysed – or, for the chart, reported.
 */
function measurePatch() {
  const cur = currentSheet();
  if (!cur) return;
  const { c, r } = cur; // kept: switching colours while measuring still records into this patch
  const chart = isChart(c);
  const k = nextPatchIndex(c, r);
  const p = r.patches[k];
  return task(`Measuring #${p.n}`, async () => {
    // Demo: the simulated SD-10 "sees" what a simulated printer would print for this patch.
    if (DEMO && state.transport?.setSpectrumOverride) {
      const lab = r.mode === 'rgb' ? srgbToLabD50(p.x) : p.x;
      const cmyk = r.mode === 'cmyk' ? [...p.x, p.k ?? r.kFixed] : (await loadProfile(settingsFromUI().cmykProfile)).fromLab(lab, 0);
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
      commit({ withSpaces: chart });
      toast(`Reading ${p.reads.length}/${match.reads} – move the SD-10 to another spot on patch #${p.n}.`);
      return;
    }
    Object.assign(p, averageReadings(p.reads));
    debugLog('measure', `${colourLabel(c)}${chart ? '' : ` sheet ${r.round}`} patch #${p.n}`, { x: p.x, k: p.k, lab: p.lab, readings: p.reads.length, spread: p.spread });
    p.spectrum = roundSpectrum(meanSpectrum(p.spectra));
    delete p.spectra; // the mean is enough – keeps the saved job small
    if (chart) delete p.spectrum; // a chart only feeds the colour space, which keeps L*a*b*
    learnPatch(c, r, p);
    // next: the first unmeasured patch after this one, else any unmeasured patch
    const after = r.patches.findIndex((q, j) => j > k && !q.lab);
    const any = r.patches.findIndex((q) => !q.lab);
    c.next = after >= 0 ? after : any >= 0 ? any : k;
    const complete = r.patches.every((q) => q.lab);
    if (complete && chart) onChartComplete(c);
    else if (complete) analyseColour(c, r);
    commit({ withSpaces: chart });
    if (complete && !chart) $('mResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/** A colour's result from its measured patches (and its earlier rounds); false (and says why) when it cannot be fitted. */
function analyseColour(c, r = latest(c)) {
  try {
    // the colour's earlier rounds count too: the best patch so far is the bar to beat, and a failed move is undone
    const a = analyseRound(r, c.target, match.formula, c.rounds.filter((x) => x !== r));
    r.result = { x: a.x, predicted: a.predicted, predictedDeltaE: a.predictedDeltaE, clamped: a.clamped, correction: a.correction, extrapolated: a.extrapolated,
      source: a.source, trustLimited: a.trustLimited, gamutLimited: a.gamutLimited, regressed: a.regressed, pickRound: a.pickRound, pickN: a.pickN,
      best: { n: a.best.n, dE: a.best.dE }, bestEver: { round: a.bestEver.round, n: a.bestEver.n, dE: a.bestEver.dE },
      centreDE: a.centreDE, repeatability: a.repeatability, rms: a.model.rms };
    const { x, predictedDeltaE, source, centreDE, bestEver, regressed, gamutLimited, trustLimited, extrapolated, rms } = r.result;
    debugLog('result', `${colourLabel(c)} sheet ${r.round}`, { target: c.target, x, predictedDeltaE, source, centreDE, best: bestEver, regressed, gamutLimited, trustLimited, extrapolated, rms, formula: match.formula });
    return true;
  } catch (e) {
    debugLog('error', `analysis of ${colourLabel(c)} failed`, { stack: e.stack });
    toast(`${colourLabel(c)}: ${e.message}`, 'error');
    return false;
  }
}

/** "Calculate now": the selected colour's result from the patches measured so far (at least 5). */
function analyseMatch() {
  const cur = currentSheet();
  const ok = cur && scannedCount(cur.r) >= 5 && analyseColour(cur.c, cur.r);
  commit();
  if (ok) $('mResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- sheets
/**
 * First sheet centre for a colour: the colour space's prediction when there is one – with finer steps where the space
 * has measured patches nearby – else a first estimate (CMYK: from the selected profile, K kept fixed).
 */
async function initialCentre(c) {
  const p = spacePrediction(c);
  if (p) {
    const s = usableSpace(), { spacing } = spaceStats(s);
    const near = spacing != null && p.d1 <= 2 * spacing;
    const { step0, minStep } = MODES[match.mode];
    return { centre: [...p.x], kFixed: match.mode === 'cmyk' ? p.k : 0, step: step0.map((v, k) => (near ? Math.max(minStep[k], v / 2) : v)),
      fromSpace: { name: s.name, dE: round2(p.predictedDeltaE) } };
  }
  if (match.mode === 'cmyk') {
    const cmyk = (await loadProfile(settingsFromUI().cmykProfile)).fromLab(c.target, 0).map((v) => Math.round(Math.min(v, 100) * 10) / 10);
    return { centre: cmyk.slice(0, 3), kFixed: cmyk[3], step: [...MODES.cmyk.step0] };
  }
  if (match.mode === 'rgb') return { centre: labD50ToSrgb(c.target).rgb, kFixed: 0, step: [...MODES.rgb.step0] };
  return { centre: [...c.target], kFixed: 0, step: [...MODES[match.mode].step0] };
}

/** A colour's next sheet (round) around `centre`; its patches are named SD10-<colour code>-R<round>-<n> in spot mode. */
function createRound(c, { centre, step, kFixed, fromSpace = null }) {
  const round = (latest(c)?.round ?? 0) + 1;
  const patches = designPatches(match.mode, centre, step, match.design)
    .map((p) => (match.mode === 'spot' ? { ...p, name: patchSpotName(c.code, round, p.n) } : p));
  c.rounds.push({ round, mode: match.mode, centre, step, kFixed, design: match.design, patches, result: null, ...(fromSpace ? { fromSpace } : {}) });
  debugLog('match', `sheet ${round} created for ${colourLabel(c)}`, { mode: match.mode, centre, step, kFixed, design: match.design, fromSpace });
  c.next = 0;
  commit();
}

/** First sheet for the selected colour (starting it over if it already has sheets). */
async function startFirstSheet() {
  const c = activeColour();
  if (!c.target) return;
  if (c.rounds.length && !confirm(`Start ${colourLabel(c)} again with a new first sheet? Its sheets and measurements are discarded.`)) return;
  try {
    const start = await initialCentre(c);
    c.rounds = []; c.accepted = false;
    c.code = newCode(); // fresh spot names, so libraries imported for an earlier attempt cannot clash
    createRound(c, start);
    toast(`Sheet created for ${colourLabel(c)} – download and print it.`, 'ok');
  } catch (e) {
    toast(`Could not create the sheet: ${e.message}`, 'error');
  }
}

/** Next sheet for the selected colour, centred on its result with finer steps. */
function makeNextSheet() {
  const c = activeColour(), r = latest(c);
  if (c.accepted) { toast(`${colourLabel(c)} is accepted – press Accepted to undo that before making another sheet.`, 'error'); return; }
  if (!r?.result) { toast(`Scan the sheet of ${colourLabel(c)} first.`, 'error'); return; }
  createRound(c, { centre: r.result.x, step: nextStep(r.mode, r.step, r.result.correction), kFixed: r.kFixed });
  toast(`Sheet ${r.round + 1} for ${colourLabel(c)} created – download and print it.`, 'ok');
  $('mSheetInfo').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** "Start over" – or, for the chart, "Close chart". */
function restartSheet() {
  if (activeChart()) { closeChart(); return; }
  const c = activeColour();
  if (!confirm(`Discard the sheets and measurements of ${colourLabel(c)}? (Its reference is kept.)`)) return;
  c.rounds = []; c.accepted = false; c.next = 0;
  commit();
}

/** Every colour starts over (a new sheet type). */
function resetMatching() {
  for (const c of match.colours) { c.rounds = []; c.accepted = false; c.next = 0; }
}

/** The current sheet as a PDF (or PNG pages for raster workflows), named after the colour and sheet (or the chart). */
async function downloadSheet() {
  const cur = currentSheet();
  if (!cur) return;
  const { c, r } = cur;
  const opts = { mode: r.mode, groups: [sheetGroup(c, r)], round: r.round, media: mediaMm(), patchMm: match.patchMm, title: sheetTitle(c) };
  const base = safeFileName(isChart(c) ? colourLabel(c) : `${colourLabel(c)} - sheet ${r.round}`);
  try {
    if (r.mode === 'rgb') {
      const pages = await buildSheetPng(opts);
      pages.forEach(({ png }, i) => downloadFile(png, 'image/png', `${base}${pages.length > 1 ? ` - page ${i + 1}` : ''}.png`));
      if (pages[0].dpi < 300) toast(`Large media: the PNG is ${pages[0].dpi} dpi (still printed at actual size).`);
    } else downloadFile(buildSheetPdf(opts), 'application/pdf', `${base}.pdf`);
  } catch (e) { toast(e.message, 'error'); }
}

/** Spot colour library for the RIP: the current sheet's patch colours ('sheet') or the collected spot library ('library'). */
function downloadRipLibrary(what, rip = match.ripFormat) {
  const ex = RIP_EXPORTS[rip];
  if (!ex) return;
  const cur = currentSheet();
  if (what === 'sheet' && cur) {
    const { c, r } = cur;
    const colours = r.patches.filter((p) => p.name).map((p) => ({ name: p.name, lab: p.x }));
    if (!colours.length) return;
    const chart = isChart(c);
    const text = ex.build({
      library: chart ? `SD10 ${c.code} chart` : `SD10 ${c.code} sheet ${r.round}`,
      description: chart ? `Colour space chart patches (${c.name}), CIE L*a*b* D50/2°` : `Print match test sheet patches for ${colourLabel(c)}, CIE L*a*b* D50/2°`,
      colours,
    });
    downloadFile(text, ex.mime, chart ? `sd10-${c.code}-chart.${ex.ext}` : `sd10-${c.code}-sheet${r.round}.${ex.ext}`);
  } else if (what === 'library' && spotLib.colours.length) {
    const library = spotLib.name.trim() || DEFAULT_LIBRARY_NAME;
    const description = `${spotLib.colours.length} colour(s) matched with SD-10 Print match, CIE L*a*b* D50/2°`;
    downloadFile(ex.build({ library, description, colours: spotLib.colours.map((c) => ({ name: c.name, lab: c.lab })) }), ex.mime, `${safeFileName(library)}.${ex.ext}`);
  }
}

// ---------------------------------------------------------------- spot library
function renderLibrary() {
  const ex = RIP_EXPORTS[match.ripFormat] ?? RIP_EXPORTS.cxf;
  const n = spotLib.colours.length;
  $('mLibCount').textContent = n ? `(${n})` : '';
  if (document.activeElement !== $('mLibName')) $('mLibName').value = spotLib.name;
  $('btnLibDownload').disabled = !n;
  // the download is the card's main action once there is something to download
  $('btnLibDownload').classList.toggle('btn-primary', !!n);
  $('btnLibDownload').classList.toggle('btn-ghost', !n);
  $('btnLibClear').disabled = !n;
  $('mLibList').innerHTML = !n
    ? '<p class="text-sm text-slate-500">No colours yet – add a finished match, type one in below, or import a library.</p>'
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

/** Copy a colour's result – or other values for it (`res`, e.g. the colour space prediction) – as text. */
function copyMatchValues(c, res = latest(c)?.result, mode = latest(c)?.mode, k = latest(c)?.kFixed) {
  if (!res) return;
  const text = `${colourLabel(c)} – ${{ spot: 'L*a*b*', lab: 'L*a*b*', cmyk: 'CMYK', rgb: 'sRGB' }[mode]}: ` + formatValues(mode, res.x, k).map(([key, v]) => `${key} ${v}`).join(', ') +
    ` (predicted ${DE().label} ${res.predictedDeltaE.toFixed(2)} to reference L*a*b* ${c.target.map((v) => v.toFixed(2)).join(' / ')})`;
  navigator.clipboard?.writeText(text).then(() => toast('Values copied', 'ok'), () => toast('Clipboard not available', 'error'));
}

/**
 * Add a colour's result – or other values for it (`res`: { x, predictedDeltaE }, e.g. the colour space prediction) – to
 * the spot library under its name (replacing a colour with the same name).
 */
function addResultToLibrary(c, res = latest(c)?.result, mode = latest(c)?.mode) {
  if (!res || !isLabMode(mode)) return;
  let name = c.name.trim();
  if (!name) {
    name = (prompt('Spot colour name – exactly as it is named in your artwork and the RIP:') ?? '').trim();
    if (!name) return;
    c.name = name; saveMatch();
  }
  if (putInLibrary({ name, lab: res.x, target: c.target, predictedDeltaE: res.predictedDeltaE, mf: match.mf })) {
    $('mLibraryCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/** Add or (after asking) replace a colour by name. Returns true if the library changed. */
function putInLibrary(c) {
  const entry = { predictedDeltaE: null, ...c, lab: c.lab.map(round2), time: new Date().toISOString() };
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
    const entry = { name: c.name, lab: c.lab.map(round2), predictedDeltaE: null, imported: file.name, time: new Date().toISOString() };
    const i = spotLib.colours.findIndex((o) => o.name === c.name);
    if (i < 0) { spotLib.colours.push(entry); added++; } else if (replace) { spotLib.colours[i] = entry; replaced++; }
  }
  saveLib(); renderMatch();
  toast(`Imported ${file.name}: ${added} added${replaced ? `, ${replaced} replaced` : ''}${clashes.length && !replace ? `, ${clashes.length} kept` : ''}${lib.skipped.length ? ` – ${lib.skipped.length} skipped (no D50 / 2° L*a*b*)` : ''}`, 'ok');
}

/** Rename and remove buttons in the library table. */
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

// ---------------------------------------------------------------- colour space
const SESSION_KIND = { chart: 'Chart', check: 'Check chart', sheet: 'Test sheet', import: 'Imported' };
const predictionCache = new Map();

/** What the colour space predicts for a colour's reference (cached), or null. CMYK keeps the K of the colour's sheets. */
function spacePrediction(c) {
  const s = usableSpace();
  if (!s || !c?.target || s.points.length < SPACE_MIN_POINTS) return null;
  const k = match.mode === 'cmyk' ? latest(c)?.kFixed ?? null : null;
  const key = `${s.id}|${s.updated}|${s.points.length}|${c.target.join()}|${match.formula}|${k}`;
  if (!predictionCache.has(key)) {
    if (predictionCache.size > 100) predictionCache.clear();
    let p = null;
    try { p = invert(s, c.target, { formula: match.formula, kFixed: k }); } catch { /* no prediction */ }
    predictionCache.set(key, p);
  }
  return predictionCache.get(key);
}

/** Reference card: the values the colour space predicts for the reference, and how close they should print. */
function spacePredictionHtml(c) {
  const p = spacePrediction(c);
  if (!p) return '';
  const s = usableSpace(), st = spaceStats(s);
  const rough = st.spacing != null && p.d1 > 2 * st.spacing; // no measured patches nearby
  const lab = `<span class="font-mono">L ${fmt1(p.predicted[0])} a ${fmt1(p.predicted[1])} b ${fmt1(p.predicted[2])}</span>`;
  return `<div class="flex flex-wrap items-baseline justify-between gap-2"><h4 class="text-sm font-semibold">Predicted by the colour space</h4><span class="text-xs text-slate-500">${escapeHtml(s.name)}</span></div>
    ${valueTilesHtml(match.mode, p.x, p.k)}
    <p class="text-xs">${p.predictedDeltaE <= 2
      ? `<span class="text-emerald-600">Predicted to print ${DE().label} ${p.predictedDeltaE.toFixed(2)} from the reference.</span>`
      : `<span class="text-rose-600"><b>Beyond what this printer reached in the colour space.</b> The closest it prints is ${lab}, ${DE().label} ${p.predictedDeltaE.toFixed(2)} from the reference.</span>`}
      <span class="text-slate-500">The colour space is typically accurate to ΔE00 ${st.accuracy ? st.accuracy.median.toFixed(2) : '–'}${rough ? ', but it has few measured patches near this colour, so treat this as a first estimate' : ''}. The first test sheet starts from these values${rough ? '' : ' with finer steps'} and confirms them.</span></p>
    <div class="flex flex-wrap gap-2"><button type="button" data-pred-act="copy" class="btn btn-ghost">Copy values</button>${isLabMode(match.mode) ? '<button type="button" data-pred-act="add" class="btn btn-ghost" title="Add the predicted values to your spot library under the colour’s name">Add to spot library</button>' : ''}</div>`;
}

/** The Colour space card: the space in use, what it holds and how well it predicts, drift warnings, its data. */
function renderSpaceCard() {
  const s = activeSpace();
  $('mSpace').innerHTML = '<option value="">None</option>' + spaces.map((q) => `<option value="${escapeHtml(q.id)}">${escapeHtml(q.name)}${q.mode !== match.mode ? ` (${MODE_NAME[q.mode]} sheets)` : ''}</option>`).join('');
  $('mSpace').value = s?.id ?? '';
  $('mSpaceLearn').checked = match.learn;
  $('mSpaceActions').classList.toggle('hidden', !s);
  $('btnSpaceCgats').disabled = !s?.points.length;
  $('btnSpaceChart').textContent = s?.chart ? 'New chart' : 'Create chart';
  // a chart is the card's main action until the colour space can predict
  const needsChart = !s || s.points.length < SPACE_MIN_POINTS;
  $('btnSpaceChart').classList.toggle('btn-primary', needsChart);
  $('btnSpaceChart').classList.toggle('btn-ghost', !needsChart);
  $('mSpaceData').classList.toggle('hidden', !s);
  if (!s) {
    $('mSpaceInfo').innerHTML = '<p>A colour space is a measured map of what your printer really prints: scan a chart once, and every colour starts from a prediction instead of a guess.</p>';
    return;
  }
  const st = spaceStats(s);
  const parts = [];
  if (s.mode !== match.mode) parts.push(`<p class="text-amber-600">This colour space was measured with ${MODE_NAME[s.mode]} sheets – switch the sheet type to use it.</p>`);
  parts.push(st.points < SPACE_MIN_POINTS
    ? `<p>${st.points ? `${st.points} measured patch${st.points === 1 ? '' : 'es'} so far` : 'No measurements yet'} – scan a chart; the colour space predicts once it holds ${SPACE_MIN_POINTS} patches.</p>`
    : `<p>${st.points} measured patches${st.accuracy ? ` · predicts within ΔE00 ${st.accuracy.median.toFixed(2)} typically (90 % within ${st.accuracy.p90.toFixed(2)})` : ''}</p>`);
  if (s.chart && !activeChart()) {
    const r = s.chart.rounds[0];
    parts.push(`<p>${escapeHtml(s.chart.name)}: ${scannedCount(r)} of ${r.patches.length} patches scanned – <button type="button" data-space-act="chart" class="font-medium text-indigo-600 hover:underline dark:text-indigo-400">continue scanning</button></p>`);
  }
  // the most recent set of patches that could be compared with the space: did the printer print as predicted?
  const last = [...s.sessions].sort((a, b) => (b.updated ?? b.time) - (a.updated ?? a.time)).map((q) => ({ q, d: driftOf(s, q.id) })).find((x) => x.d);
  if (last?.d.drift) {
    parts.push(`<div class="rounded-lg bg-rose-50 p-2 text-rose-700 dark:bg-rose-950 dark:text-rose-200"><b>${escapeHtml(last.q.label)} printed differently from what this colour space predicts</b>
      – typically ΔE00 ${last.d.median.toFixed(2)} off, where the space is usually within ${st.accuracy ? st.accuracy.median.toFixed(2) : '–'}. The printer, ink, media or settings have probably changed: check them. If the change is meant to stay, keep only the newer measurements.
      <div class="mt-1"><button type="button" data-space-act="trim" data-time="${last.q.time}" class="font-medium underline">Keep only data from ${fmtDate(last.q.time)} on</button></div></div>`);
  } else if (last?.q.kind === 'check') {
    parts.push(`<p class="text-emerald-600">${escapeHtml(last.q.label)} (${fmtDate(last.q.time)}): the printer still prints as predicted (typically ΔE00 ${last.d.median.toFixed(2)} off).</p>`);
  }
  $('mSpaceInfo').innerHTML = parts.join('');
  $('mSpaceData').querySelector('summary').textContent = `Data & files${s.sessions.length ? ` · ${s.sessions.length} set${s.sessions.length === 1 ? '' : 's'} of measurements` : ''}`;
  $('mSpaceSessions').innerHTML = !s.sessions.length ? '<li class="text-slate-500">No measurements yet – scan a chart.</li>' : [...s.sessions].sort((a, b) => b.time - a.time).map((q) => {
    const d = driftOf(s, q.id);
    return `<li data-session="${escapeHtml(q.id)}" class="flex items-center gap-2 border-t border-slate-200 pt-1 dark:border-slate-800">
      <span class="min-w-0 flex-1"><span class="block truncate font-medium text-slate-700 dark:text-slate-300">${escapeHtml(q.label)}</span>
        <span class="text-slate-500">${SESSION_KIND[q.kind] ?? ''} · ${fmtDate(q.time)} · ${sessionSize(s, q.id)} patches${d ? ` · <span class="${d.drift ? 'font-medium text-rose-600' : ''}">ΔE00 ${d.median.toFixed(2)} from the prediction</span>` : ''}</span></span>
      <button type="button" data-space-act="remove" class="px-1 text-rose-600 hover:underline" title="Remove these measurements from the colour space">remove</button></li>`;
  }).join('');
}

/** Use another colour space ('' = none); the cards go back to the colours. */
function selectSpace(id) {
  match.space = id; match.chartActive = false;
  commit({ withSpaces: true });
}

/** A new, empty colour space for the current sheet type (asks for its name); it becomes the one in use. */
function createSpace() {
  const name = (prompt(`Name for the new colour space (${MODE_NAME[match.mode]} sheets) – e.g. the printer, ink, media and settings it describes:`, `Colour space ${spaces.length + 1}`) ?? '').trim().slice(0, 60);
  if (!name) return null;
  const s = newSpace({ name, mode: match.mode });
  spaces.push(s);
  selectSpace(s.id);
  return s;
}

function renameSpace() {
  const s = activeSpace();
  const name = s && (prompt('Name of the colour space:', s.name) ?? '').trim().slice(0, 60);
  if (!name) return;
  s.name = name;
  commit({ withSpaces: true });
}

function deleteSpace() {
  const s = activeSpace();
  if (!s || !confirm(`Delete the colour space “${s.name}” and its ${s.points.length} measured patches from this browser? Export it first to keep a copy.`)) return;
  spaces.splice(spaces.indexOf(s), 1);
  selectSpace('');
}

/** Import a colour space file (.json) or a CGATS / IT8 measurement file as a colour space, and use it. */
async function importSpaceFile(file) {
  if (file.size > 50 * 1024 * 1024) { toast('That file is too large for a colour space.', 'error'); return; }
  let s;
  try { s = readSpaceFile(new Uint8Array(await file.arrayBuffer()), file.name); } catch (e) { toast(e.message, 'error'); return; }
  const i = spaces.findIndex((q) => q.id === s.id);
  if (i >= 0 && confirm(`“${spaces[i].name}” is already in this browser.\n\nOK = replace it with the file, Cancel = keep both.`)) {
    s.chart = spaces[i].chart;
    spaces[i] = s;
  } else {
    if (i >= 0) { s.id = newSpaceId(); s.name = `${s.name} (copy)`.slice(0, 60); }
    spaces.push(s);
  }
  selectSpace(s.id);
  toast(`Colour space “${s.name}” imported – ${s.points.length} patches${s.mode !== match.mode ? `, measured with ${MODE_NAME[s.mode]} sheets: switch the sheet type to use it` : ''}.`, 'ok');
}

/** A new chart for the colour space in use (creating a space first if there is none); the cards switch to it. */
function createChart() {
  let s = activeSpace();
  if (s && s.mode !== match.mode) { toast(`“${s.name}” was measured with ${MODE_NAME[s.mode]} sheets – switch the sheet type, or create a new colour space.`, 'error'); return; }
  const key = CHART_SIZES[$('mChartSize').value] ? $('mChartSize').value : 'starter';
  if (key === 'check' && (!s || s.points.length < SPACE_MIN_POINTS)) { toast('A check chart compares the printer with an existing colour space – print and scan a full chart first.', 'error'); return; }
  s ??= createSpace();
  if (!s) return;
  const old = s.chart?.rounds[0];
  if (old && !old.patches.every((p) => p.lab) && !confirm(`Replace ${s.chart.name}?${scannedCount(old) ? ' The patches scanned so far stay in the colour space.' : ''}`)) return;
  const kind = key === 'check' ? 'check' : 'chart';
  const no = s.sessions.filter((q) => q.kind === kind).length + 1;
  const code = newCode();
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const patches = designChart(s.mode, CHART_SIZES[key].n, seed).map((p) => (s.mode === 'spot' ? { ...p, name: chartSpotName(code, no, p.n) } : p));
  s.chart = { id: `${kind}:${code}`, code, name: `${s.name} – ${kind === 'check' ? 'check chart' : 'chart'} ${no}`, target: null, refReads: [], accepted: false, next: 0,
    rounds: [{ round: no, mode: s.mode, kind, kFixed: 0, patches, result: null, chart: true }] };
  match.chartActive = true;
  commit({ withSpaces: true });
  debugLog('space', `${s.chart.name} created`, { kind, patches: patches.length, mode: s.mode, seed });
  toast(`${s.chart.name} created – ${patches.length} patches. Download, print and scan it.`, 'ok');
}

/** Show the colour space's chart in the sheet and scan cards (from the colour list or the Colour space card). */
function selectChart() {
  match.chartActive = true;
  commit();
}

/** Close the chart: back to the colours; what was scanned stays in the colour space. */
function closeChart() {
  const s = activeSpace(), r = s?.chart?.rounds[0];
  if (!r) return;
  const done = scannedCount(r);
  if (done < r.patches.length && !confirm(`Close ${s.chart.name}? ${done ? `The ${done} patches scanned so far stay in the colour space.` : 'Nothing has been scanned yet.'}`)) return;
  s.chart = null; match.chartActive = false;
  commit({ withSpaces: true });
}

/**
 * Add a scanned patch to the colour space: a chart's patches always go into its space, a colour's test-sheet patches
 * when learning is on and the space was measured with this sheet type. Says so once when a sheet prints differently
 * from what the space predicts.
 */
function learnPatch(c, r, p) {
  const chart = isChart(c);
  const s = chart || match.learn ? activeSpace() : null;
  if (!s || s.mode !== r.mode) return;
  const session = chart ? c.id : `sheet:${c.code}-R${r.round}`;
  const label = chart ? c.name : `${colourLabel(c)} – sheet ${r.round}`;
  const was = driftOf(s, session)?.drift;
  const check = learn(s, { session, kind: chart ? r.kind : 'sheet', label, n: p.n, x: pointX(r.mode, p.x, p.k ?? r.kFixed), lab: p.lab });
  saveSpaces();
  const d = driftOf(s, session);
  debugLog('space', `“${s.name}” learned ${label} #${p.n}`, { checkDeltaE: check, points: s.points.length, drift: d });
  if (d?.drift && !was) toast(`${label} prints differently from what the colour space “${s.name}” predicts (typically ΔE00 ${d.median.toFixed(2)} off) – the printer, ink or media may have changed. See Colour space.`, 'error');
}

/** Every patch of the chart is scanned: say so – and, for a check chart, whether the printer still prints as before. */
function onChartComplete(c) {
  const s = activeSpace(), r = c.rounds[0];
  if (r.kind !== 'check') { toast(`${c.name} complete – its ${r.patches.length} patches are in the colour space “${s?.name}”.`, 'ok'); return; }
  const d = s && driftOf(s, c.id);
  if (!d) toast('Check chart scanned – too few of its patches lie near measured ones to judge the printer.');
  else if (d.drift) toast(`Check chart: the printer prints differently from the colour space (typically ΔE00 ${d.median.toFixed(2)} off) – see Colour space.`, 'error');
  else toast(`Check chart: the printer still prints as the colour space predicts (typically ΔE00 ${d.median.toFixed(2)} off).`, 'ok');
}

/** Buttons inside the Colour space card's text: continue the chart, remove a set of measurements, keep only newer data. */
function onSpaceClick(e) {
  const b = e.target.closest('[data-space-act]'), s = activeSpace();
  if (!b || !s) return;
  const act = b.dataset.spaceAct;
  if (act === 'chart') { selectChart(); return; }
  if (act === 'remove') {
    const q = s.sessions.find((x) => x.id === b.closest('[data-session]').dataset.session);
    if (!q || !confirm(`Remove “${q.label}” (${sessionSize(s, q.id)} patches) from the colour space?`)) return;
    removeSession(s, q.id);
  } else if (act === 'trim') {
    const time = +b.dataset.time;
    const old = s.sessions.filter((q) => q.time < time);
    if (!old.length || !confirm(`Remove the ${old.length} older set${old.length > 1 ? 's' : ''} of measurements (${old.reduce((n, q) => n + sessionSize(s, q.id), 0)} patches) from the colour space, keeping only the data from ${fmtDate(time)} on?`)) return;
    keepFrom(s, time);
  }
  commit({ withSpaces: true });
}

/** The Colour space view: measure a colour (D50 / 2°, the job's M-factor) and show it in the 3-D picture. */
function measureForSpaceView() {
  return task('Measuring', async () => {
    const m = await measureLabD50();
    if (!m) return;
    showSpaceView();
    toast(`Measured L* ${m.lab[0].toFixed(1)} a* ${m.lab[1].toFixed(1)} b* ${m.lab[2].toFixed(1)} – shown as “Last measurement”.`, 'ok');
  });
}

// ---------------------------------------------------------------- start-up
// Files dropped anywhere on Print match: spot colour libraries go into the spot library, .icc/.icm files become
// printer profiles, colour spaces and CGATS measurement files become colour spaces. The browser would otherwise open a
// file dropped outside a drop zone, so every drop is caught.
function wireDrop() {
  const view = $('viewMatch');
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  let depth = 0; // dragenter/dragleave fire for every child element
  const highlight = (on) => { view.classList.toggle('outline-dashed', on); view.classList.toggle('outline-2', on); view.classList.toggle('outline-indigo-500', on); };
  for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => { if (hasFiles(e)) e.preventDefault(); });
  view.addEventListener('dragenter', (e) => { if (hasFiles(e) && depth++ === 0) highlight(true); });
  view.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth === 0) highlight(false); });
  view.addEventListener('drop', async (e) => {
    depth = 0; highlight(false);
    for (const file of e.dataTransfer?.files ?? []) {
      if (/\.ic[cm]$/i.test(file.name)) await addPrinterProfile(file);
      else if (/\.(json|txt|cgats|cgt|it8|ti3)$/i.test(file.name)) await importSpaceFile(file);
      else await importLibraryFile(file);
    }
  });
}

/** Colour list and reference card. */
function wireColours() {
  $('btnColourAdd').onclick = () => {
    match.colours.push(newColour());
    match.active = match.colours.length - 1;
    commit();
    $('mSpotName').focus();
  };
  $('mColourList').onclick = (e) => {
    const b = e.target.closest('[data-colour-act]');
    if (!b) return;
    const item = b.closest('[data-colour]').dataset.colour;
    if (item === 'chart') { selectChart(); return; }
    const i = +item;
    const c = match.colours[i];
    if (b.dataset.colourAct === 'remove') {
      if (c.rounds.length && !confirm(`Remove ${colourLabel(c)} and its measurements?`)) return;
      match.colours.splice(i, 1);
      if (match.active >= match.colours.length) match.active = match.colours.length - 1;
    } else { match.active = i; match.chartActive = false; }
    commit();
  };
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
  $('mSpotName').onchange = () => { activeColour().name = $('mSpotName').value.trim(); commit(); };
  $('mSpacePred').onclick = (e) => {
    const b = e.target.closest('[data-pred-act]');
    const c = activeColour(), p = b && spacePrediction(c);
    if (!p) return;
    if (b.dataset.predAct === 'copy') copyMatchValues(c, p, match.mode, p.k);
    else addResultToLibrary(c, p, match.mode);
  };
}

/** Settings card (and the tips under it). */
function wireSettings() {
  $('mMode').onchange = () => {
    if (match.colours.some((c) => c.rounds.length) && !confirm('Changing the sheet type starts every colour over. Continue?')) { $('mMode').value = match.mode; return; }
    match.mode = $('mMode').value; resetMatching(); commit();
  };
  // A preset or saved size fills in the width and height; editing either box makes the size custom.
  renderMediaOptions();
  $('mPaper').onchange = () => {
    match.media = $('mPaper').value;
    const size = mediaSizeOf(match.media);
    if (size) [match.mediaW, match.mediaH] = size;
    commit();
  };
  $('btnMediaSave').onclick = saveMediaSize;
  $('btnMediaRemove').onclick = removeMediaSize;
  for (const [id, key, lo, hi] of [['mMediaW', 'mediaW', 50, 3000], ['mMediaH', 'mediaH', 20, 10000]]) {
    $(id).oninput = () => { $('mPaper').value = 'custom'; };
    $(id).onchange = () => {
      match[key] = Math.min(Math.max(Math.round(+$(id).value * 10) / 10 || match[key], lo), hi);
      match.media = 'custom';
      commit(); // renderMatch raises a height below the minimum (and says so)
    };
  }
  $('mPatchMm').onchange = () => { match.patchMm = +$('mPatchMm').value; commit(); };
  $('mDesign').onchange = () => { match.design = $('mDesign').value; commit(); };
  $('mReads').onchange = () => { match.reads = Math.min(Math.max(+$('mReads').value || 1, 1), 9); for (const c of match.colours) c.refReads = []; commit(); };
  $('matchMf').onchange = () => { match.mf = +$('matchMf').value; commit(); };
  $('matchFormula').onchange = () => {
    match.formula = $('matchFormula').value;
    // re-judge every result with the new formula (the measurements stay)
    for (const c of match.colours) { const r = latest(c); if (r?.result) analyseColour(c, r); }
    commit();
  };
  $('mTol').onchange = () => { match.tol = Math.min(Math.max(+$('mTol').value || 1, 0.1), 20); commit(); };
  $('mPrinterProfile').onchange = () => { match.printerProfile = $('mPrinterProfile').value; commit(); };
  $('btnPrinterIcc').onclick = () => $('printerIccFile').click();
  onFilePicked('printerIccFile', addPrinterProfile);
  $('btnPrinterIccRemove').onclick = removePrinterProfile;
  refreshPrinterProfiles().then(() => { if (state.view === 'match') renderMatch(); });
  $('mRipFormat').onchange = () => { match.ripFormat = $('mRipFormat').value; commit(); };
  // folded sections remember whether they were open; Tips start closed
  for (const [id, key] of [['mTipsBox', 'sd10.tipsOpen'], ['mMoreSettings', 'sd10.moreSettingsOpen'], ['mLibEdit', 'sd10.libEditOpen']]) {
    $(id).open = readFlag(key);
    $(id).ontoggle = () => writeFlag(key, $(id).open);
  }
}

/** Sheet, scan and result cards. */
function wireSheetCards() {
  $('btnMatchSheet').onclick = startFirstSheet;
  $('btnMatchPdf').onclick = downloadSheet;
  $('btnMatchRipSheet').onclick = () => downloadRipLibrary('sheet');
  $('btnMatchRestart').onclick = restartSheet;
  $('btnMatchMeasure').onclick = measurePatch;
  $('btnMatchAnalyse').onclick = analyseMatch;
  $('mPatchGrid').onclick = (e) => {
    const b = e.target.closest('[data-patch]');
    const cur = b && currentSheet();
    if (!cur?.r.patches[+b.dataset.patch]) return;
    cur.c.next = +b.dataset.patch;
    commit({ withSpaces: isChart(cur.c) });
  };
  $('btnMatchRefine').onclick = makeNextSheet;
  $('mResult').onclick = (e) => {
    const b = e.target.closest('[data-res-act]');
    const c = b && match.colours.find((x) => x.id === b.closest('[data-res]').dataset.res);
    if (!c) return;
    if (b.dataset.resAct === 'accept') { c.accepted = !c.accepted; commit(); }
    else if (b.dataset.resAct === 'copy') copyMatchValues(c);
    else if (b.dataset.resAct === 'add') addResultToLibrary(c);
  };
}

/** Colour space card. */
function wireSpaceCard() {
  $('mChartSize').innerHTML = Object.entries(CHART_SIZES).map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)}</option>`).join('');
  $('mSpace').onchange = () => selectSpace($('mSpace').value);
  $('btnSpaceNew').onclick = createSpace;
  $('btnSpaceImport').onclick = () => $('spaceFile').click();
  onFilePicked('spaceFile', importSpaceFile);
  $('btnSpaceChart').onclick = createChart;
  $('mSpaceLearn').onchange = () => { match.learn = $('mSpaceLearn').checked; saveMatch(); };
  $('btnSpaceJson').onclick = () => { const s = activeSpace(); if (s) downloadFile(spaceToJson(s), 'application/json', `${safeFileName(s.name)}.json`); };
  $('btnSpaceCgats').onclick = () => { const s = activeSpace(); if (s?.points.length) downloadFile(spaceToCgats(s), 'text/plain', `${safeFileName(s.name)}.txt`); };
  $('btnSpaceRename').onclick = renameSpace;
  $('btnSpaceDelete').onclick = deleteSpace;
  $('mSpaceCard').addEventListener('click', onSpaceClick);
}

/** Spot library card. */
function wireLibrary() {
  $('btnLibDownload').onclick = () => downloadRipLibrary('library');
  $('btnLibImport').onclick = () => $('libFile').click();
  onFilePicked('libFile', importLibraryFile);
  $('btnLibClear').onclick = () => { if (confirm('Remove all colours from the spot library?')) { spotLib.colours = []; saveLib(); renderMatch(); } };
  $('mLibName').onchange = () => { spotLib.name = $('mLibName').value.trim() || DEFAULT_LIBRARY_NAME; saveLib(); renderMatch(); };
  $('mLibList').onclick = onLibraryClick;
  $('libAddForm').onsubmit = addLibraryColourByHand;
  $('btnLibFromLast').onclick = () => {
    if (!state.lastLabD50) { toast('Measure a colour first (in the Console or here in Print match).', 'error'); return; }
    state.lastLabD50.forEach((v, i) => { $(['libNewL', 'libNewA', 'libNewB'][i]).value = v.toFixed(2); });
    $('libNewName').focus();
  };
}

/** Called once by app.js with the Console's state and helpers; wires Print match and the Colour space view, opens the view in the URL. */
export function initMatch(app) {
  ({ state, task, settingsFromUI, updateControls, doCalibrate } = app);
  for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => setView(b.dataset.view);
  wireColours();
  wireSettings();
  wireSheetCards();
  wireSpaceCard();
  wireLibrary();
  wireDrop();
  initSpaceView(spaceViewData);
  $('vsMeasure').onclick = measureForSpaceView;
  setView(location.hash.slice(1) || 'console');
  WIDE.addEventListener('change', () => { if (!WIDE.matches && state.view !== 'console') setView('console'); });
}

/**
 * The SD-10's button in Print match: measure the next patch, or the reference while there is no sheet; in the Colour
 * space view: measure a colour to show in the picture.
 */
export function onMatchButton() {
  if (state.view === 'space') measureForSpaceView();
  else if (currentSheet()) measurePatch(); else measureMatchTarget();
}
