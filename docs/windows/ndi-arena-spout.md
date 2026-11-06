# NDI into Arena, local Spout into Pixel Brightness

The supported Windows signal path is:

```text
exact NDI sender
        │ NDI (local host or wired show network)
        ▼
Resolume Arena on the Windows render PC
        │ one local GPU texture: PB-COMPOSITION (Spout)
        ▼
Pixel Brightness native renderer
        │ Area, mesh, blend, mask, black, colour and scanout
        ▼
arbitrary named projector surfaces
```

**Direct NDI input to Pixel Brightness is unsupported.** The Pixel Brightness
release bundles a Spout receiver, not an NDI receiver, NDI SDK/runtime, or an
NDI-to-Spout bridge. Arena is the supported NDI receiver and composition
boundary; its output to Pixel Brightness must remain local Spout.

The authoritative project and native renderer therefore keep:

```json
{
  "compositionSource": {
    "type": "spout",
    "senderName": "PB-COMPOSITION"
  }
}
```

Resolume documents that NDI senders appear as inputs in Arena's Sources tab,
and that Spout can publish a separate local output:

- [Resolume NDI inputs and outputs](https://resolume.com/support/en/NDI_inputs_and_outputs)
- [Resolume Syphon and Spout](https://resolume.com/support/syphonspout)

## Supported one-PC and two-PC topologies

### One PC

The NDI sender, Arena, and Pixel Brightness may run on the same Windows render
PC. Arena still receives the exact named NDI source, composes it, and publishes
`PB-COMPOSITION` locally through Spout. Arena and Pixel Brightness must run in
the same interactive show session and use the same NVIDIA GPU.

### Two PCs

The source PC sends NDI over a dedicated wired show network to Arena on the
Windows render PC. Arena and Pixel Brightness both remain on that render PC;
only the NDI leg crosses the network. Spout cannot cross PCs.

```text
source PC ── NDI over wired LAN ──> render PC: Arena ── local Spout ──> Pixel
```

Do not run Arena on the source PC and expect `PB-COMPOSITION` to reach Pixel on
the render PC through Spout. For multiple render PCs, each PC needs its own
local Arena receiver and local `PB-COMPOSITION`. Separate Arena instances are
not frame locked; keep overlapping projector outputs on one GPU/render node.

## Exact NDI source selection

1. Record the full advertised NDI identity exactly as shown by the sender and
   receiver, including host and source components such as
   `SOURCE-PC (SHOW-FEED)`. Do not select the first discovered source or a
   look-alike name.
2. In Arena **Sources**, select that exact source, place it in a dedicated saved
   show clip, trigger it, and record the clip/deck location in the show sheet.
3. Stop if Arena shows a red **Offline** mark or `0x0` dimensions. Discovery is
   not proof that video frames can be received.
4. Feed a moving frame counter or clock from upstream during rehearsal. Confirm
   that it advances in Arena before accepting the downstream path.
5. Remove or clearly label unused look-alike inputs. Never silently substitute
   a different sender during recovery.

## Wired-network operator preflight

For a two-PC show, use a provisioned wired network. The NDI Tools Windows
requirements specify a 1 Gbps LAN as a baseline; higher resolutions, multiple
receivers, or multiple sources may require more capacity. Avoid Wi-Fi for the
show feed and use NDI Access Manager/NIC selection when the render PC has more
than one active adapter.

Before opening the accepted Arena composition:

1. On the render PC, open official NDI Studio Monitor and select the exact
   recorded source.
2. Confirm the expected raster, frame rate, moving counter, and uninterrupted
   motion. Treat a red dropped-frame indicator as a failed preflight.
3. Confirm Arena sees the same exact source with non-zero dimensions and no
   Offline mark.
4. Close Studio Monitor before the show gate unless it is deliberately retained
   as a separately capacity-tested receiver.

NDI Tools/Studio Monitor are external operator diagnostics, not components
installed or launched by Pixel Brightness:

- [NDI Studio Monitor](https://docs.ndi.video/all/using-ndi/ndi-tools/ndi-tools-for-windows/studio-monitor)
- [NDI Tools for Windows requirements](https://docs.ndi.video/all/using-ndi/ndi-tools/ndi-tools-for-windows)
- [NDI NIC selection](https://docs.ndi.video/all/getting-started/white-paper/nic-selection)

## Arena to `PB-COMPOSITION`

1. Match Arena's Composition width, height, and exact frame rate to the Pixel
   Brightness master canvas.
2. In **Output → Advanced**, create exactly one Spout screen named
   `PB-COMPOSITION`.
3. Give it one rectangular 1:1 slice covering the complete clean Composition.
4. Do not apply projector Area, warp, blend, mask, black correction, or colour
   correction in Arena. Those belong to Pixel Brightness and its named-surface
   project.
5. Do not route the Arena Spout screen to a physical projector display.

## What acceptance proves

`SPOUT LOCKED`, `RUNTIME LIVE`, and
`Test-PixelBrightness.ps1 -Full` are authoritative only from the local
`PB-COMPOSITION` handoff onward. The Windows acceptance checks the exact Spout
sender contract, advancing received-frame telemetry, dimensions, format,
cadence, every committed native output, and physical DXGI presentation. It then
identifies every committed output regardless of surface name and restores all
outputs to content.

Those signals do **not** prove the upstream NDI source identity, NDI packet
health, or that Arena has not substituted, held, or generated a frame. Never
label Pixel's green runtime state as “NDI ready.” The Studio Monitor and Arena
checks above are operator evidence and must be recorded separately.

## Fail-to-black boundary

- If Arena exits, `PB-COMPOSITION` disappears, stops advancing, changes size,
  format, or cadence, or is renamed, Pixel Brightness rejects it and drives the
  projector outputs to black according to the local Spout safety contract.
- If NDI fails but Arena continues publishing a technically valid Spout texture
  containing a held frame, local fallback, or black, Pixel Brightness cannot
  distinguish that from intentional content. Automatic fail-to-black on the
  NDI leg is outside this release's observable boundary.

During rehearsal, disconnect the NDI sender and record Arena's actual behavior;
then stop Arena separately and prove Pixel fails black on Spout loss. A show
that requires automatic black specifically on NDI loss is not accepted by the
Pixel-only gate until an independently observable upstream watchdog is designed
and validated.

## Show-day sequence

1. Pass the wired-network/Studio Monitor preflight when NDI crosses PCs.
2. Open the frozen Arena composition and prove the exact NDI source is live and
   moving.
3. Confirm exact canvas/rate and the local `PB-COMPOSITION` Spout screen.
4. Start Pixel Brightness and require the frozen project revision live on every
   renderer.
5. Run:

   ```powershell
   & 'C:\ProgramData\Pixel Brightness\Test-PixelBrightness.ps1' -Full
   ```

6. Visually confirm every Identify flash appears on its intended named surface
   and that all outputs return to content.
