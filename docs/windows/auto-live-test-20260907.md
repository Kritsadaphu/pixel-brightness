# Auto acquisition live test — 7 September 2026

## Installed and tested

- Pixel isolated preview runs on Windows, Web 3001/API 4101. Arena was not closed or reconfigured.
- Fixed locally generated NDI patterns whose SDK sender identity contains an empty address. For these exact UUID-qualified pattern names only, receiver discovery resolves the endpoint on the explicitly configured NDI host `192.168.68.50`. Ambiguous results and arbitrary empty-address names are rejected. Receiver setup retains this host when the same receiver is edited.
- New read-only UVC `--controls` command and authenticated `/v1/calibrations/uvc-geometry/controls?deviceId=...` endpoint inspect available camera controls. No camera settings are changed; unsupported controls never assert a manual lock.
- Empty black/white reference contrast now stops acquisition before a long Gray-code scan. Scene drift failures retain numeric details for subsequent tests.
- A failure before receiver mutation no longer falsely reports that receiver recovery is required when the routing journal has no pending operation.

## Physical observations

A fresh Canon USB frame was captured at 1920x1080/30 and inspected. It shows the room wall and active projection. Evidence: `outputs/windows/canon-current.png`.

The live geometry job `b210abe0-e32a-40c8-9d66-c5eddf489402` routed both decoders to isolated Pixel sources and confirmed NDI connections. It captured all 48 reference/Gray-code frames for output A, then rejected that pass because the initial and final black/white references differed beyond the 8% criterion. It did not reach output B or apply a candidate. Decoder routing returned to Arena S1 on the left and S2 on the right with no pending recovery. Evidence: `outputs/windows/auto-geometry-live-20260907.json`.

Read-only inspection while Canon was present reported unsupported exposure, focus, iris, white-balance, gain, and gamma controls through the queried USB interfaces. This is not proof that the camera is in Auto; it means this software path cannot read or lock those settings.

Before a short reference-repeat test could start, Canon disappeared from the Windows camera inventory; only four NDI Webcam devices remained. That test therefore made no receiver changes and produced no photometric measurements. Battery condition and the reason for disconnection are unverified.

## Next physical prerequisite

Restore the Canon USB video connection and inspect the camera's own settings. Use Movie manual exposure, fixed ISO, fixed white balance, and fixed focus for measurement; do not assume ordinary still-photo M mode or Auto ISO provides a fixed video exposure. Keep room lighting and the camera position unchanged. No calibration pass is certified until a repeated reference test and both output scans succeed.

Official instructions: [Canon R50 movie manual exposure](https://cam.start.canon/en/C011/manual/html/UG-05_Shooting-2_0030.html), [Canon R50 USB streaming](https://cam.start.canon/en/C011/manual/html/UG-09_Set-up_0230.html).

Validation: native Windows UVC build succeeded; application build succeeded; 596 tests, 590 passed, 6 platform skips, no failures. Production Auto, black/color calibration, five-projector performance, and scheduled power-cycle acceptance remain unverified. The previous R2 installer predates these patches.
