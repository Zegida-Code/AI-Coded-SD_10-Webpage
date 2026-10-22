// Mini color space: a small, slowly turning 3-D picture of a color space for the spare room of the Print match color
// space card – the measured patches, the outline of their gamut surface and the reference colors (ringed red when
// outside). With no color space it shows a faint example shape. It only draws while it has room and is on screen, and
// it stands still for people who prefer reduced motion. A click opens the full Color space view.
import { displayHex } from './ui.js';
import { HUES, gamutShell, shellChroma } from './space-view.js';

/** Below this height (px) the spare room is too small for a picture: the preview hides. */
const MIN_HEIGHT = 110;
const SPIN = 0.00018; // radians per ms
const PITCH = 0.38;

/** A gamut-like cloud of colors for the example shape (no color space yet). */
function exampleLabs() {
  const labs = [];
  for (let L = 12; L <= 94; L += 6) {
    const lift = Math.sin((Math.PI * (L - 4)) / 96) ** 0.8;
    for (let h = 0; h < 360; h += 15) {
      const rad = (h * Math.PI) / 180;
      const Cmax = 70 * lift * (0.85 + 0.2 * Math.cos(rad - 1.4) + 0.1 * Math.cos(2 * rad));
      for (const f of [1, 0.6]) labs.push([L, f * Cmax * Math.cos(rad), f * Cmax * Math.sin(rad)]);
    }
  }
  return labs;
}
let example = null;

/**
 * Set up the preview in `slot` (the spare room – its height decides whether the picture shows) with `canvas` and the
 * caption element `note`. `onOpen()` is called on a click. Returns { set({ labs, refs, selected, name }) } – `labs` of the
 * measured patches (null: the example), `refs` [{ id, lab }].
 */
export function createMiniSpace(slot, canvas, note, { onOpen }) {
  let scene = null, yaw = -0.65, frame = 0, last = 0, onScreen = true, roomy = false;
  const still = matchMedia('(prefers-reduced-motion: reduce)');

  function set({ labs, refs = [], selected = null, name = '' }) {
    const isExample = !labs;
    const pts = isExample ? (example ??= exampleLabs()) : labs;
    const shell = gamutShell(pts);
    const outside = (lab) => !!shell && Math.hypot(lab[1], lab[2]) > shellChroma(shell, lab[0], (Math.atan2(lab[2], lab[1]) * 180) / Math.PI) + 1;
    const chroma = [...pts, ...refs.map((r) => r.lab)].map((l) => Math.hypot(l[1], l[2]));
    scene = {
      isExample,
      R: Math.max(60, Math.min(140, Math.max(0, ...chroma) + 10)),
      points: pts.map((lab) => ({ pos: [lab[1], lab[0], lab[2]], hex: displayHex(lab) })),
      shell,
      refs: isExample ? [] : refs.map((r) => ({ pos: [r.lab[1], r.lab[0], r.lab[2]], hex: displayHex(r.lab), outside: outside(r.lab), selected: r.id === selected })),
    };
    note.textContent = isExample ? 'An example – create a chart to see what your printer really prints' : `${name} · click to open in 3-D`;
    canvas.title = isExample ? '' : 'Open this color space in the 3-D view';
    canvas.classList.toggle('cursor-pointer', !isExample);
    draw();
    run();
  }

  function project([a, L, b], W, H) {
    const y = L - 50;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
    const X = a * cy - b * sy, Z0 = a * sy + b * cy;
    const Y = y * cp + Z0 * sp, Z = -y * sp + Z0 * cp;
    const scale = Math.min(W / (2.1 * scene.R), H / 112);
    const s = (scale * 700) / (700 + Z);
    return { x: W / 2 + X * s, y: H * 0.5 - Y * s, z: Z, s };
  }

  function draw() {
    if (!scene || !roomy) return;
    const dpr = devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const ink = (alpha) => `rgba(${dark ? '203,213,225' : '51,65,85'},${alpha})`;
    // the L* axis, and the outline of the gamut surface every other ring
    const axis = [project([0, 0, 0], W, H), project([0, 100, 0], W, H)];
    ctx.strokeStyle = ink(0.25); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(axis[0].x, axis[0].y); ctx.lineTo(axis[1].x, axis[1].y); ctx.stroke();
    if (scene.shell) {
      ctx.strokeStyle = ink(scene.isExample ? 0.12 : 0.22);
      scene.shell.rings.forEach((ring, k) => {
        if (k % 2) return;
        ctx.beginPath();
        for (let i = 0; i <= HUES; i++) {
          const h = ((i % HUES) * 2 * Math.PI) / HUES, r = ring.r[i % HUES];
          const p = project([r * Math.cos(h), ring.L, r * Math.sin(h)], W, H);
          if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        }
        ctx.stroke();
      });
    }
    const items = scene.points.map((pt) => ({ pt, p: project(pt.pos, W, H) })).sort((a, b) => b.p.z - a.p.z);
    ctx.globalAlpha = scene.isExample ? 0.35 : 1;
    for (const { pt, p } of items) {
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.5, 1.5 * p.s), 0, 2 * Math.PI);
      ctx.fillStyle = pt.hex; ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const ref of scene.refs) {
      const p = project(ref.pos, W, H);
      ctx.beginPath(); ctx.arc(p.x, p.y, ref.selected ? 6 : 4.5, 0, 2 * Math.PI);
      ctx.fillStyle = ref.hex; ctx.fill();
      ctx.lineWidth = ref.selected ? 2.5 : 1.5; ctx.strokeStyle = ref.outside ? '#e11d48' : dark ? '#fff' : '#0f172a'; ctx.stroke();
    }
  }

  // turning: only while there is room, the picture is on screen and the page is visible
  const turning = () => roomy && onScreen && !document.hidden && !still.matches && !!scene;
  function loop(time) {
    frame = 0;
    if (!turning()) return;
    yaw += Math.min(time - (last || time), 50) * SPIN;
    last = time;
    draw();
    frame = requestAnimationFrame(loop);
  }
  function run() { if (turning() && !frame) { last = 0; frame = requestAnimationFrame(loop); } }

  new ResizeObserver(() => {
    roomy = slot.clientHeight >= MIN_HEIGHT;
    slot.classList.toggle('invisible', !roomy);
    draw();
    run();
  }).observe(slot);
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; run(); }).observe(slot);
  document.addEventListener('visibilitychange', run);
  still.addEventListener('change', () => { draw(); run(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
  canvas.addEventListener('click', () => { if (scene && !scene.isExample) onOpen(); });

  return { set };
}
