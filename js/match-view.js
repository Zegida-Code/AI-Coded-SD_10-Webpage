// Print match view: find the values that make the user's printer reproduce reference colours – reference colours,
// test sheets (PDF / PNG), scanning the printed patches, per-colour results with metamerism and gamut checks, and the
// spot colour library. The maths is in match.js and the library file formats in rip-export.js; this is the UI.
// It shares the Console's device session: app.js hands over its state and helpers once, through initMatch().
import { $, DEMO, NEEDS_CALIBRATION, displayHex, downloadFile, escapeHtml, onFilePicked, round2, safeFileName, toast } from './ui.js';
import { METHOD } from './protocol.js';
import { deltaE2000, labD50ToSrgb, meanSpectrum, rgbHex, spectrumToLab, srgbToLabD50 } from './color.js';
import { CUSTOM_PREFIX, PRINTER_PREFIX, loadProfile, printerProfiles } from './icc.js';
import {
  DESIGNS, DE_FORMULAS, MEDIA, MODES, analyseRound, averageReadings, buildSheetPdf, buildSheetPng, designPatches, metamerism,
  minSheetHeight, nextStep, patchSpotName, sheetLayout,
} from './match.js';
import { RIP_EXPORTS, readLibrary } from './rip-export.js';
import { printSpectrum } from './printer-sim.js';

// From the Console (set by initMatch): shared state, the busy-guarded task runner, the Console's settings (for the
// CMYK profile), the control refresh and white calibration.
let state, task, settingsFromUI, updateControls, doCalibrate;

// Persisted job (localStorage 'sd10.match'):
//   settings: mode, media ('custom' | a preset 'a4' … | 'size:<name>' for a saved size), mediaW/mediaH (mm – the size
//             in use, also for presets), patchMm,
//             design ('full' | 'compact'), mf, tol, reads, ripFormat
//   formula (DE_FORMULAS key), printerProfile (name of a stored printer profile for the gamut check, '' = none)
//   colours: [{ id, code, name, target, targetSpectrum, refReads, refSpectra, accepted, next,
//               rounds: [{ round, mode, centre, step, kFixed, design,
//                          patches: [{ n, offset, x, name?, reads, spectra, lab, spread, spectrum }], result }] }]
//   active (index of the selected colour)
// Every colour is matched on its own: its own sheets (one per round), scan position (next = patch index) and result.
// The sheet, scan and result cards always work on the selected colour, so several colours can be in progress at once.
// code: 4 characters in the colour's patch spot names (SD10-<code>-R<round>-<n>), new for every fresh start.
const MATCH_KEY = 'sd10.match';
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const newCode = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const newColour = () => ({ id: newId(), code: newCode(), name: '', target: null, targetSpectrum: null, refReads: [], refSpectra: [], accepted: false, next: 0, rounds: [] });
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
  // jobs saved while all colours shared one sheet: give each colour its own code and scan position
  for (const c of m.colours ?? []) {
    c.code ??= m.jobId && c === m.colours[0] ? m.jobId : newCode();
    c.next ??= m.next?.c === c.id ? m.next.i : 0;
  }
  for (const k of ['sheet', 'next', 'jobId']) delete m[k];
  const out = { mode: 'spot', media: 'custom', mediaW: 210, mediaH: 297, patchMm: 20, design: 'full', mf: 1, tol: 1, reads: 1,
    formula: 'de00', printerProfile: '', ripFormat: 'cxf', colours: [], active: 0, ...m };
  if (!out.colours.length) out.colours = [newColour()];
  return out;
})();
// Media sizes the user saved: [{ name, w, h }] (mm) – kept in this browser, independent of the current job.
const SIZES_KEY = 'sd10.mediaSizes';
const savedSizes = (() => {
  try { return JSON.parse(localStorage.getItem(SIZES_KEY)) || []; } catch { return []; }
})();
const saveSizes = () => { try { localStorage.setItem(SIZES_KEY, JSON.stringify(savedSizes)); } catch { /* ignore */ } };
const SIZE_PREFIX = 'size:';
const PRESET_NAMES = { a4: 'A4', letter: 'Letter', a3: 'A3', tabloid: 'Tabloid' };
/** Width × height (mm) of a preset or saved size key, or null for 'custom' / a size that no longer exists. */
function mediaSizeOf(key) {
  if (MEDIA[key]) return MEDIA[key];
  const s = key.startsWith(SIZE_PREFIX) && savedSizes.find((x) => x.name === key.slice(SIZE_PREFIX.length));
  return s ? [s.w, s.h] : null;
}
// the boxes show the size in use: a preset's or saved size's own; a deleted saved size becomes custom
if (match.media !== 'custom') {
  const size = mediaSizeOf(match.media);
  if (size) [match.mediaW, match.mediaH] = size; else match.media = 'custom';
}
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
/** The selected colour with its current round (latest sheet) – what the sheet, scan and result cards work on. */
const sheetItems = () => { const c = activeColour(), r = latest(c); return r ? [{ c, r }] : []; };
/** The current sheet as layout groups, one per colour. */
const sheetGroups = () => sheetItems().map(({ c, r }) => ({ label: colourLabel(c), target: c.target, patches: r.patches, kFixed: r.kFixed }));
/** All patches of the current sheet in scan order: [{ c, r, p, i }]. */
const sheetPatches = () => sheetItems().flatMap(({ c, r }) => r.patches.map((p, i) => ({ c, r, p, i })));
/** Index (in sheetPatches()) of the patch to measure next: the selected colour's scan position. */
function nextIndex(all = sheetPatches()) {
  const k = all.findIndex((e) => e.i === activeColour().next);
  return k >= 0 ? k : Math.max(0, all.findIndex((e) => !e.p.lab));
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
  renderMediaOptions(); saveMatch(); renderMatch();
  toast(`Media size “${name}” saved`, 'ok');
}

function removeMediaSize() {
  if (!match.media.startsWith(SIZE_PREFIX)) return;
  const name = match.media.slice(SIZE_PREFIX.length);
  if (!confirm(`Remove the saved media size “${name}”? (The width and height stay as they are.)`)) return;
  savedSizes.splice(savedSizes.findIndex((s) => s.name === name), 1);
  saveSizes();
  match.media = 'custom';
  renderMediaOptions(); saveMatch(); renderMatch();
}

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

export function matchControls(busyLabel) {
  if (!state || !$('btnMatchMeasure')) return; // the Console refreshes its controls before initMatch() has run
  const on = !!state.session?.connected, idle = on && !state.busy;
  const all = sheetPatches();
  const e = all[nextIndex(all)];
  const c = activeColour();
  $('btnMatchTarget').disabled = !idle;
  $('btnMatchUseLast').disabled = !(state.lastLabD50 || state.last) || state.busy;
  $('btnMatchSheet').disabled = !c.target || state.busy;
  $('btnMatchMeasure').disabled = !idle || !all.length;
  $('btnMatchAnalyse').disabled = state.busy || !sheetItems().some(({ r }) => r.patches.filter((p) => p.lab).length >= 5);
  $('btnMatchRefine').disabled = state.busy || !c.target || c.accepted;
  const reading = (n) => (match.reads > 1 ? ` (reading ${n + 1}/${match.reads})` : '');
  $('btnMatchMeasure').textContent = busyLabel ? `${busyLabel}…`
    : !e ? 'Measure patch' : `Measure patch #${e.p.n}${match.colours.length > 1 ? ` – ${colourLabel(e.c)}` : ''}${reading(e.p.lab ? 0 : e.p.reads?.length ?? 0)}`;
  $('btnMatchTarget').textContent = `Measure reference${c.refReads.length ? reading(c.refReads.length) : ''}`;
}

/**
 * Media heights for the chosen width, patch size and patches per colour (whole mm, null when the patches do not fit
 * across the width): min = one row of patches plus the sheet's text (the smallest usable height), onePage = each
 * colour on a single page.
 */
function heightLimits() {
  const per = DESIGNS[match.design] ?? 16;
  // the current sheet, or a stand-in colour with the chosen number of patches before there is one
  const groups = sheetGroups().length ? sheetGroups() : [{ label: 'Colour 1', target: [50, 0, 0], kFixed: 0,
    patches: Array.from({ length: per }, (_, i) => ({ n: i + 1, offset: [0, 0, 0], x: [0, 0, 0], name: 'SD10-XXXX-R1-01' })) }];
  const opts = (g) => ({ mode: match.mode, groups: [g], round: latest(activeColour())?.round ?? 1, media: [match.mediaW, 0], patchMm: match.patchMm });
  const worst = (hs) => (hs.some((h) => h == null) ? null : Math.max(...hs));
  return {
    min: worst(groups.map((g) => minSheetHeight(opts(g), { onePage: false }))),
    onePage: worst(groups.map((g) => minSheetHeight(opts(g)))),
  };
}

function heightHint({ min, onePage }) {
  if (min == null) return `${match.patchMm} mm patches do not fit on ${match.mediaW} mm wide media.`;
  return min === onePage
    ? `Minimum height ${min} mm at ${match.mediaW} mm wide – one row of patches plus the sheet's text, each colour on one page.`
    : `Minimum height ${min} mm at ${match.mediaW} mm wide (one row of patches plus the sheet's text); ${onePage} mm fits each colour on one page.`;
}

function colourStatus(c) {
  if (!c.target) return 'no reference yet';
  if (c.accepted) return 'accepted';
  const r = latest(c);
  if (!r) return 'no sheet yet';
  if (r.result) return `round ${r.round} · predicted ${DE().label} ${r.result.predictedDeltaE.toFixed(2)}`;
  return `round ${r.round} · ${r.patches.filter((p) => p.lab).length}/${r.patches.length} scanned`;
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
  const fmtLabel = ` (${RIP_EXPORTS[match.ripFormat].label})`;
  $('btnMatchRipSheet').textContent = `Sheet library${fmtLabel}`;
  $('btnLibDownload').textContent = `Download library${fmtLabel}`;
  $('mModeHelp').innerHTML = modeHelp(match.mode);
  $('mPrintTips').innerHTML = printTips(match.mode);

  // sheet
  const items = sheetItems();
  const all = sheetPatches();
  const per = DESIGNS[match.design] ?? 16;
  const current = latest(c);
  $('mRoundLabel').textContent = `· ${colourLabel(c)}${current ? ` – sheet ${current.round}` : ''}`;
  $('btnMatchSheet').textContent = current ? 'New first sheet' : 'Create sheet';
  $('mSheetActions').classList.toggle('hidden', !items.length);
  $('btnMatchPdf').textContent = match.mode === 'rgb' ? 'Download PNG' : 'Download PDF';
  $('btnMatchRipSheet').classList.toggle('hidden', !items.some(({ r }) => r.mode === 'spot'));
  if (!t) $('mSheetInfo').textContent = `Set the reference of ${colourLabel(c)} first.`;
  else if (!items.length) $('mSheetInfo').textContent = `Creates a sheet of ${per} ${MODE_NAME[match.mode]} patches for ${colourLabel(c)}, around a first estimate of its reference.`;
  else {
    let pages = '';
    try {
      const n = sheetLayout({ mode: match.mode, groups: sheetGroups(), round: current.round, media: mediaMm(), patchMm: match.patchMm }).pages.length;
      pages = ` · ${n} page${n > 1 ? 's' : ''} of ${mediaName()} with ${match.patchMm} mm patches`;
    } catch (e) { pages = ` · <span class="text-rose-600">${escapeHtml(e.message)}</span>`; }
    const lines = items.map(({ c: x, r }) => {
      const vals = formatValues(r.mode, r.centre, r.kFixed).map(([k, v]) => `${k} ${v}`).join('  ');
      const steps = r.step.map((v, k) => `${MODES[r.mode].axes[k]} ±${fmt1(v)}`).join(', ');
      return `<li><b>${escapeHtml(colourLabel(x))}</b> (round ${r.round}): centre <span class="font-mono">${vals}</span> · steps ${steps}</li>`;
    }).join('');
    $('mSheetInfo').innerHTML = `${all.length} patches${pages}. Download, print and scan the patches below.
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

/** The selected colour's result (other colours keep theirs – select them in the list). */
function renderMatchResult() {
  const c = activeColour();
  const shown = !!latest(c)?.result;
  $('mResultCard').classList.toggle('hidden', !shown);
  if (!shown) return;
  $('mResult').innerHTML = resultBlock(c);
  $('btnMatchRefine').textContent = c.accepted ? 'Accepted – no more sheets' : 'Make next sheet';
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
  if (c.rounds.some((r) => r.patches.some((p) => p.lab)) && !confirm(`Changing the reference of ${colourLabel(c)} starts its matching over. Continue?`)) { renderMatch(); return false; }
  c.target = lab.map(round2);
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

/** A colour's next sheet (round) around `centre`; its patches are named SD10-<colour code>-R<round>-<n> in spot mode. */
function createRound(c, { centre, step, kFixed }) {
  const round = (latest(c)?.round ?? 0) + 1;
  const patches = designPatches(match.mode, centre, step, match.design)
    .map((p) => (match.mode === 'spot' ? { ...p, name: patchSpotName(c.code, round, p.n) } : p));
  c.rounds.push({ round, mode: match.mode, centre, step, kFixed, design: match.design, patches, result: null });
  c.next = 0;
  saveMatch(); renderMatch();
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

/** The selected colour's current sheet as a PDF (or PNG pages for raster workflows), named after the colour and sheet. */
async function downloadSheet() {
  if (!sheetItems().length) return;
  try {
    for (const g of sheetGroups()) {
      const { round } = latest(activeColour());
      const opts = { mode: match.mode, groups: [g], round, media: mediaMm(), patchMm: match.patchMm };
      const base = safeFileName(`${g.label} - sheet ${round}`);
      if (match.mode === 'rgb') {
        const pages = await buildSheetPng(opts);
        pages.forEach(({ png }, i) => downloadFile(png, 'image/png', `${base}${pages.length > 1 ? ` - page ${i + 1}` : ''}.png`));
        if (pages[0].dpi < 300) toast(`Large media: the PNG is ${pages[0].dpi} dpi (still printed at actual size).`);
      } else downloadFile(buildSheetPdf(opts), 'application/pdf', `${base}.pdf`);
    }
  } catch (e) { toast(e.message, 'error'); }
}

/** Spot colour library for the RIP: the current sheet's patch colours ('sheet') or the collected spot library ('library'). */
function downloadRipLibrary(what, rip = match.ripFormat) {
  const ex = RIP_EXPORTS[rip];
  if (!ex) return;
  if (what === 'sheet' && sheetItems().length) {
    const { c, r } = sheetItems()[0];
    const colours = sheetPatches().filter((e) => e.p.name).map((e) => ({ name: e.p.name, lab: e.p.x }));
    if (!colours.length) return;
    const text = ex.build({ library: `SD10 ${c.code} sheet ${r.round}`, description: `Print match test sheet patches for ${colourLabel(c)}, CIE L*a*b* D50/2°`, colours });
    downloadFile(text, ex.mime, `sd10-${c.code}-sheet${r.round}.${ex.ext}`);
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
    c.next = all[after >= 0 ? after : any >= 0 ? any : k].i;
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

/** "Calculate now": the selected colour's result from the patches measured so far (at least 5). */
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

async function addPrinterProfile(file) {
  if (file.size > 30 * 1024 * 1024) { toast('That file is too large to be a printer profile.', 'error'); return; }
  try {
    const r = await printerProfiles.add(file);
    match.printerProfile = r.name;
    await refreshPrinterProfiles();
    saveMatch(); renderMatch();
    toast(`Printer profile “${r.name}” added (${r.channels} ink channels)${r.saved ? '' : ' – for this session only (browser storage is unavailable)'}`, 'ok');
  } catch (err) { toast(`Could not use ${file.name}: ${err.message}`, 'error'); }
}

async function refreshPrinterProfiles() {
  const names = await printerProfiles.list();
  if (match.printerProfile && !names.includes(match.printerProfile)) match.printerProfile = '';
  $('mPrinterProfile').innerHTML = '<option value="">None</option>' + names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  $('mPrinterProfile').value = match.printerProfile;
}

function resetMatching() {
  for (const c of match.colours) { c.rounds = []; c.accepted = false; c.next = 0; }
}

export function initMatch(app) {
  ({ state, task, settingsFromUI, updateControls, doCalibrate } = app);
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
    } else match.active = i;
    saveMatch(); renderMatch();
  };
  $('mMode').onchange = () => {
    if (match.colours.some((c) => c.rounds.length) && !confirm('Changing the sheet type starts every colour over. Continue?')) { $('mMode').value = match.mode; return; }
    match.mode = $('mMode').value; resetMatching(); saveMatch(); renderMatch();
  };
  // A preset or saved size fills in the width and height; editing either box makes the size custom.
  renderMediaOptions();
  $('mPaper').onchange = () => {
    match.media = $('mPaper').value;
    const size = mediaSizeOf(match.media);
    if (size) [match.mediaW, match.mediaH] = size;
    saveMatch(); renderMatch();
  };
  $('btnMediaSave').onclick = saveMediaSize;
  $('btnMediaRemove').onclick = removeMediaSize;
  for (const [id, key, lo, hi] of [['mMediaW', 'mediaW', 50, 3000], ['mMediaH', 'mediaH', 20, 10000]]) {
    $(id).oninput = () => { $('mPaper').value = 'custom'; };
    $(id).onchange = () => {
      match[key] = Math.min(Math.max(Math.round(+$(id).value * 10) / 10 || match[key], lo), hi);
      match.media = 'custom';
      saveMatch(); renderMatch(); // renderMatch raises a height below the minimum (and says so)
    };
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
  onFilePicked('libFile', importLibraryFile);
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
  onFilePicked('printerIccFile', addPrinterProfile);
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
  $('btnMatchRestart').onclick = () => {
    const c = activeColour();
    if (!confirm(`Discard the sheets and measurements of ${colourLabel(c)}? (Its reference is kept.)`)) return;
    c.rounds = []; c.accepted = false; c.next = 0;
    saveMatch(); renderMatch();
  };
  $('btnMatchMeasure').onclick = measurePatch;
  $('btnMatchAnalyse').onclick = analyseMatch;
  $('btnMatchRefine').onclick = makeNextSheet;
  $('mPatchGrid').onclick = (e) => {
    const b = e.target.closest('[data-patch]');
    if (!b) return;
    const en = sheetPatches()[+b.dataset.patch];
    if (en) { activeColour().next = en.i; saveMatch(); renderMatch(); }
  };
  setView(location.hash === '#match' ? 'match' : 'console');
  WIDE.addEventListener('change', () => { if (!WIDE.matches && state.view === 'match') setView('console'); });
}

/** The SD-10's button in this view: measure the next patch, or the reference while there is no sheet. */
export function onMatchButton() {
  if (sheetPatches().length) measurePatch(); else measureMatchTarget();
}
