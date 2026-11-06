# Pixel Brightness Render Node V3

This daemon is the worker/render side of Pixel Brightness. It registers with the
control server, caches media by SHA-256, executes durable ordered commands, and
derives every content frame from an absolute server-time deadline. A late timer
never shifts the next frame; the node skips to the authoritative frame and
reports the drop. Clock corrections step only before playback and slew while a
show is active so the show clock cannot jump backwards.

The core includes a deterministic CPU simulator and production-oriented GLSL mapping
pipeline. The simulator exercises the same crop, 2–128 by 2–128 mesh, mask,
edge-blend, black-uniformity, gain/offset/gamma, and LUT-hook configuration that
a native OpenGL/Vulkan/Metal adapter consumes. It deliberately does not claim
physical GPU, genlock, decoder, or NDI output; those backends implement the
`OutputAdapter` contract in `render-engine.mjs`.

V2 adds an Ubuntu 24.04 host-control layer. Heartbeats include kernel, uptime,
load, memory, disk, systemd service, display-session, NVIDIA (`nvidia-smi`), and
DRM connector/EDID/mode telemetry. Optional probes are reported as unavailable
instead of taking the render node offline. macOS remains a supported development
fallback; Linux-only probes are marked unsupported and host mutations default to
dry-run.

## Run

```sh
node runtime/node/index.mjs \
  --id node-east-01 \
  --name "East wall node" \
  --server http://127.0.0.1:4100 \
  --data-dir runtime/data/nodes/node-east-01 \
  --outputs '[{"id":"A","connector":"DP-1"},{"id":"B","connector":"DP-2"}]'
```

For a secured server, generate a credential on the Server for this exact
`nodeId`, copy only that credential to the Node, and run:

```sh
PIXEL_BRIGHTNESS_NODE_TOKEN='pbnode.v1…' node runtime/node/index.mjs
```

The Node credential has no project/timeline/calibration/host-control authority
and cannot authenticate as another node. Legacy `PIXEL_BRIGHTNESS_AUTH_TOKEN`,
`PIXEL_AUTH_TOKEN`, the `authToken` JSON key, and `--auth-token` fail closed;
rotate the old Server control token before provisioning the new credential.

All flags have matching `PIXEL_BRIGHTNESS_*` environment variables. A JSON file
can be supplied with `--config node.json`; CLI overrides environment, which
overrides the file. Use `--help` for the complete list.

## Asset-cache capacity

The content-addressed cache has two independent byte limits. `maxAssetBytes`
(`--max-asset-bytes`, default 50 GiB) bounds one payload, while
`maxCacheBytes` (`--max-cache-bytes`, default 100 GiB) is an exact aggregate
payload budget for cached files, crash-left partials, and every in-flight
reservation. The daemon inventories the existing `cache/sha256` tree before it
downloads anything. Existing content is never evicted implicitly: if the
inventory already fills or exceeds the budget, new downloads fail closed until
an operator explicitly relocates or removes unused cache data.

Known-length downloads reserve their advertised bytes before opening the HTTP
body. An unknown-length download conservatively reserves its entire effective
per-asset ceiling; a body that exceeds a declared size must atomically grow its
reservation before the extra chunk is written. Concurrent requests for the same
SHA share one in-flight promise. Reservations are released on network, write,
hash, and pre-rename publication failures. Once rename makes verified bytes
reachable, a later directory-sync error retains their capacity ownership until
a retry verifies and syncs the entry. A partial file that cannot be removed, or
one found after a process crash, stays in place and is charged as
`orphanedBytes` rather than being silently deleted.

The configured cache root, `sha256` directory, every two-hex digest prefix, and
every inventoried entry must be real local directories or exclusive regular
files. A symlink, Windows junction/reparse-like entry, nested directory, hard
link, or topology change fails cache startup/access before any network request;
such entries are never ignored for capacity accounting and are never followed
for reads, writes, renames, or cleanup. The deployed data-directory ACL remains
the boundary against a same-identity process racing filesystem changes between
those checks; sharing one cache directory between processes is unsupported.

Heartbeat diagnostics expose `committedBytes`, `reservedBytes`,
`capacityBytes`, `availableBytes`, `overCapacityBytes`, and `orphanedBytes` in
the cache snapshot. The small advisory `.json` sidecars are not payload-budget
bytes; their string fields are bounded and a sidecar failure never deletes a
verified content file. Deploy one daemon per data directory—the in-memory
reservation ledger is not a cross-process filesystem lock.

## Authoritative boot reconciliation

On Windows, verified local state and cache bytes only arm the native boot-black
release; they do not release it. The first authenticated Server registration
must provide a current output-scoped project, a durable acknowledgement cursor,
and the latest durable command cursor. Node compares both with its persisted
`lastSequence`, applies the scoped project, verifies every current cue even
while the timeline is idle, prepares the renderer, and commits the result
before sending the one-shot release. A missing cursor, a local cursor behind
the Server acknowledgement, a local cursor ahead of that acknowledgement, a
Server cursor behind local state, or a truncated history activates the durable
state-recovery safety lock. Boot release requires exact equality between local
`lastSequence` and the Server's durable per-Node `ackSequence`; knowing only
that a command exists is not proof that this Node executed it. Consequently, a
crash after local command commit but before the Server receives its heartbeat
ACK is an explicit availability boundary: the Node remains black for operator
reconciliation instead of guessing and potentially dropping a queued HOST or
CAMERA command. Node never repairs these cases by resetting to zero or skipping
to an earliest retained command.

Output reassignment can make a previously local cue return HTTP 403 before the
first registration. That specific startup case remains black and continues to
registration so the authoritative scoped project can remove or replace the
stale cue. Asset authority is never widened; all cues in the replacement
snapshot must pass the normal hash/download, renderer-prepare, and durable
commit gates before release. Other missing/corrupt-cache failures remain
fail-closed startup failures.

## Poison-command recovery

Ordered commands default to three durable attempts (`--command-retry-budget`,
or `PIXEL_BRIGHTNESS_COMMAND_RETRY_BUDGET`, range 1–20). Each failure is written
with the exact command id/sequence/type, attempt number, error, and timestamp
before reconnect. At the budget, the Node retains a deterministic dead-letter
outbox record and does **not** advance `lastSequence`. The Server must first
persist identical evidence and remove only that queue head; only its explicit
acknowledgement lets the Node atomically advance the local cursor. A lost HTTP
response or local rename failure replays the same idempotent record after
restart, while later unrelated commands can proceed after the hand-off.

Calibration-pattern, camera calibration/verification, and rollback failures
activate a separate durable safety lock. The renderer is forced to black before
retry and after every later command; subsequent safety commands, including a
`content` pattern restore, are rejected into their own visible dead-letter
audit. A normal project sync therefore cannot silently clear the failure. The current implementation deliberately requires
operator review rather than exposing an unsafe automatic clear/requeue action.
The lock and complete bounded local failure history appear in Node diagnostics.

## Windows native health freshness

The Windows bridge polls `get-status` once per second instead of repeating the
last configure-time snapshot forever. A status older than the bounded freshness
window makes heartbeat `ready=false` and `connected=false`, even if the native
process still exists. Only native state `running` together with composition
source state `connected` is show-ready. `validating`, `waiting`, `stale`,
`mismatch`, `input-degraded`, render/display errors and a wedged named-pipe
request are not ready. A recovered pipe performs a fresh `hello` handshake and
status read before the Node advertises recovery.

## Host action security

The node accepts exactly six `HOST_ACTION` values: `APPLY_DISPLAY_CONFIG`,
`RESTART_RENDERER`, `RESTART_NODE`, `REBOOT_HOST`, `SHUTDOWN_HOST`, and
`COLLECT_DIAGNOSTICS`. It never accepts a command line or shell fragment from the
network. Every OS command uses an absolute, locally configured executable and an
argv array through `execFile` with `shell: false`, timeout, environment filtering,
and output limits.

`REBOOT_HOST` and `SHUTDOWN_HOST` are denied unless both conditions are true:

- `PIXEL_BRIGHTNESS_ALLOW_POWER_ACTIONS=true`
- the queued action carries a `confirmationToken` equal to the node-local
  `PIXEL_BRIGHTNESS_POWER_CONFIRMATION_TOKEN`

Keep the confirmation token in the systemd environment file rather than the CLI
or Web Control. Action results are persisted before acknowledgement and sent in
heartbeats until the Server explicitly acknowledges each `resultId`.

On Ubuntu, privileged operations use one fixed helper by default:

```text
/usr/local/sbin/pixel-brightness-hostctl apply-display-config --backend kms --config <fixed-node-config-path>
/usr/local/sbin/pixel-brightness-hostctl restart-node --service pixel-brightness-node.service --delay-ms 3000
/usr/local/sbin/pixel-brightness-hostctl reboot --delay-ms 3000
/usr/local/sbin/pixel-brightness-hostctl shutdown --delay-ms 3000
```

The helper path is local configuration
(`PIXEL_BRIGHTNESS_HOST_CONTROL_COMMAND`), never an API payload. The deployment
must grant the node service permission to run only this helper and the helper
must retain the same allowlist. `RESTART_RENDERER` is handled inside the daemon,
so no separate renderer systemd unit is required. `COLLECT_DIAGNOSTICS` writes a
mode-0600 JSON artifact below the node data directory.

## Display control

Display configuration is schema-validated and durably persisted: the same-dir
temporary file is flushed before rename, the parent directory is synced where
the platform exposes that operation, and an independently flushed
`display-config.json.last-known-good.json` retains the preceding configuration
(or the first authorized configuration on initial commit). A separately durable
`display-config.json.commit.json` records pending and committed intent digests
before and after publication. Startup restores a missing or invalid primary only
from a canonical LKG and quarantines corrupt input, but exposes that rollback as
an active recovery boundary; restoring bytes alone never authorizes boot-black
release. A new authenticated display intent or local operator recovery must
resolve that boundary. Startup aborts behind native boot-black if neither copy is
trustworthy. Before any recovered display is applied, the daemon converts an
active marker into the durable Node state-recovery lock, skips automatic display
reconciliation, destroys boot-release authority, and reports
`DISPLAY_CONFIG_RECOVERY_REQUIRED`; restoring the LKG bytes alone can therefore
never re-enable content. Clearing that monotonic Node lock remains an explicit
local operator-recovery action. DRM/KMS is
the default because it can own scanout without a desktop compositor. The
privileged helper is the boundary to the native KMS backend that holds DRM
master. This repository currently fails closed with `KMS_APPLY_FAILED` until
`runtime/native/pixel-brightness-kms` is installed; it does not claim a mode-set
from persistence alone. An X11
fallback is used only for `backend: "xrandr"`, or for `backend: "auto"` when
`PIXEL_BRIGHTNESS_ALLOW_XRANDR_FALLBACK=true`; fallback results explicitly report
`fallbackFrom: "kms"`. Xrandr still requires a valid local `DISPLAY` and
`XAUTHORITY`, supplied through `PIXEL_BRIGHTNESS_DISPLAY_ENV` JSON.

On every live Linux daemon start, a saved configuration is reconciled exactly
once through the same allowlisted action executor. A failed KMS/helper result does
not crash or retry-loop the node: the heartbeat reports `display.applied=false`
and a display fault until an operator resolves and reapplies it. DRM hotplug
telemetry also marks saved connectors missing/disconnected and clears the claim
that the configuration is applied; V2 surfaces this fault rather than making an
unsafe automatic mode-set while a show may be running.

Example payload compatible with Fleet Web Control:

```json
{
  "backend": "kms",
  "outputs": [
    {
      "id": "A",
      "connector": "DP-1",
      "enabled": true,
      "primary": true,
      "x": 0,
      "y": 0,
      "resolution": { "width": 1920, "height": 1080, "refreshNum": 60000, "refreshDen": 1001 }
    }
  ]
}
```

The automated tests use injected sysfs/command adapters and therefore cannot
prove real EDID access, DRM-master acquisition, NVIDIA driver behavior, systemd
policy, projector link training, or hardware scanout on this macOS development
host. Those checks must be completed on the target Ubuntu/NVIDIA mini PC.

## Output assignment

Each physical connector is declared in the node config. Project outputs match it
by output `id` first and connector name second. A project output with a `nodeId`
is accepted only on that node. Outputs that overlap should normally live on the
same render node; multiple nodes need PTP and hardware frame lock for guaranteed
scanout-level synchronization.

## Camera auto calibration

The Node executes camera calibration asynchronously so heartbeat and cancel
commands continue while patterns are being captured. The Windows native pattern
adapter requires raw linear `solid` and normal/inverse `gray-code` modes,
automatic black isolation of non-target outputs, correction bypass, preserved
warp, and presented-frame counters. It does not accept a command as settled
until the requested number of swapchain frames has actually been presented.
The shared/Windows pattern command also reserves `applyCorrections:true` for a
linear `solid` only. This is the bounded renderer primitive for a later
post-apply optical recapture: the renderer must advertise corrected-solid
support, telemetry must show corrections are not bypassed, and every other
pattern mode rejects the field. It does not by itself declare an optical pass.

The deterministic camera/solver path is available only when the Server queues
`mode: "simulation"`; its manifest is permanently non-applicable. Production
on Windows targets the Sony A7 IV through a process-isolated external helper;
without the separately licensed helper executable it reports unavailable and
cannot apply a measured result. Tests can still supply an adapter through the
Node's `cameraCalibrationFactory` boundary without changing the Server API. The
production `MeasuredCalibrationSolver` is active behind that boundary:
it decodes Gray code, scatters camera measurements to physical projector pixels,
and atomically commits warp/R32/LUT files below `dataDir/calibrations`. It never
substitutes an image resize for measured correspondence. Black lift is computed
once from the averaged room baseline and allocated across overlap blend weights,
so two projectors do not add the full correction twice. Measured files are then
size/SHA-256 verified before their paths can enter the final renderer project.

Every terminal measured/applicable manifest is also committed to the dedicated
`camera-calibration-manifests.json` archive before a terminal heartbeat may
publish it to the Server. The atomic file write is flushed before rename and
the containing directory is synced where the host permits it. Each immutable
entry binds the exact calibration session, Node, base project revision, output
set, camera view, normalized plan hash, manifest hash, and—for immersive bundle
members—the Server-issued bundle/member/view-capture tuple. Optical
verification requests resolve this archive by their exact calibration session
and base project; they never fall back to the most recently captured wall.

The archive defaults to 32 entries and 128 MiB and can be bounded further with
`--camera-manifest-archive-max-entries` and
`--camera-manifest-archive-max-bytes` (or the matching
`PIXEL_BRIGHTNESS_CAMERA_MANIFEST_ARCHIVE_*` variables). Unpinned standalone
entries may be removed oldest-first to admit a new manifest. Bundle entries are
never auto-evicted: the current Server protocol has no authenticated exact
terminal/expiry release acknowledgement, so their pins are deliberately
permanent. If pinned evidence fills either bound, the next measured calibration
fails closed instead of discarding an earlier wall baseline. An operator may
raise the bounds; manual archive deletion forfeits the affected bundle's local
optical-verification baseline. Diagnostics expose entry, pin, logical-entry,
serialized-file, and configured-capacity byte counts.

Before projector takeover, the Node preflights the complete retained-capture
budget (512 MiB by default). Gray-code frames retain bounded luma statistics;
radiometry retains bounded RGB statistics and uncertainty without keeping every
full-resolution source frame. Measured maps must also pass dense pixel/tile,
response-fit, clipping and provenance gates before an artifact directory can be
committed. The current solver measures the illuminated footprint; it does not
yet infer a venue-design boundary or camera-lens model automatically.

The intended Windows production camera is now configured through a
process-isolated Sony A7 IV helper. The proprietary helper is not bundled or
claimed complete; its fail-closed NDJSON/file contract and hardware gate are in
[`docs/windows/sony-a7iv-camera-helper.md`](../../docs/windows/sony-a7iv-camera-helper.md).

## Black level

The shader hard-masks/crops unwanted pixels and normalizes overlap intensity.
For LCD projectors, a digital black pixel still leaks optical light. The black
uniformity map therefore raises darker regions toward the measured worst black
floor; true removal needs projector contrast, optical masking/shutters, or a
darker room/surface.
