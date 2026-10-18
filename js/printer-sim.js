// Simulated CMYK printer for the demo and tests: CMYK (%) -> reflectance spectrum (400..700 nm, 31 bands).
// Subtractive model with dot gain, unwanted ink absorptions and paper white, so it deliberately does NOT
// agree with any ICC profile – that gives the Print match loop a realistic first-guess error to correct.

const NM = Array.from({ length: 31 }, (_, i) => 400 + 10 * i);
const g = (nm, c, w) => Math.exp(-(((nm - c) / w) ** 2));

// Absorbance spectra (optical density at 100% coverage) of the four inks.
const INK = {
  c: NM.map((nm) => 1.35 * g(nm, 640, 70) + 0.12 * g(nm, 520, 60)),
  m: NM.map((nm) => 1.25 * g(nm, 545, 45) + 0.18 * g(nm, 430, 40)),
  y: NM.map((nm) => 1.15 * g(nm, 430, 45) + 0.05 * g(nm, 520, 40)),
  k: NM.map(() => 1.6),
};
const PAPER = NM.map((nm) => 0.86 + 0.04 * g(nm, 450, 40)); // slightly blue-white (optical brighteners)

/** Dot gain: a 50% tint prints like ~62%. */
const gain = (v) => { const t = Math.min(Math.max(v / 100, 0), 1); return t + 0.48 * t * (1 - t); };

export function printSpectrum([c, m, y, k]) {
  const tc = gain(c), tm = gain(m), ty = gain(y), tk = gain(k);
  return NM.map((_, i) => PAPER[i] * 10 ** -(tc * INK.c[i] + tm * INK.m[i] + ty * INK.y[i] + tk * INK.k[i]));
}
