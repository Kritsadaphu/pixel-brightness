# Pixel Brightness native Windows renderer

This directory is the hardware output boundary for the Windows edition of
Pixel Brightness. It is deliberately not a media player. Arena/Resolume renders
the show, publishes one master Composition through Spout, and this process is
the final GPU stage:

```text
Arena Composition (PB-COMPOSITION) ─> one shared Spout texture / D3D11 device
                                      ├─ per-output source viewport crop
                                      ├─ indexed warp mesh (up to 128 x 128 cells)
                                   ├─ linear-light edge weight
                                   ├─ measured black map
                                   ├─ gain / offset / gamma / 3D LUT
                                   ├─ final hard/soft mask
                                   └─ one flip-model swapchain per projector
```

While the D3D device and swapchains remain usable, the renderer fails closed: a
missing sender, wrong resolution/format/frame rate, or rejected display topology
is driven to digital black rather than substituted desktop content. Spout frame
rate is checked over 30 new frames against the configured rational rate with a
tolerance of the greater of 0.5 fps or 1%. The shared texture is not exposed to
the output pipeline during that settling window: telemetry reports
`validating`, and every output remains black until cadence passes. Reconnect or
replacement of the shared texture discards the old cadence proof. Telemetry
also exposes expected, measured and delta values. A driver/device loss,
process crash, cable failure, or Windows session transition can make presenting
another black frame impossible; installations requiring guaranteed optical
black need an external watchdog, signal switcher/shutter, and kiosk policy.
All outputs on one process must be attached to the selected GPU. One immediate
D3D11 context owns rendering, which prevents concurrent-context ordering bugs.

## Build

Requirements: Windows 11, Visual Studio 2022 with Desktop C++, Windows 10/11
SDK, CMake 3.24+, Git, and an x64 build. Spout2 2.007.017 and nlohmann/json
3.11.3 are fetched from their official source repositories at immutable commits.
No prebuilt dependency binaries are downloaded.
The native target and pinned Spout libraries use the same static MSVC runtime,
so the installed renderer does not depend on a separately deployed VC runtime
DLL set.

```powershell
cd native\windows
cmake --preset vs2022-x64
cmake --build --preset release
ctest --preset test-release
cmake --install out\build\vs2022-x64 --config Release
```

For shader/display work without Spout, use `release-no-spout`; the renderer will
run patterns and black output but will report Spout as unavailable.

## First run

1. In Windows Display Settings use **Extend**, 100% scaling, HDR off, and the
   native resolution/refresh rate of every projector.
2. Connect every projector to the NVIDIA card, not the motherboard.
3. Start once with `--list-displays` and copy `devicePath`, `gdiName`, adapter
   LUID, and target ID into the config. Every identifier supplied is checked
   against the same target; disagreement or ambiguity fails closed instead of
   falling back to a possibly recycled `DISPLAY1` name. Re-run the display
   binder after a topology change.
4. Publish one master Arena Composition named `PB-COMPOSITION` at the configured
   master-canvas size. Pixel Brightness owns all per-projector crop, warp,
   blend, mask, black and color processing.
5. Start the renderer in the interactive show account, not Session 0. A Windows
   service may supervise it, but the GPU/window process itself must run in the
   logged-in console session.

Normal Show startup must use `Start-PixelBrightness.ps1`, which creates a fresh
256-bit `PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN` for exactly one Renderer/Node
process pair. Renderer refuses normal startup without it, hashes and removes
its inherited plaintext copy, creates every swapchain black, and keeps a
separate process-wide boot latch ahead of composition sampling. Node does not
release that latch during renderer connection or config apply. It sends the
authenticated `release-boot-black` IPC command only after durable Node state,
the manifest archive, host actions, saved project and all three safety lock
classes have been reconciled, every retained prepared asset has been freshly
hash-verified or downloaded, every current project cue (including an idle
project's cues) has passed that same check, the engine has prepared those verified paths, and
that result has been committed durably. The latch remains held after this local
work until an authenticated Server registration supplies the current
output-scoped project, the Node proves the Server's durable acknowledgement and
latest command cursors have not rolled back either side, and the scoped project,
timeline, and cue cache have been reconciled. A 403 for a formerly assigned
local cue does not broaden that cue's grant: Node stays black, registers, drops
or replaces the stale project from the authoritative scoped snapshot, and only
then repeats cache/prepare/durable-state proof. Persisted transport/READY labels are
not used as cache evidence. If state/cache initialization or that durable
commit fails, if cursor proof is missing/rolled back, or if any lock is retained, Node permanently disables its local
release path and that Renderer process remains boot-locked; operator recovery requires
a reviewed Show restart after the durable lock has been resolved.

```powershell
.\pixel-brightness-renderer.exe --list-displays
.\pixel-brightness-renderer.exe --list-displays-file C:\ProgramData\PixelBrightness\displays.json
.\pixel-brightness-renderer.exe --config C:\ProgramData\PixelBrightness\renderer.json
```

Command-line options override environment variables:

| Option | Environment fallback |
| --- | --- |
| `--config <path>` | `PIXEL_BRIGHTNESS_RENDERER_CONFIG` |
| `--pipe <full-name>` | `PIXEL_BRIGHTNESS_RENDERER_PIPE` |
| `--node-id <id>` | `PIXEL_BRIGHTNESS_NODE_ID` |

The default pipe is
`\\.\pipe\pixel-brightness-renderer-<sanitized-node-id>`. See
[`ipc/contract.md`](ipc/contract.md) and
[`config/renderer.schema.json`](config/renderer.schema.json).

IPC is one NDJSON request per connection. A silent client loses the sole pipe
instance after a five-second first-message deadline; a partial frame must keep
making read progress within two seconds. The writer preserves any events already
ahead of the request's result/error, writes that terminal response, and then
waits up to 500 ms for the client to read and close before forcing release for
the next request. The pipe has a protected DACL for
the current launch account plus LocalSystem and rejects remote clients. ACL
construction failure is fail-closed through listener recovery rather than a
fallback to Windows' default DACL. This is defense in depth only: every lifetime
mutation still requires the per-launch authorization token.

Named-pipe listener setup is supervised inside the renderer. Failures from
`CreateNamedPipeW`, allocation plus abort/terminal-event creation for the connection state,
and the OVERLAPPED connect event/start/wait/completion path share one
consecutive-failure budget. Retries wait 50, 100, 200, 400, 800, then at most
1000 ms and the wait is interrupted by renderer shutdown; there is no tight
failure loop. A successful controller connection resets the budget. Telemetry
reports `ipcListener` state, failure stage/error, counts, and next delay; while
retrying the top-level state is `ipc-listener-degraded`.

At eight consecutive setup failures the listener latches fatal and cannot
self-revive. The render loop detects that latch before accepting another
command or submitting the next normal content frame, explicitly presents and
flushes black on every surviving output, records `ipc-listener-fatal`, and
makes one 500 ms bounded best-effort write through the existing asynchronous
telemetry worker. It then exits with code 70 so the Show supervisor restarts
the complete renderer/Node pair. If the GPU, cable, projector, or telemetry
disk is already unusable, software cannot guarantee either optical black or a
terminal telemetry file; the non-zero process exit remains observable to the
supervisor.

The boot-black latch is software fail-closed, not an optical shutter. It closes
the pre-Node content window. Every mutating IPC request for the renderer
process lifetime requires the same per-launch token: apply uses an authenticated
config wrapper, pattern/blank use authenticated inner payloads, and shutdown
accepts only the token. Before release, every pattern and `blank(false)` request
is additionally rejected. Node removes the environment copy but retains one
in-memory control copy after release; a retained safety lock disables only the
one-way release method so authenticated `blank(true)` can still be reinforced.
This prevents a tokenless local pipe client from preloading or replacing
content, clearing sticky black, or stopping the renderer, but a failed
GPU/cable/projector can still hold or generate light.

## Correction assets

The runtime accepts headerless little-endian float data so calibration can
write deterministic GPU assets without relying on image color management:

| Asset | Format | Meaning |
| --- | --- | --- |
| blend map | `r32_float` | authoritative physical-pixel light weight, 0..1 |
| black map | `r32_float` | scalar direct additive linear-light correction |
| black map | `rgba32_float` | per-channel direct additive linear-light correction; A ignored |
| mask | `r32_float` | scalar final opacity, 0..1 |
| LUT | `rgba32_float` | R-fastest 3D lattice; RGB used |

If a configured asset is missing or has the wrong byte size, output creation
fails and remains black. Relative paths resolve against the renderer config.
Each individual raw asset is capped at 256 MiB before allocation; use a lower
spatial calibration resolution for unusually large projector rasters.

Without an authoritative blend map, matched opposing overlap edges use a
midpoint-symmetric normalized power curve in linear light. Equal overlap,
feather and gamma settings therefore sum to one across the pair; camera-created
blend maps remain the preferred path for unequal optics or non-planar surfaces.

Black-map samples are **direct additive corrections in linear-light units**,
not blend-weight multipliers. They are added at every mapped pixel before the
RGB/gamma/LUT stage. When black correction is enabled without a map, `lift` is
used as a uniform additive correction. When a map is present it is authoritative
and `lift` is not multiplied into it.

This is black-level *uniformity compensation*: software can raise selected
pixels so overlap and non-overlap floors match, but it cannot emit negative
light or lower an LCD projector below its physical black floor. A digital-zero
mask removes image signal outside the mapped surface; it does not optically
shutter leaked LCD light.

Manual Web masks do not require an asset file. An enabled normalized polygon
`path` is filled with the even-odd rule and rasterized deterministically to an
R32 texture capped at 2048x2048; `softness` uses a bounded two-pass distance
field. If both `map` and `path` are supplied, the calibrated map is authoritative.
Blend edges, black maps, masks, and test-pattern cells are evaluated in
post-warp physical projector coordinates (`SV_Position/outputSize`). Only the
master-canvas crop samples the mesh's interpolated source `{u,v}` coordinates;
moving a warp point therefore cannot drag a measured correction map with it.

`processing.bypass=true` is a measured A/B switch. It retains the selected
master-canvas area and active warp mesh, but skips blend, black correction,
gain/offset/gamma, LUT and mask. Telemetry reports both the configured bypass
and the effective bypass state. Bypassed correction assets are not opened, so a
stale disabled asset cannot prevent the raw crop/mesh recovery path from
starting; applying a revision with bypass off validates and loads them again.

## Deterministic calibration patterns

`set-pattern` supports raw solid linear RGB levels and MSB-first Gray code in
addition to black/white/gray/RGB/grid/identify presets. A targeted non-content
pattern isolates that projector and drives all other outputs to digital black.
Patterns bypass blend, black correction, color, LUT and mask by default so the
camera measures the projector rather than the previous calibration. They retain
the active mesh footprint and encode Gray/grid coordinates in post-warp physical
projector pixels; a controller that needs a full identity raster must first
apply an identity mesh revision. Sticky `blank` remains stronger than a pattern
and must be cleared for the selected target.

After a correction revision is renderer-acknowledged, a controller may request
one corrected linear solid with `applyCorrections:true`. That solid traverses
the normal warp, blend, black, RGB/gamma, LUT and mask stages and is intended
only for optical verification recapture. The field is boolean, defaults to
`false`, and is rejected for every non-solid mode. Output
`processing.bypass=true` remains authoritative and telemetry reports the
effective result; non-target outputs stay isolated with raw digital black.

Incoming `srgb` Spout samples use the exact sRGB transfer curve for decoding.
The final linear result is always transfer-encoded for the SDR G22/P709
swapchain, including when the incoming sender declares `linear`.

Warp control grids contain normalized `{u,v,x,y}` points and may be 2x2 through
128x128 cells. V1 rasterizes the supplied dense control grid as indexed
triangles. Folded or degenerate source/output triangles are rejected before
they can reach a projector. The `bicubic` metadata round-trips for the controller, but V1 does
not yet add spline subdivision between control points; use a denser grid where
curvature needs more sampling.

## Timing boundary

Flip-discard swapchains use a frame-latency waitable object and a maximum frame
latency of one. The render loop waits until every local output queue is ready,
then submits each output through the one immediate context; `Present(1, 0)`
locks each swapchain to its display vblank. This is deterministic local
scheduling, not genlock. A latency-handle failure or 100 ms timeout immediately
enters the same fail-closed recovery path as a Present/device fault rather than
terminating the renderer.
Projectors with different refresh rates, independent
GPUs, or multiple PCs can still scan out at different phases; overlap-critical
walls need identical modes and NVIDIA Sync/genlock-class hardware when the
installation requires frame-accurate scanout.

Telemetry keeps two timing domains separate. `presentSubmissions.accepted` is
only the number of calls accepted by DXGI; it is never labelled as a frame seen
on a monitor. `displayTiming` comes from the flip-model
[`IDXGISwapChain::GetFrameStatistics`](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgiswapchain-getframestatistics)
contract and publishes its `PresentCount`, `PresentRefreshCount`,
`SyncRefreshCount` and `SyncQPCTime`. Microsoft explicitly notes that
`PresentCount` need not equal the number of `Present` calls. `SyncQPCTime` is
the scheduler's approximate vblank-associated QPC value, not a measured photon
time or proof that two outputs have the same scanout phase.
Microsoft also warns that this API is unreliable in some multi-monitor and
other-fullscreen-app scenarios. Pixel Brightness therefore treats it as a
strict Windows telemetry gate that may fail unavailable; it does not promote
it to optical proof. The venue high-speed-camera phase check remains required.
[`IDXGISwapChainMedia::GetFrameStatisticsMedia`](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_3/nf-dxgi1_3-idxgiswapchainmedia-getframestatisticsmedia)
is not substituted here: the
Microsoft contract scopes that interface to custom present-duration/refresh
approval (principally integrated panels), while these outputs are fixed-rate
external projectors. The ordinary flip-model statistics API is Microsoft's
documented glitch-detection path for this queue.

Successive physical counter samples detect present IDs skipped before display,
refresh periods that held the previous image, and late intervals. The first
statistics query and a display-mode transition may return
`DXGI_ERROR_FRAME_STATISTICS_DISJOINT`; unavailable/disjoint/zero/stale samples
are reported as unavailable with nullable physical metrics rather than invented
zero faults. Occlusion is reported separately from failed submissions. A
currently occluded projector window also changes native state to
`display-occluded`, so Node readiness cannot remain true. A
bounded 500 ms telemetry refresh calls
[`DwmFlush`](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmflush)
before re-querying because Microsoft documents that Hardware Flip Queue can
otherwise defer statistics updates. `Test-PixelBrightness.ps1 -Full` requires
two fresh, advancing physical samples on every output and fails closed when the
statistics contract is unavailable.

Telemetry file persistence is isolated from the render/IPC thread. The render
loop publishes an immutable status object into a latest-only mailbox with a
capacity of one; it never creates directories, serializes the persistence
payload, opens/writes/flushes a file, or performs a write-through rename. If the
writer is busy, a newer sample coalesces the stale pending sample. A momentarily
busy handoff lock drops the producer sample instead of delaying Present or an
IPC reply. Serialized files are capped at 1 MiB.

The dedicated writer creates a uniquely named temporary file beside the target,
writes and flushes it, closes it, then uses same-directory
`MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`. A config
generation is checked before publish so an in-flight old target is normally
discarded after live reconfiguration. The writer requests Windows background
resource scheduling (falling back to below-normal thread priority) so JSON and
storage work do not inherit the renderer process's high-priority scheduling.
IPC status exposes
`telemetryPersistence`: writer health, in-flight/stall state, last completed and
successful sequence, success age, bounded error text, queue capacity, and
separate coalesced/contention/config/shutdown/oversize drop counters. These
process-lifetime counters and current-generation health fields are held
independently in memory. A persisted payload labels its status
as captured before that payload's write completed; it never recursively claims
that its own atomic replacement succeeded.

Shutdown discards the one optional pending sample. It gives an in-flight write
750 ms to return, then calls `CancelIoEx` and `CancelSynchronousIo`, waits a
further 750 ms cancellation grace, and always joins the owned thread—there is
no detached worker or use-after-free window. The join is deliberately still the
final ownership barrier: Windows must return a cancelled synchronous filesystem
call. Validate cancellation latency and temporary-file cleanup with real NTFS
disk-fault injection before production; a stalled storage driver cannot be
certified on macOS or by the portable mailbox test.

## Live configuration transaction

An authenticated `apply-config` builds replacement output windows, swapchains,
correction resources, Spout input and correction-binding evidence without
retiring the active revision. Each visible candidate must then accept an exact
black Present with `S_OK`; `DXGI_STATUS_OCCLUDED`, another successful status, a
failed HRESULT, or a removed D3D device rejects the request. The previous
outputs, renderer config and correction binding remain authoritative on that
failure. A device-removal result also enters the existing bounded black
recovery path before another IPC request can release the boot latch.

Telemetry configuration is the final throwing preparation step. The following
input/output/config/binding exchanges are statically required to be no-throw,
and only afterward is `outputsHealthy` set. Startup initializes that health gate
to false, so a failed first candidate exits without ever exposing a releasable
false-healthy Renderer.

## Display and device recovery

`WM_DISPLAYCHANGE` is delivered to every top-level output window and often
arrives in bursts. The renderer immediately submits black to every surviving
committed swapchain, marks physical timing unavailable, and waits for a 750 ms
quiet window after the final notification. Frame-latency, Present and detected
D3D device-removal failures enter recovery immediately without that debounce.
Normal content rendering is disabled for the complete recovery interval.

Each attempt constructs an independent DXGI factory, exact configured adapter
(or the startup-committed adapter LUID when the config omitted one),
D3D11 device, every output swapchain/correction resource, and a new exact-name
Spout receiver. Candidate windows have a black class background and receive an
explicit checked black present before commit; they never sample the Composition or a test pattern
during validation. Existing windows remain alive as black covers. Only after
the whole candidate succeeds are outputs, D3D and Spout exchanged in one
main-loop transaction, followed by the new correction-binding fingerprint.
Blank and calibration-pattern overrides are restored by output ID. Configured
device path, GDI name and adapter-LUID/target-ID fields remain simultaneous
assertions; a missing, ambiguous or conflicting target is never replaced by a
different active display.

Retries use 250, 500, 1000, 2000 and then at most 4000 ms delays, with a hard
limit of 10 attempts per generation. Exhaustion leaves the process responsive
to IPC but latched in `display-recovery-exhausted` with best-effort digital
black; a later `WM_DISPLAYCHANGE` (such as reconnecting the projector) starts a
new bounded generation. Telemetry exposes phase, trigger, generation, attempt
count, next retry, exhaustion and D3D recreation evidence. Async IPC events
announce start, each attempt, scheduled retry/exhaustion, and success.

This is recovery and software fail-closed behavior, not an optical guarantee.
The required `Present()==S_OK` proves only that DXGI accepted the candidate
black submission; it does not prove that a photon-level black frame reached the
projector.
If the device/driver cannot execute a black Present, or the cable/projector
holds the last frame, software cannot force darkness. Use the external watchdog
and shutter/signal-switch design described above where that failure matters.

## Current production checks

Before calling a node verified: run 8+ hours at show resolution, hot-plug each
adapter once, restart Arena, remove/recreate a Spout sender, force a GPU driver
reset test, verify all missing-signal paths remain black, and photograph the
32-pixel grid plus black/white/RGB calibration sequence on every output.
Also compile and run the native CTest targets with the production MSVC/Windows
SDK, test telemetry replacement on the deployed NTFS ACL, inject access-denied,
disk-full, read-only, slow/hung-write and power-loss faults, and measure the
750 ms shutdown-cancel boundary. The cross-platform latest-mailbox test proves
only the bounded handoff/coalescing and close/wakeup policy.
Also run the listener fault-injection CTest on the production Windows build:
it injects creation, connection-state allocation, and connect-event failures,
checks transient recovery, then exhausts the shared budget and checks bounded
backoff/fatal shutdown. Finally repeat those faults against the installed Show
supervisor and real projectors to verify exit code 70 restarts the whole stack
and that the hardware actually shows black. The platform-neutral policy test
and macOS static audit cannot certify Win32 handle cancellation or photons.
The same Windows harness connects a silent client and a partial-frame client,
verifies their terminal timeouts and connection release, then proves a legitimate
same-account client can reconnect, receive an event and terminal result, and
reconnect again through the explicit ACL. Its final reconnect deliberately delays
the reader while draining a multi-buffer result. These Win32 timing, ACL, and delivery
checks remain a physical Windows/MSVC gate; the portable source audit cannot
certify them.
Run `pbwin-boot-black-lock-contract` as part of the same MSVC/CTest build, then
power-cycle with each retained safety-lock fixture and photograph every output
from renderer process creation through Node exit/restart. The portable latch
test proves only authorization/state-transition logic, not Windows environment
isolation, named-pipe delivery, DXGI scanout, or optical black.
