# SD-10 Web Console

**Live: [sd-10.com](https://sd-10.com)** · **Try it without hardware: [sd-10.com/?demo](https://sd-10.com/?demo)**

A browser app for the **Epson SD-10 spectrometer**. It connects over Web Bluetooth and does what the official Epson
Spectrometer Android app does – measure, compare, calibrate, and manage the device's palettes and settings – in a
desktop or Android browser. On top of that, **Print match** helps you get a printer to reproduce a colour.
There is nothing to install, and your measurements stay in your browser.

The SD-10 protocol was reverse-engineered from the Android app; see [docs/PROTOCOL.md](docs/PROTOCOL.md) and
[docs/FEATURES.md](docs/FEATURES.md).

> Unofficial project – not affiliated with or endorsed by Epson.

## Browser support

| Works | Doesn't work |
|---|---|
| Chrome or Edge on Windows, macOS, Linux, ChromeOS and Android | Safari, Firefox, and anything on iOS / iPadOS (no Web Bluetooth) |

The demo ([sd-10.com/?demo](https://sd-10.com/?demo)) runs in every modern browser.

## Measuring (Console)

1. **Connect** – press **Connect device** and choose your SD-10. If it isn't listed, open the **▾** next to the
   button and switch on *Show all Bluetooth devices*.
2. **Calibrate** – close the shutter and the Measure button becomes **Calibrate**. Open the shutter again afterwards.
3. **Measure** – choose a mode and press **Measure**, or the button on the SD-10:
   - **Spot** – one colour, optionally the median of several readings.
   - **Compare** – a sample against a reference, with PASS / FAIL and the ΔE. With no reference yet, the first
     measurement becomes the reference. **Use as reference** (under a result) or **ref** (in History) picks another
     one and re-compares the colour on screen; the reference is marked **REF** in History.
   - **Line scan** – drag the SD-10 across a strip of up to 18 patches.
4. **Read the result** – swatches, L\*a\*b\*, LCh, HEX / RGB, CMYK, LRV and the spectral curve. **Copy values** copies
   them all as text.

| Also in the Console | Where |
|---|---|
| Battery, charging, calibration and shutter state, device errors | **Device** card – updates when the device reports a change |
| Device name, buzzer, auto power-off, language, panel direction | **Device → Device settings** |
| Write colours to the device's four palette slots, or clear a slot | **Device palettes** – tick the colours in History first |
| Measurement history with CSV export | **History** – kept in this browser |
| Import measurements stored on the SD-10 | **Sync device history** (new ones) or **Re-import all**; *Clear* resets the sync position |
| CMYK profile and rendering intent | Under the result; **+ add .icc** adds your own CMYK profile |
| Every Bluetooth frame, decoded | **Protocol log** at the bottom (collapsed by default) |

## Print match

**Print match** (in the header, or [sd-10.com/#match](https://sd-10.com/#match)) finds the values to put in your
artwork or RIP so that your printer reproduces a reference colour. It works in rounds: print a test sheet, scan it,
and the app works out how your printer responds and which values should hit the colour – then a finer sheet confirms
it. It needs a computer or tablet (768 px or wider); phones only show the Console. On wide screens the colour list and
settings sit in a column at the left, next to the selected colour's workflow.

### 1. Reference colours

Scan the colour you want to match (or use the last measurement, or type in L\*a\*b\*) and give it the name it has in
your artwork. **+ Add colour** lets you work on several colours at once. Each colour has its own sheets, scan
position and result, and the reference, sheet, scan and result cards work on the colour **selected in the list** – so you can scan one
colour's sheet while another is still printing or curing, and switching colours never disturbs the others.

### 2. Test sheet

Pick the sheet type that matches how colour reaches your printer, then **Create sheet** and download it:

| Sheet type | For | What you get |
|---|---|---|
| **Spot colours (RIP, L\*a\*b\*)** | RIPs that colour named spot colours from an L\*a\*b\* library | A PDF in which every patch is a uniquely named spot colour, with its L\*a\*b\* as the fallback. The result is the L\*a\*b\* to enter for your named colour. |
| **L\*a\*b\* objects** | Workflows that print Lab colours directly | A PDF with CIE L\*a\*b\* (D50) patches |
| **CMYK numbers** | Documents that send CMYK values to the printer | A PDF with CMYK patches (K stays fixed; the first estimate comes from the CMYK profile chosen in the Console) |
| **RGB image (raster workflows)** | Software that only accepts images | A 300 dpi sRGB PNG; the result is an RGB / hex value for your artwork |

Each sheet has **16 patches** around the current estimate, or **8** (*Patches per colour*) to save media and scanning.

**Media and patch size**

- **Media** is a custom width × height in mm by default, or A4, Letter, A3 or Tabloid – a preset simply fills in its
  size, and editing the size makes it custom again. **Save** keeps the current size under a name (listed under
  *Your sizes*; **✕** removes it), and the size you used last is remembered.
- The height can't go below one row of patches plus the sheet's text. The app shows that minimum and the height that
  fits a whole sheet on one page, and raises the height for you (and says so) when a change needs more room.
- On wide, short media – such as a 700 mm roll – the sheet's text moves beside the patches, so a sheet with 20 mm
  patches can be as thin as about 40 mm.
- **Patch size** is 10–30 mm. From 20 mm, each patch also carries its values (and spot name); smaller patches only
  carry their number. Patches must cover the SD-10's whole measuring area – if readings of one patch jump around,
  use larger patches. Sheets that don't fit on one page continue on further pages.

### 3. Print and scan

Print the sheet exactly like the final job – same printer, media, quality and colour settings, at 100% – and scan
the patches in number order with **Measure** or the SD-10's button (tap a patch to re-measure it). If your prints are
transferred, cured or finished (pressed, cured, laminated…), treat the sheet the same way and scan the finished
result.

On textured or uneven surfaces, set **Readings per patch** to 3 or more: each patch is then the average of readings
taken at different spots, and a **!** marks patches whose readings disagree by more than 1.5 ΔE00.

### 4. Result

The app fits a model of how your printer responds around the colour and calculates the values that should print
closest to the reference, with the predicted colour difference. **Make next sheet** prints a finer sheet centred on
that answer, and its centre patches check it. A colour shows **Done** once its values print within your tolerance –
**Accept** it to stop making sheets for it.

To keep the search safe, each round only moves as far as the sheet's measurements can be trusted, and the app never
recommends values predicted to print worse than a patch you have already measured. If a reference is beyond what the
printer and media can reproduce, it says so and gives the closest values instead of chasing it. (With the demo's
simulated printer, a first estimate 22 ΔE00 off reaches about 0.2 ΔE00 in three to four rounds; a real RIP usually
starts much closer.)

**Colour difference.** Matches are judged with **ΔE00** by default. For textiles, choose **ΔE00 2:1:1** or
**ΔE CMC 2:1**, which – like people looking at fabric – are more forgiving of lightness differences; the search then
also aims for hue and chroma first. Changing the formula re-judges existing results without new measurements.

**Metamerism check.** When the reference was measured with the SD-10, each result compares the best printed patch
with the reference under daylight (D65), warm incandescent light (A), tri-band shop lighting (F11, close to many LEDs)
and cool white fluorescent (F2). It shows the difference you would see and the *metamerism index* – how far the two
drift apart once the D50 difference is taken out. A high index means the ink and the reference reflect light
differently, so they can match under one light but not another: check the colour under the light it will be seen in.

**Gamut check.** Add the ICC output profile your RIP uses for the printer, ink and media (**+ .icc**; CMYK and
multi-ink profiles both work). Each reference is then marked as inside the printer's gamut, at its edge, or outside –
with the closest printable colour and how far away it is. No amount of matching gets an out-of-gamut colour closer
than that. The profile stays in this browser and is only used for this check.

### Spot colour libraries

In the L\*a\*b\* sheet types the app also writes spot colour libraries for your RIP, in the format chosen under
**Spot library format**:

| Format | Notes |
|---|---|
| **CxF3** (`.cxf`) | The ISO 17972-1 colour exchange standard that many RIPs import |
| **Adobe Color Book** (`.acb`) | Read by Photoshop and by RIPs that import Adobe colour books. It stores L\* in steps of 0.4 and a\*/b\* as whole numbers; the app shows what that rounding costs. |
| **Epson Edge Print** (`.epcc`) | Edge Print colour collection, values to one decimal |
| **Roland VersaWorks** (`.spot`) | VersaWorks 6 spot colour library – it imports switched off, so enable it in the library list |

- **Sheet library** holds the current test sheet's patch colours. Import and enable it before printing the sheet, so
  the patches go through the same named-colour path as your artwork.
- **Add to spot library** stores a finished match under the colour's name – use exactly the name from your artwork,
  because the RIP finds spot colours by name.
- The **Spot library** collects colours across jobs and is kept in this browser. You can rename or remove entries,
  type a colour in (or take the last measurement), and **Import library…** any of the formats above – for example one
  exported from your RIP – to update existing colours. CxF colours are read from their D50 / 2° L\*a\*b\* values or
  computed from their spectra; entries without L\*a\*b\* (such as CMYK) are skipped.
- **Download library** saves the whole library as one file to import into the RIP. Support for other RIPs' formats
  can be added from a sample library exported by that RIP.

## Colour accuracy

- **L\*a\*b\*** uses the illuminant and observer weighting tables recovered from the official app's colour library,
  so values match the app (checked against its native code to better than 0.001).
- **CMYK** is calculated the way the app does it – L\*a\*b\* (D50 / 2°) through the selected ICC profile, by default
  **EpsonWideCMYK_Ver2** with **perceptual** intent – and agrees with the app's own colour engine to within
  0.42 percentage points (0.15 on average).
- **Your own profiles** can be CMYK output profiles in ICC v2 or v4 (Lab or XYZ connection space). They are kept in this
  browser (IndexedDB); if the browser blocks storage, they work for the current session only.
- **HEX / RGB** is sRGB (D50 → D65, Bradford). **LRV** is Y under D65 / 10°.

## Tests

Open these pages in Chrome – on the live site (e.g. [sd-10.com/test/](https://sd-10.com/test/)) or a local copy:

| Page | What it checks |
|---|---|
| [`test/index.html`](https://sd-10.com/test/index.html) | 99 checks of the core code: command frames against the app's own (emulated) code; L\*a\*b\* and CMYK against its native libraries; ΔE2000, CMC and ΔE00 2:1:1 against reference data; the ICC engine against LittleCMS; Print match convergence, layouts and PDF / PNG sheets; the library formats against real VersaWorks and Edge Print exports, the CxF3 standard and a reference Adobe Color Book encoder; and a full session against the simulated SD-10 |
| [`test/ui-smoke.html`](https://sd-10.com/test/ui-smoke.html) | 34 checks driving the Console against the simulated SD-10: calibrate, measure, compare, line scan, history sync, palettes, settings, custom ICC profiles |
| [`test/mobile-check.html`](https://sd-10.com/test/mobile-check.html) | The layout at phone width (no sideways scrolling) and the compare / reference flows |
| [`test/match-smoke.html`](https://sd-10.com/test/match-smoke.html) | 49 checks driving Print match against the simulated device and printer: matching to within tolerance, several colours at once, media sizes and limits, readings per patch, textile ΔE, metamerism and gamut checks, spot colour sheets and libraries, RGB sheets |

## Project layout

```
index.html          page and layout
css/app.css         compiled Tailwind stylesheet (source: css/tailwind.src.css)
js/app.js           Console view (connection, measuring, history, palettes, settings, log) and start-up
js/match-view.js    Print match view (reference colours, sheets, scanning, results, spot library)
js/ui.js            DOM and formatting helpers shared by both views
js/session.js       SD-10 session: byte routing, command queue with FF / FE acks, handshake, operations
js/protocol.js      command builders and reply parsers
js/transport.js     Web Bluetooth GATT transport
js/mock.js          simulated SD-10 (demo mode and tests)
js/color.js         spectrum → L*a*b*, ΔE (76 / 94 / 2000 / CMC), sRGB, LRV
js/weights.js       CIE weighting tables from the app (12 illuminants × 2 observers)
js/match.js         Print match maths: patch design, printer model, solver, metamerism, PDF / PNG sheet layout
js/rip-export.js    spot colour library files (CxF3, Adobe Color Book, Edge Print, VersaWorks): export and import
js/printer-sim.js   simulated CMYK printer (demo and tests)
js/icc.js           ICC engine (L*a*b* → CMYK, and device → L*a*b* for the gamut check); profile storage
js/storage.js       history and preferences (localStorage)
icc/                CMYK profiles bundled with the app
docs/               protocol, feature and development notes
test/               test pages and reference data
bump-version.sh     release helper (cache-busting version for every script)
build-css.sh        rebuilds css/app.css
```

## Troubleshooting

- **The SD-10 isn't in the device list** – switch on *Show all Bluetooth devices* (▾ next to Connect), and check that
  the SD-10 is switched on and not connected to the phone app.
- **"Device rejected control"** – another app (such as the Epson app) holds the session; close it and reconnect.
- **Anything else** – open the **Protocol log**, press *Copy* and include it in your bug report.
- Writing large palettes is slow because data goes in 20-byte chunks; raise `chunkSize` in `js/transport.js` if your
  setup allows bigger writes.
- Firmware updates are deliberately not supported.

## Licences

The ICC profiles in `icc/` come from the Epson Spectrometer app. The Adobe profiles are covered by
[icc/AdobeLicenseStatement.txt](icc/AdobeLicenseStatement.txt); the EpsonWideCMYK profiles belong to Epson.
