# Resolume Arena → Pixel Brightness master-composition contract

This is the supported Windows V1 show path:

```text
Resolume Arena
  media · timeline · layers · effects · one master Composition
                         │ one Spout texture: PB-COMPOSITION
                         ▼
Pixel Brightness final processor
  receive once
    ├─ crop A → camera mesh/curve → blend → black map → colour/LUT → mask → Projector A
    ├─ crop B → camera mesh/curve → blend → black map → colour/LUT → mask → Projector B
    └─ crop C → camera mesh/curve → blend → black map → colour/LUT → mask → Projector C
```

Arena is the player. Pixel Brightness is the mapper, calibration engine and
only physical projector output. Arena must never send a per-projector mapped or
edge-blended image in this mode.

## Responsibility boundary

| Function | Owner |
| --- | --- |
| Clips, audio, timeline, live effects and layer composition | Arena |
| Master Composition resolution and frame rate | Arena, matching the Pixel Brightness canvas |
| Source-area selection per projector | Pixel Brightness `sourceViewport` |
| Keystone, curved surfaces and dense camera mesh | Pixel Brightness |
| Edge blend and overlap normalization | Pixel Brightness |
| Polygon/final mask and crop outside the surface | Pixel Brightness |
| Black-uniformity, gain/gamma and LUT | Pixel Brightness |
| Stable Windows display binding and fullscreen scanout | Pixel Brightness |
| Missing-input safety black | Pixel Brightness |

This single-owner rule prevents double warp and double blend. Arena's master
texture stays rectangular and uncorrected; projector defects are stored only in
the Pixel Brightness project.

Resolume documents that Spout shares a GPU texture with another Windows
application and that an Advanced Output Screen uses its Screen name as the
Spout Sender name. See the official
[Syphon & Spout](https://resolume.com/support/syphonspout),
[Screens](https://resolume.com/support/screens), and
[Advanced Output](https://resolume.com/support/advanced-output) chapters.

## Arena setup: one master sender only

Preferred deterministic setup:

1. Set Arena's Composition width, height and frame rate to the Pixel Brightness
   master canvas.
2. Open **Output → Advanced** and create exactly one Spout Screen.
3. Rename it exactly `PB-COMPOSITION`.
4. Set its width and height equal to the full Composition.
5. Give it one rectangular slice covering the entire Composition at 1:1.
6. Leave output transform, masks, warp and edge blend at identity/off.
7. Do not assign Arena to any physical projector display.
8. Save this as the Arena master-output preset.

Arena's direct Spout Composition output uses the generic Sender name
`Composition`. Pixel Brightness deliberately uses the named Advanced Output
Screen instead, so another Spout source cannot be selected accidentally. The
receiver never binds to `Composition`, an active sender, or a sender-selection
dialog.

## Canvas and overlap math

For three 1920×1080 projectors with 240 px overlap at each join and no source
scaling:

```text
canvas width = 1920 + 1920 + 1920 - 240 - 240 = 5280

PB-COMPOSITION 5280 × 1080
0                 1680                3360                 5280
├──── crop A 1920 ────┤
                  ├──── crop B 1920 ────┤
                                      ├──── crop C 1920 ────┤
                  ◄ 240 ►             ◄ 240 ►
```

The shared pixels in each intersection are what Pixel Brightness fades in
linear light. The example configuration therefore uses:

| Output | `sourceViewport` | Blend edge |
| --- | --- | --- |
| A | `x=0, width=1920` | right 240 |
| B | `x=1680, width=1920` | left 240, right 240 |
| C | `x=3360, width=1920` | left 240 |

A 5760×1080 Composition is also allowed, but it is not automatically the
physical wall width once overlaps exist. Either preserve 5280 useful pixels
inside that larger canvas or configure deliberate source scaling. Never enter
three independent 1920 px lanes and then expect a 240 px geometric overlap to
appear without duplicating a shared source region.

## Top-level `compositionSource` contract

Use [`config/windows-arena-final-processor.example.json`](../../config/windows-arena-final-processor.example.json)
as the starting point. There is exactly one top-level `compositionSource`:

```json
{
  "canvas": {
    "width": 5280,
    "height": 1080,
    "frameRateNum": 60,
    "frameRateDen": 1
  },
  "compositionSource": {
    "type": "spout",
    "senderName": "PB-COMPOSITION",
    "width": 5280,
    "height": 1080,
    "frameRateNum": 60,
    "frameRateDen": 1,
    "acceptedFormats": [
      "DXGI_FORMAT_R16G16B16A16_FLOAT",
      "DXGI_FORMAT_R8G8B8A8_UNORM",
      "DXGI_FORMAT_B8G8R8A8_UNORM"
    ],
    "colorEncoding": "srgb",
    "alphaMode": "ignore",
    "timeoutMs": 500,
    "startupGraceMs": 10000,
    "onMissing": "black",
    "onMismatch": "black",
    "allowAutoSelect": false
  }
}
```

`compositionSource.width/height/frameRate*` must equal `canvas`. Every output
samples this one validated texture; outputs do not declare their own Spout
sender.

The preferred texture is `DXGI_FORMAT_R16G16B16A16_FLOAT`. Resolume's official
[10-bit colour output](https://resolume.com/support/10-bit-color-output) guide
identifies Spout as a 16-bit-capable texture-sharing path, so use an Arena
**16 bpc** Composition for gradients and black calibration. RGBA8 and BGRA8 are
accepted for compatibility and diagnostics.

Spout does not provide a transfer-function contract to this project, so
`colorEncoding` is explicit. The normal Arena SDR preset uses `srgb`; select
`linear` only for a sender deliberately producing linear-light values. Input
alpha is ignored and the master image is treated as opaque.

Spout texture sharing requires Arena and Pixel Brightness to use the same GPU.
Resolume recommends high-performance GPU mode in its official
[Spout guidance](https://resolume.com/support/wire-syphon-and-spout), and the
Spout SDK exposes exact receiver-name, dimensions, format, frame number and
adapter inspection in the official
[SpoutDX API](https://github.com/leadedge/Spout2/blob/master/SPOUTSDK/SpoutDirectX/SpoutDX/SpoutDX.h).
Force both applications to the NVIDIA GPU in Windows Graphics settings.

Baseline show settings are SDR, RGB Full, HDR off, Windows scaling 100%, and a
matching rational frame rate end-to-end (normally 60/1 or 60000/1001).

## Physical display binding

Every enabled output has an independent `display` selector. Prefer the Windows
monitor `devicePath`; an `adapterLuid` + `targetId` pair is also exact.
`gdiName` such as `\\.\DISPLAY2` is discovery fallback only.

Windows display numbers are not the authority. The renderer enumerates paths
with `QueryDisplayConfig` and reads target identity with
`DisplayConfigGetDeviceInfo`; Microsoft documents these fields in
[QueryDisplayConfig](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-querydisplayconfig)
and [`DISPLAYCONFIG_TARGET_DEVICE_NAME`](https://learn.microsoft.com/windows/win32/api/wingdi/ns-wingdi-displayconfig_target_device_name).
Copy discovered values into the node configuration; do not guess them.

Each output then keeps its own `resolution`, `sourceViewport`, `overlap`,
`warp`, `blend`, `blackUniformity`, `color` and `mask`. A camera calibration may
replace the identity mesh and correction maps without changing Arena.
The sample starts with a disabled 2×2 identity mesh; calibrated meshes use
row-major `(columns+1) × (rows+1)` points containing normalized `u`, `v`, `x`
and `y`, up to 128×128 cells.

In V1, `interpolation` records the calibration intent (`bilinear` or
`bicubic`), but the native renderer rasterizes the saved dense grid as
triangles. It does not yet evaluate a bicubic spline at draw time. Use a dense
camera-solved grid when a curved surface needs more local control.

## Fail-closed rules

These rules are mandatory:

- No exact `PB-COMPOSITION` sender at startup → all projector swapchains show
  digital black immediately; health is `waiting`, then faulted after
  `startupGraceMs`.
- No new master frame for `timeoutMs` → replace the held master frame with black
  on every projector by the next present; report `stale`.
- Wrong master width, height or DXGI format → all projectors black immediately;
  report `mismatch` with expected and actual values.
- Sender renamed or another sender becomes active → remain black. Automatic
  sender selection is forbidden.
- A valid master source resumes only after 30 consecutive new frames establish
  the configured cadence. During this `validating` interval the shared texture
  is not exposed and every output remains black. A reconnect or replaced shared
  texture starts a fresh cadence window.
- A physical display fault is reported against that output and blocks a
  truthful show-ready state.
- Never expose the Windows desktop or retain the last show frame as fallback.

`startupGraceMs` delays the alarm only; it never delays safety black. Pixel
Brightness' internally generated 32 px grid, Gray-code and black/white/RGB
calibration patterns bypass Arena, but only while an explicit calibration mode
owns the outputs.

The executable V1 sequence, safety state machine, camera adapter boundary and
artifact contract are specified in
[`camera-calibration-v1.md`](camera-calibration-v1.md). The Canon EOS R50 adapter
is an honest unavailable boundary until an EDSDK implementation is added.

The final mask guarantees a digital zero outside the mapped polygon. It cannot
subtract an LCD projector's optical black leakage; camera black-uniformity makes
the leakage less visible by matching regions to the measured worst black floor.

## Acceptance procedure

Run this after every GPU-driver update, Arena update, cable/adapter change, or
projector replacement.

1. **Display discovery** — with Arena closed, confirm every configured
   `devicePath` (or `adapterLuid` + `targetId`) resolves to exactly one active
   projector at the expected mode. All projector outputs must be black.
2. **Master connection** — enable an Arena 5280×1080 test card containing a
   one-pixel border, 32 px grid, canvas coordinates and moving frame counter.
   Telemetry must show `PB-COMPOSITION`, exact dimensions, accepted DXGI format,
   expected frame rate and the NVIDIA adapter.
3. **Viewport routing** — put unique markers at x=0, 1680, 1920, 3360, 3600 and
   5279. Verify A/B/C sample the configured canvas regions with no unexplained
   crop, scale, flip or duplicate.
4. **Overlap ownership** — show a flat 50% grey and then moving vertical lines.
   Verify the shared 240 px regions line up and only Pixel Brightness applies
   edge weights. Arena must have no projector blend or output warp active.
5. **Camera geometry** — run Pixel Brightness' internal 32 px/Gray-code
   patterns, solve the mesh, and then restore the Arena source. The correction
   must affect the intended output only and Arena's Composition must not move.
6. **Missing source** — close Arena while showing a bright still. Every
   projector must become black within `timeoutMs` plus one refresh interval; no
   last frame or Windows desktop may remain.
7. **Name safety** — rename the Arena Screen to `PB-WRONG`. All outputs must stay
   black and must not attach to `Composition` or another sender. Restore the
   exact name and verify recovery.
8. **Mismatch safety** — change the Arena Screen to 5760×1080 while the contract
   expects 5280×1080. All outputs must black with a `mismatch` fault. Restore the
   expected size and verify recovery.
9. **Cadence safety** — cold-start and reconnect an exact-name, exact-size,
   accepted-format sender at the wrong frame rate. Confirm zero non-black output
   frames during all 30 settling frames and after the `mismatch` transition.
   Restore the configured rational rate; output may resume only after a fresh
   30-frame `validating` window passes.
10. **Final correction** — confirm per-output black map, gain/gamma/LUT and hard
   final mask can be enabled independently without changing source routing.
11. **Restart order** — reboot with Pixel Brightness starting before Arena. The
    projectors remain black, attach automatically only to `PB-COMPOSITION`, and
    return to black when Arena exits.
12. **Burn-in** — run the actual Composition for at least 30 minutes. Accept
    only with no source mismatch, stale transition, D3D reset, desktop exposure
    or persistent present-rate fault.

Record the Arena preset, Pixel Brightness config revision, canvas/overlap math,
GPU driver, actual Spout format, discovered display paths, adapter LUID/target
IDs, reported EDID identity and acceptance time with the show. That turns a
later hardware change into a reproducible defect instead of venue-side trial
and error.
