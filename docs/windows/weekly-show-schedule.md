# Weekly show schedule on Windows

The all-in-one Windows `Role All` installation includes a local weekly scheduler for the
complete Arena → Pixel Brightness → five-projector show path. It does not use a
cloud service and it does not store a Windows password. In this role,
`PixelBrightness-Show` is an enabled interactive task with no automatic trigger;
the weekly worker is its sole automatic owner. A standalone `Role Node` keeps
Show-at-logon and does not install this weekly worker.

## One-time prerequisites

1. Finish physical display binding and verify `PixelBrightness-Show` can run.
2. Configure exactly five Panasonic PT-VMZ51 rows on **Projector Control** and
   verify each LAN command/status response.
3. In BIOS/UEFI, configure RTC power-on for the same operating weekdays. BIOS
   and Web Control are separate calendars and are not synchronized. Set BIOS
   wake before the Web Start time, and leave enough boot/Arena/projector-warmup
   margin before the customer needs the room ready.
4. Configure Windows to sign in automatically to the dedicated, standard local
   Show account. Arena and the DXGI renderer require that local interactive
   session; neither is allowed to run in Session 0 or through RDP. Pixel
   Brightness deliberately does not ask for or save that account password.
5. Set the Windows time zone and clock correctly. Schedule decisions use the
   render PC's local Windows time.

BIOS/UEFI remains the authority that can turn on a physically powered-off PC.
The Web schedule begins only after Windows has booted. Keep BIOS wake weekdays
aligned with the Web schedule and disable closed days in both places. On a disabled weekday the worker intentionally
does not launch Arena, power projectors, or issue a surprise shutdown; an
accidental maintenance boot therefore remains on for an operator to inspect.

## Configure from Web Control

Open `http://localhost:3000`, choose **Show Schedule**, and enter:

- the exact Windows render node ID, normally the ID used during display bind;
- the absolute path to the installed Resolume Arena `.exe`;
- the absolute path to the production Arena `.avc` composition;
- each active weekday, local start time, and local shutdown time;
- projector command stagger and warm-up time.

Use **WEEK OFF** for the customer's regular closed week or disable individual
days. The preset only edits the draft. Select **SAVE WEEKLY SCHEDULE** to commit
it; saving the form never starts or stops equipment immediately.

Each save creates a new revision. If it is saved after today's Start boundary,
that revision waits for the next enabled day and is not treated as a catch-up
instruction. Once a run has started, the worker pins that revision, the exact
Arena target, projector IDs, projector IP-binding revision and original
shutdown time. Later edits—including changing a time or disabling the
day/master—cannot move or cancel that active run's safe shutdown. If Projector
Control is rebound during a run, scheduled commands fail closed instead of
targeting the new IP mapping; the operator must inspect/restore the original
projector group.

## Scheduled startup

For an active day, a late Windows boot still catches up once while the current
time is between Start and Shutdown only when that revision was armed before
today's Start boundary:

1. wait for the local Pixel Server;
2. require the bound `PixelBrightness-Show` task and the local Show-user session;
3. validate the exact five-projector inventory;
4. start the Pixel Brightness renderer/node;
5. open the exact Arena executable with the exact `.avc` composition in the
   Show-user desktop;
6. wait until the selected node is ready and native telemetry reports
   `PB-COMPOSITION` as `connected`;
7. send explicit Panasonic power-on commands to all five configured projector
   IDs, staggered by the saved interval;
8. wait for warm-up, refresh every projector, and require online, power-on,
   light-on status before reporting **READY**.

The worker persists an active-run snapshot and a checkpoint before each side
effect. A crash or power loss therefore cannot replay an uncertain
Arena/projector start automatically. A partial failed startup remains tracked
and still receives the pinned shutdown cleanup; if Arena launch identity is
uncertain, shutdown blocks for local inspection instead of guessing a process.

## Scheduled shutdown

Shutdown uses this fixed order:

1. focus the exact recorded Arena process;
2. send `Ctrl+S`;
3. wait, require Arena to remain responsive, and request normal window close;
4. require that exact Arena process to exit without force termination;
5. send standby to the explicit five-projector group, poll LAN status, and
   require every unit to report power/light standby;
6. stop `PixelBrightness-Show`;
7. request normal Windows shutdown with `/t 0` and without `/f` or forced
   application closure.

If Arena cannot be focused, saved, or closed, the worker records
`SHUTDOWN-BLOCKED` and stops the sequence. It does **not** put the projectors in
standby, stop the renderer, force-kill Arena, or shut down Windows. A failed or
uncertain projector standby also blocks Windows shutdown so the operator can
inspect the room.

Each active run is bound to the Windows boot that created it. If Windows loses
power or reboots before the final shutdown request, the next boot never repeats
that overdue Windows shutdown. It retires the old renderer/projector session,
keeps the new Windows session on, and reports an error so the operator checks
the Arena composition. A final shutdown request is also tombstoned by boot
identity so it cannot become a boot→shutdown loop.

## First supervised test

Before unattended use, test one start and one shutdown with temporary times at
least ten minutes apart. Confirm all of the following physically:

- Windows auto-logon reaches the intended local Show account;
- the exact production `.avc` opens;
- Arena publishes `PB-COMPOSITION` and the Show Schedule page reaches **READY**;
- all five projectors turn on and show the correct mapped outputs;
- a harmless Arena edit is saved before Arena closes;
- all five projectors enter standby before Windows powers off.

Also test the fail-closed path once by leaving an Arena confirmation dialog
open: Windows must remain on and Web Control must show `SHUTDOWN-BLOCKED`.

The installed tasks are:

- `PixelBrightness-Schedule`: long-running SYSTEM worker, triggered at startup;
- `PixelBrightness-Schedule-Interactive`: bounded one-shot Arena helper running
  only as the signed-in Show user;
- `PixelBrightness-Show`: enabled, no-trigger interactive renderer/node task
  started automatically only by the weekly worker after display binding is valid.
