# R50 SDK-free USB acquisition — 6 September 2026

## Delivered scope

A Windows Media Foundation single-frame capture executable and an isolated,
loopback-only camera diagnostic page. No Canon EDSDK or EOS Webcam Utility
dependency. Requires Windows Media Foundation and Node.js 22+ for the page.
This is not the full Pixel installer or automatic calibration implementation.

Installed separately on MappingPC:

`C:\Users\CPU_Mapping\Desktop\Pixel-Brightness-UVC-Check`

Open **http://localhost:4310/** on that Windows computer. The desktop shortcut
is **Pixel Brightness USB Camera**. For a later session, run
`START-UVC-CHECK.cmd` in the diagnostic folder, then open the URL. Do not run a
second instance if the page already works. Close that console to stop it.

During development a temporary task, `PixelBrightness-UVC-Diagnostic-20260906`,
starts the diagnostic in the interactive session with no triggers, no startup
registration, and a four-hour execution limit. To stop that development instance:

```powershell
Stop-ScheduledTask -TaskName 'PixelBrightness-UVC-Diagnostic-20260906'
Unregister-ScheduledTask -TaskName 'PixelBrightness-UVC-Diagnostic-20260906' -Confirm:$false
```

Neither the app's weekly schedules nor production tasks were changed.

## Camera operation

R50: Set-up → Choose USB connection app → Video calls/streaming, then reconnect
USB. Canon documents 1920×1080 at 30fps in this mode:
https://cam.start.canon/en/C011/manual/html/UG-09_Set-up_0230.html

Select the actual camera explicitly; no selection by device index or automatic
substitution. Click **รับภาพทดสอบ 1 เฟรม**. Each request opens the device,
negotiates exactly 1080p30, discards eight startup samples, reads one frame and
releases the device. Close competing camera apps if capture reports busy.
This is a snapshot diagnostic, not continuous video playback. The discarded
frames do not establish projector synchronization or manual exposure lock.

The helper converts Media Foundation RGB32 to top-down encoded RGB24 with
bounded stride/row handling. It does not linearize samples or claim sensor RAW.
The native process has a bounded parent timeout (15 seconds), no shell command
interpolation, a bounded binary frame output, and a single-request busy lock.
No image is retained by the web server; command-line probes deliberately save
new BMP and JSON evidence files without overwriting existing evidence.

## Verified on the real Windows machine

- MSVC x64 Release build of `pixel-brightness-uvc.exe` succeeded.
- Windows native CTest: **10/10 passed**, including the new UVC RGB order,
  padding, negative stride and invalid-buffer tests.
- Selected local Node tests: **14/14 passed**, including existing Canon RAW
  substitution rejection and native correction binding tests. These are not a
  claim that the complete project test suite passes.
- Real device enumerated as **Canon Digital Camera**, USB VID `04a9`.
- Native capture through the new Node adapter returned real 1920×1080 RGB24,
  30/1 fps metadata, **6,220,800 raster bytes**.
- `r50-first-uvc.bmp`: **6,220,854 bytes**; raster SHA256
  `a0af6a13185cf49359014b1525b1d808ed642c1ada1eacc91511aaad9c78985c`.
- Viewed the captured image: actual purple/blue content on the projection wall,
  with room/floor visible. This proves acquisition, not geometric accuracy or
  colorimetric correctness.
- Local diagnostic GET `/` and POST `/capture` returned HTTP 200. The second
  capture produced a different raster SHA256:
  `f987963efec95226416e5d6b289b1026e69903a40a1a4ee595f8f8dc1c1d98cf`.
- Arena PID 11888 remained responsive; Pixel `/v1/health` reported `ok: true`.
- Installed renderer SHA256 stayed
  `4a54076b1f75444801ae6df66644196bf492df72d7d84325c3ef42b58404aa3c`.

## Still required for Auto

1. Integrate a separate processed-video geometry session into Pixel; never feed
   UVC frames into the linear-RAW calibration contract as if they were CR3.
2. Establish fixed camera exposure, focus and white balance; current metadata
   correctly reports `manualLockVerified: false`.
3. Project uniquely identifiable patterns through the actual output path and
   associate frames with observed pattern identity and adequate settling time.
   Current metadata correctly reports `patternSynchronized: false`.
4. Implement/test geometry solving and lens-distortion handling against the
   actual two-projector setup. Preview alone does not solve overlap/blending.
5. Complete and validate the separate NDI output integration. Existing Arena
   NDI/blending was not changed and must not receive double correction.
6. Independently characterize camera video response and clipping before using
   processed video for brightness/black-level estimation. No precision claim
   for black level, RAW, 5-projector alignment, or unattended operation yet.

## Build

Use the existing Windows toolchain and pinned nlohmann dependency:

```powershell
cmake -S native/windows -B build/uvc -A x64 -DPB_BUILD_UVC_CAMERA=ON -DPB_FETCH_SPOUT2=OFF
cmake --build build/uvc --config Release --target pixel-brightness-uvc pbwin-uvc-buffer-tests
```

The target is opt-in and is not installed over the production renderer. Media
Foundation libraries come from the Windows SDK. Its software RGB conversion is
intended here for occasional frames, not a demonstrated sustained-throughput
implementation:
https://learn.microsoft.com/en-us/windows/win32/medfound/mf-source-reader-enable-video-processing
