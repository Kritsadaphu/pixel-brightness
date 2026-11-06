import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Pixel Brightness control surface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="th">/);
  assert.match(html, /<title>Pixel Brightness — Windows Spatial Projection Processor<\/title>/);
  assert.match(html, /<meta property="og:image" content="http:\/\/localhost(?::3000)?\/og\.png"/);
  assert.match(html, /PIXEL<span>BRIGHTNESS<\/span>/);
  assert.match(html, /Spatial output &amp; correction/);
  assert.match(html, /PIXEL SERVER/);
  assert.doesNotMatch(html, /PAIR TOKEN/, "trusted-local control must not prompt for a token");
  assert.match(html, /Windows Nodes/);
  assert.match(html, /Projector Control/);
  assert.match(html, /Show Schedule/);
  assert.match(html, /ARENA COMPOSITION → PIXEL BRIGHTNESS SPATIAL OUTPUT/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("weekly schedule UI exposes seven-day safe show automation without an immediate shutdown control", async () => {
  const [page, panel, client, hook, css] = await Promise.all([
    readFile(new URL("app/page.tsx", projectRoot), "utf8"),
    readFile(new URL("app/components/show-schedule-panel.tsx", projectRoot), "utf8"),
    readFile(new URL("app/lib/pixel-server.ts", projectRoot), "utf8"),
    readFile(new URL("app/hooks/use-pixel-server.ts", projectRoot), "utf8"),
    readFile(new URL("app/globals.css", projectRoot), "utf8"),
  ]);
  assert.match(page, /Show Schedule/);
  assert.match(page, /Weekly show schedule/);
  assert.match(panel, /Changes saved after today’s start time wait for the next active day/);
  assert.match(panel, /a running show keeps its original shutdown plan/);
  assert.match(panel, /editGenerationRef/,
    "edits made while a save is pending must remain dirty instead of being overwritten by its response");
  assert.match(panel, /error instanceof PixelServerError && error\.status === 412/,
    "a stale schedule save must load the latest revision without discarding the operator draft");
  assert.match(panel, /your draft is preserved/);
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
    assert.match(panel, new RegExp(day));
  }
  assert.match(panel, /type="time"/);
  assert.match(panel, /MON–FRI · WEEKEND OFF/);
  assert.match(panel, /WEEK OFF/);
  assert.match(panel, /RESOLUME ARENA \.EXE/);
  assert.match(panel, /ARENA COMPOSITION \.AVC/);
  assert.match(panel, /BIOS \/ UEFI CONTROLS PHYSICAL WAKE/);
  assert.match(panel, /WINDOWS AUTO-LOGON REQUIRED/);
  assert.match(panel, /SAVE ARENA → CLOSE ARENA → PROJECTORS STANDBY → WINDOWS SHUTDOWN/);
  assert.match(panel, /LAST WINDOWS WORKER RESULT/);
  assert.match(panel, /projectorWarmupSeconds/);
  assert.match(panel, /projectorStaggerMs/);
  assert.doesNotMatch(panel, /SHUTDOWN NOW|shutdownNow|onShutdown/);
  assert.match(client, /showSchedule\(signal\?: AbortSignal\)/);
  assert.match(client, /configureShowSchedule\(schedule: PixelShowScheduleConfig, expectedRevision: number\)/);
  assert.match(client, /headers: \{ "if-match": String\(expectedRevision\) \}/);
  assert.match(client, /"\/v1\/show-schedule"/);
  assert.match(hook, /loadShowSchedule/);
  assert.match(hook, /show-schedule:save/);
  assert.match(css, /\.schedule-control-layout/);
  assert.match(css, /\.schedule-table/);
});

test("projector control stays allowlisted and keeps its password server-side", async () => {
  const [page, panel, client, server, controller] = await Promise.all([
    readFile(new URL("app/page.tsx", projectRoot), "utf8"),
    readFile(new URL("app/components/projector-control-panel.tsx", projectRoot), "utf8"),
    readFile(new URL("app/lib/pixel-server.ts", projectRoot), "utf8"),
    readFile(new URL("runtime/server/server.mjs", projectRoot), "utf8"),
    readFile(new URL("runtime/server/projector-control.mjs", projectRoot), "utf8"),
  ]);

  assert.match(page, /nav === "projectors" \? "Projector Control"/);
  assert.doesNotMatch(page, /Panasonic projector control/);
  assert.match(panel, /<h2>Projector Control<\/h2>/);
  assert.match(panel, /LOCAL NETWORK CONTROL/);
  assert.match(panel, /ACTIVE DRIVER · PANASONIC NTCONTROL · PT-VMZ51/);
  assert.match(panel, /COMMAND PROTECT OFF FOR OFFLINE LAN/);
  assert.match(panel, /NOT NEEDED IN UNPROTECTED MODE/);
  assert.match(panel, /credential stays on Pixel Server and is never sent to this page/);
  assert.doesNotMatch(panel, /type="password"/);
  assert.match(client, /\/v1\/projectors\/actions/);
  assert.match(server, /requireAuthorization\(\);[\s\S]{0,180}projectorControl\.action/);
  assert.match(controller, /const ACTION_COMMANDS = Object\.freeze/);
  assert.doesNotMatch(controller, /password:\s*this\.password[\s\S]{0,120}snapshot/);
});

test("Windows fleet controls remain allowlisted, guarded, and token-aware", async () => {
  const [page, fleet, client, css] = await Promise.all([
    readFile(new URL("app/page.tsx", projectRoot), "utf8"),
    readFile(new URL("app/components/fleet-node-panel.tsx", projectRoot), "utf8"),
    readFile(new URL("app/lib/pixel-server.ts", projectRoot), "utf8"),
    readFile(new URL("app/globals.css", projectRoot), "utf8"),
  ]);

  assert.match(page, /Windows render nodes/);
  assert.match(page, /AUTHENTICATION REQUIRED · SERVER TOKEN/);
  assert.match(page, /source\.state \?\? source\.status/, "native compositionSource.state must drive the Spout status");
  assert.match(page, /RUNTIME LIVE/);
  assert.doesNotMatch(page, /hardwareVerified/, "Web Control must not invent a physical-acceptance flag");
  assert.match(fleet, /PHYSICAL ACCEPTANCE NOT RECORDED IN WEB CONTROL/);
  assert.match(fleet, /telemetryRenderer\.connected === true/);
  assert.match(fleet, /compositionSourceIsConnected\(telemetryRenderer\.compositionSource\)/);
  assert.doesNotMatch(fleet, /hardwareVerified/, "fleet runtime state must come from real telemetry, not a missing producer");
  assert.match(fleet, /WINDOWS DISPLAYCONFIG \/ DXGI/);
  assert.match(fleet, /APPLY_DISPLAY_CONFIG/);
  assert.match(fleet, /COLLECT_DIAGNOSTICS/);
  assert.match(fleet, /RESTART_RENDERER/);
  assert.match(fleet, /RESTART_NODE/);
  assert.match(fleet, /`REBOOT \$\{nodeId\}`/);
  assert.match(fleet, /`SHUTDOWN \$\{nodeId\}`/);
  assert.match(client, /\/v1\/nodes\/\$\{encodeURIComponent\(nodeId\)\}\/actions/);
  assert.match(client, /authorization: `Bearer \$\{token\}`/);
  assert.match(client, /headers: \{ "if-match": String\(expectedRevision\) \}/,
    "project writes must use optimistic concurrency instead of silently overwriting another operator");
  assert.match(client, /pixel-brightness-server-token/);
  assert.match(css, /\.kms-verification\.runtime-live/);
  assert.match(css, /\.power-guard button\.danger/);
  assert.match(css, /\.surface-manager/);
  assert.match(css, /\.surface-overview/);
  assert.match(css, /\.overlap-vector/);
  assert.match(css, /\.seam-diagnostics/);
  assert.match(css, /\.topology-status\.safe/);
});

test("Arena is one composition source and Pixel Brightness owns the complete spatial pipeline", async () => {
  const [page, calibrationPanel, hook, client] = await Promise.all([
    readFile(new URL("app/page.tsx", projectRoot), "utf8"),
    readFile(new URL("app/components/camera-calibration-panel.tsx", projectRoot), "utf8"),
    readFile(new URL("app/hooks/use-pixel-server.ts", projectRoot), "utf8"),
    readFile(new URL("app/lib/pixel-server.ts", projectRoot), "utf8"),
  ]);
  const calibrationUi = `${page}\n${calibrationPanel}`;

  assert.match(page, /PB-COMPOSITION/);
  assert.match(page, /ONE GPU TEXTURE · ALL PROJECTORS/);
  assert.match(page, /Arena plays media and positions layers only/);
  assert.match(page, /performs every projector crop, mesh, blend, mask and black correction itself/);
  assert.match(page, /sourceViewport/);
  assert.match(page, /128 × 128/);
  assert.match(page, /resampleMesh\(/, "changing mesh density must preserve the existing deformation");
  assert.match(page, /meshPoints\.length === \(columns \+ 1\) \* \(rows \+ 1\)/, "the full mesh, not four display corners, must be saved");
  assert.match(page, /Smooth mesh brush/);
  assert.match(page, /meshDisplay\.handles\.map/);
  assert.doesNotMatch(page, /points: meshFromCorners\(corners/, "manual output must not collapse back to a four-corner warp");
  assert.match(page, /Camera Correspondence \+ Blend/);
  assert.match(calibrationUi, /does not choose the intended wall boundary/);
  assert.doesNotMatch(calibrationUi, /Camera lens profile/);
  assert.match(page, /server\.startCameraCalibration\(/, "Auto Calibrate must call the real Server route");
  assert.match(page, /cameraCalibrationRunning/);
  assert.match(calibrationUi, /projectCommitted/);
  assert.match(calibrationUi, /rendererAcknowledged/);
  assert.match(calibrationUi, /opticalVerification/);
  assert.doesNotMatch(calibrationUi, /next implementation stage/i, "camera control must not report placeholder success");
  assert.match(page, /blackUniformity/);
  assert.match(page, /output\.processing\?\.bypass/, "saved native bypass state must hydrate back into Web Control");
  assert.match(page, /calibrationCapabilityKeys\.has\(output\.id\)/, "camera calibration must intersect the project with real node output capabilities");
  assert.match(page, /sameCameraView[\s\S]{0,220}output\.raw\?\.wallId/, "one camera session must remain on the selected immersive wall/view");
  assert.match(page, /expectedNodeId[\s\S]{0,260}candidate\.nodeId === expectedNodeId/, "project outputs must bind within their authoritative render node before matching ids or connectors");
  assert.match(page, /matches\.length === 1 \? matches\[0\] : undefined/, "ambiguous legacy fleet output matches must fail closed");
  assert.doesNotMatch(page, /visibleOutputIds\.has\(String\(output\.id\)\)/,
    "a spatial edit must not delete authoritative outputs just because they are temporarily hidden");
  assert.match(page, /mergeAuthoritativeOutputs\(existingOutputs, active\.id, updateOutput, activeFallback\)/,
    "spatial saves must merge into the complete authoritative topology");
  assert.match(page, /PHYSICAL SURFACE CATALOG/);
  assert.match(page, /Existing physical surfaces/);
  assert.match(page, /Create physical surface/);
  assert.match(page, /Rename safely/);
  assert.match(page, /Independent/);
  assert.match(page, /Horizontal row/);
  assert.match(page, /Vertical column/);
  assert.match(page, /Confirm \{inferredSurfaceCount\} inferred layout/,
    "legacy layout inference must require an explicit operator confirmation");
  assert.match(page, /Assign Output \{active\.id\} without camera/,
    "manual surface mapping must remain available without camera calibration");
  assert.doesNotMatch(page, /surface-wall|surface-table/,
    "Web Control must not hard-code one wall and one table topology");
  assert.match(page, /catalogProjectSurfaces\(/,
    "all project and output-referenced surfaces must hydrate into the catalog");
  assert.match(page, /createPhysicalSurface\(surfaceCatalog/,
    "surface creation must pass through the validated unique catalog helper");
  assert.match(page, /renamePhysicalSurface\(surfaceCatalog, surfaceId, surfaceNameDraft\)/,
    "surface display names must use the safe immutable-ID rename helper");
  assert.match(page, /setSurfaceId\(String\(output\.wallId \?\? defaultSurface\.id\)\)/,
    "the selected physical surface must hydrate from the authoritative output");
  assert.match(page, /setOverlap\(exactOverlapVector\(output\.overlap\)/,
    "all four persisted overlap edges must hydrate exactly");
  assert.doesNotMatch(page, /setOverlap\(Math\.max\(/,
    "asymmetric LEFT/RIGHT or TOP/BOTTOM edges must never collapse to one scalar");
  assert.match(page, /Exact four-edge overlap vector/);
  assert.match(page, /0 px<small>INACTIVE<\/small>/,
    "inactive-axis edges must be visibly and immutably zero");
  assert.match(page, /onChange=\{\(event\) => selectPhysicalSurface\(event\.target\.value\)\}/,
    "inspector surface assignment must clear the pending vector through the safe selector");
  assert.match(page, /rebuildPhysicalSurfaceSeams\(topologyOutputs/,
    "surface assignment must clear old seams and rebuild measured neighbours");
  assert.match(page, /targetLayout: surfaceLayoutDraft[\s\S]{0,120}surfaces: committedSurfaceCatalog/,
    "mode changes must be compared with the authoritative pre-edit catalog");
  assert.match(page, /validatePhysicalSurfaceTopology\(saveSurfaceCatalog, rebuiltTopology\)/,
    "the complete candidate project must pass topology validation before persistence");
  assert.match(page, /walls: saveSurfaceCatalog/,
    "saving must retain the complete arbitrary physical-surface catalog");
  assert.match(page, /surfaceCatalog: saveSurfaceCatalog \}\)\)/,
    "offline spatial drafts must retain the arbitrary surface catalog");
  assert.doesNotMatch(page, /replace\(\/ wall\$\/i/,
    "arbitrary surface display names must not be rewritten by wall-specific presentation logic");
  assert.match(page, /surfaceOverviewGroups\.map\(\(group\)/,
    "the composition overview must render one labeled track per physical surface");
  assert.match(page, /group\.seams\.map/,
    "overlap labels must be derived only from adjacent outputs inside one surface track");
  assert.match(page, /seam\.fromId\}[\s\S]{0,100}seam\.fromEdge[\s\S]{0,120}seam\.toEdge/,
    "overview diagnostics must name horizontal or vertical reciprocal edges");
  assert.match(page, /group\.issues\.slice[\s\S]{0,180}className="orphan"/,
    "overview must expose orphan, gap, and mismatch diagnostics");
  assert.match(page, /const topologyIsSafe = inferredSurfaceCount === 0 && draftTopology\.validation\.valid/,
    "unconfirmed legacy layouts and invalid draft topology must both suppress LIVE");
  assert.match(page, /runtimeOutputsLive \? "CORRECTION LIVE" : "CORRECTION NOT LIVE"/,
    "the top correction control must not claim LIVE while draft topology or render telemetry is unsafe");
  assert.match(page, /outputs\.length === 0 \|\| !topologyIsSafe/,
    "unsafe mappings must disable the spatial save control");
  assert.doesNotMatch(page, /outputs\.slice\(0, -1\)\.map/,
    "the overview must never imply seams across global cross-surface output order");
  assert.match(page, /source Area must stay completely inside the master composition/, "invalid source crops must be rejected before save");
  assert.match(page, /result\.syncStatus\.live[\s\S]{0,220}setSaveStatus\("live"\)/,
    "LIVE must require the bounded renderer acknowledgement result");
  assert.match(page, /setSaveStatus\("not-live"\)[\s\S]{0,260}NOT LIVE on/,
    "a persisted project with pending renderers must be reported explicitly as NOT LIVE");
  assert.match(page, /server\.saveProject\(project, finiteNumber\(baseProject\.revision\)\)/,
    "Web Control must save against the exact authoritative revision it edited");
  const validationIndex = page.indexOf("validatePhysicalSurfaceTopology(saveSurfaceCatalog, rebuiltTopology)");
  const localDraftIndex = page.indexOf('window.localStorage.setItem("pixel-brightness-spatial-config"', validationIndex);
  const serverSaveIndex = page.indexOf("server.saveProject(project", validationIndex);
  assert.ok(validationIndex >= 0 && localDraftIndex > validationIndex && serverSaveIndex > validationIndex,
    "no local or Server save may occur before candidate topology validation");
  assert.match(page, /patternOutputId === active\.id/,
    "identify-grid UI state must belong only to the active output");
  const outputSelection = page.slice(page.indexOf("async function selectProjector"), page.indexOf("async function togglePattern"));
  assert.ok(
    outputSelection.indexOf("await server.pattern(previousPatternOutputId, false") >= 0
      && outputSelection.indexOf("await server.pattern(previousPatternOutputId, false") < outputSelection.indexOf("setProjector(outputId)"),
    "switching outputs must clear the old projector pattern before selection changes",
  );
  assert.match(hook, /status === 409\) await refresh\(undefined, true\)/,
    "a stale Web save must force a refresh that starts after the rejected mutation");
  assert.match(hook, /if \(predecessor\) await predecessor;[\s\S]{0,100}performRefresh\(signal\)/,
    "a post-write refresh must not reuse or race an older polling GET");
  assert.match(page, /frameRateNum: Math\.max\(1, Math\.round\(finiteNumber\(baseProject\.canvas\?\.frameRateNum/,
    "Web saves must preserve the exact Server/DXGI refresh rational instead of rounding 60000/1001");
  assert.doesNotMatch(page, /Spatial project distributed to the Windows renderer/, "a queued project must not be described as already applied");
  assert.match(hook, /projectSyncReadiness\(summary, targets, revision\)/,
    "Web Control must poll exact per-node apply receipts before declaring LIVE");
  assert.match(hook, /timeoutMs = 15_000/,
    "renderer acknowledgement waiting must be bounded");
  assert.match(client, /syncTargets: PixelProjectSyncTarget\[\]/,
    "the project-save response must carry per-node command receipts");
  assert.match(page, /\["sourceViewport", "warp", "blend", "blackUniformity", "color", "mask"\]/);
  assert.doesNotMatch(page, /Media library|Show timeline|Play show|Upload media|Add video to cue stack/);
  assert.match(page, /server\.authRequired\s*&&[\s\S]{0,160}<div className="auth-pair">/, "Pair controls must be hidden in trusted-local mode");
  assert.match(hook, /next\.server\?\.authRequired/, "the UI must follow the Server-advertised auth mode");
  assert.match(hook, /next\.server\?\.accessMode === "trusted-local"[\s\S]{0,180}localStorage\.removeItem\(PIXEL_SERVER_TOKEN_KEY\)/, "trusted-local mode must discard the old paired token");
  assert.match(hook, /setAuthRequired\(/);
  assert.match(client, /authRequired\?: boolean/, "the Server auth capability must be typed");
  assert.match(client, /compositionSource\?:/);
  assert.match(client, /\/v1\/calibrations\/camera/);
});

test("camera UI presents honest two-pass A7 IV capture and verification gates", async () => {
  const [page, panel, markerless, client, hook, docs] = await Promise.all([
    readFile(new URL("app/page.tsx", projectRoot), "utf8"),
    readFile(new URL("app/components/camera-calibration-panel.tsx", projectRoot), "utf8"),
    readFile(new URL("app/components/markerless-camera-setup.tsx", projectRoot), "utf8"),
    readFile(new URL("app/lib/pixel-server.ts", projectRoot), "utf8"),
    readFile(new URL("app/hooks/use-pixel-server.ts", projectRoot), "utf8"),
    readFile(new URL("docs/windows/camera-calibration-v1.md", projectRoot), "utf8"),
  ]);

  assert.match(page, /geometry-short/);
  assert.match(page, /radiometry-long/);
  assert.match(page, /normalizationScale: 60/);
  assert.match(page, /repeatPolicy: \{ geometry: 1, radiometry: 5, nearBlack: 16, references: 16 \}/);
  assert.match(page, /lensProfile: markerlessSetup\.lensProfile/);
  assert.match(page, /surfaceSurveys: markerlessSetup\.surfaceSurveys/);
  assert.doesNotMatch(page, /cameraSettings:\s*geometryCameraSettings/,
    "V2 exposureProfiles must not be combined with the rejected legacy field");
  assert.match(client, /exposureProfiles\?: PixelCameraExposureProfile\[\]/);
  assert.match(client, /rendererAcknowledged\?: boolean/);
  assert.match(client, /opticalVerification\?:/);
  assert.match(client, /confirmCameraCalibration\(sessionId: string, stepId: string, confirmationId: string\)/);
  assert.match(client, /startCameraOpticalVerification\(sessionId: string\)/);
  assert.match(client, /cancelCameraOpticalVerification\(sessionId: string\)/);
  assert.match(client, /confirmCameraOpticalVerification\(sessionId: string, stepId: string, confirmationId: string\)/);
  assert.match(client, /confirmed: true, stepId, confirmationId/);
  assert.match(client, /requestCameraSurveyPreview/);
  assert.match(client, /cameraSurveyPreviewArtifact/);
  assert.match(client, /authorization: `Bearer \$\{token\}`/,
    "paired remote control must fetch the protected preview artifact with its bearer token");
  assert.match(hook, /Camera survey preview did not finish within 120 seconds/);
  assert.match(hook, /artifact\.type !== "image\/png"/);
  assert.match(hook, /camera-optical-verification-confirm/);

  assert.match(markerless, /Load Lens Profile JSON/);
  assert.match(markerless, /Capture exact RAW preview/);
  assert.match(markerless, /lensProfile\.capture\.apertureFNumber/);
  assert.match(markerless, /surfaceSurveys: \[survey\]/);
  assert.match(markerless, /SERVER \+ CAMERA VERIFIED/);
  assert.doesNotMatch(markerless, /live.?view/i,
    "the survey boundary must never be selected on an unproven live-view raster");

  assert.match(panel, /SHORT EXPOSURE · GEOMETRY/);
  assert.match(panel, /LONG EXPOSURE · RADIOMETRY/);
  assert.match(panel, /1× per pattern default/);
  assert.match(panel, /5× signal · 16× reference \/ near-black/);
  assert.match(panel, /inferredCompletedCaptures/,
    "progress must weight acknowledged steps by their planned repeat count");
  assert.match(panel, /acknowledged capture repeats complete/);
  assert.match(panel, /14-bit RAW/);
  assert.match(panel, /ISO 100 · MANUAL/);
  assert.match(panel, /MECHANICAL \/ EFCS/);
  assert.match(panel, /FIXED OPTICS/);
  assert.match(panel, /Sensor-dark reference/);
  assert.match(panel, /Ambient-light reference/);
  assert.match(panel, /Projector-black reference/);
  assert.match(panel, /promptState === "waiting"/);
  assert.match(panel, /I verified this physical state/);
  assert.match(panel, /Confirmation queued…/);
  assert.match(panel, /await onConfirm\(promptStepId, promptConfirmationId\)/,
    "physical state confirmation must require an explicit operator click");
  assert.match(panel, /locallyQueuedConfirmationId === promptConfirmationId/,
    "a successful click must stay disabled while waiting for fresh Server state");
  assert.match(panel, /identity fallback/);
  assert.match(panel, /CAMERA-RELATIVE RGB · NOT COLORIMETRIC/);
  assert.match(panel, /record\(output\.radiometry\)\.colorimetric === true/,
    "full-colour UI claims require characterized colorimetric evidence");
  assert.match(panel, /OPTICAL VERIFICATION REQUIRED/);
  assert.match(panel, /OPTICAL VERIFICATION FAILED/);
  assert.match(panel, /Start post-apply RAW verification/);
  assert.match(panel, /I verified this optical state/);
  assert.match(panel, /FAILED · ROLLED BACK/);
  assert.match(panel, /ROLLBACK BLOCKED/);
  assert.match(panel, /SUPERSEDED/);
  assert.match(panel, /opticalVerificationState === "waiting-operator"/,
    "verification prompts must come from the strict post-apply state machine");
  assert.match(page, /server\.startCameraOpticalVerification\(cameraCalibration\.sessionId\)/);
  assert.match(page, /server\.confirmCameraOpticalVerification\(cameraCalibration\.sessionId, stepId, confirmationId\)/);
  assert.match(panel, /PROJECT COMMITTED · WAITING FOR RENDERER ACK/);
  assert.match(panel, /opticalVerificationState === "verified"/,
    "optical success must come from the explicit verification state");
  assert.match(panel, /\(!running && markerlessSetup == null\)/,
    "a new measured run must remain blocked until its exact lens profile and wall survey are ready");
  assert.doesNotMatch(panel, /COMPLETE · PROJECT REVISION/,
    "capture completion alone must never be presented as verified output");

  assert.match(docs, /two-pass/);
  assert.match(docs, /`projectCommitted: true`/);
  assert.match(docs, /`rendererAcknowledged: true`/);
  assert.match(docs, /`opticalVerification\.state: "verified"`/);
  assert.match(docs, /`sensor-dark`/);
  assert.match(docs, /`projectors-off-ambient`/);
  assert.match(docs, /`projector-black`/);
  assert.match(docs, /POST \/v1\/calibrations\/camera\/\{sessionId\}\/confirm/);
  assert.match(docs, /does not auto-confirm/);
  assert.match(docs, /pending-optical-capture/);
  assert.match(docs, /POST \/v1\/calibrations\/camera\/\{sessionId\}\/verification/);
  assert.match(docs, /rollback-renderer-ack/);
  assert.match(docs, /strict `rolled-back`/);
  assert.match(docs, /identity or\s+camera-relative LUT must never be displayed as full colour calibration/i);
});

test("Windows Fleet display apply fails closed to the local stable-identity binder", async () => {
  const panel = await readFile(new URL("app/components/fleet-node-panel.tsx", projectRoot), "utf8");
  assert.match(panel, /if \(windowsRenderer\)[\s\S]{0,300}Bind-PixelBrightnessDisplays\.ps1/);
  assert.match(panel, /disabled=\{windowsRenderer \|\| actionBusy/);
  assert.match(panel, /refreshNum: display\.refreshNum/);
  assert.match(panel, /refreshDen: display\.refreshDen/);
});
