# Pixel Brightness Server V3

The server is the control plane. It stores one authoritative project, registers render nodes, distributes ordered commands, schedules transport commands against a nanosecond epoch clock, and stores uploaded media by SHA-256. It never streams frames to nodes; nodes cache assets and render locally.

Run with Node.js 22.13 or newer:

```sh
PIXEL_CONTROL_TOKEN="a-control-only-random-secret" \
PIXEL_NODE_SIGNING_KEY="a-different-node-signing-secret" \
  node runtime/server/index.mjs --host 0.0.0.0 --port 4100
```

State is atomically persisted below `runtime/data/server` by default. A durable
transaction is published to memory only after its temporary state file has
been renamed successfully, so a disk-full/write failure cannot leave RAM ahead
of restart state. This includes the latest host snapshot, node registry,
command queues, action results, and a bounded action audit. For production, set
`PB_SERVER_DATA_DIR` to durable local storage. Command dead-letter evidence is
part of the same durable state and is never inferred from volatile telemetry.

Every committed replacement is flushed before rename and retains the previous
primary as `state.last-known-good.json`. Invalid JSON or an unsupported schema
never resets the room to defaults. Startup also validates nested node, ordered
command, timeline, media, camera, preview, and bundle contracts; syntactically
valid JSON with a damaged inner container is not accepted. It restores a valid
last-known-good file, quarantines the damaged primary as
`state.json.invalid-*`, or refuses to start when neither copy is valid. A legacy
`requiresResync` marker represents an unrecoverable ordered-log gap and is
handled through the same LKG/fail-closed path rather than advancing a cursor
past unknown commands. Directory-entry `fsync` is attempted and is skipped only
on Node/Windows runtimes that do not expose directory handles.

Per-node command queues are bounded. Consecutive trailing project snapshots may
coalesce, but a snapshot separated by another ordered command is retained as
that command's dependency. A full queue rejects the entire durable operation;
it never drops an older STOP, rollback, calibration, action, or transport
command and never publishes sibling project/timeline mutations from the failed
transaction.

The source-run default binds only `127.0.0.1`. A non-loopback listener refuses
to start unless both a control token and a distinct Render Node signing key are
configured. `PIXEL_CONTROL_TOKEN` (or `PB_CONTROL_TOKEN_FILE`) authorizes Web
Control/operator reads and mutations. `PIXEL_NODE_SIGNING_KEY` (or
`PB_NODE_SIGNING_KEY_FILE`) remains Server-only and verifies per-node bearer
credentials. Generate one without exposing the signing key in argv:

```sh
sudo node runtime/server/create-node-credential.mjs \
  --node-id render-02 \
  --secret-file /etc/pixel-brightness/node-signing-key \
  > /root/render-02.node-token
```

Each credential is HMAC-bound to its exact `nodeId`. It can register,
heartbeat, poll, submit camera-preview results, and download media currently
assigned to that node; it receives HTTP 403 on project, timeline, output,
calibration, diagnostics, host-action, and other-node routes. Conversely the
control token cannot register or impersonate a node. Health and clock discovery
remain public. CORS reflects the requesting origin rather than using a wildcard.
`PB_ALLOW_INSECURE_NETWORK=1` is a development-only override.

When the signing key is configured, the saved project's `outputs[].nodeId` is
the sole ownership authority. A Node's self-reported output IDs/connectors remain
useful inventory but cannot grant another output, its media, a pattern command,
camera-calibration scope or `PREPARE` membership. Assign every production output
an explicit `nodeId`; registered Nodes with no explicit output assignment receive
an empty scoped project and are excluded from default `PREPARE`. Explicitly
targeting one also fails closed. Tokenless loopback development alone retains
automatic matching of unassigned outputs by ID/connector.

`PIXEL_AUTH_TOKEN` is deliberately rejected by the production entrypoint. It
was historically copied to every node, so retaining it as a control credential
would leave every old Render Node with operator authority. Migration must rotate
the browser control token, create a new Server-only signing key, and provision
`PIXEL_BRIGHTNESS_NODE_TOKEN` separately to each node.

JSON requests and raw uploads have bounded inactivity deadlines. The global
duration remains unlimited so a steadily progressing multi-gigabyte upload is
not cut off; a client that stops sending bytes cannot retain its socket forever.

For a dedicated controller that should not show a Pair prompt, retain
`PIXEL_CONTROL_TOKEN` and explicitly allow only that controller's source IP:

```sh
PB_TRUST_LOCAL_WEB=1
PB_TRUSTED_WEB_CLIENTS=192.168.1.193
PB_TRUSTED_WEB_HOSTS=192.168.1.195,pixel-brightness-01.local
```

Trusted requests must come from an allowlisted IP and carry the same-host Web
Control origin on port 3000 and use an explicitly allowed Server hostname.
Requests without that origin, including every node register/heartbeat/command
request, still require the token. Loopback is included automatically. Trusted
mode refuses to start if `PIXEL_CONTROL_TOKEN` is absent, so it cannot accidentally
open the API to the entire LAN.

Ubuntu fleet controls use these environment variables:

```sh
PB_ALLOW_POWER_ACTIONS=0
PB_POWER_ACTION_TOKEN=a-long-random-cluster-secret
PB_MAX_ACTION_AUDIT=10000
```

`PB_ALLOW_POWER_ACTIONS` defaults to off. Install every node with the same
separate power secret as its `PIXEL_BRIGHTNESS_POWER_CONFIRMATION_TOKEN`. The
power secret must not equal the control token; the Server refuses that unsafe
configuration. The browser never receives it.

## HTTP API

- `GET /v1/health`, `GET /v1/time`, `GET /v1/state`
- `GET|POST /v1/projects/default`
- `POST /v1/nodes/register`
- `POST /v1/nodes/:id/heartbeat`
- `GET /v1/nodes/:id/commands?after=0&waitMs=25000`
- `GET /v1/nodes/:id`
- `GET /v1/nodes/:id/diagnostics`
- `POST /v1/nodes/:id/actions`
- `POST /v1/timeline/prepare|play|pause|seek`
- `POST /v1/outputs/:id/pattern` (`grid`, `identify`, or `content`; default 32 px cells)
- `POST /v1/calibrations/camera` (measured by default; simulation must be explicit)
- `GET /v1/calibrations/camera/latest|:sessionId`
- `POST /v1/calibrations/camera/:sessionId/cancel`
- `POST /v1/media/upload` with raw bytes and `x-file-name`
- `GET /v1/assets/:sha256` (byte ranges supported)

Project writers must send the revision returned by `GET /v1/projects/default`
as `If-Match: 42` (a quoted decimal is also accepted). The comparison occurs in
the same store transaction as the update. A stale writer receives HTTP `409`
with code `project_revision_mismatch`; omitting `If-Match` receives HTTP `428`
instead of silently overwriting a newer operator or calibration change.

`PREPARE` distributes the authoritative project plus the relevant SHA-256 asset manifest. In secured mode its default target set contains only registered Nodes that own an explicitly assigned project output; an explicit target list may not bypass that ownership rule. Node heartbeats acknowledge durable commands using `ackSequence`, and `/v1/state` reports the explicit readiness barrier. V2 allows `PLAY_AT` while nodes are pending but returns a warning instead of claiming readiness. Graphics-driver, configured-connector, and renderer-service faults from the latest host snapshot are included in readiness warnings. Transport `play`, `pause`, and `seek` commands include a future `effectiveAtNs`, allowing all nodes to execute on the same corrected server clock.

Each render node receives the shared canvas/timeline plus only the outputs it
owns. A pending `sync-project` is a complete node-scoped snapshot, so a newer
revision replaces every older pending snapshot for that node while unrelated
ordered commands remain. This keeps an offline node bounded even with dense
128×128 meshes and avoids sending every wall in a large fleet to every PC.

## Fleet heartbeat

Nodes may extend the normal heartbeat with a bounded host snapshot and durable action results:

```json
{
  "status": "ready",
  "ackSequence": 42,
  "telemetry": { "currentFrame": "1200", "droppedFrames": 0 },
  "host": {
    "capturedAt": "2026-08-11T12:00:00.000Z",
    "hostname": "render-01",
    "kernel": "6.8.0",
    "driver": { "status": "ok" },
    "displays": [{ "name": "DP-1", "status": "connected" }]
  },
  "actionResults": [{
    "resultId": "result-01",
    "commandId": "cmd_123",
    "sequence": 43,
    "actionType": "COLLECT_DIAGNOSTICS",
    "status": "succeeded",
    "startedAt": "2026-08-11T12:00:01.000Z",
    "completedAt": "2026-08-11T12:00:02.000Z",
    "result": { "diagnostics": { "renderer": "healthy" } }
  }]
}
```

The response contains `acknowledgedActionResultIds`; nodes can remove only those results from their durable outbox. Repeated result IDs are idempotent. `GET /v1/nodes/:id/diagnostics` returns the latest host/renderer diagnostics and the last 100 action audit records for that node.

Permanently failing ordered commands use the same authenticated heartbeat as a
two-phase dead-letter hand-off. The Server accepts only evidence for the exact
next queue head and verifies its id, sequence, type, retry timestamps, errors,
and authoritative safety classification. It atomically persists the audit and
removes only that command before returning
`acknowledgedCommandDeadLetters`; an identical lost-response replay is
idempotent and changed evidence is rejected. Records remain visible in
`GET /v1/nodes/:id` (`recentCommandDeadLetters`) and diagnostics
(`commandDeadLetters`) with `operator-review-required` recovery state. A safety
dead-letter adds a critical readiness fault and retains the Node's sticky-black
status across registration. No automatic clear or arbitrary requeue endpoint is
provided because recovery must prove the physical output is safe first.

Camera-calibration progress and its terminal manifest use the same durable
heartbeat channel. A measured result is applied only when its manifest is
applicable, every local artifact has been verified by the owning Node, and the
Server validates the proposed renderer fields against the unchanged project
revision. Simulation results are retained for diagnostics but never mutate the
project.

## Allowlisted host actions

`POST /v1/nodes/:id/actions` accepts only:

- `APPLY_DISPLAY_CONFIG`
- `RESTART_RENDERER`
- `RESTART_NODE`
- `REBOOT_HOST`
- `SHUTDOWN_HOST`
- `COLLECT_DIAGNOSTICS`

Example:

```json
{ "type": "RESTART_RENDERER", "payload": { "reason": "operator-request" } }
```

A successful request returns HTTP `202` with the durable audit record and command identity. The node receives an ordered command with this shape:

```json
{
  "type": "HOST_ACTION",
  "action": {
    "id": "action_123",
    "type": "RESTART_RENDERER",
    "payload": { "reason": "operator-request" }
  }
}
```

`REBOOT_HOST` requires `confirmationPhrase: "REBOOT <nodeId>"`; `SHUTDOWN_HOST` requires `confirmationPhrase: "SHUTDOWN <nodeId>"`. Both also require `PB_ALLOW_POWER_ACTIONS=1` and a separate configured power-confirmation token. That token must differ from the control credential and appears in the node's `action.confirmationToken`, never in the HTTP action response or audit. Disabled and mistyped power attempts are recorded as rejected. There is intentionally no arbitrary shell or arbitrary-command endpoint.
