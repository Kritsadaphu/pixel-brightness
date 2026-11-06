# Sony A7 IV camera helper boundary

Pixel Brightness keeps proprietary camera SDK code outside the Render Node. A
licensed Windows helper owns Sony Camera Remote SDK, downloads one still RAW,
decodes it to bounded linear samples, and exchanges only a verified raster with
the Node. A helper crash, callback deadlock or SDK timeout must therefore be
killable without stopping the renderer or control plane.

This repository defines and tests the boundary. It does **not** contain Sony's
SDK, a Sony DLL, or a hardware-verified `PixelBrightnessCamera.exe`. Measured
calibration remains unavailable until that separately licensed helper is built,
installed in the protected release tree and tested with the exact A7 IV body.

## Node configuration

The Windows Node defaults to the intended camera identity but fails closed while
the helper path is absent:

```json
{
  "cameraBackend": "sony-sdk",
  "cameraExpectedModel": "ILCE-7M4",
  "cameraHelperCommand": "C:\\Program Files\\Pixel Brightness\\releases\\VERSION\\native\\windows\\bin\\PixelBrightnessCamera.exe",
  "cameraHelperTimeoutMs": 30000,
  "cameraCaptureDir": "C:\\ProgramData\\Pixel Brightness\\state\\node\\camera-captures"
}
```

The helper executable and every parent directory must pass the same protected
runtime ACL/reparse-point checks as the renderer. The capture directory belongs
to the interactive Show account, contains no long-lived RAW archive, and must
not be shared over the network.

## Process protocol

The Node starts the absolute command directly, without a shell:

```text
PixelBrightnessCamera.exe --stdio --capture-root <absolute-confined-directory>
```

stdin and stdout are newline-delimited JSON. Each request has a unique `id` and
each response must echo it. A record is limited to 1 MiB. Binary pixels never go
through JSON.

```json
{"schemaVersion":1,"id":"camera-1","method":"detect","params":{"backend":"sony-camera-remote-sdk","expectedModel":"ILCE-7M4"}}
{"id":"camera-1","ok":true,"result":{"protocolVersion":1,"helperVersion":"...","cameras":[{"id":"...","vendor":"Sony","model":"ILCE-7M4","serial":"...","transport":"usb","backend":"sony-camera-remote-sdk","capabilities":{"manualExposure":true,"manualWhiteBalance":true,"manualFocus":true,"linearCapture":true}}]}}
```

Required methods are:

- `detect`
- `open`
- `lock-manual-settings`
- `capture`
- `capture-survey-preview`
- `close`

`capture` receives the complete deterministic step, exposure-profile identity,
expected manual settings, repeat index and raster limits. Its response points to
one regular file created beneath `--capture-root`:

```json
{
  "id": "camera-4",
  "ok": true,
  "result": {
    "id": "vendor-capture-id",
    "capturedAt": "2026-08-24T12:00:00.000Z",
    "rawFormat": "ARW",
    "sourceBitDepth": 14,
    "sourceSha256": "64-lowercase-hex-of-downloaded-arw",
    "source": {
      "path": "C:\\ProgramData\\Pixel Brightness\\state\\node\\camera-captures\\camera-4.arw",
      "byteLength": 45678901,
      "sha256": "64-lowercase-hex-of-downloaded-arw"
    },
    "linearized": true,
    "exposure": { "normalizationScale": 60 },
    "camera": { "model": "ILCE-7M4", "serial": "...", "firmware": "..." },
    "lens": {
      "id": "...",
      "vendor": "Sony",
      "model": "FE 16-35mm F2.8 GM II",
      "mount": "E",
      "focalLengthMm": 16,
      "apertureF": 5.6,
      "focusLocked": true,
      "zoomLocked": true,
      "stabilization": "off"
    },
    "decoder": {
      "name": "LibRaw",
      "version": "pinned-version",
      "binarySha256": "64-lowercase-hex-of-the-loaded-decoder-binary"
    },
    "rawDecode": {
      "rawFormat": "ARW",
      "sensorWidth": 7008,
      "sensorHeight": 4672,
      "cfaPattern": "RGGB",
      "blackLevels": [512, 512, 512, 512],
      "whiteLevels": [16383, 16383, 16383, 16383]
    },
    "pipeline": {
      "captureMode": "single-shot",
      "shutterMode": "efcs",
      "rawEncoding": "lossless-compressed",
      "blackLevelSubtracted": false,
      "whiteBalanceApplied": false,
      "toneCurveApplied": false,
      "noiseReductionApplied": false,
      "lensCorrectionsApplied": false
    },
    "conditionVerification": {
      "projectorState": "emission-off",
      "opticalPath": "blocked",
      "otherProjectors": "emission-off",
      "method": "explicit-operator-confirmation",
      "verifiedAt": "2026-08-24T12:00:00.000Z"
    },
    "raster": {
      "path": "C:\\ProgramData\\Pixel Brightness\\state\\node\\camera-captures\\camera-4.f32",
      "width": 2432,
      "height": 1621,
      "pixelFormat": "linear-rgb-f32-le",
      "byteLength": 47311104,
      "sha256": "64-lowercase-hex"
    }
  }
}
```

The Node independently reads both exchange files. It verifies that the ARW and
decoded raster are distinct regular non-link files inside the real capture
root, hashes the ARW itself and requires that digest to equal both
`source.sha256` and `sourceSha256`. It then verifies that the raster byte count
exactly matches width × height × channels × 4, checks its SHA-256 and rejects
any non-finite float. Both temporary files are removed after validation.
Any timeout, malformed message, unknown response ID, path escape, digest error or
non-finite sample kills the helper and fails calibration closed.

The numeric values above illustrate the protocol shape; the production helper
must report values read from the pinned RAW decoder for that exact ARW and must
not hard-code assumed A7 IV levels. `decoder` and `rawDecode` are exact,
bounded-scalar objects: unknown keys, binary/maker-note payloads, non-canonical
case or an invalid decoder binary digest are rejected. Every physical capture
must have a new lowercase `sourceSha256`. Reuse of a RAW source, or any change
to decoder identity, sensor dimensions, CFA, black levels or white levels during
one calibration session, aborts the session while outputs remain fail-closed.

### Markerless survey preview

`capture-survey-preview` is one bounded still-capture command; it is not a Sony
live-view or SDK JPEG request. The Node supplies the authenticated request id,
camera id, fixed `cameraViewId`, exact manual settings, a SHA-256 lens-profile
binding (body/lens serials, focal/focus/aperture and raster), and server-derived
raster limits. The helper must lock/read back those settings and return the same
uncorrected `linear-rgb-f32-le` ARW decode and provenance fields as `capture`,
plus:

```json
{
  "rawSourceKind": "single-shot-linear-raw-decode-v1",
  "lensProfileSha256": "64-lowercase-hex",
  "sourceSha256": "sha256-of-downloaded-arw",
  "manualLock": {
    "confirmed": true,
    "applied": "exact-requested-settings-object",
    "lockedFields": ["exposureMode", "iso", "apertureF", "shutterUs", "whiteBalance.mode", "whiteBalance.kelvin", "focusMode", "captureFormat"]
  }
}
```

The returned raster dimensions must exactly equal the bound lens-profile frame.
The Node verifies the exchange-file hash, canonical ARW digest, decoder binary
identity, bounded RAW decode metadata, body/lens serials and every
lock, then creates a lossless grayscale PNG with no crop, resize, interpolation
or lens correction. The Server verifies canonical base64, byte length, SHA-256,
PNG header and dimensions before exposing the artifact through an authenticated,
`private, no-store` endpoint. No helper path is ever returned to the operator.

## Required A7 IV acquisition profile

The helper must read back and record, rather than merely request:

- single still capture; mechanical shutter or electronic first curtain;
- 14-bit uncompressed or lossless-compressed RAW, never JPEG/HEIF or lossy RAW;
- fixed ISO, shutter, aperture, Kelvin white balance and manual focus;
- FE 16-35mm F2.8 GM II at the profiled focal length (initial target 16 mm),
  with zoom and focus physically locked;
- tripod, stabilization off, automatic lens correction off, no tone curve,
  no noise reduction and no processed SDK preview as measurement data;
- sensor black level retained through decode. Pixel Brightness subtracts the
  measured sensor-dark reference itself.

The V2 plan deliberately uses two exposure profiles: a short geometry exposure
that protects white/Gray-code highlights and a calibrated longer radiometry
exposure for black/near-black/color. Its explicit `normalizationScale` is a
measured linear ratio; it must not be guessed from ISO × shutter time.

## Hardware acceptance before enabling measured apply

Follow the complete [`sony-a7iv-arrival-checklist.md`](sony-a7iv-arrival-checklist.md)
with the exact production body, lens, firmware, cable, power path and decoder.
The summary below is only the minimum release gate.

Use the exact body, lens, firmware, USB cable, power supply and decoder build.
The release gate must include:

1. 50 consecutive open/lock/capture/download/close cycles without a leaked SDK
   session or corrupt ARW.
2. Lens-cap dark stacks at both exposure profiles after a 10-minute warm-up;
   inspect temporal noise, row/column pattern, hot pixels and drift.
3. Flat gray stacks at center and corners; verify no clipping, flicker banding,
   focus/zoom movement or hidden lens correction.
4. Forced helper hang during capture; Node must meet its deadline, kill the
   helper and keep every projector fail-closed.
5. Apply a measured revision, wait for renderer acknowledgement, then perform a
   separate optical verification capture. A committed project is not an optical
   pass.
