import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { ControlPlane } from "./control-plane.mjs";
import { HttpError, notFound } from "./errors.mjs";
import { readJson, sendError, sendJson, sendNoContent, setCors, parseByteRange } from "./http-utils.mjs";
import { MediaLibrary } from "./media-library.mjs";
import { PanasonicProjectorControl, ProjectorControlError } from "./projector-control.mjs";
import { ShowScheduleControl, ShowScheduleError } from "./show-schedule.mjs";
import { PersistentStore } from "./store.mjs";
import { UvcGeometryControl } from "./uvc-geometry-control.mjs";
import { NdiVideoControl } from "./ndi-video-control.mjs";
import { NdiReceiverRouting } from "./ndi-receiver-routing.mjs";
import { validateNodeSigningKey, verifyNodeCredential } from "../shared/node-auth.mjs";

function routeNode(pathname, suffix) {
  const ending = suffix ? `/${suffix}` : "";
  const match = new RegExp(`^/v1/nodes/([^/]+)${ending}$`).exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(400, "invalid_node_id", "Invalid encoded node id");
  }
}

function requestAddress(request) {
  return request.socket.remoteAddress ?? null;
}

function contentTypeHeader(value) {
  return String(value ?? "application/octet-stream").split(";", 1)[0].trim().slice(0, 255);
}

function projectRevisionPrecondition(value) {
  if (value == null) return null;
  const header = Array.isArray(value) ? value.join(",") : String(value);
  const match = /^(?:"([1-9]\d*)"|([1-9]\d*))$/.exec(header.trim());
  const revision = Number(match?.[1] ?? match?.[2]);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new HttpError(
      400,
      "invalid_project_revision_precondition",
      "If-Match must contain exactly one positive integer project revision, optionally quoted",
    );
  }
  return revision;
}

function showScheduleRevisionPrecondition(value) {
  if (value == null) return null;
  const header = Array.isArray(value) ? value.join(",") : String(value);
  const match = /^(?:"(0|[1-9]\d*)"|(0|[1-9]\d*))$/.exec(header.trim());
  const revision = Number(match?.[1] ?? match?.[2]);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new HttpError(
      400,
      "invalid_show_schedule_revision_precondition",
      "If-Match must contain exactly one non-negative integer weekly schedule revision, optionally quoted",
    );
  }
  return revision;
}

function tokenMatches(actual, expected) {
  const actualBytes = Buffer.from(String(actual ?? ""));
  const expectedBytes = Buffer.from(String(expected));
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function normalizeNetworkAddress(value) {
  let address = String(value ?? "").trim().toLowerCase();
  if (address.startsWith("::ffff:")) address = address.slice(7);
  const zoneIndex = address.indexOf("%");
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  return address;
}

function normalizeHostname(value) {
  const hostname = String(value ?? "").trim().toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLoopbackHostname(value) {
  const hostname = normalizeHostname(value);
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function allowedCorsOrigin(request, { controlToken, allowInsecureNetwork, webControlPort }) {
  const originValue = String(request.headers.origin ?? "").trim();
  if (!originValue) return null;
  try {
    const origin = new URL(originValue);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") return null;
    // Token-authenticated callers remain protected by the bearer secret. An
    // explicitly insecure network listener likewise opts into broad browser
    // access. Tokenless default mode is loopback-only and exposes CORS solely
    // to the local Web Control development/production port.
    if (controlToken || allowInsecureNetwork) return origin.origin;
    return isLoopbackHostname(origin.hostname) && origin.port === String(webControlPort) ? origin.origin : null;
  } catch {
    return null;
  }
}

function trustedClientAddresses(options) {
  if (!options.trustedLocalWeb) return new Set();
  const configured = Array.isArray(options.trustedWebClients)
    ? options.trustedWebClients
    : String(options.trustedWebClients ?? "").split(",");
  return new Set(["127.0.0.1", "::1", ...configured]
    .map(normalizeNetworkAddress)
    .filter(Boolean));
}

function trustedWebHostnames(options) {
  if (!options.trustedLocalWeb) return new Set();
  const configured = Array.isArray(options.trustedWebHosts)
    ? options.trustedWebHosts
    : String(options.trustedWebHosts ?? "").split(",");
  return new Set(["127.0.0.1", "::1", "localhost", ...configured]
    .map(normalizeHostname)
    .filter(Boolean));
}

function isTrustedLocalWebRequest(request, trustedClients, trustedHosts, webControlPort) {
  const remoteAddress = normalizeNetworkAddress(request.socket.remoteAddress);
  if (!remoteAddress || !trustedClients.has(remoteAddress)) return false;

  const originValue = String(request.headers.origin ?? "").trim();
  const hostValue = String(request.headers.host ?? "").trim();
  if (!originValue || !hostValue) return false;
  try {
    const origin = new URL(originValue);
    const api = new URL(`http://${hostValue}`);
    const originHostname = normalizeHostname(origin.hostname);
    const apiHostname = normalizeHostname(api.hostname);
    return (origin.protocol === "http:" || origin.protocol === "https:")
      && origin.port === String(webControlPort)
      && originHostname === apiHostname
      && trustedHosts.has(originHostname);
  } catch {
    return false;
  }
}

function authorizationState(control, controlToken, trustedLocalWeb) {
  const authRequired = Boolean(controlToken) && !trustedLocalWeb;
  const health = control.health();
  return {
    ...health,
    authRequired,
    accessMode: controlToken ? (trustedLocalWeb ? "trusted-local" : "token") : "open",
    features: {
      ...health.features,
      authenticationRequired: authRequired,
    },
  };
}

function requestBearer(request) {
  const authorization = String(request.headers.authorization ?? "");
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
  return String(bearer || request.headers["x-pixel-token"] || "");
}

function requestPrincipal(request, controlToken, nodeSigningKey) {
  const token = requestBearer(request);
  if (!token) return null;
  if (controlToken && tokenMatches(token, controlToken)) return { role: "control" };
  const nodeId = nodeSigningKey ? verifyNodeCredential(token, nodeSigningKey) : null;
  return nodeId ? { role: "node", nodeId } : null;
}

function authorizeControl(request, { controlToken, nodeSigningKey, trustedLocalWeb = false }) {
  if (trustedLocalWeb) return { role: "control", trustedLocalWeb: true };
  if (!controlToken && !nodeSigningKey) return { role: "open" };
  const principal = requestPrincipal(request, controlToken, nodeSigningKey);
  if (principal?.role === "control") return principal;
  if (principal?.role === "node") {
    throw new HttpError(403, "insufficient_scope", "Render-node credentials cannot access control-plane routes");
  }
  throw new HttpError(401, "unauthorized", "A valid Pixel Brightness control credential is required");
}

function authorizeNode(request, { controlToken, nodeSigningKey, expectedNodeId = null }) {
  if (!controlToken && !nodeSigningKey) return { role: "open", nodeId: expectedNodeId };
  const principal = requestPrincipal(request, controlToken, nodeSigningKey);
  if (principal?.role === "control") {
    throw new HttpError(403, "insufficient_scope", "Control credentials cannot impersonate a render node");
  }
  if (!principal) {
    throw new HttpError(401, "unauthorized", "A valid Pixel Brightness render-node credential is required");
  }
  if (expectedNodeId != null && principal.nodeId !== expectedNodeId) {
    throw new HttpError(403, "node_identity_mismatch", "Render-node credential is bound to a different node id");
  }
  return principal;
}

function nodeCommandNeedsAsset(command, sha256) {
  const payload = command?.payload;
  if (!payload || typeof payload !== "object") return false;
  if (String(payload.assetSha256 ?? "").toLowerCase() === sha256) return true;
  if (Array.isArray(payload.assets) && payload.assets.some((asset) => (
    String(asset?.sha256 ?? asset ?? "").toLowerCase() === sha256
  ))) return true;
  return Array.isArray(payload.project?.timeline?.cues) && payload.project.timeline.cues.some((cue) => (
    String(cue?.assetSha256 ?? "").toLowerCase() === sha256
  ));
}

function nodeProjectNeedsAsset(store, nodeId, sha256, requireExplicitOutputOwnership = false) {
  const node = store.state.nodes[nodeId];
  const project = store.state.project;
  if (!node || !project) return false;
  const capabilities = new Set((node.capabilities?.outputs || []).flatMap((output) => [
    String(output?.id ?? ""),
    String(output?.connector ?? ""),
  ]).filter(Boolean));
  const outputIds = new Set((project.outputs || []).filter((output) => (
    String(output?.nodeId ?? "") === nodeId
    || (!requireExplicitOutputOwnership
      && !output?.nodeId
      && (capabilities.has(String(output?.id ?? ""))
        || capabilities.has(String(output?.connector ?? ""))))
  )).map((output) => String(output.id)));
  if (requireExplicitOutputOwnership && outputIds.size === 0) return false;
  return (project.timeline?.cues || []).some((cue) => (
    String(cue?.assetSha256 ?? "").toLowerCase() === sha256
    && ((cue.outputIds || []).length === 0
      || cue.outputIds.some((outputId) => outputIds.has(String(outputId))))
  ));
}

function nodeMayAccessAsset(
  store,
  nodeId,
  sha256Input,
  requireExplicitOutputOwnership = false,
) {
  const sha256 = String(sha256Input).toLowerCase();
  if (!store.state.nodes[nodeId]) return false;
  const hasExplicitOutput = (store.state.project?.outputs || []).some((output) => (
    String(output?.nodeId ?? "") === nodeId
  ));
  if (requireExplicitOutputOwnership && !hasExplicitOutput) return false;
  const queue = store.state.commandQueues[nodeId] ?? [];
  // In secured mode, old queued snapshots are not authorization. A project
  // reassignment must revoke media access immediately even when an ordered
  // pre-reassignment command remains queued behind another durable command.
  if (!requireExplicitOutputOwnership
    && queue.some((command) => nodeCommandNeedsAsset(command, sha256))) return true;
  // A Node verifies every cue for its own scoped project before releasing the
  // native boot-black latch, including after its old PREPARE/SYNC commands
  // have been acknowledged and trimmed. Bind this access to output ownership;
  // one wall's credential must not become a general media-library bearer.
  if (nodeProjectNeedsAsset(store, nodeId, sha256, requireExplicitOutputOwnership)) return true;
  const timeline = store.state.timeline;
  return Array.isArray(timeline?.targetNodeIds)
    && timeline.targetNodeIds.includes(nodeId)
    && String(timeline.preparedAssetSha256 ?? "").toLowerCase() === sha256;
}

async function sendAsset(request, response, library, sha256) {
  const asset = await library.describe(sha256);
  let range;
  try {
    range = parseByteRange(request.headers.range, asset.size);
  } catch (error) {
    if (error instanceof HttpError && error.status === 416) {
      response.setHeader("content-range", `bytes */${asset.size}`);
    }
    throw error;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? asset.size - 1;
  const status = range ? 206 : 200;
  const headers = {
    "content-type": asset.mimeType,
    "content-length": Math.max(0, end - start + 1),
    "accept-ranges": "bytes",
    etag: `"sha256-${asset.sha256}"`,
    "cache-control": "private, max-age=31536000, immutable",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
  };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${asset.size}`;
  response.writeHead(status, headers);
  if (request.method === "HEAD" || asset.size === 0) {
    response.end();
    return;
  }
  const stream = library.createReadStream(asset.filePath, { start, end });
  stream.on("error", (error) => response.destroy(error));
  stream.pipe(response);
}

function sendCameraSurveyPreviewArtifact(request, response, artifact) {
  response.writeHead(200, {
    "content-type": artifact.mimeType,
    "content-length": artifact.bytes.byteLength,
    "cache-control": "private, no-store",
    etag: `"sha256-${artifact.sha256}"`,
    "x-content-sha256": artifact.sha256,
    "content-disposition": "inline; filename=markerless-camera-survey-preview.png",
  });
  if (request.method === "HEAD") response.end();
  else response.end(artifact.bytes);
}

function projectorControlHttpError(error) {
  if (!(error instanceof ProjectorControlError)) return error;
  return new HttpError(
    Number(error.status) || 400,
    String(error.code || "projector_control_failed"),
    error.message,
    error.details,
  );
}

function showScheduleHttpError(error) {
  if (!(error instanceof ShowScheduleError)) return error;
  return new HttpError(
    Number(error.status) || 400,
    String(error.code || "show_schedule_failed"),
    error.message,
  );
}

export async function createPixelBrightnessServer(options = {}) {
  const webControlPort = options.webControlPort ?? 3000;
  if (!Number.isInteger(webControlPort) || webControlPort < 1024 || webControlPort > 65535) {
    throw new Error("webControlPort must be an integer from 1024 to 65535");
  }
  const dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), "runtime", "data", "server"));
  if (options.authToken != null) {
    throw new Error(
      "Legacy authToken was shared with Render Nodes and cannot retain control authority; use controlToken after rotating it",
    );
  }
  const controlTokenInput = options.controlToken;
  const controlToken = controlTokenInput ? String(controlTokenInput) : null;
  const nodeSigningKey = options.nodeSigningKey
    ? validateNodeSigningKey(options.nodeSigningKey)
    : null;
  if (nodeSigningKey && !controlToken) {
    throw new Error("Render-node authentication requires a distinct Pixel Brightness control token");
  }
  if (controlToken && nodeSigningKey && tokenMatches(controlToken, nodeSigningKey)) {
    throw new Error("Control token and render-node signing key must be distinct secrets");
  }
  const allowInsecureNetwork = options.allowInsecureNetwork === true;
  if (options.trustedLocalWeb && !controlToken) {
    throw new Error("trustedLocalWeb requires PIXEL_CONTROL_TOKEN so non-trusted clients remain protected");
  }
  const store = new PersistentStore(dataDir);
  await store.init();
  // This secret is delivered to the Node in a power command. Falling back to
  // the control credential would hand control-plane authority to a compromised
  // render host, so an absent power token remains absent and power fails closed.
  const powerActionToken = options.powerActionToken ? String(options.powerActionToken) : null;
  if (powerActionToken && controlToken && tokenMatches(powerActionToken, controlToken)) {
    throw new Error("Power confirmation token must be distinct from the control token");
  }
  const control = new ControlPlane(store, {
    offlineAfterMs: options.offlineAfterMs,
    allowPowerActions: options.allowPowerActions,
    powerActionToken,
    maxActionAudit: options.maxActionAudit,
    requireExplicitOutputOwnership: Boolean(nodeSigningKey),
  });
  const media = new MediaLibrary(store, { maxUploadBytes: options.maxUploadBytes });
  const projectorControl = options.projectorControl ?? new PanasonicProjectorControl({
    dataDir,
    username: options.projectorUsername,
    password: options.projectorPassword,
    sendCommand: options.projectorSendCommand,
    commandTimeoutMs: options.projectorCommandTimeoutMs,
    commandGapMs: options.projectorCommandGapMs,
  });
  await projectorControl.init();
  const showSchedule = options.showSchedule ?? new ShowScheduleControl({
    dataDir,
    clock: options.scheduleClock,
  });
  await showSchedule.init();
  const receiverRouting = options.receiverRouting ?? await new NdiReceiverRouting({ dataDir, profiles: options.ndiReceiverProfiles || [] }).initialize();
  const uvcGeometry = options.uvcGeometryControl ?? (options.uvcGeometry
    ? new UvcGeometryControl({ ...options.uvcGeometry, dataDir, receiverRouting, getProject: () => control.getProject(),
      saveProject: (project, precondition) => control.saveProject(project, precondition),
      canApply: () => !receiverRouting.snapshot().pendingRecovery && (!ndiVideo?.snapshot().job || ['stopped', 'failed'].includes(ndiVideo.snapshot().job.state)) }) : null);
  const ndiVideo = options.ndiVideoControl ?? (options.ndiVideo
    ? new NdiVideoControl({ ...options.ndiVideo, assetDirectory: dataDir, getProject: () => control.getProject() }) : null);
  // A complete 32-output project with calibrated 128 x 128 meshes can exceed
  // 32 MiB. Keep the control plane bounded and aligned with native IPC.
  const maxJsonBytes = options.maxJsonBytes ?? 64 * 1024 * 1024;
  const trustedClients = trustedClientAddresses(options);
  const trustedHosts = trustedWebHostnames(options);
  const requestIdleTimeoutMs = Math.max(5_000, Math.min(300_000, Number(options.requestIdleTimeoutMs) || 30_000));
  const uploadIdleTimeoutMs = Math.max(5_000, Math.min(300_000, Number(options.uploadIdleTimeoutMs) || 30_000));

  const httpServer = createServer(async (request, response) => {
    const requestId = randomUUID();
    request.setTimeout(requestIdleTimeoutMs, () => {
      if (response.headersSent) response.destroy();
      else {
        response.setHeader("connection", "close");
        sendError(response, new HttpError(408, "request_timeout", "Request body or response stalled"), requestId);
      }
    });
    const requestOriginPresent = request.headers.origin != null;
    const corsOrigin = allowedCorsOrigin(request, { controlToken, allowInsecureNetwork, webControlPort });
    setCors(response, corsOrigin);
    response.setHeader("x-request-id", requestId);
    try {
      // CORS response headers do not prevent a browser from sending a simple
      // cross-origin POST. In tokenless loopback mode that would otherwise let
      // an arbitrary web page mutate the local control plane without being
      // able to read the response. Reject the request before any route handler
      // whenever a browser supplies an origin outside the configured policy.
      if (requestOriginPresent && !corsOrigin) {
        throw new HttpError(403, "origin_not_allowed", "Browser origin is not allowed by the Pixel Brightness control plane");
      }
      if (!request.url) throw notFound();
      const url = new URL(request.url, "http://pixel-brightness.local");
      const pathname = url.pathname.replace(/\/$/, "") || "/";
      const method = request.method ?? "GET";
      const trustedLocalWeb = isTrustedLocalWebRequest(request, trustedClients, trustedHosts, webControlPort);
      const requireAuthorization = () => authorizeControl(request, {
        controlToken,
        nodeSigningKey,
        trustedLocalWeb,
      });
      const requireNodeAuthorization = (expectedNodeId = null) => authorizeNode(request, {
        controlToken,
        nodeSigningKey,
        expectedNodeId,
      });
      const requestAuthorizationState = () => authorizationState(control, controlToken, trustedLocalWeb);

      if (method === "OPTIONS") {
        sendNoContent(response);
        return;
      }
      if (method === "GET" && pathname === "/v1/health") {
        sendJson(response, 200, requestAuthorizationState());
        return;
      }
      if (method === "GET" && pathname === "/v1/time") {
        sendJson(response, 200, control.time());
        return;
      }
      if (pathname === "/v1/calibrations/uvc-geometry" || pathname.startsWith("/v1/calibrations/uvc-geometry/")) {
        requireAuthorization();
        if (!uvcGeometry) throw new HttpError(503, "uvc_geometry_disabled", "Local UVC geometry acquisition is not configured on this server");
        const action = pathname.slice("/v1/calibrations/uvc-geometry".length);
        if (method === "GET" && action === "") sendJson(response, 200, uvcGeometry.snapshot());
        else if (method === "GET" && action === "/devices") sendJson(response, 200, await uvcGeometry.devices());
        else if (method === "GET" && action === "/controls") sendJson(response, 200, await uvcGeometry.controls(url.searchParams.get('deviceId')));
        else if (method === "POST" && action === "") sendJson(response, 202, await uvcGeometry.start(await readJson(request, 2 * 1024 * 1024)));
        else if (method === "POST" && action === "/apply") sendJson(response, 200, await uvcGeometry.apply(await readJson(request, 4096)));
        else if (method === "POST" && action === "/restore") sendJson(response, 200, await uvcGeometry.restore(await readJson(request, 4096)));
        else if (method === "POST" && action === "/restore-routing") sendJson(response, 200, await uvcGeometry.restoreRouting(await readJson(request, 4096)));
        else if (method === "POST" && ["/confirm-routing", "/cancel"].includes(action)) {
          const body = await readJson(request, 4096);
          if (typeof body.id !== "string") throw new HttpError(400, "uvc_invalid_job", "An exact job id is required");
          sendJson(response, 202, action === "/cancel" ? uvcGeometry.cancel(body.id) : await uvcGeometry.confirmRouting(body.id));
        } else throw notFound("UVC geometry route not found");
        return;
      }
      if (pathname === "/v1/outputs/ndi-preview" || pathname.startsWith("/v1/outputs/ndi-preview/")) {
        requireAuthorization();
        if (!ndiVideo) throw new HttpError(503, "ndi_video_disabled", "Local NDI video preview is not configured");
        const action = pathname.slice("/v1/outputs/ndi-preview".length);
        if (method === "GET" && action === "") sendJson(response, 200, ndiVideo.snapshot());
        else if (method === "GET" && action === "/sources") sendJson(response, 200, await ndiVideo.sources());
        else if (method === "POST" && action === "") sendJson(response, 202, await ndiVideo.start(await readJson(request, 4096)));
        else if (method === "POST" && ["/blank", "/stop"].includes(action)) {
          const body = await readJson(request, 4096);
          if (typeof body.id !== "string") throw new HttpError(400, "ndi_job", "Exact preview id required");
          sendJson(response, 200, action === "/stop" ? await ndiVideo.stop(body.id) : await ndiVideo.blank(body.id, body.blank));
        } else throw notFound("NDI preview route not found");
        return;
      }
      if (method === "GET" && pathname === "/v1/state") {
        requireAuthorization();
        if (url.searchParams.get("includeProject") === "0") {
          sendJson(response, 200, {
            ...control.stateSummary(),
            server: requestAuthorizationState(),
            projectorControl: projectorControl.snapshot(),
            showSchedule: await showSchedule.snapshot(),
          });
        } else {
          const snapshot = control.stateSnapshot();
          sendJson(response, 200, {
            ...snapshot,
            server: requestAuthorizationState(),
            projectorControl: projectorControl.snapshot(),
            showSchedule: await showSchedule.snapshot(),
          });
        }
        return;
      }
      if (method === "GET" && pathname === "/v1/projects/default") {
        requireAuthorization();
        sendJson(response, 200, { protocolVersion: 1, project: control.getProject() });
        return;
      }
      if (method === "POST" && pathname === "/v1/projects/default") {
        requireAuthorization();
        const ifMatchRevision = projectRevisionPrecondition(request.headers["if-match"]);
        if (ifMatchRevision == null) {
          throw new HttpError(
            428,
            "project_revision_precondition_required",
            "Project updates require If-Match with the exact current project revision",
          );
        }
        const project = await readJson(request, maxJsonBytes);
        sendJson(response, 200, await control.saveProject(project, { ifMatchRevision }));
        return;
      }
      if (method === "POST" && pathname === "/v1/calibrations/camera") {
        requireAuthorization();
        sendJson(response, 202, await control.startCameraCalibration(await readJson(request, maxJsonBytes)));
        return;
      }
      if (method === "POST" && pathname === "/v1/calibrations/camera/survey-previews") {
        requireAuthorization();
        sendJson(response, 202, await control.requestCameraSurveyPreview(await readJson(request, maxJsonBytes)));
        return;
      }
      if (method === "GET" && pathname === "/v1/calibrations/camera/survey-previews/latest") {
        requireAuthorization();
        sendJson(response, 200, control.getCameraSurveyPreview("latest"));
        return;
      }
      const cameraSurveyPreviewMatch = /^\/v1\/calibrations\/camera\/survey-previews\/([^/]+)(?:\/(artifact))?$/.exec(pathname);
      if (cameraSurveyPreviewMatch) {
        requireAuthorization();
        let requestId;
        try {
          requestId = decodeURIComponent(cameraSurveyPreviewMatch[1]);
        } catch {
          throw new HttpError(400, "invalid_camera_survey_preview_id", "Invalid encoded camera survey preview id");
        }
        if (method === "GET" && !cameraSurveyPreviewMatch[2]) {
          sendJson(response, 200, control.getCameraSurveyPreview(requestId));
          return;
        }
        if ((method === "GET" || method === "HEAD") && cameraSurveyPreviewMatch[2] === "artifact") {
          sendCameraSurveyPreviewArtifact(request, response, control.getCameraSurveyPreviewArtifact(requestId));
          return;
        }
      }
      if (pathname === "/v1/calibrations/camera/bundles") {
        requireAuthorization();
        if (method === "GET") {
          sendJson(response, 200, control.listCameraCalibrationBundles());
          return;
        }
        if (method === "POST") {
          const ifMatchRevision = projectRevisionPrecondition(request.headers["if-match"]);
          sendJson(response, 201, await control.createCameraCalibrationBundle(
            await readJson(request, maxJsonBytes),
            { ifMatchRevision },
          ));
          return;
        }
      }
      const cameraCalibrationBundleMemberMatch = /^\/v1\/calibrations\/camera\/bundles\/([^/]+)\/members\/([^/]+)\/(calibration|verification)$/.exec(pathname);
      if (method === "POST" && cameraCalibrationBundleMemberMatch) {
        requireAuthorization();
        let bundleId;
        let memberId;
        try {
          bundleId = decodeURIComponent(cameraCalibrationBundleMemberMatch[1]);
          memberId = decodeURIComponent(cameraCalibrationBundleMemberMatch[2]);
        } catch {
          throw new HttpError(
            400,
            "invalid_camera_calibration_bundle_member_id",
            "Invalid encoded camera calibration bundle or member id",
          );
        }
        if (cameraCalibrationBundleMemberMatch[3] === "calibration") {
          sendJson(response, 202, await control.startCameraCalibrationBundleMember(
            bundleId,
            memberId,
            await readJson(request, maxJsonBytes),
          ));
          return;
        }
        sendJson(response, 200, await control.recordCameraCalibrationBundleMemberVerification(
          bundleId,
          memberId,
        ));
        return;
      }
      const cameraCalibrationBundleAdjacencyMatch = /^\/v1\/calibrations\/camera\/bundles\/([^/]+)\/adjacencies\/([^/]+)\/observations$/.exec(pathname);
      if (method === "POST" && cameraCalibrationBundleAdjacencyMatch) {
        requireAuthorization();
        let bundleId;
        let adjacencyId;
        try {
          bundleId = decodeURIComponent(cameraCalibrationBundleAdjacencyMatch[1]);
          adjacencyId = decodeURIComponent(cameraCalibrationBundleAdjacencyMatch[2]);
        } catch {
          throw new HttpError(
            400,
            "invalid_camera_calibration_bundle_adjacency_id",
            "Invalid encoded camera calibration bundle or adjacency id",
          );
        }
        sendJson(response, 201, await control.appendCameraCalibrationBundleAdjacencyObservation(
          bundleId,
          adjacencyId,
          await readJson(request, maxJsonBytes),
        ));
        return;
      }
      const cameraCalibrationBundleMatch = /^\/v1\/calibrations\/camera\/bundles\/([^/]+)(?:\/(commit))?$/.exec(pathname);
      if (cameraCalibrationBundleMatch) {
        requireAuthorization();
        let bundleId;
        try {
          bundleId = decodeURIComponent(cameraCalibrationBundleMatch[1]);
        } catch {
          throw new HttpError(
            400,
            "invalid_camera_calibration_bundle_id",
            "Invalid encoded camera calibration bundle id",
          );
        }
        if (method === "GET" && !cameraCalibrationBundleMatch[2]) {
          sendJson(response, 200, control.getCameraCalibrationBundle(bundleId));
          return;
        }
        if (method === "POST" && cameraCalibrationBundleMatch[2] === "commit") {
          const ifMatchRevision = projectRevisionPrecondition(request.headers["if-match"]);
          sendJson(response, 202, await control.commitCameraCalibrationBundle(
            bundleId,
            { ifMatchRevision },
          ));
          return;
        }
      }
      if (method === "GET" && pathname === "/v1/calibrations/camera/latest") {
        requireAuthorization();
        sendJson(response, 200, control.getCameraCalibration("latest"));
        return;
      }
      const cameraVerificationMatch = /^\/v1\/calibrations\/camera\/([^/]+)\/verification(?:\/(confirm|cancel))?$/.exec(pathname);
      if (cameraVerificationMatch) {
        requireAuthorization();
        let sessionId;
        try {
          sessionId = decodeURIComponent(cameraVerificationMatch[1]);
        } catch {
          throw new HttpError(400, "invalid_camera_calibration_id", "Invalid encoded camera calibration id");
        }
        if (method === "POST" && !cameraVerificationMatch[2]) {
          sendJson(response, 202, await control.startCameraOpticalVerification(sessionId));
          return;
        }
        if (method === "POST" && cameraVerificationMatch[2] === "confirm") {
          sendJson(response, 202, await control.confirmCameraOpticalVerification(
            sessionId,
            await readJson(request, maxJsonBytes),
          ));
          return;
        }
        if (method === "POST" && cameraVerificationMatch[2] === "cancel") {
          sendJson(response, 202, await control.cancelCameraOpticalVerification(sessionId));
          return;
        }
      }
      const cameraCalibrationMatch = /^\/v1\/calibrations\/camera\/([^/]+)(?:\/(cancel|confirm))?$/.exec(pathname);
      if (cameraCalibrationMatch) {
        requireAuthorization();
        let sessionId;
        try {
          sessionId = decodeURIComponent(cameraCalibrationMatch[1]);
        } catch {
          throw new HttpError(400, "invalid_camera_calibration_id", "Invalid encoded camera calibration id");
        }
        if (method === "GET" && !cameraCalibrationMatch[2]) {
          sendJson(response, 200, control.getCameraCalibration(sessionId));
          return;
        }
        if (method === "POST" && cameraCalibrationMatch[2] === "cancel") {
          sendJson(response, 202, await control.cancelCameraCalibration(sessionId));
          return;
        }
        if (method === "POST" && cameraCalibrationMatch[2] === "confirm") {
          sendJson(response, 202, await control.confirmCameraCalibration(
            sessionId,
            await readJson(request, maxJsonBytes),
          ));
          return;
        }
      }
      if (method === "POST" && pathname === "/v1/nodes/register") {
        const principal = requireNodeAuthorization();
        const registration = await readJson(request, maxJsonBytes);
        if (principal.role === "node" && String(registration.nodeId ?? "") !== principal.nodeId) {
          throw new HttpError(403, "node_identity_mismatch", "Render-node credential is bound to a different node id");
        }
        sendJson(response, 201, await control.register(registration, requestAddress(request)));
        return;
      }

      const cameraSurveyPreviewResultMatch = /^\/v1\/nodes\/([^/]+)\/camera-survey-previews\/([^/]+)\/result$/.exec(pathname);
      if (method === "POST" && cameraSurveyPreviewResultMatch) {
        let nodeId;
        let requestId;
        try {
          nodeId = decodeURIComponent(cameraSurveyPreviewResultMatch[1]);
          requestId = decodeURIComponent(cameraSurveyPreviewResultMatch[2]);
        } catch {
          throw new HttpError(400, "invalid_camera_survey_preview_id", "Invalid encoded camera survey preview id");
        }
        requireNodeAuthorization(nodeId);
        sendJson(response, 200, await control.completeCameraSurveyPreview(
          nodeId,
          requestId,
          await readJson(request, maxJsonBytes),
        ));
        return;
      }

      const nodeDetailId = routeNode(pathname, "");
      if (method === "GET" && nodeDetailId) {
        requireAuthorization();
        sendJson(response, 200, control.getNodeDetail(nodeDetailId));
        return;
      }
      const diagnosticsNodeId = routeNode(pathname, "diagnostics");
      if (method === "GET" && diagnosticsNodeId) {
        requireAuthorization();
        sendJson(response, 200, control.getNodeDiagnostics(diagnosticsNodeId));
        return;
      }
      const actionNodeId = routeNode(pathname, "actions");
      if (method === "POST" && actionNodeId) {
        requireAuthorization();
        sendJson(response, 202, await control.requestHostAction(
          actionNodeId,
          await readJson(request, maxJsonBytes),
          { requestedBy: requestAddress(request) },
        ));
        return;
      }

      const heartbeatNodeId = routeNode(pathname, "heartbeat");
      if (method === "POST" && heartbeatNodeId) {
        requireNodeAuthorization(heartbeatNodeId);
        sendJson(response, 200, await control.heartbeat(heartbeatNodeId, await readJson(request, maxJsonBytes)));
        return;
      }
      const commandNodeId = routeNode(pathname, "commands");
      if (method === "GET" && commandNodeId) {
        requireNodeAuthorization(commandNodeId);
        const abortController = new AbortController();
        const abort = () => abortController.abort();
        request.once("aborted", abort);
        response.once("close", abort);
        const result = await control.pollCommands(
          commandNodeId,
          url.searchParams.get("after"),
          url.searchParams.get("waitMs"),
          abortController.signal,
        );
        if (!response.destroyed) sendJson(response, 200, result);
        return;
      }

      if (method === "POST" && pathname.startsWith("/v1/timeline/")) {
        requireAuthorization();
        const action = pathname.slice("/v1/timeline/".length);
        const input = await readJson(request, maxJsonBytes);
        const handler = { prepare: "prepare", play: "play", pause: "pause", seek: "seek" }[action];
        if (!handler) throw notFound("Timeline action not found", "route_not_found");
        sendJson(response, 200, await control[handler](input));
        return;
      }
      const outputPatternMatch = /^\/v1\/outputs\/([^/]+)\/pattern$/.exec(pathname);
      if (method === "POST" && outputPatternMatch) {
        requireAuthorization();
        let outputId;
        try {
          outputId = decodeURIComponent(outputPatternMatch[1]);
        } catch {
          throw new HttpError(400, "invalid_output_id", "Invalid encoded output id");
        }
        sendJson(response, 200, await control.outputPattern(outputId, await readJson(request, maxJsonBytes)));
        return;
      }
      if (pathname === "/v1/projectors") {
        requireAuthorization();
        if (method === "GET") {
          sendJson(response, 200, projectorControl.snapshot());
          return;
        }
        if (method === "PUT") {
          try {
            sendJson(response, 200, await projectorControl.configure(await readJson(request, maxJsonBytes)));
          } catch (error) {
            throw projectorControlHttpError(error);
          }
          return;
        }
      }
      if (method === "POST" && pathname === "/v1/projectors/refresh") {
        requireAuthorization();
        try {
          sendJson(response, 200, await projectorControl.refresh(await readJson(request, maxJsonBytes)));
        } catch (error) {
          throw projectorControlHttpError(error);
        }
        return;
      }
      if (method === "POST" && pathname === "/v1/projectors/actions") {
        requireAuthorization();
        try {
          sendJson(response, 200, await projectorControl.action(await readJson(request, maxJsonBytes)));
        } catch (error) {
          throw projectorControlHttpError(error);
        }
        return;
      }
      if (pathname === "/v1/show-schedule") {
        requireAuthorization();
        if (method === "GET") {
          sendJson(response, 200, await showSchedule.snapshot());
          return;
        }
        if (method === "PUT") {
          try {
            const ifMatchRevision = showScheduleRevisionPrecondition(request.headers["if-match"]);
            if (ifMatchRevision == null) {
              throw new HttpError(
                428,
                "show_schedule_revision_precondition_required",
                "Weekly schedule updates require If-Match with the exact current schedule revision",
              );
            }
            sendJson(response, 200, await showSchedule.configure(
              await readJson(request, 64 * 1024),
              { ifMatchRevision },
            ));
          } catch (error) {
            throw showScheduleHttpError(error);
          }
          return;
        }
      }
      if (method === "POST" && pathname === "/v1/media/upload") {
        requireAuthorization();
        // This is an inactivity deadline, not a total upload deadline: every
        // arriving chunk refreshes it, so multi-gigabyte show media can take
        // hours while a stalled authenticated client cannot pin a socket.
        request.setTimeout(uploadIdleTimeoutMs);
        const metadata = await media.upload(request, {
          fileName: request.headers["x-file-name"],
          declaredSha256: request.headers["x-content-sha256"],
          mimeType: contentTypeHeader(request.headers["content-type"]),
        });
        sendJson(response, 201, { protocolVersion: 1, media: metadata });
        return;
      }

      const assetMatch = /^\/v1\/assets\/([a-fA-F0-9]{64})$/.exec(pathname);
      if ((method === "GET" || method === "HEAD") && assetMatch) {
        const principal = trustedLocalWeb
          ? requireAuthorization()
          : requestPrincipal(request, controlToken, nodeSigningKey);
        if (!controlToken && !nodeSigningKey) {
          // Explicitly open loopback/development mode preserves the original
          // source-run behavior.
        } else if (!principal) {
          throw new HttpError(401, "unauthorized", "A valid Pixel Brightness credential is required");
        } else if (principal.role === "node" && !nodeMayAccessAsset(
          store,
          principal.nodeId,
          assetMatch[1],
          Boolean(nodeSigningKey),
        )) {
          throw new HttpError(403, "node_asset_forbidden", "This asset is not assigned to the authenticated render node");
        }
        await sendAsset(request, response, media, assetMatch[1]);
        return;
      }
      throw notFound("API route not found", "route_not_found");
    } catch (error) {
      if (options.onError && !(error instanceof HttpError)) options.onError(error);
      sendError(response, error, requestId);
    }
  });

  // Total request duration stays unlimited for long media transfers and
  // command polls. Per-request inactivity deadlines above prevent slow/stale
  // clients from pinning sockets indefinitely.
  httpServer.requestTimeout = options.requestTimeoutMs ?? 0;
  httpServer.headersTimeout = options.headersTimeoutMs ?? 15_000;
  httpServer.keepAliveTimeout = options.keepAliveTimeoutMs ?? 5_000;

  let closing = false;
  return {
    dataDir,
    store,
    control,
    media,
    projectorControl,
    showSchedule,
    uvcGeometry,
    ndiVideo,
    httpServer,
    async listen({ host = "127.0.0.1", port = 4100 } = {}) {
      if ((!controlToken || !nodeSigningKey) && !allowInsecureNetwork && !isLoopbackHostname(host)) {
        throw new Error(
          "Refusing a non-loopback Pixel Brightness listener without distinct control and render-node credentials; "
          + "set allowInsecureNetwork only for an explicitly isolated development network",
        );
      }
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          resolve();
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port, host);
      });
      return httpServer.address();
    },
    async close() {
      if (closing) return;
      closing = true;
      const acquisitionCleanup = await Promise.allSettled([uvcGeometry?.close(), ndiVideo?.close()]);
      control.close();
      await new Promise((resolve, reject) => {
        if (!httpServer.listening) {
          resolve();
          return;
        }
        httpServer.close((error) => error ? reject(error) : resolve());
        setTimeout(() => httpServer.closeAllConnections?.(), 2_000).unref?.();
      });
      await store.flush();
      const cleanupErrors = acquisitionCleanup.filter(result => result.status === "rejected").map(result => result.reason);
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Acquisition cleanup failed; HTTP server was closed");
    },
  };
}
