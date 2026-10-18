// Simulated SD-10 implementing the device side of the protocol (for the Demo mode and tests).
// Same interface as BleTransport: connect / write / disconnect / onData / onDisconnect.
import { CMD, OP, encodeGroup, parseGroups } from './protocol.js';

const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (s, len) => { const b = new Uint8Array(len); b.set(new TextEncoder().encode(s).subarray(0, len)); return [...b]; };

export const SAMPLES = {
  'Tomato red': [[620, 70, 0.62], [450, 30, 0.04]],
  'Leaf green': [[540, 40, 0.38], [450, 25, 0.06]],
  'Sky blue': [[460, 45, 0.55], [520, 40, 0.2]],
  'Sunflower': [[600, 90, 0.75], [470, 20, -0.02]],
  'Lavender': [[430, 40, 0.45], [660, 50, 0.4]],
  'Concrete grey': [[550, 400, 0.18]],
  'Paper white': [[550, 600, 0.86]],
};

function sampleSpectrum(name, noise = 0.004) {
  const comps = SAMPLES[name] ?? SAMPLES['Tomato red'];
  return Array.from({ length: 31 }, (_, i) => {
    const nm = 400 + 10 * i;
    let r = 0.05;
    for (const [c, w, a] of comps) r += a * Math.exp(-(((nm - c) / w) ** 2));
    r += (Math.random() - 0.5) * 2 * noise;
    return Math.min(Math.max(r, 0.005), 0.98);
  });
}

export class MockTransport {
  constructor() {
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.name = 'SD-10 (simulated)';
    this.rxBuf = [];
    this.state = {
      battery: 78, charging: 0, shutter: 0, calibration: 0, deviceStatus: 4, errorBits: 0n,
      name: 'SD-10 Demo', fw: '1.04.0', serial: 'X3K0012345', buzzer: 1, autoPowerOff: 2, language: 1, panelDirection: 0,
      mode: { wire: 1, tlv: {} }, cache: [], history: [], nextId: 1000, groups: {}, sample: 'Tomato red',
    };
    this.linked = false;
  }

  async connect() { await new Promise((r) => setTimeout(r, 300)); this.linked = true; }
  async disconnect() { this.linked = false; }

  // --- simulator controls (used by the demo panel)
  setSample(name) { this.state.sample = name; }
  setShutter(closed) { this.state.shutter = closed ? 1 : 0; this._event(0xc4); }
  pressButton() { this._event(0xc2); }
  dropLink() { this.linked = false; this.onDisconnect(); }

  async write(bytes) {
    if (!this.linked) throw new Error('not connected');
    await new Promise((r) => setTimeout(r, 5));
    for (const b of bytes) {
      if (!this.rxBuf.length && b !== 0x00) continue; // ACK (FF/FE) from host
      this.rxBuf.push(b);
      if (this.rxBuf.length >= 8) {
        const len = this.rxBuf[4] | (this.rxBuf[5] << 8);
        if (this.rxBuf.length === 8 + len) {
          const f = Uint8Array.from(this.rxBuf);
          this.rxBuf = [];
          setTimeout(() => this._handle(f), 15);
        }
      }
    }
  }

  _send(bytes) {
    if (!this.linked) return;
    const arr = Uint8Array.from(bytes);
    for (let i = 0; i < arr.length; i += 20) {
      const chunk = arr.slice(i, i + 20);
      setTimeout(() => this.linked && this.onData(chunk), 2 + i / 20);
    }
  }

  _event(code) { setTimeout(() => this.linked && this.onData(Uint8Array.of(code)), 10); }

  _reply(cmd, payload, op = OP.REPLY) { this._send([0x00, 0x43, cmd, op, ...u32(payload.length), ...payload]); }
  _ok(cmd) { this._reply(cmd, [0x4f, 0x4b]); }

  _record(spectrum, ok, extra = {}) {
    const s = this.state, d = new Date();
    const b = new Uint8Array(144);
    const dv = new DataView(b.buffer);
    b[0] = ok ? 1 : 0;
    b.set([d.getFullYear() % 100, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()], 1);
    spectrum.forEach((v, i) => dv.setFloat32(7 + 4 * i, v, true));
    const t = s.mode.tlv;
    b[0x83] = t[4]?.[0] ?? 1; b[0x84] = t[5]?.[0] ?? 0; b[0x85] = t[6]?.[0] ?? 2; b[0x86] = t[7]?.[0] ?? 0;
    dv.setUint32(0x87, s.nextId++, true);
    dv.setUint16(0x8b, extra.inspectionNo ?? 0, true);
    b[0x8d] = extra.patchNo ?? 0;
    dv.setUint16(0x8e, extra.groupId ?? 0, true);
    return b;
  }

  _status() {
    const s = this.state;
    const err = [];
    for (let i = 7; i >= 0; i--) err.push(Number((s.errorBits >> BigInt(8 * i)) & 0xffn));
    return [1, 1, s.deviceStatus, 2, 8, ...err, 3, 1, s.calibration, 4, 1, s.battery, 5, 1, s.shutter, 6, 1, s.charging];
  }

  _handle(f) {
    const s = this.state;
    const cmd = f[2], op = f[3];
    const p = f.subarray(8);
    switch (cmd) {
      case CMD.CONTROL: return this._ok(cmd);
      case CMD.DATETIME: return this._ok(cmd);
      case CMD.STATUS: return this._reply(cmd, this._status());
      case CMD.FW_VERSION: return this._reply(cmd, ascii(s.fw, 6));
      case CMD.SERIAL: return this._reply(cmd, ascii(s.serial, 10));
      case CMD.DEVICE_NAME:
        if (op === OP.SET) { s.name = new TextDecoder().decode(p).replace(/\0+$/, ''); return this._ok(cmd); }
        return this._reply(cmd, ascii(s.name, 16));
      case CMD.BUZZER: case CMD.AUTO_POWER_OFF: case CMD.LANGUAGE: case CMD.PANEL_DIRECTION: {
        const key = { [CMD.BUZZER]: 'buzzer', [CMD.AUTO_POWER_OFF]: 'autoPowerOff', [CMD.LANGUAGE]: 'language', [CMD.PANEL_DIRECTION]: 'panelDirection' }[cmd];
        if (op === OP.SET) { s[key] = p[0]; return this._ok(cmd); }
        return this._reply(cmd, [s[key]]);
      }
      case CMD.SET_MODE: {
        const tlv = {};
        for (let i = 0; i < p.length; i += 2 + p[i + 1]) tlv[p[i]] = p.subarray(i + 2, i + 2 + p[i + 1]);
        s.mode = { wire: tlv[1][0], tlv };
        return this._ok(cmd);
      }
      case CMD.GET_MODE: {
        const t = s.mode.tlv;
        const wire = [2, 3, 4].includes(s.mode.wire) ? s.mode.wire : 2;
        return this._reply(cmd, [1, 1, wire, 4, 1, t[9]?.[0] ?? 1, 5, 1, t[10]?.[0] ?? 1, 6, 1, t[11]?.[0] ?? 1]);
      }
      case CMD.CALIBRATE:
        this._ok(cmd);
        setTimeout(() => {
          if (s.shutter === 1) { s.calibration = 2; s.errorBits = 0n; } else s.errorBits |= 1n << 49n;
          this._event(0xc3);
        }, 1200);
        return;
      case CMD.MEASURE:
        this._ok(cmd);
        setTimeout(() => {
          const ok = s.calibration === 2 && s.shutter === 0;
          if (!ok) s.errorBits |= 1n << 57n; else s.errorBits &= ~(1n << 57n);
          const scan = s.mode.wire === 5 || s.mode.wire === 3;
          const n = scan ? (s.mode.tlv[10]?.[0] ?? 1) : 1;
          const names = Object.keys(SAMPLES);
          s.cache = Array.from({ length: n }, (_, k) => {
            const sp = sampleSpectrum(scan ? names[(names.indexOf(s.sample) + k) % names.length] : s.sample);
            return this._record(sp, ok, { patchNo: k + 1 });
          });
          if (ok && s.mode.tlv[2]?.[0] === 2) s.history.push(...s.cache);
          this._event(0xc1);
        }, scan(s) ? 1600 : 900);
        return;
      case CMD.RESULT_CACHE: {
        const all = s.cache.flatMap((r) => [...r]);
        if (op === OP.SIZE) return this._reply(cmd, u32(all.length), OP.SIZE_REPLY);
        return this._reply(cmd, all);
      }
      case CMD.NOTIFY_RESULT: case CMD.STANDALONE: case CMD.GROUP_DONE: return this._ok(cmd);
      case CMD.SET_GROUP: {
        for (const g of parseGroups(p)) { if (g.control === 1) delete s.groups[g.slot]; else s.groups[g.slot] = g; }
        return this._ok(cmd);
      }
      case CMD.GROUP: {
        const out = [];
        for (let slot = 1; slot <= 4; slot++) if (s.groups[slot]) out.push(...encodeGroup(s.groups[slot]));
        if (op === OP.SIZE) return this._reply(cmd, u32(out.length), OP.SIZE_REPLY);
        return this._reply(cmd, out);
      }
      case CMD.HISTORY_CHECK: {
        const last = new DataView(p.buffer, p.byteOffset).getUint32(1, true);
        const idx = s.history.findIndex((r) => new DataView(r.buffer).getUint32(0x87, true) > last);
        // Real SD-10 (observed): with nothing newer it answers offset = requested identifier, count = 0.
        return this._reply(cmd, idx < 0 ? [...u32(last), ...u32(0)] : [...u32(idx), ...u32(s.history.length - idx)]);
      }
      case CMD.HISTORY: {
        const dv = new DataView(p.buffer, p.byteOffset);
        const a = dv.getUint32(1, true), n = dv.getUint32(5, true);
        if (p[0] === 2) { s.history.splice(a, n); return this._ok(cmd); }
        return this._reply(cmd, s.history.slice(a, a + n).flatMap((r) => [...r.subarray(1)]));
      }
      case CMD.NVRAM: {
        const log = Array.from({ length: 96 }, (_, i) => (i * 37) & 0xff);
        if (op === OP.SIZE) return this._reply(cmd, u32(log.length), OP.SIZE_REPLY);
        return this._reply(cmd, log);
      }
      default:
        return this._reply(cmd, [0x4e, 0x47]); // "NG"
    }
  }
}

function scan(s) { return s.mode.wire === 5 || s.mode.wire === 3; }
