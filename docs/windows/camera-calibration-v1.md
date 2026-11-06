# Windows camera auto-calibration contract

The repository has an executable orchestration contract, not a camera button or
a UI mock. The plan and manifest schema is V2; the stable filename is retained
for existing links, and individual artifact encodings such as
`pb-warp-mesh-v1` keep their own version. The measured capture plan is two-pass
so geometry and low-light radiometry are not inferred from one compromised
exposure. Its implementation is split into:

- [`runtime/shared/camera-calibration.mjs`](../../runtime/shared/camera-calibration.mjs):
  normalized plan, manual-camera lock, state machine and artifact manifest;
- [`runtime/node/camera-calibration.mjs`](../../runtime/node/camera-calibration.mjs):
  camera/pattern adapter boundaries, fail-closed orchestrator, the production
  measured solver and deterministic simulation used in automated tests.

The orchestration is exposed through a real Server → Node command path:

- `POST /v1/calibrations/camera` queues one session on the Windows node that
  owns the selected outputs;
- `GET /v1/calibrations/camera/latest` and
  `GET /v1/calibrations/camera/{sessionId}` return durable state and progress;
- `POST /v1/calibrations/camera/{sessionId}/cancel` aborts capture and invokes
  the fail-closed pattern path;
- `POST /v1/calibrations/camera/{sessionId}/confirm` accepts one explicit,
  current operator confirmation using its exact `stepId` and `confirmationId`.

The Web Control uses these routes directly. There is no success placeholder.
`mode: "measured"` is the production default. An unavailable production camera
adapter must fail before projector takeover. `mode: "simulation"` is an
explicit automated-test/dry-run path; its manifest is marked non-applicable and
can never update projector output.

## Signal ownership

During calibration, Pixel Brightness exclusively owns every projector output.
Arena remains the show player but its master Composition is blanked and never
generates calibration frames:

```text
Arena PB-COMPOSITION ── blanked
                              Pixel Brightness pattern override
Camera capture <── wall <── A: calibration frame; every other output: black
Camera capture <── wall <── B: calibration frame; every other output: black
                              ...
valid manifest ── restore Arena Composition
failure after takeover ── remain black
```

The pattern adapter must resolve `showStep()` only after the requested frame has
been presented exclusively for `settleFrames`. A camera frame cannot be
accepted merely because a command was queued.

## State machine

The valid success path is:

```text
idle
  → detecting-camera
  → camera-detected
  → locking-camera
  → camera-locked
  → blanking-master
  → capturing (strict plan order)
  → solving
  → validating
  → restoring-content
  → complete
```

An out-of-order step, missing capability, unlocked setting, invalid manifest,
capture fault or solver fault transitions to `failed`. After the pattern
override begins, failure invokes `failClosed()` and leaves every output black.
`complete` means that capture, solve, manifest validation and content restore
finished. It does **not** by itself mean that the project was committed, the
renderer acknowledged the revision, or an optical verification capture passed.

## Commit, renderer and optical truth

The Server reports the following independent facts. The Web Control must not
collapse them into one green "complete" state:

1. `projectCommitted: true` — the Server atomically committed the measured
   project revision;
2. `rendererAcknowledged: true` and `rendererAcknowledgedAt` — the owning
   Windows renderer reported that exact committed revision;
3. `opticalVerification.state: "verified"` — a post-apply camera recapture met
   the defined residual gates.

`opticalVerification.state` progresses through `pending-apply`,
`pending-renderer-ack`, `pending-optical-capture`, `queued`, `preflight`,
`waiting-operator`, `capturing` and `evaluating`. Simulation is always
`not-applicable`. Only the deterministic terminal state `verified` is a pass.
`blocked`, `cancelled`, `superseded`, `failed`, `rolling-back`,
`rollback-renderer-ack`, `rolled-back` and `rollback-blocked` are never displayed
as pending success. Until the state is explicitly `verified`, the UI does not
claim optical verification even when the original capture session state is
`complete`.

After the renderer acknowledges the applied revision, the operator starts the
separate recapture with:

```text
POST /v1/calibrations/camera/{sessionId}/verification
```

Physical-condition prompts use the same explicit safety principle as the
calibration references, but remain bound to the verification ID, random lease,
current step, node and applied revision:

```text
POST /v1/calibrations/camera/{sessionId}/verification/confirm
{ "confirmed": true, "stepId": "...", "confirmationId": "..." }
```

The Web Control does not auto-confirm these prompts. Cancellation is a separate
`POST .../verification/cancel` request and is not a pass. Once the calibrated
revision owns the outputs, cancellation keeps the renderer sticky-black; it
cannot restore that unverified revision's content directly.

If a conclusive optical report fails any gate, or an acknowledged authoritative
Server command cancels the verification, the Server restores the exact
pre-apply output snapshot as `appliedRevision + 1`. Rollback evidence records
the immutable trigger (`failed` or `cancelled`); cancellation cannot invent a
failed gate report. This is a new monotonic project revision, not a revision
rewind. The lifecycle does not finish at the database write: it waits for both
Node and native renderer telemetry to report the exact rollback revision,
queues an explicit content-restore command, and requires that command
acknowledgement plus the Node's strict `rolled-back` evidence. A concurrent
project edit, absent snapshot or mismatched revision becomes `rollback-blocked`
and requires operator intervention.

## Camera detect and physical preflight

Calibration requires all four capabilities:

- manual exposure;
- manual Kelvin white balance;
- manual focus;
- linear RGB capture.

The adapter must read back and confirm these locked values before projection:

- exposure mode;
- ISO;
- aperture;
- shutter time;
- white-balance mode and Kelvin value;
- focus mode;
- RAW bit depth and still-capture format;
- shutter mode and disabled automatic processing where the camera API exposes
  those values.

The Sony A7 IV production profile is 14-bit lossless-compressed or uncompressed
RAW, ISO 100, f/5.6, manual focus, fixed 16 mm focal length, fixed 5600 K white
balance and mechanical or EFCS single-shot capture. Auto ISO, autofocus,
electronic silent shutter, HDR/exposure fusion, long-exposure NR, high-ISO NR,
IBIS/OSS and in-camera lens correction remain off. The lens, zoom, focus,
aperture, camera pose and tripod must not move between passes.

The default short profile starts at 1/60 second. The default long profile starts
at 1 second. They are starting points, not permission to clip: the geometry
white frame should land at 60–75% of RAW full scale with no clipped channel. An
adapter may report that a requested value or prerequisite cannot be applied;
the orchestrator then fails before taking pattern ownership.

## Exposure profiles and repeat policy

The request uses explicit exposure profiles:

```json
{
  "exposureProfiles": [
    {
      "id": "geometry-short",
      "role": "geometry",
      "normalizationScale": 1,
      "settings": { "iso": 100, "apertureF": 5.6, "shutterUs": 16667 }
    },
    {
      "id": "radiometry-long",
      "role": "radiometry",
      "normalizationScale": 60,
      "settings": { "iso": 100, "apertureF": 5.6, "shutterUs": 1000000 }
    }
  ],
  "repeatPolicy": {
    "geometry": 1,
    "radiometry": 5,
    "nearBlack": 16,
    "references": 16
  }
}
```

Both settings objects also carry manual exposure mode, fixed Kelvin white
balance, manual focus and linear-RAW capture intent. `normalizationScale` is the
nominal expected exposure ratio `E / E_geometry`; it is not a brightness slider
and the UI must not invite an operator to guess it. Paired optical bridge
captures measure the actual ratio, uncertainty and clipping, then fail closed
when they contradict the nominal declaration. The solver subtracts the matching
sensor-dark reference before normalizing a long exposure to the geometry
profile.

Each capture step records `passId`, `exposureProfileId`, its immutable exposure
snapshot, `referenceKind`, repeat count and capture conditions. Reference and
near-black repeats are bounded to 32.

## Two-pass per-output capture plan

All other projectors remain black while one output runs a deterministic plan.
The short geometry pass captures white plus normal/inverse Gray-code pairs for
every X and Y bit, then gates correspondence, footprint, warp, overlap, blend,
mask and confidence. A geometry pass can succeed while radiometry fails; the UI
must keep those results distinct.

The reference and radiometry sequence captures:

1. sensor dark at both exposure profiles while one confirmation lease keeps the
   lens physically blocked;
2. one global projectors-off ambient reference;
3. one global all-projector digital-black reference;
4. per-output paired, unsaturated exposure-bridge gray captures in both profiles;
5. near-black at 1/255, 4/255 and 16/255;
6. neutral tone samples at 18%, 50% and 75%;
7. full and low-level red, green and blue primary samples.

The shared gray reference connects the two exposure scales. It does not turn a
processed or clipped frame into a linear measurement.

Three physical reference states are explicit. None can be silently inferred
from a queued pattern command. Projector black also needs an operator because
software cannot prove that the projector emitters are powered, warmed and
optically unblocked:

| `referenceKind` | Required physical condition |
| --- | --- |
| `sensor-dark` | Operator confirms once: opaque lens cap fitted; camera and cable remain fixed; both exposure-profile references reuse that exact confirmation lease |
| `projectors-off-ambient` | Operator confirms: lens cap removed; projector optical output off; intended room lighting unchanged |
| `projector-black` | Operator confirms: lens cap removed; projectors warmed, powered and optically unblocked; every output at digital black; ambient unchanged |

The plan step exposes `captureConditions.requiresOperatorConfirmation` and
`captureConditions.operatorPrompt`. While the Node is paused, the Server exposes
a top-level `operatorPrompt` with state `waiting`, the exact `stepId`, a random
`confirmationId`, its `confirmationLeaseId`, title, instructions and requested conditions. The Web Control
does not auto-confirm: an operator presses the confirmation button, which POSTs
those two IDs and `confirmed: true`. The Server rejects stale or replayed IDs,
changes the prompt to `confirmation-queued`, and the Node resumes only after it
accepts that matching command. Contiguous steps may reuse only the same planned
lease and must retain the same confirmation ID in capture provenance; another
physical state requires a fresh ID. Cancellation and the 15-minute timeout
remain fail-closed.

The Server durably retains the exact command ID, sequence, step, lease,
confirmation ID and confirmation time for every physical-condition click. An
applicable terminal manifest is rejected unless its RAW capture provenance
matches that history one-for-one and the Node has acknowledged the highest
confirmation-command sequence. Every RAW `capturedAt` must be at or after its
condition `verifiedAt`; pre-confirmation frames cannot be relabelled and reused.
The terminal Node report is also hash-bound: an identical retry after a lost
HTTP response is idempotent, while any changed state, progress, camera,
timestamp, manifest or project patch is rejected.

The plan starts and ends with an all-output safety-black frame. Resolution
determines the number of Gray-code bits. Every step has a stable ID, sequence,
pass, exposure snapshot, isolation policy, repeat count and settle-frame
requirement. At the Web Control's conservative planning estimate, geometry is
about 3–6 minutes per output and radiometry about 8–15 minutes per output;
camera transfer speed, exposure length and confirmation time determine the real
duration. Progress is computed from acknowledged steps, weighted by each
step's planned repeat count; a repeat in flight is not counted until that step
is acknowledged. It is never an animation or a wall-clock guess.

## Markerless planar-wall targeting

An immersive venue does not need permanent ChArUco sheets or fiducial markers
on every wall. ChArUco is used once, away from the venue if necessary, to build
a lens profile for the exact camera body, lens copy, retained RAW raster,
focal length, focus distance and aperture. At the venue the operator keeps the
camera fixed and clicks the intended planar-wall boundary in this order:
top-left, top-right, bottom-right, bottom-left.

The Web Control implements this as a gated sequence, not a free-form image
upload:

1. load the canonical Lens Profile JSON;
2. request `POST /v1/calibrations/camera/survey-previews` for the selected Node;
3. wait for the Node to take one lossless 14-bit RAW exposure with the exact
   profiled body, lens, focal length, focus, aperture and raster;
4. download the authenticated, `private, no-store` PNG artifact. The PNG is a
   lossless grayscale display transform of that same raster; it is not JPEG or
   Live View and has no crop, resize, lens correction or spatial interpolation;
5. click TL → TR → BR → BL and accept the boundary;
6. submit that survey and the complete Lens Profile with the measured
   calibration request.

The Browser fetches the artifact as an authenticated Blob before displaying
it. A direct `<img>` URL would omit the paired Bearer token on a remote control
computer and is not the supported path. Start remains disabled until the
Server/camera-bound preview and one accepted boundary for the selected wall
are both present. Recapturing the preview or changing the profile invalidates
the old boundary.

The request carries the complete `pixel-brightness.camera-lens-profile.v1`
payload and its canonical SHA-256, not a digest with unverifiable coefficients.
The profile is Brown–Conrady, calibrated by the declared ChArUco method, and is
accepted only while all of the following remain true:

- RMS reprojection residual is at most 0.5 pixel and maximum residual is at
  most 1.5 pixels;
- the calibration is no older than 730 days and does not fold or become
  singular anywhere in the retained raster;
- camera and lens model plus serial, raster, focal length, focus distance and
  f-number match physical capture provenance;
- focus and zoom are locked, stabilization is off, and every exposure pass
  retains the profiled aperture;
- the survey digest and frame exactly match the supplied profile.

The Server derives each projector's intended wall quadrilateral from the saved
project `sourceViewport`, including intentional overlap. The Node first
undistorts the four clicked RAW-frame corners, samples the planar homography as
the requested dense control grid, then redistorts every vertex into the raw
sensor coordinate system used by the Gray-code map. Applying one homography
directly to distorted 16 mm image coordinates is explicitly forbidden.

Every markerless manifest records survey, wall, fixed camera-view and profile
identity, target point count, correspondence confidence, holes, and median,
95th-percentile and maximum search distance. An applicable run requires zero
holes and passed distance/confidence gates. Changing only a camera or lens
serial therefore fails before artifacts are published.

One capture session represents one fixed camera pose. It may contain more than
one planar wall only when every wall is visible in the same retained RAW frame,
uses the same lens profile, and shares the same `cameraViewId`; this is the
bridge-observation case for a visible room corner. Moving the tripod creates a
new view and a separate member calibration. Until the room-bundle workflow has
atomically committed and reverified every member against one final project
revision and renderer correction fingerprint, the truthful status is
`cross-view-seams-unverified`, **not** room verified. A curved, faceted or
discontinuous surface requires a dense surveyed surface model and cannot use
the four-corner planar tool. Markers remain useful for generating or auditing
the reusable lens profile, but they are not required on the finished venue
wall.

## Artifact manifest

A complete output entry must contain all of the following:

| Artifact | Encoding | Purpose |
| --- | --- | --- |
| Dense warp | `pb-warp-mesh-v1` | Rows, columns, interpolation and exact point count |
| Blend weight | `r32_float` | Normalized overlap contribution |
| Black pedestal | `r32_float` | Additive lift toward the measured worst LCD black floor |
| Final mask | `r32_float` | Digital zero outside the observed illuminated footprint |
| Confidence | `r32_float` | Spatial Gray-code confidence |
| Gamma | Three finite channel values plus confidence | Long-pass neutral tone-response estimate |
| LUT | `rgba32_float` | Measured LUT or an explicitly labelled identity fallback |

Every binary/mesh artifact carries a URI, byte length and SHA-256. The manifest
also records the project revision, camera identity, locked settings, timestamps,
all capture IDs and provenance.

Simulation manifests are always:

```json
{ "provenance": "simulated", "applicable": false }
```

`assertCalibrationManifestApplicable()` rejects them. Only a validated
`measured` manifest explicitly marked applicable may update real outputs.

Before a measured patch is accepted, the owning Node reads each local artifact,
verifies its byte length and SHA-256, parses the complete warp mesh, and proposes
the exact final-renderer fields. The Server verifies that proposal against the
manifest and the unchanged project revision, then atomically writes:

- `warp.points` and dense mesh dimensions;
- `blend.map`;
- `blackUniformity.map` with scalar lift reset to zero;
- `mask.map`;
- measured RGB gamma and a status-labelled LUT artifact.

Only then does it increment and commit the project revision. Distribution and
renderer acknowledgement are later facts. A stale revision, wrong node,
changed output, missing local file or digest mismatch rejects the patch.

`MeasuredCalibrationSolver` is implemented independently of any camera vendor.
It decodes the captured Gray-code pairs, then scatters camera-space blend,
black, mask and confidence samples to their decoded physical projector-pixel
addresses. It does not resize the camera image into an output map. The complete
session is written below the Node data directory in a staging directory, every
file is SHA-256 labelled, and one same-volume directory rename publishes the
artifact set atomically. Dark-subtracted, exposure-normalized neutral tone
captures produce a gamma estimate with confidence. RGB-primary captures can
produce a 17³ `measured-relative` LUT whose declared basis is
`camera-relative-rgb`; it equalizes response as seen by this camera but is not
spectral or target-space colorimetry. Only a separately validated camera
characterization (profile digest, RGB→XYZ matrix, target space, date and ΔE
gate) may label a LUT `measured` and `colorimetric: true`. An identity or
camera-relative LUT must never be displayed as full colour calibration.

Black uniformity uses one combined optical baseline from the long pass. It
subtracts only the matching sensor-dark reference from the global
all-projector-black capture, then targets the **total observable black floor**:
ambient light plus projector leakage. The projectors-off ambient capture remains
an independent drift diagnostic and is not subtracted away; doing so would hide
real spatial room light that the additive shader cannot remove. The solver finds
one worst-black target over the union surface and distributes that single
calibrated optical correction across each projector's normalized blend weight.
Overlapping outputs therefore sum to one correction instead of each applying
the full lift.

## Capture and coverage safety limits

The orchestration performs a memory preflight before taking projector pattern
ownership. By default it retains at most 512 MiB for the complete session,
4,194,304 pixels per frame, and 4096 pixels per dimension. A camera adapter is
asked to produce bounded linear RGB. The Node immediately area-bins the frame;
geometry may retain luma, while radiometry retains RGB and bounded robust
statistics. A separate raw-frame ceiling covers the active adapter transfer and
the robust stack's peak working set. The plan is rejected before takeover when
the resulting per-frame budget cannot retain at least four camera samples per
requested mesh point.

Measured correction maps remain projector-resolution artifacts in the current contract. Before
any file is committed, the solver measures the decoded scatter coverage inside
the observed projector-coordinate bounds. The default apply gate requires at
least 85% pixel coverage and 98% occupied 64×64 coverage tiles. A sparse,
clustered or perforated result fails with
`CALIBRATION_MAP_COVERAGE_TOO_LOW`; zero-filled holes are never silently treated
as a successful correction map. After the raw gate passes, only the remaining
small holes inside the decoded projector-coordinate bounds are filled from the
nearest measured value; pixels outside those bounds stay at the fail-closed
zero value. A future streaming accumulator and bounded-map format can reduce
session memory without weakening this gate.

Without a markerless surface survey, the legacy geometry stage can still use
the observed illuminated projector footprint as a diagnostic target. That mode
does not infer the operator's intended wall, screen or architectural boundary.
The four-corner planar path supplies that intent explicitly and never claims
semantic wall detection.

Black-pedestal calibration makes LCD leakage more uniform by adding light to
darker regions. It cannot optically subtract the projector's native black.

## Production camera-adapter status

The configured production boundary is the process-isolated Sony A7 IV helper
described in [`sony-a7iv-camera-helper.md`](sony-a7iv-camera-helper.md). This
repository contains the bounded protocol, path/hash/RAW provenance checks and
timeout/kill behavior; it does not bundle Sony Camera Remote SDK or a licensed,
hardware-verified `PixelBrightnessCamera.exe`. Until that helper path is
installed, measured Sony capture intentionally reports unavailable.

The older `CanonR50WindowsCameraAdapter` remains an explicit stub with backend
name `canon-edsdk` and reports:

```text
CANON_EDSDK_ADAPTER_UNAVAILABLE
```

It returns no detected camera and its capture methods throw. Neither boundary
may claim production capture without the matching licensed helper and physical
acceptance. This repository
does not bundle Canon EDSDK, does not claim an EDSDK license, and does not claim
USB remote capture from an R50 yet. A supplied Windows adapter must implement detection,
open/close, manual-setting readback and linear capture behind the existing
boundary before a measured session can finish. The API remains useful now
because it reports this limitation as real session state instead of pretending
the camera is connected.

The A7 IV two-pass settings and Web Control are a capture contract, not proof
that Sony USB remote capture is installed. A production Sony adapter must still
detect the exact body, command and read back both profiles, prove 14-bit RAW and
the selected shutter mode, transfer every capture with stable sequence IDs, and
decode RAW into linear samples while retaining sensor black for the solver's
matched dark-reference subtraction. Telemetry may show "remote
capture ready" only after those checks; simple USB presence is insufficient.

The Server, Node and Web expose the guarded post-apply verification lifecycle.
That software path still cannot create physical proof without the licensed Sony
helper, an attached A7 IV, the exact 16 mm lens profile, controlled projector
conditions and real RAW captures. On development hardware it therefore remains
pending or fails closed; the Web Control never fabricates `verified` from a
renderer acknowledgement or simulation.

## Automated acceptance

[`tests/camera-calibration-contract.test.mjs`](../../tests/camera-calibration-contract.test.mjs)
verifies the canonical V2 exposure profiles and passes, immutable exposure
snapshots, matched dark references, physical-capture provenance, bounded robust
stacks, radiometric gates and fail-closed rejection of falsified evidence.

[`tests/camera-calibration-orchestration.test.mjs`](../../tests/camera-calibration-orchestration.test.mjs)
verifies deterministic plan order, strict state transitions, R50 unavailability,
manual-lock refusal, complete manifest contents and hashes, reproducible
simulated runs, non-applicability of simulated artifacts, and fail-to-black on
solver failure. It also runs the production measured solver against deterministic
linear captures, verifies its atomic on-disk artifact set and proves a shuffled
camera raster is scattered by decoded projector address rather than resized.

[`tests/camera-calibration-api.integration.test.mjs`](../../tests/camera-calibration-api.integration.test.mjs)
also starts the Server and a live Node, drives the HTTP command through to a
simulation result, proves that the project revision is unchanged, and then
proves that production Canon mode fails with the honest adapter error. Artifact
tests verify measured mapping and reject a tampered binary.

Every V2 orchestration or API fixture must explicitly answer the sensor-dark
and ambient prompts (by callback or the `/confirm` route). Omitting that action
is expected to fail closed at the first required reference, not finish a
simulation automatically.
