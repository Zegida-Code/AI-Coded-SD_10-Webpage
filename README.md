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

### Print match (matching a colour on your printer)

Open the **Print match** tab (or [sd-10.com/#match](https://sd-10.com/#match)). It finds the values to put in your
document so your printer reproduces a reference colour:

1. **Reference** – scan the colour to match (or use the last measurement, or type L\*a\*b\*).
2. **Test sheet** – choose *CMYK* (recommended for CMYK printers; K is kept fixed) or *L\*a\*b\** values and
   download the PDF: 16 patches around a first estimate (CMYK estimates come from the selected CMYK profile).
3. **Print** it exactly like the final job – same printer, paper, quality and colour settings, at 100% – and scan
   the patches in number order (the SD-10's button works too; tap a patch to re-measure it).
4. **Result** – the app models how your printer responds around the colour and calculates the values that should
   print closest to the reference, with the predicted ΔE00. **Make refinement sheet** prints a finer sheet centred on
   that answer; its centre patch verifies it. It reports **Done** once the values print within your tolerance.

With the simulated printer in the demo, a first estimate 22 ΔE00 away reaches about 0.2 ΔE00 in three rounds. How
many rounds a real printer needs depends on how far the profile's first estimate is from what it actually prints.
If the reference is outside what the printer and paper can reproduce, the app says so and gives the closest values.

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
| [`test/index.html`](https://sd-10.com/test/index.html) | 64 checks: command frames vs. the app's own (emulated) code, Lab and CMYK vs. the native libraries, ΔE2000 reference data, ICC v4 parsing, print-match model fitting/convergence and PDF structure, a full session against the simulator |
| [`test/ui-smoke.html`](https://sd-10.com/test/ui-smoke.html) | 34 checks driving the real UI against the simulator (calibrate, measure, compare, line scan, history sync, palettes, settings, custom ICC) |
| [`test/mobile-check.html`](https://sd-10.com/test/mobile-check.html) | Layout at 375 px wide (no sideways scrolling) plus the compare/reference flows |
| [`test/match-smoke.html`](https://sd-10.com/test/match-smoke.html) | 17 checks for Print match against the simulated device and printer: sheet, PDF, scanning, three rounds to within tolerance |

## Project layout

```
index.html          page and layout
css/app.css         compiled Tailwind stylesheet (source: css/tailwind.src.css)
js/app.js           UI controller
js/session.js       SD-10 session: byte routing, command queue + FF/FE acks, handshake, operations
js/protocol.js      command builders and reply parsers
js/transport.js     Web Bluetooth GATT transport
js/mock.js          simulated SD-10 (demo mode and tests)
js/color.js         spectrum → Lab, ΔE (76/94/2000), sRGB, LRV
js/weights.js       CIE weighting tables from the app (12 illuminants × 2 observers)
js/match.js         Print match: patch design, printer-response model, solver, PDF sheet
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
