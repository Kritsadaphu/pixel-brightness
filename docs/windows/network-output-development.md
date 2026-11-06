# Network-output development patch — 2026-09-06

Status: **experimental source patch; real SDK/local GPU-to-NDI roundtrip verified,
not a complete release or installer**.
The deployed DXGI renderer, server configuration, Arena composition, NDI
receivers and existing edge blends are unchanged. No NDI source is started by
this patch. The default build leaves the experimental targets disabled.

## Implemented boundary

- `OffscreenOutput` runs the existing `FinalPipeline` shader and correction
  assets into an RGBA8 render target without a window, monitor or swapchain.
- Two staging slots and completion queries provide bounded, non-blocking
  readback. A full queue rejects the incoming frame instead of growing.
- CPU frames own tightly packed rows (GPU row padding is removed) and carry
  sequence, common 100 ns sender timecode and rational frame rate.
- `DiscardPending` allows a caller to retire pre-blank/pre-config frames. This
  is not yet wired into the production boot lock or camera-pattern scheduler.
- `NdiSender` is an optional implementation against an operator-provided
  official Windows x64 NDI SDK. It uses synchronous SDK submission on a dedicated
  transport thread; mapped GPU memory is never handed to the SDK. It rejects
  malformed frames, odd widths, regressing sequences and regressing timecodes.
  SDK submission counts and connection counts do not prove receiver presentation.
  `SourceIdentity()` exposes the exact SDK-owned source name/address as copied
  strings for deliberate receiver binding, without selecting discovery index zero.

`NdiSender` must not run on the render or server thread: an SDK send can block.
Before production integration it needs a bounded mailbox, epoch invalidation,
process supervision, clear shutdown/black behavior and a single composition
clock. NDI disconnection/decoder hold-last-frame behavior cannot be treated as
optical black or DXGI scanout acknowledgement.

## Build the isolated shader/readback tests

Use a separate build directory, never a published release directory:

```powershell
cmake -S native/windows -B <separate-build-directory> -G "Visual Studio 17 2022" -A x64 `
  -DPB_FETCH_SPOUT2=OFF -DPB_BUILD_EXPERIMENTAL_NETWORK_OUTPUT=ON
cmake --build <separate-build-directory> --config Release --target pbwin-offscreen-tests
ctest --test-dir <separate-build-directory> -C Release -R pbwin-offscreen-network-boundary --output-on-failure
```

The test uses Windows D3D11 WARP, not a physical display or projector. It verifies
two source crops, RGBA channel ordering, shared timecode, 60000/1001 cadence
metadata, blend edge pixels, source-loss black, explicit blank, queue saturation
and invalidation of pre-blank frames. These are rendering-boundary tests, not an
end-to-end NDI, camera-calibration or projector acceptance result.

An explicit `pbwin-offscreen-tests.exe --hardware` run uses the high-performance
DXGI adapter instead of WARP. On MappingPC this selected **NVIDIA RTX A400** and
passed on 2026-09-06 in the interactive Windows session (exit 0). It still creates
no window and does not bind any monitor. The run includes padded-row packing and
invalid-canvas rejection in addition to the cases above. Its log is
`C:\Users\CPU_Mapping\Downloads\pixel-offscreen-hardware-20260906.log`.

The existing JavaScript Canon-helper fixture tests plus native correction-binding
test passed **7/7** on macOS with Node's directory added to PATH (the fixtures
use `#!/usr/bin/env node`). This is protocol-fixture evidence, not SDK/hardware
camera-provider evidence. An initial run without Node on PATH failed to launch
those fixture processes; no product code was changed to bypass that failure.

The complete isolated Windows native build (MSVC 19.44, Release, Spout fetching
disabled) and CTest run passed **9/9** on MappingPC, including the new offscreen
test and the existing configuration, shader, boot-lock, named-pipe, display
timing, recovery and mailbox tests. Build/test files remain under
`C:\ProgramData\Pixel Brightness Build\ndi-dev-20260906`.
At the time of that initial build, the SDK-dependent target was not compiled.
The operator subsequently installed the official NDI 6 SDK; see the real SDK
verification below. The initial source ZIP remains an earlier development artifact.

Post-test checks: installed renderer SHA-256 remains
`4a54076b1f75444801ae6df66644196bf492df72d7d84325c3ef42b58404aa3c`,
server health reports `ok: true`, version `0.3.0`, and Arena PID 11888 remains
responsive. No development binary was copied into the installed release.

To compile the optional sender later, additionally pass
`-DPB_NDI_SDK_ROOT=<official-sdk-root>` and build `pbwin-ndi-sender`.
The root must contain `Include/Processing.NDI.Lib.h` and
`Lib/x64/Processing.NDI.Lib.x64.lib`. No SDK headers, runtime DLLs, licence
acceptances or third-party application binaries are bundled/copied by this patch.

## Actual hardware evidence already obtained

On MappingPC (`192.168.1.200`):

- Canon EOS R50 is present over USB and EOS Utility 3.20.21.1 detects it.
- EOS Utility Remote Live View displays the physical projection.
- Remote shooting produced
  `C:\Users\CPU_Mapping\Pictures\2026_09_06\IMG_0001.JPG` (5,714,404 bytes).
- This JPEG is a connectivity test, **not** linear RAW/black-level calibration
  evidence, a measured lens profile, or proof of the Pixel camera adapter.
- Existing Arena output/blends remain operator-owned and must be backed up and
  explicitly migrated, not silently applied a second time in Pixel.

## Remaining gates before a complete release

1. NDI SDK installation and local roundtrip tests are now verified. Canon SDK
   is not required for the separate UVC video acquisition path. EOS Utility is
   still not a substitute for an EDSDK developer package when implementing RAW.
2. Extend the verified NDI transport with bounded worker/process supervision,
   frame epochs, sustained performance tests and receiver failure handling.
3. Integrate offscreen outputs with the native config/IPC/boot lock, output
   transport selection, installer, Web Control and actual camera pattern timing.
   Do not invent Windows monitor identities for Magewell decoders.
4. Integrate the working R50 UVC acquisition with a separate processed-video
   geometry workflow and verify fixed camera settings and pattern/frame matching.
   RAW/precision black-level mode still requires a genuine RAW capture/decoder
   provider and measurement validation. Never substitute UVC for CR3 evidence.
5. Build a separate preview executable/package. Validate GPU readback cadence,
   CPU/network load and two Magewell receivers on the wired show network.
   Verify RGB/video range through the decoder/projector and measure receiver
   skew; matching sender timecodes are not physical projector genlock.
6. Obtain operator confirmation of exact receiver identities and physical
   left/right mapping; preserve/export current Arena settings before any switch.
7. Complete camera-assisted measured calibration, before/after optical checks,
   reconnect/failure tests and rollback rehearsal. Only then label a release
   complete. Five-projector performance requires its own acceptance run.

## Official SDK request pages

- Canon Asia EDSDK with RAW library:
  https://asia.canon/en/campaign/developerresources/sdk/form?sdk=321
  Requires registered-entity and representative details plus terms acceptance.
- NDI SDK:
  https://ndi.video/for-developers/ndi-sdk/download/
  Requires company/contact/use details. Optional marketing/partner sharing is
  not required for this project's request and should remain unchecked.

Suggested purpose text for the applicant to review:

> We are developing a Windows x64 projection-mapping application. We need USB
> control of a Canon EOS R50, manual exposure readback, remote still-image
> capture and RAW transfer for projector geometry, edge-blend and black-level
> measurement. The application processes a local composition and is intended
> to send separately corrected video outputs to NDI-to-HDMI projector decoders.

Do not submit an application with invented company/registration/contact data or
accept its terms without the applicant's approval.

## Real NDI SDK verification after operator installation

Official public Windows SDK installer:
https://downloads.ndi.tv/SDK/NDI_SDK/NDI%206%20SDK.exe

Downloaded to `C:\Users\CPU_Mapping\Downloads\NDI-SDK-20260906\NDI 6 SDK.exe`.
File version **6.3.2.0**, size **41,608,832 bytes**, Authenticode valid, publisher
**Vizrt AG**. SHA256:
`4d5dd36a1c7c7634f408bf459b068787cce6f5310a3efe832d76b1ddeb54e499`.
The user confirmed completing installation. Headers, x64 import library and
signed runtime were verified at `C:\Program Files\NDI\NDI 6 SDK`.
No SDK files have been added to the source repository or release ZIP.

- `pbwin-ndi-sender` compiled successfully against the actual SDK.
- Complete isolated native CTest suite after integration: **11/11 passed**
  (11.59 seconds), including UVC, NDI, offscreen rendering and existing tests.
- Added `pbwin-ndi-roundtrip-tests`, enabled only with the experimental network
  option plus an explicit SDK root and `BUILD_TESTING`.
- Default CTest roundtrip: two isolated 320×180 local senders/receivers; validates
  source distinction, RGB channels, 60000/1001 frame-rate metadata, sender
  timecode bounds, invalid-frame rejection and transition to black.
- `pbwin-ndi-roundtrip-tests.exe --gpu-full-hd` passed on **NVIDIA RTX A400**:
  the existing correction shader crops a generated 3840×1080 texture into two
  1920×1080 offscreen outputs, reads them back, submits through the actual SDK,
  and receives/validates both outputs locally. Four frames per phase per
  receiver passed for red/blue, green/white and blank phases.
- This diagnostic renders each phase once, then repeatedly transmits it. It
  is **not** a sustained 59.94fps rendering/NDI throughput benchmark or a test
  of Spout, Magewell decoding, projector synchronization or camera calibration.
- Every test uses unique `PB-DEV-VERIFY-<process-id>-A/B` sources, which are
  destroyed when the test exits. Existing source names/subscriptions were not
  changed. NDI runtime is loaded from the official SDK Bin/x64 via process PATH;
  it is not copied from Arena or another app.
- The temporary one-shot SDK installer task was removed after installer exit.
  No scheduled show settings were changed.

Re-run the bounded default test with:

```powershell
ctest --test-dir <development-build> -C Release -R pbwin-ndi-sdk-roundtrip --output-on-failure
```

The CTest entry sets the SDK runtime path for its own process. For the optional
GPU full-HD mode set that process's PATH to include the official SDK `Bin/x64`,
then run `pbwin-ndi-roundtrip-tests.exe --gpu-full-hd` (no display binding).
