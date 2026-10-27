# SD-10 Web Console

**Live: [sd-10.com](https://sd-10.com)** · **Try it without hardware: [sd-10.com/?demo](https://sd-10.com/?demo)**

A browser app for the **Epson SD-10 spectrometer**. It connects over Web Bluetooth and does what the official Epson
Spectrometer Android app does – measure, compare, calibrate, and manage the device's palettes and settings – in a
desktop or Android browser.

On top of that, **Print match** helps you get a printer to reproduce a color.

- Nothing to install
- Your measurements stay in your browser

> Unofficial project – not affiliated with or endorsed by Epson.

**Contents:** [Browser support](#browser-support) · [Measuring](#measuring-console) · [Print match](#print-match) ·
[Color space](#color-space) · [Spot color libraries](#spot-color-libraries) · [Color accuracy](#color-accuracy) ·
[Tests](#tests) · [Project layout](#project-layout) · [Troubleshooting](#troubleshooting)

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
   - **Spot** – one color, optionally the median of several readings.
   - **Compare** – a sample against a reference, with PASS / FAIL and the ΔE. With no reference yet, the first
     measurement becomes the reference. **Use as reference** (under a result) or **ref** (in History) picks another
     one and re-compares the color on screen; the reference is marked **REF** in History.
   - **Line scan** – drag the SD-10 across a strip of up to 18 patches.
4. **Read the result** – swatches, L\*a\*b\*, LCh, HEX / RGB, CMYK, LRV and the spectral curve. **Copy values** copies
   them all as text.

| Also in the Console | Where |
|---|---|
| Battery, charging, calibration and shutter state, device errors | **Device** card – updates when the device reports a change |
| Device name, buzzer, auto power-off, language, panel direction | **Device → Device settings** |
| Write colors to the device's four palette slots, or clear a slot | **Device palettes** – tick the colors in History first |
| Measurement history with CSV export | **History** – kept in this browser |
| Import measurements stored on the SD-10 | **Sync device history** (new ones) or **Re-import all**; *Clear* resets the sync position |
| CMYK profile and rendering intent | Under the result; **+ add .icc** adds your own CMYK profile |
| Every Bluetooth frame, decoded | **Protocol log** at the bottom (collapsed by default) |

## Print match

**Print match** (in the header, or [sd-10.com/#match](https://sd-10.com/#match)) finds the values to put in your
artwork or RIP so that your printer reproduces a reference color.

It works in rounds:

```
 print a test sheet  →  scan it  →  the app models your printer  →  a finer sheet confirms the answer
        ↑                                                                        │
        └──────────────────────────── until it prints within tolerance ──────────┘
```

With a measured [color space](#color-space) of your printer, the first sheet already starts from a prediction.

**Screen layout**

- Needs a computer or tablet (768 px or wider); phones only show the Console.
- On wide screens, the colors and the settings sit in a column at the left; the selected color's workflow and the
  color space are at the right, and the tips run across the bottom.
- Settings you change less often – readings per patch, M-factor, ΔE formula, tolerance, printer profile and the spot
  library's name – open in a dialog from the **Measuring & matching** line, which shows their current values.

### 1. Reference colors

Scan the color you want to match (or use the last measurement, or type in L\*a\*b\*) and give it the name it has in
your artwork.

**+ Add color** lets you work on several colors at once:

- Each color has its own sheets, scan position and result.
- The reference, sheet, scan and result cards work on the color **selected in the list**.
- So you can scan one color's sheet while another is still printing or curing – switching colors never disturbs the
  others.

**Import…** (or dropping a file on the page) adds the named colors of a swatch or library file in one go – for
example the swatches exported from your artwork as an Adobe Swatch Exchange file (`.ase`), or a CxF, Adobe Color Book,
Edge Print or VersaWorks library. Each color gets its name exactly as in the file and its L\*a\*b\* as the reference;
names already in the list are left alone. A swatch value is the design value: measure a printed or physical sample to
replace it with the real color.

Under each color the list shows the L\*a\*b\* recommended for the RIP (→): its latest test-sheet result, or – before
any sheet – what the [color space](#color-space) predicts. **Download library** at the bottom of the card turns the
list into a [spot color library](#spot-color-libraries).

### 2. Test sheet

Pick the sheet type that matches how color reaches your printer, then **Create sheet** and download it:

| Sheet type | For | What you get |
|---|---|---|
| **Spot colors (RIP, L\*a\*b\*)** | RIPs that color named spot colors from an L\*a\*b\* library | A PDF in which every patch is a uniquely named spot color, with its L\*a\*b\* as the fallback. The result is the L\*a\*b\* to enter for your named color. |
| **L\*a\*b\* objects** | Workflows that print Lab colors directly | A PDF with CIE L\*a\*b\* (D50) patches |
| **CMYK numbers** | Documents that send CMYK values to the printer | A PDF with CMYK patches (K stays fixed; the first estimate comes from the CMYK profile chosen in the Console) |
| **RGB image (raster workflows)** | Software that only accepts images | A 300 dpi sRGB PNG; the result is an RGB / hex value for your artwork |

Each sheet has **16 patches** around the current estimate, or **8** (*Patches* in Settings) to save media and
scanning. A to-scale preview shows how the sheet sits on your media before you download it.

#### Media and patch size

| Setting | How it works |
|---|---|
| **Media** | A custom width × height in mm by default, or A4, Letter, A3 or Tabloid – a preset simply fills in its size, and editing the size makes it custom again. **Save** keeps the current size under a name (listed under *Your sizes*; **✕** removes it). The size you used last is remembered. |
| **Height** | Can't go below one row of patches plus the sheet's text. The app shows that minimum and the height that fits a whole sheet on one page, and raises the height for you (and says so) when a change needs more room. |
| **Patch size** | 10–30 mm. From 20 mm, each patch also carries its values (and spot name); smaller patches only carry their number. |

- On wide, short media – such as a 700 mm roll – the sheet's text moves beside the patches, so a sheet with 20 mm
  patches can be as thin as about 40 mm.
- Sheets that don't fit on one page continue on further pages.

> **Tip:** patches must cover the SD-10's whole measuring area. If readings of one patch jump around, use larger
> patches.

### 3. Print and scan

1. Print the sheet **exactly like the final job** – same printer, media, quality and color settings, at 100%.
2. If your prints are transferred or finished (pressed, cured, laminated…), treat the sheet the same way and scan the
   finished result.
3. Scan the patches in number order with **Measure** or the SD-10's button. Tap a patch to re-measure it.

**Scanned the wrong patch?** **Undo last scan** takes the last reading back – off the sheet and out of the color
space – and makes that patch the next to scan. Press it again to go further back.

> **Tip:** on textured or uneven surfaces, set **Readings per patch** to 3 or more. Each patch is then the average of
> readings taken at different spots, and a **!** marks patches whose readings disagree by more than 1.5 ΔE00.

### 4. Result

The app fits a model of how your printer responds around the color and calculates the values that should print
closest to the reference, with the predicted color difference.

| Button / state | What it does |
|---|---|
| **Make next sheet** | Prints a finer sheet centered on that answer; its center patches check it |
| **Done** | Shown once a patch prints within your tolerance – the sheet's centre values, or another patch that printed clearly closer. Those measured values are shown and go into the spot library. |
| **Accept** | Stops making sheets for that color |

**How the search stays safe**

- Each round only moves as far as the sheet's measurements can be trusted.
- It never recommends values predicted to print worse than the best patch measured so far – on this sheet or an
  earlier one.
- When the best guess lies beyond the sheet's patches, it is only a rough estimate: the card and the spot library use
  the best patch actually printed until the next sheet (centred on the guess) confirms it.
- If a sheet comes out worse than an earlier one, the last move is undone: the next sheet goes back to the best patch
  and searches around it in smaller steps.
- If a reference is beyond what the printer and media can reproduce, it says so and gives the closest values instead
  of chasing it.
- When the printer profile calls the color printable but the prints stop getting closer, the profile probably doesn't
  describe how the printer really prints with that ink and media – re-profiling helps more than further rounds.

With the demo's simulated printer, a first estimate 22 ΔE00 off reaches about 0.2 ΔE00 in three to four rounds; a
real RIP usually starts much closer.

#### Color difference

Matches are judged with **ΔE00** by default. Changing the formula re-judges existing results without new
measurements.

| Formula | Use it for |
|---|---|
| **ΔE00** | Most work (default) |
| **ΔE00 2:1:1** or **ΔE CMC 2:1** | Textiles – like people looking at fabric, they are more forgiving of lightness differences, and the search then aims for hue and chroma first |

#### Metamerism check

When the reference was measured with the SD-10, each result compares the best printed patch with the reference under
four lights:

| Light | Stands for |
|---|---|
| D65 | Daylight |
| A | Warm incandescent light |
| F11 | Tri-band shop lighting (close to many LEDs) |
| F2 | Cool white fluorescent |

It shows the difference you would see and the *metamerism index* – how far the two drift apart once the D50
difference is taken out. A high index means the ink and the reference reflect light differently, so they can match
under one light but not another.

> **Tip:** check the color under the light it will be seen in.

#### Gamut check

Add the ICC output profile your RIP uses for the printer, ink and media (**+ .icc**; CMYK and multi-ink profiles both
work). Each reference is then marked as:

- **inside** the printer's gamut,
- **at its edge**, or
- **outside** – with the closest printable color and how far away it is. No amount of matching gets an out-of-gamut
  color closer than that.

The profile stays in this browser and is only used for this check.

### Color space

A **color space** is a measured map of what your printer – with its ink, media and RIP settings – really prints.
Measure it once and every color gets a prediction straight away, instead of starting from a guess.

#### Getting started

1. **Create chart** under *Color space* (it asks for a name, e.g. the printer, media and settings) and download the
   chart like a test sheet.
2. Print it like the final job and scan the patches in number order. Each one goes into the color space as you scan
   it, so a chart can be scanned in several sittings – it sits at the top of the color list until you close it.
3. Set a reference: the *Reference* card now shows the values the color space predicts and how close they should
   print – or, for a color the printer never reached, the closest it prints. **Create sheet** starts from those
   values with finer steps, and the usual rounds confirm and refine them.

| Chart | Patches | When |
|---|---|---|
| **Starter** | 200 | A first map |
| **Standard** | 400 | More accuracy |
| **Fine** | 800 | The most detail |
| **Fill gaps** | 48 | Later – measures where the color space is emptiest |
| **Check** | 24 | When the app suspects the printer has changed (see [It learns](#it-learns)) |

The patches are spread over everything the printer might produce and placed in a mixed order, so uneven printing
across the sheet averages out. In the L\*a\*b\* sheet types there is a **Sheet library** for the chart too.

**How good is the prediction?** It is an estimate from the measured patches around it, not a measured color.

- Between patches, it fills in.
- At the edge of what the chart measured – typically the gamut edge, where a RIP prints every "more saturated" request
  the same – it stays close to the last measured patches instead of extrapolating, so it does not promise colors the
  printer cannot make.
- It never promises less than a patch already measured: when one printed closer than any prediction, the card offers
  that patch's values ("measured to print").
- Accuracy depends on the printer and the number of patches; the card shows its own typical accuracy. With the demo's
  simulated printer, a 200-patch chart predicts to about ΔE00 1 and a 400-patch chart to about 0.6.

#### It learns

With *Learn from every test sheet I scan* on, every patch you scan for a color is added too, so the color space gets
more accurate where you actually work.

- **Checked first** – before a patch counts, it is compared with what the rest of the color space predicts, where
  measured patches surround it. (At a sparsely measured edge a miss only means the space did not know that region.)
- **Drift warning** – when a whole test sheet prints differently, the app warns that the printer, ink or media may
  have changed and suggests a **Check** chart to find out.
- **Starting fresh** – if a check chart confirms the change and it is meant to stay, **Keep only data from this check
  chart on** removes the older measurements. It lists exactly what it would remove, a chart from earlier the same day
  included.
- **Aging** – older measurements count less over time.

#### Fill-in patches

*Fill-in patches on each test sheet* (off by default) adds patches to every test sheet where the color space has
measured least – some near the color being matched, where it needs the data most (up to 8), the rest wherever it is
emptiest.

| Option | Adds |
|---|---|
| **None** | Nothing (default) |
| **4** / **8** | That many – which can take an extra page on tight media |
| **Fill the free space** | Exactly as many as fit in the empty slots of the pages the sheet needs anyway – no extra media, only a little more scanning (at most 100) |

Fill-in patches are marked *fill-in* on the sheet and in the scan card. The match calculation ignores them, and they
go into the color space like chart patches.

#### Data & files

**Data & files** lists every chart, check chart and test sheet in the color space; **remove** takes one out again –
for example a sheet printed on the wrong media.

| Action | What it does |
|---|---|
| **Export** | Saves the color space as a file to keep, move to another computer or share |
| **Import…** | Loads it again – or drop the file on the page |
| **CGATS** | Writes the measurements as a CGATS.17 text file (device values and measured L\*a\*b\*) – the format profiling software reads |
| **Rename** / **Delete** | As named |

CGATS / IT8 files from other software (CMYK or RGB charts with L\*a\*b\* values, including ArgyllCMS `.ti3`) can be
imported as a color space too.

> **Make a separate color space for each printer, ink, media and RIP setting.** A color space only predicts for the
> sheet type it was measured with.

#### See it in 3-D

The **Color space** tab in the header shows a color space as a large, turnable picture in L\*a\*b\*. Every measured
patch appears in the color it printed, inside the *gamut surface* – the most colorful colors measured at each
lightness and hue.

| To… | Do this |
|---|---|
| Turn it | Drag |
| Zoom | Scroll, or pinch |
| See the a\*b\* diagram | **From above** |
| See what was asked for and what printed | Hover a patch |
| Compare with another media, printer or setting | **Compare with** – draws a second color space as a wireframe; the panel gives both gamut volumes |
| Check whether a sample is printable | **Measure a color** (or the SD-10's button) adds it to the picture |
| Center on a color | Double-click a patch or reference marker, **center** in the list, or right-click → **Center the view here** |
| Go back to the middle | **back to the middle** in the corner, or double-click empty space to reset |
| Fill the screen | **Full screen** on the picture (Esc to leave) |
| Watch it turn | **Spin** |
| Take out a stray patch (a smudge or a mis-scan) | Right-click it → **Remove from the color space** – the test sheet keeps its measurement |

When you center on a color, the picture glides there and zooms in; turning, spinning and zooming then happen around
that color, so you can look closely at the colors around it. Patches between you and that color fade out (and let
the pointer through to what is behind them), so it and its neighbors stay in sight from every side.

**Reference colors.** The Print match reference colors are marked in the picture, and the ones outside the surface
are flagged. The list beside the picture shows for every reference:

- the patch of the color space that measured **closest** to it – with its ΔE, what it printed and which sheet it came
  from;
- the values the color space **predicts** for it – what to ask for, what it should print, and "first estimate" where
  it has few patches nearby.

Click one to show it in the picture: a line runs to its closest measured patch and a dashed one to its predicted
color. With many references, only the selected one is named in the picture – hover the others.

### Spot color libraries

In the L\*a\*b\* sheet types the app writes spot color libraries for your RIP, in the format chosen at the bottom of
the *Colors* card, beside **Download library**:

| Format | Notes |
|---|---|
| **CxF3** (`.cxf`) | The ISO 17972-1 color exchange standard that many RIPs import – written in the same form as CadLink Digital Factory's own spot color exports |
| **Adobe Color Book** (`.acb`) | Read by Photoshop and by RIPs that import Adobe color books. It stores L\* in steps of 0.4 and a\*/b\* as whole numbers; the app shows what that rounding costs. |
| **Epson Edge Print** (`.epcc`) | Edge Print color collection, values to one decimal |
| **Roland VersaWorks** (`.spot`) | VersaWorks 6 spot color library – it imports switched off, so enable it in the library list |

**The two libraries**

| Library | Where | What it holds |
|---|---|---|
| **Sheet library** | Test sheet card | The current test sheet's patch colors. Import and enable it before printing the sheet, so the patches go through the same named-color path as your artwork. |
| **Download library** | *Colors* card | Every color under its name (exactly as in your artwork – the RIP finds spot colors by name) with its recommended L\*a\*b\*. A color without a result or prediction yet goes in with its reference, and the card says how many. The file is named after the **Spot library name** (under *Measuring & matching*). |

**Getting files in**

- **Import…** on the *Colors* card, or drop a file anywhere on the Print match page: any of the formats above – for
  example one exported from your RIP – or an Adobe Swatch Exchange file (`.ase`, from Illustrator, Photoshop or
  InDesign). Its colors become colors to match. An `.icc` / `.icm` file dropped there is added as the printer profile.
- ASE files: their L\*a\*b\* swatches are read, RGB and CMYK swatches skipped. CxF colors are read from their
  D50 / 2° L\*a\*b\* values or computed from their spectra; entries without L\*a\*b\* (such as CMYK) are skipped.

Support for other RIPs' formats can be added from a sample library exported by that RIP.

## Color accuracy

| Value | How it's calculated |
|---|---|
| **L\*a\*b\*** | The illuminant and observer weighting tables recovered from the official app's color library, so values match the app (checked against its native code to better than 0.001) |
| **CMYK** | The way the app does it – L\*a\*b\* (D50 / 2°) through the selected ICC profile, by default **EpsonWideCMYK_Ver2** with **perceptual** intent. Agrees with the app's own color engine to within 0.42 percentage points (0.15 on average). |
| **HEX / RGB** | sRGB (D50 → D65, Bradford) |
| **LRV** | Y under D65 / 10° |

**Your own profiles** can be CMYK output profiles in ICC v2 or v4 (Lab or XYZ connection space). They are kept in
this browser (IndexedDB); if the browser blocks storage, they work for the current session only.

## Tests

Open these pages in Chrome – on the live site (e.g. [sd-10.com/test/](https://sd-10.com/test/)) or a local copy.

| Page | Checks | What it covers |
|---|---|---|
| [`test/index.html`](https://sd-10.com/test/index.html) | 120 | The core code (see below) |
| [`test/ui-smoke.html`](https://sd-10.com/test/ui-smoke.html) | 34 | The Console against the simulated SD-10: calibrate, measure, compare, line scan, history sync, palettes, settings, custom ICC profiles |
| [`test/mobile-check.html`](https://sd-10.com/test/mobile-check.html) | – | The layout at phone width (no sideways scrolling) and the compare / reference flows |
| [`test/match-smoke.html`](https://sd-10.com/test/match-smoke.html) | 50 | Print match against the simulated device and printer: matching to within tolerance, several colors at once, media sizes and limits, readings per patch, textile ΔE, metamerism and gamut checks, spot color sheets and libraries, colors imported from a swatch file, RGB sheets |
| [`test/space-smoke.html`](https://sd-10.com/test/space-smoke.html) | 38 | The color space workflow against the simulated device and printer (see below) |

**`test/index.html` checks**

- command frames against the app's own (emulated) code
- L\*a\*b\* and CMYK against its native libraries
- ΔE2000, CMC and ΔE00 2:1:1 against reference data
- the ICC engine against LittleCMS
- Print match convergence, layouts and PDF / PNG sheets
- color space charts, predictions, learning, drift checks and files against simulated printers
- the library formats against real VersaWorks and Edge Print exports, the CxF3 standard, the Adobe Swatch Exchange layout and a reference Adobe Color
  Book encoder
- a full session against the simulated SD-10

**`test/space-smoke.html` checks**

- charts, scanning into the color space, import / export
- predictions, and a first sheet that starts from them
- learning, the drift check, removing measurements, undoing a scan
- fill-in patches and fill-gaps charts
- the 3-D view with its reference list, centering (and fading what is in front), full screen and right-click removal
- taking over data saved under the old "colour" spelling

## Project layout

```
index.html          page and layout
css/app.css         compiled Tailwind stylesheet (source: css/tailwind.src.css)

js/app.js           Console view (connection, measuring, history, palettes, settings, log) and start-up
js/match-view.js    Print match view (colors and their library file, sheets, scanning, results, color space)
js/space-view.js    Color space view: the 3-D picture of a color space (gamut surface, comparison, volume)
js/ui.js            DOM and formatting helpers shared by the views
js/debug.js         debug report: journal of actions, messages and errors; the report file

js/session.js       SD-10 session: byte routing, command queue with FF / FE acks, handshake, operations
js/protocol.js      command builders and reply parsers
js/transport.js     Web Bluetooth GATT transport
js/mock.js          simulated SD-10 (demo mode and tests)

js/color.js         spectrum → L*a*b*, ΔE (76 / 94 / 2000 / CMC), sRGB, LRV
js/weights.js       CIE weighting tables from the app (12 illuminants × 2 observers)
js/match.js         Print match maths: patch design, printer model, solver, metamerism, PDF / PNG sheet layout
js/colorspace.js    color spaces: chart design, prediction from measured patches, learning, drift check, files
js/rip-export.js    spot color library files (CxF3, Adobe Color Book, Edge Print, VersaWorks): export and import; ASE import
js/printer-sim.js   simulated CMYK printer (demo and tests)
js/icc.js           ICC engine (L*a*b* → CMYK, and device → L*a*b* for the gamut check); profile storage
js/storage.js       browser storage: JSON load / save for every view, history and preferences

icc/                CMYK profiles bundled with the app
docs/               protocol, feature and development notes
test/               test pages and reference data
bump-version.sh     release helper (cache-busting version for every script)
build-css.sh        rebuilds css/app.css
```

## Troubleshooting

| Problem | What to do |
|---|---|
| **Something isn't working as expected** | Press **Save a debug report** at the bottom of the page (you can add a note on what happened) and share the file instead of screenshots |
| **The SD-10 isn't in the device list** | Switch on *Show all Bluetooth devices* (▾ next to Connect), and check that the SD-10 is switched on and not connected to the phone app |
| **"Device rejected control"** | Another app (such as the Epson app) holds the session – close it and reconnect |
| **Anything else** | Open the **Protocol log**, press *Copy* and include it in your bug report |

The debug report holds the app's recent actions and messages (kept across reloads), what the page shows, its
settings, measurements, color spaces and libraries, the protocol log, and the device and browser details – no
passwords or personal details.

**Good to know**

- Writing large palettes is slow because data goes in 20-byte chunks; raise `chunkSize` in `js/transport.js` if your
  setup allows bigger writes.
- Firmware updates are deliberately not supported.

## Licences

The ICC profiles in `icc/` come from the Epson Spectrometer app. The Adobe profiles are covered by
[icc/AdobeLicenseStatement.txt](icc/AdobeLicenseStatement.txt); the EpsonWideCMYK profiles belong to Epson.
