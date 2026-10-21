// Small ICC engine for Lab(D50) -> CMYK, matching how the Android app drives its CMM
// (EPSPM::Controller::ConvertLabtoDevColor -> libepcmm ISM, see FEATURES.md §7):
//   * Lab is quantised to the PCS 16-bit encoding of the profile's version
//     (v2: L*65280/100, (a+128)*256; v4: L*65535/100, (a+128)*257), +0.5, truncated
//   * the profile's BToA table for the rendering intent is evaluated
//     (lut8 'mft1', lut16 'mft2' or v4 lutBtoA 'mBA '; Lab or XYZ PCS)
//   * 16-bit device values are scaled to percent as v*100/65280 (65535 -> 100), like the app.
// For the Print match gamut check it also evaluates AToB tables (device -> Lab, any number of inks, 'mAB ' too).
import { deltaE2000 } from './color.js';

const INTENT_TAG = { 0: 'B2A0', 1: 'B2A2', 2: 'B2A1', 3: 'B2A1' }; // perceptual, saturation, relative, absolute
const INTENT_A2B = { 0: 'A2B0', 1: 'A2B2', 2: 'A2B1', 3: 'A2B1' };
const D50 = [0.9642, 1.0, 0.8249];

export class IccError extends Error {}

export class IccProfile {
  constructor(buffer) {
    // (no instanceof check: buffers from another window/realm are valid too)
    if (!buffer || typeof buffer.byteLength !== 'number' || buffer.byteLength < 132) throw new IccError('File is too small to be an ICC profile');
    this.dv = new DataView(buffer);
    const dv = this.dv;
    const sig = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (sig(36) !== 'acsp') throw new IccError('Not an ICC profile (missing "acsp" signature)');
    this.version = dv.getUint8(8);
    this.deviceClass = sig(12).trim();
    this.colorSpace = sig(16).trim();
    this.pcs = sig(20).trim();
    this.tags = {};
    const n = dv.getUint32(128);
    if (132 + 12 * n > buffer.byteLength) throw new IccError('Corrupt ICC tag table');
    for (let i = 0; i < n; i++) {
      const o = 132 + 12 * i;
      const offset = dv.getUint32(o + 4), size = dv.getUint32(o + 8);
      if (offset + Math.min(size, 4) > buffer.byteLength) throw new IccError('Corrupt ICC tag table');
      this.tags[sig(o)] = { offset, size, type: sig(offset) };
    }
    this.description = this._desc();
    this._luts = {};
  }

  _desc() {
    const t = this.tags.desc;
    if (!t) return '';
    const dv = this.dv;
    try {
      if (t.type === 'desc') {
        const len = dv.getUint32(t.offset + 8);
        let s = '';
        for (let i = 0; i < len - 1; i++) s += String.fromCharCode(dv.getUint8(t.offset + 12 + i));
        return s.trim();
      }
      if (t.type === 'mluc') { // first record, UTF-16BE
        const len = dv.getUint32(t.offset + 20), off = dv.getUint32(t.offset + 24);
        let s = '';
        for (let i = 0; i < len; i += 2) s += String.fromCharCode(dv.getUint16(t.offset + off + i));
        return s.trim();
      }
    } catch { /* fall through */ }
    return '';
  }

  /** Throws IccError with a readable message unless this profile can convert Lab -> CMYK. */
  validateCmyk() {
    if (this.colorSpace !== 'CMYK') throw new IccError(`This is a ${this.colorSpace} profile – a CMYK output profile is needed`);
    if (this.pcs !== 'Lab' && this.pcs !== 'XYZ') throw new IccError(`Unsupported PCS "${this.pcs}"`);
    const tag = ['B2A0', 'B2A1', 'B2A2'].find((t) => this.tags[t]);
    if (!tag) throw new IccError('The profile has no BToA (output) table, so it cannot convert colors to CMYK');
    const lut = this.lut(tag);
    if (lut.inCh !== 3 || lut.outCh !== 4) throw new IccError(`Unexpected ${tag} table (${lut.inCh} → ${lut.outCh} channels)`);
    this.fromLab([50, 0, 0], 0); // smoke-run the whole pipeline
  }

  lut(tagName) {
    let name = tagName;
    const family = tagName.startsWith('A2B') ? ['A2B0', 'A2B1', 'A2B2'] : ['B2A0', 'B2A1', 'B2A2'];
    if (!this.tags[name]) name = family.find((t) => this.tags[t]); // fall back like most CMMs
    if (!name) throw new IccError(`profile has no ${tagName} tag`);
    if (this._luts[name]) return this._luts[name];
    const t = this.tags[name];
    let lut;
    if (t.type === 'mft2' || t.type === 'mft1') lut = this._legacyLut(t, name.startsWith('B2A'));
    else if (t.type === 'mBA ') lut = this._lutBtoA(t);
    else if (t.type === 'mAB ') lut = this._lutAtoB(t);
    else throw new IccError(`Unsupported table type "${t.type}" for ${name}`);
    this._luts[name] = lut;
    return lut;
  }

  _legacyLut(t, pcsInput = true) {
    const dv = this.dv, o = t.offset, is16 = t.type === 'mft2';
    const inCh = dv.getUint8(o + 8), outCh = dv.getUint8(o + 9), g = dv.getUint8(o + 10);
    const matrix = Array.from({ length: 9 }, (_, i) => dv.getInt32(o + 12 + 4 * i) / 65536);
    let p, inEntries = 256, outEntries = 256;
    if (is16) { inEntries = dv.getUint16(o + 48); outEntries = dv.getUint16(o + 50); p = o + 52; } else p = o + 48;
    const read = (count) => {
      const a = new Float64Array(count);
      for (let i = 0; i < count; i++) { a[i] = is16 ? dv.getUint16(p) / 65535 : dv.getUint8(p) / 255; p += is16 ? 2 : 1; }
      return a;
    };
    const inTables = Array.from({ length: inCh }, () => read(inEntries));
    const clut = read(g ** inCh * outCh);
    const outTables = Array.from({ length: outCh }, () => read(outEntries));
    const identity = matrix.every((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) < 1e-9);
    return {
      kind: is16 ? 'lut16' : 'lut8', inCh, outCh, grids: Array(inCh).fill(g), clut,
      // lut16/lut8 PCS encodings are the v2 legacy ones
      legacyPcs: true,
      stages: [
        // the matrix only applies to XYZ PCS input
        pcsInput && this.pcs === 'XYZ' && !identity ? (x) => mat3(matrix, x) : null,
        (x) => x.map((v, i) => sampleTable(inTables[i], v)),
        'clut',
        (y) => y.map((v, i) => sampleTable(outTables[i], v)),
      ].filter(Boolean),
    };
  }

  /** v4 lutBtoA ('mBA '): B curves -> matrix -> M curves -> CLUT -> A curves (PCS -> device). */
  _lutBtoA(t) {
    const { inCh, outCh, off, curvesStage, matrixStage, readClut } = this._mabParts(t);
    const stages = [];
    if (off.B) stages.push(curvesStage(off.B, inCh));
    if (off.matrix && inCh === 3) stages.push(matrixStage(off.matrix));
    if (off.M) stages.push(curvesStage(off.M, inCh));
    const { grids, clut } = off.clut ? readClut(off.clut) : { grids: null, clut: null };
    if (clut) stages.push('clut');
    if (off.A) stages.push(curvesStage(off.A, outCh));
    return { kind: 'lutBtoA', inCh, outCh, grids, clut, legacyPcs: false, stages };
  }

  /** v4 lutAtoB ('mAB '): A curves -> CLUT -> M curves -> matrix -> B curves (device -> PCS). */
  _lutAtoB(t) {
    const { inCh, outCh, off, curvesStage, matrixStage, readClut } = this._mabParts(t);
    const stages = [];
    if (off.A) stages.push(curvesStage(off.A, inCh));
    const { grids, clut } = off.clut ? readClut(off.clut) : { grids: null, clut: null };
    if (clut) stages.push('clut');
    if (off.M) stages.push(curvesStage(off.M, outCh));
    if (off.matrix && outCh === 3) stages.push(matrixStage(off.matrix));
    if (off.B) stages.push(curvesStage(off.B, outCh));
    return { kind: 'lutAtoB', inCh, outCh, grids, clut, legacyPcs: false, stages };
  }

  /** Header and element readers shared by the v4 'mAB ' / 'mBA ' tag types (same layout, opposite processing order). */
  _mabParts(t) {
    const dv = this.dv, o = t.offset;
    const [B, matrix, M, clut, A] = [12, 16, 20, 24, 28].map((k) => dv.getUint32(o + k));
    // n curves stored one after another at offset `rel`, applied channel by channel
    const curvesStage = (rel, n) => {
      let p = o + rel;
      const fns = Array.from({ length: n }, () => { const c = this._curve(p); p += c.bytes; return c.fn; });
      return (x) => x.map((v, i) => fns[i](v));
    };
    // 3×3 matrix plus offset (s15Fixed16)
    const matrixStage = (rel) => {
      const m = Array.from({ length: 12 }, (_, i) => dv.getInt32(o + rel + 4 * i) / 65536);
      return (x) => [0, 1, 2].map((r) => m[3 * r] * x[0] + m[3 * r + 1] * x[1] + m[3 * r + 2] * x[2] + m[9 + r]);
    };
    const inCh = dv.getUint8(o + 8), outCh = dv.getUint8(o + 9);
    // CLUT: grid points per input, precision (1 or 2 bytes), then the table normalised to 0..1
    const readClut = (rel) => {
      const c = o + rel;
      const grids = Array.from({ length: inCh }, (_, i) => dv.getUint8(c + i));
      const prec = dv.getUint8(c + 16);
      const count = grids.reduce((a, b) => a * b, 1) * outCh;
      const table = new Float64Array(count);
      for (let i = 0; i < count; i++) table[i] = prec === 1 ? dv.getUint8(c + 20 + i) / 255 : dv.getUint16(c + 20 + 2 * i) / 65535;
      return { grids, clut: table };
    };
    return { inCh, outCh, off: { B, matrix, M, clut, A }, curvesStage, matrixStage, readClut };
  }

  /** Parse a 'curv' or 'para' element at byte p. Returns { fn, bytes } (bytes padded to 4). */
  _curve(p) {
    const dv = this.dv;
    const type = String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
    const pad = (n) => (n + 3) & ~3;
    if (type === 'curv') {
      const n = dv.getUint32(p + 8);
      if (n === 0) return { fn: (v) => v, bytes: 12 };
      if (n === 1) { const gamma = dv.getUint16(p + 12) / 256; return { fn: (v) => Math.max(v, 0) ** gamma, bytes: pad(14) }; }
      const tbl = new Float64Array(n);
      for (let i = 0; i < n; i++) tbl[i] = dv.getUint16(p + 12 + 2 * i) / 65535;
      return { fn: (v) => sampleTable(tbl, v), bytes: pad(12 + 2 * n) };
    }
    if (type === 'para') {
      const ft = dv.getUint16(p + 8);
      const np = [1, 3, 4, 5, 7][ft];
      if (np === undefined) throw new IccError(`Unsupported parametric curve type ${ft}`);
      const [g, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] = Array.from({ length: np }, (_, i) => dv.getInt32(p + 12 + 4 * i) / 65536);
      const pw = (x) => (x > 0 ? x ** g : 0);
      const fns = [
        (x) => pw(x),
        (x) => (x >= -b / a ? pw(a * x + b) : 0),
        (x) => (x >= -b / a ? pw(a * x + b) + c : c),
        (x) => (x >= d ? pw(a * x + b) : c * x),
        (x) => (x >= d ? pw(a * x + b) + e : c * x + f),
      ];
      return { fn: (v) => Math.min(Math.max(fns[ft](v), 0), 1), bytes: pad(12 + 4 * np) };
    }
    throw new IccError(`Unsupported curve type "${type}"`);
  }

  /** Lab (D50, as the app passes it) -> device values in percent (CMYK: 4 values 0..100). */
  fromLab(lab, intent = 0) {
    return this._toDevice(lab, intent).map((v) => {
      const dev16 = Math.round(v * 65535);
      return dev16 === 0 ? 0 : dev16 === 65535 ? 100 : (dev16 * 100) / 65280;
    });
  }

  /** Lab (D50) -> device values 0..1 through the BToA table of `intent` (any number of device channels). */
  _toDevice([L, a, b], intent = 0) {
    const lut = this.lut(INTENT_TAG[intent] ?? 'B2A0');
    let x;
    if (this.pcs === 'Lab') {
      // Quantise exactly like ConvertLabtoDevColor: legacy (v2) or v4 16-bit Lab encoding.
      const v4 = !lut.legacyPcs || this.version > 3;
      const q = (v) => Math.trunc(Math.min(Math.max(v, 0), 65535));
      const enc = v4
        ? [q((L / 100) * 65535 + 0.5), q((a + 128) * 257 + 0.5), q((b + 128) * 257 + 0.5)]
        : [q((L / 100) * 65280 + 0.5), q((a + 128) * 256 + 0.5), q((b + 128) * 256 + 0.5)];
      x = lut.kind === 'lut8' ? enc.map((v) => (v >> 8) / 255) : enc.map((v) => v / 65535);
    } else {
      // XYZ PCS (D50), u1Fixed15 encoding: 1.0 -> 0x8000
      const fy = (L + 16) / 116;
      const finv = (t) => (t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29));
      const xyz = [finv(fy + a / 500) * D50[0], finv(fy) * D50[1], finv(fy - b / 200) * D50[2]];
      x = xyz.map((v) => Math.min(Math.max(v, 0), 65535 / 32768) * (32768 / 65535));
    }
    for (const stage of lut.stages) x = stage === 'clut' ? (lut.inCh === 3 ? interpolate(lut, x) : interpolateN(lut, x)) : stage(x);
    return x.map((v) => Math.min(Math.max(v, 0), 1));
  }

  /** Device values 0..1 -> Lab (D50) through the AToB table of `intent`. */
  toLab(device, intent = 2) {
    const lut = this.lut(INTENT_A2B[intent] ?? 'A2B0');
    if (device.length !== lut.inCh) throw new IccError(`The profile's AToB table expects ${lut.inCh} channels`);
    let x = device.map((v) => Math.min(Math.max(v, 0), 1));
    for (const stage of lut.stages) x = stage === 'clut' ? interpolateN(lut, x) : stage(x);
    if (this.pcs === 'XYZ') {
      const xyz = x.map((v) => (v * 65535) / 32768);
      const f = (t) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
      const [fx, fy, fz] = xyz.map((v, i) => f(v / D50[i]));
      return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
    }
    if (lut.kind === 'lut16') return [((x[0] * 65535) / 65280) * 100, (x[1] * 65535) / 256 - 128, (x[2] * 65535) / 256 - 128]; // legacy 16-bit Lab
    return [x[0] * 100, x[1] * 255 - 128, x[2] * 255 - 128]; // lut8 / v4 encoding
  }

  /**
   * Gamut check: Lab -> device -> Lab through the colorimetric tables. Returns the closest color this printer can
   * reproduce and how far it is from the requested one (ΔE00; profiles round-trip in-gamut colors to about 1).
   */
  gamut(lab) {
    const closest = this.toLab(this._toDevice(lab, 2), 2);
    return { closest, dE: deltaE2000(lab, closest) };
  }

  /** Throws IccError with a readable message unless this can be used as a printer (output) profile for gamut checks. */
  validatePrinter() {
    if (this.pcs !== 'Lab' && this.pcs !== 'XYZ') throw new IccError(`Unsupported PCS "${this.pcs}"`);
    if (!['B2A0', 'B2A1', 'B2A2'].some((t) => this.tags[t])) throw new IccError('The profile has no BToA (output) table – a printer / media output profile is needed');
    if (!['A2B0', 'A2B1', 'A2B2'].some((t) => this.tags[t])) throw new IccError('The profile has no AToB table, so it cannot predict printed colors');
    const g = this.gamut([50, 0, 0]);
    if (!g.closest.every(Number.isFinite)) throw new IccError('The profile could not be evaluated');
  }
}

/** N-linear interpolation in an N-dimensional CLUT (first input varies slowest) – CMYK and multi-ink AToB tables. */
function interpolateN(lut, x) {
  const g = lut.grids, n = lut.outCh, c = lut.clut, d = g.length;
  const f = x.map((v, k) => Math.min(Math.max(v, 0), 1) * (g[k] - 1));
  const i0 = f.map((v, k) => Math.max(Math.min(Math.floor(v), g[k] - 2), 0));
  const r = f.map((v, k) => v - i0[k]);
  const stride = new Array(d);
  stride[d - 1] = n;
  for (let k = d - 2; k >= 0; k--) stride[k] = stride[k + 1] * g[k + 1];
  const out = new Array(n).fill(0);
  for (let corner = 0; corner < 1 << d; corner++) {
    let w = 1, base = 0;
    for (let k = 0; k < d; k++) {
      const bit = (corner >> (d - 1 - k)) & 1;
      w *= bit ? r[k] : 1 - r[k];
      base += (i0[k] + bit) * stride[k];
    }
    if (!w) continue;
    for (let j = 0; j < n; j++) out[j] += w * c[base + j];
  }
  return out;
}

function sampleTable(table, v) {
  const n = table.length - 1;
  if (n < 1) return table[0] ?? v;
  const pos = Math.min(Math.max(v, 0), 1) * n;
  const i = Math.min(Math.floor(pos), n - 1);
  return table[i] + (table[i + 1] - table[i]) * (pos - i);
}

function mat3(m, x) {
  return [0, 1, 2].map((r) => m[3 * r] * x[0] + m[3 * r + 1] * x[1] + m[3 * r + 2] * x[2]);
}

/**
 * Trilinear interpolation in a 3-D CLUT (per-dimension grid sizes). Compared with the app's own CMM
 * (libepcmm, emulated) on 12 reference colors this is the closest of trilinear/tetrahedral (mean 0.15,
 * max 0.42 percentage points; the native engine resamples the profile into its own internal LUT, so an
 * exact match is not possible from the profile alone).
 */
function interpolate(lut, xyz) {
  const g = lut.grids, n = lut.outCh, c = lut.clut;
  const f = xyz.map((v, k) => Math.min(Math.max(v, 0), 1) * (g[k] - 1));
  const i0 = f.map((v, k) => Math.max(Math.min(Math.floor(v), g[k] - 2), 0));
  const r = f.map((v, k) => v - i0[k]);
  const out = new Array(n).fill(0);
  for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) {
    const w = (dx ? r[0] : 1 - r[0]) * (dy ? r[1] : 1 - r[1]) * (dz ? r[2] : 1 - r[2]);
    if (!w) continue;
    const base = (((i0[0] + dx) * g[1] + (i0[1] + dy)) * g[2] + (i0[2] + dz)) * n;
    for (let k = 0; k < n; k++) out[k] += w * c[base + k];
  }
  return out;
}

// ---------------------------------------------------------------- bundled profiles (lazy-loaded)
export const CMYK_PROFILES = {
  EpsonWideCMYK_Ver2: 'EpsonWideCMYK_Ver2.icc', // app default
  EpsonWideCMYK_Ver3: 'EpsonWideCMYK_Ver3.icc',
  JapanColor2001Coated: 'JapanColor2001Coated.icc',
  JapanColor2001Uncoated: 'JapanColor2001Uncoated.icc',
  JapanWebCoated: 'JapanWebCoated.icc',
  USWebCoatedSWOP: 'USWebCoatedSWOP.icc',
  USWebUncoated: 'USWebUncoated.icc',
};
export const CUSTOM_PREFIX = 'custom:';
/** Printer (output) profiles for the Print match gamut check – kept apart from the Console's CMYK profiles. */
export const PRINTER_PREFIX = 'printer:';

const cache = new Map();
export function loadProfile(name, base = new URL('../icc/', import.meta.url)) {
  if (!cache.has(name)) {
    const buf = name.startsWith(CUSTOM_PREFIX) || name.startsWith(PRINTER_PREFIX)
      ? customProfiles.get(name.startsWith(PRINTER_PREFIX) ? name : name.slice(CUSTOM_PREFIX.length)).then((b) => { if (!b) throw new Error('profile not found in this browser'); return b; })
      : CMYK_PROFILES[name]
        ? fetch(new URL(CMYK_PROFILES[name], base)).then((r) => { if (!r.ok) throw new Error(`could not load ${CMYK_PROFILES[name]} (${r.status})`); return r.arrayBuffer(); })
        : Promise.reject(new Error(`unknown profile ${name}`));
    cache.set(name, buf.then((b) => new IccProfile(b)).catch((e) => { cache.delete(name); throw e; }));
  }
  return cache.get(name);
}

// ---------------------------------------------------------------- user-provided profiles (IndexedDB)
// Profiles are often 0.5–2 MB, too large for localStorage, so they are kept in IndexedDB in this browser.
const DB = 'sd10-icc', STORE = 'profiles';
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available')); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}
function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('storage transaction aborted'));
  }));
}

// Profiles are always kept in memory for this session; persistence is best effort (private modes may block it).
const memory = new Map();
const withTimeout = (p, ms = 3000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('storage did not respond')), ms))]);

export const customProfiles = {
  async list() {
    const stored = await withTimeout(tx('readonly', (s) => s.getAllKeys())).catch(() => []);
    return [...new Set([...stored.map(String), ...memory.keys()])].filter((k) => !k.startsWith(PRINTER_PREFIX)).sort();
  },
  async get(name) {
    if (memory.has(name)) return memory.get(name);
    const buf = await withTimeout(tx('readonly', (s) => s.get(name)));
    if (buf) memory.set(name, buf);
    return buf;
  },
  /** Validate and store a user profile. Returns { name, description, saved } (saved = persisted in this browser). */
  async add(file) {
    const buf = await file.arrayBuffer();
    const profile = new IccProfile(buf);
    profile.validateCmyk();
    let name = (profile.description || file.name.replace(/\.(icc|icm)$/i, '')).slice(0, 60) || 'Custom profile';
    if (CMYK_PROFILES[name]) name += ' (custom)';
    memory.set(name, buf);
    cache.set(CUSTOM_PREFIX + name, Promise.resolve(profile));
    const saved = await withTimeout(tx('readwrite', (s) => s.put(buf, name))).then(() => true, () => false);
    return { name, description: profile.description, saved };
  },
  async remove(name) {
    memory.delete(name);
    cache.delete(CUSTOM_PREFIX + name);
    await withTimeout(tx('readwrite', (s) => s.delete(name))).catch(() => {});
  },
};

/** Printer / media output profiles (any ink set: CMYK, CMYK + spot inks …), stored next to the custom CMYK profiles. */
export const printerProfiles = {
  async list() {
    const stored = await withTimeout(tx('readonly', (s) => s.getAllKeys())).catch(() => []);
    return [...new Set([...stored.map(String), ...memory.keys()])].filter((k) => k.startsWith(PRINTER_PREFIX)).map((k) => k.slice(PRINTER_PREFIX.length)).sort();
  },
  /** Validate and store. Returns { name, key, description, channels, saved }. */
  async add(file) {
    const buf = await file.arrayBuffer();
    const profile = new IccProfile(buf);
    profile.validatePrinter();
    const name = (profile.description || file.name.replace(/\.(icc|icm)$/i, '')).slice(0, 60) || 'Printer profile';
    const key = PRINTER_PREFIX + name;
    memory.set(key, buf);
    cache.set(key, Promise.resolve(profile));
    const saved = await withTimeout(tx('readwrite', (s) => s.put(buf, key))).then(() => true, () => false);
    return { name, key, description: profile.description, channels: profile.lut('A2B1').inCh, saved };
  },
  async remove(name) {
    const key = PRINTER_PREFIX + name;
    memory.delete(key);
    cache.delete(key);
    await withTimeout(tx('readwrite', (s) => s.delete(key))).catch(() => {});
  },
};
