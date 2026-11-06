# Pixel Brightness V3 architecture

## Active Windows spatial-output profile

The current product direction uses Resolume Arena only as the media player and
master-composition authoring surface. Arena publishes one unwarped GPU texture
named `PB-COMPOSITION` through Spout. It does not own projector Screens,
geometry, edge blend, masks or black correction.

When the show source is NDI, the supported ingress is the current local chain
`NDI source → Arena on the render PC → local PB-COMPOSITION Spout → Pixel
Brightness`. Arena owns NDI reception. Direct NDI into Pixel Brightness is
unsupported, and Pixel exposes no upstream “NDI ready” guard; its authoritative
readiness boundary starts at the local Spout handoff.

```text
Arena layers / cues / composition position
                  │ one master Spout texture
                  ▼
      Pixel Brightness Windows renderer
        ├─ output A source viewport
        │    → dense mesh warp / curve / keystone
        │    → measured blend / black / colour / mask
        │    → DXGI swapchain → projector A
        ├─ output B source viewport → … → projector B
        └─ output C source viewport → … → projector C
```

One native C++20 process owns one D3D11 device, receives the master Spout
texture once per frame, and renders every output from that shared shader
resource. Each output owns a borderless Win32 window and flip-model DXGI
swapchain on a display bound by device path/EDID identity. It never chooses a
Spout sender or Windows screen by current ordinal. Missing/mismatched source,
display identity changes and device/present failures all fail to black.

The native renderer runs in the signed-in local Show session. Windows services
and scheduled startup tasks may host the control plane, Web Control and
watchdog, but Session 0 cannot own physical projector windows. RDP is excluded
during setup and playback because it can change the interactive display
topology.

Optional camera calibration remains inside Pixel Brightness. Gray-code normal/inverse
captures recover camera-to-projector correspondence; a dense target grid is
converted into up to 128×128 curved warp meshes. Visibility masks become
normalized linear-light blend maps, while black/near-black, white and RGB
captures produce black-lift, gain, gamma and LUT maps. Manual four-corner
or dense-mesh editing is also a supported independent workflow: an operator may
bind/Identify displays, create and name surfaces, assign source viewports,
author mesh/blend/mask/black/colour, save a revision and pass acceptance without
a camera. Camera absence must not block a valid manual project.

The Linux node and simulator remain useful protocol/test backends. Windows is
the primary physical-output backend for the first A400 installation.

## System topology

```text
                         browser / tablet
                               │ HTTP
                               ▼
┌──────────────────────────────────────────────────────────┐
│ Pixel Brightness Server                                 │
│ authoritative project · media SHA store · command log   │
│ timeline epoch · readiness barrier · node registry      │
└──────────────┬───────────────────────┬───────────────────┘
               │ long-poll + heartbeat │
       ┌───────▼────────┐      ┌───────▼────────┐       …
       │ Render Node 01 │      │ Render Node 02 │
       │ local cache    │      │ local cache    │
       │ one TimeCore   │      │ one TimeCore   │
       │ outputs A–D    │      │ outputs E–H    │
       └─┬───┬───┬───┬─┘      └─┬───┬───┬───┬─┘
         ▼   ▼   ▼   ▼          ▼   ▼   ▼   ▼
        PJ  PJ  PJ  PJ         PJ  PJ  PJ  PJ
```

The Server is a control plane, not a frame server. Render Nodes keep media locally and derive the frame to render from the same server epoch. Adding projectors adds output adapters; exceeding one machine's connector/GPU bandwidth adds another Node without changing the canvas model.

Projector device control is a separate, low-rate path. For the PT-VMZ51 show
profile, Web Control sends allowlisted logical operations to Pixel Server;
Pixel Server connects directly to each explicitly configured projector over
Panasonic native LAN Command Control (`NTCONTROL`, TCP port 1024). It does not
use PJLink, depend on screen order, pass device credentials to Render Nodes, or
couple power/shutter state to the NDI/Magewell/HDMI signal path.

## Durable command lifecycle

1. A Node registers its stable ID, physical connectors and active capabilities.
2. The Server appends one node-scoped `SYNC_PROJECT` snapshot to that Node's
   ordered durable queue. A newer project revision replaces an older pending
   snapshot while preserving unrelated commands.
3. The Node processes commands in sequence and acknowledges the last completed sequence in its heartbeat.
4. `PREPARE` includes the authoritative project and SHA-256 asset manifest.
5. The Node downloads missing assets, verifies hashes, configures outputs and reports `ready`.
6. The Server readiness barrier reports required, ready and pending Node IDs.
7. `PLAY_AT`, `PAUSE_AT` and `SEEK_AT` carry a future absolute `effectiveAtNs`.
8. After reconnect or restart, persistent sequence/transport state and Server reconciliation make operations idempotent.

Non-snapshot commands are pruned after acknowledgement. Complete project
snapshots are coalesced to the newest node-owned output subset. If a Node falls
behind the remaining bounded queue, the Server marks it for a full
resynchronization.

### Fail-closed execution lease boundary

Every production registration, heartbeat and command poll carries a short,
node-bound execution lease (five seconds or less). The Server mints the lease
inside its serialized state transaction and tracks the maximum expiry issued to
that Node. Durable state transitions persist that maximum; steady lease-only
heartbeats keep the serialized maximum in authoritative RAM so they do not
rewrite a dense project every two seconds. After a Server restart, a fence
conservatively drains one complete maximum TTL, covering any pre-crash response
which can still be in flight. A timeline dead letter immediately blocks
readiness and stops new leases; its persisted emergency fence becomes effective
no earlier than both the tracked maximum and that crash-safe drain boundary.
This makes a delayed old HTTP response usable only inside the bounded interval.

The Node renews authority before every non-black mutation and while content is
scheduled or playing. Fence receipt, lease expiry, generation mismatch or
renewal failure discards boot-release authority, aborts camera workflows and
forces authenticated global black. An asynchronous renderer/helper call which
was already in flight may be unabortable. The Node therefore withholds its
command acknowledgement, waits for that bounded call to return, and reasserts
black as the final renderer mutation. The Windows native renderer serializes
these requests and enforces its IPC timeout, so the software final-black bound
is the outstanding native request timeout plus at most one lease TTL. Generic
test/render adapters must provide an equivalent bounded completion contract.

Camera survey capture records the same execution-authority epoch. The Node
checks it after helper capture, before persisting a terminal report, immediately
before submission and again after the request returns. Authority loss produces
no complete report or command acknowledgement. As defense in depth, a Server
whose per-node fence or global recovery lock is already active converts a late
`complete` survey result into durable `failed` authority instead of preserving
ambiguous success.

Server primary-to-LKG recovery is independently remembered in the atomically
renamed and fsynced `state.recovery-lock.json` sidecar and mirrored in the
primary state. Either copy reconstructs the other; a conflicting same-generation
copy fails startup. The active monotonic marker blocks readiness, command/SYNC
delivery and all execution leases, and causes reconnecting Nodes to persist
sticky recovery black. It is never cleared automatically; a future explicit
operator-reconciliation workflow must prove and replace the lost authority.

This is a bounded software fail-close guarantee, not instantaneous physical
revocation: an already-issued lease or in-flight projector/GPU operation may be
visible briefly. Installations requiring zero-transient optical black need an
independent hardware shutter or watchdog interlock.

## Time and frame authority

Each process anchors epoch time once against a monotonic high-resolution clock. A Node samples `/v1/time` multiple times:

```text
RTT       = localReceive - localSend
midpoint  = localSend + RTT / 2
offset    = serverTime - midpoint
```

The estimator favors the lowest-RTT samples. Before playback it may step to the estimated offset. During playback `SlewedClock` converges gradually and never moves backward.

For a rational rate `rateNum/rateDen`, the frame is integer math:

```text
frame = baseFrame + (nowNs - playAtNs) × rateNum
                    ─────────────────────────────
                       1e9 × rateDen
```

Every wake-up recomputes this value. A late callback can drop a frame, but cannot shift every later deadline. The simulator records rendered, repeated, dropped, late and maximum-lateness metrics per output.

Software time synchronization is not scanout synchronization. Production multi-machine walls should add PTP clock discipline and hardware frame lock/genlock; the protocol already provides the absolute scheduling boundary those adapters need.

## Project and output model

A project contains:

- rational canvas frame rate and arbitrary master resolution;
- arbitrary named surfaces (persisted under the legacy wire field `walls`);
- up to 256 outputs;
- per-output `nodeId`, connector, resolution and source viewport;
- explicit `independent`, `horizontal`, or `vertical` surface layout;
- per-output left/right/top/bottom overlap constrained by that layout;
- 2×2 through 128×128 warp mesh;
- blend feather/gamma;
- black-uniformity lift/map;
- polygon or texture mask with softness;
- RGB gain/offset/gamma and LUT reference;
- timeline cues referencing media SHA-256.

On a secured Server (a Render Node signing key is configured), `outputs[].nodeId`
is the only output-ownership authority. Registration capabilities are untrusted
hardware discovery/telemetry: changing a claimed output ID or connector cannot
expand a Node's project, cue/media access, pattern routing, calibration scope or
`PREPARE` membership. Every production output must therefore have an explicit
`nodeId`; unassigned outputs and Nodes fail closed. Tokenless loopback development
retains the convenience behavior that matches an unassigned output by physical
output ID and then connector.

### Surface layout and seam authority

The **2 September 2026** show profile supports exactly three named-surface
layout modes. Every newly created surface defaults to `independent`, which
infers no neighbours and permits no positive overlap. `horizontal` represents
one left-to-right row; `vertical` represents one top-to-bottom column.

A positive seam is valid only between two outputs on the same surface and only
when the claims are reciprocal and equal (`right`/`left` for horizontal or
`bottom`/`top` for vertical). The pair must be aligned on the orthogonal axis,
adjacent in the selected one-dimensional ordering, and have a real positive
`sourceViewport` intersection equal to the seam width or height. One-sided,
cross-surface, misaligned, non-adjacent, gap, edge-touch, or wrong-axis seams
fail closed.

These modes deliberately do not infer a 2D or multi-row graph. A matrix,
multiple rows/columns, branch, L/T shape, diagonal, or any topology with an
ambiguous neighbour must be rejected, never guessed by sort order or nearest
coordinates. It requires a future versioned explicit edge graph, or must be
split into independent unambiguous surfaces with zero seams.

## Render graph

The reference GLSL pipeline in `runtime/node/shaders` implements:

```text
receive shared Arena composition texture through Spout
  → per-output source viewport (master-composition crop)
  → tessellated calibrated mesh
  → linear-light edge weight
  → measured black-lift texture
  → gain / offset / gamma / 3D LUT
  → hard or soft final mask
  → connector swapchain
```

`OutputAdapter` is the backend boundary. The simulator deterministically
evaluates mapping and timing without pretending to own a physical GPU. The
Windows native backend implements the physical boundary through D3D11, Spout
and DXGI. Media decoding is intentionally outside this profile because Arena is
the player. The supported NDI show path terminates in Arena and crosses into
Pixel only as local `PB-COMPOSITION` Spout. A direct Pixel NDI adapter remains
unsupported future scope and is not a release-readiness guard.

## Calibration core

`runtime/shared/calibration.mjs` provides dependency-free building blocks:

- exact 32-pixel (or configurable) RGBA grid pattern;
- normal/inverse Gray-code pattern generation and camera decode;
- four-point homography solve/apply;
- multi-output blend-weight normalization;
- black-uniformity lift-map calculation.

The automatic sequence is lens profile → Gray-code geometry → overlap → white
uniformity → LCD black uniformity → RGB/gamma LUT. V3 includes the bounded plan,
state machine, deterministic simulator, fail-closed pattern ownership and artifact
manifest contract. A physical run is applicable only after a Windows camera
adapter confirms real USB capture plus locked manual exposure, white balance and
focus; simulated artifacts are explicitly marked non-applicable.

## Ubuntu host control

Each Node periodically sends a bounded host snapshot with Ubuntu/kernel/memory/disk information, NVIDIA telemetry, DRM connectors, EDID hashes and systemd state. The Server persists the latest snapshot, derives driver/display readiness faults, and exposes the fleet without putting a shell behind the browser.

Host changes use a durable `HOST_ACTION` command with one of six allowlisted types:

```text
APPLY_DISPLAY_CONFIG · COLLECT_DIAGNOSTICS · RESTART_RENDERER
RESTART_NODE · REBOOT_HOST · SHUTDOWN_HOST
```

Every payload is size- and schema-bounded. The Node invokes fixed absolute executables through `execFile` with `shell:false`. The Ubuntu root helper accepts only exact argument shapes, validates the persisted display file again, and has no arbitrary command mode. Reboot and shutdown require all three gates: Server power policy, the exact browser phrase (`REBOOT node-id` or `SHUTDOWN node-id`), and a Node-local secret passed only in the queued command.

Actions and their Node results are retained in a bounded durable audit. Driver, connector and renderer faults feed the same readiness barrier as media/project readiness, so a disconnected configured projector blocks a truthful READY state.

## Appliance release and recovery

Ubuntu installation builds dependencies, Web Control and core tests inside a new versioned directory. Only a successful build switches `/opt/pixel-brightness/current` atomically. Persistent state/configuration live outside the release in `/var/lib/pixel-brightness` and `/etc/pixel-brightness`; upgrades preserve both and retain the previous release for rollback.

Systemd restarts failed processes and a health timer checks the Server, Web and Node every 30 seconds. A support-bundle tool captures redacted NVIDIA/DRM/EDID/service evidence for reproducing hardware bugs in the next release without including pairing or power secrets.

## LCD black-level boundary

A final digital mask guarantees zero signal outside the mapped polygon. It cannot guarantee zero photons: an LCD projector's optical black floor remains when the input pixel is zero, and overlapping projectors add their leaked light.

The correction map therefore raises darker single-projector regions toward the measured worst/overlap black floor. It makes seams less visible at the cost of a raised room black level. Actual black removal requires better native contrast, optical masking/shutters, reduced stray light, or a darker projection surface.

## Persistence and media

Server state is written to a temporary file and atomically renamed. Media is stored by SHA-256 and served with immutable cache headers and byte-range support. A Node streams a download into a temporary file, enforces byte limits, hashes during transfer, fsyncs, then atomically renames it into a two-level content-addressed cache.

Node state stores project revision, last acknowledged sequence, prepared assets, transport state and future scheduled actions. This supports restart recovery without re-streaming media.

## V3 implementation and verification boundary

Implemented and tested:

- Web Control and live API connection;
- one shared Arena `PB-COMPOSITION` source contract;
- native Windows C++20 D3D11/DXGI/Spout renderer source;
- stable display binding by device path plus adapter LUID/target ID;
- one shared source texture and per-output crop, indexed mesh, blend map,
  black map, colour/LUT, mask and flip-model swapchain;
- bounded NDJSON IPC between the Node and native renderer;
- 64 MiB bounded IPC/project envelope for up to 32 high-precision dense 128×128-cell output meshes;
- fail-closed source/display/device behavior and renderer telemetry;
- versioned Windows installer, delayed Show-task enablement, display binder and
  full acceptance contract;
- Server persistence, auth option, media store and ordered command queues;
- multi-Node registration, heartbeat, readiness and reconnect;
- deterministic absolute frame scheduler with clock slew;
- media cache verification;
- mapping/calibration math up to a 128×128 grid;
- camera calibration plan/state/manifest and deterministic simulated capture;
- CPU render simulator and production-oriented GLSL;
- two-Node integration test proving a shared authoritative frame within one frame under software scheduling.
- Ubuntu OS/NVIDIA/DRM/EDID/service telemetry and fleet readiness faults;
- allowlisted, authenticated and audited Ubuntu host actions;
- immutable release installation, service recovery, support bundle and rollback.

Still requiring physical Windows/hardware acceptance:

- Visual Studio build of the native target with the pinned Spout2 dependency;
- exact A400/projector display binding and Present telemetry on the target PC;
- Canon USB camera capture adapter and measured lens/radiometric validation;
- generated calibration assets applied to a real project revision;
- hot-plug, sender-loss, restart and multi-hour soak testing;
- PTP/hardware frame lock/genlock;
- optional future direct Pixel NDI input/output adapters (the supported current
  NDI path is NDI → Arena → local Spout);
- signed installer/update packages and production watchdog policy.

The macOS test suite proves contracts and orchestration, not Windows GPU output.
The Web UI must continue to show `hardware verification pending` until the
native renderer reports the bound EDID identities and successful Present
statistics from the actual Windows/A400 machine.
