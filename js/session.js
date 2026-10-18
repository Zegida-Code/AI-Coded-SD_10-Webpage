// SD-10 session: byte routing, command/ack exchange, handshake and high-level operations.
// Behaviour follows EPSPM::Device::ExecuteCommand / EPSPM::Controller (see PROTOCOL.md §2–§5).
import {
  ACK_NG, ACK_OK, CMD, EVENT, EVENT_NAME, HEADER_LEN, METHOD, build, describe, parseGroups, parseHistoryCheck,
  parseMode, parseRecords, parseSizeReply, parseStatus, parseStatusString, payloadOf, parseAscii, ProtocolError,
} from './protocol.js';

export class DeviceError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 16-byte application id, generated once and persisted (MunsellLib.createApplicationIdForOpen). */
export function getAppId() {
  const KEY = 'sd10.appId';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const b = Uint8Array.from(atob(saved), (c) => c.charCodeAt(0));
      if (b.length === 16) return b;
    }
  } catch { /* storage unavailable */ }
  const id = crypto.getRandomValues(new Uint8Array(16));
  try { localStorage.setItem(KEY, btoa(String.fromCharCode(...id))); } catch { /* ignore */ }
  return id;
}

export class SD10Session extends EventTarget {
  constructor(transport) {
    super();
    this.t = transport;
    this.t.onData = (chunk) => this._rx(chunk);
    this.t.onDisconnect = () => this._linkLost();
    this.pending = null;
    this.queue = Promise.resolve();
    this.waiters = [];
    this.connected = false;
    this.controlled = false;
    this.appId = getAppId();
  }

  // ------------------------------------------------------------ plumbing
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _log(dir, bytes, note = '') { this._emit('log', { dir, bytes, note: note || describe(bytes, dir), time: new Date() }); }

  _rx(chunk) {
    this._emit('raw', { bytes: chunk });
    for (const b of chunk) {
      const p = this.pending;
      if (p && (p.buf.length || b === 0x00)) {
        p.buf.push(b);
        if (p.buf.length === HEADER_LEN) {
          p.need = HEADER_LEN + (p.buf[4] | (p.buf[5] << 8) | (p.buf[6] << 16) | (p.buf[7] << 24));
        }
        if (p.need && p.buf.length >= p.need) {
          this.pending = null;
          clearTimeout(p.timer);
          const reply = Uint8Array.from(p.buf);
          this._log('rx', reply);
          p.resolve(reply);
        }
      } else {
        this._event(b);
      }
    }
  }

  _event(code) {
    this._log('rx', Uint8Array.of(code));
    this.waiters = this.waiters.filter((w) => {
      if (w.code !== code) return true;
      clearTimeout(w.timer);
      w.resolve(code);
      return false;
    });
    this._emit('device-event', { code, name: EVENT_NAME[code] ?? `0x${code.toString(16)}` });
    if (code === EVENT.DISCONNECTED) this._linkLost();
  }

  _linkLost() {
    if (!this.connected) return;
    this.connected = false;
    this.controlled = false;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new DeviceError('Disconnected', 'disconnected')); this.pending = null; }
    for (const w of this.waiters) { clearTimeout(w.timer); w.reject(new DeviceError('Disconnected', 'disconnected')); }
    this.waiters = [];
    this._emit('disconnected');
  }

  async _write(bytes) {
    this._log('tx', bytes);
    await this.t.write(bytes);
  }

  /** Arm a wait for a single-byte device event. Call before triggering the action. */
  waitEvent(code, timeout = 20000) {
    let w;
    const promise = new Promise((resolve, reject) => {
      w = { code, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new DeviceError(`Timed out waiting for ${EVENT_NAME[code]}`, 'timeout'));
      }, timeout);
    });
    this.waiters.push(w);
    promise.cancel = () => { clearTimeout(w.timer); this.waiters = this.waiters.filter((x) => x !== w); };
    return promise;
  }

  /** Write a command, read its reply, acknowledge it (FF / FE). Serialized. */
  exchange(cmdBytes, { timeout = 5000 } = {}) {
    const run = async () => {
      if (!this.connected) throw new DeviceError('Not connected', 'disconnected');
      const reply = new Promise((resolve, reject) => {
        this.pending = { buf: [], need: 0, resolve, reject };
        this.pending.timer = setTimeout(() => {
          this.pending = null;
          reject(new DeviceError(`No reply to ${describe(cmdBytes, 'tx')}`, 'timeout'));
        }, timeout);
      });
      try {
        await this._write(cmdBytes);
        const r = await reply;
        await this._write(Uint8Array.of(ACK_OK));
        return r;
      } catch (e) {
        if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; }
        if (this.connected) { try { await this._write(Uint8Array.of(ACK_NG)); } catch { /* link gone */ } }
        throw e;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async _expectOk(cmdBytes, cmd, opts) {
    const s = parseStatusString(await this.exchange(cmdBytes, opts), cmd);
    if (s !== 'OK') throw new DeviceError(`Device answered "${s}"`, s);
  }

  // ------------------------------------------------------------ session
  async connect() {
    await this.t.connect();
    this.connected = true;
    this._emit('linked', { name: this.t.name });
    await this.acquireControl();
    await this.exchange(build.setDatetime(new Date())).then((r) => {
      const s = parseStatusString(r, CMD.DATETIME);
      if (s !== 'OK') throw new DeviceError(`SetDatetime failed: ${s}`, s);
    });
    this._emit('ready');
  }

  async acquireControl() {
    const deadline = Date.now() + 25000;
    for (;;) {
      const s = parseStatusString(await this.exchange(build.control(true, this.appId, 1)), CMD.CONTROL);
      if (s === 'OK') { this.controlled = true; return; }
      if (s === 'NG') throw new DeviceError('Device rejected control (another app is connected)', 'reject');
      if (s === 'TO') throw new DeviceError('Device timed out granting control', 'timeout');
      if (Date.now() > deadline) throw new DeviceError(`Device busy ("${s}")`, 'busy');
      await sleep(1000);
    }
  }

  async disconnect() {
    try {
      if (this.connected && this.controlled) await this.exchange(build.control(false, this.appId, 1));
    } catch { /* best effort */ }
    this.controlled = false;
    const wasConnected = this.connected;
    this.connected = false;
    await this.t.disconnect();
    if (wasConnected) this._emit('disconnected');
  }

  // ------------------------------------------------------------ info & settings
  async getStatus() {
    const s = parseStatus(await this.exchange(build.getStatus()));
    this._emit('status', s);
    return s;
  }

  async getString(cmd) { return parseAscii(payloadOf(await this.exchange(build.getString(cmd)), cmd)); }

  async getInt(cmd) { return payloadOf(await this.exchange(build.getInt(cmd)), cmd)[0]; }

  setInt(cmd, value) { return this._expectOk(build.setInt(cmd, value), cmd); }

  setDeviceName(name) { return this._expectOk(build.setDeviceName(name), CMD.DEVICE_NAME); }

  async getInfo() {
    return { firmware: await this.getString(CMD.FW_VERSION), serial: await this.getString(CMD.SERIAL), model: 'SD-10' };
  }

  async getSettings() {
    return {
      name: await this.getString(CMD.DEVICE_NAME),
      buzzer: await this.getInt(CMD.BUZZER),
      autoPowerOff: await this.getInt(CMD.AUTO_POWER_OFF),
      language: await this.getInt(CMD.LANGUAGE),
      panelDirection: await this.getInt(CMD.PANEL_DIRECTION),
    };
  }

  async applySettings(next, prev = {}) {
    if (next.name !== undefined && next.name !== prev.name) await this.setDeviceName(next.name);
    for (const [key, cmd] of [['buzzer', CMD.BUZZER], ['autoPowerOff', CMD.AUTO_POWER_OFF], ['language', CMD.LANGUAGE], ['panelDirection', CMD.PANEL_DIRECTION]]) {
      if (next[key] !== undefined && next[key] !== prev[key]) await this.setInt(cmd, next[key]);
    }
  }

  // ------------------------------------------------------------ measuring
  setMode(settings) { return this._expectOk(build.setMode(settings), CMD.SET_MODE); }

  async getMode() { return parseMode(await this.exchange(build.getMode())); }

  async calibrate() {
    await this.setMode({ method: METHOD.CALIBRATION });
    const done = this.waitEvent(EVENT.FINISH_CALIBRATION, 20000);
    try {
      await this._expectOk(build.calibrate(), CMD.CALIBRATE);
    } catch (e) { done.cancel(); throw e; }
    await done;
    const status = await this.getStatus();
    if (status.errors.length) throw new DeviceError(`Calibration failed: ${status.errors[0].text}`, 'calibration');
    return status;
  }

  /** Run one measurement in the given mode and return the parsed result records. */
  async measure(settings) {
    await this.setMode(settings);
    const done = this.waitEvent(EVENT.FINISH_MEASURING, 20000);
    try {
      await this._expectOk(build.measure(), CMD.MEASURE);
    } catch (e) { done.cancel(); throw e; }
    await done;
    const records = await this.readResults();
    const failed = records.find((r) => !r.ok);
    if (!records.length || failed) {
      const status = await this.getStatus().catch(() => null);
      const why = status?.errors?.[0]?.text ?? 'device reported a failed measurement';
      throw new DeviceError(`Measurement failed: ${why}`, 'measurement');
    }
    return records;
  }

  async readResults() {
    const size = parseSizeReply(await this.exchange(build.resultSize()), CMD.RESULT_CACHE);
    if (!size) return [];
    return parseRecords(payloadOf(await this.exchange(build.result()), CMD.RESULT_CACHE));
  }

  notifyResult(ok) { return this._expectOk(build.notifyResult(ok), CMD.NOTIFY_RESULT); }
  setStandAlone() { return this._expectOk(build.standAlone(), CMD.STANDALONE); }
  notifyGroupDone() { return this._expectOk(build.groupDone(), CMD.GROUP_DONE); }

  // ------------------------------------------------------------ palettes
  async getGroups() {
    const size = parseSizeReply(await this.exchange(build.groupSize(), { timeout: 30000 }), CMD.GROUP);
    if (!size) return [];
    return parseGroups(payloadOf(await this.exchange(build.group(), { timeout: 30000 }), CMD.GROUP));
  }

  setGroups(groups) { return this._expectOk(build.setGroups(groups), CMD.SET_GROUP, { timeout: 30000 }); }

  // ------------------------------------------------------------ device history
  /** Records stored on the device that are newer than lastIdentifier (0 = everything). */
  async readHistory(lastIdentifier = 0) {
    const { offset, count } = parseHistoryCheck(await this.exchange(build.historyCheck(lastIdentifier)));
    if (!count) return [];
    const reply = await this.exchange(build.history(offset, count), { timeout: 5000 + count * 100 });
    return parseRecords(payloadOf(reply, CMD.HISTORY), true);
  }

  // ------------------------------------------------------------ diagnostics
  async readDeviceLog() {
    const size = parseSizeReply(await this.exchange(build.nvramSize()), CMD.NVRAM);
    if (!size) return new Uint8Array();
    return payloadOf(await this.exchange(build.nvram(), { timeout: 30000 }), CMD.NVRAM).slice();
  }
}

export { ProtocolError };
