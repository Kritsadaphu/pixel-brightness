# USB SDR Black/RGB patch — 7 September 2026

## Implemented and deployed to the separate Windows Control preview

- Optional Gray-code + neutral RGB ramp acquisition through the existing Media Foundation USB capture helper, without Canon EDSDK.
- Streaming camera-space measurement, per-output inverse neutral-response LUT, common brightness reference, coarse measured Black lift map allocated by geometric blend weights.
- Exact device/digest/frame timing checks, clipping rejection, monotonic response checks, repeated-reference drift checks, and rejection of unmeasured active Black tiles or >15% spatial response variation.
- Opt-in acknowledgement of locked exposure/white balance/focus and an **assumed sRGB camera response**. Processed USB video is not RAW. This is an experimental neutral RGB matching model, not calibrated colorimetry, HDR radiometry, spectral correction, or proof of optical synchronization.
- Generated Blend/Black/LUT artifacts are digest-bound. Apply backs up the saved project, replaces the intended corrections together and rejects revision drift or damaged files. Restore returns the previous project within the current API session.
- Physical before/after verification and `productionAutoReady` remain false. No real R50 image was available for this run; Windows PnP did not show a Canon camera and UVC listed only NDI Webcam virtual devices.

## Native NDI buffer reuse

Profiling identified per-frame RGBA allocation/zeroing as a substantial expense. The sender now returns one bounded reusable buffer only after a synchronous NDI send has completed (or when a queued frame was replaced before sending). The D3D owner still maps/unmaps and overwrites every byte; no mapped GPU memory is handed to a transport thread. Stop, blank and source-loss handling remain in place.

Five 1920×1200 local decoded outputs, NVIDIA RTX A400, synthetic 1920×1200 input repeated across five outputs:

- Before reuse: approximately 21.5–22.3 observed fps/channel at target 30.
- After reuse: approximately 29.17–29.37 fps/channel at target 30; all channels contained expected image values, no decoder-reported drops in this bounded run.
- At target 60 with a matching 60 fps synthetic source: approximately 32.6–33.6 observed fps/channel; **60 fps acceptance failed**.
- Four rounds of approximately five seconds of decode per channel, with discovery gaps. This is a short capacity test, **not a multi-hour continuous soak**, full-width Arena-composition test, wired-LAN capacity certification, receiver synchronization test, or five physical projector acceptance. Bundle preparation was also running in the background; do not treat this as an unloaded benchmark.
- Both native processes submitted their stop-black frames and exited. This does not prove physical black on projectors.

Detailed machine reports: `usb-photometry-ndi-evidence-20260907.json`.

## Receiver accounts

`deploy/windows/Configure-PixelBrightnessReceivers.ps1` provides local masked password entry, saved-output selection, explicit Magewell/Kiloview API kind and DPAPI encryption for the signed-in Windows account. It does not switch receivers. The preview launcher imports credentials into its process environment; it does not persist plaintext environment settings. `scripts/check-ndi-receivers.mjs` checks login/current selection without a select/route call.

No account was guessed or installed. Current project identifies A as Left test A and B as Right test B; user-provided decoder addresses are left 192.168.68.34 and right 192.168.68.31. Decoder credentials are not the Panasonic projector credentials. Live source switch/restore still requires those accounts and a hardware check.

## Save, scheduling, and installer

The staged scheduler now requires the scheduled composition file to show a new, stable on-disk save after Ctrl+S before closing Arena. A blocked save, Save As dialog, different opened file, missing file or unchanged disk evidence blocks shutdown. Windows fixture tests verify this without touching Arena. This proves a stable file write, not that every external media asset was collected.

The new helper is included in installation and upgrade snapshots, with exact compatibility profiles for prior snapshots. **The production scheduler was not replaced or enabled during this patch**; full upgrade/rollback and power-cycle acceptance are still required. The existing show scheduler and isolated NDI preview are not yet a certified single unattended NDI show stack.

The separate Control Installer builder includes compiled UVC/NDI executables and npm dependencies, with a complete file manifest and read-only validation. It requires Windows x64, installed Node.js 22.13+ and the installed NDI 6 SDK runtime. It intentionally does not redistribute the third-party NDI runtime, include credentials/project data, replace the running production release, or automatically power projectors/shut down the PC. A new install uses a separate local folder; existing running ports block replacement.

## Verification and remaining acceptance

- Local suite: 585 tests, 579 passed, six platform/hardware skips, zero failures at the recorded full run; typecheck and web build passed.
- Windows processed-USB fixture through capture → artifacts → Apply/Restore and tamper rejection passed.
- Windows save/DPAPI runtime tests passed. Neither used real credentials or closed Arena.
- Still required: real R50 detection/capture with locked settings, physical before/after evaluation, decoder credentials and actual route/restore, full-size real Arena composition sustained throughput, complete production promotion and unattended weekly start/Save/standby/shutdown/BIOS boot acceptance with the actual configured devices and times.

Do not describe this patch as “only plug in the camera” or fully automatic production-ready.
