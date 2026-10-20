# SD-10 Web Console

**Live: [sd-10.com](https://sd-10.com)** · **Try it without hardware: [sd-10.com/?demo](https://sd-10.com/?demo)**

A browser app for the **Epson SD-10 spectrometer**. It connects over Web Bluetooth and does what the official
Epson Spectrometer Android app does — measure, compare, calibrate, manage device palettes and settings — in a
desktop or Android browser. Nothing to install; measurements stay in your browser.

The SD-10 protocol was reverse-engineered from the Android app; see [docs/PROTOCOL.md](docs/PROTOCOL.md) and
[docs/FEATURES.md](docs/FEATURES.md).

> Unofficial project, not affiliated with or endorsed by Epson.

## Browser support

| Works | Doesn't work |
|---|---|
| Chrome or Edge on Windows, macOS, Linux, ChromeOS, Android | Safari, Firefox, anything on iOS/iPadOS (no Web Bluetooth) |

The demo ([sd-10.com/?demo](https://sd-10.com/?demo)) works in every modern browser.

## Using it

1. **Connect** – press **Connect device** and pick your SD-10. If it isn't listed, open the **▾** next to the
   button and switch on *Show all Bluetooth devices*.
2. **Calibrate** – close the shutter; the Measure button turns into **Calibrate**. Open the shutter afterwards.
3. **Measure** – choose a mode and press **Measure** (or the button on the SD-10):
   - **Spot** – one colour; optionally several readings combined as the median.
   - **Compare** – measures a sample against a reference and shows PASS/FAIL with ΔE. With no reference set,
     the first measurement becomes the reference. **Use as reference** (on a result) or **ref** (in History)
     picks a different one and re-compares the colour on screen; the reference row is marked **REF**.
   - **Line scan** – drag the SD-10 across a strip of up to 18 patches.
4. **Read the result** – sample/reference swatches, L\*a\*b\*, LCh, HEX/RGB, CMYK, LRV and the spectral curve.
   **Copy values** copies everything as text.

### Print match (matching colours on your printer)

Open **Print match** in the header (or [sd-10.com/#match](https://sd-10.com/#match)). It finds the values to put in your
document so your printer reproduces reference colours. It needs a computer or tablet (768 px or wider) – it works
with downloaded sheets and your RIP software, so phones only show the Console.

1. **Reference colours** – scan the colour to match (or use the last measurement, or type L\*a\*b\*) and give it the
   name it has in your artwork. **+ Add colour** matches several colours at once: they share every test sheet, and each
   colour keeps its own model and rounds.
2. **Test sheet** – pick the sheet type that matches how the colour reaches your printer and download it. Each colour
   gets its own file (named after the colour and sheet), with 16 patches around a first estimate – or 8 with
   **Patches per colour: 8** to save media.

   | Sheet type | For | You get |
   |---|---|---|
   | **Spot colours (RIP, L\*a\*b\*)** | RIPs and workflows that colour named spot colours from an L\*a\*b\* library | PDF where every patch is a uniquely named spot colour with its L\*a\*b\* as the alternate; the result is the L\*a\*b\* to enter for your named colour |
   | **L\*a\*b\* objects** | workflows that print Lab colours directly | PDF with CIE Lab (D50) patches |
   | **CMYK numbers** | documents that send CMYK to the printer (K is kept fixed; first estimate from the selected CMYK profile) | PDF with CMYK patches |
   | **RGB image (raster workflows)** | software that only accepts raster images | sRGB PNG (300 dpi); the result is an RGB / hex value for your artwork |

   **Media** is A4, Letter, A3, Tabloid or a custom width × height in mm, and **Patch size** is 10–30 mm. From 20 mm the
   values (and spot names) are printed under each patch, smaller patches only carry their number. Patches that do not
   fit on one page continue on further pages. Patches must cover the SD-10's whole measuring area – if readings of
   one patch jump around, use larger patches.
3. **Print** it exactly like the final job – same printer, media, quality and colour settings, at 100% – and scan
   the patches in number order (the SD-10's button works too; tap a patch to re-measure it). If the print is
   transferred, cured or finished (pressing, curing, laminating …), process the sheet the same way and scan the finished
   product. On textured or uneven surfaces set **Readings per patch** to 3 or more: each patch is then the average of
   several readings taken at different spots (a **!** marks patches whose readings disagree by more than 1.5 ΔE00).
4. **Results** – for each colour, the app models how your printer responds around it and calculates the values that
   should print closest to the reference, with the predicted ΔE00. **Make next sheet** prints a finer sheet centred on
   those answers; its centre patches verify them. A colour reports **Done** once its values print within your
   tolerance – **Accept** it to leave it off the next sheets.

**Colour difference:** matches are judged with **ΔE00** (graphic arts, the default), or for textiles with **ΔE00 2:1:1**
or **ΔE CMC 2:1**, which judge lightness differences more leniently, as people do on fabric. The solver then also aims
for hue and chroma first. Changing the formula re-judges existing results without new measurements.

**Metamerism check:** when the reference was measured with the SD-10 (not typed in), each result compares the best
printed patch with the reference under daylight (D65), warm / incandescent light (A), tri-band shop lighting (F11,
LED-like) and cool white fluorescent (F2) – the difference you would see, and the metamerism index (how far they drift
apart once the D50 difference is taken out). A large index means the ink and the reference reflect light differently,
so the colours match under one light but not another; check the colour under the light the product will be seen in.

**Printer profile (gamut check):** add the ICC output profile your RIP uses for the printer, ink and media (**+ .icc**;
CMYK or multi-ink profiles). Each reference is then checked against it: inside the gamut, at its edge, or outside – with
the closest printable colour and how far it is. An out-of-gamut colour cannot be matched closer than that, whatever the
rounds. The profile is kept in this browser and only used for this check.

Each round's move is limited to the range the sheet's measurements can be trusted for, and the app never recommends
values predicted to print worse than a patch you already measured. If a reference is outside what the printer and
media can reproduce, it says so and gives the closest values instead of chasing it. With the simulated printer in the
demo, a first estimate 22 ΔE00 away reaches about 0.2 ΔE00 in three to four rounds; a real RIP's first estimate is
usually much closer.

**Spot library files:** in L\*a\*b\* modes the app also exports spot colour libraries for the RIP, in the format
chosen under **Spot library format**:

| Format | Notes |
|---|---|
| **CxF3** (`.cxf`) | the ISO 17972-1 colour exchange standard that many RIPs import |
| **Adobe Color Book** (`.acb`) | read by Photoshop and RIPs that import Adobe colour books; stores L\* in steps of 0.4 and a\*/b\* as whole numbers (the spot library shows what that rounding costs) |
| **Epson Edge Print** (`.epcc`) | Edge Print colour collection, values with one decimal |
| **Roland VersaWorks** (`.spot`) | VersaWorks 6 spot colour library (it imports switched off – enable it in the library list) |

**Sheet library** holds the test sheet's patch colours (import and enable it before printing the sheet, so the patches
go through the RIP's named-colour path). When a match is done, **Add to spot library** puts the result into your
**Spot library** under the colour's name – exactly the name used in your artwork, since the RIP finds spot colours by
name. The spot library collects colours across matches (rename, replace or remove them; it is kept in this browser).
You can also type a colour in (or take the last measurement) and **Import library…** – any of the formats above, e.g.
one exported from your RIP – to update existing colours. CxF colours are read from their D50 / 2° L\*a\*b\* values, or
computed from their reflectance spectra; colours without L\*a\*b\* (e.g. CMYK entries) are skipped. **Download
library** saves all of them as one file to import into the RIP. Other formats can be added from a sample library
exported by that RIP.

### Other features

| Feature | Where |
|---|---|
| Battery, charging, calibration and shutter state, device errors | **Device** card (refreshes when the device reports a change) |
| Device name, buzzer, auto power-off, language, panel direction | **Device → Device settings** |
| Write colours to the device's 4 palette slots / delete a slot | **Device palettes** – tick colours in History first |
| History with CSV export | **History** – stored in this browser |
| Import measurements saved on the SD-10 | **Sync device history** (new ones) / **Re-import all**; *Clear* resets the sync position |
| CMYK profile and rendering intent | under the result; **+ add .icc** to use your own CMYK profile |
| Every Bluetooth frame, decoded | **Protocol log** at the bottom (collapsed by default) |

### Colour accuracy

- **Lab** uses the illuminant/observer weighting tables recovered from the app's own colour library, so values
  match the official app (checked against the native code to better than 0.001).
- **CMYK** is computed like the app: Lab (D50/2°) → the selected ICC profile, default **EpsonWideCMYK_Ver2**,
  **perceptual**. It agrees with the app's own colour engine to within 0.42 percentage points (mean 0.15).
- **Your own profiles**: CMYK output profiles, ICC v2 or v4 (Lab or XYZ PCS). They are kept in this browser
  (IndexedDB); if the browser blocks storage they work for the current session only.
- **HEX/RGB** is sRGB (D50 → D65 Bradford). **LRV** is Y under D65/10°.

## Tests

Open these pages in Chrome (on the live site, e.g. [sd-10.com/test/](https://sd-10.com/test/), or a local copy):

| Page | Checks |
|---|---|
| [`test/index.html`](https://sd-10.com/test/index.html) | 95 checks: command frames vs. the app's own (emulated) code, Lab and CMYK vs. the native libraries, ΔE2000 reference data, ICC v4 parsing, print-match model fitting/convergence for all four sheet types, PDF/PNG sheet structure, CxF3 structure, Adobe Color Book bytes, Edge Print .epcc vs. a real Edge Print export, ΔE CMC / ΔE00 2:1:1 vs. colour-science, metamerism, ICC AToB vs. LittleCMS and the gamut check, compact design, multi-page layout, library import (CxF incl. spectra, ACB, .epcc, .spot), VersaWorks .spot output vs. a real VersaWorks export, a full session against the simulator |
| [`test/ui-smoke.html`](https://sd-10.com/test/ui-smoke.html) | 34 checks driving the real UI against the simulator (calibrate, measure, compare, line scan, history sync, palettes, settings, custom ICC) |
| [`test/mobile-check.html`](https://sd-10.com/test/mobile-check.html) | Layout at 375 px wide (no sideways scrolling) plus the compare/reference flows |
| [`test/match-smoke.html`](https://sd-10.com/test/match-smoke.html) | 44 checks for Print match against the simulated device and printer: rounds to within tolerance, textile ΔE, metamerism and printer-profile gamut checks, several colours on custom media (one PDF per colour, accepting a colour), spot colour sheets with averaged readings, a spot library (add, import, type in) exported as CxF3 / Adobe Color Book / VersaWorks, RGB/PNG sheets |

## Project layout

```
index.html          page and layout
css/app.css         compiled Tailwind stylesheet (source: css/tailwind.src.css)
js/app.js           UI controller
js/session.js       SD-10 session: byte routing, command queue + FF/FE acks, handshake, operations
js/protocol.js      command builders and reply parsers
js/transport.js     Web Bluetooth GATT transport
js/mock.js          simulated SD-10 (demo mode and tests)
js/color.js         spectrum → Lab, ΔE (76/94/2000/CMC), sRGB, LRV
js/weights.js       CIE weighting tables from the app (12 illuminants × 2 observers)
js/match.js         Print match: patch design, printer-response model, solver, PDF / PNG sheets
js/rip-export.js    spot colour library files for RIPs (CxF3, Adobe Color Book, Edge Print, VersaWorks): export and import
js/printer-sim.js   simulated CMYK printer (demo and tests)
js/icc.js           ICC engine (lut8/lut16/lutBtoA) for Lab → CMYK; custom profile storage
js/storage.js       history and preferences (localStorage)
icc/                CMYK profiles bundled with the app
docs/               protocol, feature and development notes
test/               test pages and reference data
bump-version.sh     release helper
build-css.sh        rebuilds css/app.css
```

## Troubleshooting

- **SD-10 not in the device list** – switch on *Show all Bluetooth devices* (▾ next to Connect), make sure the
  SD-10 is on and not connected to the phone app.
- **"Device rejected control"** – another app (e.g. the Epson app) holds the session; close it and reconnect.
- **Anything else** – open the **Protocol log**, press *Copy* and include it in a bug report.
- Large palette writes are slow because writes go in 20-byte chunks; raise `chunkSize` in `js/transport.js` if
  your setup allows bigger writes.
- Firmware updates are intentionally not supported.

## Licences

The ICC profiles in `icc/` come from the Epson Spectrometer app. The Adobe profiles are covered by
[icc/AdobeLicenseStatement.txt](icc/AdobeLicenseStatement.txt); the EpsonWideCMYK profiles belong to Epson.
