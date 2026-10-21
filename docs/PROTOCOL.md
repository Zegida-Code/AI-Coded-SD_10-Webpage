# Epson SD-10 Spectrometer — BLE Protocol

Reverse-engineered from **Epson Spectrometer 1.12.0** (`com.epson.spectrometer`).
The Java layer (`com.epson.munselllib.ble.*`) is only a byte pipe; all framing lives in
`lib/arm64-v8a/libmunsell-lib.so` (C++ namespace `EPSPM`, unstripped). Every command frame
below was produced by **executing the library's own `EPSPM::CommandBuilder` functions in an
emulator** (Unicorn), and reply layouts were confirmed by feeding crafted replies to the
library's own `EPSPM::ResponseParser` functions.

Conventions: bytes in hex, `u16`/`u32`/`f32` are **little-endian** unless marked BE.

---

## 1. GATT layout

| Role | UUID | Notes |
|---|---|---|
| Advertised service (scan filter) | `4d756e73-656c-6cde-92b1-3b0cb21f4bf7` | ASCII "Munsell"; only in advertising |
| GATT service | `49535343-fe7d-4ae5-8fa9-9fafd205e455` | Microchip ISSC "Transparent UART" |
| TX → device (write) | `49535343-8841-43f4-a8d4-ecbe34729bb3` | write **with response** |
| RX ← device (notify) | `49535343-1e4d-4bd9-ba61-23c647249616` | enable via CCCD `0x2902` = `01 00` |

Connection sequence used by the app (`BluetoothWork` / `g.java`):
`connectGatt` → (500 ms) `discoverServices` → `requestMtu(512)` → chunk size = MTU − 3 → enable notify on RX.
Writes longer than the chunk size are split and sent back-to-back, each waiting for its write callback.

> Web Bluetooth: filter on the advertised service UUID **and** list the GATT service in `optionalServices`.

---

## 2. Frame format

### Command (host → device)

```
offset  size  field
0       1     0x00            sync
1       1     0x43 ('C')      magic
2       1     cmdId
3       1     op              0x10 = size-check, 0x11 = get, 0x12 = execute, 0x13 = set/notify
4       4     payloadLen u32
8       n     payload
```

No checksum, no encryption. (Only exception: group names are XOR-0x5A obfuscated, §5.11.)

### Reply (device → host)

```
0  0x00   1  0x43   2  cmdId (echo)   3  op: 0x01 = reply, 0x00 = size-check reply
4  payloadLen u32   8  payload
```

The parser validates `[0]==00`, `[1]==43`, `[2]==cmdId`, `[3]==expected op` and `len ≥ 8+payloadLen`.
Most "do something" commands reply with the 2-byte ASCII status `"OK"` (10-byte reply).

### Acknowledgement (host → device, after every reply)

| Byte | Meaning |
|---|---|
| `FF` | OK — reply received and parsed |
| `FE` | NG — reply missing/garbled |

### Asynchronous events (device → host, single bytes)

Any byte that arrives **before** a reply's leading `0x00` (or while no command is pending) is an event:

| Byte | Event | App reaction |
|---|---|---|
| `C1` | FINISHMEASURING | fetch result from cache (§5.5) |
| `C2` | MEASUREBUTTONPUSH | user pressed the device button → read mode (§5.15) and run a measurement |
| `C3` | FINISHCALIBRATION | re-read status, report calibration result |
| `C4` | CHANGEDSTATUS | re-read status (§5.1) |
| `A0` | DISCONNECTED | tear down session (synthesised by the app on GATT loss) |
| `FF` / `FE` | OK / NG | device-side ack |

### Exchange rule (`EPSPM::Device::ExecuteCommand`)

1. Switch RX handling to *buffer mode* (Java `setEventNotificationMode(1)`).
2. Write the command frame.
3. Read exactly the expected reply size (table in §4). While searching for the reply, bytes before the first `0x00` are dispatched as events.
4. Switch RX back to *event mode*.
5. Write `FF` (parsed OK) or `FE` (failed).

Default timeouts: **5 s** write / **5 s** read; group information **30 s**.

---

## 3. Session state machine

```
            ┌──────────────┐ requestDevice / connect / notify on
 DISCONNECTED ─────────────► LINKED
                                │ ControlDevice(acquire)        §5.13
                                ▼
                         "OK" ──► CONTROLLED ──► SetDatetimeInfo §5.12
                         "NG" ──► rejected (error 7 RejectControl)
                         "TO" ──► timeout (error 8)
                         other ──► wait 1 s, resend, give up after 25 s
                                │
                                ▼
                     READY  (GetString FW/serial, GetStatus, GetInt settings)
                       │  ▲
   SetColorMeasurementMode + ExecuteColorMeasurement ─► wait C1 (≤20 s) ─► GetResultFromCache
   ExecuteCalibration ─► wait C3 ─► GetStatus
   C4 ─► GetStatus      C2 ─► GetColorMeasurementMode ─► measure
                       │
                       ▼ FinishControlDevice(release) §5.13 → disconnect
```

App's connect order (`smali/c1.1/k.smali` ≈ L2389): `open` (ControlDevice, clientType 1) →
`registerCallback` → `setDatetimeInfo(year % 100, month, day, h, m, s)` → GetString(FW), GetString(serial), GetStatus.

---

## 4. Command table

| # | Command | cmdId | op | Request payload | Reply size | Reply payload |
|---|---|---|---|---|---|---|
| 5.1 | GetStatus | `0B` | `11` | `00` | 33 | TLV status |
| 5.2 | ExecuteCalibration | `0C` | `12` | `01` | 10 | `"OK"` |
| 5.3 | ExecuteColorMeasurement | `01` | `12` | `01` | 10 | `"OK"` |
| 5.4 | GetResultFromCache — size check | `05` | `10` | `00` | 12 | `u32 dataLen` (reply op `00`) |
| 5.5 | GetResultFromCache — data | `05` | `11` | `00` | 8+dataLen | N × 144-byte records |
| 5.6 | NotifyColorMeasurementSuccessOrFailure | `1C` | `13` | `01`=success / `02`=failure | 10 | `"OK"` |
| 5.7 | GetIntValue | param | `11` | `01` | 9 | `u8 value` |
| 5.7 | SetIntValue | param | `13` | `u8 value` | 10 | `"OK"` |
| 5.8 | GetStringValue | param | `11` | `01` | 8+len | ASCII |
| 5.8 | SetStringValue (device name) | `08` | `13` | 16 bytes, NUL-padded | 10 | `"OK"` |
| 5.9 | SetColorMeasurementMode | `1A` | `13` | TLV (§5.9) | 10 | `"OK"` |
| 5.15 | GetColorMeasurementMode | `1B` | `11` | `01` | 20 | TLV |
| 5.10 | SetStandAloneMode | `1D` | `12` | `01` | 10 | `"OK"` |
| 5.10 | NotifyGroupMeasurementCompleted | `1E` | `13` | `01` | 10 | `"OK"` |
| 5.11 | SetGroupInformation | `15` | `13` | group records | 10 | `"OK"` |
| 5.11 | GetGroupInformation — size check | `16` | `10` | `01` | 12 | `u32 dataLen` |
| 5.11 | GetGroupInformation — data | `16` | `11` | `01` | 8+dataLen | group records |
| 5.12 | SetDatetimeInfo | `0D` | `13` | `YY MM DD hh mm ss` | 10 | `"OK"` |
| 5.13 | ControlDevice / FinishControlDevice | `19` | `12` | TLV (24 B) | 10 | `"OK"`/`"NG"`/`"TO"` |
| 5.14 | History — check | `13` | `11` | `01 u32 lastIdentifier` | 16 | `u32 offset, u32 count` |
| 5.14 | History — get | `14` | `12` | `01 u32 offset u32 count` | 8+143·count | N × 143-byte records |
| 5.14 | History — delete | `14` | `12` | `02 u32 a u32 b` | 10 | `"OK"` |
| — | GetNVRAMData — size check | `07` | `10` | `01` | 12 | `u32 dataLen` |
| — | GetNVRAMData — data | `07` | `11` | `01` | 8+dataLen | raw device log |

Firmware update (`FWUpdate`, separate raw transfer path) is intentionally **not** documented/used.

---

## 5. Command details

### 5.1 GetStatus
```
TX  00 43 0B 11 01 00 00 00 00
RX  00 43 0B 01 19 00 00 00 | 01 01 dd | 02 08 ee ee ee ee ee ee ee ee | 03 01 cc | 04 01 bb | 05 01 ss | 06 01 gg
```
TLV = `tag, len, value…`; multi-byte TLV values are **big-endian**.

| Tag | Field | Values |
|---|---|---|
| 1 | deviceStatus | 0 = ERROR, 4 = IDLE |
| 2 | errorStatus (u64 BE) | bitmask: bit *n* set ⇒ status error code *n* (table §6) |
| 3 | calibrationStatus | 0 = NEED, 2 = DONE, 255 = OTHER |
| 4 | battery | percent |
| 5 | shutterStatus | 0 = OPEN, 1 = CLOSE |
| 6 | chargingStatus | 0 = not charging, 1 = charging |

### 5.2 / 5.3 Calibration & measurement
```
Calibrate  TX 00 43 0C 12 01 00 00 00 01   → "OK", later event C3
Measure    TX 00 43 01 12 01 00 00 00 01   → "OK", later event C1 (app timeout 20 s)
```
Calibration appears to require the shutter closed (the `INFORM_CALIB_SHUTTER_OPEN_*` error bits fire otherwise); check `calibrationStatus` before measuring.

### 5.4 / 5.5 Measurement result (cache)
```
TX 00 43 05 10 01 00 00 00 00      RX 00 43 05 00 04 00 00 00 | u32 dataLen
TX 00 43 05 11 01 00 00 00 00      RX 00 43 05 01 <dataLen>   | records (dataLen / 144)
```
**144-byte result record:**

| Off | Size | Field | Notes |
|---|---|---|---|
| 0x00 | 1 | gettingResult | 0 = measurement failed (read GetStatus for reason), 1 = OK |
| 0x01 | 6 | year(YY) month day hour min sec | year is 2-digit |
| 0x07 | 124 | 31 × f32 | spectral reflectance factor (0–1), **400 … 700 nm, 10 nm step** |
| 0x83 | 1 | mFactor | 0 = M0, 1 = M1, 2 = M2 |
| 0x84 | 1 | lightSource | enum §5.9 |
| 0x85 | 1 | viewAngle | 2 or 10 |
| 0x86 | 1 | colorDiffFormula | enum §5.9 |
| 0x87 | 4 | identifier (u32) | unique result id (app treats as 32-bit LE) |
| 0x8B | 2 | inspectionNo (u16) | |
| 0x8D | 1 | patchNo | |
| 0x8E | 2 | groupId (u16) | |

The wavelength for sample *i* = `400 + 10·i` (the library hard-codes lower=400 / upper=700).
Lab/LCh/sRGB are computed **on the host** from this spectrum (`ConvertSpectrumToLab`, illuminant + observer).

### 5.6 NotifyColorMeasurementSuccessOrFailure
`00 43 1C 13 01 00 00 00 01` (success) / `… 02` (failure). Sent after a line-scan comparison so the device can show pass/fail.

### 5.7 Integer parameters

| Parameter (API id) | cmdId | Get | Set range |
|---|---|---|---|
| BUZZERVOLUME (8) | `0F` | ✓ | 0 off, 1 small, 2 big |
| PANELDIRECTION (9) | `10` | ✓ | 0 = 0°, 1 = 90°, 2 = 180°, 3 = 270° |
| AUTOPOWEROFF (12) | `1F` | ✓ | 0 disabled, 1 = 10 min, 2 = 30 min, 3 = 60 min |
| LANGUAGE (13) | `20` | ✓ | 0 JA, 1 EN, 2 FR, 3 DE, 4 IT, 5 ES, 6 PT, 8 TR, 9 NL, 10 RU, 11 ZH-CN, 12 ZH-TW, 13 KO (7 invalid) |

```
Get  00 43 <id> 11 01 00 00 00 01      RX 00 43 <id> 01 01 00 00 00 <value>
Set  00 43 <id> 13 01 00 00 00 <value> RX "OK"
```

### 5.8 String parameters

| Parameter | cmdId | Reply length | R/W |
|---|---|---|---|
| DEVICENAME (5) | `08` | 16 (NUL-padded) | read/write (max 16 bytes) |
| FWVERSION (10) | `03` | 6 | read |
| SERIALNUMBER (11) | `0E` | 10 | read |

```
Get  00 43 08 11 01 00 00 00 01
Set  00 43 08 13 10 00 00 00 4D 79 53 44 31 30 00 00 00 00 00 00 00 00 00 00   ("MySD10")
```

### 5.9 SetColorMeasurementMode (`1A`/`13`) — TLV payload

The API `measurementMethod` is translated to a **different wire value** and only certain tags are sent per method:

| API method | Wire `01` | Tags sent (in order) |
|---|---|---|
| 1 SPOT_SINGLECOLOR | `01` | 01 02 04 05 06 |
| 2 SPOT_COMPARISON | `02` | 01 02 04 05 06 07 08 |
| 3 SPOT_GROUP | `02` | 01 02 09 0B |
| 4 SCAN (line) | `05` | 01 02 04 05 06 0A 0D 0E 0F |
| 5 SCAN_GROUP | `03` | 01 02 09 0A 0B |
| 6 CALIBRATION | `04` | 01 |
| 7 SCAN_COMPARISON | `03` | 01 02 04 05 06 07 08 0A 0D 0E 0F |

| Tag | Len | Field | Encoding / range |
|---|---|---|---|
| 01 | 1 | method | wire value above |
| 02 | 1 | saveResult | `02` = save to history, `01` = don't |
| 04 | 1 | mFactor | 0–2 |
| 05 | 1 | lightSource | 0 D50, 1 D65, 2 A, 17 F1, 18 F2, 19 F3, 23 F7, 24 F8, 25 F9, 26 F10, 27 F11, 28 F12 |
| 06 | 1 | viewingAngle | 2 or 10 |
| 07 | 1 | colorDiffFormula | 0 ΔE00, 1 ΔE94 graphic arts, 2 ΔE94 textile, 3 ΔE76 |
| 08 | 4 | colorDiffThreshold | f32 of (threshold × 10), threshold 0–20 |
| 09 | 1 | groupNo | 1–4 (device slot) |
| 0A | 1 | patchNum | 1–18 |
| 0B | 1 | startPatchNo | 1–80 |
| 0D | 1 | patchBorder | 0/1 |
| 0E | 12·patchNum | target Labs | per patch 3 × f32 of (L×100, a×100, b×100) |
| 0F | 2 | lineNo | u16, 1–65535 |

Examples (emulator output):
```
spot, M0, D50, 2°, save          00 43 1A 13 0F 00 00 00 01 01 01 02 01 02 04 01 00 05 01 00 06 01 02
spot comparison, ΔE00, thr=1.0   00 43 1A 13 18 00 00 00 01 01 02 02 01 02 04 01 00 05 01 00 06 01 02 07 01 00 08 04 00 00 20 41
calibration mode                 00 43 1A 13 03 00 00 00 01 01 04
spot group, slot 4, start 80     00 43 1A 13 0C 00 00 00 01 01 02 02 01 02 09 01 04 0B 01 50
```
Note: the shipped JNI wrapper zeroes the Lab array before sending (Java `labs` is ignored), so the
official app always sends zero targets in tag `0E`.

### 5.10 Stand-alone / group completion
`SetStandAloneMode 00 43 1D 12 01 00 00 00 01` — hand control back to the device UI.
`NotifyGroupMeasurementCompleted 00 43 1E 13 01 00 00 00 01`.

### 5.11 Group information (device color-palette slots)

Payload = concatenation of records. **Register** record (control `02`):

| Size | Field |
|---|---|
| 1 | control: `02` register, `01` delete (delete record = `01 slot` only) |
| 1 | slotNo (1–4) |
| 2 | hardwareId (u16) |
| 1 | groupNameLength (≤ 42) |
| 42 | groupName, each byte **XOR 0x5A**, padded with `5A` |
| 1 | patchBorder |
| 1 | labsNum (≤ 80) |
| 1 | mFactor |
| 1 | lightSource |
| 1 | viewingAngle |
| 1 | colorDiffFormula |
| 4 | threshold f32 (×10) |
| 12·labsNum | Labs, 3 × f32 (×100) each |

```
register slot 1 "Paint", hw 0x1234, 1 Lab (50,10,-20), thr 1.0:
00 43 15 13 45 00 00 00 02 01 34 12 05 0A 3B 33 34 2E 5A…(37×5A) 00 01 00 00 02 00 00 00 20 41 00 40 9C 45 00 00 7A 44 00 00 FA C4
delete slot 3:  00 43 15 13 02 00 00 00 01 03
```
The GetGroupInformation data reply uses **the same record format**.

### 5.12 SetDatetimeInfo
`00 43 0D 13 06 00 00 00 YY MM DD hh mm ss` — YY = year % 100 (valid 20–99), MM 1–12, DD 1–31, hh 0–23, mm/ss 0–59.

### 5.13 ControlDevice / FinishControlDevice (session lock)
```
00 43 19 12 18 00 00 00 | 01 01 <act> | 02 01 <clientType> | 03 10 <16-byte appId>
act: 01 = acquire, 02 = release
clientType: 1 = PERMIT_SA_BEHAVIOR (used by the app), 2 = PROHIBIT_SA_BEHAVIOR
appId: 16 random bytes generated once per install and persisted
```
Reply `"OK"` = granted; `"NG"` = another client holds control; `"TO"` = timeout. Anything else ⇒ retry each 1 s for up to 25 s.

### 5.14 History
1. `00 43 13 11 05 00 00 00 01 <u32 lastIdentifier>` → reply payload `u32 offset, u32 count` = the records newer than `lastIdentifier`.
   The app sends `device.last_color_info_id` from its DB: **0 for a newly registered device** (= everything), afterwards the
   identifier of the newest record it imported from that device (it does *not* advance for measurements taken in the app).
   Observed on a real SD-10: request `…01 C6 03 00 00` (966) → reply `C6 03 00 00 | 00 00 00 00`, i.e. with nothing newer
   the device echoes the identifier as `offset` and returns `count = 0`.
2. `00 43 14 12 09 00 00 00 01 <u32 offset> <u32 count>` → `count` × **143-byte** records = the 144-byte record of §5.5 without the leading `gettingResult` byte.
3. Delete: `00 43 14 12 09 00 00 00 02 <u32> <u32>`.

### 5.15 GetColorMeasurementMode (`1B`/`11`)
Reply TLV (12 bytes): `01 01 m | 04 01 groupNo | 05 01 patchNum | 06 01 startPatchNo`.
Wire `m`: `02` → SPOT_GROUP (3), `03` → SCAN_GROUP (5), `04` → CALIBRATION (6); other values are rejected. Used after event `C2` to learn what the user selected on the device.

---

## 6. Error codes

**Library return codes:** 0 OK, 1 Memory, 3 InvalidParameter, 4 OutOfBound, 5 Busy, 6 Other, 7 RejectControl, 8 Timeout, 100000 + n = I/O error n.

**errorStatus bits** (status tag 2, bit *n*):

| n | Code | n | Code |
|---|---|---|---|
| 2 | FATAL SC_TEMP_HIGH | 25 | ALERT DEVICE_ERR_TH_SENSOR |
| 3 | FATAL SC_TEMP_LOW | 26 | ALERT DEVICE_ERR_BLE |
| 4 | FATAL BATTERY_NO_RECEIVE | 27 | ALERT DEVICE_ERR_BCCC |
| 5 | FATAL BATTERY_CONNECT | 28 | ALERT DEVICE_ERR_RTC |
| 6 | FATAL BATTERY_TIMEOUT | 30 | ALERT FWUPDATE_TEMP_HIGH |
| 7 | FATAL BATTERY_UPERR | 32 | ALERT WDT_ERR |
| 8 | FATAL BATTERY_FULL | 33 | ALERT FWUPDATE_TEMP_LOW |
| 9 | FATAL LED_DRV | 34 | ALERT CALIB_ERROR |
| 10 | FATAL LED_FAIL | 35 | INFORM BATTERY_EMPTY_FAIL |
| 11 | FATAL ETALON_DEVICE_FAIL | 36–43 | INFORM battery charge/discharge temperature control |
| 12 | FATAL ETALON_TH_FAIL | 44 | INFORM BATTERY_EMPTY_LOW |
| 13 | FATAL LED_TH_FAIL | 47 | INFORM CALIB_SHUTTER_OPEN_PON_MEASUREMENT |
| 14 | ALERT DISCHARGE_TEMP_LOW_MUC | 48 | INFORM CALIB_SHUTTER_OPEN_PON |
| 15 | ALERT DISCHARGE_TEMP_LOW_BATTERY | 49 | INFORM CALIB_SHUTTER_OPEN_MEASUREMENT |
| 16 | ALERT DISCHARGE_TEMP_HIGH_MUC | 50 | INFORM SCAN_FAIL_SHORT_PATCH |
| 17 | ALERT DISCHARGE_TEMP_HIGH_BATTERY | 51 | INFORM SCAN_FAIL_TIMEOUT |
| 18 | ALERT ETALON_TH_HIGH_WARNING | 52 | INFORM SCAN_FAIL_QUICK_MOTION |
| 19 | ALERT ETALON_TH_LOW_WARNING | 54 | INFORM HISTORY_FULL_COLOR |
| 20 | ALERT LED_TH_HIGH_WARNING | 55 | INFORM HISTORY_FULL_GROUP |
| 21 | ALERT LED_TH_LOW_WARNING | 57 | INFORM OTHER_MEASUREMENT_EXE_ERROR |
| 23 | ALERT DEVICE_ERR_SERIAL_FLASH | | |
| 24 | ALERT DEVICE_ERR_LED_DRIVER | | |

The app reports the **lowest** set bit.

---

## 7. Open questions (need a real device or HCI snoop log)

- ~~Absolute scale of the spectral values~~ — resolved: **0–1 reflectance factor**. The app passes the raw floats to
  `librmcc` `ConvertSpectralToLab`, where 1.0 gives L\* ≈ 100 (L\* is clamped at 130.15, so percent values would saturate).
- Whether the device needs an ack (`FF`) after unsolicited events; the library only re-sends `FF` when a previous ack write failed (`CancelEventNotificationProhibitionState`).
- Exact semantics of the two `u32` arguments of History-delete.
