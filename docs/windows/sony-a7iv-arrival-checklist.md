# Sony A7 IV arrival and measurement acceptance

Use this checklist with the exact Sony A7 IV body, FE 16-35mm F2.8 GM II
copy, Windows 11 Render Node, USB cable and power source that will be used at
the venue. Passing ordinary tethered shooting is not enough to enable measured
Pixel Brightness calibration. The licensed camera helper, deterministic RAW
decode, fixed lens profile and optical rollback test must all pass.

## Prepare before the camera arrives

- Apply for the current [Sony Camera Remote SDK](https://support.d-imaging.sony.co.jp/app/sdk/en/)
  for the legal entity and intended commercial use. Keep its license and binary
  package outside this source repository.
- Reserve an Intel/AMD Windows 11 machine. Sony's current Windows SDK does not
  support Windows on ARM.
- Obtain a short certified USB-C data cable, strain relief and a known-good
  USB-PD supply or powered hub. Keep a charged NP-FZ100 in the camera; Sony
  states that USB supply does not operate the camera without a battery and does
  not charge that battery while the camera is on.
- Prepare a rigid tripod, opaque lens cap, flat neutral target and the exact
  ChArUco board used to create the lens profile. A physical marker is not needed
  on the projection wall.
- Do not enable measured apply while `PixelBrightnessCamera.exe` is absent or
  while the helper has only been tested with synthetic fixtures.

## Record immutable equipment identity

Before changing settings, photograph and record:

- body model `ILCE-7M4`, serial, firmware and Sony warranty evidence;
- lens model, serial and firmware;
- USB cable, hub/power-supply model and port used;
- Windows build, Sony SDK version and hashes of the helper, SDK DLLs and RAW
  decoder DLL;
- venue lens state: initially 16 mm, f/5.6, measured focus distance and camera
  pose.

Changing the body, lens copy, firmware, focal length, focus distance, aperture,
decoder or camera pose invalidates the corresponding profile or survey.

## Camera menu baseline

Set the Still/Movie/S&Q selector to still image and use manual exposure. The
helper must read every available value back; an operator menu check alone is not
authoritative.

| Setting | Required starting value |
| --- | --- |
| Drive mode | Single Shooting |
| File format | RAW |
| RAW file type | Lossless Comp (L) or Uncompressed; never Compressed, M or S |
| Shutter type | Mechanical Shutter |
| e-Front Curtain Shut. | Choose one tested state and record it as `efcs` or full mechanical; do not change it during a profile |
| Silent mode | Off |
| Anti-flicker / Variable Shutter | Off |
| Exposure | M, ISO 100, fixed aperture, independent short and long shutter profiles |
| Focus | Manual, then physically lock the focus and zoom rings |
| White balance | Fixed Kelvin, initial value 5600 K |
| SteadyShot | Off; Sony recommends Off on a tripod |
| Long Exposure NR | Off; Pixel Brightness captures its own sensor-dark reference |
| High ISO NR | Off |
| Lens compensation | Shading, chromatic aberration and distortion Off when the body permits it |
| Remote shooting | On, computer/USB path, original RAW delivered to the computer |
| USB power supply | On only with the validated power/data topology and a charged battery installed |

Sony documents [RAW file types](https://helpguide.sony.net/ilc/2110/v1/en/contents/TP1000659395.html),
[electronic-front-curtain behavior](https://helpguide.sony.net/ilc/2110/v1/en/contents/TP1000616690.html),
[long-exposure noise reduction](https://helpguide.sony.net/ilc/2110/v1/en/contents/TP1000656583.html),
[still-image SteadyShot](https://helpguide.sony.net/ilc/2110/v1/en/contents/TP1000616742.html),
and [USB power constraints](https://helpguide.sony.net/ilc/2110/v1/en/contents/TP1000640874.html).
Some lens-correction choices can be forced by a compatible lens or firmware;
the acceptance capture must determine whether the downloaded ARW remains the
uncorrected sensor raster instead of trusting the menu label.

## Bench acceptance sequence

### 1. Electrical and SDK ownership

1. Turn off Wi-Fi/Bluetooth and close Imaging Edge, Windows Photos, webcam and
   any other process that can own the camera.
2. Connect USB and power with the final cable topology.
3. Run `detect`, `open`, `lock-manual-settings`, one RAW capture/download and
   `close`.
4. Verify body/lens serials, firmware, focal length, aperture, manual focus,
   shutter mode, RAW encoding and bit depth from returned data.
5. Repeat open/lock/capture/download/close 50 times. Zero leaked sessions,
   corrupt files, reconnects, unknown callbacks or setting drift are allowed.

### 2. Decoder and raster identity

For every test capture retain an audit record containing the ARW SHA-256,
decoder name/version/DLL SHA-256, sensor dimensions, CFA, per-channel black and
white levels, bit depth and final bounded-raster SHA-256. The production raster
must be finite linear float data derived from the downloaded still RAW—not live
view, JPEG, HEIF or a tone-mapped preview.

The helper contract names these fields `sourceSha256`,
`decoder.{name,version,binarySha256}` and
`rawDecode.{rawFormat,sensorWidth,sensorHeight,cfaPattern,blackLevels,whiteLevels}`.
All digests are lowercase hexadecimal. Each physical shutter actuation must
produce one unique ARW digest; copied/replayed sources fail. Decoder identity and
the complete bounded `rawDecode` object must remain byte-for-byte canonical and
unchanged for the entire session. Do not send maker notes, thumbnails, profiles,
buffers or other binary metadata through the NDJSON/manifest boundary.

Confirm that lossless L/uncompressed single-shot data is 14 bit on this exact
firmware. Reject the camera profile if changing shutter mode or RAW mode changes
bit depth, dimensions or hidden processing.

### 3. Dark and low-light stability

After a ten-minute powered warm-up:

1. Capture at least 20 capped frames at the short exposure and 20 at the long
   exposure without moving the camera.
2. Record temporal noise, row/column residuals, hot-pixel count, black-level
   drift and sensor temperature/time.
3. Remove the cap and separately capture room ambient, warmed-projector digital
   black and projector-off/optically-muted references. Never hotplug a warmed
   projector or cover its hot lens.
4. Confirm the long exposure resolves projector leakage without clipping the
   near-black bridge patches. Sensor black must remain present in helper output;
   Pixel Brightness performs the controlled subtraction itself.

### 4. Lens profile and flat field

1. At the locked focal/focus/aperture state, capture at least 20–30 ChArUco
   views spanning the complete frame and create the Brown-Conrady intrinsic
   profile.
2. Reject a lens copy with asymmetric corner softness, visible decentering,
   focus/zoom creep or unstable focal-length readback.
3. Capture neutral flats at the same settings to build per-channel shading and
   confidence maps. Do not digitally stretch unsupported dark corners into
   high-confidence measurements.

### 5. Process-isolation and fail-closed tests

- Hang the helper during `detect`, `open`, settings lock, capture, download and
  close. Every command must meet its deadline; the Node must kill/restart the
  helper without hanging the renderer.
- Return malformed JSON, wrong request id, a path outside the capture root,
  symlink/reparse target, wrong size/hash, NaN/Infinity and a mismatched body or
  lens. Every case must fail before measured apply.
- Disconnect USB during each phase and reconnect. No stale SDK callback or old
  raster may satisfy a new request.

### 6. Full room dry run

1. Capture the markerless survey preview at the profiled camera pose and click
   each planar wall boundary TL → TR → BR → BL. Survey each camera view
   separately; do not combine walls from different camera poses into one fixed-
   view plan.
2. Run the complete short geometry and long radiometry sequence with the three
   explicit physical-reference confirmations.
3. Confirm the Server commits a new revision only after manifest validation and
   that native telemetry reports the exact active warp/blend/black/mask/LUT
   correction fingerprint.
4. Run post-apply RAW optical verification. Check absolute black drift and every
   same-wall or visible cross-wall shared-edge band.
5. Force a verification failure. The exact pre-apply outputs must be committed
   as the next revision, acknowledged by the renderer and restored to content.

Do not call a sequence of independently applied wall sessions a full-room
verification. Every view must be retained in one room bundle, applied in one
atomic final revision, and optically checked against the same native correction
fingerprint. A corner not visible from any bridge view remains explicitly
`cross-view-seams-unverified`; it must not be inferred from source-canvas
adjacency alone.

## Release decision

Measured apply remains **blocked** until all bench and room tests pass with the
same equipment identity. A successful Sony sample application, EOS-style
tether, synthetic helper fixture, generated manifest or renderer revision ACK
alone is not calibration evidence.
