// Color space view: a large, turnable 3-D picture of a measured color space in CIE L*a*b* – every measured patch in the
// color it printed, the gamut surface around them, optionally a second space as a wireframe to compare (another
// media or printer), and the Print match reference colors. Plain canvas 2-D with a small perspective projection;
// drag to turn, scroll or pinch to zoom, hover a patch for its values.
// The data comes from the Print match view (initSpaceView's `data` callback), which owns the color spaces.
import { $, displayHex, escapeHtml } from './ui.js';
import { spaceStats } from './colorspace.js';
import { MODE_NAME } from './match.js';

let data = () => ({ spaces: [], active: '', refs: [] });
const PREFS_KEY = 'sd10.space3d';
const prefs = (() => {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { /* ignore */ }
  return { surface: true, points: true, refs: true, spin: true, space: '', compare: '', ...p };
})();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

// camera: yaw turns around the L* axis, pitch tilts towards a view from above; zoom 1 fits the L*a*b* range
const HOME = { yaw: -0.65, pitch: 0.38, zoom: 1 };
let cam = { ...HOME };
let visible = false, frame = 0, lastTime = 0, dirty = true;
let scene = null; // { space, shell, other, otherShell, points: [{ pos, hex, p }], refs } – rebuilt when the data changes
let projected = []; // screen positions of the points drawn last, for hovering

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
  const x = a, y = L - 50, z = b;
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

/** Draw the depth-sorted items; remembers where the patches landed, for hovering. */
function drawItems(items, { wire }) {
  projected = [];
  const faceAlpha = prefs.points ? 0.22 : 0.55; // the surface is see-through while the patches show
  for (const it of items) {
    if (it.kind === 'face') {
      const q = it.quad.map(project);
      ctx.beginPath(); q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
      ctx.globalAlpha = faceAlpha; ctx.fillStyle = it.hex; ctx.fill();
      ctx.globalAlpha = 0.25; ctx.strokeStyle = it.hex; ctx.lineWidth = 0.6; ctx.stroke(); ctx.globalAlpha = 1;
    } else if (it.kind === 'wire') {
      line(it.a, it.b, wire);
    } else {
      const p = project(it.pt.pos), r = Math.max(2, 1.9 * p.s);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = it.pt.hex; ctx.fill();
      ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke();
      projected.push({ x: p.x, y: p.y, r, pt: it.pt });
    }
  }
}

/** Reference colors on top of everything, with their names – ringed red when outside the surface. */
function drawReferences({ text }) {
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  for (const ref of scene.refs) {
    const p = project(ref.pos);
    ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, 2 * Math.PI);
    ctx.fillStyle = ref.hex; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = ref.outside ? '#e11d48' : text; ctx.stroke();
    ctx.fillStyle = text; ctx.textAlign = 'left';
    ctx.fillText(`${ref.name}${ref.outside ? ' (outside)' : ''}`, p.x + 11, p.y + 4);
  }
}

function draw() {
  dirty = false;
  if (!fitCanvas()) return;
  const colors = theme();
  drawAxes(colors);
  drawItems(depthItems(), colors);
  if (prefs.refs && scene) drawReferences(colors);
}

function loop(time) {
  frame = 0;
  if (!visible) return;
  if (prefs.spin && !drag) { cam.yaw += Math.min(time - lastTime, 50) * 0.00025; dirty = true; }
  lastTime = time;
  if (dirty) draw();
  frame = requestAnimationFrame(loop);
}
const kick = () => { dirty = true; if (visible && !frame) frame = requestAnimationFrame((t) => { lastTime = t; loop(t); }); };

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

function hover(e) {
  const tip = $('vsTip');
  const box = $('vsCanvas').getBoundingClientRect();
  const x = e.clientX - box.left, y = e.clientY - box.top;
  let hit = null, best = 9;
  for (const q of projected) { const d = Math.hypot(q.x - x, q.y - y); if (d < Math.max(best, q.r + 2)) { best = d; hit = q; } }
  if (!hit) { tip.classList.add('hidden'); return; }
  const { p, session } = hit.pt;
  const mode = scene.space.mode;
  const asked = mode === 'cmyk' ? `C ${p.x[0]} M ${p.x[1]} Y ${p.x[2]} K ${p.x[3]}` : mode === 'rgb' ? `R ${p.x[0]} G ${p.x[1]} B ${p.x[2]}` : `L* ${p.x[0]} a* ${p.x[1]} b* ${p.x[2]}`;
  tip.innerHTML = `<div class="flex items-center gap-2"><span class="h-3 w-3 rounded-sm ring-1 ring-white/40" style="background:${hit.pt.hex}"></span><b>Printed L* ${p.lab[0].toFixed(1)} a* ${p.lab[1].toFixed(1)} b* ${p.lab[2].toFixed(1)}</b></div>
    <div>Asked for ${asked}</div><div class="text-slate-300">${escapeHtml(session)}${p.n != null ? ` · patch #${p.n}` : ''}</div>`;
  tip.classList.remove('hidden');
  tip.style.left = `${Math.min(x + 14, box.width - tip.offsetWidth - 4)}px`;
  tip.style.top = `${Math.max(4, y - tip.offsetHeight - 10)}px`;
}

function wire() {
  const canvas = $('vsCanvas');
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, e);
    canvas.setPointerCapture(e.pointerId);
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
  canvas.addEventListener('dblclick', () => { cam = { ...HOME }; kick(); });
  new ResizeObserver(kick).observe(canvas);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', kick);

  $('vsSpace').onchange = () => { prefs.space = $('vsSpace').value; savePrefs(); showSpaceView(); };
  $('vsCompare').onchange = () => { prefs.compare = $('vsCompare').value; savePrefs(); showSpaceView(); };
  for (const k of ['surface', 'points', 'refs', 'spin']) $(`vs_${k}`).onchange = () => { prefs[k] = $(`vs_${k}`).checked; savePrefs(); kick(); };
  const view = (yaw, pitch) => { cam = { ...cam, yaw, pitch }; prefs.spin = false; $('vs_spin').checked = false; savePrefs(); kick(); };
  $('vsTop').onclick = () => view(0, Math.PI / 2 - 0.001); // the usual a*b* diagram: +a* right, +b* up
  $('vsSide').onclick = () => view(0, 0);
  $('vsReset').onclick = () => { cam = { ...HOME }; kick(); };
}

/** Called once by the Print match view, which owns the color spaces: `getData()` -> { spaces, active, refs: [{ name, lab }] }. */
export function initSpaceView(getData) {
  data = getData;
  wire();
}

/** The view became visible (or its data changed): rebuild and draw. */
export function showSpaceView() {
  visible = true;
  buildScene();
  renderPanel();
  kick();
}

export function hideSpaceView() {
  visible = false;
  $('vsTip').classList.add('hidden');
}
