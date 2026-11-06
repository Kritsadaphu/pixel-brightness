# Windows Control recovery — 7 September 2026

## Active installations

- Windows host: `MAPPINGPC`, management address `192.168.1.200`.
- Installed release: web `3000`, API `4100`, release `0.3.0-win-20260906141807`.
- Latest NDI/UVC preview: **on Windows** at `http://127.0.0.1:3001/`, API `4101`.
- Preview source: `C:\ProgramData\Pixel Brightness Build\control-preview-20260906\Pixel-Brightness-Windows-V3-Source`.
- Preview data: sibling `preview-data`; it is separate from production state.
- Bare `http://192.168.1.200/` is IIS, not Pixel Control.
- Preview binds loopback only: its localhost URL is for the Windows computer, not a phone. Production LAN API requires its existing access token.

## What changed

The previous preview was launched through a temporary session and did not survive a Windows reboot. The new `PixelBrightness-NDI-Preview` Windows scheduled task starts it after the configured user signs in, independently of the Mac or an AI app. It uses the interactive desktop and the existing protected installation's administrator account. It does not launch Arena, change decoder subscriptions, start NDI output/calibration, or power projectors.

Installation/update from an administrator PowerShell window belonging to the show user:

```powershell
& '.\deploy\windows\Install-PixelBrightnessPreviewStartup.ps1' -SourceRoot (Get-Location).Path
```

The task uses IgnoreNew to avoid duplicate instances and has no runtime time limit. Its wrapper retries a stopped preview pair up to three times with a ten-second delay, independently of Task Scheduler's prior retry accounting. A failed Web or API child ends the preview pair; the wrapper reports failure after exhausting retries rather than treating a null PowerShell exit code as success. This handles process exits, **not every possible unresponsive-process failure**.

Startup rebuilds the local web bundle for API port 4101 before launching either service. Logs are under `preview-data\logs\startup-*.out.log` and `*.err.log`. A `Running` task alone is not proof of readiness: check the web response and API with the browser's Origin header.

## Readiness and limits

- Confirm Web HTTP 200 and `/v1/health`, `/v1/state`, `/v1/outputs/ndi-preview`, `/v1/calibrations/uvc-geometry` on API port 4101.
- Confirm `Access-Control-Allow-Origin: http://127.0.0.1:3001` when using that Origin.
- `/v1/calibrations/uvc-geometry/devices` must actually list the intended camera. Four NDI Webcam entries do not prove the Canon R50 is connected.
- Left decoder `192.168.68.34`, right decoder `192.168.68.31`: reachable web pages do not prove live video or physical projection.
- Preview API explicitly reports `productionAutoReady: false`. Geometry is candidate-not-applied; measured-map application and full five-projector end-to-end verification remain unfinished.
- Existing release boot was slow after the user's reboot: Web log started 06:29:18 and API 06:30:18 after a 06:22:29 boot. It inventories and validates the complete release before launch. This patch does not bypass those checks or promote preview files into that immutable release.
- No Arena restart, projector power operation, production release-pointer change, or decoder subscription change is part of this recovery.

Do not clear data or delete logs as a recovery step. Do not stop the task during an active output/calibration job without first requesting cleanup through its API.

## Live verification, 06:42 ICT

- Injected an idle preview Web-child failure at 06:41:39. The same wrapper (PID 14264) started a new pair automatically; a new startup log appeared at 06:41:49. No manual task start followed this injection.
- Web 3001 and API health, NDI discovery, and geometry state returned 200 with the correct browser Origin after recovery. New launcher PID 3244 / Web PID 1688 are diagnostic observations, not permanent process identities.
- NDI discovery found `MAPPINGPC (Arena - Composition)` and `Arena - S1` through `S5`. This was discovery only, not a receive/frame-rate/physical-output test.
- R50 was absent from device enumeration; only the four NDI Webcam devices were listed. Arena was running again (PID 4292), with roughly 4.7 GiB private memory. No Windows resource-exhaustion event 2004 was found since this boot.
- Both decoder web pages returned 200. Installed projector configuration has five entries; the weekly schedule is disabled and was left unchanged.
- Independent read-only profiling of the installed release measured 35.3 seconds for its ACL audit and 412.6 seconds for its SHA/inventory verification. The installed release was not modified or its validation bypassed.
- Logon-trigger registration and live child-recovery were tested; no additional Windows reboot was requested or performed to test the logon trigger.
