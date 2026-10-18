# SD-10 Web Console

A browser app that talks to the **Epson SD-10 spectrometer** over Web Bluetooth. It reimplements the protocol
reverse-engineered from the Epson Spectrometer Android app (see [`../PROTOCOL.md`](../PROTOCOL.md) and
[`../FEATURES.md`](../FEATURES.md)). Plain HTML + ES modules + Tailwind (CDN) — no build step.

## Run

Web Bluetooth needs a secure context, so serve the folder over `localhost` (or HTTPS):

```powershell
python -m http.server 8765 --directory web-app
# open http://localhost:8765 in Chrome or Edge
```

Supported: Chrome / Edge on Windows, macOS, Linux, ChromeOS and Android. Not supported: Safari, Firefox, iOS.
A simulated SD-10 is available for trying the app without hardware: open `http://localhost:8765/?demo` to show the **Demo** button.

## Features

| Area | What it does | Protocol |
|---|---|---|
| Connect | Device chooser (filtered on the SD-10 service), session lock, clock sync | ControlDevice, SetDatetime |
| Status | Battery, charging, calibration, shutter, decoded error bits; auto-refresh on device events | GetStatus, event `C4` |
| Calibrate | Close the shutter → Measure button turns into **Calibrate** | SetMode(6), ExecuteCalibration, event `C3` |
| Spot | Spectrum chart, L\*a\*b\*, LCh, HEX/sRGB, CMYK (ICC), LRV; 1–5 readings with median Lab | SetMode(1), Execute, event `C1`, result cache |
| Compare | ΔE00 / ΔE94 / ΔE76 against a reference, pass/fail tolerance; **Use as reference** (result or history row) sets the reference and switches to Compare | SetMode(2) |
| Line scan | Drag across a strip of up to 18 patches | SetMode(4), NotifySuccessOrFailure |
| Device button | Pressing the SD-10's button triggers a measurement | event `C2`, GetColorMeasurementMode |
| Settings | Name, buzzer, auto power-off, language, panel direction (under *Device → Device settings*) | Get/SetInt, Get/SetString |
| Palettes | Read the 4 device slots; write ticked history colours; delete | Get/SetGroupInformation |
| History | Saved in this browser; CSV export; **Sync** imports new device records, **Re-import all** fetches everything again (duplicates skipped); clearing history resets the sync position | History check/get |
| Log | Every TX/RX frame in hex with decoded meaning; optional raw BLE chunks (collapsed by default) | — |
| CMYK profiles | 7 profiles from the app, or **+ add .icc** to use your own CMYK profile (ICC v2/v4, Lab or XYZ PCS; kept in this browser) | — |

CMYK follows the app: Lab under D50/2° → the selected CMYK profile (default **EpsonWideCMYK_Ver2**, **perceptual**),
with the same 16-bit Lab encoding and percent scaling as the app's CMM.

Lab values are computed with weighting factors recovered from the app's own `librmcc.so`, so they match the
official app (verified against the native code to < 0.001).

## Layout

```
index.html        UI
js/protocol.js    frame builders / parsers (mirrors EPSPM::CommandBuilder / ResponseParser)
js/session.js     byte routing, command queue + FF/FE acks, handshake, high-level operations
js/transport.js   Web Bluetooth GATT transport
js/mock.js        simulated SD-10 (device side of the protocol) for the demo and tests
js/color.js       spectrum → Lab, ΔE, sRGB, LRV
js/icc.js         ICC v2 LUT engine: Lab(D50) → CMYK through the app's bundled profiles
icc/              CMYK profiles copied from the app (Adobe profiles: see icc/AdobeLicenseStatement.txt)
js/weights.js     CIE weighting tables extracted from the app (12 illuminants × 2 observers)
js/storage.js     localStorage persistence
js/app.js         UI controller
test/index.html   55 checks: golden frames from the emulated native library, native Lab values, ΔE2000 reference data, end-to-end session vs simulator
test/ui-smoke.html  drives the real UI in an iframe against the simulator
```

## Testing on hardware — things to watch

- If the SD-10 does not appear in the chooser, tick **all devices** (some firmware may not advertise the service UUID).
- Writes are sent in 20-byte chunks (safe default). Change `chunkSize` in `BleTransport` to speed up large palette writes.
- The **Protocol log** is the first place to look: every frame is decoded. Use *Copy* to share a session.
- Firmware update is intentionally not implemented.

## Deploying (GitHub Pages)

GitHub Pages caches files for 10 minutes, so a browser can end up with a new `index.html` and an old `js/app.js`.
To prevent that, every script URL in `index.html` carries a release version (`?v=…`, via the import map).
Before each release run:

```sh
./bump-version.sh    # updates ?v= in index.html
git commit -am "Release" && git push
```
