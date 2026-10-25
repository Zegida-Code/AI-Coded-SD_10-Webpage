// Epson SD-10 BLE protocol: frame builders and parsers.
// Mirrors EPSPM::CommandBuilder / ResponseParser from libmunsell-lib.so (see ../../PROTOCOL.md).

export const UUID = {
  ADVERTISED_SERVICE: '4d756e73-656c-6cde-92b1-3b0cb21f4bf7',
  SERVICE: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  TX: '49535343-8841-43f4-a8d4-ecbe34729bb3', // write
  RX: '49535343-1e4d-4bd9-ba61-23c647249616', // notify
};

export const OP = { SIZE: 0x10, GET: 0x11, EXEC: 0x12, SET: 0x13, REPLY: 0x01, SIZE_REPLY: 0x00 };

export const CMD = {
  MEASURE: 0x01, FW_VERSION: 0x03, RESULT_CACHE: 0x05, NVRAM: 0x07, DEVICE_NAME: 0x08, STATUS: 0x0b,
  CALIBRATE: 0x0c, DATETIME: 0x0d, SERIAL: 0x0e, BUZZER: 0x0f, PANEL_DIRECTION: 0x10, HISTORY_CHECK: 0x13,
  HISTORY: 0x14, SET_GROUP: 0x15, GROUP: 0x16, CONTROL: 0x19, SET_MODE: 0x1a, GET_MODE: 0x1b,
  NOTIFY_RESULT: 0x1c, STANDALONE: 0x1d, GROUP_DONE: 0x1e, AUTO_POWER_OFF: 0x1f, LANGUAGE: 0x20,
};

export const CMD_NAME = Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k]));

export const ACK_OK = 0xff;
export const ACK_NG = 0xfe;

export const EVENT = { FINISH_MEASURING: 0xc1, BUTTON: 0xc2, FINISH_CALIBRATION: 0xc3, STATUS_CHANGED: 0xc4, DISCONNECTED: 0xa0, OK: 0xff, NG: 0xfe };
export const EVENT_NAME = {
  0xc1: 'FINISH_MEASURING', 0xc2: 'MEASURE_BUTTON_PUSH', 0xc3: 'FINISH_CALIBRATION',
  0xc4: 'CHANGED_STATUS', 0xa0: 'DISCONNECTED', 0xff: 'OK', 0xfe: 'NG',
};

export const HEADER_LEN = 8;
export const RECORD_LEN = 144;
export const HISTORY_RECORD_LEN = 143;
export const WAVELENGTHS = Array.from({ length: 31 }, (_, i) => 400 + 10 * i);

// API measurement methods (EPSPM_METHOD) -> wire value of TLV tag 01.
export const METHOD = { SPOT: 1, SPOT_COMPARISON: 2, SPOT_GROUP: 3, SCAN: 4, SCAN_GROUP: 5, CALIBRATION: 6, SCAN_COMPARISON: 7 };
const METHOD_WIRE = { 1: 1, 2: 2, 3: 2, 4: 5, 5: 3, 6: 4, 7: 3 };
const METHOD_TAGS = {
  1: [1, 2, 4, 5, 6], 2: [1, 2, 4, 5, 6, 7, 8], 3: [1, 2, 9, 11], 4: [1, 2, 4, 5, 6, 10, 13, 14, 15],
  5: [1, 2, 9, 10, 11], 6: [1], 7: [1, 2, 4, 5, 6, 7, 8, 10, 13, 14, 15],
};

export const LIGHT_SOURCES = { D50: 0, D65: 1, A: 2, F1: 17, F2: 18, F3: 19, F7: 23, F8: 24, F9: 25, F10: 26, F11: 27, F12: 28 };
export const LIGHT_SOURCE_NAME = Object.fromEntries(Object.entries(LIGHT_SOURCES).map(([k, v]) => [v, k]));
export const DIFF_FORMULAS = { 0: 'ΔE00', 1: 'ΔE94 (graphic arts)', 2: 'ΔE94 (textile)', 3: 'ΔE76' };
export const BUZZER = { 0: 'Off', 1: 'Small', 2: 'Big' };
export const AUTO_POWER_OFF = { 0: 'Disabled', 1: '10 min', 2: '30 min', 3: '60 min' };
export const PANEL_DIRECTION = { 0: '0°', 1: '90°', 2: '180°', 3: '270°' };
export const LANGUAGES = { 0: 'Japanese', 1: 'English', 2: 'French', 3: 'German', 4: 'Italian', 5: 'Spanish', 6: 'Portuguese', 8: 'Turkish', 9: 'Dutch', 10: 'Russian', 11: 'Chinese (Simplified)', 12: 'Chinese (Traditional)', 13: 'Korean' };

export const STATUS_ERROR_BITS = {
  2: 'FATAL: temperature high', 3: 'FATAL: temperature low', 4: 'FATAL: battery not responding', 5: 'FATAL: battery connection',
  6: 'FATAL: battery timeout', 7: 'FATAL: battery update error', 8: 'FATAL: battery full error', 9: 'FATAL: LED driver',
  10: 'FATAL: LED failure', 11: 'FATAL: etalon device failure', 12: 'FATAL: etalon thermal failure', 13: 'FATAL: LED thermal failure',
  14: 'ALERT: MCU discharge temperature low', 15: 'ALERT: battery discharge temperature low', 16: 'ALERT: MCU discharge temperature high',
  17: 'ALERT: battery discharge temperature high', 18: 'ALERT: etalon temperature high', 19: 'ALERT: etalon temperature low',
  20: 'ALERT: LED temperature high', 21: 'ALERT: LED temperature low', 23: 'ALERT: serial flash error', 24: 'ALERT: LED driver error',
  25: 'ALERT: thermal sensor error', 26: 'ALERT: BLE error', 27: 'ALERT: BCCC error', 28: 'ALERT: RTC error',
  30: 'ALERT: firmware update temperature high', 32: 'ALERT: watchdog error', 33: 'ALERT: firmware update temperature low',
  34: 'ALERT: calibration error', 35: 'INFO: battery empty', 36: 'INFO: battery charge (high) cancelled', 37: 'INFO: battery charge (high) controlled',
  38: 'INFO: battery charge (low) cancelled', 39: 'INFO: battery charge (low) controlled', 40: 'INFO: battery discharge (high) cancelled',
  41: 'INFO: battery discharge (high) controlled', 42: 'INFO: battery discharge (low) cancelled', 43: 'INFO: battery discharge (low) controlled',
  44: 'INFO: battery low', 47: 'INFO: shutter open (power-on + measurement)', 48: 'INFO: shutter open at power-on', 49: 'INFO: shutter open during measurement',
  50: 'INFO: scan failed – patch too short', 51: 'INFO: scan failed – timeout', 52: 'INFO: scan failed – moved too fast',
  54: 'INFO: color history full', 55: 'INFO: group history full', 57: 'INFO: other measurement error',
};

// ---------------------------------------------------------------- helpers
export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

function u32le(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }
function f32le(v) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return [...b]; }

export function frame(cmd, op, payload = []) {
  const p = Array.from(payload);
  return new Uint8Array([0x00, 0x43, cmd, op, ...u32le(p.length), ...p]);
}

function tlv(tag, bytes) {
  if (bytes.length > 255) throw new RangeError(`TLV ${tag} too long`);
  return [tag, bytes.length, ...bytes];
}

const range = (v, lo, hi, what) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${what} must be an integer ${lo}..${hi} (got ${v})`);
  return v;
};

// ---------------------------------------------------------------- command builders
export const build = {
  getStatus: () => frame(CMD.STATUS, OP.GET, [0]),
  calibrate: () => frame(CMD.CALIBRATE, OP.EXEC, [1]),
  measure: () => frame(CMD.MEASURE, OP.EXEC, [1]),
  resultSize: () => frame(CMD.RESULT_CACHE, OP.SIZE, [0]),
  result: () => frame(CMD.RESULT_CACHE, OP.GET, [0]),
  nvramSize: () => frame(CMD.NVRAM, OP.SIZE, [1]),
  nvram: () => frame(CMD.NVRAM, OP.GET, [1]),
  groupSize: () => frame(CMD.GROUP, OP.SIZE, [1]),
  group: () => frame(CMD.GROUP, OP.GET, [1]),
  standAlone: () => frame(CMD.STANDALONE, OP.EXEC, [1]),
  groupDone: () => frame(CMD.GROUP_DONE, OP.SET, [1]),
  getMode: () => frame(CMD.GET_MODE, OP.GET, [1]),
  notifyResult: (ok) => frame(CMD.NOTIFY_RESULT, OP.SET, [ok ? 1 : 2]),
  getInt: (cmd) => frame(cmd, OP.GET, [1]),
  setInt: (cmd, value) => frame(cmd, OP.SET, [range(value, 0, 255, 'value')]),
  getString: (cmd) => frame(cmd, OP.GET, [1]),

  setDeviceName(name) {
    const b = new TextEncoder().encode(name);
    if (b.length > 16) throw new RangeError('Device name is limited to 16 bytes');
    const p = new Uint8Array(16); p.set(b);
    return frame(CMD.DEVICE_NAME, OP.SET, p);
  },

  setDatetime(d = new Date()) {
    return frame(CMD.DATETIME, OP.SET, [d.getFullYear() % 100, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]);
  },

  /** acquire=true -> ControlDevice, false -> FinishControlDevice. appId: 16 bytes. */
  control(acquire, appId, clientType = 1) {
    if (appId.length !== 16) throw new RangeError('appId must be 16 bytes');
    return frame(CMD.CONTROL, OP.EXEC, [...tlv(1, [acquire ? 1 : 2]), ...tlv(2, [clientType]), ...tlv(3, appId)]);
  },

  /**
   * SetColorMeasurementMode. s = { method, saveResult, mFactor, lightSource, viewingAngle, colorDiffFormula,
   * threshold, groupNo, patchNum, startPatchNo, patchBorder, labs:[[L,a,b],..], lineNo }
   */
  setMode(s) {
    const method = s.method;
    const tags = METHOD_TAGS[method];
    if (!tags) throw new RangeError(`unsupported method ${method}`);
    const out = [];
    for (const t of tags) {
      switch (t) {
        case 1: out.push(...tlv(1, [METHOD_WIRE[method]])); break;
        case 2: out.push(...tlv(2, [s.saveResult ? 2 : 1])); break;
        case 4: out.push(...tlv(4, [range(s.mFactor ?? 0, 0, 2, 'mFactor')])); break;
        case 5:
          if (!(s.lightSource in LIGHT_SOURCE_NAME)) throw new RangeError('invalid light source');
          out.push(...tlv(5, [s.lightSource])); break;
        case 6:
          if (s.viewingAngle !== 2 && s.viewingAngle !== 10) throw new RangeError('viewing angle must be 2 or 10');
          out.push(...tlv(6, [s.viewingAngle])); break;
        case 7: out.push(...tlv(7, [range(s.colorDiffFormula ?? 0, 0, 3, 'colorDiffFormula')])); break;
        case 8: {
          const thr = s.threshold ?? 0;
          if (!(thr >= 0 && thr <= 20)) throw new RangeError('threshold must be 0..20');
          out.push(...tlv(8, f32le(thr * 10))); break;
        }
        case 9: out.push(...tlv(9, [range(s.groupNo, 1, 4, 'groupNo')])); break;
        case 10: out.push(...tlv(10, [range(s.patchNum, 1, 18, 'patchNum')])); break;
        case 11: out.push(...tlv(11, [range(s.startPatchNo, 1, 80, 'startPatchNo')])); break;
        case 13: out.push(...tlv(13, [s.patchBorder ? 1 : 0])); break;
        case 14: {
          const labs = s.labs ?? [];
          const bytes = [];
          for (let i = 0; i < s.patchNum; i++) {
            const [L, a, b] = labs[i] ?? [0, 0, 0];
            bytes.push(...f32le(L * 100), ...f32le(a * 100), ...f32le(b * 100));
          }
          out.push(...tlv(14, bytes)); break;
        }
        case 15: {
          const n = range(s.lineNo, 1, 65535, 'lineNo');
          out.push(...tlv(15, [n & 0xff, n >> 8])); break;
        }
      }
    }
    return frame(CMD.SET_MODE, OP.SET, out);
  },

  /** groups: [{slot, control:2, hardwareId, name, patchBorder, mFactor, lightSource, viewingAngle, colorDiffFormula, threshold, labs}] or {slot, control:1} */
  setGroups(groups) {
    const out = [];
    for (const g of groups) out.push(...encodeGroup(g));
    return frame(CMD.SET_GROUP, OP.SET, out);
  },

  historyCheck: (lastIdentifier) => frame(CMD.HISTORY_CHECK, OP.GET, [1, ...u32le(lastIdentifier >>> 0)]),
  history: (offset, count) => frame(CMD.HISTORY, OP.EXEC, [1, ...u32le(offset), ...u32le(count)]),
  historyDelete: (a, b) => frame(CMD.HISTORY, OP.EXEC, [2, ...u32le(a), ...u32le(b)]),
};

export function encodeGroup(g) {
  range(g.slot, 1, 4, 'slot');
  if (g.control === 1) return [1, g.slot];
  const name = new TextEncoder().encode(g.name ?? '');
  if (name.length > 42) throw new RangeError('group name is limited to 42 bytes');
  const labs = g.labs ?? [];
  if (labs.length > 80) throw new RangeError('a device palette holds at most 80 colors');
  const nameBytes = Array.from({ length: 42 }, (_, i) => (name[i] ?? 0) ^ 0x5a);
  const out = [2, g.slot, g.hardwareId & 0xff, (g.hardwareId >> 8) & 0xff, name.length, ...nameBytes,
    g.patchBorder ? 1 : 0, labs.length, g.mFactor ?? 0, g.lightSource ?? 0, g.viewingAngle ?? 2, g.colorDiffFormula ?? 0,
    ...f32le((g.threshold ?? 0) * 10)];
  for (const [L, a, b] of labs) out.push(...f32le(L * 100), ...f32le(a * 100), ...f32le(b * 100));
  return out;
}

// ---------------------------------------------------------------- reply parsing
export class ProtocolError extends Error {}

/** Validate a reply frame and return its payload. */
export function payloadOf(reply, cmd, op = OP.REPLY) {
  if (reply.length < HEADER_LEN || reply[0] !== 0x00 || reply[1] !== 0x43) throw new ProtocolError('bad reply header');
  if (reply[2] !== cmd) throw new ProtocolError(`reply for cmd ${reply[2].toString(16)}, expected ${cmd.toString(16)}`);
  if (reply[3] !== op) throw new ProtocolError(`reply op ${reply[3]}, expected ${op}`);
  const len = new DataView(reply.buffer, reply.byteOffset).getUint32(4, true);
  if (reply.length < HEADER_LEN + len) throw new ProtocolError('truncated reply');
  return reply.subarray(HEADER_LEN, HEADER_LEN + len);
}

export function parseAscii(payload) {
  const end = payload.indexOf(0);
  return new TextDecoder().decode(end < 0 ? payload : payload.subarray(0, end)).trim();
}

/** Parse a "status string" reply ("OK" / "NG" / "TO"). */
export function parseStatusString(reply, cmd) {
  return parseAscii(payloadOf(reply, cmd));
}

export function parseStatus(reply) {
  const p = payloadOf(reply, CMD.STATUS);
  const s = { deviceStatus: 0, errorStatus: 0n, calibrationStatus: 0, battery: 0, shutterStatus: 0, chargingStatus: 0 };
  for (let i = 0; i + 2 <= p.length;) {
    const tag = p[i], len = p[i + 1];
    const v = p.subarray(i + 2, i + 2 + len);
    let n = 0n;
    for (const b of v) n = (n << 8n) | BigInt(b); // big-endian
    switch (tag) {
      case 1: s.deviceStatus = v[0]; break;
      case 2: s.errorStatus = n; break;
      case 3: s.calibrationStatus = v[0]; break;
      case 4: s.battery = v[0]; break;
      case 5: s.shutterStatus = v[0]; break;
      case 6: s.chargingStatus = v[0]; break;
      default: throw new ProtocolError(`unknown status tag ${tag}`);
    }
    i += 2 + len;
  }
  s.errors = [];
  for (let bit = 0; bit < 64; bit++) if ((s.errorStatus >> BigInt(bit)) & 1n) s.errors.push({ bit, text: STATUS_ERROR_BITS[bit] ?? `error bit ${bit}` });
  return s;
}

export function parseSizeReply(reply, cmd) {
  const p = payloadOf(reply, cmd, OP.SIZE_REPLY);
  return new DataView(p.buffer, p.byteOffset).getUint32(0, true);
}

export function parseRecord(bytes, fromHistory = false) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const o = fromHistory ? -1 : 0;
  const rec = {
    ok: fromHistory ? true : bytes[0] !== 0,
    date: new Date(2000 + bytes[1 + o], bytes[2 + o] - 1, bytes[3 + o], bytes[4 + o], bytes[5 + o], bytes[6 + o]),
    spectrum: Array.from({ length: 31 }, (_, i) => dv.getFloat32(7 + o + 4 * i, true)),
    mFactor: bytes[0x83 + o], lightSource: bytes[0x84 + o], viewAngle: bytes[0x85 + o], colorDiffFormula: bytes[0x86 + o],
    identifier: dv.getUint32(0x87 + o, true), inspectionNo: dv.getUint16(0x8b + o, true), patchNo: bytes[0x8d + o],
    groupId: dv.getUint16(0x8e + o, true),
  };
  return rec;
}

export function parseRecords(payload, fromHistory = false) {
  const size = fromHistory ? HISTORY_RECORD_LEN : RECORD_LEN;
  if (payload.length % size) throw new ProtocolError(`result payload ${payload.length} is not a multiple of ${size}`);
  const out = [];
  for (let i = 0; i < payload.length; i += size) out.push(parseRecord(payload.subarray(i, i + size), fromHistory));
  return out;
}

export function parseMode(reply) {
  const p = payloadOf(reply, CMD.GET_MODE);
  const WIRE_TO_API = { 2: METHOD.SPOT_GROUP, 3: METHOD.SCAN_GROUP, 4: METHOD.CALIBRATION };
  const m = {};
  for (let i = 0; i + 2 <= p.length; i += 2 + p[i + 1]) {
    const v = p[i + 2];
    if (p[i] === 1) m.method = WIRE_TO_API[v] ?? null;
    else if (p[i] === 4) m.groupNo = v;
    else if (p[i] === 5) m.patchNum = v;
    else if (p[i] === 6) m.startPatchNo = v;
  }
  return m;
}

export function parseGroups(payload) {
  const groups = [];
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let i = 0; i < payload.length;) {
    const control = payload[i];
    if (control === 1) { groups.push({ control, slot: payload[i + 1] }); i += 2; continue; }
    const g = { control, slot: payload[i + 1], hardwareId: dv.getUint16(i + 2, true) };
    const nameLen = payload[i + 4];
    g.name = new TextDecoder().decode(payload.subarray(i + 5, i + 5 + nameLen).map((b) => b ^ 0x5a));
    let j = i + 5 + 42;
    g.patchBorder = payload[j]; const n = payload[j + 1];
    g.mFactor = payload[j + 2]; g.lightSource = payload[j + 3]; g.viewingAngle = payload[j + 4]; g.colorDiffFormula = payload[j + 5];
    g.threshold = dv.getFloat32(j + 6, true) / 10;
    j += 10;
    g.labs = [];
    for (let k = 0; k < n; k++, j += 12) g.labs.push([dv.getFloat32(j, true) / 100, dv.getFloat32(j + 4, true) / 100, dv.getFloat32(j + 8, true) / 100]);
    groups.push(g);
    i = j;
  }
  return groups;
}

export function parseHistoryCheck(reply) {
  const p = payloadOf(reply, CMD.HISTORY_CHECK);
  const dv = new DataView(p.buffer, p.byteOffset);
  return { offset: dv.getUint32(0, true), count: dv.getUint32(4, true) };
}

// ---------------------------------------------------------------- decoding for the log
const OP_NAME = { 0x10: 'size?', 0x11: 'get', 0x12: 'exec', 0x13: 'set', 0x01: 'reply', 0x00: 'size' };

export function describe(bytes, dir) {
  if (bytes.length === 1) {
    const b = bytes[0];
    if (dir === 'tx') return b === ACK_OK ? 'ACK OK' : b === ACK_NG ? 'ACK NG' : 'byte';
    return `event ${EVENT_NAME[b] ?? '0x' + b.toString(16)}`;
  }
  if (bytes.length >= HEADER_LEN && bytes[0] === 0 && bytes[1] === 0x43) {
    const name = CMD_NAME[bytes[2]] ?? `cmd 0x${bytes[2].toString(16)}`;
    const len = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
    let extra = '';
    const p = bytes.subarray(8, 8 + len);
    if (dir === 'rx' && bytes[3] === OP.REPLY && len === 2 && p[0] >= 0x41) extra = ` "${parseAscii(p)}"`;
    return `${name} ${OP_NAME[bytes[3]] ?? bytes[3]} (${len} B)${extra}`;
  }
  return '';
}
