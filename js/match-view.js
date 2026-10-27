// Print match view: find the values that make the user's printer reproduce reference colors – the colors (typed,
// measured or imported from swatch and library files), test sheets (PDF / PNG), scanning the printed patches, per-color
// results with metamerism and gamut checks, the printer's color space (charts, predictions, learning), and the colors
// as a spot color library for the RIP. The maths is in match.js and colorspace.js, the library file formats in
// rip-export.js; this is the UI. It also owns the color spaces that the 3-D Color space view (space-view.js) shows, and
// switches between the views.
// It shares the Console's device session: app.js hands over its state and helpers once, through initMatch().
//
// Sections: stored data · what the cards work on · formatting · views · media sizes · printer profile (gamut check) ·
// rendering · measuring · sheets · colors in and out (swatch files, the library for the RIP) · color space · start-up.
import {
  $, DEMO, NEEDS_CALIBRATION, displayHex, downloadFile, escapeHtml, fmt1, formatValues, labText, onFilePicked, readFlag, round2, safeFileName,
  toast, valuesText, writeFlag,
} from './ui.js';
import { METHOD } from './protocol.js';
import { deltaE2000, labD50ToSrgb, meanSpectrum, rgbHex, spectrumToLab, srgbToLabD50 } from './color.js';
import { CUSTOM_PREFIX, PRINTER_PREFIX, loadProfile, printerProfiles } from './icc.js';
import {
  DESIGNS, DE_FORMULAS, MEDIA, MODES, MODE_NAME, analyseRound, averageReadings, buildSheetPdf, buildSheetPng, designPatches,
  metamerism, minSheetHeight, nextStep, patchSpotName, sheetLayout,
} from './match.js';
import { RIP_EXPORTS, readLibrary } from './rip-export.js';
import {
  CHART_SIZES, SPACE_MIN_POINTS, chartSpotName, designChart, designGapChart, driftOf, forgetPatch, gapFillers, invert, keepFrom, learn,
  newSpace, newSpaceId, pointX,
  readSpaceFile, refreshChecks, removeSession, sessionSize, spaceStats, spaceToCgats, spaceToJson,
} from './colorspace.js';
import { printSpectrum } from './printer-sim.js';
import { debugLog } from './debug.js';
import { loadJson, removeStored, saveJson } from './storage.js';
import { hideSpaceView, initSpaceView, showSpaceView } from './space-view.js';

// From the Console (set by initMatch): shared state, the busy-guarded task runner, the Console's settings (for the
// CMYK profile), the control refresh and white calibration.
let state, task, settingsFromUI, updateControls, doCalibrate;

// ---------------------------------------------------------------- stored data
/**
 * Data saved by versions that spelled "colour": a stored object's `colours` list becomes `colors`, and the color
 * spaces move from 'sd10.colourSpaces' to 'sd10.colorSpaces' (the old entry is removed once the new one is stored).
 */
function fromLegacySpelling(o) {
  if (o && Array.isArray(o.colours) && !o.colors) o.colors = o.colours;
  if (o) delete o.colours;
  return o;
}
function loadSpaces() {
  const legacy = loadJson(LEGACY_SPACES_KEY, null);
  const stored = loadJson(SPACES_KEY, null) ?? legacy ?? [];
  // spaces saved under an older check rule get their checks made again (and are saved once if anything changed)
  const rechecked = stored.map((s) => refreshChecks(s)).some(Boolean);
  if ((legacy || rechecked) && saveJson(SPACES_KEY, stored) && legacy) removeStored(LEGACY_SPACES_KEY);
  return stored;
}

// Persisted job (localStorage 'sd10.match'):
//   settings: mode, media ('custom' | a preset 'a4' … | 'size:<name>' for a saved size), mediaW/mediaH (mm – the size
//             in use, also for presets), patchMm,
//             design ('full' | 'compact'), mf, tol, reads, ripFormat, libraryName (the name inside the library file)
//   formula (DE_FORMULAS key), printerProfile (name of a stored printer profile for the gamut check, '' = none)
//   space (id of the color space in use, '' = none), learn (add scanned test-sheet patches to it),
//   fillIn (fill-in patches added to each test sheet where the color space has measured least – 0, 4, 8 or 'auto':
//          as many as fit in the free space of the pages the sheet needs anyway),
//   chartActive (the sheet and scan cards show the color space's chart instead of the selected color)
//   colors: [{ id, code, name, target, targetSpectrum, refReads, refSpectra, accepted, next,
//               rounds: [{ round, mode, centre, step, kFixed, design,
//                          patches: [{ n, offset, x, name?, reads, spectra, lab, spread, spectrum }
//                                    – fill-in patches: { n, x, k?, name?, fill: true, … }, no offset ], result,
//                          fromSpace? ({ name, dE } – the first sheet started from the color space's prediction) }] }]
//   active (index of the selected color)
//   scanLog: the last readings, newest last – [{ chart, id (color or chart id), round, index (patch index) }] – for
//            "Undo last scan"
// Every color is matched on its own: its own sheets (one per round), scan position (next = patch index) and result.
// The sheet, scan and result cards always work on the selected color, so several colors can be in progress at once.
// code: 4 characters in the color's patch spot names (SD10-<code>-R<round>-<n>), new for every fresh start.
const MATCH_KEY = 'sd10.match';
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const newCode = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const newColor = () => ({ id: newId(), code: newCode(), name: '', target: null, targetSpectrum: null, refReads: [], refSpectra: [], accepted: false, next: 0, rounds: [] });
const match = (() => {
  const m = fromLegacySpelling(loadJson(MATCH_KEY, {}));
  if (!m.colors && (m.target || m.rounds?.length)) {
    // single-color job saved by an earlier version: becomes the first color
    m.colors = [{ id: newId(), name: m.spotName ?? '', target: m.target ?? null, refReads: m.refReads ?? [], accepted: false, next: m.next ?? 0, rounds: m.rounds ?? [] }];
    if (m.paper) m.media = m.paper;
    for (const k of ['target', 'rounds', 'spotName', 'refReads', 'paper']) delete m[k];
  }
  // jobs saved while all colors shared one sheet: give each color its own code and scan position
  for (const c of m.colors ?? []) {
    c.code ??= m.jobId && c === m.colors[0] ? m.jobId : newCode();
    c.next ??= m.next?.c === c.id ? m.next.i : 0;
  }
  for (const k of ['sheet', 'next', 'jobId']) delete m[k];
  const out = { mode: 'spot', media: 'custom', mediaW: 210, mediaH: 297, patchMm: 20, design: 'full', mf: 1, tol: 1, reads: 1,
    formula: 'de00', printerProfile: '', ripFormat: 'cxf', space: '', learn: true, fillIn: 0, chartActive: false, colors: [], active: 0, scanLog: [], ...m };
  if (!out.colors.length) out.colors = [newColor()];
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

// The colors are also the spot library for the RIP: each is exported under its name with its recommended L*a*b*
// (libraryName: the name inside the file). A separate spot library kept by earlier versions ('sd10.spotLibrary') is
// retired on load – its colors are not carried over, its name is.
const DEFAULT_LIBRARY_NAME = 'SD-10 spot colors';
{
  const OLD_LIB_KEY = 'sd10.spotLibrary';
  const old = loadJson(OLD_LIB_KEY, null);
  if (old) {
    match.libraryName ??= typeof old.name === 'string' && old.name.trim() ? old.name.trim().slice(0, 60) : undefined;
    removeStored(OLD_LIB_KEY);
    saveMatch();
  }
}

// Color spaces (see colorspace.js): measured maps of what a printer, ink and media really print, independent of the
// current job. The one in use (match.space) predicts the first-sheet values for the sheet type it was measured with,
// and learns from every scanned patch. A chart being scanned (space.chart) has the shape of a color with one round –
// { id, code, name, target: null, next, rounds: [{ round, mode, kind, kFixed, patches, chart: true }] } – so the sheet
// and scan cards handle it like a color's sheet.
const SPACES_KEY = 'sd10.colorSpaces';
const LEGACY_SPACES_KEY = 'sd10.colourSpaces';
const spaces = loadSpaces();
let spaceStorageWarned = false;
function saveSpaces() {
  if (saveJson(SPACES_KEY, spaces) || spaceStorageWarned) return;
  spaceStorageWarned = true;
  toast('The browser storage is full – color space changes are kept for this session only. Export the color space to keep it.', 'error');
}

/** Save the job – and the color spaces, when they changed too – and redraw the view. */
function commit({ withSpaces = false } = {}) {
  saveMatch();
  if (withSpaces) saveSpaces();
  renderMatch();
}

// ---------------------------------------------------------------- what the cards work on
const activeColor = () => match.colors[match.active] ?? match.colors[0];
const latest = (c) => c.rounds[c.rounds.length - 1] ?? null;
const colorLabel = (c) => c.name || `Color ${match.colors.indexOf(c) + 1}`;
const activeSpace = () => spaces.find((s) => s.id === match.space) ?? null;
/** The color space that predicts for the current sheet type – null for none, or one measured with another sheet type. */
const usableSpace = () => { const s = activeSpace(); return s && s.mode === match.mode ? s : null; };
/** The color space's chart while it is selected in the color list, else null. */
const activeChart = () => (match.chartActive && activeSpace()?.chart) || null;
const isChart = (c) => !!c?.rounds?.[0]?.chart;
/** What the sheet and scan cards work on: the color space's chart while it is selected, else the selected color. */
const workItem = () => activeChart() ?? activeColor();
/** The work item and its current round (latest sheet) – what the sheet, scan and result cards work on – or null. */
const currentSheet = () => { const c = workItem(), r = latest(c); return r ? { c, r } : null; };
const scannedCount = (r) => r.patches.filter((p) => p.lab).length;
/** A round without its fill-in patches – what the match is worked out from (they only feed the color space). */
const matchPart = (r) => (r.patches.some((p) => p.fill) ? { ...r, patches: r.patches.filter((p) => !p.fill) } : r);
/** The color-space session a sheet's patches go into: the chart itself, or one per color and sheet. */
const spaceSessionId = (c, r) => (isChart(c) ? c.id : `sheet:${c.code}-R${r.round}`);

/** Index of the patch to measure next: the color's scan position, or else its first unmeasured patch. */
const nextPatchIndex = (c, r) => (r.patches[c.next] ? c.next : Math.max(0, r.patches.findIndex((p) => !p.lab)));
/** A color's (or the chart's) round as a sheet-layout group. */
const sheetGroup = (c, r) => ({ label: colorLabel(c), target: c.target, patches: r.patches, kFixed: r.kFixed });
/** Title printed on a sheet (the default for a color's test sheet). */
const sheetTitle = (c) => (isChart(c) ? 'SD-10 color space chart' : undefined);
/** The color difference formula chosen for judging matches: { label, name, fn(ref, sample), lWeight }. */
const DE = () => DE_FORMULAS[match.formula] ?? DE_FORMULAS.de00;
/** Sheet types whose values are L*a*b* – the ones a spot color library can hold. */
const isLabMode = (mode) => mode === 'spot' || mode === 'lab';

// ---------------------------------------------------------------- formatting
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const roundSpectrum = (s) => s.map((v) => Math.round(v * 1e5) / 1e5);

function cmykPreviewHex([c, m, y], k) {
  const ch = (v) => Math.round(255 * (1 - v / 100) * (1 - k / 100));
  return rgbHex([ch(c), ch(m), ch(y)]);
}
function patchPreviewHex(mode, x, k) {
  return mode === 'cmyk' ? cmykPreviewHex(x, k) : mode === 'rgb' ? rgbHex(x) : displayHex(x);
}
/** Values as tiles – large in a result, smaller in the color space prediction. */
function valueTilesHtml(mode, x, k, { large = false } = {}) {
  const tiles = formatValues(mode, x, k).map(([key, v]) => `<div class="rounded-lg bg-slate-100 dark:bg-slate-800 ${large ? 'px-3 py-2' : 'px-2 py-1.5'} text-center"><div class="text-[10px] text-slate-500">${key}</div><div class="font-mono ${large ? 'text-xl ' : ''}tabular-nums">${v}</div></div>`).join('');
  return `<div class="grid ${isLabMode(mode) ? 'grid-cols-3' : 'grid-cols-4'} gap-2${large ? '' : ' max-w-md'}">${tiles}</div>`;
}

function modeHelp(mode) {
  const profile = escapeHtml(settingsFromUI().cmykProfile.replace(CUSTOM_PREFIX, ''));
  return {
    spot: 'For RIPs and workflows that color named spot colors from an L*a*b* library. Every patch is a uniquely named spot color with its L*a*b* value as the alternate, so the RIP handles the sheet like the spot colors in your artwork. Enter the result as the L*a*b* value of your named color in the RIP.',
    lab: 'Patches are plain CIE L*a*b* objects. This only matches a spot color workflow if the RIP converts Lab objects with the same profile and rendering intent as named colors – otherwise use spot colors.',
    cmyk: `For documents that send CMYK numbers to the printer. The starting values come from the CMYK profile selected in the Console (${profile}); K is kept fixed.`,
    rgb: 'For software that only accepts raster images. The sheet is an sRGB PNG and the result is an sRGB value / hex for your artwork – keep the artwork in sRGB like the sheet.',
  }[mode] + ' Colors are measured at D50 / 2°. Several colors can be in progress at once, each with its own sheets; 8 patches per color need less media, 16 are more robust on noisy or uneven prints.';
}

function printTips(mode) {
  const tips = ['<b>Print it exactly like the final job:</b> same printer, media, quality and color settings, at 100% / actual size (not "fit to page"). Let the ink dry before scanning.',
    '<b>Transferred, cured or finished prints:</b> process the sheet exactly like production (pressing, curing, laminating …) and scan the finished product, not the raw print. On textured or uneven surfaces use 3 or more readings per patch.',
    '<b>Patch size:</b> each patch must cover the SD-10’s whole measuring area with some room to spare – if readings of the same patch jump around, use larger patches.'];
  if (mode === 'spot') tips.push('<b>Spot library:</b> if your RIP imports spot color libraries (CxF3 is the common standard; Adobe Color Book, Edge Print and VersaWorks files are also offered), import the sheet library and enable it before printing, so the patches take the named-color path. Otherwise unknown spot colors normally print from their L*a*b* alternate – check that the RIP does not substitute or reject them.');
  if (mode === 'rgb') tips.push('<b>Substrate:</b> print on the same substrate color, with the same underlayers or pre-treatment, as the final job.');
  tips.push('<b>Color space:</b> print and scan a chart of your printer once, and every color’s first sheet starts from a prediction instead of a guess – often within tolerance straight away. Make one color space per printer, ink, media and RIP setting, and print a check chart now and then to see whether the printer has changed.');
  return tips.map((t) => `<p>${t}</p>`).join('');
}

// ---------------------------------------------------------------- views
// Print match and the Color space view are desktop / tablet workflows (PDFs, spot libraries, RIP software): phones
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

/** What the 3-D Color space view shows: the color spaces, the one in use, the reference colors and the last color measured. */
const spaceViewData = () => ({
  spaces,
  active: match.space,
  formula: match.formula,
  refs: [
    ...match.colors.filter((c) => c.target).map((c) => ({ id: c.id, name: colorLabel(c), lab: c.target })),
    ...(state.lastLabD50 ? [{ id: 'last', name: 'Last measurement', lab: state.lastLabD50 }] : []),
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
 * Media heights for the chosen width, patch size and patches per color (whole mm, null when the patches do not fit
 * across the width): min = one row of patches plus the sheet's text (the smallest usable height), onePage = each
 * color on a single page.
 */
function heightLimits() {
  const cur = currentSheet();
  // the current sheet, or a stand-in color with the chosen number of patches before there is one
  const group = cur ? sheetGroup(cur.c, cur.r) : { label: 'Color 1', target: [50, 0, 0], kFixed: 0,
    // 'auto' fill-ins only use free slots, so they never need more height
    patches: Array.from({ length: (DESIGNS[match.design] ?? 16) + (+fillInSetting() || 0) }, (_, i) => ({ n: i + 1, offset: [0, 0, 0], x: [0, 0, 0], name: 'SD10-XXXX-R1-01' })) };
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
  const need = match.colors.filter((c) => c.target && !gamutCache.has(gamutKey(c)));
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
  const closest = `<span class="font-mono">${labText(g.closest)}</span>`;
  return {
    inside: `<span class="text-emerald-600">Inside the printer gamut</span> <span class="text-slate-500">(profile round trip ΔE00 ${g.dE.toFixed(2)})</span>`,
    edge: `<span class="text-amber-600">At the edge of the printer gamut – the closest printable color is ${closest}, ΔE00 ${g.dE.toFixed(2)} away.</span>`,
    outside: `<span class="text-rose-600"><b>Outside the printer gamut.</b> The closest printable color is ${closest}, ΔE00 ${g.dE.toFixed(2)} away – no amount of matching gets much closer with this printer, ink and media.</span>`,
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
  const color = activeColor(), c = workItem(), chart = isChart(c);
  const cur = currentSheet();
  const p = cur && cur.r.patches[nextPatchIndex(c, cur.r)];
  $('btnMatchTarget').disabled = !idle;
  $('btnMatchUseLast').disabled = !(state.lastLabD50 || state.last) || state.busy;
  $('btnMatchSheet').disabled = chart || !c.target || state.busy;
  $('btnMatchMeasure').disabled = !idle || !cur;
  $('btnMatchAnalyse').disabled = state.busy || !cur || scannedCount(matchPart(cur.r)) < 5;
  $('btnMatchAnalyse').classList.toggle('hidden', chart);
  const undo = lastScan();
  $('btnMatchUndo').disabled = state.busy || !undo;
  $('btnMatchUndo').title = undo ? `Undo the last scan: patch #${undo.p.n} of ${colorLabel(undo.c)}${isChart(undo.c) ? '' : ` – sheet ${undo.r.round}`}` : 'Nothing to undo';
  $('btnMatchRefine').disabled = state.busy || !c.target || c.accepted;
  $('btnSpaceChart').disabled = state.busy;
  $('vsMeasure').disabled = !idle;
  const reading = (n) => (match.reads > 1 ? ` (reading ${n + 1}/${match.reads})` : '');
  $('btnMatchMeasure').textContent = busyLabel ? `${busyLabel}…`
    : !p ? 'Measure patch' : `Measure patch #${p.n}${match.colors.length > 1 && !chart ? ` – ${colorLabel(c)}` : ''}${reading(p.lab ? 0 : p.reads?.length ?? 0)}`;
  $('btnMatchTarget').textContent = `Measure reference${color.refReads.length ? reading(color.refReads.length) : ''}`;
}

/**
 * The values to use for a color now – what the result card shows big, what Copy values copies and what the spot library
 * gets – from a round's result (default: the latest round with one):
 *   confirmed – a patch printed within tolerance: a measured answer beats any refinement. The sheet's centre values,
 *               unless another patch printed clearly closer (by more than the measuring noise) – then that patch's;
 *   measured  – the result is only a rough estimate beyond the sheet's patches: until a sheet confirms it, the best patch
 *               measured so far (values that really printed);
 *   result    – the result itself (interpolated within the sheet, or a measured patch already).
 * Returns { x, k, mode, dE, measured (dE was measured, not predicted), why, round, n (the patch, when not the centre) }
 * or null.
 */
function useNow(c, r = [...c.rounds].reverse().find((x) => x.result)) {
  const res = r?.result;
  if (!res) return null;
  // the best patch printed so far (on this sheet or an earlier one) – its values and how close it printed
  const bestRound = res.bestEver?.round ?? r.round, bestN = res.bestEver?.n ?? res.best.n, bestDE = res.bestEver?.dE ?? res.best.dE;
  const rr = c.rounds.find((x) => x.round === bestRound), bp = rr?.patches.find((q) => q.n === bestN);
  const bestPatch = bp && { x: bp.x, k: bp.k ?? rr.kFixed, mode: rr.mode, dE: bestDE, measured: true, round: bestRound, n: bestN };
  const centreOk = res.centreDE != null && res.centreDE <= match.tol;
  const noise = Math.max(0.3, res.repeatability ?? 0);
  if (centreOk && !(bestPatch && res.centreDE - bestDE > noise)) {
    return { x: r.centre, k: r.kFixed, mode: r.mode, dE: res.centreDE, measured: true, why: 'confirmed', round: r.round };
  }
  if (bestPatch && bestDE <= match.tol) return { ...bestPatch, why: 'confirmed' };
  if (res.extrapolated && bestPatch) return { ...bestPatch, why: 'measured' };
  const measured = res.source === 'best-patch' || res.source === 'best-earlier';
  return { x: res.x, k: r.kFixed, mode: r.mode, dE: res.predictedDeltaE, measured, why: 'result', round: r.round };
}

function colorStatus(c) {
  if (!c.target) return 'no reference yet';
  if (c.accepted) return 'accepted';
  const r = latest(c);
  if (!r) return 'no sheet yet';
  if (r.result) {
    const u = useNow(c, r);
    return u.why === 'confirmed' ? `done · printed ${DE().label} ${u.dE.toFixed(2)}` : `round ${r.round} · ${u.measured ? 'printed' : 'predicted'} ${DE().label} ${u.dE.toFixed(2)}`;
  }
  return `round ${r.round} · ${scannedCount(r)}/${r.patches.length} scanned`;
}

/** The color list, with the color space's chart at the top while one is being scanned. */
function colorListHtml() {
  const selected = 'ring-2 ring-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30', unselected = 'ring-slate-200 dark:ring-slate-800';
  const chart = activeSpace()?.chart;
  const chartItem = !chart ? '' : `<li data-color="chart" class="flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 ring-1 ${activeChart() ? selected : unselected}">
      <button type="button" data-color-act="select" class="flex flex-1 min-w-0 items-center gap-2 text-left">
        <span class="h-8 w-8 flex-none rounded ring-1 ring-black/10" style="background:conic-gradient(#e11d48,#f59e0b,#84cc16,#06b6d4,#6366f1,#d946ef,#e11d48)"></span>
        <span class="min-w-0 flex-1"><span class="block font-medium truncate">${escapeHtml(chart.name)}</span>
          <span class="block text-xs text-slate-500">color space chart · ${scannedCount(chart.rounds[0])}/${chart.rounds[0].patches.length} scanned</span></span></button></li>`;
  // a single untouched color: the rest of the list explains how colors come in
  const fresh = match.colors.length === 1 && !match.colors[0].target && !match.colors[0].name;
  const hint = !fresh ? '' : `<li class="grid flex-1 place-items-center py-6 text-center">
      <div class="max-w-xs space-y-2">
        <p class="text-sm font-medium text-slate-700 dark:text-slate-200">Your colors go here</p>
        <p class="text-xs text-slate-500">Measure or type a reference for this one, add more with <b>+ Add color</b>, or <b>Import…</b> the swatches of your artwork (Adobe Swatch Exchange) or a spot color library – each comes in under its name, ready to match.</p>
      </div></li>`;
  return chartItem + match.colors.map((x, i) => `<li data-color="${i}" class="flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 ring-1 ${i === match.active && !activeChart() ? selected : unselected}">
      <button type="button" data-color-act="select" class="flex flex-1 min-w-0 items-center gap-2 text-left">
        <span class="h-8 w-8 flex-none rounded ring-1 ring-black/10 ${x.target ? '' : 'bg-slate-200 dark:bg-slate-700'}" ${x.target ? `style="background:${displayHex(x.target)}"` : ''}></span>
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-2"><span class="font-medium truncate">${escapeHtml(colorLabel(x))}</span>
            ${gamutClass(gamutFor(x)) === 'outside' ? '<span class="chip bg-rose-600 text-white !px-1.5 !py-0 text-[10px]" title="Outside the printer gamut">OUT OF GAMUT</span>' : ''}</span>
          <span class="block text-xs ${x.accepted ? 'text-emerald-600' : 'text-slate-500'}">${x.target ? `<span class="font-mono">${x.target.map((v) => v.toFixed(1)).join(' / ')}</span> · ` : ''}${colorStatus(x)}</span>
          ${outputLineHtml(x)}
        </span></button>
      ${match.colors.length > 1 ? '<button type="button" data-color-act="remove" class="text-xs text-rose-600 hover:underline px-1" title="Remove this color">remove</button>' : ''}</li>`).join('') + hint;
}

/** The color list's second line: the L*a*b* the library file gives this color, and where it comes from. */
function outputLineHtml(c) {
  if (!c.target || !isLabMode(match.mode)) return '';
  const o = outputOf(c, { later: true });
  const swatch = (lab) => `<span class="inline-block h-2.5 w-2.5 rounded-sm align-middle ring-1 ring-black/10" style="background:${displayHex(lab)}"></span>`;
  if (o === undefined) return '<span class="block text-xs text-slate-400">→ working out the prediction…</span>';
  if (!o) return '<span class="block text-xs text-slate-400" title="No test sheet result or color space prediction yet – the library gives the reference">→ the reference (no recommendation yet)</span>';
  const from = { confirmed: 'confirmed', result: 'result', 'sheet-patch': 'printed', prediction: 'predicted', measured: 'measured' }[o.source];
  const why = { confirmed: 'its sheet values, which printed within tolerance', result: 'its latest test-sheet result', 'sheet-patch': 'the best patch printed so far – the result is still a rough estimate', prediction: 'the color space prediction', measured: 'a patch the color space measured' }[o.source];
  return `<span class="block text-xs text-indigo-600 dark:text-indigo-400" title="The L*a*b* the library file gives this color (${why}, ${DE().label} ${o.dE.toFixed(2)} from the reference) – enter it for the named color in the RIP">→ ${swatch(o.lab)} <span class="font-mono">${o.lab.map(fmt1).join(' / ')}</span> · ${from} ${o.dE.toFixed(2)}</span>`;
}

/** Draw the whole Print match view from the job. */
function renderMatch() {
  renderColorList();
  renderReferenceCard(activeColor());
  renderSettings();
  renderSheet(workItem());
  renderPatchGrid(workItem());
  renderMatchResult();
  renderSpaceCard();
  renderLibraryExport();
  updateControls();
  updateGamut();
}

/** The Colors card's list (the selected entry kept in view when the list scrolls). */
function renderColorList() {
  $('mColorCount').textContent = match.colors.length > 1 ? `(${match.colors.length})` : '';
  const list = $('mColorList');
  list.innerHTML = colorListHtml();
  const selectedItem = list.querySelector(activeChart() ? '[data-color="chart"]' : `[data-color="${match.active}"]`);
  if (selectedItem && list.clientHeight) {
    const top = selectedItem.offsetTop, bottom = top + selectedItem.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top - 4;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
  }
}

/** Card 1: the selected color's name and reference, its gamut check and the color space's prediction (hidden for the chart). */
function renderReferenceCard(c) {
  const t = c.target;
  $('mRefCard').classList.toggle('hidden', !!activeChart());
  for (const [id, i] of [['mL', 0], ['mA', 1], ['mB', 2]]) if (document.activeElement !== $(id)) $(id).value = t ? t[i].toFixed(2) : '';
  if (document.activeElement !== $('mSpotName')) $('mSpotName').value = c.name;
  $('mTargetSwatch').style.background = t ? displayHex(t) : '';
  $('mStatusTarget').textContent = c.refReads.length ? `– reading ${c.refReads.length}/${match.reads}, measure another spot` : t ? `– ${displayHex(t)}` : '– not set';
  $('mGamut').innerHTML = gamutHtml(c);
  const prediction = spacePredictionHtml(c);
  $('mSpacePred').innerHTML = prediction;
  $('mSpacePred').classList.toggle('hidden', !prediction);
}

/** The Settings card, the Measuring & matching dialog and the tips. */
function renderSettings() {
  $('matchFormula').value = match.formula in DE_FORMULAS ? match.formula : 'de00';
  $('mPrinterProfile').value = match.printerProfile;
  $('btnPrinterIccRemove').classList.toggle('hidden', !match.printerProfile);
  $('mMode').value = match.mode; $('matchMf').value = match.mf; $('mTol').value = match.tol;
  $('mReads').value = match.reads; $('mPatchMm').value = match.patchMm; $('mDesign').value = match.design;
  // the height always holds at least one row of patches plus the sheet's text: raise it (and say so) when the width,
  // patch size, patches per color or sheet type ask for more
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
  $('mLibNameWrap').classList.toggle('hidden', !isLabMode(match.mode));
  if (!RIP_EXPORTS[match.ripFormat]) match.ripFormat = 'cxf';
  $('btnMatchRipSheet').title = `Spot color library with this sheet's patch colors, in ${RIP_EXPORTS[match.ripFormat].label} format (chosen on the Colors card) – import it into the RIP before printing`;
  $('mModeHelp').innerHTML = `<b>${escapeHtml($('mMode').selectedOptions[0]?.textContent ?? 'Sheet type')}:</b> ${modeHelp(match.mode)}`;
  $('mPrintTips').innerHTML = printTips(match.mode);
  // the Measuring & matching line shows the dialog's current values
  $('mMoreSummary').textContent = `${['M0', 'M1', 'M2'][match.mf] ?? 'M1'} · ${DE().label} ≤ ${match.tol}${match.reads > 1 ? ` · ${match.reads} readings` : ''}${match.printerProfile ? ' · gamut check' : ''}`;
}

/** Card 2: the current sheet (the selected color's, or the color space chart) – what it holds, how it prints, the downloads. */
function renderSheet(c) {
  const r = latest(c), chart = isChart(c);
  $('mRoundLabel').textContent = `· ${colorLabel(c)}${r && !chart ? ` – sheet ${r.round}` : ''}`;
  $('btnMatchSheet').classList.toggle('hidden', chart);
  $('btnMatchSheet').textContent = r ? 'New first sheet' : 'Create sheet';
  $('mSheetActions').classList.toggle('hidden', !r);
  $('btnMatchPdf').textContent = (r?.mode ?? match.mode) === 'rgb' ? 'Download PNG' : 'Download PDF';
  $('btnMatchRipSheet').classList.toggle('hidden', r?.mode !== 'spot');
  $('btnMatchRestart').textContent = chart ? 'Close chart' : 'Start over';
  $('btnMatchRestart').title = chart ? 'Back to your colors – the patches scanned so far stay in the color space' : "Discard this color's sheets and measurements (its reference is kept)";
  if (!chart && !c.target) { $('mSheetInfo').textContent = `Set the reference of ${colorLabel(c)} first.`; return; }
  if (!r) {
    const fill = fillInSetting();
    const fillText = fill === 'auto' ? ', with fill-in patches for the color space in its free space' : fill ? `, plus ${fill} fill-in patches for the color space` : '';
    $('mSheetInfo').textContent = `Creates a sheet of ${DESIGNS[match.design] ?? 16} ${MODE_NAME[match.mode]} patches for ${colorLabel(c)}, around a first estimate of its reference${fillText}.`;
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
      ? '<b class="text-emerald-600">All patches are scanned and in the color space.</b> Close the chart to go back to your colors.'
      : 'Print it like the final job and scan the patches in number order – each goes into the color space as you scan it.'}</p>${names}${preview}`;
  } else {
    const vals = valuesText(r.mode, r.centre, r.kFixed);
    const steps = r.step.map((v, k) => `${MODES[r.mode].axes[k]} ±${fmt1(v)}`).join(', ');
    const from = r.fromSpace ? `<p class="mt-1 text-xs">Starts from the color space prediction (${escapeHtml(r.fromSpace.name)}, predicted ${DE().label} ${r.fromSpace.dE.toFixed(2)}).</p>` : '';
    const fills = r.patches.filter((p) => p.fill).length;
    $('mSheetInfo').innerHTML = `${r.patches.length} patches${fills ? ` (${fills} fill-in for the color space)` : ''}${pages}. Download, print and scan the patches below.
      <p class="mt-1 text-xs">Round ${r.round}: centre <span class="font-mono">${vals}</span> · steps ${steps}</p>${from}${names}${preview}`;
  }
  if (layout) wirePreview(`${c.id}|${r.round}|${layout.W}x${layout.H}`, Math.min(...layout.pages[0].boxes.map((b) => b.x)) / layout.W);
}

/**
 * A small to-scale drawing of the sheet's first page, from the same layout as the PDF: patches in their print colors
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
  // the figure and the close-up stretch to fill the card's free height (124–240 px: beside a long scan card it would
  // otherwise grow huge); the drawing's width follows its height through aspect-ratio, so a taller close-up stays to scale
  return `<figure class="mt-3 flex-1 flex flex-col gap-1.5">
    <div class="${label}">Whole sheet · ${notes}</div>
    <div id="mPreviewOverview" class="relative w-full cursor-pointer overflow-hidden rounded-sm bg-white ring-1 ring-black/10" style="aspect-ratio:${W.toFixed(1)}/${H.toFixed(1)}" title="Click to show this part in the close-up">${drawing}
      <div id="mPreviewWindow" class="pointer-events-none absolute inset-y-0 rounded-sm bg-indigo-500/10 ring-2 ring-indigo-500"></div></div>
    <div class="${label} pt-1">Close-up – scroll sideways, or click the whole sheet above</div>
    <div id="mPreviewZoom" class="relative flex-1 min-h-[124px] max-h-[240px] overflow-x-auto"><div class="absolute inset-y-0 left-0 rounded-sm bg-white ring-1 ring-black/10" style="aspect-ratio:${W.toFixed(1)}/${H.toFixed(1)}">${drawing}</div></div>
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

/** Card 3: the current sheet's patches – measured ones in their measured color, the next one outlined. */
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
    scrollToPatch($('mChartGrid'), next);
    return;
  }
  // as many per row as the card's width holds; a long sheet (fill-ins) scrolls inside the card, kept at the next patch
  const long = r.patches.length > 16;
  $('mPatchGrid').innerHTML = `<div id="mSheetGrid" class="relative grid grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] gap-2 ${long ? 'max-h-[21rem] overflow-y-auto p-0.5' : ''}">${r.patches.map((p, i) => {
    const done = !!p.lab;
    const bg = done ? displayHex(p.lab) : patchPreviewHex(r.mode, p.x, p.k ?? r.kFixed);
    const dE = done && c.target && !p.fill ? DE().fn(c.target, p.lab) : null; // a fill-in patch is not aiming at the reference
    const partial = !done && p.reads?.length ? `${p.reads.length}/${match.reads}` : '';
    const uneven = done && p.spread > 1.5; // readings disagree – textured / uneven print
    const title = `Patch #${p.n}${p.fill ? ' · fill-in for the color space' : ''}${p.name ? ' · ' + p.name : ''}${done && p.spread != null && p.reads?.length > 1 ? ` · ${p.reads.length} readings, spread ΔE00 ${p.spread.toFixed(2)}` : ''}${done ? ' – tap to re-measure' : ''}`;
    return `<button type="button" data-patch="${i}" class="text-left rounded-lg p-1.5 ring-1 ${i === next ? 'ring-2 ring-indigo-500' : 'ring-slate-200 dark:ring-slate-800'} ${p.fill ? 'outline-dashed outline-1 outline-offset-[-3px] outline-slate-400' : ''}" title="${escapeHtml(title)}">
      <div class="h-10 rounded-md ${done ? '' : 'opacity-40'}" style="background:${bg}"></div>
      <div class="flex justify-between text-[11px] mt-1"><b>#${p.n}${uneven ? ' <span class="text-amber-600" title="Readings differ by more than 1.5 ΔE00">!</span>' : ''}</b><span class="font-mono ${dE != null && dE <= match.tol ? 'text-emerald-600' : 'text-slate-500'}">${dE != null ? 'ΔE ' + dE.toFixed(1) : partial || (p.fill ? 'fill' : '')}</span></div>
    </button>`;
  }).join('')}</div>`;
  if (long) scrollToPatch($('mSheetGrid'), next);
}

/** Keep the patch to scan next in view in a scrolling patch grid. */
function scrollToPatch(grid, index) {
  const b = grid.children[index];
  if (b && grid.clientHeight) grid.scrollTop = b.offsetTop - grid.clientHeight / 2;
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
    <p class="mt-1 text-slate-500">The metamerism index is how far the two colors drift apart under that light once the D50 difference is taken out. ${bad
      ? 'The ink and the reference reflect light differently across the spectrum, so a match under every light may not be possible with these inks – check the color under the light the product will be seen in, and match for that light if it matters most.'
      : 'Values up to about 1 are hard to see.'}${m.d50 > 3 ? ' The patch is still far from the reference under D50, so treat this as a first indication – it becomes reliable as the match gets close.' : ''}</p></details>`;
}

/**
 * When the recommended patch is not the one that measured lowest: they printed alike (within the measuring noise), and
 * of such patches the one whose values are nearest the reference is recommended – near the gamut edge, more extreme
 * values only measure better by chance.
 */
function pickNote(res) {
  const lowest = res.bestEver ?? { ...res.best, round: null };
  if (res.pickN == null || (res.pickN === lowest.n && (lowest.round == null || res.pickRound === lowest.round))) return '';
  const where = (round, n) => (round != null && round !== res.pickRound ? `sheet ${round} #${n}` : `#${n}`);
  return ` Patch ${where(lowest.round, lowest.n)} measured slightly lower (${DE().label} ${lowest.dE.toFixed(2)} against ${res.predictedDeltaE.toFixed(2)}) – within the measuring noise – but #${res.pickN}'s values are nearer the reference: where patches print alike, more extreme values only measure better by chance.`;
}

/**
 * Card 4: one color's result – the values to use now (see useNow), how close they print, the one thing to know about
 * them, and the round history.
 */
function resultHtml(c) {
  const r = latest(c);
  const res = r.result;
  const u = useNow(c, r);
  const fmt = (x, k) => `<span class="font-mono">${valuesText(r.mode, x, k)}</span>`;
  const differs = u.x.some((v, k) => Math.abs(v - res.x[k]) >= 0.05);
  const within = u.why === 'confirmed' || (u.dE <= match.tol && !res.extrapolated);
  const gamut = gamutClass(gamutFor(c));
  const bestElsewhere = res.bestEver && res.bestEver.round !== r.round;
  const where = (round, n) => (round !== r.round ? `patch #${n} of sheet ${round}` : `patch #${n}`);
  // the one message that explains these values – the most important situation wins
  let note = '';
  if (u.why === 'confirmed') {
    note = `<div class="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"><b>Done.</b> ${u.n != null ? `The values of ${where(u.round, u.n)}` : "This sheet's centre values"} printed within tolerance (${DE().label} ${u.dE.toFixed(2)}) – use them, and accept the color.${differs && res.predictedDeltaE < u.dE ? ` Another sheet could still try ${fmt(res.x, r.kFixed)} (predicted ${DE().label} ${res.predictedDeltaE.toFixed(2)}${res.extrapolated ? ', a rough estimate' : ''}), but it isn't needed.` : ''}</div>`;
  } else if (res.regressed) {
    note = `<p class="text-xs text-amber-600"><b>The last change made the color worse</b> (this sheet's centre printed ${DE().label} ${res.centreDE.toFixed(2)}), so these are the values of ${where(res.pickRound ?? res.bestEver.round, res.pickN ?? res.bestEver.n)}, the best so far; the next sheet searches around them in smaller steps.</p>`;
  } else if (res.gamutLimited && u.dE > match.tol) {
    note = gamut === 'inside'
      ? `<p class="text-xs text-rose-600"><b>Your printer profile says this color is printable, but the prints stop getting closer at ${DE().label} ${u.dE.toFixed(2)}.</b> The profile probably doesn't describe how this printer, ink and media really print – or the measuring conditions differ (M-factor, drying, lamination). Re-profiling the media, or checking the RIP's media and ink settings, will help more than further rounds.</p>`
      : `<p class="text-xs text-rose-600"><b>The reference looks outside what this printer and media can reproduce.</b> Nothing within reach is predicted closer than ${DE().label} ${u.dE.toFixed(2)} – more rounds will not get much closer. Use these values as the closest match. If your RIP shows the color as printable, its media profile probably doesn't match the real prints – check the media, ink limits and color settings.</p>`;
  } else if (u.why === 'measured') {
    note = `<p class="text-xs text-amber-600"><b>The best guess lies beyond this sheet's patches</b> – ${fmt(res.x, r.kFixed)}, predicted ${DE().label} ${res.predictedDeltaE.toFixed(2)}, is only a rough estimate${res.clamped ? ' and reaches the limit of what can be asked for, so the color may be at the edge of what this printer can make' : ''}. Until a sheet confirms it, these are the values of ${where(u.round, u.n)}, which printed ${DE().label} ${u.dE.toFixed(2)}. The next sheet is centred on the guess and tests it.</p>`;
  } else if (res.source === 'best-patch') {
    note = `<p class="text-xs text-amber-600">No values are predicted to print closer than the patches you measured, so these are the values of patch #${res.pickN ?? res.best.n}.${pickNote(res)} A next sheet with finer steps around it may still gain a little – or accept these.</p>`;
  } else if (res.source === 'best-earlier') {
    note = `<p class="text-xs text-amber-600">Nothing on this sheet beats patch #${res.pickN} of sheet ${res.pickRound}, so these are its values; the next sheet looks for something better close to it.${pickNote(res)}</p>`;
  } else if (res.trustLimited) {
    note = '<p class="text-xs text-amber-600">This round moves as far as the sheet’s measurements can be trusted; the next sheet continues in that direction.</p>';
  } else if (res.clamped) {
    note = '<p class="text-xs text-amber-600">Some values reached their limit – the reference may be outside the colors this printer and media can produce. These are the closest reachable values.</p>';
  }
  return `<section data-res="${c.id}" class="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <span class="h-5 w-5 rounded ring-1 ring-black/10" style="background:${displayHex(c.target)}"></span>
      <h4 class="font-semibold">${escapeHtml(colorLabel(c))}</h4><span class="text-xs text-slate-500">round ${r.round}</span>
      ${c.accepted ? '<span class="chip bg-emerald-600 text-white">ACCEPTED</span>' : ''}
    </div>
    <p class="text-sm text-slate-500">${{
    spot: `Enter these L*a*b* values for the named color${c.name ? ` <b>${escapeHtml(c.name)}</b>` : ''} in the RIP’s spot color library:`,
    lab: 'Use these L*a*b* values for the color in your document:',
    cmyk: 'Use these CMYK values for the color in your document:',
    rgb: 'Use this sRGB color in your artwork:',
  }[r.mode]}</p>
    ${valueTilesHtml(r.mode, u.x, u.k, { large: true })}
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="rounded-md px-2 py-0.5 text-xs font-bold text-white ${u.why === 'confirmed' ? 'bg-emerald-600' : within ? 'bg-emerald-600' : 'bg-amber-500'}">${u.why === 'confirmed' ? 'DONE' : within ? 'EXPECTED MATCH' : 'NEEDS ANOTHER ROUND'}</span>
      <span>${u.measured ? 'printed' : 'predicted'} ${DE().label} <b class="tabular-nums">${u.dE.toFixed(2)}</b> (tolerance ${match.tol})</span>
    </div>
    ${note}
    ${gamut === 'outside' || gamut === 'edge' ? `<p class="text-xs">${gamutHtml(c)}</p>` : ''}
    <dl class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
      <div><dt class="text-slate-500">Centre patch</dt><dd class="font-mono">${DE().label} ${res.centreDE != null ? res.centreDE.toFixed(2) : '–'}</dd></div>
      <div><dt class="text-slate-500">${bestElsewhere ? 'Best so far' : 'Best patch'}</dt><dd class="font-mono">${bestElsewhere ? `sheet ${res.bestEver.round} #${res.bestEver.n} · ${DE().label} ${res.bestEver.dE.toFixed(2)}` : `#${res.best.n} · ${DE().label} ${res.best.dE.toFixed(2)}`}</dd></div>
      <div><dt class="text-slate-500">Model fit (rms)</dt><dd class="font-mono">${res.rms.toFixed(2)} ΔE</dd></div>
      <div><dt class="text-slate-500">Repeatability</dt><dd class="font-mono">${res.repeatability != null ? DE().label + ' ' + res.repeatability.toFixed(2) : '–'}</dd></div>
    </dl>
    ${metamerismHtml(c, r)}
    <div class="flex flex-wrap gap-2">
      <button type="button" data-res-act="accept" class="btn ${c.accepted ? 'btn-primary' : 'btn-ghost'}" title="Accepted colors are left off the next sheets">${c.accepted ? 'Accepted ✓' : 'Accept – no more rounds'}</button>
      <button type="button" data-res-act="copy" class="btn btn-ghost">Copy values</button>
    </div>
    <details class="text-xs"><summary class="cursor-pointer text-slate-500">Rounds</summary>
      <table class="w-full mt-2"><thead class="text-slate-500"><tr><th class="text-left">Round</th><th class="text-left">Sheet centre</th><th class="text-left">Centre ${DE().label}</th><th class="text-left">Predicted ${DE().label}</th></tr></thead><tbody>
      ${c.rounds.map((rr) => `<tr class="border-t border-slate-200 dark:border-slate-800"><td class="py-1">${rr.round}</td><td class="font-mono">${formatValues(rr.mode, rr.centre, rr.kFixed).map(([k, v]) => `${k}${v}`).join(' ')}</td><td class="font-mono">${rr.result?.centreDE != null ? rr.result.centreDE.toFixed(2) : '–'}</td><td class="font-mono">${rr.result ? rr.result.predictedDeltaE.toFixed(2) : '–'}</td></tr>`).join('')}
      </tbody></table></details>
  </section>`;
}

/** Copy values – `v`: { x, k, mode, dE, measured } (a color's values to use now, or the color space's prediction) – as text. */
function copyMatchValues(c, v) {
  if (!v) return;
  const text = `${colorLabel(c)} – ${{ spot: 'L*a*b*', lab: 'L*a*b*', cmyk: 'CMYK', rgb: 'sRGB' }[v.mode]}: ` + formatValues(v.mode, v.x, v.k).map(([key, val]) => `${key} ${val}`).join(', ') +
    ` (${v.measured ? 'printed' : 'predicted'} ${DE().label} ${v.dE.toFixed(2)} to reference L*a*b* ${c.target.map((n) => n.toFixed(2)).join(' / ')})`;
  navigator.clipboard?.writeText(text).then(() => toast('Values copied', 'ok'), () => toast('Clipboard not available', 'error'));
}

/** The selected color's result (other colors keep theirs – select them in the list). */
function renderMatchResult() {
  const c = activeColor();
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
 * Set a color's reference (spectrum: its measured reflectance, for the metamerism check – none when typed in);
 * with measurements already made for it, asks first and starts that color over.
 */
function setColorTarget(c, lab, spectrum = null) {
  if (c.rounds.some((r) => scannedCount(r)) && !confirm(`Changing the reference of ${colorLabel(c)} starts its matching over. Continue?`)) { renderMatch(); return false; }
  c.target = lab.map(round2);
  c.targetSpectrum = spectrum ? roundSpectrum(spectrum) : null;
  debugLog('match', `reference of ${colorLabel(c)} set`, { lab: c.target, measured: !!spectrum });
  c.rounds = []; c.accepted = false; c.refReads = []; c.refSpectra = [];
  commit();
  return true;
}

/** Measure the selected color's reference (one reading of it, with several readings per reference). */
function measureMatchTarget() {
  const c = activeColor();
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
    if (setColorTarget(c, lab, spectrum)) toast(`Reference color measured${match.reads > 1 ? ` – mean of ${match.reads} readings, spread ΔE00 ${spread.toFixed(2)}` : ''}`, 'ok');
    else saveMatch();
  });
}

/**
 * Measure the current sheet's next patch (one reading of it, with several readings per patch). A finished patch goes
 * into the color space; a finished sheet is analysed – or, for the chart, reported.
 */
function measurePatch() {
  const cur = currentSheet();
  if (!cur) return;
  const { c, r } = cur; // kept: switching colors while measuring still records into this patch
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
    match.scanLog = [...(match.scanLog ?? []), { chart, id: c.id, round: r.round, index: k }].slice(-SCAN_LOG_MAX);
    if (p.reads.length < match.reads) {
      commit({ withSpaces: chart });
      toast(`Reading ${p.reads.length}/${match.reads} – move the SD-10 to another spot on patch #${p.n}.`);
      return;
    }
    Object.assign(p, averageReadings(p.reads));
    debugLog('measure', `${colorLabel(c)}${chart ? '' : ` sheet ${r.round}`} patch #${p.n}`, { x: p.x, k: p.k, lab: p.lab, readings: p.reads.length, spread: p.spread });
    p.spectrum = roundSpectrum(meanSpectrum(p.spectra));
    delete p.spectra; // the mean is enough – keeps the saved job small
    if (chart) delete p.spectrum; // a chart only feeds the color space, which keeps L*a*b*
    learnPatch(c, r, p);
    // next: the first unmeasured patch after this one, else any unmeasured patch
    const after = r.patches.findIndex((q, j) => j > k && !q.lab);
    const any = r.patches.findIndex((q) => !q.lab);
    c.next = after >= 0 ? after : any >= 0 ? any : k;
    const complete = r.patches.every((q) => q.lab);
    if (complete && chart) onChartComplete(c);
    else if (complete) analyseColor(c, r);
    commit({ withSpaces: chart });
    if (complete && !chart) $('mResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// ---- undo the last scan
/** How many readings "Undo last scan" can go back. */
const SCAN_LOG_MAX = 30;

/** The color (or chart), round and patch of the newest logged reading – null when there is none or its sheet changed since. */
function lastScan() {
  const entry = match.scanLog?.[match.scanLog.length - 1];
  if (!entry) return null;
  const s = activeSpace();
  const c = entry.chart ? (s?.chart?.id === entry.id ? s.chart : null) : match.colors.find((x) => x.id === entry.id);
  const r = c && latest(c), p = r?.patches[entry.index];
  return r?.round === entry.round && (p?.lab || p?.reads?.length) ? { c, r, p, index: entry.index } : null;
}

/**
 * "Undo last scan": a patch with all its readings loses its measurement – on the sheet and in the color space it went
 * into – and becomes the next to scan; a patch still collecting readings loses its last reading. The sheet's result,
 * if it had one, goes too (it rested on that patch).
 */
function undoLastScan() {
  const t = lastScan();
  match.scanLog = (match.scanLog ?? []).slice(0, -1);
  if (!t) { commit(); toast('That scan can no longer be undone – its sheet has changed since.', 'error'); return; }
  const { c, r, p, index } = t;
  let msg;
  if (p.lab) {
    for (const s of spaces) forgetPatch(s, spaceSessionId(c, r), p.n);
    Object.assign(p, { lab: null, reads: [], spectra: [], spread: null, spectrum: null });
    msg = `Scan of patch #${p.n} undone – measure it again.`;
  } else {
    p.reads = p.reads.slice(0, -1);
    p.spectra = (p.spectra ?? []).slice(0, -1);
    msg = `Reading ${p.reads.length + 1} of patch #${p.n} undone.`;
  }
  r.result = null;
  c.next = index;
  debugLog('match', `scan undone: ${colorLabel(c)} patch #${p.n}`, { round: r.round, readingsLeft: p.reads.length });
  commit({ withSpaces: true });
  toast(msg, 'ok');
}

/** A color's result from its measured patches (and its earlier rounds); false (and says why) when it cannot be fitted. */
function analyseColor(c, r = latest(c)) {
  try {
    // the color's earlier rounds count too: the best patch so far is the bar to beat, and a failed move is undone
    const a = analyseRound(matchPart(r), c.target, match.formula, c.rounds.filter((x) => x !== r).map(matchPart));
    r.result = { x: a.x, predicted: a.predicted, predictedDeltaE: a.predictedDeltaE, clamped: a.clamped, correction: a.correction, extrapolated: a.extrapolated,
      source: a.source, trustLimited: a.trustLimited, gamutLimited: a.gamutLimited, regressed: a.regressed, pickRound: a.pickRound, pickN: a.pickN,
      best: { n: a.best.n, dE: a.best.dE }, bestEver: { round: a.bestEver.round, n: a.bestEver.n, dE: a.bestEver.dE },
      centreDE: a.centreDE, repeatability: a.repeatability, rms: a.model.rms };
    const { x, predictedDeltaE, source, centreDE, bestEver, regressed, gamutLimited, trustLimited, extrapolated, rms } = r.result;
    debugLog('result', `${colorLabel(c)} sheet ${r.round}`, { target: c.target, x, predictedDeltaE, source, centreDE, best: bestEver, regressed, gamutLimited, trustLimited, extrapolated, rms, formula: match.formula });
    return true;
  } catch (e) {
    debugLog('error', `analysis of ${colorLabel(c)} failed`, { stack: e.stack });
    toast(`${colorLabel(c)}: ${e.message}`, 'error');
    return false;
  }
}

/** "Calculate now": the selected color's result from the patches measured so far (at least 5). */
function analyseMatch() {
  const cur = currentSheet();
  const ok = cur && scannedCount(matchPart(cur.r)) >= 5 && analyseColor(cur.c, cur.r);
  commit();
  if (ok) $('mResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- sheets
/**
 * First sheet centre for a color: the color space's prediction when there is one – with finer steps where the space
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

/**
 * The fill-in setting in force for a new test sheet: 0 (none – also without a color space to fill or with learning
 * off), 4, 8, or 'auto' (as many as fit in the empty slots of the pages the sheet already needs – see emptySlots).
 */
const fillInSetting = () => (match.learn && usableSpace()?.points.length >= SPACE_MIN_POINTS ? match.fillIn : 0);
/** Most fill-in patches 'auto' adds (each one is also a patch to scan). */
const MAX_AUTO_FILL = 100;

/**
 * How many more patches fit on the pages a color's sheet of `n` patches already takes – its empty slots on the media
 * in use – so fill-in patches cost no extra media.
 */
function emptySlots(c, n) {
  const opts = (count) => ({ mode: match.mode, round: 1, media: mediaMm(), patchMm: match.patchMm, groups: [{ label: colorLabel(c), target: c.target, kFixed: 0,
    patches: Array.from({ length: count }, (_, i) => ({ n: i + 1, offset: [1, 0, 0], x: [0, 0, 0], name: 'SD10-XXXX-R1-01' })) }] });
  const pagesFor = (count) => { try { return sheetLayout(opts(count)).pages.length; } catch { return Infinity; } };
  const pages = pagesFor(n);
  if (!Number.isFinite(pages)) return 0;
  let extra = 0;
  while (extra < MAX_AUTO_FILL && pagesFor(n + extra + 1) === pages) extra++;
  return extra;
}
/**
 * A color's next sheet (round) around `centre`, plus its fill-in patches (half around the centre, half wherever the
 * color space is emptiest); its patches are named SD10-<color code>-R<round>-<n> in spot mode.
 */
function createRound(c, { centre, step, kFixed, fromSpace = null }) {
  const round = (latest(c)?.round ?? 0) + 1;
  const design = designPatches(match.mode, centre, step, match.design);
  const setting = fillInSetting();
  const fillCount = setting === 'auto' ? emptySlots(c, design.length) : setting;
  const fillers = fillCount ? gapFillers(usableSpace(), fillCount, { near: pointX(match.mode, centre, kFixed), seed: crypto.getRandomValues(new Uint32Array(1))[0] }) : [];
  const patches = [...design, ...fillers.map((f, i) => ({ n: design.length + i + 1, ...f, fill: true }))]
    .map((p) => (match.mode === 'spot' ? { ...p, name: patchSpotName(c.code, round, p.n) } : p));
  c.rounds.push({ round, mode: match.mode, centre, step, kFixed, design: match.design, patches, result: null, ...(fromSpace ? { fromSpace } : {}) });
  debugLog('match', `sheet ${round} created for ${colorLabel(c)}`, { mode: match.mode, centre, step, kFixed, design: match.design, fromSpace, fillIn: fillers.length });
  c.next = 0;
  commit();
}

/** First sheet for the selected color (starting it over if it already has sheets). */
async function startFirstSheet() {
  const c = activeColor();
  if (!c.target) return;
  if (c.rounds.length && !confirm(`Start ${colorLabel(c)} again with a new first sheet? Its sheets and measurements are discarded.`)) return;
  try {
    const start = await initialCentre(c);
    c.rounds = []; c.accepted = false;
    c.code = newCode(); // fresh spot names, so libraries imported for an earlier attempt cannot clash
    createRound(c, start);
    toast(`Sheet created for ${colorLabel(c)} – download and print it.`, 'ok');
  } catch (e) {
    toast(`Could not create the sheet: ${e.message}`, 'error');
  }
}

/** Next sheet for the selected color, centred on its result with finer steps. */
function makeNextSheet() {
  const c = activeColor(), r = latest(c);
  if (c.accepted) { toast(`${colorLabel(c)} is accepted – press Accepted to undo that before making another sheet.`, 'error'); return; }
  if (!r?.result) { toast(`Scan the sheet of ${colorLabel(c)} first.`, 'error'); return; }
  createRound(c, { centre: r.result.x, step: nextStep(r.mode, r.step, r.result.correction), kFixed: r.kFixed });
  toast(`Sheet ${r.round + 1} for ${colorLabel(c)} created – download and print it.`, 'ok');
  $('mSheetInfo').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** "Start over" – or, for the chart, "Close chart". */
function restartSheet() {
  if (activeChart()) { closeChart(); return; }
  const c = activeColor();
  if (!confirm(`Discard the sheets and measurements of ${colorLabel(c)}? (Its reference is kept.)`)) return;
  c.rounds = []; c.accepted = false; c.next = 0;
  commit();
}

/** Every color starts over (a new sheet type). */
function resetMatching() {
  for (const c of match.colors) { c.rounds = []; c.accepted = false; c.next = 0; }
}

/** The current sheet as a PDF (or PNG pages for raster workflows), named after the color and sheet (or the chart). */
async function downloadSheet() {
  const cur = currentSheet();
  if (!cur) return;
  const { c, r } = cur;
  const opts = { mode: r.mode, groups: [sheetGroup(c, r)], round: r.round, media: mediaMm(), patchMm: match.patchMm, title: sheetTitle(c) };
  const base = safeFileName(isChart(c) ? colorLabel(c) : `${colorLabel(c)} - sheet ${r.round}`);
  try {
    if (r.mode === 'rgb') {
      const pages = await buildSheetPng(opts);
      pages.forEach(({ png }, i) => downloadFile(png, 'image/png', `${base}${pages.length > 1 ? ` - page ${i + 1}` : ''}.png`));
      if (pages[0].dpi < 300) toast(`Large media: the PNG is ${pages[0].dpi} dpi (still printed at actual size).`);
    } else downloadFile(buildSheetPdf(opts), 'application/pdf', `${base}.pdf`);
  } catch (e) { toast(e.message, 'error'); }
}

/** "Sheet library": the current sheet's named patches as a spot color library, to import into the RIP before printing. */
function downloadSheetLibrary() {
  const ex = RIP_EXPORTS[match.ripFormat], cur = currentSheet();
  if (!ex || !cur) return;
  const { c, r } = cur;
  const colors = r.patches.filter((p) => p.name).map((p) => ({ name: p.name, lab: p.x }));
  if (!colors.length) return;
  const chart = isChart(c);
  const text = ex.build({
    library: chart ? `SD10 ${c.code} chart` : `SD10 ${c.code} sheet ${r.round}`,
    description: chart ? `Color space chart patches (${c.name}), CIE L*a*b* D50/2°` : `Print match test sheet patches for ${colorLabel(c)}, CIE L*a*b* D50/2°`,
    colors,
  });
  downloadFile(text, ex.mime, chart ? `sd10-${c.code}-chart.${ex.ext}` : `sd10-${c.code}-sheet${r.round}.${ex.ext}`);
}

// ---------------------------------------------------------------- colors in and out
// Colors come in from swatch and library files; they go out as a spot color library for the RIP, each under its
// name with its recommended L*a*b*.
const libraryName = () => (match.libraryName ?? '').trim() || DEFAULT_LIBRARY_NAME;

/**
 * A color's recommended L*a*b* for the RIP: the values to use now from its latest test-sheet result (useNow – values
 * a sheet backs up), else what the color space predicts (a measured patch when one printed closer). Returns
 * { lab, dE, source: 'confirmed' | 'result' | 'sheet-patch' | 'prediction' | 'measured' }, null when there is neither,
 * or – `later` – undefined while the prediction is still to be worked out (it is, in the background).
 */
function outputOf(c, { later = false } = {}) {
  const r = [...c.rounds].reverse().find((x) => x.result && isLabMode(x.mode));
  if (r) {
    const u = useNow(c, r);
    return { lab: u.x, dE: u.dE, source: { confirmed: 'confirmed', measured: 'sheet-patch', result: 'result' }[u.why] };
  }
  if (!isLabMode(match.mode) || !c.target) return null;
  const p = spacePrediction(c, { later });
  if (p === undefined) return undefined;
  return p ? { lab: p.x, dE: p.predictedDeltaE, source: p.measured ? 'measured' : 'prediction' } : null;
}

/** What the library file holds: every color with a reference, under its name, with its recommended L*a*b* – or its reference where there is none yet. */
function libraryColors() {
  return match.colors.filter((c) => c.target).map((c) => {
    const o = outputOf(c);
    return { name: colorLabel(c), lab: o ? o.lab : c.target, fromReference: !o };
  });
}

/** "Download library": every color (see libraryColors) as a library file in the chosen format, named after the library. */
function downloadColorLibrary() {
  const ex = RIP_EXPORTS[match.ripFormat];
  const colors = libraryColors();
  if (!ex || !colors.length) return;
  const library = libraryName(), asReference = colors.filter((c) => c.fromReference).length;
  const description = `${colors.length} color(s) from SD-10 Print match – recommended values${asReference ? `, ${asReference} still their reference` : ''}; CIE L*a*b* D50/2°`;
  downloadFile(ex.build({ library, description, colors: colors.map(({ name, lab }) => ({ name, lab: lab.map(round2) })) }), ex.mime, `${safeFileName(library)}.${ex.ext}`);
  debugLog('match', `library downloaded (${ex.label})`, { colors: colors.length, asReference });
}

/** The Colors card's export row: the format, the download button and what the file will hold. */
function renderLibraryExport() {
  const ex = RIP_EXPORTS[match.ripFormat] ?? RIP_EXPORTS.cxf;
  const lab = isLabMode(match.mode), withRef = match.colors.filter((c) => c.target);
  $('mRipFormat').value = match.ripFormat;
  $('mRipFormat').disabled = !lab;
  const btn = $('btnLibDownload');
  btn.disabled = !lab || !withRef.length;
  btn.title = lab ? `Every color under its name with its recommended L*a*b* (its reference until it has one), as a ${ex.label} file for the RIP – the library's name is under Measuring & matching` : 'Spot color libraries hold L*a*b* values – for spot color or L*a*b* sheets';
  if (document.activeElement !== $('mLibName')) $('mLibName').value = libraryName();
  if (!lab || !withRef.length) { $('mLibNote').textContent = ''; return; }
  const outs = withRef.map((c) => outputOf(c, { later: true }));
  const pending = outs.filter((o) => o === undefined).length, asRef = outs.filter((o) => o === null).length;
  const parts = [];
  if (asRef) parts.push(`${asRef} of ${withRef.length} without a recommendation yet go in with their reference`);
  if (pending) parts.push('working out predictions…');
  // formats with reduced L*a*b* precision round the values: say what that costs when it matters
  let worst = 0;
  if (ex.quantize) {
    worst = Math.max(0, ...withRef.map((c, i) => { const v = outs[i]?.lab ?? c.target; return deltaE2000(v, ex.quantize(v)); }));
    if (worst >= 0.1) parts.push(`${ex.label} stores ${ex.precision} – rounding costs up to ΔE00 ${worst.toFixed(2)}; for full precision use CxF3`);
  }
  $('mLibNote').textContent = parts.join(' · ');
  $('mLibNote').className = `text-xs ${worst > match.tol / 2 ? 'text-amber-600' : 'text-slate-500'}`;
}

/**
 * Add the named colors of a swatch or library file (Adobe Swatch Exchange, CxF, …) as colors to match, each with the
 * file's L*a*b* as its reference – names exactly as in the artwork. Names already in the list are left as they are; an
 * untouched empty first color is used for the first one.
 */
async function importColorsFile(file) {
  if (file.size > 20 * 1024 * 1024) { toast('That file is too large for a swatch or library file.', 'error'); return; }
  let lib;
  try { lib = readLibrary(new Uint8Array(await file.arrayBuffer()), file.name); } catch (e) { toast(e.message, 'error'); return; }
  const names = new Set(match.colors.map((c) => c.name.trim()).filter(Boolean));
  const fresh = lib.colors.filter((c) => !names.has(c.name.trim()));
  if (!fresh.length) {
    toast(lib.colors.length ? `All ${lib.colors.length} colors in ${file.name} are already in the list.` : `No L*a*b* colors in ${file.name}${lib.skipped.length ? ` (${lib.skipped.length} without L*a*b*, e.g. CMYK or RGB)` : ''}.`, 'error');
    return;
  }
  const first = match.colors.length === 1 && !match.colors[0].name && !match.colors[0].target ? match.colors.pop() : null;
  for (const [i, c] of fresh.entries()) match.colors.push({ ...(i === 0 && first ? first : newColor()), name: c.name.trim().slice(0, 60), target: c.lab.map(round2) });
  match.active = match.colors.length - fresh.length;
  match.chartActive = false;
  debugLog('match', `${fresh.length} colors imported from ${file.name}`, { format: lib.format, names: fresh.map((c) => c.name) });
  commit();
  const left = lib.colors.length - fresh.length;
  toast(`${fresh.length} color${fresh.length === 1 ? '' : 's'} added from ${file.name}${left ? ` (${left} already in the list)` : ''}${lib.skipped.length ? ` – ${lib.skipped.length} without L*a*b* skipped` : ''}. Measure a sample to replace a swatch value with the real color.`, 'ok');
}

// ---------------------------------------------------------------- color space
const SESSION_KIND = { chart: 'Chart', check: 'Check chart', gaps: 'Fill-gaps chart', sheet: 'Test sheet', import: 'Imported' };
const predictionCache = new Map();

/**
 * What a color's prediction rests on – the color space, the K held fixed (CMYK: the K of the color's sheets) and the
 * cache key – or null when the color space cannot predict for it.
 */
function predictionInputs(c) {
  const s = usableSpace();
  if (!s || !c?.target || s.points.length < SPACE_MIN_POINTS) return null;
  const k = match.mode === 'cmyk' ? latest(c)?.kFixed ?? null : null;
  return { s, k, key: `${s.id}|${s.updated}|${s.points.length}|${c.target.join()}|${match.formula}|${k}` };
}

/**
 * What the color space predicts for a color's reference (cached), or null. CMYK keeps the K of the color's sheets.
 * `later`: return undefined instead of working it out now – the list's predictions are made in the background.
 */
function spacePrediction(c, { later = false } = {}) {
  const inputs = predictionInputs(c);
  if (!inputs) return null;
  const { s, k, key } = inputs;
  if (!predictionCache.has(key)) {
    if (later) { queuePredictions(); return undefined; }
    if (predictionCache.size > 100) predictionCache.clear();
    let p = null;
    try { p = invert(s, c.target, { formula: match.formula, kFixed: k }); } catch { /* no prediction */ }
    predictionCache.set(key, p);
  }
  return predictionCache.get(key);
}

/** Work out the missing predictions of the color list one per tick, redrawing the list (and the export row) after each. */
let predictionTimer = 0;
function queuePredictions() {
  if (predictionTimer) return;
  predictionTimer = setTimeout(() => {
    predictionTimer = 0;
    // (a prediction may have been made meanwhile – e.g. for the reference card – so the list is redrawn either way)
    const c = match.colors.find((x) => { const inputs = predictionInputs(x); return inputs && !predictionCache.has(inputs.key); });
    if (c) spacePrediction(c);
    if (state.view === 'match') { $('mColorList').innerHTML = colorListHtml(); renderLibraryExport(); }
    if (c) queuePredictions();
  }, 30);
}

/** What to do with the values of a prediction or result, by sheet type. */
const ASK_FOR = { spot: 'Ask the RIP for', lab: 'Use in your document', cmyk: 'Use in your document', rgb: 'Use in your artwork' };

/**
 * Reference card: the values the color space recommends asking for, and – separately, since they differ beyond the
 * printer's reach – the color those values print and how close that is to the reference.
 */
function spacePredictionHtml(c) {
  const p = spacePrediction(c);
  if (!p) return '';
  const s = usableSpace(), st = spaceStats(s);
  const rough = st.spacing != null && p.d1 > 2 * st.spacing; // no measured patches nearby
  const reached = p.predictedDeltaE <= 2;
  return `<div class="flex flex-wrap items-baseline justify-between gap-2"><h4 class="text-sm font-semibold">Predicted by the color space</h4><span class="text-xs text-slate-500">${escapeHtml(s.name)}</span></div>
    <div class="space-y-1"><div class="text-xs font-medium text-slate-500">${ASK_FOR[match.mode]}</div>${valueTilesHtml(match.mode, p.x, p.k)}</div>
    <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"><span class="font-medium text-slate-500">It prints</span>
      <span class="inline-block h-4 w-4 rounded ring-1 ring-black/10" style="background:${displayHex(p.predicted)}"></span>
      <span class="font-mono">${labText(p.predicted)}</span>
      <span class="${reached ? 'text-emerald-600' : 'text-rose-600'}">– ${DE().label} ${p.predictedDeltaE.toFixed(2)} from the reference${p.measured ? ' (measured)' : ''}</span></p>
    <p class="text-xs">${reached ? '' : `<span class="text-rose-600"><b>Beyond what this printer reached in the color space</b> – no values print closer.${isLabMode(match.mode) ? ' Past the printer’s limit, more extreme values print alike, so these are the ones nearest the reference.' : ''}</span>`}
      ${p.measured ? '<span class="text-slate-500">These are the values of a patch already measured – no prediction prints closer.</span>' : ''}
      <span class="text-slate-500">The color space is typically accurate to ΔE00 ${st.accuracy ? st.accuracy.median.toFixed(2) : '–'}${rough ? ', but it has few measured patches near this color, so treat this as a first estimate' : ''}. The first test sheet starts from these values${rough ? '' : ' with finer steps'} and confirms them.</span></p>
    <div class="flex flex-wrap gap-2"><button type="button" data-pred-act="copy" class="btn btn-ghost">Copy values</button></div>`;
}

/** The Color space card: the space in use, what it holds and how well it predicts, drift warnings, its data. */
function renderSpaceCard() {
  const s = activeSpace();
  $('mSpace').innerHTML = '<option value="">None</option>' + spaces.map((q) => `<option value="${escapeHtml(q.id)}">${escapeHtml(q.name)}${q.mode !== match.mode ? ` (${MODE_NAME[q.mode]} sheets)` : ''}</option>`).join('');
  $('mSpace').value = s?.id ?? '';
  $('mSpaceLearn').checked = match.learn;
  $('mFillIn').value = String(match.fillIn);
  $('mFillIn').disabled = !match.learn;
  $('mSpaceActions').classList.toggle('hidden', !s);
  $('btnSpaceCgats').disabled = !s?.points.length;
  $('btnSpaceChart').textContent = s?.chart ? 'New chart' : 'Create chart';
  // a chart is the card's main action until the color space can predict
  const needsChart = !s || s.points.length < SPACE_MIN_POINTS;
  $('btnSpaceChart').classList.toggle('btn-primary', needsChart);
  $('btnSpaceChart').classList.toggle('btn-ghost', !needsChart);
  $('mSpaceData').classList.toggle('hidden', !s);
  $('mSpaceData').classList.toggle('flex', !!s);
  // without Data & files beside it, the space and its intro take the card's whole width
  $('mSpaceMain').classList.toggle('xl:col-span-2', !s);
  const bar = $('mSpaceChartBar');
  if (bar.parentElement !== (s ? $('mSpaceMain') : $('mSpaceCard'))) (s ? $('mSpaceMain') : $('mSpaceCard')).append(bar);
  bar.classList.toggle('mt-auto', !!s);
  bar.classList.toggle('xl:grid-cols-2', !s);
  $('mSpaceInfo').classList.toggle('flex-1', !s);
  $('mSpaceInfo').classList.toggle('content-center', !s);
  $('mSpaceInfo').classList.toggle('grid', !s);
  if (!s) {
    // an empty state in the middle of the card: what a color space is, and the one step to start
    $('mSpaceInfo').innerHTML = `<div class="mx-auto max-w-md space-y-3 py-6 text-center">
        <svg class="mx-auto h-10 w-10 text-slate-300 dark:text-slate-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10.4 1.6a.75.75 0 0 0-.8 0l-6.75 4A.75.75 0 0 0 2.5 6.25v7.5c0 .27.14.51.37.65l6.75 4a.75.75 0 0 0 .76 0l6.75-4a.75.75 0 0 0 .37-.65v-7.5a.75.75 0 0 0-.37-.65l-6.75-4ZM10 3.12l5.27 3.13L10 9.38 4.73 6.25 10 3.12ZM4 7.57l5.25 3.11v5.83L4 13.4V7.57Zm6.75 8.94v-5.83L16 7.57v5.83l-5.25 3.11Z"/></svg>
        <p class="text-sm font-medium text-slate-700 dark:text-slate-200">No color space yet</p>
        <p>A color space is a measured map of what your printer really prints. Measure a chart once, and every color starts from a prediction instead of a guess.</p>
        <button type="button" data-space-start class="btn btn-primary">+ New color space</button>
      </div>`;
    return;
  }
  const st = spaceStats(s);
  const parts = [];
  if (s.mode !== match.mode) parts.push(`<p class="text-amber-600">This color space was measured with ${MODE_NAME[s.mode]} sheets – switch the sheet type to use it.</p>`);
  parts.push(st.points < SPACE_MIN_POINTS
    ? `<p>${st.points ? `${st.points} measured patch${st.points === 1 ? '' : 'es'} so far` : 'No measurements yet'} – scan a chart; the color space predicts once it holds ${SPACE_MIN_POINTS} patches.</p>`
    : `<p>${st.points} measured patches${st.accuracy ? ` · predicts within ΔE00 ${st.accuracy.median.toFixed(2)} typically (90 % within ${st.accuracy.p90.toFixed(2)})` : ''}</p>`);
  if (s.chart && !activeChart()) {
    const r = s.chart.rounds[0];
    parts.push(`<p>${escapeHtml(s.chart.name)}: ${scannedCount(r)} of ${r.patches.length} patches scanned – <button type="button" data-space-act="chart" class="font-medium text-indigo-600 hover:underline dark:text-indigo-400">continue scanning</button></p>`);
  }
  // the most recent set of patches that could be compared with the space: did the printer print as predicted?
  const last = [...s.sessions].sort((a, b) => (b.updated ?? b.time) - (a.updated ?? a.time)).map((q) => ({ q, d: driftOf(s, q.id) })).find((x) => x.d);
  if (last?.d.drift && last.q.kind === 'check') {
    // a check chart is a deliberate test across the gamut: only it offers to drop the older measurements
    parts.push(`<div class="rounded-lg bg-rose-50 p-2 text-rose-700 dark:bg-rose-950 dark:text-rose-200"><b>${escapeHtml(last.q.label)} printed differently from what this color space predicts</b>
      – typically ΔE00 ${last.d.median.toFixed(2)} off, where the space is usually within ${st.accuracy ? st.accuracy.median.toFixed(2) : '–'}. The printer, ink, media or settings have probably changed: check them. If the change is meant to stay, keep only the measurements from this check chart on.
      <div class="mt-1"><button type="button" data-space-act="trim" data-time="${last.q.time}" class="font-medium underline">Keep only data from this check chart on</button></div></div>`);
  } else if (last?.d.drift) {
    // one test sheet can also miss because it lies where the color space knows little – a check chart tells them apart
    parts.push(`<div class="rounded-lg bg-amber-50 p-2 text-amber-800 dark:bg-amber-950 dark:text-amber-200"><b>${escapeHtml(last.q.label)} printed differently from what this color space predicts</b>
      – typically ΔE00 ${last.d.median.toFixed(2)} off, where the space is usually within ${st.accuracy ? st.accuracy.median.toFixed(2) : '–'}. The printer, ink, media or settings may have changed. Print a <b>check chart</b> to find out: it compares the printer with the color space across its whole range.</div>`);
  } else if (last?.q.kind === 'check') {
    parts.push(`<p class="text-emerald-600">${escapeHtml(last.q.label)} (${fmtDate(last.q.time)}): the printer still prints as predicted (typically ΔE00 ${last.d.median.toFixed(2)} off).</p>`);
  }
  $('mSpaceInfo').innerHTML = parts.join('');
  $('mSpaceDataTitle').textContent = `Data & files${s.sessions.length ? ` · ${s.sessions.length} set${s.sessions.length === 1 ? '' : 's'} of measurements` : ''}`;
  $('mSpaceSessions').innerHTML = !s.sessions.length ? '<li class="text-slate-500">No measurements yet – scan a chart.</li>' : [...s.sessions].sort((a, b) => b.time - a.time).map((q) => {
    const d = driftOf(s, q.id);
    return `<li data-session="${escapeHtml(q.id)}" class="flex items-center gap-2 border-t border-slate-200 pt-1 dark:border-slate-800">
      <span class="min-w-0 flex-1"><span class="block truncate font-medium text-slate-700 dark:text-slate-300">${escapeHtml(q.label)}</span>
        <span class="text-slate-500">${SESSION_KIND[q.kind] ?? ''} · ${fmtDate(q.time)} · ${sessionSize(s, q.id)} patches${d ? ` · <span class="${d.drift ? 'font-medium text-rose-600' : ''}">ΔE00 ${d.median.toFixed(2)} from the prediction</span>` : ''}</span></span>
      <button type="button" data-space-act="remove" class="px-1 text-rose-600 hover:underline" title="Remove these measurements from the color space">remove</button></li>`;
  }).join('');
}

/** Use another color space ('' = none); the cards go back to the colors. */
function selectSpace(id) {
  match.space = id; match.chartActive = false;
  commit({ withSpaces: true });
}

/** A new, empty color space for the current sheet type (asks for its name); it becomes the one in use. */
function createSpace() {
  const name = (prompt(`Name for the new color space (${MODE_NAME[match.mode]} sheets) – e.g. the printer, ink, media and settings it describes:`, `Color space ${spaces.length + 1}`) ?? '').trim().slice(0, 60);
  if (!name) return null;
  const s = newSpace({ name, mode: match.mode });
  spaces.push(s);
  selectSpace(s.id);
  return s;
}

function renameSpace() {
  const s = activeSpace();
  const name = s && (prompt('Name of the color space:', s.name) ?? '').trim().slice(0, 60);
  if (!name) return;
  s.name = name;
  commit({ withSpaces: true });
}

function deleteSpace() {
  const s = activeSpace();
  if (!s || !confirm(`Delete the color space “${s.name}” and its ${s.points.length} measured patches from this browser? Export it first to keep a copy.`)) return;
  spaces.splice(spaces.indexOf(s), 1);
  selectSpace('');
}

/** Import a color space file (.json) or a CGATS / IT8 measurement file as a color space, and use it. */
async function importSpaceFile(file) {
  if (file.size > 50 * 1024 * 1024) { toast('That file is too large for a color space.', 'error'); return; }
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
  toast(`Color space “${s.name}” imported – ${s.points.length} patches${s.mode !== match.mode ? `, measured with ${MODE_NAME[s.mode]} sheets: switch the sheet type to use it` : ''}.`, 'ok');
}

/** A new chart for the color space in use (creating a space first if there is none); the cards switch to it. */
function createChart() {
  let s = activeSpace();
  if (s && s.mode !== match.mode) { toast(`“${s.name}” was measured with ${MODE_NAME[s.mode]} sheets – switch the sheet type, or create a new color space.`, 'error'); return; }
  const key = CHART_SIZES[$('mChartSize').value] ? $('mChartSize').value : 'starter';
  if (key === 'check' && (!s || s.points.length < SPACE_MIN_POINTS)) { toast('A check chart compares the printer with an existing color space – print and scan a full chart first.', 'error'); return; }
  if (key === 'gaps' && (!s || s.points.length < SPACE_MIN_POINTS)) { toast('A fill-gaps chart adds to an existing color space – print and scan a full chart first.', 'error'); return; }
  s ??= createSpace();
  if (!s) return;
  const old = s.chart?.rounds[0];
  if (old && !old.patches.every((p) => p.lab) && !confirm(`Replace ${s.chart.name}?${scannedCount(old) ? ' The patches scanned so far stay in the color space.' : ''}`)) return;
  const kind = key === 'check' || key === 'gaps' ? key : 'chart';
  const no = s.sessions.filter((q) => q.kind === kind).length + 1;
  const code = newCode();
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const designed = kind === 'gaps' ? designGapChart(s, CHART_SIZES[key].n, seed) : designChart(s.mode, CHART_SIZES[key].n, seed);
  const patches = designed.map((p) => (s.mode === 'spot' ? { ...p, name: chartSpotName(code, no, p.n) } : p));
  const title = { chart: 'chart', check: 'check chart', gaps: 'fill-gaps chart' }[kind];
  s.chart = { id: `${kind}:${code}`, code, name: `${s.name} – ${title} ${no}`, target: null, refReads: [], accepted: false, next: 0,
    rounds: [{ round: no, mode: s.mode, kind, kFixed: 0, patches, result: null, chart: true }] };
  match.chartActive = true;
  commit({ withSpaces: true });
  debugLog('space', `${s.chart.name} created`, { kind, patches: patches.length, mode: s.mode, seed });
  toast(`${s.chart.name} created – ${patches.length} patches. Download, print and scan it.`, 'ok');
}

/** Show the color space's chart in the sheet and scan cards (from the color list or the Color space card). */
function selectChart() {
  match.chartActive = true;
  commit();
}

/** Close the chart: back to the colors; what was scanned stays in the color space. */
function closeChart() {
  const s = activeSpace(), r = s?.chart?.rounds[0];
  if (!r) return;
  const done = scannedCount(r);
  if (done < r.patches.length && !confirm(`Close ${s.chart.name}? ${done ? `The ${done} patches scanned so far stay in the color space.` : 'Nothing has been scanned yet.'}`)) return;
  s.chart = null; match.chartActive = false;
  commit({ withSpaces: true });
}

/** The 3-D view's right-click menu: one measured patch (a stray point) out of a color space; the sheet keeps it. */
function removeSpacePoint(spaceId, point) {
  const s = spaces.find((q) => q.id === spaceId);
  if (!s || !forgetPatch(s, point.s, point.n, point)) return;
  saveSpaces();
  showSpaceView();
  debugLog('space', `point removed from “${s.name}”`, { session: point.s, n: point.n, x: point.x, lab: point.lab });
  toast(`Patch${point.n != null ? ` #${point.n}` : ''} removed from the color space “${s.name}”.`, 'ok');
}

/**
 * Add a scanned patch to the color space: a chart's patches always go into its space, a color's test-sheet patches
 * when learning is on and the space was measured with this sheet type. Says so once when a sheet prints differently
 * from what the space predicts.
 */
function learnPatch(c, r, p) {
  const chart = isChart(c);
  const s = chart || match.learn || p.fill ? activeSpace() : null; // fill-in patches exist only for the color space
  if (!s || s.mode !== r.mode) return;
  const session = spaceSessionId(c, r);
  const label = chart ? c.name : `${colorLabel(c)} – sheet ${r.round}`;
  const was = driftOf(s, session)?.drift;
  const check = learn(s, { session, kind: chart ? r.kind : 'sheet', label, n: p.n, x: pointX(r.mode, p.x, p.k ?? r.kFixed), lab: p.lab });
  saveSpaces();
  const d = driftOf(s, session);
  debugLog('space', `“${s.name}” learned ${label} #${p.n}`, { checkDeltaE: check, points: s.points.length, drift: d });
  if (d?.drift && !was) toast(`${label} prints differently from what the color space “${s.name}” predicts (typically ΔE00 ${d.median.toFixed(2)} off) – the printer, ink or media may have changed. See Color space.`, 'error');
}

/** Every patch of the chart is scanned: say so – and, for a check chart, whether the printer still prints as before. */
function onChartComplete(c) {
  const s = activeSpace(), r = c.rounds[0];
  if (r.kind !== 'check') { toast(`${c.name} complete – its ${r.patches.length} patches are in the color space “${s?.name}”.`, 'ok'); return; }
  const d = s && driftOf(s, c.id);
  if (!d) toast('Check chart scanned – too few of its patches lie near measured ones to judge the printer.');
  else if (d.drift) toast(`Check chart: the printer prints differently from the color space (typically ΔE00 ${d.median.toFixed(2)} off) – see Color space.`, 'error');
  else toast(`Check chart: the printer still prints as the color space predicts (typically ΔE00 ${d.median.toFixed(2)} off).`, 'ok');
}

/** Buttons inside the Color space card's text: continue the chart, remove a set of measurements, keep only newer data. */
function onSpaceClick(e) {
  if (e.target.closest('[data-space-start]')) { $('btnSpaceNew').click(); return; }
  const b = e.target.closest('[data-space-act]'), s = activeSpace();
  if (!b || !s) return;
  const act = b.dataset.spaceAct;
  if (act === 'chart') { selectChart(); return; }
  if (act === 'remove') {
    const q = s.sessions.find((x) => x.id === b.closest('[data-session]').dataset.session);
    if (!q || !confirm(`Remove “${q.label}” (${sessionSize(s, q.id)} patches) from the color space?`)) return;
    removeSession(s, q.id);
  } else if (act === 'trim') {
    // say exactly what goes – a chart from earlier the same day included – and what is left
    const time = +b.dataset.time;
    const old = s.sessions.filter((q) => q.time < time);
    if (!old.length) return;
    const removed = old.reduce((n, q) => n + sessionSize(s, q.id), 0), left = s.points.length - removed;
    const charts = old.filter((q) => q.kind === 'chart').length;
    const list = old.map((q) => `• ${q.label} – ${SESSION_KIND[q.kind] ?? 'measurements'}, ${fmtDate(q.time)}, ${sessionSize(s, q.id)} patches`).join('\n');
    if (!confirm(`Keep only the measurements from the check chart on? This removes:\n\n${list}\n\n${charts ? `That includes ${charts > 1 ? `${charts} charts` : 'the chart'}. ` : ''}The color space keeps ${left} patches${left < SPACE_MIN_POINTS ? ' and needs a new chart before it can predict again' : ''}. Export it first if you may want the old data back.`)) return;
    keepFrom(s, time);
  }
  commit({ withSpaces: true });
}

/** The Color space view: measure a color (D50 / 2°, the job's M-factor) and show it in the 3-D picture. */
function measureForSpaceView() {
  return task('Measuring', async () => {
    const m = await measureLabD50();
    if (!m) return;
    showSpaceView();
    toast(`Measured L* ${m.lab[0].toFixed(1)} a* ${m.lab[1].toFixed(1)} b* ${m.lab[2].toFixed(1)} – shown as “Last measurement”.`, 'ok');
  });
}

// ---------------------------------------------------------------- start-up
// Files dropped anywhere on Print match: swatch and spot color library files add colors to match, .icc/.icm files
// become printer profiles, color spaces and CGATS measurement files become color spaces. The browser would otherwise
// open a file dropped outside a drop zone, so every drop is caught.
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
      else await importColorsFile(file); // swatch and library files: colors to match
    }
  });
}

/** Color list and reference card. */
function wireColors() {
  $('btnColorsImport').onclick = () => $('colorsFile').click();
  onFilePicked('colorsFile', importColorsFile);
  $('btnColorAdd').onclick = () => {
    match.colors.push(newColor());
    match.active = match.colors.length - 1;
    commit();
    $('mSpotName').focus();
  };
  $('mColorList').onclick = (e) => {
    const b = e.target.closest('[data-color-act]');
    if (!b) return;
    const item = b.closest('[data-color]').dataset.color;
    if (item === 'chart') { selectChart(); return; }
    const i = +item;
    const c = match.colors[i];
    if (b.dataset.colorAct === 'remove') {
      if (c.rounds.length && !confirm(`Remove ${colorLabel(c)} and its measurements?`)) return;
      match.colors.splice(i, 1);
      if (match.active >= match.colors.length) match.active = match.colors.length - 1;
    } else { match.active = i; match.chartActive = false; }
    commit();
  };
  $('btnMatchTarget').onclick = measureMatchTarget;
  $('btnMatchUseLast').onclick = () => {
    const lab = state.lastLabD50 ?? (state.last && spectrumToLab(state.last.spectrum, 0, 2));
    if (lab) setColorTarget(activeColor(), lab, state.lastSpectrum ?? state.last?.spectrum ?? null);
  };
  for (const id of ['mL', 'mA', 'mB']) {
    $(id).addEventListener('change', () => {
      const v = ['mL', 'mA', 'mB'].map((k) => parseFloat($(k).value));
      if (v.every(Number.isFinite)) setColorTarget(activeColor(), [Math.min(Math.max(v[0], 0), 100), Math.min(Math.max(v[1], -128), 127), Math.min(Math.max(v[2], -128), 127)]);
    });
  }
  $('mSpotName').onchange = () => { activeColor().name = $('mSpotName').value.trim(); commit(); };
  $('mSpacePred').onclick = (e) => {
    const b = e.target.closest('[data-pred-act]');
    const c = activeColor(), p = b && spacePrediction(c);
    if (!p) return;
    if (b.dataset.predAct === 'copy') copyMatchValues(c, { x: p.x, k: p.k, mode: match.mode, dE: p.predictedDeltaE, measured: p.measured });
  };
}

/** Settings card, the Measuring & matching dialog and the tips. */
function wireSettings() {
  $('mMode').onchange = () => {
    if (match.colors.some((c) => c.rounds.length) && !confirm('Changing the sheet type starts every color over. Continue?')) { $('mMode').value = match.mode; return; }
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
  $('mReads').onchange = () => { match.reads = Math.min(Math.max(+$('mReads').value || 1, 1), 9); for (const c of match.colors) c.refReads = []; commit(); };
  $('matchMf').onchange = () => { match.mf = +$('matchMf').value; commit(); };
  $('matchFormula').onchange = () => {
    match.formula = $('matchFormula').value;
    // re-judge every result with the new formula (the measurements stay)
    for (const c of match.colors) { const r = latest(c); if (r?.result) analyseColor(c, r); }
    commit();
  };
  $('mTol').onchange = () => { match.tol = Math.min(Math.max(+$('mTol').value || 1, 0.1), 20); commit(); };
  $('mPrinterProfile').onchange = () => { match.printerProfile = $('mPrinterProfile').value; commit(); };
  $('btnPrinterIcc').onclick = () => $('printerIccFile').click();
  onFilePicked('printerIccFile', addPrinterProfile);
  $('btnPrinterIccRemove').onclick = removePrinterProfile;
  refreshPrinterProfiles().then(() => { if (state.view === 'match') renderMatch(); });
  // Tips remember whether they were open (closed at first)
  $('mTipsBox').open = readFlag('sd10.tipsOpen');
  $('mTipsBox').ontoggle = () => writeFlag('sd10.tipsOpen', $('mTipsBox').open);
  $('btnMoreSettings').onclick = () => $('mMoreDialog').showModal();
  // dialogs close with their ✕ / Done ([data-close-dialog]), Esc, or a click on the backdrop
  for (const dialog of $('viewMatch').querySelectorAll('dialog')) {
    dialog.addEventListener('click', (e) => {
      if (e.target.closest('[data-close-dialog]')) { dialog.close(); return; }
      const r = dialog.getBoundingClientRect();
      if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dialog.close();
    });
  }
}

/** Sheet, scan and result cards. */
function wireSheetCards() {
  $('btnMatchSheet').onclick = startFirstSheet;
  $('btnMatchPdf').onclick = downloadSheet;
  $('btnMatchRipSheet').onclick = downloadSheetLibrary;
  $('btnMatchRestart').onclick = restartSheet;
  $('btnMatchMeasure').onclick = measurePatch;
  $('btnMatchAnalyse').onclick = analyseMatch;
  $('btnMatchUndo').onclick = undoLastScan;
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
    const c = b && match.colors.find((x) => x.id === b.closest('[data-res]').dataset.res);
    if (!c) return;
    if (b.dataset.resAct === 'accept') { c.accepted = !c.accepted; commit(); }
    else if (b.dataset.resAct === 'copy') copyMatchValues(c, useNow(c));
  };
}

/** Color space card. */
function wireSpaceCard() {
  $('mChartSize').innerHTML = Object.entries(CHART_SIZES).map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)}</option>`).join('');
  $('mSpace').onchange = () => selectSpace($('mSpace').value);
  $('btnSpaceNew').onclick = createSpace;
  $('btnSpaceImport').onclick = () => $('spaceFile').click();
  onFilePicked('spaceFile', importSpaceFile);
  $('btnSpaceChart').onclick = createChart;
  $('mSpaceLearn').onchange = () => { match.learn = $('mSpaceLearn').checked; commit(); };
  $('mFillIn').onchange = () => { match.fillIn = $('mFillIn').value === 'auto' ? 'auto' : +$('mFillIn').value || 0; commit(); };
  $('btnSpaceJson').onclick = () => { const s = activeSpace(); if (s) downloadFile(spaceToJson(s), 'application/json', `${safeFileName(s.name)}.json`); };
  $('btnSpaceCgats').onclick = () => { const s = activeSpace(); if (s?.points.length) downloadFile(spaceToCgats(s), 'text/plain', `${safeFileName(s.name)}.txt`); };
  $('btnSpaceRename').onclick = renameSpace;
  $('btnSpaceDelete').onclick = deleteSpace;
  $('mSpaceCard').addEventListener('click', onSpaceClick);
}

/** The library's format and download (Colors card) and its name (Measuring & matching). */
function wireLibrary() {
  $('mRipFormat').onchange = () => { match.ripFormat = $('mRipFormat').value; commit(); };
  $('btnLibDownload').onclick = downloadColorLibrary;
  $('mLibName').onchange = () => { match.libraryName = $('mLibName').value.trim().slice(0, 60); commit(); };
}

/** Called once by app.js with the Console's state and helpers; wires Print match and the Color space view, opens the view in the URL. */
export function initMatch(app) {
  ({ state, task, settingsFromUI, updateControls, doCalibrate } = app);
  for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => setView(b.dataset.view);
  wireColors();
  wireSettings();
  wireSheetCards();
  wireSpaceCard();
  wireLibrary();
  wireDrop();
  initSpaceView(spaceViewData, { removePoint: removeSpacePoint });
  $('vsMeasure').onclick = measureForSpaceView;
  setView(location.hash.slice(1) || 'console');
  WIDE.addEventListener('change', () => { if (!WIDE.matches && state.view !== 'console') setView('console'); });
}

/**
 * The SD-10's button in Print match: measure the next patch, or the reference while there is no sheet; in the Color
 * space view: measure a color to show in the picture.
 */
export function onMatchButton() {
  if (state.view === 'space') measureForSpaceView();
  else if (currentSheet()) measurePatch(); else measureMatchTarget();
}
