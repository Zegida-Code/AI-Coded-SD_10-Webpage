// Spot colour library files for RIP software, so the named colours of a test sheet (or of the final match) can be
// imported into the RIP. One exporter per format; more can be added as sample library files become available.
// colours: [{ name, lab: [L, a, b] }] – CIE L*a*b* D50 / 2°.
import { spectrumToLab } from './color.js';

const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
/** Colour book id for a library: stable per name, kept clear of the stock Photoshop books (3000+). */
const bookId = (name) => 4000 + ([...String(name)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 20000);

export const RIP_EXPORTS = {
  // CxF3 (ISO 17972-1, X-Rite Color Exchange Format) – the open standard for named colour libraries, imported by
  // many RIPs. Written exactly the way CadLink Digital Factory exports its spot colour libraries (UTF-8 with BOM, CRLF,
  // cc: prefixed core schema, one object per colour with its CIELab value, one shared D50/2° specification), so RIPs
  // that read Digital Factory's files read these too. Digital Factory also states its measuring device (XRGA, UV
  // excluded); that is left out, since the values here are not tied to that device. Library name and description
  // have no place in this form and are not written.
  cxf: {
    label: 'CxF3',
    ext: 'cxf',
    mime: 'application/xml',
    build({ colours }) {
      const num = (v) => String(Math.round(v * 100) / 100 + 0); // 42, 26.4, -31.65 (never "-0")
      const objects = colours.map(({ name, lab }, i) => [
        `      <cc:Object ObjectType="Standard" Name="${xmlEsc(name)}" Id="EXC_${i + 1}">`,
        '        <cc:ColorValues>',
        '          <cc:ColorCIELab ColorSpecification="CS0">',
        `            <cc:L>${num(lab[0])}</cc:L>`,
        `            <cc:A>${num(lab[1])}</cc:A>`,
        `            <cc:B>${num(lab[2])}</cc:B>`,
        '          </cc:ColorCIELab>',
        '        </cc:ColorValues>',
        '      </cc:Object>',
      ]).flat();
      const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<cc:CxF xmlns:cc="http://colorexchangeformat.com/CxF3-core">',
        '  <cc:Resources>',
        '    <cc:ObjectCollection>',
        ...objects,
        '    </cc:ObjectCollection>',
        '    <cc:ColorSpecificationCollection>',
        '      <cc:ColorSpecification Id="CS0">',
        '        <cc:TristimulusSpec>',
        '          <cc:Illuminant>D50</cc:Illuminant>',
        '          <cc:Observer>2_Degree</cc:Observer>',
        '          <cc:Method>E308_Table6</cc:Method>',
        '        </cc:TristimulusSpec>',
        '        <cc:MeasurementSpec>',
        '          <cc:MeasurementType>Spectrum_Reflectance</cc:MeasurementType>',
        '          <cc:GeometryChoice>',
        '            <cc:SingleAngle>',
        '              <cc:SingleAngleConfiguration>Annular</cc:SingleAngleConfiguration>',
        '              <cc:IlluminationAngle>45</cc:IlluminationAngle>',
        '              <cc:MeasurementAngle>0.0</cc:MeasurementAngle>',
        '            </cc:SingleAngle>',
        '          </cc:GeometryChoice>',
        '        </cc:MeasurementSpec>',
        '      </cc:ColorSpecification>',
        '    </cc:ColorSpecificationCollection>',
        '  </cc:Resources>',
        '</cc:CxF>',
      ];
      return '﻿' + lines.join('\r\n');
    },
  },

  // Adobe Color Book (Photoshop "Color Books"; also read by RIPs that import Adobe colour book libraries).
  // Binary, big-endian: '8BCB', version 1, book id, 4 UTF-16 strings (uint32 length in characters, no terminator),
  // colour count, page size, page key, colour model (7 = Lab), then per colour: name, 6-character ASCII code and
  // 3 bytes L*·255/100, a*+128, b*+128; trailer 'spflspot'. Layout as in the @atesgoral/acb encoder (ISC).
  // Lab is stored with 8 bits per channel: L* in steps of 100/255, a*/b* in whole numbers – see quantize().
  acb: {
    label: 'Adobe Color Book',
    ext: 'acb',
    mime: 'application/octet-stream',
    precision: 'L* in steps of 0.4 and a*/b* as whole numbers',
    quantize: ([L, a, b]) => [Math.round((clamp(L, 0, 100) * 255) / 100) * 100 / 255, Math.round(clamp(a, -128, 127)), Math.round(clamp(b, -128, 127))],
    build({ library, colours, description = '', id = bookId(library) }) {
      const out = [];
      const u16 = (v) => out.push((v >> 8) & 0xff, v & 0xff);
      const str = (s) => {
        s = String(s);
        out.push((s.length >>> 24) & 0xff, (s.length >>> 16) & 0xff, (s.length >>> 8) & 0xff, s.length & 0xff);
        for (let i = 0; i < s.length; i++) u16(s.charCodeAt(i));
      };
      const ascii = (s) => { for (const c of s) out.push(c.charCodeAt(0) & 0x7f); };
      ascii('8BCB'); u16(1); u16(id);
      str(library); str(''); str(''); str(description);
      u16(colours.length); u16(Math.max(1, Math.min(9, colours.length))); u16(1); u16(7);
      colours.forEach(({ name, lab }, i) => {
        str(name);
        ascii(`SD${String(i + 1).padStart(4, '0')}`);
        out.push(Math.round((clamp(lab[0], 0, 100) * 255) / 100), Math.round(clamp(lab[1], -128, 127)) + 128, Math.round(clamp(lab[2], -128, 127)) + 128);
      });
      ascii('spflspot');
      return Uint8Array.from(out);
    },
  },

  // Epson Edge Print colour collection (.epcc) – format taken from collections exported by Edge Print: UTF-16LE text
  // with a BOM and CRLF lines: 'EpsonEdgePrint', '200', '0', collection name, colour count, then one line per colour
  // '0,<name length>,<name>,<colour type>,<value count>,<values ;-separated>' – type 0 = L*a*b* (3 values),
  // type 1 = CMYK (4 values). Values are written with at most one decimal, as Edge Print does.
  epcc: {
    label: 'Edge Print',
    ext: 'epcc',
    mime: 'application/octet-stream',
    precision: 'values with one decimal',
    quantize: (lab) => lab.map((v) => Math.round(v * 10) / 10),
    build({ library, colours }) {
      const num = (v) => String(Math.round(v * 10) / 10 + 0); // 42, 15.4 (and never "-0")
      const lines = ['EpsonEdgePrint', '200', '0', String(library), String(colours.length),
        ...colours.map(({ name, lab }) => `0,${String(name).length},${name},0,3,${lab.map(num).join(';')}`)];
      const text = lines.map((l) => `${l}\r\n`).join('');
      const out = new Uint8Array(2 + text.length * 2);
      out[0] = 0xff; out[1] = 0xfe;
      for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[2 + 2 * i] = c & 0xff; out[3 + 2 * i] = c >> 8; }
      return out;
    },
  },

  // Roland VersaWorks 6 – format copied from a library exported by VersaWorks (strVersion 4.3.0.0).
  versaworks: {
    label: 'VersaWorks .spot',
    ext: 'spot',
    mime: 'application/xml',
    build({ library, colours }) {
      const items = colours.map(({ name, lab }) =>
        `<Lab16SpotColor name="${xmlEsc(name)}" flags="0" redirectLibraryName="" redirectColorName="">` +
        `<L VALUE="${lab[0].toFixed(2)}"/><a VALUE="${lab[1].toFixed(2)}"/><b VALUE="${lab[2].toFixed(2)}"/></Lab16SpotColor>`).join('');
      return '<?xml version="1.0" encoding="UTF-8"?>\n<SpotColorLibraryList strVersion="4.3.0.0">' +
        `<LabSpotColorLibrary name="${xmlEsc(library)}"><m_eMakerType>0</m_eMakerType><m_bUseLibrary>false</m_bUseLibrary>` +
        `${items}</LabSpotColorLibrary></SpotColorLibraryList>\n`;
    },
  },
};

// ---------------------------------------------------------------- import
/**
 * Read a spot colour library file (CxF3 .cxf, Adobe Color Book .acb, Edge Print .epcc, VersaWorks .spot) into
 * { format, library, colours: [{ name, lab }], skipped: [names] } with Lab D50 / 2°.
 * Colours without usable D50/2° data are reported in `skipped`.
 */
export function readLibrary(bytes, fileName = '') {
  const notALibrary = (why = '') => new Error(`${fileName || 'The file'} is not a CxF, Adobe Color Book, Edge Print or VersaWorks library${why}`);
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (String.fromCharCode(...bytes.subarray(0, 4)) === '8BCB') return readAcb(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (text.startsWith('EpsonEdgePrint')) return readEpcc(text);
  }
  const text = new TextDecoder().decode(bytes);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw notALibrary();
  const root = doc.documentElement.localName;
  if (root === 'CxF') {
    // CxF often carries no library name (Digital Factory's files don't): use the file name
    const lib = readCxf(doc);
    return { ...lib, library: lib.library || fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '') };
  }
  if (root === 'SpotColorLibraryList') return readVersaWorks(doc);
  throw notALibrary(` (root element <${root}>)`);
}

const byLocal = (el, name) => [...el.getElementsByTagName('*')].filter((e) => e.localName === name);
const child = (el, name) => [...el.children].find((e) => e.localName === name);
const num = (el, name) => parseFloat(child(el, name)?.textContent);

function readVersaWorks(doc) {
  const libs = byLocal(doc, 'LabSpotColorLibrary');
  const colours = byLocal(doc, 'Lab16SpotColor').map((c) => ({
    name: c.getAttribute('name') ?? '',
    lab: ['L', 'a', 'b'].map((k) => parseFloat(child(c, k)?.getAttribute('VALUE'))),
  }));
  const ok = colours.filter((c) => c.name && c.lab.every(Number.isFinite));
  return { format: 'versaworks', library: libs[0]?.getAttribute('name') ?? '', colours: ok, skipped: colours.filter((c) => !ok.includes(c)).map((c) => c.name || '(unnamed)') };
}

function readCxf(doc) {
  // colour specifications: id -> { illuminant, observer, start, increment }
  const specs = {};
  for (const s of byLocal(doc, 'ColorSpecification')) {
    const tri = child(s, 'TristimulusSpec');
    const range = byLocal(s, 'WavelengthRange')[0];
    specs[s.getAttribute('Id')] = {
      illuminant: tri ? child(tri, 'Illuminant')?.textContent.trim() : null,
      observer: tri ? child(tri, 'Observer')?.textContent.trim() : null,
      start: range ? parseFloat(range.getAttribute('StartWL')) : NaN,
      increment: range ? parseFloat(range.getAttribute('Increment')) : NaN,
    };
  }
  const isD50 = (sp) => !sp || ((!sp.illuminant || /^D50$/i.test(sp.illuminant)) && (!sp.observer || /^2/.test(sp.observer)));
  const colours = [], skipped = [];
  for (const o of byLocal(doc, 'Object')) {
    const name = o.getAttribute('Name') ?? '';
    const values = child(o, 'ColorValues');
    let lab = null;
    if (values) {
      // 1st choice: CIELab under D50 / 2°
      for (const v of [...values.children].filter((e) => e.localName === 'ColorCIELab')) {
        if (!isD50(specs[v.getAttribute('ColorSpecification')])) continue;
        const l = ['L', 'A', 'B'].map((k) => num(v, k));
        if (l.every(Number.isFinite)) { lab = l; break; }
      }
      // 2nd choice: a reflectance spectrum covering 400–700 nm, converted at D50 / 2°
      if (!lab) {
        for (const v of [...values.children].filter((e) => e.localName === 'ReflectanceSpectrum')) {
          const sp = specs[v.getAttribute('ColorSpecification')] ?? {};
          const start = parseFloat(v.getAttribute('StartWL')) || sp.start || 400;
          const inc = sp.increment || 10;
          const r = v.textContent.trim().split(/\s+/).map(Number);
          // value at wavelength nm by linear interpolation; NaN outside the measured range
          const at = (nm) => {
            const pos = (nm - start) / inc, i = Math.floor(pos), frac = pos - i;
            if (i < 0 || i >= r.length || (frac > 0 && i + 1 >= r.length)) return NaN;
            return frac ? r[i] + frac * (r[i + 1] - r[i]) : r[i];
          };
          const scale = Math.max(...r) > 1.5 ? 100 : 1; // spectra given in percent
          const s31 = Array.from({ length: 31 }, (_, i) => at(400 + 10 * i));
          if (s31.every(Number.isFinite)) { lab = spectrumToLab(s31.map((x) => x / scale), 0, 2); break; }
        }
      }
    }
    if (name && lab) colours.push({ name, lab }); else skipped.push(name || '(unnamed)');
  }
  const info = byLocal(doc, 'FileInformation')[0];
  const library = (info && child(info, 'Description')?.textContent.split(' – ')[0].trim()) || '';
  return { format: 'cxf', library, colours, skipped };
}

function readEpcc(text) {
  const lines = text.split(/\r?\n/);
  const library = lines[3] ?? '';
  const colours = [], skipped = [];
  for (const line of lines.slice(5)) {
    if (!line.trim()) continue;
    // 0,<name length>,<name>,<type>,<count>,<values>  – the length lets names contain commas
    const m = /^(\d+),(\d+),/.exec(line);
    if (!m) continue;
    const start = m[0].length, name = line.substr(start, +m[2]);
    const [type, count, values] = line.slice(start + name.length + 1).split(',');
    const v = (values ?? '').split(';').map(Number);
    if (type === '0' && count === '3' && v.length === 3 && v.every(Number.isFinite)) colours.push({ name, lab: v });
    else skipped.push(name);
  }
  return { format: 'epcc', library, colours, skipped };
}

function readAcb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 4;
  const u16 = () => { const v = dv.getUint16(p); p += 2; return v; };
  const str = () => { const n = dv.getUint32(p); p += 4; let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u16()); return s.replace(/\0+$/, ''); };
  if (u16() !== 1) throw new Error('Unsupported Adobe Color Book version');
  u16(); // book id
  const library = str().replace(/^\$\$\$\/[^=]*=/, ''), prefix = str(), postfix = str();
  str(); // description
  const count = u16(); u16(); u16();
  const model = u16();
  if (model !== 7) throw new Error('Only L*a*b* Adobe Color Books can be imported (this one is ' + ({ 0: 'RGB', 2: 'CMYK' }[model] ?? `model ${model}`) + ')');
  const colours = [];
  for (let i = 0; i < count; i++) {
    const name = str(); p += 6; // 6-character code
    const [L, a, b] = [bytes[p], bytes[p + 1], bytes[p + 2]]; p += 3;
    if (name) colours.push({ name: `${prefix}${name}${postfix}`.replace(/^\$\$\$\/[^=]*=/, ''), lab: [(L * 100) / 255, a - 128, b - 128] });
  }
  return { format: 'acb', library, colours, skipped: [] };
}
