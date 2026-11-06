# Renderer named-pipe contract (schema version 1)

Transport is one UTF-8 JSON object followed by `\n` (NDJSON) over the byte-mode
duplex named pipe `\\.\pipe\pixel-brightness-renderer-<nodeId>`. A line may not
exceed 67,108,864 bytes. A measured worst-case configuration with all 32
outputs carrying dense 128×128-cell meshes plus calibration assets is about
38 MiB; the remaining headroom is deliberate. Incoming queued wire data is
separately capped at 128 MiB. Outgoing results/events use a dedicated writer
thread and are capped at 32 messages and 128 MiB total.
The renderer accepts one controller and exactly one non-empty request record per
connection. The controller opens a fresh connection for each request. It has
five seconds after connect to send the first bytes; once a partial record exists,
each read must make progress within the two-second framing-idle deadline. Blank
lines do not satisfy the first-message deadline. Silence returns
`FIRST_MESSAGE_TIMEOUT`; an incomplete record returns `FRAMING_TIMEOUT`. Both
are terminal error envelopes with an empty request ID because no trusted frame
exists, and the connection is then released. Invalid UTF-8/JSON,
oversized messages, unknown commands, or wrong schema versions return an error
and never mutate renderer state. A result or error is terminal for that
connection: events already queued ahead of it retain FIFO order, the dedicated
writer completes the terminal write, then gives the controller 500 ms to read
the envelope and close its end before forcing release. This bounded client-close
phase avoids discarding a prompt reader's buffered result while still allowing
the next legitimate controller to connect when a client stops reading. The controller must continuously
drain results and events. The render thread only enqueues a response and never
performs pipe I/O. Every queued message has a two-second absolute write deadline; queue
overflow, deadline expiry, or a client that stops reading disconnects that
connection without stopping render/present cadence. Responses retain the
connection generation of their request and are never delivered to a later
client after reconnect. A disconnected controller must treat its unreceived
acknowledgements as unknown and reconcile with fresh `get-status` telemetry.

`CreateNamedPipeW` uses a protected DACL granting pipe access only to the
Renderer/Node launch account and LocalSystem, in addition to
`PIPE_REJECT_REMOTE_CLIENTS`. Failure to construct that descriptor enters the
same bounded listener-recovery path; the renderer never falls back to a default
DACL. This narrows which local processes can occupy the pipe but does not replace
the lifetime authorization token required by every mutating request.

Listener-setup failures are not allowed to silently terminate the reader
thread. Pipe creation, connection-state abort/terminal-event allocation, and OVERLAPPED
connect setup failures use stop-aware exponential retry (50 ms initially,
1000 ms maximum) with a hard bound of eight consecutive failures. A successful
controller connection resets the bound. The top-level `ipcListener` telemetry
contains state, health/degraded/fatal flags, consecutive and lifetime counts,
next delay, last setup stage, Win32 error, and bounded detail. During a retry
the top-level renderer state is `ipc-listener-degraded`. At exhaustion the
renderer presents and flushes black, updates `ipc-listener-fatal` telemetry
with one bounded best-effort persistence wait, and exits with code 70 for the
Show supervisor; it never continues indefinitely with stale content and no
command/safety channel.

Request envelope:

```json
{"schemaVersion":1,"requestId":"req-42","type":"get-status","payload":{}}
```

Success/error envelopes:

```json
{"schemaVersion":1,"requestId":"req-42","type":"result","ok":true,"payload":{}}
{"schemaVersion":1,"requestId":"req-42","type":"error","ok":false,"error":{"code":"COMMAND_FAILED","message":"compositionSource.senderName is required"}}
```

Supported request types:

- `hello`: returns version, node ID, protocol version, and capabilities. The
  advertised `compositionValidation.frameRate` values are the exact native
  settling/tolerance policy; `hardwareBlackGuarantee:false` distinguishes the
  software fail-closed path from an optical shutter or signal watchdog.
- `get-status`: returns the telemetry snapshot. `compositionSource` includes
  `expectedFps`, `senderFps`, `frameRateDelta`, and `frameRateValidated`; the
  latter becomes true when the 30-new-frame settling window has elapsed.
  `activeCorrectionBinding` is the committed native evidence: a SHA-256 of the
  exact normalized active config plus per-output SHA-256 digests for the
  generated GPU warp mesh and the loaded/generated blend, black, mask and LUT
  resources. The artifact digests are computed from the same byte buffers
  uploaded to D3D, not from asset paths or the controller plan.
  The status payload uses telemetry schema version 2. Every output has separate
  `presentSubmissions` and `displayTiming` objects: accepted DXGI calls are not
  evidence that an image reached a monitor. `displayTiming` is sourced from
  `IDXGISwapChain::GetFrameStatistics` and includes availability/status,
  `PresentCount`, `PresentRefreshCount`, `SyncRefreshCount`, `SyncQPCTime`,
  sample age/sequence, occlusion, disjoint count, skipped-present IDs, repeated
  refreshes and late intervals. Current physical counters and fault metrics are
  JSON `null` when DXGI cannot provide fresh evidence; clients must not replace
  unknown values with zero. `phaseProof:false` and
  `multiMonitorReliability:"platform-dependent"` preserve Microsoft's stated
  multi-monitor limitation and prevent these counters from being presented as
  optical/genlock evidence. Top-level `recovery` reports `active`, `phase`,
  `trigger`, generation/attempt counts, bounded next-retry delay, exhaustion,
  D3D recreation evidence, trigger detail and the last attempt error. During recovery `state` is
  `display-recovering` or `display-recovery-exhausted`, so a controller must
  revoke readiness even though the pipe remains connected.
  Top-level `ipcListener` independently reports listener setup/recovery health.
  `degraded:true` or `fatal:true` is never show-ready; on a fatal listener the
  pipe itself may no longer be reachable, so the same terminal snapshot is
  also offered to configured telemetry-file persistence.
  `bootBlackLocked:true` is an independent process-start barrier and makes the
  renderer non-ready even if output-level blank state is false. Its transition
  counter starts at zero and can become exactly one only through the
  authenticated release command below.
  Top-level `telemetryPersistence` is independent in-memory writer state. It
  reports latest-only queue capacity/depth, in-flight and stall state, completed
  and successful sequence/age, bounded last error, and categorized drops. A
  file payload's `statusCaptured:"before-this-write-completed"` and
  `completedThroughSequence` describe only previously completed work; the file
  never claims that the atomic replacement carrying its own status succeeded.
- `release-boot-black`: the only command that can release the renderer's
  process-start black latch. Payload is
  `{ "authorizationToken":"<43-128 base64url characters>" }`. The launcher
  creates a fresh 256-bit token for each Show process pair, passes it only in
  the child environment, and Renderer retains only its SHA-256 digest. Node
  may send this command once, after strict durable-state hydration, fresh
  `cache.ensureAll` hash/download verification of every current project cue
  (including while transport is idle), renderer prepare, and a durable
  prepared-state commit. It must then complete an authenticated Server
  registration, validate the Server's durable acknowledgement and latest
  command cursors against local `lastSequence`, apply the authoritative
  output-scoped project, and repeat required cue/transport reconciliation.
  A stale locally scoped cue that returns 403 keeps the latch closed until this
  authoritative snapshot removes or replaces it; Node never retries it with a
  broader asset grant. Missing cursor proof, local state behind the Server's
  durable acknowledgement, a Server cursor behind local durable state, or a
  truncated command history creates a durable state-recovery lock rather than
  resetting/skipping `lastSequence`. Release is permitted only when no state-recovery, safety-command, or
  optical-verification fail-closed lock is active. Persisted READY/playing/
  paused/scheduled labels and a persisted asset SHA are never cache proof. If
  one of those locks is retained, Node permanently destroys its local
  *release authority* while retaining the credential only to authenticate
  repeated black enforcement. The release method checks that independent
  one-way flag before it can send IPC, so that process cannot authorize a
  later release. A wrong token, degraded renderer, ordinary `blank(false)`,
  pattern command, or config apply cannot release the latch. Success returns
  `bootBlackLocked:false` and `bootBlackReleaseCount:1`; Node must reconcile
  both with a fresh `get-status` before declaring the renderer ready.
- `apply-config`: every request, before or after boot release, uses
  `{ "authorizationToken":"<process token>", "config":{...} }`; `config` is
  the complete renderer configuration with one shared
  top-level `compositionSource` and per-output crop/mesh/correction data. Its `revision`
  must be newer than the active revision. Application is all-or-black: outputs
  and correction resources are validated/rebuilt before the new revision is
  acknowledged. A successful result includes `activeCorrectionBinding`; a
  controller computes SHA-256 over the key-sorted, whitespace-free JSON of the
  exact normalized `config` object it sent and requires
  `activeCorrectionBinding.configSha256` to equal that digest before accepting
  the receipt. Native computes the same digest from the received JSON before
  narrowing floats or resolving paths. The complete binding must then match
  the next fresh `get-status` response. A self-consistent response/status pair
  for a different config is therefore not a valid acknowledgement.
  Failed apply or topology rebuild paths retain the previous committed binding.
  Live apply treats candidate construction as a transaction: every candidate
  swapchain must return exactly `S_OK` from a checked black Present and the D3D
  device-removal check must also succeed before any previous committed surface,
  config, or correction binding is retired. `DXGI_STATUS_OCCLUDED` is therefore
  an apply error even though it is a non-failing HRESULT. An error preserves the
  previous committed outputs/config/binding and returns `COMMAND_FAILED`; an
  initial candidate failure never marks renderer outputs healthy and cannot
  satisfy `release-boot-black`.
  `apply-config` is rejected while display recovery is active; changing a
  physical selector requires an explicit reviewed restart rather than racing
  the exact-target recovery transaction. Renderer verifies the credential
  without changing the latch. Requiring it for the renderer process lifetime
  prevents an unauthenticated local client from preloading a different config
  before release or replacing the active config afterward.
- `set-pattern`: the fixed presets use
  `{ "authorizationToken":"<process token>", "pattern":{
  "mode":"content|black|white|gray|red|green|blue|grid|identify",
  "cellSize":32, "outputId":"optional" } }`.
  Measured calibration levels use linear RGB
  `{ "mode":"solid", "rgb":[0.0039,0.0039,0.0039], "outputId":"A" }`.
  A post-apply optical verification frame is the same bounded solid command
  with the explicit boolean `{ "applyCorrections":true }`. Only `solid`
  accepts that field; its omission (or `false`) preserves raw measurement.
  Supplying `applyCorrections` to content, presets, identify/grid, or Gray code
  is rejected without changing renderer state. The renderer must advertise
  `hello.patterns.applyCorrectionsModes:["solid"]` before a controller uses it.
  Structured light uses bit zero as the most-significant Gray-code bit:
  `{ "mode":"gray-code", "axis":"x|y", "bit":0, "inverse":false, "outputId":"A" }`.
  A targeted non-content pattern automatically drives every other output to
  raw digital black. Non-content patterns normally bypass blend, black
  correction, RGB/gamma, LUT and final mask, while retaining the active mesh
  footprint; their coordinates are physical output pixels. An explicitly
  corrected solid instead traverses that output's normal warp, blend, black,
  RGB/gamma, LUT and mask stack. Per-output telemetry echoes
  `patternParameters.applyCorrections` and reports the effective
  `correctionsBypassed`, including an output-level `processing.bypass` override.
  `hello.patterns` advertises these invariants for calibration preflight.
  Every pattern request also requires the lifetime credential and is rejected
  while boot black is locked, so no future white/calibration frame can be
  preloaded before authenticated release.
- `blank`: `{ "authorizationToken":"<process token>", "blank":{
  "enabled":true, "outputId":"optional" } }`. Blank overrides both
  content and patterns and is sticky until explicitly cleared, including across
  a successful config or display-topology rebuild for surviving output IDs. A
  global blank also becomes the safe default for outputs added by a later config.
  Clearing ordinary blank never clears the independent boot-black latch;
  `blank(false)` is rejected while that latch is locked. Both true and false
  require lifetime authentication; authenticated `blank(true)` remains
  available as an additional fail-closed action.
- `shutdown`: `{ "authorizationToken":"<process token>" }`; after successful
  lifetime authentication it exits cleanly after blacking all swapchains.

Only `hello` and `get-status` are unauthenticated/read-only. Renderer retains
only the token's SHA-256 digest. Node removes the inherited environment entry
and keeps its sole plaintext copy inside the renderer bridge for the paired
process lifetime; it is never serialized to config, state, telemetry, or logs.
This is an incompatible mutation-envelope change: older controllers that send
raw `apply-config`, `set-pattern`, `blank`, or `shutdown` payloads receive
`COMMAND_FAILED` and cannot control this renderer build.

An asynchronous event uses `type:"event"`, `requestId:null`, and a payload with
an `event` field. Controllers must tolerate future event fields and commands
but must not silently downgrade `schemaVersion`. Display recovery emits
`display-recovery-started`, `display-recovery-attempt`,
`display-recovery-retry-scheduled` (or `display-recovery-exhausted` at the hard
attempt bound), and `display-recovery-succeeded`. The success event carries the
committed correction fingerprint; controllers must still reconcile it with a
fresh `get-status` response rather than treating the event as an acknowledgement
of an unrelated request.
