# Two-projector commissioning — 2026-09-06

## Confirmed identities (not a live output configuration)

| Position | Address | Observed device | Evidence |
| --- | --- | --- | --- |
| Left | 192.168.68.34 | Magewell Pro Convert; exact submodel unknown | User confirmed position; web page branding |
| Right | 192.168.68.31 | Kiloview N6 | User confirmed position; device web configuration and login title |
| Mapping PC, show LAN | 192.168.68.50/24 | MAPPINGPC | Windows interface inventory |
| Mapping PC, management Wi-Fi | 192.168.1.200/24 | MAPPINGPC | Windows interface inventory and SSH |

Do not treat either decoder IP as a Panasonic projector control address or a Windows display identity. Do not assume both receivers are Magewell. Current NDI subscriptions, decoder output timing and firmware versions have not been verified through authenticated device controls.

## Verified components

- EOS R50 USB video capture: real 1920 × 1080 RGB24 frames acquired on the Mapping PC. Processed video only, not RAW. Manual exposure/white-balance/focus lock and optical pattern synchronization remain unverified.
- Official NDI SDK 6.3.2 installed on Windows and used for native compilation.
- Isolated native tests: 11/11 passed, including actual local NDI send/receive.
- GPU test on NVIDIA RTX A400: correction pipeline, two 1920 × 1080 offscreen crops, readback, NDI send and local receive passed color/black checks.
- The GPU diagnostic does not demonstrate sustained frame rate, external receiver delivery, projector synchronization, or measured Auto calibration.

See `network-output-development.md` and `uvc-camera-development.md` for component evidence and remaining implementation work.

## Access boundary

Both decoder web interfaces respond through the Mapping PC but require login. No decoder credentials have been provided. The N6 login also displays a preselected agreement checkbox; no sign-in or agreement submission was performed. Previously supplied Panasonic credentials were not tried on these unrelated devices.

Temporary local forwarding, while the SSH session remains alive:

- http://127.0.0.1:18334/ → left receiver
- http://127.0.0.1:18331/ → right receiver

These loopback links are temporary, not installed services or a permanent control URL.

### Windows-only follow-up after operator sign-in

The operator subsequently reported logging in and pulling the images. Mac UI access was unavailable because the Mac was locked; no attempt was made to bypass the lock or extract browser sessions. The following checks were performed directly through SSH on MAPPINGPC instead.

The new isolated `pixel-brightness-ndi-probe.exe` was compiled and run in
`C:\ProgramData\Pixel Brightness Build\ndi-dev-20260906\build\Release`.
It discovers sources and can receive one exact named source for five seconds. It does not publish sources, send tally/control commands, or alter decoder subscriptions. Receiving adds a temporary consumer; no receiver remains after the process exits.

Observed discovery: `MAPPINGPC (Arena - Composition)` and `MAPPINGPC (Arena - S1)` through `S5`.

| Check | S1 | S2 |
| --- | --- | --- |
| Received format | 1920 × 1080, 60/1 fps metadata | 1920 × 1080, 60/1 fps metadata |
| Frames returned in approximately 5.009 seconds | 282 | 286 |
| SDK-reported dropped video frames | 0 | 0 |
| Observed timecode regressions | 0 | 0 |

These short counts include connection startup and do not certify sustained 60 fps or physical projector delivery. Sampled RGB statistics show nonzero pixel values, not verified optical black level or a visual assessment of the content.

Windows TCP telemetry for the live Arena process independently showed:

- `192.168.68.34` connected to Arena at `192.168.68.50:5962`, matching the discovered S1 service port.
- `192.168.68.31` connected to Arena at `192.168.68.50:5963`, matching the discovered S2 service port.

This supports **left = S1 / right = S2** as the current network routing. Discovery selected the PC's Wi-Fi address when listing source URLs, but the external decoder connections above use the show Ethernet address. Do not change network bindings solely because the local discovery URL lists Wi-Fi.

Camera recheck: Media Foundation enumerated only four `NDI Webcam Video` virtual inputs. Windows present-device enumeration did not find Canon/R50 as a camera or portable device. Earlier successful R50 capture is historical evidence, not proof that the camera is currently attached. Physical R50 availability must be restored before a fresh Auto capture can run.

Production renderer, Arena composition and existing blends remain unchanged.

## Preservation and readiness

- Existing Arena composition, manual blending, receiver subscriptions and physical output have not been changed by the NDI diagnostics.
- Development binaries have not replaced the installed production renderer.
- UVC Auto Geometry orchestration and corrected NDI video now have a separate
  Windows Web preview; see `ndi-video-preview.md`. Measured application,
  physical verification and production integration remain incomplete. Do not
  label this installation Auto-ready based on the component tests.
- Before changing a receiver source: authenticate, record/export its current subscription and timing, and back up the Arena composition/Advanced Output and Pixel configuration. Verify which system owns blending to avoid applying it twice.
- Then test target-isolated patterns, fresh R50 capture, geometry solving, output correction and measured before/after verification on both physical projectors. Test receiver latency independently because the models differ.
- The eventual five-projector/10% overlap requirement is not certified by this two-output local diagnostic.
