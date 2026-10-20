// Print colour matching: patch-sheet design, local printer-response model, and solving for the
// input values (Lab, CMYK or RGB) that reproduce a measured target colour on the user's printer.
//
// Method (closed loop, per round):
//   1. Patches = centre guess x0 + a design around it: 16 points (centre ×2, ±step on each axis, 8 corners)
//      or 8 (no corners).
//   2. The user prints the sheet and measures every patch: y_i = Lab of patch i.
//   3. Fit an affine model  y ≈ m0 + J·(x − x0)  by least squares (J is 3×3).
//   4. Solve  J·Δx = T − m0  in weighted least squares (lightness weight from the ΔE formula), bounded to a trusted
//      box around x0 and the valid input range, damped if J is ill-conditioned.
//   5. The answer x* = x0 + Δx is the centre of the next, finer sheet; its centre patch verifies it. A patch that
//      already measured closer than the prediction is recommended instead.
import { deltaE2000, deltaECMC, spectrumToLab } from './color.js';

/**
 * Colour difference used to judge a match. lWeight scales lightness in the solver's least squares, so the
 * textile formulas (which forgive lightness differences) also aim for hue and chroma first.
 */
export const DE_FORMULAS = {
  de00: { label: 'ΔE00', name: 'ΔE00 (graphic arts)', fn: (r, s) => deltaE2000(r, s), lWeight: 1 },
  de00t: { label: 'ΔE00 2:1:1', name: 'ΔE00 2:1:1 (textiles)', fn: (r, s) => deltaE2000(r, s, 2), lWeight: 0.5 },
  cmc21: { label: 'ΔE CMC 2:1', name: 'ΔE CMC 2:1 (textiles)', fn: (r, s) => deltaECMC(r, s, 2, 1), lWeight: 0.5 },
};
const formulaOf = (key) => DE_FORMULAS[key] ?? DE_FORMULAS.de00;

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
/** Patches per colour: 'full' = 16 (centre ×2, ±step on each axis, 8 corners), 'compact' = 8 (no corners). */
export const DESIGNS = { full: 16, compact: 8 };

/**
 * Patches around `centre` (3 values) with per-axis `step`. Order is the scan order.
 * Returns [{ n, offset:[..], x:[..] }] with x clamped to the mode's range.
 */
export function designPatches(mode, centre, step, design = 'full') {
  const { min, max, decimals } = MODES[mode];
  const offsets = [[0, 0, 0]];
  for (let k = 0; k < 3; k++) for (const s of [-1, 1]) { const o = [0, 0, 0]; o[k] = s; offsets.push(o); }
  const c = 0.7;
  // the corners make the fit robust to curvature and noise; the compact design (7 distinct points) still determines it
  if (design !== 'compact') for (const a of [-1, 1]) for (const b of [-1, 1]) for (const d of [-1, 1]) offsets.push([a * c, b * c, d * c]);
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
 * Inputs x within [lo, hi] (default: the mode's range) whose predicted Lab is closest to `target` (least squares in
 * Lab, each Lab component scaled by `weights`); `dE` scores the prediction. Uses an active-set loop: axes that would
 * leave the box are pinned to the bound and the rest re-solved.
 */
export function solveForTarget(mode, model, x0, target, { lo = MODES[mode].min, hi = MODES[mode].max, weights = [1, 1, 1], dE = deltaE2000 } = {}) {
  const { min, max } = MODES[mode];
  const pinned = new Map();
  let x = [...x0];
  for (let iter = 0; iter < 4; iter++) {
    const free = [0, 1, 2].filter((k) => !pinned.has(k));
    // residual after pinned axes
    const base = x0.map((v, k) => (pinned.has(k) ? pinned.get(k) : v));
    const r = target.map((t, i) => (t - predict(model, x0, base)[i]) * weights[i]);
    // weighted least squares on free axes: (Jfᵀ Jf + λI) d = Jfᵀ r  (rows of J and r scaled by the Lab weights)
    const Jf = model.J.map((row, i) => free.map((k) => row[k] * weights[i]));
    const JtJ = matMul(matT(Jf), Jf);
    const lambda = 1e-3 * Math.max(...JtJ.map((row, i) => row[i]), 1e-9);
    const A = JtJ.map((row, i) => row.map((v, j) => v + (i === j ? lambda : 0)));
    const Jtr = matT(Jf).map((col) => col.reduce((s, v, i) => s + v * r[i], 0));
    const d = free.length ? solve(A, Jtr) : [];
    if (!d) throw new Error('Could not solve for the target');
    x = base.map((v, k) => (pinned.has(k) ? v : v + d[free.indexOf(k)]));
    const out = free.filter((k) => x[k] < lo[k] - 1e-9 || x[k] > hi[k] + 1e-9);
    if (!out.length) break;
    for (const k of out) pinned.set(k, x[k] < lo[k] ? lo[k] : hi[k]);
  }
  x = x.map((v, k) => roundTo(Math.min(Math.max(v, lo[k]), hi[k]), MODES[mode].decimals));
  const predicted = predict(model, x0, x);
  return { x, predicted, predictedDeltaE: dE(target, predicted), clamped: x.some((v, k) => v <= min[k] || v >= max[k]) };
}

/**
 * Step for the next round: follows the size of the correction just made – wider when the estimate moved a lot
 * (the local model was extrapolating), finer as it settles – within [minStep, maxStep].
 */
export function nextStep(mode, prevStep, correction) {
  const { minStep, maxStep } = MODES[mode];
  return prevStep.map((s, k) => round2(Math.min(Math.max(Math.abs(correction[k]) * 0.6, s / 2, minStep[k]), maxStep[k])));
}

/**
 * How far one round may move from the sheet centre: TRUST_STEPS patch steps, but at least twice the mode's largest step
 * (the local model is only fitted around the centre; this stops runaway jumps to the ends of the range).
 */
export const TRUST_STEPS = 3;
export const trustRadius = (mode, step) => step.map((s, k) => Math.max(TRUST_STEPS * s, 2 * MODES[mode].maxStep[k]));

/**
 * Analyse a measured round: model, recommendation, best patch, centre check.
 * The recommendation stays within trustRadius() of the centre (near a gamut edge the printer barely responds, and an
 * unbounded solve would jump to the ends of the range), and it is never predicted worse than the best patch actually
 * measured – then that patch is recommended instead (source 'best-patch'). `formula` is a DE_FORMULAS key.
 */
export function analyseRound(round, target, formula = 'de00') {
  const { min, max } = MODES[round.mode];
  const { fn: dE, lWeight } = formulaOf(formula);
  const model = fitModel(round.patches, round.centre);
  const R = trustRadius(round.mode, round.step);
  const lo = round.centre.map((c, k) => Math.max(min[k], c - R[k]));
  const hi = round.centre.map((c, k) => Math.min(max[k], c + R[k]));
  const sol = solveForTarget(round.mode, model, round.centre, target, { lo, hi, weights: [lWeight, 1, 1], dE });
  const measured = round.patches.filter((p) => p.lab);
  const scored = measured.map((p) => ({ ...p, dE: dE(target, p.lab) }));
  const best = scored.reduce((a, b) => (b.dE < a.dE ? b : a));
  const centres = scored.filter((p) => p.offset.every((v) => v === 0));
  const centreDE = centres.length ? centres.reduce((s, p) => s + p.dE, 0) / centres.length : null;
  const repeat = centres.length === 2 ? dE(centres[0].lab, centres[1].lab) : null;
  // the solve stopped at the edge of the trusted box (not at the mode's own limits): it wants to go further
  const trustLimited = sol.x.some((v, k) => (lo[k] > min[k] && v <= lo[k] + 1e-6) || (hi[k] < max[k] && v >= hi[k] - 1e-6));
  let rec = { ...sol, source: 'model' };
  if (best.dE <= sol.predictedDeltaE) {
    rec = { x: [...best.x], predicted: best.lab, predictedDeltaE: best.dE, clamped: best.x.some((v, k) => v <= min[k] || v >= max[k]), source: 'best-patch' };
  }
  const correction = rec.x.map((v, k) => v - round.centre[k]);
  // The model is only trustworthy inside the sheet's patch range; beyond it the prediction is a rough estimate.
  const extrapolated = rec.source === 'model' && correction.some((c, k) => Math.abs(c) > round.step[k] * 1.05);
  // Nothing within reach is predicted to get close: the reference is probably outside the printable gamut.
  // (the model's own optimum is inside the trusted box, or it predicts nothing better than a patch already measured)
  const gamutLimited = rec.predictedDeltaE > 2 && (rec.source === 'best-patch' || !trustLimited);
  return { model, ...rec, best, centreDE, repeatability: repeat, correction, extrapolated, trustLimited: trustLimited && rec.source === 'model', gamutLimited };
}


// ---------------------------------------------------------------- metamerism
/** Lights a print is checked under besides D50 (illuminant ids as in the SD-10 weighting tables). */
export const CHECK_LIGHTS = [
  { key: 'D65', id: 1, name: 'Daylight (D65)' },
  { key: 'A', id: 2, name: 'Warm / incandescent light (A)' },
  { key: 'F11', id: 27, name: 'Tri-band shop light (F11, LED-like)' },
  { key: 'F2', id: 18, name: 'Cool white fluorescent (F2)' },
];

/**
 * How a match made under D50 holds up under other lights (2° observer), from the measured spectra.
 * For each light: dE = the difference you would see under it; mi = the metamerism index (CIE 15, additive correction:
 * the D50 difference is removed first), i.e. how much the two colours drift apart because their spectra differ.
 */
export function metamerism(refSpectrum, smpSpectrum, formula = 'de00') {
  const { fn: dE } = formulaOf(formula);
  const r0 = spectrumToLab(refSpectrum, 0, 2), s0 = spectrumToLab(smpSpectrum, 0, 2);
  const corr = r0.map((v, i) => v - s0[i]);
  const lights = CHECK_LIGHTS.map((l) => {
    const r = spectrumToLab(refSpectrum, l.id, 2), s = spectrumToLab(smpSpectrum, l.id, 2);
    return { ...l, dE: dE(r, s), mi: dE(r, s.map((v, i) => v + corr[i])) };
  });
  return { d50: dE(r0, s0), lights, worst: lights.reduce((a, b) => (b.mi > a.mi ? b : a)) };
}

// ---------------------------------------------------------------- several readings per patch
/** Mean Lab of several readings and their spread (largest ΔE00 of a reading from the mean). */
export function averageReadings(reads) {
  const lab = [0, 1, 2].map((i) => reads.reduce((s, r) => s + r[i], 0) / reads.length);
  return { lab, spread: Math.max(0, ...reads.map((r) => deltaE2000(lab, r))) };
}

// ---------------------------------------------------------------- printable sheet
/** Media sizes in mm (width × height). Any other size can be passed as [w, h]. */
export const MEDIA = { a4: [210, 297], letter: [215.9, 279.4], a3: [297, 420], tabloid: [279.4, 431.8] };
const PT = 72 / 25.4; // PDF points per mm

function fmtValues(mode, x, kFixed) {
  if (mode === 'cmyk') return `C${x[0].toFixed(1)} M${x[1].toFixed(1)} Y${x[2].toFixed(1)} K${kFixed.toFixed(1)}`;
  if (mode === 'rgb') return `R${x[0]} G${x[1]} B${x[2]}`;
  return `L${x[0].toFixed(1)} a${x[1].toFixed(1)} b${x[2].toFixed(1)}`;
}

const NOTES = {
  spot: 'Patches are named spot colours (CIE L*a*b* D50 alternates). Print through the RIP exactly like the final job (spot colour handling, media, profile, intent). If you imported the spot library for this sheet into the RIP, enable it before printing.',
  lab: 'Patch values are CIE L*a*b* (D50). Lab patches are converted by the RIP / printer colour management - use the same path for the final job.',
  cmyk: 'Patch values are CMYK percentages (K fixed per colour). If your print dialog offers it, turn colour management off / preserve CMYK numbers - exactly as for the final job.',
  rgb: 'Patch values are sRGB (0-255). Use the same software, colour settings, substrate and pre-treatment as the final job.',
};

/** Width of the text column on wide, short media, where the sheet's text sits beside the patches instead of above. */
const SIDE_MM = 80;

/**
 * Sheet layout in PDF points (origin bottom-left), shared by the PDF and the PNG.
 * opts: { mode, groups: [{ label, target, patches, kFixed }], round (sheet number), media: [w, h] mm | paper: key,
 *         patchMm, created, title }  – or a single colour as { patches, target, kFixed }.
 * Colours follow each other; each starts on a new row under a heading with its target, and the patches flow onto
 * further pages when the media is full. On wide, short media (wider than 1.5 × its height) the title, notes and footer
 * go into a column at the left and the patches use the full height beside it.
 * Returns { W, H, side (true when the text is in the side column), pages: [{ texts, boxes }] }.
 */
export function sheetLayout(opts) {
  const { mode, round = 1, created = new Date(), title = 'SD-10 print match', patchMm = 25 } = opts;
  const groups = opts.groups ?? [{ label: '', target: opts.target, patches: opts.patches, kFixed: opts.kFixed ?? 0 }];
  const [wMm, hMm] = opts.media ?? MEDIA[opts.paper] ?? MEDIA.a4;
  const W = wMm * PT, H = hMm * PT;
  const margin = Math.min(Math.max(Math.min(wMm, hMm) * 0.05, 5), 15) * PT;
  const usableW = W - 2 * margin;
  const size = patchMm * PT;
  // 20 mm and larger: number, values (and spot name) under each patch; smaller patches only carry their number
  const detailed = patchMm >= 20;
  const gap = detailed ? Math.max(4 * PT, 24 * PT - size) : 3 * PT;
  const labelH = detailed ? (mode === 'spot' ? 30 : 23) : 12;
  const rowH = size + labelH;
  const headH = 14;
  const footerPt = 6.5, footerH = 12;
  const colsIn = (width) => Math.floor((width + gap) / (size + gap) + 1e-9); // tolerance: a row sized to fit exactly must fit

  const chars = (pt, width) => Math.max(10, Math.floor(width / (pt * 0.5))); // Helvetica averages ~0.5 em per character
  const fit = (str, pt, width) => (str.length > chars(pt, width) ? str.slice(0, chars(pt, width) - 3) + '...' : str);
  const wrap = (str, pt, width) => {
    const lines = [];
    let line = '';
    for (const word of str.split(' ')) {
      if (line && (line + ' ' + word).length > chars(pt, width)) { lines.push(line); line = word; } else line = line ? line + ' ' + word : word;
    }
    if (line) lines.push(line);
    return lines;
  };
  const createdText = created.toISOString().slice(0, 16).replace('T', ' ');
  const notes = `${NOTES[mode]} Print at 100% / actual size. Let the ink dry - transferred or cured prints: process like production, then scan.`;
  const headingText = (g, cont) => {
    const lab = g.target ? `target L* ${g.target[0].toFixed(2)}  a* ${g.target[1].toFixed(2)}  b* ${g.target[2].toFixed(2)} (D50/2 deg)` : '';
    return `${g.label ? g.label + (cont ? ' (continued)' : '') + ' - ' : ''}${lab}`;
  };
  /** The text above the patches (normal layout): [{ pt, str, bold, lead }]; lead = height the line takes. */
  const headerLines = (firstPage, width) => {
    if (!firstPage) return [{ pt: 9, str: fit(`${title} - sheet ${round} (continued)`, 9, width), bold: true, lead: 18 }];
    const titlePt = Math.max(10, Math.min(16, width / 20));
    return [
      { pt: titlePt, str: fit(title, titlePt, width), bold: true, lead: titlePt + 9 },
      ...wrap(`Sheet ${round}   ${createdText}   ${patchMm} mm patches - scan them in number order`, 8, width).map((str) => ({ pt: 8, str, lead: 11 })),
      ...wrap(notes, 7, width).map((str) => ({ pt: 7, str, lead: 9 })),
    ];
  };
  /**
   * The compact text of the side column: a smaller title, the sheet line carrying the page number (no separate
   * footer), the colour and its target when the sheet holds one colour, then the notes (first page only).
   */
  const sideLines = (pageNo, width) => {
    const first = pageNo === 1;
    return [
      { pt: 11, str: fit(first ? title : `${title} - sheet ${round} (continued)`, 11, width), bold: true, lead: 11 + 8 }, // hangs from the top: its size + a gap
      ...wrap(`Sheet ${round}   ${createdText}   ${patchMm} mm patches - scan them in number order   page ${pageNo} of ${PAGES} - sd-10.com`, 7.5, width)
        .map((str) => ({ pt: 7.5, str, lead: 10 })),
      ...(single ? wrap(headingText(groups[0], !first), 8.5, width).map((str) => ({ pt: 8.5, str, bold: true, lead: 12 })) : []),
      ...(first ? wrap(notes, 7, width).map((str) => ({ pt: 7, str, lead: 9 })) : []),
    ];
  };
  const blockHeight = (lines) => lines.reduce((s, l) => s + l.lead, 0) + 6;
  const PAGES = '\u0001'; // page count, filled in once the layout is done

  // Side column when the media is wide and short, still leaves room for 4+ patches per row, and the text fits.
  // It takes the width that the longest colour's single row of patches leaves free (at least SIDE_MM), so the text
  // needs few lines and the sheet can be as short as one row of patches.
  const single = groups.length === 1;
  const sideGap = 6 * PT;
  const longest = Math.max(...groups.map((g) => g.patches.length));
  const sideW = Math.max(SIDE_MM * PT, usableW - sideGap - (longest * (size + gap) - gap));
  const side = W > 1.5 * H && colsIn(usableW - sideW - sideGap) >= 4 && blockHeight(sideLines(1, sideW)) <= H - 2 * margin;
  const textW = side ? sideW : usableW;
  const areaX = side ? margin + sideW + sideGap : margin;
  const areaW = side ? usableW - sideW - sideGap : usableW;
  const cols = colsIn(areaW);
  const bottom = side ? margin : margin + footerH; // the side column carries the page number, else a footer line
  const headInArea = !(side && single); // a single colour's heading is in the side column
  const groupHeadH = headInArea ? headH : 0;
  if (cols < 1 || H - margin - bottom - (side ? 0 : 60) < groupHeadH + rowH) throw new Error(`The media is too small for ${patchMm} mm patches – choose smaller patches or larger media.`);

  const pages = [];
  let page, y;
  const t = (x, yy, pt, str, bold = false) => page.texts.push({ x, y: yy, size: pt, str, bold });
  const newPage = () => {
    page = { texts: [], boxes: [] };
    pages.push(page);
    let ty = H - margin;
    (side ? sideLines(pages.length, textW) : headerLines(pages.length === 1, textW)).forEach((l, i) => {
      t(margin, i === 0 ? ty - l.pt : ty, l.pt, l.str, l.bold); // the first line hangs from the top edge
      ty -= l.lead;
    });
    y = side ? H - margin : ty - 6;
  };
  const heading = (g, cont) => {
    if (!headInArea) return;
    t(areaX, y - 9, 8.5, fit(headingText(g, cont), 8.5, areaW), true);
    y -= headH;
  };

  newPage();
  for (const g of groups) {
    if (y - groupHeadH - rowH < bottom) newPage();
    heading(g, false);
    let col = cols, rowTop = y;
    for (const p of g.patches) {
      if (col === cols) {
        if (y - rowH < bottom) { newPage(); heading(g, true); }
        rowTop = y; y -= rowH; col = 0;
      }
      const x = areaX + col * (size + gap);
      page.boxes.push({ x, y: rowTop - size, size, patch: p, kFixed: g.kFixed ?? 0 });
      if (detailed) {
        t(x, rowTop - size - 10, 8, `#${p.n}${p.offset.every((v) => v === 0) ? ' (centre)' : ''}`, true);
        t(x, rowTop - size - 19, 6.5, fmtValues(mode, p.x, g.kFixed ?? 0));
        if (mode === 'spot') t(x, rowTop - size - 26, 6.5, p.name ?? '');
      } else t(x, rowTop - size - 9, 7, String(p.n), true);
      col++;
    }
    y -= 6;
  }
  for (const [i, pg] of pages.entries()) {
    if (side) { for (const tx of pg.texts) tx.str = tx.str.replace(PAGES, String(pages.length)); continue; }
    const long = `Generated by SD-10 Web Console (sd-10.com) - Print match - page ${i + 1} of ${pages.length}`;
    const short = `SD-10 Web Console (sd-10.com) - page ${i + 1} of ${pages.length}`; // keeps the page count on narrow media
    pg.texts.push({ x: margin, y: margin + 1, size: footerPt, bold: false, str: fit(long.length <= chars(footerPt, textW) ? long : short, footerPt, textW) });
  }
  return { W, H, side, pages };
}

/**
 * Shortest media height (whole mm) at the width of opts.media that holds the sheet on one page – or, with
 * onePage: false, that can be laid out at all (one row of patches plus the sheet's text; more pages allowed).
 * null if it does not fit even 5 m tall (e.g. patches wider than the media).
 */
export function minSheetHeight(opts, { onePage = true } = {}) {
  const [wMm] = opts.media ?? MEDIA[opts.paper] ?? MEDIA.a4;
  const fits = (hMm) => {
    try { const layout = sheetLayout({ ...opts, media: [wMm, hMm] }); return !onePage || layout.pages.length === 1; } catch { return false; }
  };
  let lo = 20, hi = 5000;
  if (!fits(hi)) return null;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (fits(mid)) hi = mid; else lo = mid + 1; }
  return lo;
}

function pdfText(s) {
  return '(' + String(s).replace(/[^\x20-\x7e]/g, '?').replace(/([()\\])/g, '\\$1') + ')';
}
/** PDF name object: regular characters as-is, everything else #xx-escaped. */
const pdfName = (s) => '/' + String(s).replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));
const LAB_CS = '[/Lab << /WhitePoint [0.9642 1 0.8249] /Range [-128 127 -128 127] >>]';

/**
 * Build the printable sheet as a PDF (Uint8Array), one page per layout page. Patches are DeviceCMYK (mode 'cmyk'),
 * DeviceRGB (mode 'rgb'), a CIE Lab colour space with a D50 white point (mode 'lab'), or one Separation – a named
 * spot colour – per patch with that Lab colour as its alternate (mode 'spot', patch.name = spot name).
 * Pure PDF 1.4, standard Helvetica fonts.
 */
export function buildSheetPdf(opts) {
  const { mode } = opts;
  const { W, H, pages } = sheetLayout(opts);
  const f = (v) => v.toFixed(2);
  const spaces = [`/CS0 ${LAB_CS}`];
  const streams = pages.map(({ texts, boxes }) => {
    const out = ['0 g'];
    for (const { x, y, size, patch: p, kFixed } of boxes) {
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
    return out.join('\n');
  });

  // objects: 1 catalog, 2 page tree, 3/4 fonts, then per page its page object and content stream
  const resources = `<< /Font << /F1 3 0 R /F2 4 0 R >> /ColorSpace << ${spaces.join(' ')} >> >>`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  streams.forEach((content, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(W)} ${f(H)}] /Contents ${6 + 2 * i} 0 R /Resources ${resources} >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
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

/**
 * The sheet as sRGB PNGs, one per layout page (patch x = [R, G, B] 0..255). Browser only (canvas).
 * Large media get a lower resolution so the canvas stays within browser limits; each PNG records its real dpi.
 * Returns [{ png, dpi }].
 */
export async function buildSheetPng(opts, dpi = 300) {
  const { W, H, pages } = sheetLayout({ ...opts, mode: 'rgb' });
  const inch = [W / 72, H / 72];
  dpi = Math.max(72, Math.min(dpi, Math.floor(Math.sqrt(1.2e8 / (inch[0] * inch[1]))), Math.floor(16000 / Math.max(...inch))));
  const k = dpi / 72;
  return pages.map(({ texts, boxes }) => {
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
    return { png: tagPng(Uint8Array.from(atob(url.slice(22)), (c) => c.charCodeAt(0)), dpi), dpi };
  });
}
