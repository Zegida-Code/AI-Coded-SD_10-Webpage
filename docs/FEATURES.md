# Epson Spectrometer app — Feature map (Phase 3)

How the Android app's features map onto the BLE commands in [PROTOCOL.md](PROTOCOL.md) (section numbers `§x.y` refer to it).

Key source locations:

| Layer | Where |
|---|---|
| Device state machine (connect, sync, settings, calibrate, scan) | `smali/c1.1/k.smali` (`Lc1/k;->b(ILw1/e;)I`), driven by `java_src/p122w1/f.java` messages |
| Device session / measurement helpers | `java_src/Q0/e.java`, `Q0/d.java` (result handlers), `Q0/c.java` (20 s timeouts) |
| Device event handler (C2 / C4 / A0) | `java_src/Q1/i.java` `g(int)` |
| Group (palette) comparison session | `java_src/p096r1/e.java` |
| Device-palette editor | `java_src/p029f1/ViewOnClickListenerC0305c0.java`, `F3/c.java` `E()` |
| Colour maths wrappers | `java_src/P0/a.java`, `D1/c.java` |
| Local DB schema | `assets/create.sql` |

---

## 1. Connection & session

**App states** (`w1/f.g`): INIT → CONNECTING → CONNECT_SUCCESSFUL → GET_DEVICE_PALETTE_LIST → SYNCHRONIZE_HISTORY_DB → GET_DEVICE_INFO → GET_DEVICE_SETTINGS → CONNECTION_COMPLETE (failure states: CONNECTION_FAILED, RETRY_CONNECT, CANNOT_RETRY_CONNECT, DISCONNECTING).

| Step | Commands |
|---|---|
| Scan for devices | BLE scan filtered on advertised UUID `4d756e73-…` |
| Open session | ControlDevice acquire, clientType 1, persistent 16-byte appId (§5.13) |
| Clock sync | SetDatetimeInfo with phone time, year % 100 (§5.12) |
| Device info | GetString FW (`03`), GetString serial (`0E`), GetStatus (§5.1) |
| Device settings | GetString name (`08`), GetInt buzzer (`0F`), auto-off (`1F`), language (`20`) (+ panel direction `10`, read only) |
| Palette list | GetGroupInformation (§5.11) → which of the 4 slots hold which `hardwareId` |
| History sync | History check with newest local identifier → History get (§5.14) → stored in local DB |
| Disconnect | FinishControlDevice release (§5.13), then GATT disconnect |
| Link lost | event `A0` → close session, show "disconnected" |

## 2. Device status dashboard

From GetStatus (§5.1), refreshed after connect, after calibration, after measurement failures, and on event `C4`:

| UI element | Field | Display rule |
|---|---|---|
| Battery | `battery` | % ; icon bands 0–25 / 26–50 / 51–75 / 76–100 |
| Charging | `chargingStatus` | 1 = charging |
| Calibration | `calibrationStatus` | 0 = needed, 2 = done |
| Shutter | `shutterStatus` | 0 = open, 1 = closed |
| Device state | `deviceStatus` | 4 = idle, 0 = error |
| Error | `errorStatus` | lowest set bit → message (PROTOCOL §6) |
| Model / FW / serial | "SD-10", GetString | static text |

## 3. Measuring

### Scan-button logic (app UI or device button)
```
if shutter == CLOSED        → Calibrate (§3.1)
elif calibration == NEEDED  → prompt "close the shutter to calibrate"
else                        → Measure in current scan mode (§3.2)
```

### 3.1 Calibration
`SetColorMeasurementMode(method 6)` → arm 20 s timer → `ExecuteCalibration` → wait for event `C3` → GetStatus; success if `errorStatus == 0`.

### 3.2 Scan modes (`Q0/n`)

Measurement settings (`Q0/o`, defaults): mFactor **M1**, illuminant **D50**, observer **2°**, ΔE formula **CIEDE2000**, threshold **3.0**.

| App mode | Patches per line | SetColorMeasurementMode (§5.9) | Result handling |
|---|---|---|---|
| **SpotScan** — single colour | 1 | method 1, save=1, mF, light, angle | 1 record → spectrum → colour info |
| **SpotComparison** — compare with a reference colour | 1 | method 2, + formula, threshold | ΔE vs reference computed on host |
| **GroupSpotComparisonScan** — compare with a palette stored on the device | 1 | method 3, save=1, groupNo = device slot, startPatchNo | device picks the patch; host stores the result |
| **LineScan** — drag across a strip | 18 | method 4, save=0, patchNum, lineNo | N records; average ΔE vs palette ≤ threshold → NotifySuccessOrFailure(1/0) (§5.6) |
| **LineCompareScan** — strip vs palette | 10 | palette ≤ 80 colours: method 5 (groupNo, patchNum, startPatchNo = 10·(line−1)+1, lineNo); otherwise method 7 (+ formula, threshold, labs) | as LineScan |

Every measurement: SetColorMeasurementMode → `ExecuteColorMeasurement` (§5.3) → wait for event `C1` (20 s timeout) → GetResultFromCache size + data (§5.4/5.5). A record with `gettingResult == 0` means it failed → GetStatus for the reason.

**Multiple readings:** a "measurement count" setting (`favorite_setting.measurement_count`) takes N readings and stores the **per-channel median Lab** (`GetColorMedianValue`).

### 3.3 Device-initiated measurement
Event `C2` (button on the device, debounced 1.5 s, ignored while busy) → GetColorMeasurementMode (§5.15) → map wire method + groupNo/startPatchNo to an app scan mode → run that scan as in §3.2.

### 3.4 Group (palette) comparison session (`p096r1/e`)
1. Start: if the palette is not on the device and has ≤ 80 colours, write it to **slot 1** with SetGroupInformation (§5.11), then SetColorMeasurementMode.
2. Measure patches (GroupSpot / LineCompare).
3. Finish: NotifyGroupMeasurementCompleted then SetStandAloneMode (§5.10). Cancel: SetStandAloneMode.

## 4. Device palettes (4 slots)
"Device Color Palette Edit" screen:
GetGroupInformation → for each of the 4 slots, SetGroupInformation either *register* (control 2: name ≤ 42 UTF-8 bytes, random `hardwareId` 1–65535, patchBorder 1, mF/light/angle/formula/threshold, up to 80 Labs) or *delete* (control 1). The local DB links `color_group.hardware_id` to the slot.

## 5. Device settings screen

| Setting | Command | Values |
|---|---|---|
| Device name | SetString `08` (§5.8) | ≤ 16 bytes |
| Buzzer | SetInt `0F` | Off / Small / Big |
| Auto power-off | SetInt `1F` | Disable / 10 / 30 / 60 min |
| Language | SetInt `20` | JA, EN, FR, DE, IT, ES, PT, TR, NL, RU, ZH-CN, ZH-TW, KO |
| Panel direction | GetInt `10` | read only in the app (settable: 0/90/180/270°) |

## 6. Support / diagnostics
- **Device log export:** GetNVRAMData (size check + data) → raw bytes saved to a file (`ACTION_DID_RECEIVE_LOG_DATA`).
- **History delete:** History delete (§5.14).
- **Firmware update:** `FWUpdate` (not reverse-engineered, excluded).

## 7. Host-only features (no BLE)

| Feature | App implementation | Web-app approach |
|---|---|---|
| Spectrum → Lab (any illuminant/observer) | native `ConvertSpectrumToLab` | CIE 1931 2° / 1964 10° CMFs × illuminant SPDs, 400–700 nm @ 10 nm (ASTM E308) |
| LCh, ΔE76/94/2000 | native `GetLCH`, `GetDeltaE` | standard formulas |
| HEX / sRGB | ICC (`EW-sRGB.icc`) / `GetSRGB` | Lab(D50) → XYZ → Bradford → sRGB |
| CMYK | ICC profiles in `assets/ICCProfile` + native CMM (`libepcmm.so`); defaults EpsonWideCMYK_Ver2 + AdobeRGB1998, perceptual; Lab(D50/2°) quantised to v2 16-bit PCS, output `v·100/65280` | `js/icc.js` evaluates the profile's B2A LUT (tetrahedral) with the same encoding |
| Gamut check | native `IsInGamut` (libgamut) | not implemented |
| LRV | native `GetLRV` (D65/10°) | Y of XYZ (D65/10°) |
| Chromatic adaptation between illuminants | native `ConvertBradford` | Bradford matrix |
| Colour harmonies | native `CreateHarmonicLab` | LCh hue rotation |
| Munsell notation, colour sample books, near-colour search | encrypted licensed DB `assets/d02.bin` | **excluded** (licensed content) |
| History, favourites, palettes, notes, photos, GPS | local SQLite (`create.sql`) | IndexedDB/localStorage |
| Camera colour pick, Epson "Port" cloud palettes, news | `com.epson.colorpic`, `com.epson.port` | excluded |

---

## 8. Proposed web-app scope (Phase 4)

**Must have**
1. Connect / disconnect + session handshake, clock sync, live status (battery, charging, calibration, shutter, errors), device info.
2. Calibrate.
3. Spot measurement with settings (M-factor, illuminant, observer); spectrum chart + Lab / LCh / HEX swatch.
4. Spot comparison against a stored reference with ΔE (formula + threshold), pass/fail.
5. Device button (`C2`) triggers a measurement; status events (`C4`) refresh the dashboard.
6. Device settings: name, buzzer, auto power-off, language, panel direction.
7. Raw hex TX/RX log with decoded frames.
8. Local measurement history (browser storage) with CSV export.

**Should have**
9. Device palette slots: read the 4 slots, write/delete a palette built from saved measurements.
10. Line scan (18 patches) and line-compare scan.
11. Device history sync (History check/get).

**Excluded:** firmware update, Munsell/colour-book data, gamut check, cloud features, NVRAM log (could go in a debug panel).
