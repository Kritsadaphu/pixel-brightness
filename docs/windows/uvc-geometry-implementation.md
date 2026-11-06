# UVC geometry acquisition implementation — 2026-09-06

This is implemented development code, **not the complete Pixel Auto release**.
It is separate from the existing RAW calibration contract and installed renderer.
No production configuration or Arena composition was replaced.

## Executable path implemented

`run-uvc-geometry.mjs` → supervised `NdiPatternTransport` → Windows
`pixel-brightness-ndi-patterns.exe` → NDI SDK pattern sources; then
`UvcCamera` → `UvcGeometrySession` → streaming Gray-code correspondence decoder
→ optional warp candidate for an explicit camera-space target mesh → artifact files.

- Supports one to five explicitly identified outputs, even widths up to 4096
  and heights up to 2160.
- Each target receives solid/Gray/inverse patterns while the other **dedicated
  pattern sources** are black. It does not blank existing Arena sources or prove
  that projectors have been switched to these pattern sources.
- Unique `PB-GEOMETRY-<UUID>-<output>` names prevent replacing an Arena sender.
- The native sender is a separate, supervised process. Heartbeat expiry/EOF
  requests three black submissions and exits. A blocked SDK call is terminated
  by the parent timeout. Decoder hold-last-frame means process exit is **not**
  evidence of physical black.
- Capture requires exact device identity, fresh host timestamp, fixed dimensions
  and a matching RGB raster digest. Gray bit pairs are decoded incrementally.
- Black/white references are repeated after each output. Excessive reference
  change rejects the candidate. This does not certify manual camera settings.
- Camera samples preserve normalized endpoints without interpolating Gray edges.
- Explicit target meshes use the existing correspondence-to-warp implementation;
  missing correspondences reject rather than fabricate mesh points.
- Results have `candidate-not-applied` status. No photometric/black-level accuracy,
  physical pattern synchronization, lens profile, or before/after result is claimed.
- Cancellation, camera/protocol failures and artifact failures all invoke sender
  cleanup. Cleanup failures remain visible, not silently converted into success.

## Running on the Windows development build

The main server now exposes opt-in acquisition at
`/v1/calibrations/uvc-geometry`, with `/devices`, `/confirm-routing` and `/cancel`.
These reuse the existing control authorization. HTTP requests cannot choose
executables or artifact directories. The new USB geometry panel is integrated
in the existing Auto Calibrate page; it requires explicit receiver routing
confirmation and reports `candidate-not-applied`, never Auto-ready.

Enable only in a separate Windows development server with
`PB_UVC_GEOMETRY_ENABLED=1`, `PB_UVC_CAMERA_COMMAND`, `PB_NDI_PATTERN_COMMAND`,
and `PB_NDI_RUNTIME_DIRECTORY`. Use a separate port and new data directory;
do not point a preview server at production data. Production remains unchanged.
The UI follows the existing local Sites application; nothing was published.

The CLI requires a plan JSON containing:

- `cameraCommand`: absolute path to `pixel-brightness-uvc.exe`.
- `patternCommand`: absolute path to `pixel-brightness-ndi-patterns.exe`.
- `runtimeDirectory`: the installed official NDI SDK `Bin\x64` directory.
- `outputDirectory`: a **new** absolute directory; existing directories are rejected.
- `deviceId`: the exact current R50 Media Foundation identity.
- `outputs`: `{ id, width, height }` entries; optional explicit `targetMesh`.
- Optional `sampleStride` (default 3), `settleMs` (default 1000), `contrast` (default 18).

Invoke with the installed Node executable:

```powershell
node scripts/run-uvc-geometry.mjs <absolute-plan-path.json>
```

It verifies the camera exists before starting any source. After starting, it
prints the exact test source names and waits up to two minutes for at least one
NDI consumer on each source. A connection count is **not** physical routing proof.
No receiver login or subscription is changed automatically. The operator must
restore test receivers to their previous Arena sources afterward; this CLI does
not claim automatic restoration.

Successful captures produce `candidate.json` and bounded little-endian coordinate
and confidence files with SHA-256 digests. Failures produce `failure.json`; no
successful candidate file is written on failure. Partial artifacts are retained
for diagnosis and must not be applied independently.

## Evidence and limitations

- Windows MSVC Release build of the pattern host passed against the official
  installed NDI SDK 6.3.2.
- Initial Windows run passed 14/14 tests: synthetic acquisition/decoder cases,
  plus real NDI pattern IPC, white/black target isolation, Gray/inverse mean
  checks, status, normal shutdown and process restart with new source names.
  Test sources were 64 × 32 and were received locally on Windows. This is not
  a physical projector or full-resolution throughput test.
- Latest Windows UVC/geometry/real-NDI test run: 24 tests, 23 passed, one
  POSIX-only fixture skipped, zero failures. Includes endpoint-preserving target
  meshes, five-output ordering and flat/no-contrast rejection.
- Windows main-server/controller/authentication/network tests: 26/26 passed.
- Web production build and full TypeScript checking now pass. Nullable/union
  handling was corrected and local worker environment types were generated;
  no Cloudflare resource was provisioned or published.
- A real Windows main-server smoke check at 2026-09-06 23:07 Bangkok returned
  HTTP 200 for device discovery. It found four NDI Webcam virtual devices and
  no R50. No pattern sources were started. Evidence is retained under
  `C:\ProgramData\Pixel Brightness Build\ndi-dev-20260906\server-smoke-RK6dii`.
  The temporary server was closed after the check; this is not a running UI
  deployment or a physical acquisition result.
- Saved Arena files were backed up to
  `C:\Users\CPU_Mapping\Documents\Pixel-Arena-Backup-20260906-225420`
  (266 files, 2,399,543 bytes). This captures saved files only, not unsaved in-memory
  edits. No Ctrl+S or live composition change was performed by this backup.

The new main Web Control integration is now staged separately on Windows ports
3001/4101. Corrected NDI video is implemented as a development preview; see
`ndi-video-preview.md` for fresh frame-rate measurements and limitations.

Still required: integration with production corrected NDI output,
physical pattern/frame verification, measured geometry/blend and
radiometry validation, rollback of receiver subscriptions, sustained five-output
tests, and the complete installer. Battery availability does not make these
software tasks complete.
