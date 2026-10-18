// Self-checks for the SD-10 web app. Open test/index.html (served over http) or run headless.
import { build, hex, parseStatus, parseRecords, parseGroups, payloadOf, CMD, METHOD } from '../js/protocol.js';
import { spectrumToLab, deltaE2000 } from '../js/color.js';
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

e2e().catch((e) => check('e2e (exception)', false, e.stack || e.message)).finally(report);
