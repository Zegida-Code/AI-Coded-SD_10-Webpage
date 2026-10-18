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
  const { designPatches, fitModel, analyseRound, nextStep, buildSheetPdf, buildSheetPng, averageReadings, patchSpotName, MODES } = await import('../js/match.js');
  const { RIP_EXPORTS } = await import('../js/rip-export.js');
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

  // readings: mean + spread
  const avg = averageReadings([[50, 10, 10], [52, 10, 10], [51, 13, 7]]);
  check('averageReadings: mean Lab and spread', Math.abs(avg.lab[0] - 51) < 1e-9 && Math.abs(avg.lab[1] - 11) < 1e-9 && avg.spread > 1 && averageReadings([[1, 2, 3]]).spread === 0);
  // sRGB <-> Lab D50 round trip
  let rt = 0;
  for (const rgb of [[0, 0, 0], [255, 255, 255], [200, 30, 60], [12, 140, 220], [128, 128, 128]]) rt = Math.max(rt, ...labD50ToSrgb(srgbToLabD50(rgb)).rgb.map((v, i) => Math.abs(v - rgb[i])));
  check('srgbToLabD50 inverts labD50ToSrgb', rt === 0 && Math.abs(srgbToLabD50([255, 255, 255])[0] - 100) < 0.01, `max ${rt}`);

  // PNG sheet: valid chunks, sRGB + 300 dpi, exact patch colours
  const rgbPatches = designPatches('rgb', [200, 60, 40], [14, 14, 14]);
  const png = await buildSheetPng({ mode: 'rgb', patches: rgbPatches, target: [55, 40, 50], round: 1 });
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
  const k300 = 300 / 72, mm = 72 / 25.4, cell = (595.28 - 30 * mm) / 4, size = Math.min(30 * mm, cell - 6 * mm);
  const px = g2.getImageData(Math.round((15 * mm + (cell - size) / 2 + size / 2) * k300), Math.round((15 * mm + 32 + 13 + 11 + 11 + 18 + size / 2) * k300), 1, 1).data;
  check('PNG sheet: A4 at 300 dpi, sRGB-tagged, chunks valid', png[1] === 0x50 && chunks[0].type === 'IHDR' && chunks[1].type === 'sRGB' && physOk && bmp.naturalWidth === 2480 && bmp.naturalHeight === 3508 && !chunks.some((c) => c.type === 'iCCP'), chunks.map((c) => c.type).join(','));
  check('PNG sheet: patch pixels carry the exact RGB values', px[0] === rgbPatches[0].x[0] && px[1] === rgbPatches[0].x[1] && px[2] === rgbPatches[0].x[2], `${[...px]} vs ${rgbPatches[0].x}`);
  check('Lab sheet uses a D50 Lab colour space on Letter paper', /\/Lab << \/WhitePoint \[0\.9642 1 0\.8249\]/.test(labPdf) && (labPdf.match(/ sc\n/g) || []).length === 16 && /MediaBox \[0 0 612 792\]/.test(labPdf));
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
  .then(() => e2e()).catch((e) => check('e2e (exception)', false, e.stack || e.message)).finally(report);
