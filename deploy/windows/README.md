# Pixel Brightness on Windows 11

This deployment is the production direction for the Arena composition-source
workflow:

```text
Resolume Arena composition
  -> one named master Spout sender
  -> Pixel Brightness D3D11 spatial renderer
  -> per-projector area crop and 128x128 mesh warp
  -> auto blend / mask / black uniformity / colour / LUT
  -> one DXGI swapchain per physical projector
```

Arena remains the media player and is used to position layers inside the master composition.
Arena does **not** own projector geometry, edge blend, masks or black correction.
Pixel Brightness receives the unwarped master composition,
selects a source area for every projector, and performs all spatial and optical
correction itself. Pixel Brightness does not play media in this mode. It is the
final process in the signal path and therefore owns every physical projector
display.

## Supported first installation

- Windows 11 Pro 64-bit, fully updated.
- One NVIDIA GPU driving every overlapping projector on that node.
- Resolume Arena and Pixel Brightness run in the same signed-in `show` user
  session.
- Arena publishes one master Spout sender named exactly as configured in Pixel
  Brightness, for example `PB-COMPOSITION`. All projector outputs sample areas
  from that same texture.
- Projector displays use Windows **Extend these displays**, the same native
  resolution and the same exact refresh rate.
- HDR, Night Light, G-SYNC/VRR and Windows display scaling are disabled on
  projector displays.
- Web Control is used during a show. Do not use RDP while output is live;
  changing Windows sessions can remove or recreate the physical displays.
- The active Wi-Fi/Ethernet control network is set to Windows **Private**. The
  preflight fails on a Public profile because ports 3000/4100 are intentionally
  never opened to Public networks.
- The first source build needs Internet access for `npm ci` and CMake's pinned
  nlohmann/json and Spout2 commits. Later installed runs do not fetch those
  dependencies at show time.

The renderer deliberately fails to black when a sender is missing, its size or
format changes, the configured EDID/display identity changes, or a swapchain
cannot present. It never guesses a different sender or Windows display number.

## Build and install

For a release handoff, verify the ZIP's external `.sha256` through the trusted
release channel before extraction and leave `MANIFEST-SHA256.txt` untouched.
Setup verifies every listed source file before UAC, carries the exact manifest
digest inside the encoded elevation command, copies only matching files into an
administrator-protected bootstrap directory under `ProgramData`, and executes
Setup elevated only from that protected copy. The installer verifies its second
protected build-stage copy again before any npm lifecycle script or CMake build
runs. The manifest proves package consistency and closes
the writable-source/staging race; it is not a publisher signature. A production
handoff still needs an authenticated distribution channel or signed release.

Open **Windows Terminal (Administrator)** in the repository and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\windows\Preflight-PixelBrightness.ps1
.\deploy\windows\Install-PixelBrightness.ps1 -ShowUser $env:USERNAME -Appliance
```

Those commands work unchanged in the extracted source package because it has
the manifest. A developer checkout intentionally has none; local development
may opt in explicitly with `-AllowUnverifiedDeveloperSource`. Never use that
bypass for a release/customer installation.

For the safe one-click path, double-click
`deploy\windows\Setup-PixelBrightness.cmd`. Windows UAC requests Administrator
approval, then the wrapper validates the native CMake contract, JSON schema and
both HLSL shaders before invoking preflight and install. It never reads, passes
or stores a Windows password. The one-click path applies the AC no-sleep policy
and still leaves `PixelBrightness-Show` disabled. On a default all-in-one
installation, Web Control opened specifically at `http://localhost:3000` on
that same Windows PC trusts loopback only and therefore does not show the Pair step.
Every other LAN address remains
token-protected.

To remove the Pair step for one known Web Control computer, retain the
Server-only control token but explicitly trust that controller IP and the
Windows render host name:

```powershell
.\deploy\windows\Install-PixelBrightness.ps1 `
  -ShowUser $env:USERNAME `
  -TrustedWebClient 192.168.1.193 `
  -TrustedWebHost 192.168.1.195,pixel-brightness-01.local `
  -Appliance
```

Every other LAN Web client still needs the control token. Node registration
instead requires its own nodeId-bound credential. Power actions remain disabled. A future USB hardware key can
replace this trusted-controller policy without changing the render pipeline.
Trusted clients must be exact IPv4/IPv6 addresses and trusted hosts must be
exact host names or addresses; wildcards and subnets are rejected. Both lists
are required together, so a partial trusted-local configuration cannot silently
open access.

The installer:

1. verifies the source manifest, builds the Web Control and native Windows
   renderer in protected `ProgramData` staging, then runs the compiled native
   config-contract test with CTest;
2. creates a final SHA-256/byte-length manifest over every regular,
   non-reparse build output, flushes every payload file and that manifest, and
   publishes an immutable version under
   `C:\Program Files\Pixel Brightness\releases`;
3. stores mutable configuration, logs and secrets under
   `C:\ProgramData\Pixel Brightness`;
4. creates startup tasks for Server/Web; `Role All` adds the weekly SYSTEM and
   interactive scheduler pair plus a no-trigger interactive Show task, while a
   standalone `Role Node` retains Show-at-logon;
5. opens TCP 3000 and 4100 on the Private firewall profile only;
6. with `-Appliance`, sets AC sleep, hibernate, display and disk timeouts to
   never. The one-click setup supplies this switch automatically.

### Weekly show automation (`Role All`)

Open `http://localhost:3000`, choose **Show Schedule**, and configure the exact
Arena executable/composition, Windows node, operating weekdays and local
Start/Shutdown times. BIOS RTC wake and the Web calendar are separate: set BIOS
wake earlier and disable closed days in both. Windows auto-logon only creates
the local interactive Show desktop; the SYSTEM worker owns the sequence.

Saving never causes an immediate equipment action. A revision saved after
today's Start boundary waits for the next enabled day. Once a run begins it
pins its original shutdown time, Arena identity, five projector IDs and their
Projector Control revision, so
later edits or disabling the schedule cannot strand that run. Shutdown is
always Arena Save → graceful Arena close → confirmed projector standby → Show
stop → normal Windows `/t 0` shutdown, with no forced application closure. A
boot identity prevents an interrupted old run from shutting down the next boot. See
[`docs/windows/weekly-show-schedule.md`](../../docs/windows/weekly-show-schedule.md)
and perform the documented supervised cold-boot/shutdown test before unattended use.

### Transactional upgrade and rollback

An installation whose stable `Start-PixelBrightness.ps1` predates the durable
gate or the cross-session release launch barrier is
not eligible for an online in-place upgrade. The installer exits with
`legacy_upgrade_bootstrap_required` before writing the gate or changing a
managed task. An administrator must first stop and disable every task in the
installed role profile and install the gate-aware, launch-barrier-aware `Start-PixelBrightness.ps1`,
`RuntimeSecurity.ps1`, and `UpgradeTransaction.ps1` from the verified release
package while the host is offline. Only after the scheduled-task actions are
audited to point at that stable launcher may the normal installer run. This
explicit bootstrap prevents a reboot between gate creation and task disable
from launching an old process that does not understand the gate, and prevents a
launcher that made an earlier no-gate decision from resuming after mutation.

An in-place upgrade first writes
`C:\ProgramData\Pixel Brightness\upgrade\in-progress.json` with an
administrator-owned, non-reparse ACL, then takes an administrator-only
snapshot before its first managed-task or generation mutation. Every installed
Server, Web, Show and weekly scheduler launchers check that fixed gate before auditing or reading
`current-release.txt`; a missing, corrupt, wrong-schema or untrusted gate blocks
startup. The snapshot records the exact bytes, existence and owner/group/DACL
(not audit SACL) of every pointer/config/control file the installer can replace; the
exact exported XML plus enabled/running state of every scheduled task in the installed role profile; the
two installer-owned firewall rules; and, with `-Appliance`, the prior active
power scheme and four AC timeout values. Every managed task in that role profile is durably
disabled and stopped before any application control file is published.
Server/Web listeners must close while each file is atomically replaced on NTFS.
`current-release.txt` is replaced only after all other configuration and
launcher files, while the independent boot gate remains present.

Every launcher acquires `Global\PixelBrightnessReleaseLaunchBarrier` before its
fresh gate check and retains it through child-process creation. The installer
always owns the separate installer mutex first, then acquires this launch
barrier, publishes the gate, disables tasks, kills any exact launcher/runtime
descendant tree that won the barrier earlier, and proves the renderer and ports
3000/4100 are closed before entering the mutating phase. Launchers never acquire
the installer mutex, so the lock order has no reverse cycle. Once the installer
releases the launch barrier, any queued normal launcher sees the already-durable
gate and exits; only the later one-shot Server/Web health launch can consume its
exact bypass. This closes both the long manifest-hash window and the final
gate-check-to-`Start-Process` window.

The display binder uses the same global order: it owns
`Global\PixelBrightnessInstaller` first and then the release launch barrier.
An active or corrupt display-binding transaction makes a later installer exit
before release staging or mutation; an abandoned live mutex is not recovery
evidence. A binding gate blocks **Show only**. Server and Web remain available
so an interrupted all-in-one host can query and reconcile its local Server.
Gate, journal, credential, stable-control and release-pointer publication all
use a same-volume `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` operation.
The installer first flushes the temporary bytes, then reopens the published
file and requires `FlushFileBuffers` to succeed before advancing to the next
phase. A returned publication therefore cannot rely only on a cached NTFS link.

The release directory has a separate payload durability contract. After all
npm and native build/test work, the installer writes
`.pixel-brightness-release-manifest.json` over the exact all-file inventory
(the manifest itself is the sole excluded path), rejects every reparse or
case-insensitive duplicate, and calls `FlushFileBuffers` on every payload file
and the manifest. If protected build staging is on another volume, those exact
bytes are first copied to an administrator-only `.incoming` directory beside
`releases`, flushed, and re-hashed there. The final directory name is published
only with same-volume `MoveFileExW(WRITE_THROUGH)`, then the complete manifest
is verified again under the final read-only ACL before `current-release.txt`
can change. The protected post-health commit also records the manifest digest.

Every Server, Web and Show launcher resolves the protected pointer and verifies
that same exact manifest before it reads runtime policy or executes any JS,
native renderer, shader, package or camera-helper code. A missing, truncated,
extra, renamed, digest-mismatched or reparse-backed release therefore never
starts, including after the upgrade gate has been cleared. This is intentionally
fail-closed; restore or reinstall the release instead of editing its manifest.

Normal startup tasks contain no transaction bypass and remain disabled during
validation. The installer uses separate SYSTEM health tasks with no startup or
logon trigger. Each gets one role-specific token in the protected snapshot;
the launcher atomically renames and validates that token before it may read the
new release pointer. The consumed token cannot survive/replay a crash or task
restart, and Show has no bypass under any condition. A watchdog binds each
candidate process tree to the exact installer PID/start time/command identity
and a ten-minute hard expiry; killing or hanging the installer closes the
candidate child tree and its owned port. These candidate processes
must pass authenticated API/Web identity checks, and ports 4100/3000 must
belong to fresh Node processes with the exact Server/vinext command identities.
A Node-only install
also requires its configured central Server health endpoint. The Show task
remains disabled until physical display binding.

Only after candidate health and a durable protected commit record does the
installer enable the normal Server/Web task definitions. The boot gate still
blocks them until their intended definitions/states are verified; the gate is
then cleared and those normal tasks are started and health-checked again. A
reboot at every earlier boundary therefore has either the old coherent
generation or a blocking gate, never runnable mixed controls/pointer. Any
ordinary PowerShell, build, publication, task, firewall, power or health-check
exception restores and re-hashes the prior files/ACLs, restores task XML and
enabled/running state, restores installer-owned firewall/power state, and
rechecks the previously running Server/Web endpoints. The newly published
immutable release is retained for diagnosis; rollback never deletes user data.

If exact restoration cannot be proven, the installer preserves the protected
snapshot under `C:\ProgramData\Pixel Brightness Build`, stops and disables all
Pixel Brightness tasks, removes the two managed inbound firewall rules,
terminates provably owned renderer/API/Web processes, checks that their ports
are closed, and reports the host as rollback-blocked. Do not use
that host or reconnect projector output until it is serviced locally. A
concurrent installer is rejected with a machine-wide mutex. `-SkipTasks` is
rejected when any managed task already exists because a live task cannot be
upgraded transactionally behind its back.

An unresolved or corrupt gate/journal is never auto-cleared. Installer and
recovery first disable every managed/transient task, stop the renderer and
provably owned API/Web listeners, remove the managed inbound firewall rules,
and verify the closed state. Recover locally from an Administrator PowerShell:

```powershell
& "$env:ProgramData\Pixel Brightness\Recover-PixelBrightnessUpgrade.ps1" -Confirm:$false
```

The explicit recovery command validates the protected journal contract,
restores exact bytes/ACLs, firewall/power and task XML while every task remains
disabled, verifies that static snapshot, then restores and verifies intended
task enablement with no task running. Only then does it clear the boot gate,
restart previously-running tasks, and verify their final state and authenticated
service health. Any parse, digest, ACL, static-proof or task-activation failure
reinstates/retains the gate and closes the host again. When the installed helper
is unavailable, run the same script only from the manifest-verified source
package and provide the inspected exact `-JournalPath`. A gate created before a
journal could finish is intentionally not clearable automatically because no
exact rollback proof exists.

The deliberate Windows VM fault gates are:

```powershell
$env:PIXEL_BRIGHTNESS_INSTALL_FAULT_INJECTION = 'after-release-publish'
# Other gates, in order:
# after-release-manifest, after-release-payload-flush,
# after-boot-gate, after-task-disable
# after-release-write-through-move, after-release-manifest-verify,
# after-token-control-file, after-node-control-file,
# after-runtime-control-file, after-installation-control-file,
# after-renderer-control-file, after-binding-control-file,
# after-stable-control-file-<exact .ps1 name>, after-trusted-web-control-file
# after-release-pointer, after-control-publication, after-task-change
# after-firewall-change, after-power-change, after-service-start
# before-post-install-health, after-post-install-health,
# after-health-service-stop, after-commit-record,
# after-final-task-enable, after-gate-clear
.\deploy\windows\Install-PixelBrightness.ps1 -ShowUser $env:USERNAME -Appliance
Remove-Item Env:PIXEL_BRIGHTNESS_INSTALL_FAULT_INJECTION
```

Run each gate only on a disposable, already working Windows acceptance VM.
Before each run, export every managed task XML definition/state and hash the protected
files listed in `UpgradeTransaction.ps1`; after the injected failure, verify
those values and the old API/Web health are identical. Then perform one normal
upgrade and reboot. Include a forced power cut after manifest creation, after
the per-file flush pass, after the write-through directory move, after final
manifest verification, and immediately before/after pointer publication. On
each reboot, corrupt or delete one manifested payload and add one unlisted file;
all installed launch roles must stop before executing release code. Mac-side tests
model these boundaries and prove the static gate/ordering contract, but do not
prove Windows PowerShell 5.1 parsing, `MoveFileExW` directory behavior, per-file
`FlushFileBuffers`, NTFS metadata/ACL persistence, Task Scheduler no-trigger and
disable/running behavior, exact task XML round trips, NetSecurity/powercfg,
real process-tree termination, or real sudden-power-loss durability. Run every
fault hook, forced process kill, power cut and recovery path on a disposable
Windows VM, including corrupt/truncated gate and journal cases, before a
production release.
Also pause each normal launcher after its first no-gate decision and again just
before child creation: the installer must either wait for that launch and drain
its complete process tree before mutation, or publish the gate first and make
the queued launcher fail its fresh decision without creating a child.
This host-side model does not prove sudden power-loss recovery on NTFS hardware.
File audit SACLs and Task Scheduler task-security descriptors/SACLs are not in
the rollback snapshot; acceptance must verify the installation does not rely on
custom values there. Directory ACL hardening performed before a failed first
install may also remain even when every snapshotted control file is restored.

### Central Server and render-only nodes

`Role All` is the default single-PC installation. A fleet uses one protected
central control plane and separate render PCs. Install the controller first:

```powershell
.\deploy\windows\Install-PixelBrightness.ps1 -Role Server -Appliance
```

The controller creates two different administrator-only secrets:
`control-token.txt` for operator routes and `node-signing-key.txt` for issuing
Render Node credentials. Never copy either Server secret to a render PC.
Generate one credential for the exact node id on the controller:

```powershell
$data = 'C:\ProgramData\Pixel Brightness'
$release = (Get-Content -LiteralPath "$data\current-release.txt" -Raw).Trim()
$runtime = Get-Content -LiteralPath "$data\secrets\runtime.json" -Raw | ConvertFrom-Json
$nodeToken = & $runtime.node "$release\runtime\server\create-node-credential.mjs" `
  --node-id render-02 --secret-file "$data\secrets\node-signing-key.txt"
if ($LASTEXITCODE -ne 0) { throw 'Node credential generation failed.' }
[IO.File]::WriteAllText('D:\render-02.node-token', $nodeToken.Trim(), [Text.UTF8Encoding]::new($false))
```

Protect and transport only `render-02.node-token`, then install that PC without
a local Server/Web task:

```powershell
.\deploy\windows\Install-PixelBrightness.ps1 `
  -Role Node -NodeId render-02 `
  -ServerUrl http://192.168.1.20:4100 `
  -NodeTokenFile D:\render-02.node-token `
  -ShowUser $env:USERNAME -Appliance
```

The credential value is never accepted as a command-line argument; only a file
is read, its embedded node id must exactly match `-NodeId`, and the installed
copy gives the Show account read-only access. Delete or securely erase the
temporary transport file after installation. Node-only installs do
not open inbound Web/API firewall ports and do not create local Server/Web
tasks. Server-only installs do not create the interactive Show task.

`ClusterTokenFile` is retained only as a rejecting compatibility parameter. A
successful guarded upgrade never promotes `cluster-token.txt`: it generates a
new control token and a different Server-only signing key, deletes the legacy
shared file transactionally, and requires every browser and Render Node to be
paired again. A failed upgrade restores the exact old generation for explicit
recovery; it cannot partially grant the old shared value new control authority.
The presence of `cluster-token.txt` forces both Server secrets to rotate even
if canonical-looking files remain from an earlier interrupted migration.

This V1 fleet path centralizes topology, calibration jobs and transport
commands. Its composition input is still **local Spout**, which does not cross
the network. Every render PC currently needs a local Arena process publishing
the same `PB-COMPOSITION`; software start commands do not frame-lock separate
Arena processes. A single Arena feeding many PCs requires the future network
texture/NDI adapter, and hard overlap sync across PCs still requires compatible
hardware frame lock. Keep overlapping projectors on one GPU/node until those
acceptance gates are complete.

The installer pins the exact `node.exe` and `npm.cmd` paths used at install time
so deployment does not depend on a different account's `PATH`. Server/Web
startup invokes the release-protected `scripts\run-vinext.mjs` directly with
the pinned `node.exe`; `npm.cmd` is audited but is not the SYSTEM service
entrypoint.
Both executables must come from the same x64 Node.js installation under an
administrator-protected `Program Files` tree. Preflight, install and acceptance
reject AppData/nvm/user-writable paths, reparse points, untrusted owners and
low-privilege write ACLs because Server/Web tasks run as SYSTEM. The audit walks
the complete pinned Node installation, including the sibling
`node_modules\npm\bin\npm-cli.js` tree executed by `npm.cmd`; checking only the
two launcher files is not sufficient.
Those paths and the trusted-local policy are protected under
`ProgramData\Pixel Brightness\secrets`. The control token and node-signing key
are readable only by SYSTEM/Administrators; the Show account can read only its
own `node-token.txt` plus non-secret runtime policy. It also requires the renderer EXE
plus `fullscreen_vs.hlsl` and `final_ps.hlsl` in their exact release locations.
It never searches for a different renderer. Each published release is made
read-only to the Show account. During an upgrade the installer refuses to
continue while any live or orphan native renderer exists, stops the old
Server/Web tasks cleanly, and prevents duplicate task instances.

The `Program Files\Pixel Brightness`, `releases` and
`ProgramData\Pixel Brightness` roots must remain below their standard Windows
administrator-controlled roots. Installation replaces their owner/DACL with a
canonical protected ACL rather than preserving unknown explicit ACEs from an
older or pre-created directory. Startup, binding and acceptance re-audit those
parent chains, the immutable release and every stable launcher/control file.
It also rejects reparse points and replaces owner/DACL on every existing item
below SYSTEM-only `logs\system` and `state\server` during upgrades; any
untrusted item fails closed before a SYSTEM service is launched.

The installer does **not** enable automatic Windows sign-in and does not store
the Windows password. Use a dedicated non-administrator show account. If an
unattended reboot is required, configure Microsoft Sysinternals Autologon on
site after the account and BitLocker policy have been approved.

## First display binding

Never bind by `Display 1`, `Display 2` or screen order. Pixel Brightness binds
each output by its Windows target `devicePath`, or by the exact
`adapterLuid` + `targetId` pair; `gdiName` is a discovery fallback. Identical
projectors with no unique EDID serial must remain on fixed GPU ports; an EDID
keep-alive device is recommended for unattended systems.

Before the initial bind, use **Windows Settings > System > Display > Identify**
and the inventory-only binder run to record the identical projectors in the
intended A/B/… order. Web identify is unavailable yet because Show deliberately
remains disabled until the first valid binding. After a bind with `-StartShow`,
use the Web Control identify grid to verify the result. If the initial order is
wrong and calibration has not begun, rerun the exact corrected `-GdiName` order
with `-ResetSpatialConfig`. Arena's master Spout sender name and Pixel
Brightness `compositionSource.senderName` must be identical. Arena must not fullscreen directly to the projector Pixel Brightness owns.
Source-area selection, mesh points, blend weights and masks are
authored or camera-calibrated in Pixel Brightness.

The binding helper asks the native renderer for the active Windows target list
and writes the same stable selectors to both Node and native configs. It never
silently falls back to screen order. The safest first run is explicit:

```powershell
& 'C:\ProgramData\Pixel Brightness\Bind-PixelBrightnessDisplays.ps1' `
  -GdiName '\\.\DISPLAY2','\\.\DISPLAY3' `
  -Overlap 240 `
  -StartShow
```

On a render-only PC, binding is an operator mutation and therefore also needs a
temporary administrator-readable copy of the Server control token:

```powershell
& 'C:\ProgramData\Pixel Brightness\Bind-PixelBrightnessDisplays.ps1' `
  -ControlTokenFile D:\temporary-control-token.txt `
  -GdiName '\\.\DISPLAY2','\\.\DISPLAY3' -Overlap 240 -StartShow
```

Do not place that control token in the Node secrets directory. Securely erase
the temporary copy immediately after binding.

Run it once without `-GdiName` to print and save the inventory. `-AutoSelect`
is available only when exactly one non-primary GPU group can satisfy the output
count; ambiguity fails without changing either config. The helper also derives
the Arena canvas, for example two 1920-wide outputs with 240 pixels overlap
produce a 3600 × 1080 `PB-COMPOSITION`.
The derived one-node canvas may not exceed D3D11's 16384-pixel texture
dimension; larger rooms must be split across additional Pixel Brightness nodes.

For a shared master canvas spanning several nodes, specify the same global
canvas on every binder run and give each node its own source offset:

```powershell
# Node 1 owns the left pair. Node 2 starts at composition x=3360.
& 'C:\ProgramData\Pixel Brightness\Bind-PixelBrightnessDisplays.ps1' `
  -GdiName '\\.\DISPLAY2','\\.\DISPLAY3' -Overlap 240 `
  -CanvasWidth 6960 -CanvasHeight 1080 -SourceOffsetX 0 -SourceOffsetY 0

& 'C:\ProgramData\Pixel Brightness\Bind-PixelBrightnessDisplays.ps1' `
  -GdiName '\\.\DISPLAY2','\\.\DISPLAY3' -Overlap 240 `
  -CanvasWidth 6960 -CanvasHeight 1080 -SourceOffsetX 3360 -SourceOffsetY 0
```

The binder rejects a local span outside the global canvas and merges only that
node's stable outputs into the central Server project. It never resets another
node's geometry.

Re-running the binder is non-destructive by default. This includes the first
rebind after an upgrade has invalidated the local release gate: the central
Server project is the authority, not the installer defaults or the stale local
renderer JSON. Each selected Windows target is matched to its existing output
by exact `devicePath` first, then by a unique `adapterLuid` + `targetId`. If a
driver update changed both identities, the final fallback is the stable output
id (`<nodeId>-A`, `-B`, …) **only** when the operator supplies an explicit
`-GdiName` list in that logical order; `-AutoSelect` is never allowed to guess.
The matched output keeps its source viewport, overlap, warp mesh, blend/map,
black-uniformity map, colour/gamma/LUT, mask, processing order, name and custom
wall assignment. All existing custom wall records are retained.

If the authoritative output count, exact resolution/refresh or master canvas
does not match the requested physical topology, the binder stops before any
project/config write. Correct the Windows mode or run with the original canvas;
do not use a rebind as a calibration reset. An intentional reset must be stated
explicitly and will be warned before the commit:

```powershell
# Destructive to this node's spatial/optical calibration; other nodes are kept.
& 'C:\ProgramData\Pixel Brightness\Bind-PixelBrightnessDisplays.ps1' `
  -GdiName '\\.\DISPLAY2','\\.\DISPLAY3' `
  -Overlap 240 -ResetSpatialConfig
```

Before changing live local config, the Server, or the Show task, the binder
serializes the exact candidate into
`C:\ProgramData\Pixel Brightness\binding-transaction\generations\<transaction-id>`.
That non-reparse tree is administrator-writable and Show-read-only and contains
the immutable Node config, bind-time renderer snapshot, complete Server project
A and intended project B, and binding candidate. The candidate is inert. While
holding the release launch barrier, the binder then atomically writes and flushes
`binding-transaction\in-progress.json` schema v2. The gate binds the exact
generation path, project id, revision A→A+1, full stable project fingerprints,
Node/renderer byte hashes, output-selector digest, and binding hash. Only after
the binder holds the release barrier and proves no Show launcher, Node, or
renderer that won it earlier remains does it publish that gate. If an earlier
launcher is still live, binding aborts before any A→B mutation and old A remains
coherent. With the pre-gate black proof held, every gate-to-disable process or
power cut is black; the binder then disables/stops Show and performs a second
exact process-tree drain behind the durable gate.

Behind that gate, the binder publishes the diagnostic inventory and exports the
authoritative Server project, old local files, and selected Windows inventory to
a protected timestamped directory under
`C:\ProgramData\Pixel Brightness\backups\display-bindings`. Every local JSON
publication uses the audited write-through atomic primitive. The Server write
is an atomic revision transition and sends A as the `If-Match` precondition. A
lost POST response is not retried blindly: a GET of exact
project A permits retry, exact intended project B (identity, A+1 revision, canvas,
source, walls, every output/calibration and timeline; only the Server timestamp
is excluded) is accepted, and every other project retains the gate and fails
closed. Re-running the binder resumes this protected intent instead of creating
a new revision.

The administrator control bearer is never sent to a URL read from the
Show-writable `config` directory. Both first bind and post-upgrade bind obtain
`nodeId` and `serverUrl` from protected `secrets\installation.json`, audit its
administrator-only parent, and require the candidate or recovery Node config to
match that trusted bootstrap identity before the first Server request.

After exact B is proven, the binder writes and flushes both the generation commit
and `binding-transaction\commit.json` under the same non-replaceable parent,
re-hashes the immutable Node/snapshot/selectors, performs a fresh exact Server-B
GET, removes only the matching in-progress gate, and finally enables Show. A
power cut before gate removal therefore leaves a durable gate; if a deleted gate
reappears after a storage rollback, it also blocks Show. The historical
`config\display-binding.json` copy is informational and never boot authority,
because the interactive config parent must remain writable for the renderer
cache.

The Show launcher holds the release barrier through its final gate check,
protected-parent audit, commit/generation re-read, exact hashes, and child spawn.
It executes the immutable generation `node.json`, not the replaceable config
copy, and cross-checks release, node id, named pipe, canvas, Spout sender, GPU
LUID and every stable physical selector before opening black swapchains. If a
binding transaction is interrupted or any authority disagrees, Show stays
stopped and black while Server/Web can still run for recovery.
`Test-PixelBrightness.ps1` uses that same protected commit and immutable
generation Node config for acceptance; it never treats either replaceable
`config` copy as a committed binding.

Do not change a bound node's output selectors, physical topology, or master
canvas through a general Server/Web project edit. Run the binder again so the
change gets a new durable gate and immutable generation. Node registration does
**not** compare the Server selectors against this local physical binding; the
local selector wins during native resolution. The transaction gate—not
registration—is what prevents a stale local generation A from becoming runnable
after the Server has committed B.

For deterministic crash testing on a disposable Windows host, set
`PIXEL_BRIGHTNESS_BIND_FAULT_INJECTION` to one of
`after-in-progress-gate`, `after-show-disable`, `after-renderer-config`,
`after-node-config`, `after-server-commit`, `after-final-binding`,
`after-binding-gate-clear`, or `after-show-enable`. Reboot, verify Show remains
black, and rerun the binder without the variable. These portable tests model the
boundaries, but Windows PowerShell 5.1 on physical NTFS with real power cuts is
still the release gate.

For each Show launch, the protected launcher also generates a fresh ephemeral
renderer control token before starting either child. Native Renderer opens every
swapchain behind an independent black latch; Node can release it through local
authenticated IPC exactly once and only after strict durable-state hydration,
fresh verification/preparation of every current project cue, and a durable
prepared-state commit find no command-failure, state-recovery, or
optical-verification safety lock. The same token authenticates every config,
pattern, blank, and shutdown IPC mutation for that renderer process lifetime.
For config apply, Node also hashes the exact canonical normalized DTO it sent
and accepts READY only when both the apply receipt and a fresh native status
retain that same `configSha256`; a self-consistent receipt for another config
is rejected.
The token is neither a command-line argument nor a persistent config value.
Node removes its inherited environment copy during parsing and keeps its sole
plaintext control copy only inside the renderer bridge; a startup lock
permanently disables the separate release method while preserving authenticated
black reinforcement. The launcher removes its copy after both children inherit it. A
retained or unreadable Node state therefore never exposes content during the
renderer-before-Node startup interval.

Local hydration alone is not release authority. Node stays behind the latch
until its first authenticated Server registration returns a current
output-scoped project plus durable acknowledgement/latest command cursors, the
two cursors prove neither the Node state file nor Server history rolled back,
and every cue in that authoritative project has again passed cache, native
prepare, and durable-state reconciliation. If an old locally scoped cue now
returns 403 after output reassignment, Node does not request broader media
access: it remains black, registers, applies the new scoped snapshot, and
reconciles only the newly authorized cues. Missing/rolled-back cursor evidence
and truncated history persist a state-recovery safety lock; startup never
resets `lastSequence` to zero or skips to the earliest retained command.

After binding, run from **Windows Terminal (Administrator)**:

```powershell
.\deploy\windows\Test-PixelBrightness.ps1 -Full
```

For `Role Node`, pass the same temporary `-ControlTokenFile` during acceptance,
then remove it. The long-running Show/Node processes receive only
`PIXEL_BRIGHTNESS_NODE_TOKEN` and cannot call operator routes or impersonate a
different node.

Release acceptance requires a two-hour run at the target frame rate, cold boot
and hot-plug recovery, sender-loss fail-to-black, and a high-speed-camera check
across every overlap. Software pacing is not hardware frame lock; installations
whose moving overlap cannot tolerate the measured phase difference need
compatible NVIDIA RTX PRO Sync/Mosaic hardware.

`-Full` is deliberately role-aware and strict. `Server` checks the Server/Web
tasks, API and exact Private-profile firewall rules. `Node` authenticates to the
configured central Server, proves that its registration and heartbeat are fresh,
proves that the authoritative project revision and this node's physical output
identities still contain the committed binding, then checks the Show task,
protected binding and native renderer. `All` performs both sets. On render
nodes, the telemetry revision, node and adapter must match
the active config; live Node/native display selectors must still match the
protected binding; `PB-COMPOSITION` must remain connected at the configured
frame rate; and every configured DXGI output must advance both its accepted
submission counter and independent flip-model `PresentCount`,
`PresentRefreshCount`, `SyncRefreshCount` and `SyncQPCTime` evidence during a
2.5-second observation window. Submission failures, occlusion, physical
counter discontinuities, skipped present IDs, repeated refreshes and late
intervals may not increase. Actual new Spout frames, accepted submissions and
monitor-presented image/refresh counts must stay within 5% of the exact
configured rational (with a two-frame sampling floor). The gate fails when
physical statistics are absent, disjoint or older than one second; it never
turns unknown display timing into zero faults.
The physical timing portion requires the bound production setting
`vsync:true`; tearing/immediate mode has different queue semantics and cannot
pass this cadence contract.
The test then sends an authenticated identify command through the Server, waits
for the owning Node's durable `ackSequence`, and confirms in native telemetry
that the selected output shows `identify` while every other output is isolated
to black. A `finally` path always sends content restore, waits for its separate
acknowledgement, and requires every native output to report active, non-blank
`content` with the Spout source still connected. Expect the first bound
projector to flash the identify pattern briefly during `-Full`.
Web Control's `RUNTIME LIVE` badge is intentionally narrower: it means the
Node heartbeat currently reports a connected/ready renderer, connected Spout
source and registered runtime outputs. It is not a stored physical acceptance
record and never replaces `-Full`, the soak run or the camera phase check.
This proves short-window software cadence and advancing Windows display
statistics, not photon timing or scanout phase; the high-speed-camera gate above
remains mandatory. Microsoft documents that `GetFrameStatistics` can be
unreliable in some multi-monitor scenarios, so an unavailable result fails this
gate rather than being reinterpreted as success. A stale heartbeat/telemetry
file, stale physical statistics, or a merely running process cannot pass.

### Canon EOS R50 measured calibration

The default installer profile is `CanonR50RfS1018`. It records
`cameraBackend: "canon-edsdk"`, the exact `EOS R50` body and
`RF-S10-18mm F4.5-6.3 IS STM` lens contract, but deliberately leaves
`cameraHelperCommand` and `cameraRuntimeManifestPath` unset. It also publishes
the protected camera authority in the `unconfigured` state. Measured
calibration therefore remains unavailable until a separately licensed,
hardware-tested Canon EDSDK runtime is provisioned; the source package does not
bundle Canon EDSDK or claim that helper as complete.

Provisioning is a separate administrator-only transaction through
[`Provision-PixelBrightnessCanonCamera.ps1`](Provision-PixelBrightnessCanonCamera.ps1).
It requires an independently supplied SHA-256 for the exact x64 runtime
manifest and the expected EOS R50 serial number, copies only the manifest-bound
helper and SDK files into the protected camera-runtime generation, and publishes
the authority only after path, size, digest, PE architecture and ACL checks
pass. Interrupted provisioning keeps Show fail-closed and restores the exact
prior authority before clearing its durable gate.

Measured runs use two exposure profiles: a short, unclipped geometry pass and a
long, repeated radiometry pass. The operator must explicitly confirm the exact
sensor-dark and projectors-off ambient conditions in Web Control; confirmations
are bound to one session and capture step and cannot be replayed. Use single-shot
14-bit CR3 capture, ISO 100, mechanical/EFCS shutter, fixed 10 mm focal length,
manual focus, f/5.6, fixed white balance, and disabled stabilisation, lens
correction, noise reduction and tone processing. The helper must retain the
sensor black level and report the exact exposure/lens/pipeline provenance for
every capture or the run fails closed.

`Test-PixelBrightness.ps1 -Full` invokes the protected
[`scripts/probe-camera-helper.mjs`](../../scripts/probe-camera-helper.mjs) path
and accepts only one exact USB EOS R50, the locked RF-S 10-18 lens at 10 mm and
an uncompressed or lossless-compressed 14-bit CR3 capture. A configured manifest
without successful physical detection and capture does not pass acceptance.

A committed project revision is not an optical pass. Web Control reports the
renderer acknowledgement separately and keeps optical verification pending
until a post-apply camera recapture has measured alignment, seams, black floor
and colour residuals. The provision transaction and physical probe above are
the deployment gates for the bounded helper/file contract and hardware
acceptance.

## Files and tasks

| Item | Location |
| --- | --- |
| Immutable releases | `C:\Program Files\Pixel Brightness\releases` |
| Current release pointer | `C:\ProgramData\Pixel Brightness\current-release.txt` |
| Node/renderer configuration | `C:\ProgramData\Pixel Brightness\config` |
| Persistent Server/Node state | `C:\ProgramData\Pixel Brightness\state` |
| Protected Server/Web logs | `C:\ProgramData\Pixel Brightness\logs\system` |
| Interactive Node/renderer logs | `C:\ProgramData\Pixel Brightness\logs\show` |
| Durable upgrade boot gate | `C:\ProgramData\Pixel Brightness\upgrade\in-progress.json` |
| Durable display-binding gate | `C:\ProgramData\Pixel Brightness\binding-transaction\in-progress.json` |
| Immutable display-binding authority | `C:\ProgramData\Pixel Brightness\binding-transaction\commit.json` and `generations\<transaction-id>` |
| Local recovery command | `C:\ProgramData\Pixel Brightness\Recover-PixelBrightnessUpgrade.ps1` |
| Server task | `PixelBrightness-Server` |
| Web task | `PixelBrightness-Web` |
| Interactive node/renderer task | `PixelBrightness-Show` |
| Weekly SYSTEM worker (`Role All`) | `PixelBrightness-Schedule` |
| One-shot local Arena helper (`Role All`) | `PixelBrightness-Schedule-Interactive` |
| Weekly schedule configuration | `C:\ProgramData\Pixel Brightness\state\server\show-schedule.json` |
| Durable schedule runtime/checkpoints | `C:\ProgramData\Pixel Brightness\state\server\show-schedule-runtime.json` and `state\schedule` |

`Start-PixelBrightness.ps1` launches Server, Web and Show. `ShowSchedule.ps1`
launches the weekly worker and its bounded interactive Arena helper. They set
a stable working directory, record stdout/stderr, and keep the visible
renderer in the interactive user session.

The Node publishes `config\renderer.json` only after flushing the temporary
file and retains the previous flushed document as
`config\renderer.json.last-known-good.json`. If the primary document is
missing or invalid after an interrupted write or power loss, the Show launcher
restores the LKG through the same write-through atomic publication primitive
used by upgrades, then reruns every display-binding check before starting the
native renderer. If neither document is valid, Show remains stopped and black;
it never synthesizes a renderer configuration.

`config\renderer.json` is deliberately a mutable cache, not physical-binding
authority. A later strictly hydrated Server revision can legitimately cause Node
to rewrite it. On a later Show restart, the launcher still requires the immutable
bind-time renderer snapshot hash for audit. A changed cache is accepted only at
an exact revision strictly above the bind-time native revision and only when node id, pipe, adapter,
canvas and the complete physical-selector digest still match the immutable
commit. Native remains behind its fresh boot-black latch until Node re-registers,
strictly hydrates current Server authority, applies it, verifies the exact native
receipt/status digest and durably persists the cache. A cache mismatch is never
treated as authority and fails closed.
