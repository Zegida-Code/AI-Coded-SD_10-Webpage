// Self-checks for the SD-10 web app. Open test/index.html (served over http) or run headless.
import { build, hex, parseStatus, parseRecords, parseGroups, payloadOf, CMD, METHOD } from '../js/protocol.js';
import { spectrumToLab, deltaE2000, labD50ToSrgb, srgbToLabD50 } from '../js/color.js';
import { SD10Session } from '../js/session.js';
import { MockTransport } from '../js/mock.js';
import { GOLDEN_LAB } from './golden-lab.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const eqHex = (name, bytes, expected) => {
  const got = hex(bytes);
  check(name, got === expected.toUpperCase(), got === expected.toUpperCase() ? '' : `got ${got}`);
};

// ---- 1. command frames vs. output of the app's own CommandBuilder (emulated libmunsell-lib.so)
const appId = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
const G = {
  getStatus: '00 43 0B 11 01 00 00 00 00',
  calibrate: '00 43 0C 12 01 00 00 00 01',
  measure: '00 43 01 12 01 00 00 00 01',
  resultSize: '00 43 05 10 01 00 00 00 00',
  result: '00 43 05 11 01 00 00 00 00',
  nvramSize: '00 43 07 10 01 00 00 00 01',
  groupSize: '00 43 16 10 01 00 00 00 01',
  standAlone: '00 43 1D 12 01 00 00 00 01',
  getMode: '00 43 1B 11 01 00 00 00 01',
  groupDone: '00 43 1E 13 01 00 00 00 01',
};
for (const [k, v] of Object.entries(G)) eqHex(`frame ${k}`, build[k](), v);
eqHex('frame getInt buzzer', build.getInt(CMD.BUZZER), '00 43 0F 11 01 00 00 00 01');
eqHex('frame setInt language=1', build.setInt(CMD.LANGUAGE, 1), '00 43 20 13 01 00 00 00 01');
eqHex('frame getString serial', build.getString(CMD.SERIAL), '00 43 0E 11 01 00 00 00 01');
eqHex('frame setDeviceName', build.setDeviceName('MySD10'), '00 43 08 13 10 00 00 00 4D 79 53 44 31 30 00 00 00 00 00 00 00 00 00 00');
eqHex('frame control acquire', build.control(true, appId, 1), '00 43 19 12 18 00 00 00 01 01 01 02 01 01 03 10 A0 A1 A2 A3 A4 A5 A6 A7 A8 A9 AA AB AC AD AE AF');
eqHex('frame control release', build.control(false, appId, 1), '00 43 19 12 18 00 00 00 01 01 02 02 01 01 03 10 A0 A1 A2 A3 A4 A5 A6 A7 A8 A9 AA AB AC AD AE AF');
eqHex('frame notify ok', build.notifyResult(true), '00 43 1C 13 01 00 00 00 01');
eqHex('frame notify fail', build.notifyResult(false), '00 43 1C 13 01 00 00 00 02');
eqHex('frame datetime', build.setDatetime(new Date(2026, 9, 17, 13, 45, 30)), '00 43 0D 13 06 00 00 00 1A 0A 11 0D 2D 1E');
eqHex('frame history check', build.historyCheck(0x12345678), '00 43 13 11 05 00 00 00 01 78 56 34 12');
eqHex('frame history get', build.history(5, 3), '00 43 14 12 09 00 00 00 01 05 00 00 00 03 00 00 00');
eqHex('frame history delete', build.historyDelete(5, 3), '00 43 14 12 09 00 00 00 02 05 00 00 00 03 00 00 00');
const base = { saveResult: true, mFactor: 0, lightSource: 0, viewingAngle: 2 };
eqHex('mode spot', build.setMode({ method: 1, ...base }), '00 43 1A 13 0F 00 00 00 01 01 01 02 01 02 04 01 00 05 01 00 06 01 02');
eqHex('mode spot no-save F12', build.setMode({ method: 1, ...base, saveResult: false, lightSource: 28 }), '00 43 1A 13 0F 00 00 00 01 01 01 02 01 01 04 01 00 05 01 1C 06 01 02');
eqHex('mode compare thr=1', build.setMode({ method: 2, ...base, colorDiffFormula: 0, threshold: 1 }), '00 43 1A 13 18 00 00 00 01 01 02 02 01 02 04 01 00 05 01 00 06 01 02 07 01 00 08 04 00 00 20 41');
eqHex('mode compare thr=2.5 de76', build.setMode({ method: 2, ...base, colorDiffFormula: 3, threshold: 2.5 }), '00 43 1A 13 18 00 00 00 01 01 02 02 01 02 04 01 00 05 01 00 06 01 02 07 01 03 08 04 00 00 C8 41');
eqHex('mode calibration', build.setMode({ method: 6 }), '00 43 1A 13 03 00 00 00 01 01 04');
eqHex('mode spot group', build.setMode({ method: 3, saveResult: true, groupNo: 4, startPatchNo: 80 }), '00 43 1A 13 0C 00 00 00 01 01 02 02 01 02 09 01 04 0B 01 50');
eqHex('mode scan group', build.setMode({ method: 5, saveResult: true, groupNo: 1, patchNum: 18, startPatchNo: 63 }), '00 43 1A 13 0F 00 00 00 01 01 03 02 01 02 09 01 01 0A 01 12 0B 01 3F');
eqHex('mode scan labs', build.setMode({ method: 4, ...base, patchNum: 2, patchBorder: true, lineNo: 300, labs: [[50, 10, -20], [60.5, -5.25, 5]] }),
  '00 43 1A 13 33 00 00 00 01 01 05 02 01 02 04 01 00 05 01 00 06 01 02 0A 01 02 0D 01 01 0E 18 00 40 9C 45 00 00 7A 44 00 00 FA C4 00 10 BD 45 00 40 03 C4 00 00 FA 43 0F 02 2C 01');
eqHex('mode scan comparison', build.setMode({ method: 7, ...base, colorDiffFormula: 0, threshold: 0, patchNum: 2, patchBorder: false, lineNo: 1, labs: [[50, 10, -20], [60.5, -5.25, 5]] }),
  '00 43 1A 13 3C 00 00 00 01 01 03 02 01 02 04 01 00 05 01 00 06 01 02 07 01 00 08 04 00 00 00 00 0A 01 02 0D 01 00 0E 18 00 40 9C 45 00 00 7A 44 00 00 FA C4 00 10 BD 45 00 40 03 C4 00 00 FA 43 0F 02 01 00');
const paint = { control: 2, slot: 1, hardwareId: 0x1234, name: 'Paint', patchBorder: false, mFactor: 0, lightSource: 0, viewingAngle: 2, colorDiffFormula: 0, threshold: 1, labs: [[50, 10, -20]] };
eqHex('group register', build.setGroups([paint]), '00 43 15 13 45 00 00 00 02 01 34 12 05 0A 3B 33 34 2E ' + Array(37).fill('5A').join(' ') + ' 00 01 00 00 02 00 00 00 20 41 00 40 9C 45 00 00 7A 44 00 00 FA C4');
eqHex('group delete', build.setGroups([{ control: 1, slot: 3 }]), '00 43 15 13 02 00 00 00 01 03');
let threw = false; try { build.setMode({ method: 4, ...base, patchNum: 19, lineNo: 1 }); } catch { threw = true; }
check('mode validation rejects patchNum 19', threw);

// ---- 2. parsers
const statusReply = Uint8Array.from([0, 0x43, 0x0b, 1, 25, 0, 0, 0, 1, 1, 4, 2, 8, 0, 0x02, 0, 0, 0, 0, 0, 0x04, 3, 1, 2, 4, 1, 77, 5, 1, 0, 6, 1, 1]);
const st = parseStatus(statusReply);
check('status parse', st.deviceStatus === 4 && st.calibrationStatus === 2 && st.battery === 77 && st.chargingStatus === 1 && st.errors.map((e) => e.bit).join() === '2,49', JSON.stringify({ ...st, errorStatus: String(st.errorStatus) }));
const groupsBack = parseGroups(payloadOf(Uint8Array.from([...build.setGroups([paint])].map((b, i) => (i === 3 ? 1 : b))), CMD.SET_GROUP));
check('group round-trip', groupsBack[0].name === 'Paint' && groupsBack[0].hardwareId === 0x1234 && Math.abs(groupsBack[0].labs[0][2] + 20) < 1e-4 && Math.abs(groupsBack[0].threshold - 1) < 1e-6);

// ---- 3. colour maths vs. the app's native conversion
let worst = 0;
for (const c of GOLDEN_LAB) {
  const lab = spectrumToLab(c.spectrum, c.lightSource, c.observer);
  worst = Math.max(worst, ...lab.map((v, i) => Math.abs(v - c.lab[i])));
}
check(`spectrumToLab matches native (${GOLDEN_LAB.length} cases, max |Δ| ${worst.toExponential(1)})`, worst < 1e-3);
// Sharma et al. (2005) CIEDE2000 test data, pairs 1, 2 and 7
const sharma = [[[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425], [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615], [[50, 0, 0], [50, -1, 2], 2.3669]];
for (const [a, b, e] of sharma) check(`ΔE2000 ${a} vs ${b} = ${e}`, Math.abs(deltaE2000(a, b) - e) < 1e-4, deltaE2000(a, b).toFixed(5));

// ---- 3b. CMYK vs. the app's own CMM (libepcmm.so, emulated) with EpsonWideCMYK_Ver2 / perceptual
async function cmykCheck() {
  const { GOLDEN_CMYK } = await import('./golden-cmyk.js');
  const { loadProfile } = await import('../js/icc.js');
  const prof = await loadProfile('EpsonWideCMYK_Ver2');
  let worst = 0, detail = '';
  for (const g of GOLDEN_CMYK) {
    const got = prof.fromLab(g.lab, 0);
    const err = Math.max(...got.map((v, i) => Math.abs(v - g.cmyk[i])));
    if (err > worst) { worst = err; detail = `Lab ${g.lab} -> got ${got.map((v) => v.toFixed(2))} native ${g.cmyk.map((v) => v.toFixed(2))}`; }
  }
  check(`CMYK matches the app's CMM (${GOLDEN_CMYK.length} colours, max |Δ| ${worst.toFixed(3)}%)`, worst < 0.5, detail);
}

// ---- 3c. ICC v4 lutBtoA ('mBA ') support, using a synthetic profile built here
function buildV4Profile() {
  // CLUT 2x2x2 (16-bit): C = 1 - L, M = a, Y = b, K = 0  (inputs are v4-encoded Lab, 0..1)
  const clut = [];
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) clut.push(1 - i, j, k, 0);
  const curvId = [0x63, 0x75, 0x72, 0x76, 0, 0, 0, 0, 0, 0, 0, 0]; // 'curv', count 0 = identity
  const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const bCurves = [...curvId, ...curvId, ...curvId];
  const clutBytes = [2, 2, 2, ...Array(13).fill(0), 2, 0, 0, 0, ...clut.flatMap((v) => { const u = Math.round(v * 65535); return [u >> 8, u & 255]; })];
  const aCurves = [...curvId, ...curvId, ...curvId, ...curvId];
  const offB = 32, offClut = offB + bCurves.length, offA = offClut + clutBytes.length;
  const mba = [0x6d, 0x42, 0x41, 0x20, 0, 0, 0, 0, 3, 4, 0, 0, ...be32(offB), ...be32(0), ...be32(0), ...be32(offClut), ...be32(offA), ...bCurves, ...clutBytes, ...aCurves];
  const tagOff = 128 + 4 + 12;
  const total = tagOff + mba.length;
  const head = new Uint8Array(128);
  head.set(be32(total), 0); head[8] = 4; // version 4
  head.set([0x70, 0x72, 0x74, 0x72], 12); head.set([0x43, 0x4d, 0x59, 0x4b], 16); head.set([0x4c, 0x61, 0x62, 0x20], 20); head.set([0x61, 0x63, 0x73, 0x70], 36);
  return new Uint8Array([...head, ...be32(1), 0x42, 0x32, 0x41, 0x30, ...be32(tagOff), ...be32(mba.length), ...mba]).buffer;
}
async function iccV4Check() {
  const { IccProfile } = await import('../js/icc.js');
  const prof = new IccProfile(buildV4Profile());
  let ok = true; try { prof.validateCmyk(); } catch (e) { ok = false; check('v4 profile validates', false, e.message); }
  if (ok) check('v4 profile validates', true);
  const [c, m, y, k] = prof.fromLab([25, 0, 0]);
  check('v4 mBA pipeline (C = 1 - L/100, Lab v4 encoding)', Math.abs(c - 75.29) < 0.05 && Math.abs(m - 50.39) < 0.02 && Math.abs(y - 50.39) < 0.02 && k === 0, [c, m, y, k].map((v) => v.toFixed(2)).join(', '));
  let rejected = false; try { new IccProfile(new TextEncoder().encode('not a profile at all'.repeat(10)).buffer); } catch { rejected = true; }
  check('non-ICC file rejected', rejected);
}

// ---- 3d. Print match: model fitting, convergence with a simulated printer, PDF sheet
async function matchCheck() {
  const { designPatches, fitModel, analyseRound, nextStep, trustRadius, buildSheetPdf, buildSheetPng, sheetLayout, minSheetHeight, averageReadings, patchSpotName, MODES, DE_FORMULAS, metamerism } = await import('../js/match.js');
  const { deltaECMC } = await import('../js/color.js');
  const { RIP_EXPORTS, readLibrary } = await import('../js/rip-export.js');
  const { printSpectrum } = await import('../js/printer-sim.js');
  const { loadProfile } = await import('../js/icc.js');
  const prof = await loadProfile('EpsonWideCMYK_Ver2');

  // exact linear printer -> the fitted model must recover it
  const J = [[-0.5, -0.2, -0.1], [-0.3, 0.9, -0.4], [-0.2, -0.1, 0.8]], m0 = [60, 10, 20], x0 = [30, 40, 50];
  const lin = (x) => m0.map((m, i) => m + J[i].reduce((s, j, k) => s + j * (x[k] - x0[k]), 0));
  const pts = designPatches('cmyk', x0, [6, 6, 6]).map((p) => ({ ...p, lab: lin(p.x) }));
  const fit = fitModel(pts, x0);
  check('print match: model fit recovers a linear printer', fit.rms < 1e-6 && Math.abs(fit.J[1][1] - 0.9) < 1e-6, `rms ${fit.rms}`);

  // closed loop against the simulated printer (deterministic), every sheet type
  for (const mode of ['cmyk', 'lab', 'spot', 'rgb']) {
    const truth = [18, 62, 74, 6];                              // what the printer really needs
    const target = spectrumToLab(printSpectrum(truth), 0, 2);   // the reference colour
    // rgb: the raster software converts sRGB -> printer through the same (deliberately wrong) profile
    const toCmyk = (x, k) => (mode === 'cmyk' ? [...x, k] : prof.fromLab(mode === 'rgb' ? srgbToLabD50(x) : x, 0));
    const printed = (x, k) => spectrumToLab(printSpectrum(toCmyk(x, k)), 0, 2);
    let centre, k = 0;
    if (mode === 'cmyk') { const c = prof.fromLab(target, 0); centre = c.slice(0, 3); k = truth[3]; }
    else if (mode === 'rgb') centre = labD50ToSrgb(target).rgb;
    else centre = [...target];
    let step = [...MODES[mode].step0], round, firstDE = null, log = [];
    for (round = 1; round <= 4; round++) {
      const patches = designPatches(mode, centre, step).map((p) => ({ ...p, lab: printed(p.x, k) }));
      const res = analyseRound({ mode, centre, step, patches }, target);
      if (firstDE === null) firstDE = res.centreDE;
      log.push(`r${round}: centre ΔE ${res.centreDE.toFixed(2)} -> predicted ${res.predictedDeltaE.toFixed(2)}`);
      step = nextStep(mode, step, res.correction);
      centre = res.x;
      if (res.centreDE < 0.5) break;
    }
    const finalDE = deltaE2000(target, printed(centre, k));
    check(`print match converges (${mode}): first guess ΔE00 ${firstDE.toFixed(2)} -> ${finalDE.toFixed(2)} after ${Math.min(round, 4)} round(s) [${log.join('; ')}]`, finalDE < 1 && firstDE > 2);
  }

  // out-of-gamut reference (a dark, saturated purple like a real test that ran away to L 0 / a ±127):
  // every round must stay near measured colours, never recommend worse than the best patch, and flag the gamut limit
  {
    const target = [20, 60, -85];
    const printed = (x) => spectrumToLab(printSpectrum(prof.fromLab(x, 0)), 0, 2);
    let centre = [...target], step = [...MODES.lab.step0], res, bestEver = Infinity, log = [], runaway = false;
    for (let round = 1; round <= 5; round++) {
      const patches = designPatches('lab', centre, step).map((p) => ({ ...p, lab: printed(p.x) }));
      res = analyseRound({ mode: 'lab', centre, step, patches }, target);
      bestEver = Math.min(bestEver, res.best.dE);
      if (res.x.some((v, k) => Math.abs(v - centre[k]) > trustRadius('lab', step)[k] + 1e-6) || res.x[0] <= 0 || Math.abs(res.x[1]) >= 127 || Math.abs(res.x[2]) >= 127) runaway = true;
      log.push(`r${round}: centre ΔE ${res.centreDE.toFixed(2)}, best ${res.best.dE.toFixed(2)}, rec ${res.x.map((v) => v.toFixed(1)).join('/')} (${res.source}${res.gamutLimited ? ', gamut' : ''})`);
      step = nextStep('lab', step, res.correction);
      centre = res.x;
    }
    const finalDE = deltaE2000(target, printed(centre));
    check(`print match stays bounded for an out-of-gamut reference and flags it [${log.join('; ')}]`, !runaway && finalDE <= bestEver + 0.5 && res.gamutLimited && res.predictedDeltaE > 2);
  }

  // a printer at its limits, like a dark purple on vinyl: it never prints darker than L* 30, and asking for more chroma
  // than it has makes the colour duller and bluer. Over 8 rounds the search must remember its best patch, undo moves
  // that made it worse, and never recommend values that print far off – before this, rounds jumped to ΔE 15–25.
  {
    const printed = ([L, a, b]) => {
      const C = Math.hypot(a, b), h = Math.atan2(b, a);
      const Cp = C <= 40 ? C * 0.9 : Math.max(10, 36 - (C - 40) * 0.4);
      const hp = h - (C > 40 ? (C - 40) * 0.012 : 0);
      return [Math.max(30, L * 0.8 + 9), Cp * Math.cos(hp), Cp * Math.sin(hp)];
    };
    const target = [26.4, 28.8, -31.6];
    let centre = [...target], step = [...MODES.spot.step0];
    const rounds = [], recs = [];
    let regressions = 0, bestSeen = Infinity;
    for (let round = 1; round <= 8; round++) {
      const r = { round, mode: 'spot', centre, step, patches: designPatches('spot', centre, step).map((p) => ({ ...p, lab: printed(p.x) })) };
      r.result = analyseRound(r, target, 'de00', rounds);
      rounds.push(r);
      bestSeen = Math.min(bestSeen, r.result.bestEver.dE);
      if (r.result.regressed) regressions++;
      recs.push(deltaE2000(target, printed(r.result.x)));
      step = nextStep('spot', step, r.result.correction);
      centre = r.result.x;
    }
    const worst = Math.max(...recs);
    check(`at the gamut edge the search keeps its best patch and undoes failed moves (recommendations print ΔE00 ${recs.map((v) => v.toFixed(1)).join(', ')}; best ${bestSeen.toFixed(2)})`,
      worst < 6 && recs[recs.length - 1] <= bestSeen + 0.5 && regressions >= 1 && rounds[rounds.length - 1].result.gamutLimited);
  }

  // PDF structure
  const pdfBytes = buildSheetPdf({ mode: 'cmyk', patches: designPatches('cmyk', [20, 60, 70], [6, 6, 6]), target: [55, 40, 50], round: 1, kFixed: 5 });
  const txt = new TextDecoder('latin1').decode(pdfBytes);
  const xrefAt = +txt.match(/startxref\n(\d+)/)[1];
  const offsets = [...txt.slice(xrefAt).matchAll(/(\d{10}) 00000 n/g)].map((m) => +m[1]);
  const offsetsOk = offsets.length === 6 && offsets.every((o, i) => txt.startsWith(`${i + 1} 0 obj`, o));
  const fills = (txt.match(/ k\n/g) || []).length;
  check('print match sheet is a valid PDF (header, xref offsets, 16 CMYK patches)', txt.startsWith('%PDF-1.4') && txt.slice(xrefAt, xrefAt + 4) === 'xref' && offsetsOk && fills === 16, `offsetsOk=${offsetsOk} fills=${fills}`);
  const labPdf = new TextDecoder('latin1').decode(buildSheetPdf({ mode: 'lab', patches: designPatches('lab', [55, 40, 50], [4, 6, 6]), target: [55, 40, 50], round: 2, paper: 'letter' }));
  // spot sheet: one Separation per patch, uniquely named, Lab alternate = the patch value at tint 1
  const spotPatches = designPatches('spot', [55, 40, 50], [4, 6, 6]).map((p) => ({ ...p, name: patchSpotName('AB12', 3, p.n) }));
  const spotPdf = new TextDecoder('latin1').decode(buildSheetPdf({ mode: 'spot', patches: spotPatches, target: [55, 40, 50], round: 3 }));
  const seps = [...spotPdf.matchAll(/\/SP(\d+) \[\/Separation \/(\S+) \[\/Lab << \/WhitePoint \[0\.9642 1 0\.8249\][^\]]*\] >>\] << \/FunctionType 2 \/Domain \[0 1\] \/C0 \[100 0 0\] \/C1 \[([-\d. ]+)\] \/N 1 >>\]/g)];
  const sepOk = seps.length === 16 && seps.every((m, i) => m[2] === `SD10-AB12-R3-${String(i + 1).padStart(2, '0')}` && m[3] === spotPatches[i].x.map((v) => v.toFixed(2)).join(' '));
  check('spot sheet: 16 named Separation colours (SD10-<job>-R<round>-<n>) with Lab D50 alternates', sepOk && (spotPdf.match(/ cs 1 scn\n/g) || []).length === 16 && spotPdf.includes('(SD10-AB12-R3-07) Tj'), `${seps.length} separations`);
  check('rgb values are whole numbers 0..255', designPatches('rgb', [250, 3, 128], [14, 14, 14]).every((p) => p.x.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)));

  // VersaWorks library – must reproduce a library exported by VersaWorks 6 byte for byte
  const VIN_SPOT = '<?xml version="1.0" encoding="UTF-8"?>\n<SpotColorLibraryList strVersion="4.3.0.0"><LabSpotColorLibrary name="Test"><m_eMakerType>0</m_eMakerType><m_bUseLibrary>false</m_bUseLibrary><Lab16SpotColor name="Brand Red" flags="0" redirectLibraryName="" redirectColorName=""><L VALUE="75.00"/><a VALUE="50.00"/><b VALUE="100.00"/></Lab16SpotColor><Lab16SpotColor name="SpotColor0" flags="0" redirectLibraryName="" redirectColorName=""><L VALUE="0.00"/><a VALUE="0.00"/><b VALUE="0.00"/></Lab16SpotColor></LabSpotColorLibrary></SpotColorLibraryList>\n';
  const vw = RIP_EXPORTS.versaworks.build({ library: 'Test', colours: [{ name: 'Brand Red', lab: [75, 50, 100] }, { name: 'SpotColor0', lab: [0, 0, 0] }] });
  check('VersaWorks .spot export is identical to a VersaWorks-exported library', vw === VIN_SPOT, vw);
  const vwEsc = RIP_EXPORTS.versaworks.build({ library: 'A&B', colours: [{ name: 'Red "1" <x>', lab: [50.123, -3.456, 7.891] }] });
  check('VersaWorks export escapes names and rounds to 2 decimals', vwEsc.includes('name="A&amp;B"') && vwEsc.includes('name="Red &quot;1&quot; &lt;x&gt;"') && vwEsc.includes('<a VALUE="-3.46"/>') && new DOMParser().parseFromString(vwEsc, 'application/xml').querySelector('parsererror') === null);

  // CxF3: written exactly like a Digital Factory export of the same three colours (that file minus the lines that
  // describe Digital Factory's measuring device), and still a well-formed core-namespace file with escaped names
  const DF_CXF = "\ufeff<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<cc:CxF xmlns:cc=\"http://colorexchangeformat.com/CxF3-core\">\r\n  <cc:Resources>\r\n    <cc:ObjectCollection>\r\n      <cc:Object ObjectType=\"Standard\" Name=\"Color 1\" Id=\"EXC_1\">\r\n        <cc:ColorValues>\r\n          <cc:ColorCIELab ColorSpecification=\"CS0\">\r\n            <cc:L>42</cc:L>\r\n            <cc:A>0</cc:A>\r\n            <cc:B>69</cc:B>\r\n          </cc:ColorCIELab>\r\n        </cc:ColorValues>\r\n      </cc:Object>\r\n      <cc:Object ObjectType=\"Standard\" Name=\"color2\" Id=\"EXC_2\">\r\n        <cc:ColorValues>\r\n          <cc:ColorCIELab ColorSpecification=\"CS0\">\r\n            <cc:L>69</cc:L>\r\n            <cc:A>42</cc:A>\r\n            <cc:B>0</cc:B>\r\n          </cc:ColorCIELab>\r\n        </cc:ColorValues>\r\n      </cc:Object>\r\n      <cc:Object ObjectType=\"Standard\" Name=\"cololooloooolor 3\" Id=\"EXC_3\">\r\n        <cc:ColorValues>\r\n          <cc:ColorCIELab ColorSpecification=\"CS0\">\r\n            <cc:L>50</cc:L>\r\n            <cc:A>50</cc:A>\r\n            <cc:B>50</cc:B>\r\n          </cc:ColorCIELab>\r\n        </cc:ColorValues>\r\n      </cc:Object>\r\n    </cc:ObjectCollection>\r\n    <cc:ColorSpecificationCollection>\r\n      <cc:ColorSpecification Id=\"CS0\">\r\n        <cc:TristimulusSpec>\r\n          <cc:Illuminant>D50</cc:Illuminant>\r\n          <cc:Observer>2_Degree</cc:Observer>\r\n          <cc:Method>E308_Table6</cc:Method>\r\n        </cc:TristimulusSpec>\r\n        <cc:MeasurementSpec>\r\n          <cc:MeasurementType>Spectrum_Reflectance</cc:MeasurementType>\r\n          <cc:GeometryChoice>\r\n            <cc:SingleAngle>\r\n              <cc:SingleAngleConfiguration>Annular</cc:SingleAngleConfiguration>\r\n              <cc:IlluminationAngle>45</cc:IlluminationAngle>\r\n              <cc:MeasurementAngle>0.0</cc:MeasurementAngle>\r\n            </cc:SingleAngle>\r\n          </cc:GeometryChoice>\r\n        </cc:MeasurementSpec>\r\n      </cc:ColorSpecification>\r\n    </cc:ColorSpecificationCollection>\r\n  </cc:Resources>\r\n</cc:CxF>";
  const cxf = RIP_EXPORTS.cxf.build({ library: 'Lib', colours: [{ name: 'Color 1', lab: [42, 0, 69] }, { name: 'color2', lab: [69, 42, 0] }, { name: 'cololooloooolor 3', lab: [50, 50, 50] }] });
  check('CxF3 export is identical to a Digital Factory-exported library (BOM, CRLF, cc: prefix)', cxf === DF_CXF, JSON.stringify(cxf.slice(0, 200)));
  const cxf2 = RIP_EXPORTS.cxf.build({ colours: [{ name: 'A&B "1"', lab: [45.678, -0.001, 26.4] }] });
  const cdoc = new DOMParser().parseFromString(cxf2.replace(/^﻿/, ''), 'application/xml');
  const NS = 'http://colorexchangeformat.com/CxF3-core';
  const obj = cdoc.getElementsByTagNameNS(NS, 'Object')[0];
  const lab0 = obj && ['L', 'A', 'B'].map((t) => obj.getElementsByTagNameNS(NS, t)[0]?.textContent);
  check('CxF3 export: well-formed, names escaped, values in shortest form to 2 decimals (no "-0")', !cdoc.querySelector('parsererror') && cdoc.documentElement.namespaceURI === NS &&
    obj?.getAttribute('Name') === 'A&B "1"' && lab0.join() === '45.68,0,26.4', cxf2);

  // Adobe Color Book: byte layout of the reference ACB encoder (Lab book, 8-bit components, 'spflspot' trailer)
  const acb = RIP_EXPORTS.acb.build({ library: 'Test', description: 'd', id: 4242, colours: [{ name: 'Brand Red', lab: [45.6, 60.4, -30.4] }, { name: 'Grey', lab: [50, 0, 0] }] });
  const acbHex = [...acb].map((v) => v.toString(16).padStart(2, '0')).join('');
  check('Adobe Color Book export matches the reference byte layout', acbHex === '38424342000110920000000400540065007300740000000000000000000000010064000200020001000700000009004200720061006e0064002000520065006453443030303174bc620000000400470072006500795344303030328080807370666c73706f74', acbHex);
  const qz = RIP_EXPORTS.acb.quantize([45.6, 60.4, -30.4]);
  check('Adobe Color Book quantisation: L* steps of 100/255, whole a*/b*', Math.abs(qz[0] - 116 * 100 / 255) < 1e-9 && qz[1] === 60 && qz[2] === -30);

  // import: every export format reads back (ACB within its 8-bit rounding); CxF spectra and non-D50 data
  const sample = [{ name: 'Brand Red', lab: [45.6, 60.4, -30.4] }, { name: 'Grün & Blau', lab: [70.25, -40.5, 12.75] }];
  const back = Object.fromEntries(['cxf', 'versaworks', 'acb', 'epcc'].map((f) => {
    const out = RIP_EXPORTS[f].build({ library: 'House', colours: sample });
    return [f, readLibrary(typeof out === 'string' ? new TextEncoder().encode(out) : out, `x.${f}`)];
  }));
  const close = (lib, tol) => lib.colours.length === 2 && lib.colours.every((c, i) => c.name === sample[i].name && c.lab.every((v, k) => Math.abs(v - sample[i].lab[k]) <= tol));
  check('import reads CxF3, VersaWorks and Adobe Color Book files back (names, L*a*b*, library name – CxF has none, so the file name)', close(back.cxf, 0.005) && close(back.versaworks, 0.005) && close(back.acb, 0.51) && close(back.epcc, 0.051) && back.cxf.library === 'x' && back.versaworks.library === 'House' && back.acb.library === 'House' && back.acb.format === 'acb', JSON.stringify(back));
  const sp = Array.from({ length: 36 }, (_, i) => (0.2 + 0.5 * Math.exp(-(((380 + 10 * i - 600) / 60) ** 2))).toFixed(4)).join(' ');
  const cxfIn = `<?xml version="1.0"?><CxF xmlns="http://colorexchangeformat.com/CxF3-core"><Resources><ObjectCollection>
    <Object ObjectType="Standard" Name="Spectral" Id="a"><CreationDate>2026-01-01</CreationDate><ColorValues><ReflectanceSpectrum ColorSpecification="S" StartWL="380">${sp}</ReflectanceSpectrum></ColorValues></Object>
    <Object ObjectType="Standard" Name="D65 only" Id="b"><CreationDate>2026-01-01</CreationDate><ColorValues><ColorCIELab ColorSpecification="C65"><L>50</L><A>1</A><B>2</B></ColorCIELab></ColorValues></Object>
    <Object ObjectType="Standard" Name="Two Labs" Id="c"><CreationDate>2026-01-01</CreationDate><ColorValues><ColorCIELab ColorSpecification="C65"><L>1</L><A>1</A><B>1</B></ColorCIELab><ColorCIELab ColorSpecification="C50"><L>60</L><A>-5</A><B>7</B></ColorCIELab></ColorValues></Object>
  </ObjectCollection><ColorSpecificationCollection>
    <ColorSpecification Id="S"><TristimulusSpec><Illuminant>D50</Illuminant><Observer>2_Degree</Observer></TristimulusSpec><MeasurementSpec><MeasurementType>Spectrum_Reflectance</MeasurementType><WavelengthRange StartWL="380" Increment="10"/></MeasurementSpec></ColorSpecification>
    <ColorSpecification Id="C65"><TristimulusSpec><Illuminant>D65</Illuminant><Observer>10_Degree</Observer></TristimulusSpec></ColorSpecification>
    <ColorSpecification Id="C50"><TristimulusSpec><Illuminant>D50</Illuminant><Observer>2_Degree</Observer></TristimulusSpec></ColorSpecification>
  </ColorSpecificationCollection></Resources></CxF>`;
  const lib3 = readLibrary(new TextEncoder().encode(cxfIn), 'in.cxf');
  const want = spectrumToLab(Array.from({ length: 31 }, (_, i) => 0.2 + 0.5 * Math.exp(-(((400 + 10 * i - 600) / 60) ** 2))), 0, 2);
  const spectral = lib3.colours.find((c) => c.name === 'Spectral');
  check('CxF import: spectra -> Lab D50/2°, picks the D50 Lab of several, skips D65-only colours', spectral && spectral.lab.every((v, k) => Math.abs(v - want[k]) < 0.05) &&
    lib3.colours.find((c) => c.name === 'Two Labs')?.lab.join() === '60,-5,7' && lib3.skipped.join() === 'D65 only', JSON.stringify(lib3));
  let bad = '';
  try { readLibrary(new TextEncoder().encode('<html/>'), 'page.html'); } catch (e) { bad = e.message; }
  check('import rejects files that are not spot colour libraries', /not a CxF, Adobe Color Book, Edge Print or VersaWorks library/.test(bad), bad);

  // compact design: 8 patches (centre twice + ±step on each axis) – fewer patches per colour, still converges
  {
    const cp = designPatches('lab', [50, 10, 10], [5, 8, 8], 'compact');
    const target = spectrumToLab(printSpectrum([18, 62, 74, 6]), 0, 2);
    const printed = (x) => spectrumToLab(printSpectrum(prof.fromLab(x, 0)), 0, 2);
    let centre = [...target], step = [...MODES.lab.step0], round;
    for (round = 1; round <= 5; round++) {
      const res = analyseRound({ mode: 'lab', centre, step, patches: designPatches('lab', centre, step, 'compact').map((p) => ({ ...p, lab: printed(p.x) })) }, target);
      step = nextStep('lab', step, res.correction);
      centre = res.x;
      if (res.centreDE < 0.5) break;
    }
    const fin = deltaE2000(target, printed(centre));
    check(`compact design: ${cp.length} patches per colour, converges to ΔE00 ${fin.toFixed(2)} in ${Math.min(round, 5)} rounds`, cp.length === 8 && cp.filter((p) => p.offset.every((v) => v === 0)).length === 2 && fin < 1);
  }

  // layout: several colours on small custom media flow onto several pages – every patch once, on the page, no overlaps
  {
    const groups = [0, 1, 2].map((g) => ({ label: `Colour ${g + 1}`, target: [50, g * 10, -g * 10], kFixed: 0,
      patches: designPatches('lab', [50, g * 10, -g * 10], [5, 8, 8]).map((p) => ({ ...p, n: g * 16 + p.n })) }));
    const lay = sheetLayout({ mode: 'lab', groups, round: 2, media: [150, 120], patchMm: 15 });
    const boxes = lay.pages.flatMap((pg, i) => pg.boxes.map((b) => ({ ...b, page: i })));
    const inside = boxes.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.size <= lay.W && b.y + b.size <= lay.H);
    const overlap = boxes.some((a, i) => boxes.some((b, j) => j > i && a.page === b.page && a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size));
    const ns = boxes.map((b) => b.patch.n).sort((a, b) => a - b).join();
    check(`layout: 3 colours × 16 patches on 150 × 120 mm with 15 mm patches -> ${lay.pages.length} pages, every patch placed once, inside the page, no overlaps`,
      lay.pages.length > 1 && boxes.length === 48 && ns === Array.from({ length: 48 }, (_, i) => i + 1).join() && inside && !overlap);
    const multi = new TextDecoder('latin1').decode(buildSheetPdf({ mode: 'lab', groups, round: 2, media: [150, 120], patchMm: 15 }));
    check('multi-page PDF: one page object per layout page, all patches drawn', multi.includes(`/Count ${lay.pages.length} >>`) &&
      (multi.match(/\/Type \/Page /g) || []).length === lay.pages.length && (multi.match(/ sc\n/g) || []).length === 48);
    let small = '';
    try { sheetLayout({ mode: 'lab', groups, media: [40, 40], patchMm: 30 }); } catch (e) { small = e.message; }
    check('layout: media too small for the patch size is reported', /too small for 30 mm patches/.test(small), small);
  }

  // wide, short media: the text moves into a column beside the patches, so a 700 mm wide sheet needs little height
  {
    const g = { label: 'Purple', target: [26.4, 29.1, -31.9], kFixed: 0,
      patches: designPatches('spot', [26.4, 29.1, -31.9], [5, 8, 8]).map((p) => ({ ...p, name: patchSpotName('K3P9', 1, p.n) })) };
    const opts = { mode: 'spot', groups: [g], round: 1, media: [700, 80], patchMm: 20 };
    const lay = sheetLayout(opts);
    const mm = 72 / 25.4, margin = 5 * mm;
    const boxes = lay.pages[0].boxes, texts = lay.pages[0].texts;
    const textRight = Math.max(...texts.filter((t) => t.x === margin).map((t) => t.x + t.str.length * t.size * 0.5));
    const inside = boxes.every((b) => b.y >= margin - 1e-6 && b.y + b.size <= lay.H - margin + 1e-6 && b.x + b.size <= lay.W - margin + 1e-6);
    check(`700 × 80 mm: text in a side column, all 16 patches on one page beside it (text ends at ${(textRight / mm).toFixed(0)} mm, patches start at ${(Math.min(...boxes.map((b) => b.x)) / mm).toFixed(0)} mm)`,
      lay.side && lay.pages.length === 1 && boxes.length === 16 && inside && textRight <= Math.min(...boxes.map((b) => b.x)));
    const h = minSheetHeight(opts);
    const fitsAt = (hh) => { try { return sheetLayout({ ...opts, media: [700, hh] }).pages.length === 1; } catch { return false; } };
    check(`shortest one-page height at 700 mm wide: ${h} mm (fits, 1 mm less does not)`, h <= 80 && fitsAt(h) && !fitsAt(h - 1));
    check('portrait A4 keeps the text above the patches', !sheetLayout({ ...opts, media: [210, 297] }).side && minSheetHeight({ ...opts, media: [5, 5] }) === null);
    // the side column widens into the free width, so the sheet is about one row of patches tall
    const compact = { ...g, patches: designPatches('spot', g.target, [5, 8, 8], 'compact').map((p) => ({ ...p, name: patchSpotName('K3P9', 1, p.n) })) };
    const h8 = minSheetHeight({ ...opts, groups: [compact], patchMm: 10 }), h16 = minSheetHeight({ ...opts, patchMm: 10 });
    const lay41 = sheetLayout({ ...opts, media: [700, h] });
    check(`thin strips: 20 mm patches need ${h} mm, 10 mm patches ${h16} mm; 8 patches never need more than 16 (${h8} mm); page number in the side text`,
      h <= 45 && h16 <= 32 && h8 <= h16 && lay41.pages[0].texts.some((tx) => /page 1 of 1/.test(tx.str)) && !lay41.pages[0].texts.some((tx) => tx.str.includes('\u0001')));
  }

  // Edge Print .epcc: byte-identical to a collection exported by Edge Print (the user's "MoreData" test collection)
  {
    const want = 'fffe4500700073006f006e0045006400670065005000720069006e0074000d000a003200300030000d000a0030000d000a004d006f007200650044006100740061000d000a0034000d000a0030002c0032002c00480069002c0030002c0033002c00340032003b0030003b00360039000d000a0030002c0033002c0068006f0077002c0030002c0033002c00360039003b00340032003b0030000d000a0030002c0033002c006100720065002c0030002c0033002c00350030003b00360037003b00360037000d000a0030002c0033002c0079006f0075002c0030002c0033002c00380030003b00320032003b00330033000d000a00';
    const ep = RIP_EXPORTS.epcc.build({ library: 'MoreData', colours: [{ name: 'Hi', lab: [42, 0, 69] }, { name: 'how', lab: [69, 42, 0] }, { name: 'are', lab: [50, 67, 67] }, { name: 'you', lab: [80, 22, 33] }] });
    const epHex = [...ep].map((v) => v.toString(16).padStart(2, '0')).join('');
    check('Edge Print .epcc export is identical to a collection exported by Edge Print', epHex === want, epHex);
    const txt = 'EpsonEdgePrint\r\n200\r\n0\r\nMix\r\n3\r\n0,8,Red, Hot,0,3,45.5;60.1;30\r\n0,12,Subli Orange,1,4,15.4;54.5;71.1;11.8\r\n0,4,-0.5,0,3,10;-0.5;0\r\n';
    const bytes = new Uint8Array(2 + txt.length * 2);
    bytes[0] = 0xff; bytes[1] = 0xfe;
    for (let i = 0; i < txt.length; i++) bytes[2 + 2 * i] = txt.charCodeAt(i);
    const lib = readLibrary(bytes, 'mix.epcc');
    check('Edge Print import: L*a*b* entries (names may contain commas), CMYK entries skipped', lib.format === 'epcc' && lib.library === 'Mix' &&
      lib.colours.map((c) => c.name).join('|') === 'Red, Hot|-0.5' && lib.colours[0].lab.join() === '45.5,60.1,30' && lib.skipped.join() === 'Subli Orange', JSON.stringify(lib));
    const rt = readLibrary(RIP_EXPORTS.epcc.build({ library: 'House', colours: [{ name: 'Brand Red', lab: [45.62, 60.44, -30.38] }] }), 'x.epcc');
    check('Edge Print export reads back (one decimal)', rt.library === 'House' && rt.colours[0].name === 'Brand Red' && rt.colours[0].lab.join() === '45.6,60.4,-30.4', JSON.stringify(rt));
  }

  // textile colour differences vs. colour-science 0.4 (CMC l:c 2:1 and CIEDE2000 with kL = 2)
  {
    const ref = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 1.738736, 2.042460],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.420486, 1.254819],
      [[45, 60, 30], [48, 55, 25], 3.084312, 2.595942],
      [[30, 5, -40], [33, 8, -35], 3.899590, 4.640150],
      [[85, -10, 70], [80, -6, 75], 3.358596, 3.277158],
    ];
    const worst = Math.max(...ref.map(([a, b, cmc, de]) => Math.max(Math.abs(DE_FORMULAS.cmc21.fn(a, b) - cmc), Math.abs(DE_FORMULAS.de00t.fn(a, b) - de))));
    check(`ΔE CMC 2:1 and ΔE00 2:1:1 match colour-science (5 pairs, max |Δ| ${worst.toExponential(1)})`, worst < 1e-4);
    check('textile formulas forgive lightness: a pure ΔL counts half', Math.abs(DE_FORMULAS.de00t.fn([50, 10, 10], [52, 10, 10]) * 2 - DE_FORMULAS.de00.fn([50, 10, 10], [52, 10, 10])) < 1e-9 &&
      Math.abs(deltaECMC([50, 10, 10], [52, 10, 10], 2, 1) * 2 - deltaECMC([50, 10, 10], [52, 10, 10], 1, 1)) < 1e-9);
    // matching with a textile formula converges too (solver weights lightness by half)
    const target = spectrumToLab(printSpectrum([18, 62, 74, 6]), 0, 2);
    const printed = (x) => spectrumToLab(printSpectrum(prof.fromLab(x, 0)), 0, 2);
    let centre = [...target], step = [...MODES.lab.step0], res;
    for (let round = 1; round <= 5; round++) {
      res = analyseRound({ mode: 'lab', centre, step, patches: designPatches('lab', centre, step).map((p) => ({ ...p, lab: printed(p.x) })) }, target, 'cmc21');
      step = nextStep('lab', step, res.correction);
      centre = res.x;
      if (res.centreDE < 0.5) break;
    }
    const fin = DE_FORMULAS.cmc21.fn(target, printed(centre));
    check(`print match with ΔE CMC 2:1 converges (${fin.toFixed(2)})`, fin < 1);
  }

  // metamerism: identical spectra never drift; a different spectral shape with the same D50 colour does
  {
    const base = Array.from({ length: 31 }, (_, i) => 0.25 + 0.4 * Math.exp(-(((400 + 10 * i - 610) / 50) ** 2)));
    const same = metamerism(base, base);
    const other = base.map((v, i) => v * (1 + 0.25 * Math.sin(i / 2.5))); // spiky variant
    const m = metamerism(base, other);
    const keys = m.lights.map((l) => l.key).join();
    const d50 = DE_FORMULAS.de00.fn(spectrumToLab(base, 0, 2), spectrumToLab(other, 0, 2));
    check(`metamerism check: identical spectra 0 under every light; a different spectrum drifts (worst ${m.worst.key} ${m.worst.mi.toFixed(2)})`,
      same.worst.mi < 1e-9 && same.d50 < 1e-9 && keys === 'D65,A,F11,F2' && Math.abs(m.d50 - d50) < 1e-9 && m.worst.mi > 0.3);
  }

  // ICC: AToB (device -> Lab) vs. LittleCMS 2 (Pillow ImageCms, relative colorimetric, 8-bit Lab), and the gamut check
  {
    const lcms = {
      EpsonWideCMYK_Ver2: [[[0, 0, 0, 0], [255, 128, 128]], [[255, 0, 0, 0], [147, 74, 57]], [[0, 255, 0, 0], [123, 235, 122]], [[0, 0, 255, 0], [245, 118, 254]],
        [[0, 0, 0, 255], [34, 130, 130]], [[128, 64, 32, 16], [169, 122, 109]], [[200, 180, 40, 60], [79, 138, 95]]],
      USWebCoatedSWOP: [[[0, 0, 0, 0], [255, 128, 128]], [[255, 0, 0, 0], [162, 87, 80]], [[0, 255, 0, 0], [138, 204, 121]], [[0, 0, 255, 0], [242, 122, 218]],
        [[0, 0, 0, 255], [57, 129, 128]], [[128, 64, 32, 16], [164, 121, 110]], [[200, 180, 40, 60], [94, 134, 102]]],
    };
    let worst = 0, detail = '';
    for (const [name, rows] of Object.entries(lcms)) {
      const p = await loadProfile(name);
      for (const [dev, lab8] of rows) {
        const got = p.toLab(dev.map((v) => v / 255), 2);
        const want = [lab8[0] / 2.55, lab8[1] - 128, lab8[2] - 128];
        const d = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
        if (d > worst) { worst = d; detail = `${name} ${dev}: ${got.map((v) => v.toFixed(1))} vs ${want.map((v) => v.toFixed(1))}`; }
      }
    }
    check(`ICC AToB (CMYK -> Lab, 4-D interpolation) matches LittleCMS (14 colours, max ΔE76 ${worst.toFixed(2)})`, worst < 2, detail);
    const swop = await loadProfile('USWebCoatedSWOP');
    const inG = swop.gamut([60, 10, 20]);
    const outG = swop.gamut([50, 90, -100]);
    check(`gamut check: an in-gamut colour round-trips (ΔE00 ${inG.dE.toFixed(2)}), a vivid purple is far outside SWOP (ΔE00 ${outG.dE.toFixed(1)}, closest L ${outG.closest.map((v) => v.toFixed(0)).join('/')})`,
      inG.dE < 1.5 && outG.dE > 10 && outG.closest[1] < 90 && outG.closest[0] > 0);
    swop.validatePrinter();
    check('printer profile validation accepts an output profile', true);
  }

  // readings: mean + spread
  const avg = averageReadings([[50, 10, 10], [52, 10, 10], [51, 13, 7]]);
  check('averageReadings: mean Lab and spread', Math.abs(avg.lab[0] - 51) < 1e-9 && Math.abs(avg.lab[1] - 11) < 1e-9 && avg.spread > 1 && averageReadings([[1, 2, 3]]).spread === 0);
  // sRGB <-> Lab D50 round trip
  let rt = 0;
  for (const rgb of [[0, 0, 0], [255, 255, 255], [200, 30, 60], [12, 140, 220], [128, 128, 128]]) rt = Math.max(rt, ...labD50ToSrgb(srgbToLabD50(rgb)).rgb.map((v, i) => Math.abs(v - rgb[i])));
  check('srgbToLabD50 inverts labD50ToSrgb', rt === 0 && Math.abs(srgbToLabD50([255, 255, 255])[0] - 100) < 0.01, `max ${rt}`);

  // PNG sheet: valid chunks, sRGB + 300 dpi, exact patch colours
  const rgbPatches = designPatches('rgb', [200, 60, 40], [14, 14, 14]);
  const [{ png }] = await buildSheetPng({ mode: 'rgb', patches: rgbPatches, target: [55, 40, 50], round: 1, patchMm: 30 });
  const chunks = [];
  const pdv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let i = 8; i < png.length;) { const len = pdv.getUint32(i); chunks.push({ type: String.fromCharCode(...png.subarray(i + 4, i + 8)), data: png.subarray(i + 8, i + 8 + len) }); i += 12 + len; }
  const phys = chunks.find((c) => c.type === 'pHYs');
  const physOk = phys && new DataView(phys.data.buffer, phys.data.byteOffset).getUint32(0) === 11811 && phys.data[8] === 1;
  // (an <img> rather than createImageBitmap, which never resolves in headless Chrome with a virtual time budget)
  const bmp = new Image();
  bmp.src = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  await new Promise((res, rej) => { bmp.onload = res; bmp.onerror = () => rej(new Error('PNG did not decode')); });
  const cv = document.createElement('canvas'); cv.width = bmp.naturalWidth; cv.height = bmp.naturalHeight;
  const g2 = cv.getContext('2d'); g2.drawImage(bmp, 0, 0);
  // patch #1 centre: same geometry as the sheet (15 mm margin, 4 columns, 30 mm patches)
  // centre of patch #1, from the same layout the PNG was drawn from
  const k300 = 300 / 72;
  const lay1 = sheetLayout({ mode: 'rgb', patches: rgbPatches, target: [55, 40, 50], round: 1, patchMm: 30 });
  const b1 = lay1.pages[0].boxes[0];
  const px = g2.getImageData(Math.round((b1.x + b1.size / 2) * k300), Math.round((lay1.H - b1.y - b1.size / 2) * k300), 1, 1).data;
  check('PNG sheet: A4 at 300 dpi, sRGB-tagged, chunks valid', png[1] === 0x50 && chunks[0].type === 'IHDR' && chunks[1].type === 'sRGB' && physOk && bmp.naturalWidth === 2480 && bmp.naturalHeight === 3508 && !chunks.some((c) => c.type === 'iCCP'), chunks.map((c) => c.type).join(','));
  check('PNG sheet: patch pixels carry the exact RGB values', px[0] === rgbPatches[0].x[0] && px[1] === rgbPatches[0].x[1] && px[2] === rgbPatches[0].x[2], `${[...px]} vs ${rgbPatches[0].x}`);
  check('Lab sheet uses a D50 Lab colour space on Letter paper', /\/Lab << \/WhitePoint \[0\.9642 1 0\.8249\]/.test(labPdf) && (labPdf.match(/ sc\n/g) || []).length === 16 && /MediaBox \[0 0 612\.00 792\.00\]/.test(labPdf));
}

// ---- 4. end-to-end session against the simulator
async function e2e() {
  const mock = new MockTransport();
  const s = new SD10Session(mock);
  const tx = [];
  s.addEventListener('log', (e) => tx.push(e.detail));
  await s.connect();
  check('e2e connect + handshake', s.controlled && tx.some((l) => l.dir === 'tx' && l.bytes[2] === CMD.CONTROL));
  check('e2e every reply acknowledged', tx.filter((l) => l.dir === 'rx' && l.bytes.length > 1).length === tx.filter((l) => l.dir === 'tx' && l.bytes.length === 1 && l.bytes[0] === 0xff).length);
  const info = await s.getInfo();
  check('e2e info', info.firmware === '1.04.0' && info.serial === 'X3K0012345', JSON.stringify(info));
  const before = await s.getSettings();
  await s.applySettings({ ...before, name: 'Bench', buzzer: 0, language: 3 }, before);
  const after = await s.getSettings();
  check('e2e settings write/read', after.name === 'Bench' && after.buzzer === 0 && after.language === 3, JSON.stringify(after));

  let failed = false;
  try { await s.measure({ method: METHOD.SPOT, ...base }); } catch { failed = true; }
  check('e2e measure before calibration fails', failed);
  mock.setShutter(true);
  await new Promise((r) => setTimeout(r, 50));
  const cal = await s.calibrate();
  check('e2e calibrate', cal.calibrationStatus === 2);
  mock.setShutter(false);
  await new Promise((r) => setTimeout(r, 50));
  const [rec] = await s.measure({ method: METHOD.SPOT, ...base });
  const lab = spectrumToLab(rec.spectrum, 0, 2);
  check('e2e spot measurement', rec.ok && rec.spectrum.length === 31 && lab[1] > 20, `Lab ${lab.map((v) => v.toFixed(1))}`);
  const strip = await s.measure({ method: METHOD.SCAN, ...base, saveResult: false, patchNum: 6, patchBorder: false, lineNo: 1, labs: [] });
  check('e2e line scan returns 6 patches', strip.length === 6);
  await s.notifyResult(true);

  await s.setGroups([paint]);
  const groups = await s.getGroups();
  check('e2e palette write/read', groups.length === 1 && groups[0].name === 'Paint' && groups[0].slot === 1);
  await s.setGroups([{ control: 1, slot: 1 }]);
  check('e2e palette delete', (await s.getGroups()).length === 0);

  const hist = await s.readHistory(0);
  check('e2e device history sync', hist.length === 1 && hist[0].identifier === rec.identifier, `got ${hist.length}`);
  check('e2e incremental history', (await s.readHistory(rec.identifier)).length === 0);
  const log = await s.readDeviceLog();
  check('e2e device log', log.length === 96);

  let pressed = false;
  s.addEventListener('device-event', (e) => { if (e.detail.code === 0xc2) pressed = true; });
  mock.pressButton();
  await new Promise((r) => setTimeout(r, 50));
  check('e2e device button event', pressed);
  await s.disconnect();
  check('e2e release control on disconnect', tx.some((l) => l.dir === 'tx' && l.bytes[2] === CMD.CONTROL && l.bytes[10] === 2));
}

async function spaceCheck() {
  const { CHART_SIZES, designChart, driftOf, invert, keepFrom, learn, newSpace, pointX, readSpaceFile, removeSession, spaceFromCgats, spaceStats, spaceToCgats, spaceToJson } = await import('../js/colorspace.js');
  const { designPatches } = await import('../js/match.js');
  const { printSpectrum } = await import('../js/printer-sim.js');
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const noise = (lab, s = 0.3) => lab.map((v) => v + (rnd() - 0.5) * 2 * s);
  // a printer that compresses chroma towards its gamut edge (C* 48–76 depending on hue), lifts the blacks and turns hues
  const printer = ([L, a, b]) => {
    const C = Math.hypot(a, b), h = Math.atan2(b, a), Cmax = 62 + 14 * Math.cos(h - 1);
    const Cp = Cmax * Math.tanh(C / Cmax), hp = h + 0.1 * Math.sin(2 * h);
    return [Math.min(96, 6 + 0.9 * L), Cp * Math.cos(hp), Cp * Math.sin(hp)];
  };

  // charts
  const chart = designChart('spot', 400, 3);
  const keys = new Set(chart.map((p) => p.x.join()));
  const mixed = chart.slice(1, 40).filter((p, i) => Math.abs(p.x[0] - chart[i].x[0]) > 20).length > 5;
  check('colour space chart: distinct L*a*b* patches in range, a neutral ramp, reproducible from its seed, mixed order on the sheet',
    chart.length === 400 && keys.size === 400 && chart.every((p, i) => p.n === i + 1 && p.x[0] >= 3 && p.x[0] <= 98 && Math.abs(p.x[1]) <= 127 && Math.abs(p.x[2]) <= 127) &&
    chart.filter((p) => p.x[1] === 0 && p.x[2] === 0).length >= 20 && JSON.stringify(designChart('spot', 400, 3)) === JSON.stringify(chart) &&
    JSON.stringify(designChart('spot', 400, 4)) !== JSON.stringify(chart) && mixed && Object.values(CHART_SIZES).every((s) => designChart('lab', s.n, 1).length === s.n));
  const cm = designChart('cmyk', 200, 1), rg = designChart('rgb', 200, 1);
  check('CMYK and RGB charts: K per patch, device corners, the whole range',
    cm.length === 200 && cm.every((p) => p.x.length === 3 && p.k >= 0 && p.k <= 100 && p.x.every((v) => v >= 0 && v <= 100)) && cm.some((p) => p.k === 100) &&
    rg.length === 200 && rg.every((p) => p.x.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) && rg.some((p) => p.x.join() === '255,255,255'));

  // a space from a 400-patch chart
  const T0 = Date.parse('2026-01-01T00:00:00Z'), DAY = 864e5;
  const space = newSpace({ name: 'Test printer', mode: 'spot', now: T0 });
  for (const p of chart) learn(space, { session: 'chart:1', kind: 'chart', label: 'Chart 1', n: p.n, x: p.x, lab: noise(printer(p.x)), now: T0 });
  const st = spaceStats(space);
  check(`colour space accuracy (each patch predicted from the others): median ΔE00 ${st.accuracy.median.toFixed(2)}, 90 % within ${st.accuracy.p90.toFixed(2)}`,
    st.points === 400 && st.accuracy.median < 1.5 && st.accuracy.p90 < 3 && st.spacing > 0);
  const inside = [[52, 28, -22], [70, -30, 25], [35, 10, 30], [85, 2, 40]];
  const errs = inside.map((t) => { const r = invert(space, t); return { got: deltaE2000(t, printer(r.x)), pred: r.predictedDeltaE }; });
  check(`colour space prediction: in-gamut references print within ΔE00 ${errs.map((e) => e.got.toFixed(2)).join(', ')} straight away`, errs.every((e) => e.got < 1.5 && e.pred < 1));
  const outT = [50, 90, 10];
  const ro = invert(space, outT);
  let bestBrute = Infinity;
  for (let L = 30; L <= 80; L += 2) for (let a = -120; a <= 120; a += 4) for (let b = -60; b <= 60; b += 4) bestBrute = Math.min(bestBrute, deltaE2000(outT, printer([L, a, b])));
  const outGot = deltaE2000(outT, printer(ro.x));
  check(`out of gamut: predicted ΔE00 ${ro.predictedDeltaE.toFixed(2)}, the values print ${outGot.toFixed(2)}, the best this printer can do is ${bestBrute.toFixed(2)}`,
    ro.predictedDeltaE > 2 && Math.abs(outGot - ro.predictedDeltaE) < 1.5 && outGot < bestBrute + 1.5);

  // learning from test sheets
  const t = [44, 38, -34];
  const before = deltaE2000(t, printer(invert(space, t).x));
  for (let round = 1; round <= 2; round++) {
    const r0 = invert(space, t);
    for (const p of designPatches('spot', r0.x, [3, 4, 4])) learn(space, { session: `sheet:R${round}`, kind: 'sheet', label: `Sheet ${round}`, n: p.n, x: p.x, lab: noise(printer(p.x)), now: T0 + round * DAY });
  }
  const after = deltaE2000(t, printer(invert(space, t).x));
  const d1 = driftOf(space, 'sheet:R1');
  check(`learning: two test sheets near a reference refine the space there (prints ΔE00 ${before.toFixed(2)} -> ${after.toFixed(2)}) and match its prediction (no drift, median ${d1?.median.toFixed(2)})`,
    after < 1 && after <= Math.max(before, 0.5) + 0.05 && d1 && !d1.drift);

  // drift: the printer changed (darker, duller, yellower)
  const changed = (x) => { const [L, a, b] = printer(x); return [L - 4, a * 0.9, b * 0.9 + 3]; };
  const check24 = designChart('spot', 24, 9);
  for (const p of check24) learn(space, { session: 'check:1', kind: 'check', label: 'Check 1', n: p.n, x: p.x, lab: noise(changed(p.x)), now: T0 + 10 * DAY });
  const dr = driftOf(space, 'check:1');
  const n0 = space.points.length;
  learn(space, { session: 'check:1', kind: 'check', label: 'Check 1', n: 1, x: check24[0].x, lab: printer(check24[0].x), now: T0 + 10 * DAY });
  const replaced = space.points.length === n0;
  removeSession(space, 'check:1');
  check(`drift: a check chart from a changed printer is flagged (median ΔE00 ${dr?.median.toFixed(2)} > ${dr?.limit.toFixed(2)}); a re-measured patch replaces its point; removing a session removes its patches`,
    dr?.drift && replaced && space.points.length === n0 - 24 && !space.sessions.some((s) => s.id === 'check:1'));

  // files
  const json = readSpaceFile(new TextEncoder().encode(spaceToJson(space)), 'Test printer.json');
  const same = json.id === space.id && json.name === space.name && json.mode === 'spot' && json.points.length === space.points.length && json.sessions.length === 3 &&
    invert(json, t).x.join() === invert(space, t).x.join();
  const removed = keepFrom(json, T0 + DAY);
  check('colour space JSON file reads back exactly; "keep only newer data" drops the older sessions', same && removed === 1 && json.points.every((p) => p.s.startsWith('sheet:')));
  const cg = spaceToCgats(space, new Date(T0));
  const cgBack = spaceFromCgats(cg, 'x.txt');
  check('CGATS export: declared requested-L*a*b* fields, reads back (sheet type, values, name)',
    /^CGATS\.17\r\n/.test(cg) && /KEYWORD\t"REQ_L"/.test(cg) && /\r\nSAMPLE_ID\tREQ_L\tREQ_A\tREQ_B\tLAB_L\tLAB_A\tLAB_B\r\n/.test(cg) && cgBack.mode === 'spot' && cgBack.name === 'Test printer' &&
    cgBack.points.length === space.points.length && cgBack.points.every((p, i) => p.x.concat(p.lab).every((v, k) => Math.abs(v - space.points[i].x.concat(space.points[i].lab)[k]) < 0.006)));

  // CMYK: K is a fourth input; standard CMYK_ fields; ArgyllCMS .ti3 RGB in 0–100
  const cmykPrint = (x) => spectrumToLab(printSpectrum(x), 0, 2);
  const cs = newSpace({ name: 'CMYK printer', mode: 'cmyk', now: T0 });
  for (const p of designChart('cmyk', 400, 2)) learn(cs, { session: 'chart', kind: 'chart', label: 'Chart', n: p.n, x: pointX('cmyk', p.x, p.k), lab: noise(cmykPrint([...p.x, p.k]), 0.2), now: T0 });
  const ct = cmykPrint([35, 55, 15, 10]);
  const cFree = invert(cs, ct), cK = invert(cs, ct, { kFixed: 10 });
  const eFree = deltaE2000(ct, cmykPrint([...cFree.x, cFree.k])), eK = deltaE2000(ct, cmykPrint([...cK.x, 10]));
  const cmykCg = spaceFromCgats(spaceToCgats(cs), 'c.txt');
  check(`CMYK space: references print within ΔE00 ${eFree.toFixed(2)} (K chosen) / ${eK.toFixed(2)} (K 10 kept); CGATS CMYK_ fields`,
    eFree < 2 && eK < 2 && cK.k === 10 && cmykCg.mode === 'cmyk' && cmykCg.points[0].x.length === 4);
  const ti3 = 'CTI3\nDESCRIPTOR "Argyll chart"\nNUMBER_OF_FIELDS 7\nBEGIN_DATA_FORMAT\nSAMPLE_ID RGB_R RGB_G RGB_B LAB_L LAB_A LAB_B\nEND_DATA_FORMAT\nNUMBER_OF_SETS 2\nBEGIN_DATA\n1 100 100 100 95.1 0.2 -1\n2 0 50 100 40 10 -50\nEND_DATA\n';
  const ti = spaceFromCgats(ti3, 'chart.ti3');
  let bad = '';
  try { readSpaceFile(new TextEncoder().encode('hello'), 'notes.txt'); } catch (e) { bad = e.message; }
  check('CGATS import: charts measured with other software (ArgyllCMS .ti3 RGB 0–100 -> 0–255); other files are rejected',
    ti.mode === 'rgb' && ti.name === 'Argyll chart' && ti.points[0].x.join() === '255,255,255' && ti.points[1].x.join() === '0,128,255' && ti.points[1].lab.join() === '40,10,-50' && /not a CGATS/.test(bad), bad);
}

function report() {
  const pass = results.filter((r) => r.ok).length;
  const out = document.getElementById('out');
  out.textContent = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? '   -> ' + r.detail : ''}`).join('\n') + `\n\n${pass}/${results.length} passed`;
  document.title = `${pass === results.length ? 'ALL PASS' : 'FAILURES'} ${pass}/${results.length}`;
  document.body.dataset.done = '1';
}

cmykCheck().catch((e) => check('CMYK check (exception)', false, e.stack || e.message))
  .then(() => iccV4Check()).catch((e) => check('ICC v4 check (exception)', false, e.stack || e.message))
  .then(() => matchCheck()).catch((e) => check('print match (exception)', false, e.stack || e.message))
  .then(() => spaceCheck()).catch((e) => check('colour space (exception)', false, e.stack || e.message))
  .then(() => e2e()).catch((e) => check('e2e (exception)', false, e.stack || e.message)).finally(report);
