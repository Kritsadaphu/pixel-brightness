# Corrected NDI preview — Windows commissioning, 2026-09-06

Latest patch: [2026-09-07 geometric Blend and receiver routing](geometry-blend-routing-20260907.md).
This adds optional generated geometry weights and journaled receiver switching;
earlier manual-routing notes below describe the original/default unconfigured mode.

## 2026-09-07 browser-origin fix

The original preview exposed UI port 3001 but left the API's allowed browser
port hardcoded to 3000. Consequently browser requests received HTTP 403
`origin_not_allowed`, despite origin-free health checks passing. This was a
deployment validation error, not a camera/GPU failure.

`PB_WEB_CONTROL_PORT` now configures the API's local browser port (default 3000).
The Windows preview launcher explicitly sets it to 3001, builds the UI for API
4101, and checks startup with `Origin: http://127.0.0.1:3001`. Regression tests
cover GET, POST, OPTIONS preflight, default production behavior and configured
trusted-local ports. Both API and Web run on MAPPINGPC, not on the Mac; SSH
forwarding is only a temporary access path. Production ports 3000/4100 are unchanged.

Verified on the running Windows preview after the patch: project/state/NDI/UVC
GETs with both localhost:3001 and 127.0.0.1:3001 origins returned 200 and the exact
CORS response origin; POST preflight returned 204. A nonexistent-job POST reached
normal validation (409 `ndi_job`) without starting or changing output. Local
regressions: 555 tests, 552 passed, three skips. Windows origin/auth/launcher
regressions: ten passed, one non-Windows case skipped. These checks reproduce
browser HTTP headers; they do not claim a visual browser interaction test.

This is a working **development preview**, not a completed Auto installation.
The installed production release, Arena composition, existing manual blends,
external receiver subscriptions, startup tasks and drivers were not changed.

## Implemented path

Exact discovered Arena NDI source → bounded latest-frame receive → D3D11 upload
→ saved viewport/warp/blend/mask/color correction → two-slot owned RGBA readback
→ one bounded SDK worker per output → isolated `PB-VIDEO-<UUID>-<output>` sources.

- One to five outputs; each at most 4096 × 2160, even width. Canvas is bounded
  to 32 million pixels, with exact size/rational frame-rate metadata checks.
- All D3D calls stay on the render owner; SDK workers own their sender and frame
  storage. Each has at most one waiting frame plus one in flight. Replacements
  are counted, not silently described as successful delivery.
- SDK runtime lifetime includes the receiver and all sender workers, including
  failure and shutdown paths.
- Starts black, explicitly unblanks. Source loss or changed saved project revision
  makes the preview black. Starting another project requires stop/restart.
- Ten-second heartbeat/EOF requests black submissions; parent process supervision
  bounds a stuck native SDK. Neither process exit nor SDK submission certifies
  physical black, projector scanout or receiver restoration.
- Main API: `/v1/outputs/ndi-preview`, plus `/sources`, `/blank`, `/stop`.
- Area, mesh warp, analytic blend, polygon mask and manual color/black lift use
  the existing native correction pipeline. Digest-bound measured blend/black/mask
  and LUT files inside the configured server data directory are now resolved,
  checked for dimensions, byte count, SHA-256 and finite/ranged floats, and copied
  into a job-owned snapshot before native startup. Missing, remote-only, escaping,
  linked, corrupt or oversized files are rejected; they are never silently omitted.
- USB Geometry can now map a specified normalized camera target rectangle to the
  saved composition viewports and save validated Warp meshes with an explicit
  operator apply action. A durable pre-apply project backup and revision-bound
  Restore action preserve prior settings. This is **not** automatic radiometry,
  automatic receiver routing, or a measured before/after verification.

## 2026-09-07 correction asset and Geometry apply patch

Windows GPU → NDI tests loaded four independent correction slots. White-input
mean RGB8 observations: blend 0.25 → 136, unmasked white → 254.67, mask zero →
0.67, constant 0.25 LUT → 136. Black-input observations: blend output → 0.67,
black lift map 0.1 → 88.33, mask zero → 0.67, LUT → 136. These were isolated
64-pixel synthetic NDI sources, not camera captures or physical projectors.

Patch regression results: 563 JavaScript tests on macOS (559 passed, four
platform/integration skips, zero failures), TypeScript checking passed, and 14/14
selected tests passed on MAPPINGPC, including both actual GPU/NDI integrations.
The tests did not change Arena or the external receivers' source subscriptions.

Geometry API adds `/v1/calibrations/uvc-geometry/apply` and `/restore`, both with
an exact job ID and project revision. Acquisition with `targetArea` also requires
`expectedRevision`. Application verifies the saved candidate digest, complete
output identity, confidence, reference drift, hole-free meshes and unfolded cells.
An edited project or active NDI preview blocks application. All non-Warp settings
are preserved. Applying a project is not proof that the physical output changed.

Limitations: R50 must be present and fixed for real capture; the USB path still
does not measure Blend/Black/colour response. Completed jobs and their backups are
on disk, but this preview's Apply/Restore controls currently refer to the current
server session. After restarting the API, retain those files and use the saved
project backup rather than assuming the buttons can recover a historical job.

Web Control shows exact sender names, saved revision, hardware adapter in the
API, counters and observed average submission FPS separately from requested FPS.

## Actual Windows evidence

Machine: MAPPINGPC, NVIDIA RTX A400, Intel i5-14400; official installed NDI SDK
6.3.2. Source: `MAPPINGPC (Arena - Composition)`, 8892 × 1200, 60/1 metadata.

Seven Windows tests passed after the worker change: controller/API sequencing,
authorization, cleanup, project invalidation, actual two-output GPU crop/color,
normal/inverse patterns, explicit blank, source loss and normal SDK shutdown.
The synthetic optical test uses 64 × 64 outputs; it is not projector evidence.
Expected measured RGB means were approximately 0.667 and 136, then 254 and
0.667 after inversion.

Short actual-Arena performance checks, **not comparable long-duration benchmarks**:

| Variant | Observed result |
| --- | --- |
| Initial sequential upload/send | Approximately 12 received fps/output in a five-second two-channel receive check |
| Latest-frame upload | Approximately 21 submission calls/sec/output, no test consumers |
| Per-output SDK workers | Approximately 36 submission calls/sec/output, no test consumers |
| SDK workers with two local full-HD probe consumers | 169 frames/channel in 5.005 / 5.025 seconds, approximately 33.8 / 33.6 received fps |

The last receive check had zero SDK-reported dropped video frames and zero
timecode regressions. Both channels were 1920 × 1080, with nonzero sampled image
values. **This does not achieve or certify 60 fps.** SDK metadata of 60/1 is not
measured frame delivery. `timingMs.send` now measures enqueue overhead, not worker
encoding time. Input receive cadence also varied; duplicate output frames can
make output submission counts higher than unique input frames.

The final native CTest run passed 11/11 on Windows, including actual local NDI
SDK roundtrip, offscreen correction, shader/configuration, pipe and recovery
contracts. Production API health remained `ok: true`, version 0.3.0, and the
existing Arena process remained responding after the tests.

Local JS regression run: 552 tests, 549 passed, three platform/integration skips,
zero failures. TypeScript check passed. Windows Web build passed with the preview
API port. This includes both launcher checks locally; Windows ran its applicable
launcher contract test (the non-Windows rejection case is skipped there).

## Open this Windows preview

On the Mapping PC, the staged folder is:

`C:\ProgramData\Pixel Brightness Build\control-preview-20260906\Pixel-Brightness-Windows-V3-Source`

Run `START-NDI-PREVIEW.cmd` in that folder. It requires the installed Node.js,
NDI SDK runtime, staged four native executables and existing dependencies. It
builds the Web UI for API port 4101, checks that 3001/4101 are free and starts both
local processes. It does not install a service or start video automatically.
It intentionally refuses an already-running preview instead of killing it.

On this commissioning PC, the separate `PixelBrightness-NDI-Preview` logon task
now supervises the launcher; see `../WINDOWS-CONTROL-RECOVERY-20260907.md`.
Normally open the desktop Control shortcut, not a second launcher. This task
does not start video, change receiver subscriptions or launch/restart Arena.

- Windows UI: `http://127.0.0.1:3001/`
- Windows preview API: `http://127.0.0.1:4101/`
- Preview state: sibling `preview-data` directory, separate from production.
- Production ports remain 3000 / 4100.
- Use Ctrl+C in the launcher after testing. Output cleanup is requested first;
  restore decoder sources explicitly. Closing the console abruptly is not proof
  of physical black or successful cleanup.

Two launch files were added to `CPU_Mapping`'s Windows Desktop:
`Pixel-NDI-Control-20260906.url` opens the already-running preview page;
`Pixel-NDI-Preview-20260906.cmd` starts the staged preview when it is not running.

The source ZIP includes the launcher **but not third-party SDK DLLs, native EXEs,
Node.js or dependencies**. It is not an offline turnkey installer. The staged
Windows folder has the separately compiled native binaries; do not replace
the installed production renderer with these test executables.

The preview project currently has only two diagnostic crops at 10% overlap,
using the actual 8892 × 1200 source canvas. Their viewport coordinates are not
measured physical alignment and must not overwrite existing Arena mapping.

## Remaining acceptance work

1. Restore live R50 availability: latest fresh enumeration still returned only
   four NDI Webcam virtual inputs, not the R50. No new optical capture was possible.
2. Verify external receiver routing and matching frame/pattern capture on both
   physical projectors, including left/right identity and camera exposure/focus.
3. Validate and apply geometry candidates, measured blend/black/color assets and
   compare actual before/after images. USB video is not RAW radiometry.
4. Resolve full-size throughput and verify the five-output/10% overlap target,
   sustained load, receiver latency, restart and rollback on the real hardware.
5. Promote a verified release and test its complete offline installer/startup and
   weekly power schedule. No unattended power-off test was performed in this run.

Hive, Screenberry and MadMapper remain product-direction references. None of the
checks above establish parity, integration or certification against those products.
