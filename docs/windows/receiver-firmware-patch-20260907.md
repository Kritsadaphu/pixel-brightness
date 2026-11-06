# Receiver firmware compatibility patch — 7 September 2026

Installed in the isolated Windows control preview, not the production release.

- Magewell IP decoder: accept the firmware's JWT-shaped session cookie without changing it.
- Kiloview N6 web firmware: explicit `kiloview-web-v2` adapter. Login uses `/api/users/login.json`; source discovery uses `/api/source/groups/list`; readback uses `/api/output/get?output_id=1`; source-only assignment uses `/api/output/source/set`.
- API request shapes were inspected from the actual device's served web application (build `2025_1208_1011`). No guessed fallback write, layout, preset, password, or network changes.
- Kiloview discovery contains duplicate names on different NICs. Resolve exact name plus endpoint on every selection, including restore. Do not reuse a stale stream ID: the first live test demonstrated it temporarily returned the link-local interface. Repeated readback confirmed restoration; that first journal was retained as recovery evidence.
- Receiver setup can take explicit profiles and passwords from stdin, preserving the existing Windows-user credential storage. No actual passwords are included in source or this document.

## Verified on Windows

Left A is Magewell `192.168.68.34`; right B is Kiloview `192.168.68.31`.
The corrected live test switched A from Arena S1 to S2 and B from S2 to S1, then restored both automatically with exact name/address readback:

- A: `MAPPINGPC (Arena - S1)` at `192.168.68.50:5962`.
- B: `MAPPINGPC (Arena - S2)` at `192.168.68.50:5963`.

Evidence: `outputs/windows/receiver-live-check-verified-20260907.json`; Windows preview data contains the same file. Routing journal ended `restored`, with no pending recovery. Arena was not closed or restarted.

Tests: 593 tests, 587 passed, 6 platform-dependent skips, 0 failures. This includes the new cookie, web API, duplicate-interface selection, and source-only assignment fixtures.

This verifies two decoder API routes, not optical output, camera exposure lock, a completed Auto calibration, five-projector performance, or scheduled projector power cycling. `productionAutoReady` remains false. The previously produced R2 installer ZIP predates this patch.

## Follow-up: normal-user setup access

The deployed preview-data directory inherited only Read/Execute for the interactive show account. Elevated setup had succeeded, while the normal desktop setup could not create its temporary credential file. `Repair-PixelBrightnessPreviewAccess.ps1` adds Modify for the named show account only on preview-data and preserves an ACL backup; it does not change program-code or parent-directory access.

Windows PowerShell also converted `$null` to an invalid empty backup pathname for `File.Replace`. Setup and the runtime access fixture now use `[NullString]::Value`. Setup checks directory write access before prompting for credentials.

Verified using a one-off **Limited**, interactive-account scheduled task (removed after completion): create, atomic replacement, and cleanup passed, and both configured credentials loaded successfully without elevation. Evidence: `outputs/windows/receiver-access-check-20260907.json`. Existing profiles and passwords were retained; no decoder source or Arena state was changed by this check.
