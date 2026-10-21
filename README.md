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
it. With a measured [colour space](#colour-space) of your printer, the first sheet already starts from a prediction. It needs a computer or tablet (768 px or wider); phones only show the Console. On wide screens the colour list,
settings and tips sit in a column at the left; the selected colour's workflow, the spot library and the colour space
are at the right. Settings you change less often – readings per patch, M-factor, ΔE formula, tolerance, printer
profile and library format – are folded under **Measuring & matching**, whose closed line shows their current values.

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

Each sheet has **16 patches** around the current estimate, or **8** (*Patches* in Settings) to save media and
scanning. A to-scale preview shows how the sheet sits on your media before you download it.

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
recommends values predicted to print worse than the best patch measured so far – on this sheet or an earlier one. If a
sheet comes out worse than an earlier one, the last move is undone: the next sheet goes back to the best patch and
searches around it in smaller steps. If a reference is beyond what the printer and media can reproduce, it says so and
gives the closest values instead of chasing it. When the printer profile calls the colour printable but the prints stop
getting closer, the profile probably doesn't describe how the printer really prints with that ink and media –
re-profiling helps more than further rounds. (With the demo's
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

### Colour space

A **colour space** is a measured map of what your printer – with its ink, media and RIP settings – really prints.
Measure it once and every colour gets a prediction straight away, instead of starting from a guess.

1. **Create chart** under *Colour space* (it asks for a name, e.g. the printer, media and settings) and download the
   chart like a test sheet: **Starter** (200 patches), **Standard** (400) or **Fine** (800). The patches are spread
   over everything the printer might produce and placed in a mixed order, so uneven printing across the sheet averages
   out. In the L\*a\*b\* sheet types there is a **Sheet library** for the chart too.
2. Print it like the final job and scan the patches in number order. Each one goes into the colour space as you scan
   it, so a chart can be scanned in several sittings – it sits at the top of the colour list until you close it.
3. Set a reference: the *Reference* card now shows the values the colour space predicts and how close they should
   print – or, for a colour the printer never reached, the closest it prints. **Create sheet** starts from those
   values with finer steps, and the usual rounds confirm and refine them.

**It learns.** With *Learn from every test sheet I scan* on, every patch you scan for a colour is added too, so the
colour space gets more accurate where you actually work. Before a patch counts, it is compared with what the rest of
the colour space predicts. When a whole sheet prints differently, the app warns that the printer, ink or media has
probably changed. A **Check** chart (24 patches) tests exactly that. If the change is meant to stay, **Keep only data
from … on** removes the older measurements. Older measurements also count less over time.

**Data & files** lists every chart, check chart and test sheet in the colour space, and **remove** takes one out
again – for example a sheet printed on the wrong media. Make a separate colour space for each printer, ink, media and
RIP setting. A colour space only predicts for the sheet type it was measured with.

**Export** (under *Data & files*, with **Rename** and **Delete**) saves the colour space as a file to keep, move to
another computer or share; **Import…** (or dropping the
file on the page) loads it again. **CGATS** writes the measurements as a CGATS.17 text file (device values and
measured L\*a\*b\*) – the format profiling software reads – and CGATS / IT8 files from other software (CMYK or RGB
charts with L\*a\*b\* values, including ArgyllCMS `.ti3`) can be imported as a colour space.

How accurate it is depends on the printer and the number of patches; the card shows its own typical accuracy. With the
demo's simulated printer, a 200-patch chart predicts to about ΔE00 1 and a 400-patch chart to about 0.6.

**See it in 3-D.** The **Colour space** tab in the header shows a colour space as a large, turnable picture in
L\*a\*b\*. Every measured patch appears in the colour it printed, inside the *gamut surface* – the most colourful
colours measured at each lightness and hue. Drag to turn it, scroll (or pinch) to zoom, and double-click to reset it.
**From above** shows the familiar a\*b\* diagram, and hovering a patch shows what was asked for and what printed.
**Compare with** draws a second colour space as a wireframe – another media, printer or setting – and the panel gives
both gamut volumes. The Print match reference colours are marked, and the ones outside the surface are flagged.
**Measure a colour** (or the SD-10's button) adds the colour you measure to the picture, so you can see whether a
sample is printable at a glance.

### Spot colour libraries

In the L\*a\*b\* sheet types the app also writes spot colour libraries for your RIP, in the format chosen under
**Spot library format**:

| Format | Notes |
|---|---|
| **CxF3** (`.cxf`) | The ISO 17972-1 colour exchange standard that many RIPs import – written in the same form as CadLink Digital Factory's own spot colour exports |
| **Adobe Color Book** (`.acb`) | Read by Photoshop and by RIPs that import Adobe colour books. It stores L\* in steps of 0.4 and a\*/b\* as whole numbers; the app shows what that rounding costs. |
| **Epson Edge Print** (`.epcc`) | Edge Print colour collection, values to one decimal |
| **Roland VersaWorks** (`.spot`) | VersaWorks 6 spot colour library – it imports switched off, so enable it in the library list |

- **Sheet library** holds the current test sheet's patch colours. Import and enable it before printing the sheet, so
  the patches go through the same named-colour path as your artwork.
- **Add to spot library** stores a finished match under the colour's name – use exactly the name from your artwork,
  because the RIP finds spot colours by name.
- The **Spot library** collects colours across jobs and is kept in this browser. You can rename or remove entries,
  type a colour in (or take the last measurement) under **Add a colour**, and **Import…** any of the formats above – for example one
  exported from your RIP – to update existing colours. You can also drop library files anywhere on the Print match
  page, and an `.icc` / `.icm` file dropped there is added as the printer profile. CxF colours are read from their D50 / 2° L\*a\*b\* values or
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
| [`test/index.html`](https://sd-10.com/test/index.html) | 112 checks of the core code: command frames against the app's own (emulated) code; L\*a\*b\* and CMYK against its native libraries; ΔE2000, CMC and ΔE00 2:1:1 against reference data; the ICC engine against LittleCMS; Print match convergence, layouts and PDF / PNG sheets; colour space charts, predictions, learning, drift checks and files against simulated printers; the library formats against real VersaWorks and Edge Print exports, the CxF3 standard and a reference Adobe Color Book encoder; and a full session against the simulated SD-10 |
| [`test/ui-smoke.html`](https://sd-10.com/test/ui-smoke.html) | 34 checks driving the Console against the simulated SD-10: calibrate, measure, compare, line scan, history sync, palettes, settings, custom ICC profiles |
| [`test/mobile-check.html`](https://sd-10.com/test/mobile-check.html) | The layout at phone width (no sideways scrolling) and the compare / reference flows |
| [`test/match-smoke.html`](https://sd-10.com/test/match-smoke.html) | 50 checks driving Print match against the simulated device and printer: matching to within tolerance, several colours at once, media sizes and limits, readings per patch, textile ΔE, metamerism and gamut checks, spot colour sheets and libraries, RGB sheets |
| [`test/space-smoke.html`](https://sd-10.com/test/space-smoke.html) | 22 checks of the colour space workflow against the simulated device and printer: charts, scanning into the colour space, import / export, predictions, a first sheet that starts from them, learning, the drift check, removing measurements and the 3-D view |

## Project layout

```
index.html          page and layout
css/app.css         compiled Tailwind stylesheet (source: css/tailwind.src.css)
js/app.js           Console view (connection, measuring, history, palettes, settings, log) and start-up
js/match-view.js    Print match view (reference colours, sheets, scanning, results, colour space, spot library)
js/ui.js            DOM and formatting helpers shared by both views
js/debug.js         debug report: journal of actions, messages and errors; the report file
js/session.js       SD-10 session: byte routing, command queue with FF / FE acks, handshake, operations
js/protocol.js      command builders and reply parsers
js/transport.js     Web Bluetooth GATT transport
js/mock.js          simulated SD-10 (demo mode and tests)
js/color.js         spectrum → L*a*b*, ΔE (76 / 94 / 2000 / CMC), sRGB, LRV
js/weights.js       CIE weighting tables from the app (12 illuminants × 2 observers)
js/match.js         Print match maths: patch design, printer model, solver, metamerism, PDF / PNG sheet layout
js/colorspace.js    colour spaces: chart design, prediction from measured patches, learning, drift check, files
js/space-view.js    Colour space view: the 3-D picture of a colour space (gamut surface, comparison, volume)
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

- **Something isn't working as expected** – press **Save a debug report** at the bottom of the page (you can add a
  note on what happened) and share the file instead of screenshots. It holds the app's recent actions and messages
  (kept across reloads), what the page shows, its settings, measurements, colour spaces and libraries, the protocol
  log, and the device and browser details – no passwords or personal details.
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
