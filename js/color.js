// Colour science for the SD-10 web app.
// spectrumToLab reproduces the Android app's librmcc.so conversion using weights recovered from it.
import { WEIGHTS } from './weights.js';
import { LIGHT_SOURCE_NAME } from './protocol.js';

const D = 6 / 29;
const f = (t) => (t > D ** 3 ? Math.cbrt(t) : t / (3 * D * D) + 4 / 29);
const finv = (v) => (v > D ? v ** 3 : 3 * D * D * (v - 4 / 29));

export function weightsFor(lightSource, observer) {
  const w = WEIGHTS[`${LIGHT_SOURCE_NAME[lightSource] ?? 'D50'}_${observer === 10 ? 10 : 2}`];
  if (!w) throw new Error(`no weights for illuminant ${lightSource} / ${observer}°`);
  return w;
}

/** Normalized tristimulus (X/Xn, Y/Yn, Z/Zn) of a 31-band 400..700 nm reflectance spectrum (0..1). */
export function spectrumToT(spectrum, lightSource = 0, observer = 2) {
  const w = weightsFor(lightSource, observer);
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < 31; i++) {
    const r = spectrum[i] ?? 0;
    x += r * w.x[i]; y += r * w.y[i]; z += r * w.z[i];
  }
  return [x, y, z];
}

export function tToLab([tx, ty, tz]) {
  const L = Math.min(Math.max(116 * f(ty) - 16, 0), 130.15); // librmcc clamps L to 0..130.15
  return [L, 500 * (f(tx) - f(ty)), 200 * (f(ty) - f(tz))];
}

export const spectrumToLab = (spectrum, lightSource = 0, observer = 2) => tToLab(spectrumToT(spectrum, lightSource, observer));

export function labToLch([L, a, b]) {
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, Math.hypot(a, b), h];
}

// ---------------------------------------------------------------- colour difference
export function deltaE76(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }

export function deltaE94(ref, smp, textile = false) {
  const [kL, K1, K2] = textile ? [2, 0.048, 0.014] : [1, 0.045, 0.015];
  const dL = ref[0] - smp[0];
  const C1 = Math.hypot(ref[1], ref[2]), C2 = Math.hypot(smp[1], smp[2]);
  const dC = C1 - C2;
  const dH2 = Math.max((ref[1] - smp[1]) ** 2 + (ref[2] - smp[2]) ** 2 - dC * dC, 0);
  const SC = 1 + K1 * C1, SH = 1 + K2 * C1;
  return Math.sqrt((dL / kL) ** 2 + (dC / SC) ** 2 + dH2 / (SH * SH));
}

export function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (a, b) => (a === 0 && b === 0 ? 0 : ((Math.atan2(b, a) / rad) + 360) % 360);
  const h1p = hp(a1p, b1), h2p = hp(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360;
    hbp /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}

/** formula: 0 ΔE00, 1 ΔE94 graphic arts, 2 ΔE94 textile, 3 ΔE76 (EPSPM_COLORDIFFFORMULA). */
export function deltaE(ref, smp, formula = 0) {
  switch (formula) {
    case 1: return deltaE94(ref, smp, false);
    case 2: return deltaE94(ref, smp, true);
    case 3: return deltaE76(ref, smp);
    default: return deltaE2000(ref, smp);
  }
}

// ---------------------------------------------------------------- display colour
// XYZ(D50) -> linear sRGB, Bradford-adapted (Lindbloom).
const M_D50_SRGB = [
  [3.1338561, -1.6168667, -0.4906146],
  [-0.9787684, 1.9161415, 0.033454],
  [0.0719453, -0.2289914, 1.4052427],
];
const D50_WHITE = [0.96422, 1.0, 0.82521];

/** sRGB (0..255, clipped) from Lab relative to D50 / 2°. Returns { rgb, inGamut }. */
export function labD50ToSrgb(lab) {
  const fy = (lab[0] + 16) / 116;
  const xyz = [finv(fy + lab[1] / 500) * D50_WHITE[0], finv(fy) * D50_WHITE[1], finv(fy - lab[2] / 200) * D50_WHITE[2]];
  let inGamut = true;
  const rgb = M_D50_SRGB.map((row) => {
    let v = row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2];
    if (v < -0.001 || v > 1.001) inGamut = false;
    v = Math.min(Math.max(v, 0), 1);
    v = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(v * 255);
  });
  return { rgb, inGamut };
}

// linear sRGB -> XYZ(D50), the inverse of M_D50_SRGB (Bradford-adapted, Lindbloom).
const M_SRGB_D50 = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
];

/** Lab relative to D50 / 2° from sRGB (0..255). */
export function srgbToLabD50(rgb) {
  const lin = rgb.map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const [x, y, z] = M_SRGB_D50.map((row, i) => (row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]) / D50_WHITE[i]);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export const rgbHex =(rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

/** Everything the UI shows for a spectrum. */
export function describeSpectrum(spectrum, lightSource = 0, observer = 2) {
  const lab = spectrumToLab(spectrum, lightSource, observer);
  const display = labD50ToSrgb(spectrumToLab(spectrum, 0, 2));
  return {
    lab,
    lch: labToLch(lab),
    rgb: display.rgb,
    hex: rgbHex(display.rgb),
    inGamut: display.inGamut,
    lrv: spectrumToT(spectrum, 1, 10)[1] * 100, // Light Reflectance Value: Y under D65 / 10°
  };
}

/** Per-channel median, as the app's GetColorMedianValue does for multi-reading measurements. */
export function medianLab(labs) {
  const med = (xs) => { const s = [...xs].sort((p, q) => p - q); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return [0, 1, 2].map((k) => med(labs.map((l) => l[k])));
}

export function meanSpectrum(spectra) {
  return Array.from({ length: 31 }, (_, i) => spectra.reduce((s, sp) => s + sp[i], 0) / spectra.length);
}

/** Approximate display colour of a wavelength (for the chart gradient). */
export function wavelengthColor(nm) {
  let r = 0, g = 0, b = 0;
  if (nm < 440) { r = (440 - nm) / 60; b = 1; } else if (nm < 490) { g = (nm - 440) / 50; b = 1; }
  else if (nm < 510) { g = 1; b = (510 - nm) / 20; } else if (nm < 580) { r = (nm - 510) / 70; g = 1; }
  else if (nm < 645) { r = 1; g = (645 - nm) / 65; } else { r = 1; }
  const k = nm < 420 ? 0.3 + (0.7 * (nm - 380)) / 40 : nm > 680 ? 0.3 + (0.7 * (750 - nm)) / 70 : 1;
  return `rgb(${Math.round(255 * r * k)},${Math.round(255 * g * k)},${Math.round(255 * b * k)})`;
}
