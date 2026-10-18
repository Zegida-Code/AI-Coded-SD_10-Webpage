// Print colour matching: patch-sheet design, local printer-response model, and solving for the
// input values (Lab, CMYK or RGB) that reproduce a measured target colour on the user's printer.
//
// Method (closed loop, per round):
//   1. Patches = centre guess x0 + a 16-point design around it (centre ×2, ±step on each axis, 8 corners).
//   2. The user prints the sheet and measures every patch: y_i = Lab of patch i.
//   3. Fit an affine model  y ≈ m0 + J·(x − x0)  by least squares (J is 3×3).
//   4. Solve  J·Δx = T − m0  (bounded to the valid input range, damped if J is ill-conditioned).
//   5. The answer x* = x0 + Δx is the centre of the next, finer sheet; its centre patch verifies it.
import { deltaE2000 } from './color.js';

const LAB = { axes: ['L*', 'a*', 'b*'], min: [0, -127, -127], max: [100, 127, 127], step0: [5, 8, 8], minStep: [1, 1.5, 1.5], maxStep: [10, 16, 16], decimals: 2 };
// spot: L*a*b* patches written as named spot colours (Separation, Lab alternate) – for RIPs with a named-colour
// library. lab: plain CIE Lab objects. cmyk: DeviceCMYK numbers. rgb: an sRGB raster image (software that only accepts images).
export const MODES = {
  spot: LAB,
  lab: LAB,
  cmyk: { axes: ['C', 'M', 'Y'], min: [0, 0, 0], max: [100, 100, 100], step0: [8, 8, 8], minStep: [1.5, 1.5, 1.5], maxStep: [15, 15, 15], decimals: 2 },
  rgb: { axes: ['R', 'G', 'B'], min: [0, 0, 0], max: [255, 255, 255], step0: [14, 14, 14], minStep: [2, 2, 2], maxStep: [30, 30, 30], decimals: 0 },
};

/** Unique spot colour name of a sheet patch, e.g. SD10-K3P9-R2-07 (job id keeps old libraries from clashing). */
export const patchSpotName = (jobId, round, n) => `SD10-${jobId}-R${round}-${String(n).padStart(2, '0')}`;

// ---------------------------------------------------------------- patch design
/**
 * 16 patches around `centre` (3 values) with per-axis `step`. Order is the scan order.
 * Returns [{ n, offset:[..], x:[..] }] with x clamped to the mode's range.
 */
export function designPatches(mode, centre, step) {
  const { min, max, decimals } = MODES[mode];
  const offsets = [[0, 0, 0]];
  for (let k = 0; k < 3; k++) for (const s of [-1, 1]) { const o = [0, 0, 0]; o[k] = s; offsets.push(o); }
  const c = 0.7;
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const d of [-1, 1]) offsets.push([a * c, b * c, d * c]);
  offsets.push([0, 0, 0]); // centre again at the end: checks print/measurement consistency
  return offsets.map((o, i) => ({
    n: i + 1,
    offset: o,
    x: o.map((v, k) => roundTo(Math.min(Math.max(centre[k] + v * step[k], min[k]), max[k]), decimals)),
  }));
}

const round2 = (v) => Math.round(v * 100) / 100;
const roundTo = (v, decimals) => (decimals ? Math.round(v * 10 ** decimals) / 10 ** decimals : Math.round(v));

// ---------------------------------------------------------------- linear algebra helpers
function solve(A, b) {
  // Gaussian elimination with partial pivoting; returns null if singular.
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

const matT = (A) => A[0].map((_, j) => A.map((r) => r[j]));
const matMul = (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));

/**
 * Fit y ≈ m0 + J·(x − x0) to measured patches [{x, lab}] (least squares).
 * Returns { m0, J, rms } where J[i][k] = ∂Lab_i/∂x_k.
 */
export function fitModel(patches, x0) {
  const pts = patches.filter((p) => p.lab);
  if (pts.length < 5) throw new Error('Measure at least 5 patches first');
  const X = pts.map((p) => [1, ...p.x.map((v, k) => v - x0[k])]);
  const XtX = matMul(matT(X), X);
  const coef = [0, 1, 2].map((i) => {
    const y = pts.map((p) => p.lab[i]);
    const Xty = matT(X).map((col) => col.reduce((s, v, r) => s + v * y[r], 0));
    // tiny ridge keeps the fit stable if an axis was clamped (no variation)
    const reg = XtX.map((row, r) => row.map((v, c) => v + (r === c && r > 0 ? 1e-6 : 0)));
    const b = solve(reg, Xty);
    if (!b) throw new Error('The measurements do not vary enough to fit a model');
    return b;
  });
  const m0 = coef.map((b) => b[0]);
  const J = coef.map((b) => b.slice(1));
  let sse = 0;
  for (const p of pts) {
    const pred = predict({ m0, J }, x0, p.x);
    sse += pred.reduce((s, v, i) => s + (v - p.lab[i]) ** 2, 0);
  }
  return { m0, J, rms: Math.sqrt(sse / pts.length) };
}

export function predict(model, x0, x) {
  return model.m0.map((m, i) => m + model.J[i].reduce((s, j, k) => s + j * (x[k] - x0[k]), 0));
}

/**
 * Inputs x (within the mode's range) whose predicted Lab is closest to `target` (least squares in Lab).
 * Uses an active-set loop: axes that would leave the valid range are pinned to the bound and the rest re-solved.
 */
export function solveForTarget(mode, model, x0, target) {
  const { min, max } = MODES[mode];
  const pinned = new Map();
  let x = [...x0];
  for (let iter = 0; iter < 4; iter++) {
    const free = [0, 1, 2].filter((k) => !pinned.has(k));
    // residual after pinned axes
    const base = x0.map((v, k) => (pinned.has(k) ? pinned.get(k) : v));
    const r = target.map((t, i) => t - predict(model, x0, base)[i]);
    // least squares on free axes: (Jfᵀ Jf + λI) d = Jfᵀ r
    const Jf = model.J.map((row) => free.map((k) => row[k]));
    const JtJ = matMul(matT(Jf), Jf);
    const lambda = 1e-3 * Math.max(...JtJ.map((row, i) => row[i]), 1e-9);
    const A = JtJ.map((row, i) => row.map((v, j) => v + (i === j ? lambda : 0)));
    const Jtr = matT(Jf).map((col) => col.reduce((s, v, i) => s + v * r[i], 0));
    const d = free.length ? solve(A, Jtr) : [];
    if (!d) throw new Error('Could not solve for the target');
    x = base.map((v, k) => (pinned.has(k) ? v : v + d[free.indexOf(k)]));
    const out = free.filter((k) => x[k] < min[k] - 1e-9 || x[k] > max[k] + 1e-9);
    if (!out.length) break;
    for (const k of out) pinned.set(k, x[k] < min[k] ? min[k] : max[k]);
  }
  x = x.map((v, k) => roundTo(Math.min(Math.max(v, min[k]), max[k]), MODES[mode].decimals));
  const predicted = predict(model, x0, x);
  return { x, predicted, predictedDeltaE: deltaE2000(target, predicted), clamped: x.some((v, k) => v <= min[k] || v >= max[k]) };
}

/**
 * Step for the next round: follows the size of the correction just made – wider when the estimate moved a lot
 * (the local model was extrapolating), finer as it settles – within [minStep, maxStep].
 */
export function nextStep(mode, prevStep, correction) {
  const { minStep, maxStep } = MODES[mode];
  return prevStep.map((s, k) => round2(Math.min(Math.max(Math.abs(correction[k]) * 0.6, s / 2, minStep[k]), maxStep[k])));
}

/** Analyse a measured round: model, recommendation, best patch, centre check. */
export function analyseRound(round, target) {
  const model = fitModel(round.patches, round.centre);
  const sol = solveForTarget(round.mode, model, round.centre, target);
  const measured = round.patches.filter((p) => p.lab);
  const scored = measured.map((p) => ({ ...p, dE: deltaE2000(target, p.lab) }));
  const best = scored.reduce((a, b) => (b.dE < a.dE ? b : a));
  const centres = scored.filter((p) => p.offset.every((v) => v === 0));
  const centreDE = centres.length ? centres.reduce((s, p) => s + p.dE, 0) / centres.length : null;
  const repeat = centres.length === 2 ? deltaE2000(centres[0].lab, centres[1].lab) : null;
  const correction = sol.x.map((v, k) => v - round.centre[k]);
  // The model is only trustworthy inside the sheet's patch range; beyond it the prediction is a rough estimate.
  const extrapolated = correction.some((c, k) => Math.abs(c) > round.step[k] * 1.05);
  return { model, ...sol, best, centreDE, repeatability: repeat, correction, extrapolated };
}


// ---------------------------------------------------------------- several readings per patch
/** Mean Lab of several readings and their spread (largest ΔE00 of a reading from the mean). */
export function averageReadings(reads) {
  const lab = [0, 1, 2].map((i) => reads.reduce((s, r) => s + r[i], 0) / reads.length);
  return { lab, spread: Math.max(0, ...reads.map((r) => deltaE2000(lab, r))) };
}

// ---------------------------------------------------------------- printable sheet
const PAPER = { a4: [595.28, 841.89], letter: [612, 792] };
const MM = 72 / 25.4;

function fmtValues(mode, x, kFixed) {
  if (mode === 'cmyk') return `C${x[0].toFixed(1)} M${x[1].toFixed(1)} Y${x[2].toFixed(1)} K${kFixed.toFixed(1)}`;
  if (mode === 'rgb') return `R${x[0]} G${x[1]} B${x[2]}`;
  return `L${x[0].toFixed(1)} a${x[1].toFixed(1)} b${x[2].toFixed(1)}`;
}

const NOTES = {
  spot: ['Patches are named spot colours (CIE L*a*b* D50 alternates). Scan the patches in number order.',
    'Print through the RIP exactly like the final job (spot colour handling, media, profile, intent).',
    'If you imported the spot library for this sheet into the RIP, enable it before printing.'],
  lab: ['Patch values are CIE L*a*b* (D50). Scan the patches in number order.',
    'Lab patches are converted by the RIP / printer colour management - use the same path for the final job.'],
  cmyk: (k) => [`Patch values are CMYK percentages (K fixed at ${k.toFixed(1)}%). Scan the patches in number order.`,
    'If your print dialog offers it, turn colour management off / preserve CMYK numbers - exactly as for the final job.'],
  rgb: ['Patch values are sRGB (0-255) in a 300 dpi image. Scan the patches in number order.',
    'Use the same software, colour settings, substrate and pre-treatment as the final job.'],
};

/** Sheet layout in PDF points (origin bottom-left): texts and 16 patch boxes, shared by the PDF and the PNG. */
function sheetLayout({ mode, patches, target, round, paper = 'a4', created = new Date(), kFixed = 0, title = 'SD-10 print match' }) {
  const [W, H] = PAPER[paper] ?? PAPER.a4;
  const margin = 15 * MM;
  const texts = [];
  const t = (x, y, size, str, bold = false) => texts.push({ x, y, size, str, bold });
  let y = H - margin;
  t(margin, y - 14, 16, title, true);
  t(W - margin - 170, y - 12, 9, `Round ${round}   ${created.toISOString().slice(0, 16).replace('T', ' ')}`);
  y -= 32;
  t(margin, y, 9, `Target (measured, D50/2 deg): L* ${target[0].toFixed(2)}  a* ${target[1].toFixed(2)}  b* ${target[2].toFixed(2)}`);
  const notes = mode === 'cmyk' ? NOTES.cmyk(kFixed) : NOTES[mode];
  notes.forEach((n, i) => { y -= i ? 11 : 13; t(margin, y, i ? 8 : 9, n); });
  y -= 11;
  t(margin, y, 8, 'Print at 100% / actual size. Let the ink dry - transferred or cured prints: process like production, then scan.');
  y -= 18;

  const cols = 4, cell = (W - 2 * margin) / cols;
  const size = Math.min(30 * MM, cell - 6 * MM);
  const rowH = size + 26 + (mode === 'spot' ? 7 : 0);
  const boxes = patches.map((p, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = margin + col * cell + (cell - size) / 2;
    const top = y - row * rowH;
    t(x, top - size - 10, 8, `#${p.n}${p.offset.every((v) => v === 0) ? ' (centre)' : ''}`, true);
    t(x, top - size - 19, 6.5, fmtValues(mode, p.x, kFixed));
    if (mode === 'spot') t(x, top - size - 26, 6.5, p.name ?? '');
    return { x, y: top - size, size, patch: p };
  });
  t(margin, margin - 2, 7, 'Generated by SD-10 Web Console (sd-10.com) - Print match. Measure with the SD-10 in the Print match view.');
  return { W, H, texts, boxes };
}

function pdfText(s) {
  return '(' + String(s).replace(/[^\x20-\x7e]/g, '?').replace(/([()\\])/g, '\\$1') + ')';
}
/** PDF name object: regular characters as-is, everything else #xx-escaped. */
const pdfName = (s) => '/' + String(s).replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));
const LAB_CS = '[/Lab << /WhitePoint [0.9642 1 0.8249] /Range [-128 127 -128 127] >>]';

/**
 * Build the printable sheet as a PDF (Uint8Array). Patches are DeviceCMYK (mode 'cmyk'), DeviceRGB (mode 'rgb'),
 * a CIE Lab colour space with a D50 white point (mode 'lab'), or one Separation – a named spot colour – per patch
 * with that Lab colour as its alternate (mode 'spot', patch.name = spot name). Pure PDF 1.4, standard Helvetica fonts.
 */
export function buildSheetPdf(opts) {
  const { mode, kFixed = 0 } = opts;
  const { W, H, texts, boxes } = sheetLayout(opts);
  const f = (v) => v.toFixed(2);
  const out = ['0 g'];
  const spaces = [`/CS0 ${LAB_CS}`];
  for (const { x, y, size, patch: p } of boxes) {
    if (mode === 'cmyk') out.push(`${f(p.x[0] / 100)} ${f(p.x[1] / 100)} ${f(p.x[2] / 100)} ${f(kFixed / 100)} k`);
    else if (mode === 'rgb') out.push(`${(p.x[0] / 255).toFixed(4)} ${(p.x[1] / 255).toFixed(4)} ${(p.x[2] / 255).toFixed(4)} rg`);
    else if (mode === 'spot') {
      // tint 0 = paper (L* 100), tint 1 = the patch colour; the patch prints at 100 % tint
      spaces.push(`/SP${p.n} [/Separation ${pdfName(p.name)} ${LAB_CS} << /FunctionType 2 /Domain [0 1] /C0 [100 0 0] /C1 [${p.x.map(f).join(' ')}] /N 1 >>]`);
      out.push(`/SP${p.n} cs 1 scn`);
    } else out.push(`/CS0 cs ${f(p.x[0])} ${f(p.x[1])} ${f(p.x[2])} sc`);
    out.push(`${f(x)} ${f(y)} ${f(size)} ${f(size)} re f`);
    out.push('0 G 0.4 w', `${f(x)} ${f(y)} ${f(size)} ${f(size)} re S`, '0 g');
  }
  for (const t of texts) out.push(`BT /${t.bold ? 'F2' : 'F1'} ${t.size} Tf ${f(t.x)} ${f(t.y)} Td ${pdfText(t.str)} Tj ET`);

  const content = out.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> /ColorSpace << ${spaces.join(' ')} >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, (c) => c.charCodeAt(0) & 0xff);
}

// ---------------------------------------------------------------- PNG sheet (raster-only workflows)
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Tag a PNG as sRGB at `dpi`: drops colour/resolution chunks the encoder wrote (iCCP, sRGB, gAMA, cHRM, pHYs)
 * and inserts sRGB (perceptual) + pHYs right after IHDR.
 */
export function tagPng(png, dpi = 300) {
  const ppm = Math.round(dpi / 0.0254);
  const phys = new Uint8Array(9);
  const pv = new DataView(phys.buffer);
  pv.setUint32(0, ppm); pv.setUint32(4, ppm); phys[8] = 1; // unit: metre
  const parts = [png.subarray(0, 8)];
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let i = 8; i < png.length;) {
    const len = dv.getUint32(i), type = String.fromCharCode(...png.subarray(i + 4, i + 8));
    if (!['iCCP', 'sRGB', 'gAMA', 'cHRM', 'pHYs'].includes(type)) parts.push(png.subarray(i, i + 12 + len));
    if (type === 'IHDR') parts.push(pngChunk('sRGB', Uint8Array.of(0)), pngChunk('pHYs', phys));
    i += 12 + len;
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The sheet as an sRGB PNG at `dpi` (patch x = [R, G, B] 0..255). Browser only (canvas). */
export async function buildSheetPng(opts, dpi = 300) {
  const { W, H, texts, boxes } = sheetLayout({ ...opts, mode: 'rgb' });
  const k = dpi / 72;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * k); canvas.height = Math.round(H * k);
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, canvas.width, canvas.height);
  for (const { x, y, size, patch: p } of boxes) {
    // whole pixels, so a patch has no blended edge colours
    const px = Math.round(x * k), py = Math.round((H - y - size) * k), ps = Math.round(size * k);
    g.fillStyle = `rgb(${p.x[0]}, ${p.x[1]}, ${p.x[2]})`; g.fillRect(px, py, ps, ps);
    const lw = Math.max(1, Math.round(0.4 * k));
    g.fillStyle = '#000000';
    g.fillRect(px - lw, py - lw, ps + 2 * lw, lw); g.fillRect(px - lw, py + ps, ps + 2 * lw, lw);
    g.fillRect(px - lw, py, lw, ps); g.fillRect(px + ps, py, lw, ps);
  }
  g.fillStyle = '#000000'; g.textBaseline = 'alphabetic';
  for (const t of texts) { g.font = `${t.bold ? 'bold ' : ''}${t.size * k}px Helvetica, Arial, sans-serif`; g.fillText(t.str, t.x * k, (H - t.y) * k); }
  const url = canvas.toDataURL('image/png');
  if (!url.startsWith('data:image/png;base64,')) throw new Error('Could not encode the PNG');
  return tagPng(Uint8Array.from(atob(url.slice(22)), (c) => c.charCodeAt(0)), dpi);
}
