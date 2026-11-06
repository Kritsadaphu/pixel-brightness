# Windows geometric Blend and receiver routing patch — 2026-09-07

This extends the local development preview. It is not a production Auto signoff.
No physical receiver subscription, Arena process, composition, projector power,
or production release pointer was changed during deployment/testing.

## Geometric Blend

The USB Geometry panel can now request `autoBlend: true` alongside the explicit
camera target rectangle. It requires every enabled output, one physical surface,
and no processing bypass. Source viewports determine overlap in a shared canvas;
the generated per-output weights form a partition of unity. They are rasterized
through the same triangle topology as the native Warp into physical output
coordinates. This is geometry-normalized blending, **not** measured photometry.

Each full-resolution float map is digest-bound to the candidate. Apply verifies
all files before the revision-bound project commit and backs up old settings.
Warp and Blend are changed together; black lift, LUT, color, masks, and viewports
remain unchanged. Restore only succeeds if no newer project edit would be lost.
Five outputs are supported within a 44,236,800-pixel budget. Generation yields
between work chunks and honors cancellation. No candidate is advertised as
finished while its final job record is still being written.

Test evidence: a real Windows GPU/NDI integration generated five 64×64 maps with
equal 0.2 contributions. The five decoded white-input RGB8 means were each
123.3333, consistent with the linear weight being transfer-encoded by the native
pipeline. All 21 selected Windows tests passed, including the other map slots,
source loss, blank, geometric application and mock receiver routing. This is not
a full-resolution throughput test or evidence from five physical projectors.

Final local regression at the project's configured concurrency of four:
577 tests, 572 passed, five platform/integration skips, zero failures. Windows
post-fix controller/routing/startup tests: 18 passed, one non-Windows test skipped;
TypeScript checking passed. The regression run exposed and fixed a race where
`finishedAt` was visible before the final job-file write released acquisition
ownership. The UI now reports finalizing until that write completes.

## Receiver routing

Opt-in `autoRoute: true` journals the exact previous selection before any device
write, selects each generated pattern source, checks API readback and NDI
connections, and restores after success/failure/cancellation. An interrupted
process leaves a persistent recovery journal. The Control page can request
`/v1/calibrations/uvc-geometry/restore-routing` with the exact pending job ID after
restart. A changed operator selection is never overwritten by automatic recovery.
Uncertain timed-out writes remain marked recovery-required, even after an
apparently successful restore. This verifies selection, not physical scanout.
A corrupt routing journal blocks new routing but does not crash the Web/API.

Supported explicit API adapters:

- `magewell-ip-v1`: [IP decoder source list](https://www.magewell.com/api-docs/pro-convert-ip-decoder-api/latest/source/list-source.html)
  and [select source](https://www.magewell.com/api-docs/pro-convert-ip-decoder-api/latest/source/select-source.html).
  Simple Mode only; advanced profiles are not switched or reconfigured.
- `magewell-classic`: [get-channel](https://www.magewell.com/api-docs/pro-convert-decoder-api/source/get-channel.html)
  and [set-channel](https://www.magewell.com/api-docs/pro-convert-decoder-api/source/set-channel.html).
- `kiloview-v1`: [current decoder status/set](https://www.kiloview.com/en/docs/ndi-device-http-apiversion-1-0/current-decoding-output/).

Configuration is server-local. Use `config/ndi-receivers.example.json` as a
template, replacing output IDs with the exact saved IDs and device usernames.
Do not assume display numbers or names are project output IDs. The preview reads
`preview-data/ndi-receivers.json` if present; the normal server accepts
`PB_NDI_RECEIVER_PROFILES_FILE`. The example is not installed as an active profile.

Credentials are referenced by environment-variable name, never included in the
project, browser response, source ZIP or routing journal. `username` + `passwordEnv`
enable lazy login and session refresh. The Magewell IP adapter uses the
[current login API's SHA-256 password field](https://www.magewell.com/api-docs/pro-convert-ip-decoder-api/latest/base/en/user/login.html),
so verify compatible firmware; no alternate-hash guessing is attempted. Kiloview
uses [authorization with session/token headers](https://www.kiloview.com/en/docs/ndi-device-http-apiversion-1-0/security-rules/).
Alternatively use `cookieEnv` for Magewell or `sessionEnv`/`tokenEnv` for Kiloview.
Do not combine password login and explicit session headers. No failed mutation
is automatically retried.

Read-only commissioning checks on the actual LAN found `.34` returns HTTP 401
`NotLoggedIn` at the IP decoder API; its classic `/mwapi` returned 404. `.31`
returned an authentication failure at the Kiloview current-status API. No device
credentials were supplied for these adapters, so live switching is unverified
and remains disabled until profiles/credentials are configured. These are the
NDI boxes, not the Panasonic projector login.

## Still outstanding

- R50 UVC enumeration/capture and physical before/after verification.
- Automatic measured black-level and color/brightness response from USB video:
  **not implemented by this patch**. Encoded UVC pixels are not relabeled as
  linear RAW evidence or fed to the strict measured solver as if they were.
- Live receiver switching/restoration with valid device credentials.
- Full-resolution, five-projector, sustained-throughput acceptance and release
  promotion/turnkey installer qualification.

The preview startup wrapper now limits consecutive quick failures, restoring
its retry allowance after a five-minute run. It still never launches Arena,
starts output, changes routing or powers projectors merely because Windows boots.
