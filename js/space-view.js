// Color space view: a large, turnable 3-D picture of a measured color space in CIE L*a*b* – every measured patch in the
// color it printed, the gamut surface around them, optionally a second space as a wireframe to compare (another
// media or printer), and the Print match reference colors, listed beside it with their closest measured patch and the
// values the space predicts for them. Plain canvas 2-D with a small perspective projection; drag to turn, scroll or
// pinch to zoom, hover a patch for its values; full screen on request.
// The data comes from the Print match view (initSpaceView's `data` callback), which owns the color spaces.
import { $, displayHex, escapeHtml, labText, valuesText } from './ui.js';
import { invert, spaceStats } from './colorspace.js';
import { DE_FORMULAS, MODE_NAME } from './match.js';

let data = () => ({ spaces: [], active: '', refs: [], formula: 'de00' });
let actions = {}; // { removePoint(spaceId, point) } – changes to the color spaces are made by their owner
const PREFS_KEY = 'sd10.space3d';
const prefs = (() => {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { /* ignore */ }
  return { surface: true, points: true, refs: true, spin: true, space: '', compare: '', ...p };
})();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

// camera: yaw turns around the vertical axis through `target` (a*, L*, b* – the middle of the L* axis, or a color the
// view is centered on), pitch tilts towards a view from above; zoom 1 fits the L*a*b* range
const HOME = { yaw: -0.65, pitch: 0.38, zoom: 1, target: [0, 50, 0] };
let cam = { ...HOME };
let focus = null; // { name, pos } of the color the view is centered on – null in the middle
let glide = null; // { from, to, start } while the centre moves to a new color
let visible = false, frame = 0, lastTime = 0, dirty = true;
// rebuilt when the data changes: { R (picture radius), space, other (compared with), shell, otherShell,
//   points: [{ pos, hex, p, session }], refs: [{ id, name, lab, pos, hex, outside }] }
let scene = null;
let projected = []; // screen positions of the points drawn last, for hovering
let projectedRefs = []; // … and of the reference markers

// ---------------------------------------------------------------- gamut surface
const L_STEP = 5, HUES = 36;
/**
 * The gamut surface of measured L*a*b* values: for rings every 5 L* and every 10° of hue, the largest chroma measured
 * nearby (holes filled from the neighbours, lightly smoothed), closed at the darkest and lightest patch.
 * Returns { rings: [{ L, r: [HUES radii] }], bottom, top } or null for too few points.
 */
function gamutShell(labs) {
  if (labs.length < 20) return null;
  const Ls = labs.map((l) => l[0]);
  const bottom = Math.min(...Ls), top = Math.max(...Ls);
  const chromatic = labs.map(([L, a, b]) => ({ L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 })).filter((p) => p.C >= 2);
  const rings = [];
  for (let L = Math.ceil((bottom + 1) / L_STEP) * L_STEP; L < top - 1; L += L_STEP) {
    const r = Array.from({ length: HUES }, (_, i) => {
      const h = (i * 360) / HUES;
      let best = null;
      for (const p of chromatic) {
        const dh = Math.abs(((p.h - h + 540) % 360) - 180);
        if (Math.abs(p.L - L) <= 6 && dh <= 15 && (best == null || p.C > best)) best = p.C;
      }
      return best;
    });
    rings.push({ L, r });
  }
  // holes: from the nearest filled hues of the ring, then from the rings above and below
  for (const ring of rings) {
    if (ring.r.every((v) => v == null)) continue;
    ring.r = ring.r.map((v, i) => {
      if (v != null) return v;
      let lo = 1, hi = 1;
      while (ring.r[(i - lo + HUES) % HUES] == null) lo++;
      while (ring.r[(i + hi) % HUES] == null) hi++;
      return (ring.r[(i - lo + HUES) % HUES] * hi + ring.r[(i + hi) % HUES] * lo) / (lo + hi);
    });
  }
  const filled = rings.filter((ring) => ring.r.every((v) => v != null));
  if (filled.length < 2) return null;
  for (const ring of rings) if (ring.r.some((v) => v == null)) ring.r = [...filled.reduce((a, b) => (Math.abs(b.L - ring.L) < Math.abs(a.L - ring.L) ? b : a)).r];
  for (const ring of rings) ring.r = ring.r.map((v, i) => (2 * v + ring.r[(i + 1) % HUES] + ring.r[(i - 1 + HUES) % HUES]) / 4);
  return { rings, bottom, top };
}

/** Chroma of the surface at L*, hue (degrees) – 0 beyond its lightest and darkest point. */
function shellChroma(shell, L, hue) {
  const { rings } = shell;
  if (L <= shell.bottom || L >= shell.top) return 0;
  const at = (ring) => {
    const pos = ((((hue % 360) + 360) % 360) / 360) * HUES, i = Math.floor(pos) % HUES, f = pos - Math.floor(pos);
    return ring.r[i] * (1 - f) + ring.r[(i + 1) % HUES] * f;
  };
  const below = [{ L: shell.bottom, r: null }, ...rings].filter((r) => r.L <= L).pop();
  const above = [...rings, { L: shell.top, r: null }].find((r) => r.L >= L);
  const cb = below.r ? at(below) : 0, ca = above.r ? at(above) : 0;
  return above.L === below.L ? cb : cb + ((ca - cb) * (L - below.L)) / (above.L - below.L);
}

/** Volume inside the surface in cubic ΔE (L*a*b* units). */
function shellVolume(shell) {
  const area = (r) => r.reduce((s, v, i) => s + 0.5 * v * r[(i + 1) % HUES] * Math.sin((2 * Math.PI) / HUES), 0);
  const slices = [{ L: shell.bottom, a: 0 }, ...shell.rings.map((ring) => ({ L: ring.L, a: area(ring.r) })), { L: shell.top, a: 0 }];
  let v = 0;
  for (let i = 1; i < slices.length; i++) v += ((slices[i].a + slices[i - 1].a) / 2) * (slices[i].L - slices[i - 1].L);
  return v;
}

// ---------------------------------------------------------------- scene
const ringPoint = (L, r, i) => { const h = (i * 2 * Math.PI) / HUES; return [r * Math.cos(h), L, r * Math.sin(h)]; };

function buildScene() {
  const { spaces, active, refs } = data();
  if (!spaces.some((s) => s.id === prefs.space)) prefs.space = spaces.some((s) => s.id === active) ? active : spaces[0]?.id ?? '';
  if (prefs.compare === prefs.space || !spaces.some((s) => s.id === prefs.compare)) prefs.compare = '';
  const space = spaces.find((s) => s.id === prefs.space) ?? null;
  const other = spaces.find((s) => s.id === prefs.compare) ?? null;
  const labs = space ? space.points.map((p) => p.lab) : [];
  const sessions = new Map((space?.sessions ?? []).map((s) => [s.id, s.label]));
  // the picture is scaled to the colors shown: the largest chroma of either space or a reference, plus a margin
  const chroma = [...labs, ...(other?.points.map((p) => p.lab) ?? []), ...refs.map((r) => r.lab)].map((l) => Math.hypot(l[1], l[2]));
  const shell = gamutShell(labs);
  // a reference is outside when its chroma is beyond the surface at its lightness and hue
  const outside = (lab) => !!shell && Math.hypot(lab[1], lab[2]) > shellChroma(shell, lab[0], (Math.atan2(lab[2], lab[1]) * 180) / Math.PI) + 1;
  scene = {
    R: Math.max(60, Math.min(140, Math.max(0, ...chroma) + 12)),
    space,
    other,
    shell,
    otherShell: other ? gamutShell(other.points.map((p) => p.lab)) : null,
    points: space ? space.points.map((p) => ({ pos: [p.lab[1], p.lab[0], p.lab[2]], hex: displayHex(p.lab), p, session: sessions.get(p.s) ?? '' })) : [],
    refs: refs.map((r) => ({ ...r, pos: [r.lab[1], r.lab[0], r.lab[2]], hex: displayHex(r.lab), outside: outside(r.lab) })),
  };
  dirty = true;
}

// ---------------------------------------------------------------- drawing
let ctx = null, W = 0, H = 0;
/** World (a*, L*, b*) -> screen { x, y, z (depth, larger = farther), s (scale) }. */
function project([a, L, b]) {
  const x = a - cam.target[0], y = L - cam.target[1], z = b - cam.target[2];
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const X = x * cy - z * sy, Z0 = x * sy + z * cy;
  const Y = y * cp + Z0 * sp, Z = -y * sp + Z0 * cp;
  const R = scene?.R ?? 130; // fits ±R in a*/b* and L* 0–100
  const scale = Math.min(W / (2.2 * R), H / Math.max(2 * R, 145)) * cam.zoom;
  const s = (scale * 700) / (700 + Z);
  // a little above the middle: the floor rings and axis labels reach further down than the top of the L* axis goes up
  return { x: W / 2 + X * s, y: H * 0.46 - Y * s, z: Z, s };
}

/** Colors of the axes, labels, wireframe and markers for the light or dark page. */
function theme() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return { ink: (alpha) => `rgba(${dark ? '203,213,225' : '51,65,85'},${alpha})`, wire: dark ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.5)', text: dark ? '#fff' : '#0f172a' };
}

function line(a, b, style, width = 1) {
  const p = project(a), q = project(b);
  ctx.strokeStyle = style; ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
}
function label(pos, text, style, align = 'center') {
  const p = project(pos);
  ctx.fillStyle = style; ctx.textAlign = align; ctx.fillText(text, p.x, p.y);
}

/** Size the canvas to its box (at the screen's pixel density) and clear it; false while it has no size (hidden). */
function fitCanvas() {
  const canvas = $('vsCanvas');
  const dpr = devicePixelRatio || 1;
  W = canvas.clientWidth; H = canvas.clientHeight;
  if (!W || !H) return false;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return true;
}

/** Chroma rings and the a* and b* axes on the floor (L* 0), the L* axis up the middle. */
function drawAxes({ ink }) {
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  const R = scene?.R ?? 130, A = R + 8; // axis length
  for (const C of [25, 50, 75, 100, 125].filter((c) => c <= R)) {
    ctx.strokeStyle = ink(0.18); ctx.setLineDash([4, 4]); ctx.beginPath();
    for (let i = 0; i <= 72; i++) { const q = project([C * Math.cos((i * Math.PI) / 36), 0, C * Math.sin((i * Math.PI) / 36)]); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }
    ctx.stroke(); ctx.setLineDash([]);
    label([C * 0.71, 0, C * 0.71], `C* ${C}`, ink(0.45));
  }
  line([-A, 0, 0], [A, 0, 0], ink(0.35));
  line([0, 0, -A], [0, 0, A], ink(0.35));
  line([0, 0, 0], [0, 100, 0], ink(0.45), 1.5);
  label([A + 10, 0, 0], '+a* (red)', '#e11d48'); label([-A - 10, 0, 0], '−a* (green)', '#16a34a');
  label([0, 0, A + 10], '+b* (yellow)', '#ca8a04'); label([0, 0, -A - 10], '−b* (blue)', '#2563eb');
  for (const L of [0, 50, 100]) label([0, L, 0], `  L* ${L}`, ink(0.6), 'left');
}

/** Everything with depth – surface faces, the compared space's wireframe, measured patches – sorted far to near. */
function depthItems() {
  const items = [];
  const { shell, otherShell } = scene ?? {};
  if (shell && prefs.surface) {
    const levels = [{ L: shell.bottom, r: new Array(HUES).fill(0) }, ...shell.rings, { L: shell.top, r: new Array(HUES).fill(0) }];
    for (let k = 1; k < levels.length; k++) {
      for (let i = 0; i < HUES; i++) {
        const j = (i + 1) % HUES;
        const quad = [ringPoint(levels[k - 1].L, levels[k - 1].r[i], i), ringPoint(levels[k - 1].L, levels[k - 1].r[j], j), ringPoint(levels[k].L, levels[k].r[j], j), ringPoint(levels[k].L, levels[k].r[i], i)];
        const centre = [0, 1, 2].map((c) => quad.reduce((s, q) => s + q[c], 0) / 4);
        items.push({ kind: 'face', quad, z: project(centre).z, hex: displayHex([centre[1], centre[0], centre[2]]) });
      }
    }
  }
  if (otherShell) {
    const levels = otherShell.rings;
    for (let k = 0; k < levels.length; k += 2) {
      for (let i = 0; i < HUES; i++) items.push({ kind: 'wire', a: ringPoint(levels[k].L, levels[k].r[i], i), b: ringPoint(levels[k].L, levels[k].r[(i + 1) % HUES], (i + 1) % HUES) });
    }
    for (let i = 0; i < HUES; i += 3) {
      const path = [[0, otherShell.bottom, 0], ...levels.map((ring) => ringPoint(ring.L, ring.r[i], i)), [0, otherShell.top, 0]];
      for (let k = 1; k < path.length; k++) items.push({ kind: 'wire', a: path[k - 1], b: path[k] });
    }
    for (const it of items) if (it.kind === 'wire') it.z = project([0, 1, 2].map((c) => (it.a[c] + it.b[c]) / 2)).z;
  }
  if (prefs.points && scene) for (const pt of scene.points) items.push({ kind: 'point', pt, z: project(pt.pos).z });
  return items.sort((a, b) => b.z - a.z);
}

/** A patch's radius: it grows with the square root of the zoom, not the zoom itself, so zoomed in there are gaps. */
const patchRadius = (p) => Math.max(2, (1.9 * p.s) / Math.sqrt(cam.zoom));

// While the view is centered on a color, patches in front of it that cover it on screen fade out – the more, the
// nearer they are to the camera and to it on screen – so it and its neighbors stay visible from any side.
const FADE_DEPTH = 15; // ΔE in front of the centered color at which a covering patch has faded fully
const FADE_MIN = 0.12; // opacity of a fully faded patch
const FADE_PICK = 0.5; // patches fainter than this let the pointer through to what is behind them

/** Opacity (FADE_MIN–1) of a patch at screen position `p` with radius `r`; `f` is the centered color on screen. */
function fadeFor(p, r, f) {
  const near = Math.min(1, Math.max(0, (f.z - p.z) / FADE_DEPTH));
  if (!near) return 1;
  const win = Math.max(36, 5 * f.r); // the window kept clear around the centered color
  const gap = Math.max(0, Math.hypot(p.x - f.x, p.y - f.y) - r - f.r);
  const over = gap < win ? 1 : Math.max(0, 2 - gap / win);
  return 1 - (1 - FADE_MIN) * near * over;
}

const samePos = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Draw the depth-sorted items; remembers where the patches landed, for hovering. */
function drawItems(items, { wire, text }) {
  projected = [];
  const faceAlpha = prefs.points ? 0.22 : 0.55; // the surface is see-through while the patches show
  const f = focus && project(focus.pos);
  if (f) f.r = patchRadius(f);
  let centered = null; // the centered patch, drawn last so nothing covers it
  for (const it of items) {
    if (it.kind === 'face') {
      const q = it.quad.map(project);
      ctx.beginPath(); q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
      ctx.globalAlpha = faceAlpha; ctx.fillStyle = it.hex; ctx.fill();
      ctx.globalAlpha = 0.25; ctx.strokeStyle = it.hex; ctx.lineWidth = 0.6; ctx.stroke(); ctx.globalAlpha = 1;
    } else if (it.kind === 'wire') {
      line(it.a, it.b, wire);
    } else {
      const p = project(it.pt.pos), r = patchRadius(p);
      if (f && samePos(it.pt.pos, focus.pos)) { centered = { p, r, pt: it.pt }; continue; }
      const alpha = f ? fadeFor(p, r, f) : 1;
      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = it.pt.hex; ctx.fill();
      ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke();
      ctx.globalAlpha = 1;
      if (alpha >= FADE_PICK) projected.push({ x: p.x, y: p.y, r, pt: it.pt });
    }
  }
  if (centered) {
    const { p, r, pt } = centered;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = pt.hex; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = text; ctx.stroke();
    projected.push({ x: p.x, y: p.y, r, pt });
  }
}

/**
 * The selected reference with its closest colors: a line to the closest measured patch (ringed), and a dashed line to
 * the color its predicted values should print (a hollow ring).
 */
function drawSelection({ text }) {
  const ref = scene.refs.find((r) => r.id === selectedRef);
  const detail = ref && scene.space && refDetail(scene.space, ref, formulaKey());
  if (!detail) return;
  const at = (lab) => project([lab[1], lab[0], lab[2]]), from = project(ref.pos);
  const to = (lab, dash) => { const q = at(lab); ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(q.x, q.y); ctx.stroke(); ctx.setLineDash([]); return q; };
  ctx.strokeStyle = text; ctx.lineWidth = 1.5;
  if (detail.measured) {
    const q = to(detail.measured.p.lab, []);
    ctx.beginPath(); ctx.arc(q.x, q.y, 9, 0, 2 * Math.PI); ctx.lineWidth = 2; ctx.stroke();
  }
  if (detail.predicted) {
    ctx.lineWidth = 1.5;
    const q = to(detail.predicted.predicted, [5, 4]);
    ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, 2 * Math.PI); ctx.stroke();
  }
}

/** More reference colors than this and only the selected one is named in the picture (hover the others). */
const MAX_NAMED_REFS = 6;

/** Reference colors on top of everything – ringed red when outside the surface, named when there are few. */
function drawReferences({ text }) {
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  projectedRefs = [];
  for (const ref of scene.refs) {
    const p = project(ref.pos), selected = ref.id === selectedRef;
    ctx.beginPath(); ctx.arc(p.x, p.y, selected ? 9 : 7, 0, 2 * Math.PI);
    ctx.fillStyle = ref.hex; ctx.fill();
    ctx.lineWidth = selected ? 3.5 : 2.5; ctx.strokeStyle = ref.outside ? '#e11d48' : text; ctx.stroke();
    projectedRefs.push({ x: p.x, y: p.y, r: 9, ref });
    if (scene.refs.length > MAX_NAMED_REFS && !selected) continue;
    ctx.fillStyle = text; ctx.textAlign = 'left';
    ctx.fillText(`${ref.name}${ref.outside ? ' (outside)' : ''}`, p.x + 12, p.y + 4);
  }
}

function draw() {
  dirty = false;
  if (!fitCanvas()) return;
  const colors = theme();
  drawAxes(colors);
  drawItems(depthItems(), colors);
  if (prefs.refs && scene) { drawSelection(colors); drawReferences(colors); }
}

function loop(time) {
  frame = 0;
  if (!visible) return;
  if (glide) {
    const t = Math.min(1, (time - (glide.start ??= time)) / GLIDE_MS), ease = t * (2 - t);
    cam.target = glide.from.map((v, k) => v + (glide.to[k] - v) * ease);
    if (t >= 1) glide = null;
    dirty = true;
  }
  if (prefs.spin && !drag) { cam.yaw += Math.min(time - lastTime, 50) * 0.00025; dirty = true; }
  lastTime = time;
  if (dirty) draw();
  frame = requestAnimationFrame(loop);
}
const kick = () => { dirty = true; if (visible && !frame) frame = requestAnimationFrame((t) => { lastTime = t; loop(t); }); };

// ---------------------------------------------------------------- reference list
// For each reference color: the patch of this space that measured closest to it, and the values the space predicts
// for it. A prediction takes a moment, so they are worked out one at a time after the list is drawn, and cached.
const refDetailCache = new Map();
let selectedRef = null; // id of the reference shown with its closest colors in the picture
let refJob = null;
const formulaKey = () => (DE_FORMULAS[data().formula] ? data().formula : 'de00');
const refDetailKey = (space, ref, formula) => `${space.id}|${space.updated}|${space.points.length}|${ref.lab.join()}|${formula}`;
const refDetail = (space, ref, formula) => refDetailCache.get(refDetailKey(space, ref, formula));

function computeRefDetail(space, ref, formula) {
  const { fn: dE } = DE_FORMULAS[formula];
  let measured = null;
  for (const p of space.points) { const d = dE(ref.lab, p.lab); if (!measured || d < measured.dE) measured = { p, dE: d }; }
  let predicted = null;
  try { predicted = invert(space, ref.lab, { formula }); } catch { /* too few patches */ }
  return { measured, predicted };
}

/** Work out the next reference that has no details yet, then redraw; continues until all have them. */
function scheduleRefDetails() {
  clearTimeout(refJob);
  const { space, refs } = scene ?? {};
  const formula = formulaKey();
  const next = space?.points.length && refs.find((r) => !refDetail(space, r, formula));
  if (!next) return;
  refJob = setTimeout(() => {
    if (refDetailCache.size > 500) refDetailCache.clear();
    refDetailCache.set(refDetailKey(space, next, formula), computeRefDetail(space, next, formula));
    if (scene?.space === space) { renderRefList(); kick(); }
  }, 0);
}


function renderRefList() {
  const { space, refs } = scene;
  const formula = formulaKey(), dE = DE_FORMULAS[formula].label;
  $('vsRefCount').textContent = refs.length ? `(${refs.length})` : '';
  if (!refs.length) {
    $('vsRefList').innerHTML = '<li class="px-4 py-3 text-sm text-slate-500">No reference colors yet – set them in Print match, or measure a color here.</li>';
    return;
  }
  const sessions = new Map((space?.sessions ?? []).map((s) => [s.id, s.label]));
  $('vsRefList').innerHTML = refs.map((ref) => {
    const d = space?.points.length ? refDetail(space, ref, formula) : null;
    const m = d?.measured, p = d?.predicted;
    const pending = space?.points.length && !d ? '<p class="mt-1 text-[11px] text-slate-500">Working it out…</p>' : '';
    const details = !d ? pending : `<dl class="mt-1.5 grid grid-cols-[auto,minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px] leading-4">
        <dt class="text-slate-500">Measured</dt>
        <dd>${m ? `${dE} <b>${m.dE.toFixed(2)}</b> · <span class="font-mono">${labText(m.p.lab)}</span><span class="block truncate text-slate-500" title="${escapeHtml(sessions.get(m.p.s) ?? '')}">${escapeHtml(sessions.get(m.p.s) ?? '')}${m.p.n != null ? ` · patch #${m.p.n}` : ''}</span>` : '–'}</dd>
        <dt class="text-slate-500">Predicted</dt>
        <dd>${p ? `${dE} <b>${p.predictedDeltaE.toFixed(2)}</b> · <span class="font-mono">${labText(p.predicted)}</span><span class="block text-slate-500">ask for <span class="font-mono">${valuesText(space.mode, p.x, p.k)}</span>${p.measured ? ' · a measured patch' : p.sparse ? ' · first estimate' : ''}</span>` : '–'}</dd>
      </dl>`;
    const selected = ref.id === selectedRef;
    return `<li data-ref="${escapeHtml(ref.id)}" class="cursor-pointer border-b border-slate-200 px-4 py-2.5 last:border-0 dark:border-slate-800 ${selected ? 'bg-indigo-50 dark:bg-indigo-950/40' : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'}">
      <div class="flex items-center gap-2">
        <span class="flex h-6 w-12 flex-none overflow-hidden rounded ring-1 ring-black/10" title="Reference · closest measured patch">
          <span class="flex-1" style="background:${ref.hex}"></span><span class="flex-1" style="background:${m ? displayHex(m.p.lab) : 'transparent'}"></span></span>
        <span class="min-w-0 flex-1 truncate font-medium ${selected ? 'text-indigo-700 dark:text-indigo-300' : ''}">${escapeHtml(ref.name)}</span>
        ${ref.outside ? '<span class="chip bg-rose-600 text-white !px-1.5 !py-0 text-[10px]" title="Outside the measured gamut surface">OUTSIDE</span>' : ''}
        <button type="button" data-ref-center class="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400" title="Center the picture on this color and zoom in">center</button>
      </div>
      <div class="mt-0.5 font-mono text-[11px] text-slate-500">${labText(ref.lab)}</div>
      ${details}
    </li>`;
  }).join('');
  scheduleRefDetails();
}

// ---------------------------------------------------------------- full screen
// The picture fills the screen (Esc leaves). Where the browser has no full-screen mode, or refuses it, the picture is
// enlarged over the page instead.
const ENLARGED = ['!fixed', '!inset-0', '!z-50', '!max-h-none', '!aspect-auto', '!h-auto'];
const isEnlarged = () => $('vsStage').classList.contains('!fixed');
const isFull = () => document.fullscreenElement === $('vsStage') || isEnlarged();
function setEnlarged(on) {
  for (const c of ENLARGED) $('vsStage').classList.toggle(c, on);
  updateFullButton();
  kick();
}
async function toggleFullScreen() {
  const stage = $('vsStage');
  if (document.fullscreenElement) { await document.exitFullscreen().catch(() => {}); return; }
  if (isEnlarged()) { setEnlarged(false); return; }
  try {
    if (!stage.requestFullscreen) throw new Error('no full screen');
    await stage.requestFullscreen();
  } catch { setEnlarged(true); }
}
function updateFullButton() {
  $('vsFull').textContent = isFull() ? 'Exit full screen' : 'Full screen';
  $('vsSpinBtn').classList.toggle('!bg-indigo-600', prefs.spin);
  $('vsSpinBtn').classList.toggle('!text-white', prefs.spin);
}

// ---------------------------------------------------------------- panel
const fmtInt = (v) => Math.round(v).toLocaleString();

function renderPanel() {
  const { spaces } = data();
  const opts = (none) => (none ? `<option value="">${none}</option>` : '') + spaces.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
  $('vsSpace').innerHTML = opts(spaces.length ? '' : 'No color spaces yet');
  $('vsSpace').value = prefs.space;
  $('vsCompare').innerHTML = opts('Nothing');
  $('vsCompare').value = prefs.compare;
  for (const k of ['surface', 'points', 'refs', 'spin']) $(`vs_${k}`).checked = prefs[k];
  const { space, shell, otherShell, other } = scene;
  $('vsEmpty').classList.toggle('hidden', !!space?.points.length);
  $('vsEmpty').innerHTML = !spaces.length
    ? 'No color spaces yet. Create one in <b>Print match</b> (Color space → Create chart, then scan it) or import a color space or CGATS file there.'
    : 'This color space has no measured patches yet – scan its chart in <b>Print match</b>.';
  if (!space) { $('vsInfo').innerHTML = '<p class="text-slate-500">Select a color space to see it.</p>'; return; }
  const st = spaceStats(space);
  const pts = space.points;
  const chroma = pts.map((p) => ({ C: Math.hypot(p.lab[1], p.lab[2]), p }));
  const most = chroma.reduce((a, b) => (b.C > a.C ? b : a), chroma[0] ?? { C: 0 });
  const vol = shell ? shellVolume(shell) : null, otherVol = otherShell ? shellVolume(otherShell) : null;
  const outside = scene.refs.filter((r) => r.outside);
  const row = (k, v) => `<div class="flex justify-between gap-3"><dt class="text-slate-500">${k}</dt><dd class="text-right font-mono tabular-nums">${v}</dd></div>`;
  $('vsInfo').innerHTML = `<h3 class="font-semibold">${escapeHtml(space.name)}</h3>
    <dl class="space-y-1 text-xs">
      ${row('Sheet type', MODE_NAME[space.mode] ?? space.mode)}
      ${row('Measured patches', fmtInt(pts.length))}
      ${row('Sets of measurements', space.sessions.length)}
      ${st.accuracy ? row('Typical accuracy', `ΔE00 ${st.accuracy.median.toFixed(2)}`) : ''}
      ${pts.length ? row('L* range', `${Math.min(...pts.map((p) => p.lab[0])).toFixed(1)} – ${Math.max(...pts.map((p) => p.lab[0])).toFixed(1)}`) : ''}
      ${pts.length ? row('Highest chroma', `C* ${most.C.toFixed(1)}`) : ''}
      ${vol ? row('Gamut volume', `${fmtInt(vol / 1000)} k ΔE³`) : ''}
      ${other ? row(`“${escapeHtml(other.name)}”`, otherVol ? `${fmtInt(otherVol / 1000)} k ΔE³ (${((otherVol / vol) * 100).toFixed(0)} %)` : 'too few patches') : ''}
    </dl>
    ${scene.refs.length ? `<p class="text-xs ${outside.length ? 'text-rose-600' : 'text-emerald-600'}">${outside.length
      ? `${outside.length} of ${scene.refs.length} reference color${scene.refs.length > 1 ? 's' : ''} outside the gamut surface: ${outside.map((r) => escapeHtml(r.name)).join(', ')}`
      : `All ${scene.refs.length} reference color${scene.refs.length > 1 ? 's' : ''} inside the gamut surface`}</p>` : ''}
    <p class="text-xs text-slate-500">The surface follows the most colorful patches measured at each lightness and hue – a chart's patches reach the printer's edge. ${other ? 'The wireframe is the space compared with.' : ''}</p>`;
}

// ---------------------------------------------------------------- interaction
let drag = null; // { x, y, yaw, pitch } while turning; pinch: { dist, zoom }
const pointers = new Map();

/** The measured patch drawn under (x, y) on the canvas (the nearest within a few pixels), or null. */
function pointAt(x, y) {
  let hit = null, best = 9;
  for (const q of projected) { const d = Math.hypot(q.x - x, q.y - y); if (d < Math.max(best, q.r + 2)) { best = d; hit = q; } }
  return hit;
}

/** The reference marker drawn under (x, y), or null (markers are drawn on top of the patches, so they win). */
const refAt = (x, y) => (prefs.refs ? projectedRefs.find((q) => Math.hypot(q.x - x, q.y - y) <= q.r + 2) ?? null : null);
/** What is under the pointer: { ref } or { pt } (a measured patch), or null. */
function thingAt(e) {
  const box = $('vsCanvas').getBoundingClientRect();
  const x = e.clientX - box.left, y = e.clientY - box.top;
  const r = refAt(x, y);
  if (r) return { ref: r.ref, x, y, box };
  const p = prefs.points ? pointAt(x, y) : null;
  return p ? { pt: p.pt, x, y, box } : { x, y, box };
}

// ---- centering the view on a color: turning and zooming then happen around it
const GLIDE_MS = 350;
let glideTimer = null;
/**
 * Move the centre of the view to `to` over GLIDE_MS (animated by loop). Animation frames can pause – a background tab,
 * a covered window – so a timer finishes the move if the frames have not.
 */
function startGlide(to) {
  glide = { from: cam.target, to: [...to] };
  clearTimeout(glideTimer);
  glideTimer = setTimeout(() => { if (glide) { cam.target = glide.to; glide = null; kick(); } }, GLIDE_MS + 100);
}
/** Center the view on `pos` (a*, L*, b*) and zoom in on it; `name` is shown in the corner. */
function centerOn(pos, name) {
  startGlide(pos);
  cam.zoom = Math.max(cam.zoom, 3);
  focus = { name, pos: [...pos] };
  $('vsFocusName').textContent = name;
  $('vsFocus').classList.remove('hidden');
  kick();
}
/** Back to the middle of the L* axis (the zoom stays). */
function uncenter() {
  startGlide(HOME.target);
  focus = null;
  $('vsFocus').classList.add('hidden');
  kick();
}
function resetView() {
  cam = { ...HOME };
  glide = null;
  focus = null;
  $('vsFocus').classList.add('hidden');
  kick();
}
const patchName = (pt) => `${pt.session}${pt.p.n != null ? ` · patch #${pt.p.n}` : ''}`;

// The right-click menu: center the view on a patch or reference, or remove a measured patch from the color space (a
// stray point). Right-click only, so a click while turning the picture never removes anything.
let menuPoint = null, menuPos = null, menuName = '';
function hideMenu() { menuPoint = null; menuPos = null; $('vsMenu').classList.add('hidden'); }
function openMenu(e) {
  e.preventDefault();
  const { ref, pt, x, y, box } = thingAt(e);
  if (!(ref || pt) || !scene?.space) { hideMenu(); return; }
  menuPoint = pt?.p ?? null;
  menuPos = ref ? ref.pos : pt.pos;
  menuName = ref ? ref.name : patchName(pt);
  $('vsMenuTitle').textContent = ref ? `${ref.name} · reference ${labText(ref.lab)}` : `${patchName(pt)} · printed ${labText(pt.p.lab)}`;
  $('vsMenuRemove').classList.toggle('hidden', !pt);
  const menu = $('vsMenu');
  menu.classList.remove('hidden');
  menu.style.left = `${Math.min(x, box.width - menu.offsetWidth - 4)}px`;
  menu.style.top = `${Math.min(y, box.height - menu.offsetHeight - 4)}px`;
  $('vsTip').classList.add('hidden');
}

function hover(e) {
  const tip = $('vsTip');
  const { ref, pt: hitPt, x, y, box } = thingAt(e);
  const hit = hitPt ? { pt: hitPt } : null;
  if (ref) {
    tip.innerHTML = `<div class="flex items-center gap-2"><span class="h-3 w-3 rounded-sm ring-1 ring-white/40" style="background:${ref.hex}"></span><b>${escapeHtml(ref.name)}</b></div>
      <div>Reference ${labText(ref.lab)}${ref.outside ? ' · outside the measured gamut' : ''}</div>`;
  } else if (hit) {
    const { p, session } = hit.pt;
    tip.innerHTML = `<div class="flex items-center gap-2"><span class="h-3 w-3 rounded-sm ring-1 ring-white/40" style="background:${hit.pt.hex}"></span><b>Printed ${labText(p.lab)}</b></div>
      <div>Asked for ${valuesText(scene.space.mode, p.x, p.x[3])}</div><div class="text-slate-300">${escapeHtml(session)}${p.n != null ? ` · patch #${p.n}` : ''}</div>`;
  } else { tip.classList.add('hidden'); return; }
  tip.classList.remove('hidden');
  tip.style.left = `${Math.min(x + 14, box.width - tip.offsetWidth - 4)}px`;
  tip.style.top = `${Math.max(4, y - tip.offsetHeight - 10)}px`;
}

function wire() {
  const canvas = $('vsCanvas');
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, e);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* a pointer that is already gone */ }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      drag = { pinch: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: cam.zoom };
    } else drag = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch };
    canvas.classList.replace('cursor-grab', 'cursor-grabbing');
    $('vsTip').classList.add('hidden');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) { hover(e); return; }
    pointers.set(e.pointerId, e);
    if (drag.pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      cam.zoom = Math.min(6, Math.max(0.4, (drag.zoom * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)) / drag.pinch));
    } else if (!drag.pinch) {
      cam.yaw = drag.yaw + (e.clientX - drag.x) * 0.008;
      cam.pitch = Math.min(1.55, Math.max(-1.55, drag.pitch + (e.clientY - drag.y) * 0.008));
    }
    kick();
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (!pointers.size) { drag = null; canvas.classList.replace('cursor-grabbing', 'cursor-grab'); }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (!drag) $('vsTip').classList.add('hidden'); });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.zoom = Math.min(6, Math.max(0.4, cam.zoom * Math.exp(-e.deltaY * 0.0012))); kick(); }, { passive: false });
  // double-click a patch or reference to center the view on it; elsewhere, back to the start view
  canvas.addEventListener('dblclick', (e) => {
    const { ref, pt } = thingAt(e);
    if (ref) centerOn(ref.pos, ref.name);
    else if (pt) centerOn(pt.pos, patchName(pt));
    else resetView();
  });
  canvas.addEventListener('contextmenu', openMenu);
  $('vsMenuCenter').onclick = () => { const pos = menuPos, name = menuName; hideMenu(); if (pos) centerOn(pos, name); };
  $('vsFocusReset').onclick = uncenter;
  $('vsMenuRemove').onclick = () => {
    const p = menuPoint, space = scene?.space;
    hideMenu();
    if (p && space) actions.removePoint?.(space.id, p);
  };
  document.addEventListener('pointerdown', (e) => { if (!$('vsMenu').contains(e.target)) hideMenu(); }, true);
  new ResizeObserver(kick).observe(canvas);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', kick);

  $('vsSpace').onchange = () => { prefs.space = $('vsSpace').value; savePrefs(); showSpaceView(); };
  $('vsCompare').onchange = () => { prefs.compare = $('vsCompare').value; savePrefs(); showSpaceView(); };
  for (const k of ['surface', 'points', 'refs', 'spin']) $(`vs_${k}`).onchange = () => { prefs[k] = $(`vs_${k}`).checked; savePrefs(); updateFullButton(); kick(); };
  const setSpin = (on) => { prefs.spin = on; $('vs_spin').checked = on; savePrefs(); updateFullButton(); kick(); };
  const view = (yaw, pitch) => { cam = { ...cam, yaw, pitch }; setSpin(false); };
  $('vsSpinBtn').onclick = () => setSpin(!prefs.spin);
  $('vsFull').onclick = toggleFullScreen;
  document.addEventListener('fullscreenchange', () => { updateFullButton(); kick(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    hideMenu();
    if (isEnlarged()) setEnlarged(false);
  });
  $('vsRefList').onclick = (e) => {
    const li = e.target.closest('[data-ref]');
    if (!li) return;
    if (e.target.closest('[data-ref-center]')) {
      const ref = scene?.refs.find((r) => r.id === li.dataset.ref);
      if (ref) { selectedRef = ref.id; prefs.refs = true; $('vs_refs').checked = true; renderRefList(); centerOn(ref.pos, ref.name); }
      return;
    }
    selectedRef = selectedRef === li.dataset.ref ? null : li.dataset.ref;
    if (selectedRef) { prefs.refs = true; $('vs_refs').checked = true; }
    renderRefList(); kick();
  };
  $('vsTop').onclick = () => view(0, Math.PI / 2 - 0.001); // the usual a*b* diagram: +a* right, +b* up
  $('vsSide').onclick = () => view(0, 0);
  $('vsReset').onclick = resetView;
}

/**
 * Called once by the Print match view, which owns the color spaces: `getData()` -> { spaces, active (id of the space in
 * use there), refs: [{ id, name, lab }], formula (DE_FORMULAS key) }; `act.removePoint(spaceId, point)` removes a
 * measured patch (the right-click menu).
 */
export function initSpaceView(getData, act = {}) {
  data = getData;
  actions = act;
  wire();
}

/** The view became visible (or its data changed): rebuild and draw. */
export function showSpaceView() {
  visible = true;
  buildScene();
  renderPanel();
  renderRefList();
  updateFullButton();
  kick();
}

export function hideSpaceView() {
  visible = false;
  clearTimeout(refJob);
  hideMenu();
  if (isEnlarged()) setEnlarged(false);
  $('vsTip').classList.add('hidden');
}
