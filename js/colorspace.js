// Color spaces: a measured map of what one printer – with its ink, media and RIP settings – really prints.
//
// A chart of a few hundred patches spread over everything the printer might produce is printed and scanned once; every
// patch is a point "asked for x -> printed L*a*b*". From those points:
//   - localFit(x) predicts what x prints: a quadratic fit to the nearest points, weighted by distance and age, with one
//     robust re-weighting pass so a smudged or mis-scanned patch does not pull it. Where the measured patches are
//     sparse (at the edge of what the chart measured) it fits a line instead, and says so (`sparse`).
//   - invert(target) finds the inputs whose predicted print is closest to a reference (Gauss-Newton on the local fits,
//     started from the best-printing measured patches), staying close to measured patches – an honest answer, also for
//     colors the printer cannot reach.
//   - learn() adds every patch scanned later (test sheets, check charts, fill-ins), so the space gets denser where it is
//     used. Each one is first compared with what the rest of the space predicts for it, where measured patches surround
//     it: when a whole sheet disagrees, the printer, ink or media has probably changed (driftOf).
//   - gapFillers() picks inputs where the space has measured least – fill-in patches and Fill gaps charts.
// Points belong to sessions (a chart, a check chart, one test sheet, an imported file); a session or a single patch
// can be removed again.
import { deltaE2000 } from './color.js';
import { DE_FORMULAS, MODES, solve, solveForTarget } from './match.js';

/** A space predicts once it holds this many patches. */
export const SPACE_MIN_POINTS = 20;
/** Chart sizes: a check chart tests a space for drift; the others build or extend one. */
export const CHART_SIZES = {
  starter: { n: 200, label: 'Starter – 200 patches' },
  standard: { n: 400, label: 'Standard – 400 patches' },
  fine: { n: 800, label: 'Fine – 800 patches' },
  check: { n: 24, label: 'Check – 24 patches (has the printer changed?)' },
  gaps: { n: 48, label: 'Fill gaps – 48 patches where the space is emptiest' },
};
/** Older patches count less: their weight halves every 90 days (relative to the newest patch). */
const HALF_LIFE = 90 * 864e5;
/** Size of one "unit" of input per axis, so distances mean about the same in every sheet type. */
const UNIT = { spot: [1, 1, 1], lab: [1, 1, 1], cmyk: [1, 1, 1, 1], rgb: [2.55, 2.55, 2.55] };
/**
 * Version of the rule deciding which patches are compared with the prediction (learn): 2 = only where measured patches
 * surround them, 3 = also not just past the end of a tight cluster (a test sheet). Checks stored under an older rule –
 * which flagged sheets at the gamut edge as a changed printer – are made again by refreshChecks.
 */
const CHECK_RULE = 3;

/** Inputs per point: CMYK spaces keep K as a fourth input (a test sheet holds it fixed, a chart varies it). */
const inputCount = (mode) => (mode === 'cmyk' ? 4 : 3);
export const pointX = (mode, x, k = 0) => (mode === 'cmyk' ? [...x.slice(0, 3), k] : [...x]);
/** Spot color name of a chart patch, e.g. SD10-K3P9-C1-007. */
export const chartSpotName = (code, chart, n) => `SD10-${code}-C${chart}-${String(n).padStart(3, '0')}`;
export const newSpaceId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

/**
 * A new, empty space for one sheet type:
 * { id, name, mode, created, updated (ms), points: [{ x, lab, t (ms), s (session id), n (patch number) }],
 *   sessions: [{ id, kind ('chart' | 'check' | 'gaps' | 'sheet' | 'import'), label, time, updated, checks: { n: ΔE00 } }],
 *   chart (the chart being scanned, or null – kept by the app), checkRule (see CHECK_RULE) }
 */
export function newSpace({ name, mode, now = Date.now() }) {
  return { id: newSpaceId(), name, mode, created: now, updated: now, points: [], sessions: [], chart: null, checkRule: CHECK_RULE };
}

const round2 = (v) => Math.round(v * 100) / 100;
const median = (v) => quantile(v, 0.5);
function quantile(values, q) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}

// ---------------------------------------------------------------- chart design
// Where printers' gamuts typically peak, per hue: [hue°, L* of the cusp, C* of the cusp]. An L*a*b* chart reaches a
// quarter beyond that (plus C* 10), so it also covers wide-gamut printers and shows where a printer's edge is, without
// spending most patches on requests no printer can reach.
const CUSPS = [[30, 50, 85], [95, 88, 105], [150, 55, 80], [220, 60, 60], [290, 28, 75], [340, 50, 85]];
function chromaEnvelope(L, hue) {
  const h = ((hue % 360) + 360) % 360;
  const i = CUSPS.findIndex((c, j) => h >= c[0] && h < (CUSPS[j + 1]?.[0] ?? 390)); // -1: below the first cusp (wraps)
  const a = CUSPS.at(i), b = CUSPS[(i + 1) % CUSPS.length];
  const span = (b[0] - a[0] + 360) % 360, t = ((h - a[0] + 360) % 360) / span;
  const Lc = a[1] + t * (b[1] - a[1]), Cc = a[2] + t * (b[2] - a[2]);
  return 1.25 * Cc * (L < Lc ? L / Lc : (100 - L) / (100 - Lc)) + 10;
}
/** Halton low-discrepancy sequence: evenly spread points without the regular grid's gaps along the diagonals. */
function halton(i, base) {
  let f = 1, r = 0;
  for (; i > 0; i = Math.floor(i / base)) { f /= base; r += f * (i % base); }
  return r;
}
/** Small seeded random number generator (mulberry32), so a chart can be re-created exactly. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The `n` patches of a chart for a sheet type: a neutral ramp, the device corners (larger charts) and evenly spread
 * colors over everything the printer might produce –
 *   L*a*b* (spot, lab): L* 3–98, hues all round, chroma out to somewhat beyond typical printer gamuts (chromaEnvelope);
 *   CMYK: C, M, Y evenly, K weighted towards light values; RGB: the whole cube.
 * The patches are put in a random order (from `seed`), so uneven printing across the sheet averages out instead of
 * skewing one region of the space. Returns [{ n, x: [3 values], k (CMYK only) }].
 */
export function designChart(mode, n, seed = 1) {
  const xs = [], seen = new Set();
  const add = (x) => { const key = x.join(); if (xs.length < n && !seen.has(key)) { seen.add(key); xs.push(x); } };
  const ramp = Math.max(3, Math.round(n * 0.06));
  const start = 1 + ((seed >>> 0) % 5000); // another seed walks another part of the sequence
  const half = (v) => Math.round(v * 2) / 2, one = (v) => Math.round(v * 10) / 10;
  if (mode === 'cmyk') {
    if (n >= 100) for (const c of [[0, 0, 0, 0], [100, 0, 0, 0], [0, 100, 0, 0], [0, 0, 100, 0], [100, 100, 0, 0], [100, 0, 100, 0], [0, 100, 100, 0], [100, 100, 100, 0], [0, 0, 0, 100]]) add(c);
    for (let i = 0; i < ramp; i++) add([0, 0, 0, half((100 * i) / (ramp - 1))]);
    for (let i = start; xs.length < n; i++) add([100 * halton(i, 2), 100 * halton(i, 3), 100 * halton(i, 5), 100 * halton(i, 7) ** 1.6].map(half));
  } else if (mode === 'rgb') {
    if (n >= 100) for (const r of [0, 255]) for (const g of [0, 255]) for (const b of [0, 255]) add([r, g, b]);
    for (let i = 0; i < ramp; i++) { const v = Math.round((255 * i) / (ramp - 1)); add([v, v, v]); }
    for (let i = start; xs.length < n; i++) add([halton(i, 2), halton(i, 3), halton(i, 5)].map((u) => Math.round(255 * u)));
  } else {
    for (let i = 0; i < ramp; i++) add([one(3 + (95 * i) / (ramp - 1)), 0, 0]);
    for (let i = start; xs.length < n; i++) {
      const L = 3 + 95 * halton(i, 2), hue = 360 * halton(i, 3);
      const C = chromaEnvelope(L, hue) * Math.sqrt(halton(i, 5)); // √: evenly over the area of each hue slice
      add([one(L), one(C * Math.cos((hue * Math.PI) / 180)), one(C * Math.sin((hue * Math.PI) / 180))]);
    }
  }
  const rand = seeded(seed);
  for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
  return xs.map((x, i) => (mode === 'cmyk' ? { n: i + 1, x: x.slice(0, 3), k: x[3] } : { n: i + 1, x }));
}

// ---------------------------------------------------------------- prediction
/**
 * Weighted least squares of y (L*a*b*) on the features z = [1, inputs…, (squares and products)]: per Lab channel the
 * coefficients. A small ridge keeps the slopes stable where the points barely vary; a stronger one on the curvature
 * terms (from `linear` on) keeps them modest where the points are sparse.
 */
function weightedFit(z, y, w, linear) {
  const P = z[0].length;
  const A = Array.from({ length: P }, () => new Array(P).fill(0));
  const B = [0, 1, 2].map(() => new Array(P).fill(0));
  let sw = 0;
  z.forEach((zi, j) => {
    sw += w[j];
    for (let r = 0; r < P; r++) {
      for (let c = 0; c < P; c++) A[r][c] += w[j] * zi[r] * zi[c];
      for (let ch = 0; ch < 3; ch++) B[ch][r] += w[j] * zi[r] * y[j][ch];
    }
  });
  if (sw <= 0) return null;
  for (let r = 1; r < P; r++) A[r][r] += (r < linear ? 1e-3 : 0.05) * sw;
  const coef = B.map((b) => solve(A, b));
  return coef.every(Boolean) ? coef : null;
}

/**
 * What input x prints, from the nearest measured points (default: all of the space's): a quadratic fit around x – a
 * printer's response curves, so it follows them much better than a linear one between chart patches – or a linear one
 * while there are few points, where they are sparse (see isSparse; `stats` are the space's spaceStats), or just past
 * the edge of the measured patches (EDGE_LINEAR).
 * Returns { lab, J (∂Lab/∂x per input), rms (how well the nearby points agree with the fit), d1 (distance to the
 * nearest measured patch, in input units), dSupport (distance to the (D+1)-th nearest – small only where measured
 * patches surround x), offCentre, atEdge, sparse, h (the neighbourhood's radius) }, or null without enough points.
 */
function localFit(space, x, points = space.points, { stats = null } = {}) {
  const D = x.length, u = UNIT[space.mode], N = points.length;
  if (N < D + 3) return null;
  const dist = new Float64Array(N);
  let tMax = 0;
  for (let i = 0; i < N; i++) {
    const p = points[i];
    let s = 0;
    for (let k = 0; k < D; k++) s += ((p.x[k] - x[k]) / u[k]) ** 2;
    dist[i] = Math.sqrt(s);
    if (p.t > tMax) tMax = p.t;
  }
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => dist[a] - dist[b]);
  // how far x sits off the middle of its nearest patches, relative to their distance: small where they surround x,
  // near 1 or more at the edge of the measured patches and beyond (extrapolation)
  const M = Math.min(N, 2 * D + 2);
  const centre = Array.from({ length: D }, (_, k) => order.slice(0, M).reduce((sum, i) => sum + (points[i].x[k] - x[k]) / u[k], 0) / M);
  const offCentre = Math.hypot(...centre) / Math.max(1e-9, order.slice(0, M).reduce((sum, i) => sum + dist[i], 0) / M);
  // quadratic where measured patches surround x; linear where they are sparse (a curve fitted to far-away patches
  // bends away from the data – at gamut edges it promised colors the printer could not make)
  const P = 1 + D + (D * (D + 1)) / 2; // quadratic: intercept, slopes, squares and products
  const dSupport = dist[order[Math.min(D, N - 1)]];
  const d1 = dist[order[0]], atEdge = offCentre > SPARSE_OFF_CENTRE;
  const sparse = isSparse({ d1, dSupport, offCentre }, stats);
  // a curve also bends away just past the edge of the measured patches: a line there too
  const pastEdge = atEdge && stats?.spacing != null && d1 > EDGE_LINEAR * stats.spacing;
  const quadratic = N >= P + 10 && !sparse && !pastEdge;
  const K = Math.min(N, quadratic ? 3 * P : 4 * D + 8);
  const near = order.slice(0, K);
  const h = Math.max(dist[near[K - 1]] * 1.15, 1e-3);
  // tricube in distance × age
  const w = near.map((i) => (1 - (dist[i] / h) ** 3) ** 3 * 0.5 ** ((tMax - (points[i].t || tMax)) / HALF_LIFE));
  // features in units of half the neighbourhood, so the curvature ridge means the same everywhere
  const sc = h / 2;
  const z = near.map((i) => {
    const d = points[i].x.map((v, k) => (v - x[k]) / u[k] / sc);
    const f = [1, ...d];
    if (quadratic) for (let a = 0; a < D; a++) for (let b = a; b < D; b++) f.push(d[a] * d[b]);
    return f;
  });
  const y = near.map((i) => points[i].lab);
  let coef, res;
  for (let pass = 0; pass < 2; pass++) {
    coef = weightedFit(z, y, w, D + 1);
    if (!coef) return null;
    res = z.map((zi, j) => Math.hypot(...[0, 1, 2].map((c) => y[j][c] - coef[c].reduce((s, b, r) => s + b * zi[r], 0))));
    if (pass === 0) {
      // outliers – far off what their neighbours say – lose their weight (bisquare)
      const s = Math.max(1.5, 6 * median(res));
      res.forEach((r, j) => { w[j] *= r < s ? (1 - (r / s) ** 2) ** 2 : 0; });
    }
  }
  const sw = w.reduce((s, v) => s + v, 0) || 1;
  return {
    lab: coef.map((b) => b[0]),
    J: coef.map((b) => b.slice(1, D + 1).map((v, k) => v / u[k] / sc)),
    rms: Math.sqrt(res.reduce((s, r, j) => s + w[j] * r * r, 0) / sw),
    d1,
    dSupport,
    offCentre,
    atEdge,
    sparse,
    h,
  };
}

/**
 * Where the measured patches are sparse, nothing measured shows where the printer stops responding, and a fit only
 * extrapolates – at gamut edges it promised colors the printer could not make (predicted ΔE 0, printed 3–7). x counts as
 * sparse when its (D+1)-th nearest patch is further than SPARSE_FAR times the space's typical distance (`support`), or
 * it sits off the middle of its nearest patches (at their edge) while either that patch is further than SPARSE_NEAR
 * times the typical distance or x is more than a patch spacing beyond the nearest patch – past the end of a tight
 * cluster (a test sheet) is as unmeasured as past a sparse chart.
 * There, predictions use a linear fit and stay within SPARSE_REACH patch spacings of a measured patch – as they do at
 * the edge of the measured patches anywhere (beyond the last patch, a trend is a guess); between patches that surround
 * them, within REACH spacings (filling those gaps is safe).
 */
const SPARSE_FAR = 1.5, SPARSE_NEAR = 1.15, SPARSE_OFF_CENTRE = 0.45;
const REACH = 2, SPARSE_REACH = 0.5;
/** More than this many patch spacings past the edge of the measured patches, fits are linear (see localFit). */
const EDGE_LINEAR = 0.25;
function isSparse({ d1, dSupport, offCentre }, stats) {
  const { support, spacing } = stats ?? {};
  if (support == null) return false;
  const atEdge = offCentre > SPARSE_OFF_CENTRE;
  return dSupport > SPARSE_FAR * support || (atEdge && (dSupport > SPARSE_NEAR * support || d1 > spacing));
}

/**
 * The inputs predicted to print closest to `target` (Lab D50), searched only near measured patches (within REACH
 * patch spacings of one, SPARSE_REACH where they are sparse or at their edge), so the prediction rests on measurements rather than
 * extrapolation. CMYK: K is held at kFixed, or – kFixed null – each start keeps the K of the patch it starts from.
 * It never promises less than a patch already measured: when one printed closer than the best prediction, its values
 * are returned (measured: true – `predicted` is what it printed).
 * Returns { x (3 values), k, predicted, predictedDeltaE, rms, d1, sparse (a first estimate: few patches nearby),
 * measured } or null when the space is too small.
 */
export function invert(space, target, { formula = 'de00', kFixed = null } = {}) {
  const pts = space.points;
  if (pts.length < SPACE_MIN_POINTS) return null;
  const mode = space.mode;
  const { fn: dE, lWeight } = DE_FORMULAS[formula] ?? DE_FORMULAS.de00;
  const { min, max, minStep, decimals } = MODES[mode], u = UNIT[mode];
  const roundInput = (v) => (decimals ? Math.round(v * 10 ** decimals) / 10 ** decimals : Math.round(v));
  const stats = spaceStats(space, { stale: true }), { spacing } = stats;
  // within reach: close enough to measured patches for the prediction to rest on them (any distance without a spacing yet)
  const withinReach = (f) => !!f && (spacing == null || f.d1 <= (f.sparse || f.atEdge ? SPARSE_REACH : REACH) * spacing);
  const lo = [0, 1, 2].map((k) => Math.max(min[k], Math.min(...pts.map((p) => p.x[k])) - 2 * u[k]));
  const hi = [0, 1, 2].map((k) => Math.min(max[k], Math.max(...pts.map((p) => p.x[k])) + 2 * u[k]));
  const nearK = mode === 'cmyk' && kFixed != null ? pts.filter((p) => Math.abs(p.x[3] - kFixed) <= 15) : pts;
  const pool = nearK.length >= 5 ? nearK : pts;
  const starts = pool.map((p) => ({ p, d: dE(target, p.lab) })).sort((a, b) => a.d - b.d).slice(0, 4)
    .map(({ p }) => ({ x: p.x.slice(0, 3), k: mode === 'cmyk' ? kFixed ?? p.x[3] : 0 }));
  if (mode === 'spot' || mode === 'lab') starts.push({ x: target.map((v, k) => Math.min(Math.max(v, lo[k]), hi[k])), k: 0 });
  let best = null;
  for (const s of starts) {
    const fitAt = (x) => localFit(space, pointX(mode, x, s.k), space.points, { stats });
    let x = s.x;
    if (!withinReach(fitAt(x))) continue; // a start away from the measured patches (the target itself)
    for (let it = 0; it < 12; it++) {
      const f = fitAt(x);
      if (!f) return null;
      // each step stays within half the neighbourhood the fit was made from
      const R = [0, 1, 2].map((k) => Math.max(0.5 * f.h * u[k], minStep[k]));
      const sol = solveForTarget(mode, { m0: f.lab, J: f.J.map((row) => row.slice(0, 3)) }, x, target, {
        lo: x.map((v, k) => Math.max(lo[k], v - R[k])), hi: x.map((v, k) => Math.min(hi[k], v + R[k])), weights: [lWeight, 1, 1], dE,
      });
      // a step that would leave the measured patches' reach is shortened until it stays within it
      let next = null;
      for (let t = 1; t >= 1 / 32 && !next; t /= 2) {
        const c = x.map((v, k) => roundInput(v + t * (sol.x[k] - v)));
        if (withinReach(fitAt(c))) next = c;
      }
      if (!next) break;
      const move = Math.max(...next.map((v, k) => Math.abs(v - x[k]) / u[k]));
      x = next;
      if (move < 0.05) break;
    }
    const f = fitAt(x);
    const cand = { x, k: s.k, predicted: f.lab, predictedDeltaE: dE(target, f.lab), rms: f.rms, d1: f.d1, sparse: f.sparse, measured: false };
    if (!best || cand.predictedDeltaE < best.predictedDeltaE) best = cand;
  }
  // a measured patch that printed closer than any prediction (e.g. where the reach limits kept the search short)
  const m = pool.reduce((a, p) => { const d = dE(target, p.lab); return d < a.d ? { p, d } : a; }, { p: null, d: Infinity });
  if (m.p && (!best || m.d < best.predictedDeltaE)) {
    best = { x: m.p.x.slice(0, 3), k: mode === 'cmyk' ? m.p.x[3] : 0, predicted: m.p.lab, predictedDeltaE: m.d, rms: 0, d1: 0, sparse: false, measured: true };
  }
  return best;
}

// ---------------------------------------------------------------- quality and drift
const statsCache = new WeakMap();
/**
 * How well the space predicts: leave-one-out over (up to) 120 of its patches – each predicted from all the others.
 * Returns { points, accuracy: { median, p90 } (ΔE00) | null, spacing (typical distance between neighbouring
 * patches, input units) | null, support (typical distance to the (D+1)-th nearest patch) | null }. Cached until the
 * space changes; `stale: true` returns the last result even if it has changed since (cheap, for checks made while
 * scanning).
 */
export function spaceStats(space, { stale = false } = {}) {
  const key = `${space.points.length}|${space.updated}`;
  const hit = statsCache.get(space);
  if (hit && (hit.key === key || stale)) return hit;
  const pts = space.points, N = pts.length;
  const out = { key, points: N, accuracy: null, spacing: null, support: null };
  if (N >= SPACE_MIN_POINTS) {
    const errs = [], nn = [], around = [];
    for (let i = 0; i < N; i += Math.max(1, Math.floor(N / 120))) {
      const f = localFit(space, pts[i].x, pts.filter((_, j) => j !== i));
      if (f) { errs.push(deltaE2000(pts[i].lab, f.lab)); nn.push(f.d1); around.push(f.dSupport); }
    }
    if (errs.length) { out.accuracy = { median: median(errs), p90: quantile(errs, 0.9) }; out.spacing = median(nn); out.support = median(around); }
  }
  statsCache.set(space, out);
  return out;
}

/**
 * Add (or, for a patch measured again, replace) one measured patch. Before it counts, it is compared with what the
 * rest of the space predicts for it – only where measured patches surround it: at a sparsely measured gamut edge a
 * miss means the space did not know that region, not that the printer changed – and that ΔE00 is kept in the
 * session's checks (see driftOf). Returns the ΔE00, or null when there was nothing to compare with.
 */
export function learn(space, { session, kind, label, n, x, lab, now = Date.now() }) {
  let s = space.sessions.find((q) => q.id === session);
  if (!s) { s = { id: session, kind, label, time: now, updated: now, checks: {} }; space.sessions.push(s); }
  s.updated = now;
  let check = null;
  const others = space.points.filter((p) => p.s !== session);
  if (others.length >= SPACE_MIN_POINTS) {
    const stats = spaceStats(space, { stale: true });
    const f = localFit(space, x, others, { stats });
    if (f && stats.support != null && !f.sparse) { check = deltaE2000(lab, f.lab); s.checks[n] = round2(check); } else delete s.checks[n];
  }
  const point = { x: x.map(round2), lab: lab.map(round2), t: now, s: session, n };
  const i = space.points.findIndex((p) => p.s === session && p.n === n);
  if (i >= 0) space.points[i] = point; else space.points.push(point);
  space.updated = now;
  return check;
}

/**
 * Did a session print the way the space predicted? From its checks (at least 6): the median ΔE00, and drift = true
 * when that is well beyond the space's own accuracy (2.5 × its median, at least ΔE00 2) – the printer, ink or media
 * has probably changed since the earlier patches. null with too few checks.
 */
export function driftOf(space, sessionId) {
  const s = space.sessions.find((q) => q.id === sessionId);
  const v = Object.values(s?.checks ?? {});
  if (v.length < 6) return null;
  const m = median(v);
  const limit = Math.max(2, 2.5 * (spaceStats(space).accuracy?.median ?? 1));
  return { median: m, n: v.length, limit, drift: m > limit };
}

/**
 * Redo the stored checks of a space saved under an older check rule: each session's patches against the measurements
 * that existed before it (the earlier sessions), with today's rule. Returns true when it changed anything.
 */
export function refreshChecks(space) {
  if (space.checkRule === CHECK_RULE) return false;
  const timeOf = new Map(space.sessions.map((s) => [s.id, s.time]));
  for (const s of space.sessions) {
    s.checks = {};
    const earlier = space.points.filter((p) => p.s !== s.id && (timeOf.get(p.s) ?? Infinity) < s.time);
    if (earlier.length < SPACE_MIN_POINTS) continue;
    const before = { mode: space.mode, points: earlier, updated: s.time };
    const stats = spaceStats(before);
    for (const p of space.points.filter((q) => q.s === s.id)) {
      const f = localFit(before, p.x, earlier, { stats });
      if (f && stats.support != null && !f.sparse) s.checks[p.n] = round2(deltaE2000(p.lab, f.lab));
    }
  }
  space.checkRule = CHECK_RULE;
  return true;
}

// ---------------------------------------------------------------- filling gaps
/** Most fill-in patches taken from around a sheet's centre; the rest spread over the whole space. */
const NEAR_MAX = 8;

/**
 * `count` inputs where the space has measured least, for fill-in patches on a test sheet or a Fill gaps chart: from a
 * pool of candidates, each pick is the one farthest from every measured patch and every earlier pick (farthest-point
 * sampling), so they spread into the empty regions instead of crowding one. With `near` (an input, e.g. a sheet's
 * centre), half of them (at most NEAR_MAX) come from around it – up to three patch spacings away – where the color
 * being matched needs the data; the rest from anywhere. CMYK: `near` carries its K (kept for the picks around it).
 * Returns [{ x (3 values), k (CMYK only) }].
 */
export function gapFillers(space, count, { near = null, seed = 1 } = {}) {
  const mode = space.mode, D = inputCount(mode), u = UNIT[mode];
  const { min, max } = MODES[mode];
  const lo = [...min, 0].slice(0, D), hi = [...max, 100].slice(0, D);
  const { spacing } = spaceStats(space, { stale: true });
  const rand = seeded(seed);
  const tidy = (x) => x.map((v, k) => {
    const c = Math.min(Math.max(v, lo[k]), hi[k]);
    return mode === 'rgb' ? Math.round(c) : Math.round(c * 10) / 10;
  });
  const anywhere = designChart(mode, 1200, seed).map((p) => pointX(mode, p.x, p.k));
  const around = !near ? [] : Array.from({ length: 300 }, () => {
    const r = 3 * (spacing ?? 8) * Math.cbrt(rand()); // evenly through a ball of three spacings
    const dir = Array.from({ length: D }, () => rand() * 2 - 1), len = Math.hypot(...dir) || 1;
    return tidy(near.map((v, k) => (mode === 'cmyk' && k === 3 ? v : v + (dir[k] / len) * r * u[k])));
  });
  // distance (in input units) from each candidate to the nearest measured patch or earlier pick
  const dist = (a, b) => Math.hypot(...a.map((v, k) => (v - b[k]) / u[k]));
  const nearest = (pool) => pool.map((x) => space.points.reduce((m, p) => Math.min(m, dist(x, p.x)), Infinity));
  const picks = [];
  const take = (pool, n) => {
    const d = nearest(pool);
    for (let i = 0; i < n && pool.length; i++) {
      const j = d.reduce((b, v, k) => (v > d[b] ? k : b), 0);
      if (!(d[j] > 0.5)) break; // nothing left that is not already measured
      const x = pool[j];
      picks.push(x);
      pool.forEach((y, k) => { d[k] = Math.min(d[k], dist(x, y)); });
    }
  };
  if (near) take(around, Math.min(Math.ceil(count / 2), NEAR_MAX));
  take(anywhere, count - picks.length);
  return picks.map((x) => (mode === 'cmyk' ? { x: x.slice(0, 3), k: x[3] } : { x }));
}

/** A Fill gaps chart: `n` patches where the space is emptiest, in a random order like any chart ([{ n, x, k? }]). */
export function designGapChart(space, n, seed = 1) {
  const picks = gapFillers(space, n, { seed });
  const rand = seeded(seed + 1);
  for (let i = picks.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [picks[i], picks[j]] = [picks[j], picks[i]]; }
  return picks.map((p, i) => ({ n: i + 1, ...p }));
}

// ---------------------------------------------------------------- removing measurements
export const sessionSize = (space, id) => space.points.reduce((n, p) => n + (p.s === id), 0);

/**
 * Remove one measured patch (a scan undone, or a stray point), with its check; a session left without patches goes
 * too. Identified by session and patch number, or – for points without a number – by the point itself.
 * Returns true when a patch was removed.
 */
export function forgetPatch(space, session, n, point = null) {
  const i = point ? space.points.indexOf(point) : space.points.findIndex((p) => p.s === session && p.n === n);
  if (i < 0) return false;
  const [gone] = space.points.splice(i, 1);
  const s = space.sessions.find((q) => q.id === gone.s);
  if (s) delete s.checks?.[gone.n];
  if (s && !space.points.some((p) => p.s === gone.s)) space.sessions = space.sessions.filter((q) => q !== s);
  space.updated = Date.now();
  return true;
}

/** Remove a session and its patches (undo a bad sheet). */
export function removeSession(space, id) {
  space.points = space.points.filter((p) => p.s !== id);
  space.sessions = space.sessions.filter((s) => s.id !== id);
  space.updated = Date.now();
}

/** Remove every session started before `time` (after the printer changed). Returns how many were removed. */
export function keepFrom(space, time) {
  const old = space.sessions.filter((s) => s.time < time).map((s) => s.id);
  for (const id of old) removeSession(space, id);
  return old.length;
}

// ---------------------------------------------------------------- files
/** The space as JSON (without a chart in progress). */
export function spaceToJson(space) {
  const { id, name, mode, created, updated, sessions, points, checkRule } = space;
  return JSON.stringify({ format: 'sd10-color-space', version: 1, id, name, mode, created, updated, checkRule, sessions, points });
}

const CGATS_FIELDS = { cmyk: ['CMYK_C', 'CMYK_M', 'CMYK_Y', 'CMYK_K'], rgb: ['RGB_R', 'RGB_G', 'RGB_B'], lab: ['REQ_L', 'REQ_A', 'REQ_B'] };
const fieldsOf = (mode) => CGATS_FIELDS[mode === 'spot' ? 'lab' : mode];

/**
 * The space's measurements as a CGATS.17 text file: one row per patch with its input values and the measured
 * L*a*b* (D50 / 2°). CMYK and RGB use the standard CMYK_ / RGB_ (0–255) fields, which profiling software reads;
 * the requested L*a*b* of spot / Lab sheets go into declared REQ_L / REQ_A / REQ_B fields.
 */
export function spaceToCgats(space, created = new Date()) {
  const dev = fieldsOf(space.mode);
  const fields = ['SAMPLE_ID', ...dev, 'LAB_L', 'LAB_A', 'LAB_B'];
  const q = (s) => `"${String(s).replace(/"/g, "'")}"`;
  return [
    'CGATS.17',
    `ORIGINATOR\t${q('SD-10 Web Console')}`,
    `DESCRIPTOR\t${q(space.name)}`,
    `CREATED\t${q(created.toISOString().replace(/\.\d{3}Z$/, 'Z'))}`,
    '# LAB_L, LAB_A, LAB_B: measured CIE L*a*b*, D50 / 2 degree observer',
    'KEYWORD\t"SD10_MODE"',
    `SD10_MODE\t${q(space.mode)}`,
    ...(dev[0].startsWith('REQ') ? dev.map((f) => `KEYWORD\t"${f}"`) : []),
    `NUMBER_OF_FIELDS\t${fields.length}`,
    'BEGIN_DATA_FORMAT', fields.join('\t'), 'END_DATA_FORMAT',
    `NUMBER_OF_SETS\t${space.points.length}`,
    'BEGIN_DATA',
    ...space.points.map((p, i) => [i + 1, ...p.x.map(round2), ...p.lab.map((v) => v.toFixed(2))].join('\t')),
    'END_DATA', '',
  ].join('\r\n');
}

/**
 * A space from a CGATS / IT8 measurement file – one written by spaceToCgats, or a chart measured with other software
 * (CMYK_ or RGB_ fields with LAB_ values; ArgyllCMS .ti3 files store RGB as 0–100). The sheet type comes from the
 * SD10_MODE keyword, else from the fields (REQ_ fields = spot color sheets).
 */
export function spaceFromCgats(text, fileName = '') {
  const what = fileName || 'The file';
  const lines = text.split(/\r?\n/);
  const ti3 = /^\s*CTI3/.test(lines[0] ?? '');
  const tokens = (line) => (line.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ''));
  const meta = {};
  let fields = null, rows = [], part = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line === 'BEGIN_DATA_FORMAT') { part = 'format'; fields = []; continue; }
    if (line === 'END_DATA_FORMAT' || line === 'END_DATA') { if (part === 'data') break; part = ''; continue; } // first table only
    if (line === 'BEGIN_DATA') { part = 'data'; continue; }
    const t = tokens(line);
    if (part === 'format') fields.push(...t); else if (part === 'data') rows.push(t); else meta[t[0]] = t.slice(1).join(' ');
  }
  if (!fields?.length || !rows.length) throw new Error(`${what} is not a CGATS / IT8 measurement file`);
  const col = (f) => fields.indexOf(f);
  const labCols = ['LAB_L', 'LAB_A', 'LAB_B'].map(col);
  if (labCols.some((c) => c < 0)) throw new Error(`${what} has no measured L*a*b* values (LAB_L, LAB_A, LAB_B)`);
  const has = (mode) => fieldsOf(mode).every((f) => col(f) >= 0);
  const mode = MODES[meta.SD10_MODE] && has(meta.SD10_MODE) ? meta.SD10_MODE : has('cmyk') ? 'cmyk' : has('rgb') ? 'rgb' : has('spot') ? 'spot' : null;
  if (!mode) throw new Error(`${what} has no CMYK_, RGB_ or requested L*a*b* (REQ_) values`);
  const devCols = fieldsOf(mode).map(col);
  const full = mode === 'rgb' && ti3 ? 100 : 255; // RGB full scale in the file
  const now = Date.now(), session = `import:${now}`;
  const points = rows.map((r, i) => ({
    x: devCols.map((c) => (mode === 'rgb' ? Math.round((parseFloat(r[c]) * 255) / full) : round2(parseFloat(r[c])))),
    lab: labCols.map((c) => round2(parseFloat(r[c]))), t: now, s: session, n: i + 1,
  })).filter((p) => [...p.x, ...p.lab].every(Number.isFinite));
  if (!points.length) throw new Error(`${what} holds no complete measurements`);
  const name = meta.DESCRIPTOR || fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '') || 'Imported color space';
  return { id: newSpaceId(), name: name.slice(0, 60), mode, created: now, updated: now, points,
    sessions: [{ id: session, kind: 'import', label: `Imported from ${fileName || 'a measurement file'}`, time: now, updated: now, checks: {} }], chart: null, checkRule: CHECK_RULE };
}

/** A space from a file: the app's own JSON, or a CGATS / IT8 measurement file. */
export function readSpaceFile(bytes, fileName = '') {
  const text = new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  if (!text.trimStart().startsWith('{')) return spaceFromCgats(text, fileName);
  let o;
  try { o = JSON.parse(text); } catch { throw new Error(`${fileName || 'The file'} is not valid JSON`); }
  // 'sd10-colour-space': files exported by versions that spelled "colour"
  if (!['sd10-color-space', 'sd10-colour-space'].includes(o?.format) || !MODES[o.mode]) throw new Error(`${fileName || 'The file'} is not an SD-10 color space`);
  const D = inputCount(o.mode), now = Date.now();
  const points = (Array.isArray(o.points) ? o.points : [])
    .filter((p) => p?.x?.length === D && p.lab?.length === 3 && [...p.x, ...p.lab].every(Number.isFinite))
    .map((p, i) => ({ x: p.x.map(Number), lab: p.lab.map(Number), t: Number(p.t) || o.created || now, s: String(p.s ?? 'import'), n: p.n ?? i + 1 }));
  const sessions = (Array.isArray(o.sessions) ? o.sessions : []).filter((s) => s?.id).map((s) => ({ checks: {}, ...s }));
  for (const id of new Set(points.map((p) => p.s))) {
    if (!sessions.some((s) => s.id === id)) sessions.push({ id, kind: 'import', label: `Imported from ${fileName || 'a file'}`, time: now, updated: now, checks: {} });
  }
  const space = { id: String(o.id || newSpaceId()), name: String(o.name || 'Imported color space').slice(0, 60), mode: o.mode,
    created: Number(o.created) || now, updated: now, points, sessions, chart: null, ...(o.checkRule ? { checkRule: o.checkRule } : {}) };
  refreshChecks(space); // a file from a version with an older check rule
  return space;
}
