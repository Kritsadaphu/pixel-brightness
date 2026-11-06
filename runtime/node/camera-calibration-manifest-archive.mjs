import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  normalizeCameraCalibrationManifest,
  normalizeCameraCalibrationPlan,
} from "../shared/camera-calibration.mjs";

const ARCHIVE_SCHEMA_VERSION = 1;
const ENTRY_SCHEMA_VERSION = 1;

export const CAMERA_CALIBRATION_MANIFEST_ARCHIVE_DEFAULTS = Object.freeze({
  maxEntries: 32,
  maxBytes: 128 * 1024 * 1024,
});

export class CameraCalibrationManifestArchiveError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "CameraCalibrationManifestArchiveError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new CameraCalibrationManifestArchiveError(code, message, details);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function exactObject(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID", `${field} must be an object`);
  }
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(
      "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID",
      `${field} must contain exactly: ${expected.join(", ")}`,
    );
  }
  return value;
}

function text(value, field, maximum = 128) {
  const result = String(value ?? "");
  const hasControl = [...result].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
  if (!result || result.trim() !== result || result.length > maximum || hasControl) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID", `${field} is invalid`);
  }
  return result;
}

function sha256(value, field) {
  const result = String(value || "");
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID", `${field} must be a lowercase SHA-256 digest`);
  }
  return result;
}

function positiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID", `${field} must be a positive safe integer`);
  }
  return result;
}

function exactPositiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID", `${field} must be an exact positive safe integer`);
  }
  return value;
}

function isoTimestamp(value, field) {
  const result = String(value || "");
  if (!result || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID", `${field} must be a canonical ISO timestamp`);
  }
  return result;
}

function normalizeProjectBinding(input, field) {
  const value = exactObject(input, ["id", "revision"], field);
  return {
    id: text(value.id, `${field}.id`),
    revision: positiveInteger(value.revision, `${field}.revision`),
  };
}

function sortedUniqueText(input, field) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 512) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID", `${field} must be a non-empty bounded array`);
  }
  const result = input.map((item, index) => text(item, `${field}[${index}]`)).sort();
  if (new Set(result).size !== result.length) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID", `${field} must be unique`);
  }
  return result;
}

function cameraViewIdsForPlan(plan) {
  return [...new Set(plan.outputs
    .map((output) => output.surfaceTarget?.cameraViewId)
    .filter(Boolean))].sort();
}

function cameraViewIdsForManifest(manifest) {
  return [...new Set(manifest.outputs
    .map((output) => output.geometry?.cameraViewId)
    .filter(Boolean))].sort();
}

export function normalizeCameraCalibrationBundleArchiveBinding(input, { plan = null } = {}) {
  if (input == null) return null;
  const value = exactObject(
    input,
    ["bundleId", "memberId", "cameraViewId", "viewCaptureId"],
    "camera calibration bundle binding",
  );
  const normalized = {
    bundleId: text(value.bundleId, "bundle.bundleId"),
    memberId: text(value.memberId, "bundle.memberId"),
    cameraViewId: text(value.cameraViewId, "bundle.cameraViewId"),
    viewCaptureId: text(value.viewCaptureId, "bundle.viewCaptureId"),
  };
  if (plan != null) {
    const normalizedPlan = normalizeCameraCalibrationPlan(plan);
    const cameraViewIds = cameraViewIdsForPlan(normalizedPlan);
    if (cameraViewIds.length !== 1 || cameraViewIds[0] !== normalized.cameraViewId) {
      fail(
        "CAMERA_CALIBRATION_BUNDLE_ARCHIVE_BINDING_MISMATCH",
        "Bundle archive binding does not match the plan's exact camera view",
        { expectedCameraViewIds: cameraViewIds, receivedCameraViewId: normalized.cameraViewId },
      );
    }
  }
  return normalized;
}

function archiveEntryCore({
  sessionId,
  nodeId,
  project,
  outputIds,
  cameraViewIds,
  bundle,
  planSha256,
  manifestSha256,
  archivedAt,
  manifest,
}) {
  return {
    schemaVersion: ENTRY_SCHEMA_VERSION,
    sessionId,
    nodeId,
    project,
    outputIds,
    cameraViewIds,
    bundle,
    provenance: "measured",
    applicable: true,
    planSha256,
    manifestSha256,
    archivedAt,
    manifest,
  };
}

function sameReplayEvidence(left, right) {
  return left.sessionId === right.sessionId
    && left.nodeId === right.nodeId
    && left.planSha256 === right.planSha256
    && left.manifestSha256 === right.manifestSha256
    && canonicalJson(left.project) === canonicalJson(right.project)
    && canonicalJson(left.outputIds) === canonicalJson(right.outputIds)
    && canonicalJson(left.cameraViewIds) === canonicalJson(right.cameraViewIds)
    && canonicalJson(left.bundle) === canonicalJson(right.bundle);
}

function serializedEntryBytes(core, entrySha256) {
  let byteLength = 1;
  for (;;) {
    const next = Buffer.byteLength(canonicalJson({ ...core, entrySha256, byteLength }), "utf8");
    if (next === byteLength) return next;
    byteLength = next;
  }
}

export function createCameraCalibrationManifestArchiveEntry({
  nodeId: nodeIdInput,
  state,
  plan: planInput,
  manifest: manifestInput,
  bundle: bundleInput = null,
  archivedAt: archivedAtInput = new Date().toISOString(),
}) {
  if (state !== "complete") {
    fail(
      "CAMERA_CALIBRATION_MANIFEST_NOT_TERMINAL",
      "Only a completed calibration can enter the measured manifest archive",
    );
  }
  const plan = normalizeCameraCalibrationPlan(planInput);
  const manifest = normalizeCameraCalibrationManifest(manifestInput, { plan });
  if (manifest.provenance !== "measured" || manifest.applicable !== true) {
    fail(
      "CAMERA_CALIBRATION_MANIFEST_NOT_APPLICABLE",
      "Only a validated measured/applicable manifest can enter the archive",
    );
  }
  const nodeId = text(nodeIdInput, "nodeId");
  const bundle = normalizeCameraCalibrationBundleArchiveBinding(bundleInput, { plan });
  const outputIds = plan.outputs.map((output) => output.id).sort();
  const cameraViewIds = cameraViewIdsForPlan(plan);
  const manifestCameraViewIds = cameraViewIdsForManifest(manifest);
  if (canonicalJson(cameraViewIds) !== canonicalJson(manifestCameraViewIds)) {
    fail(
      "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_BINDING_MISMATCH",
      "Manifest camera-view evidence does not match the normalized calibration plan",
    );
  }
  const archivedAt = isoTimestamp(archivedAtInput, "archivedAt");
  if (Date.parse(archivedAt) < Date.parse(manifest.completedAt)) {
    fail(
      "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID",
      "Manifest archive timestamp predates manifest completion",
    );
  }
  const core = archiveEntryCore({
    sessionId: manifest.sessionId,
    nodeId,
    project: { ...manifest.project },
    outputIds,
    cameraViewIds,
    bundle,
    planSha256: sha256Json(plan),
    manifestSha256: sha256Json(manifest),
    archivedAt,
    manifest,
  });
  const entrySha256 = sha256Json(core);
  return {
    ...core,
    entrySha256,
    byteLength: serializedEntryBytes(core, entrySha256),
  };
}

export function normalizeCameraCalibrationManifestArchiveEntry(input) {
  const value = exactObject(input, [
    "schemaVersion", "sessionId", "nodeId", "project", "outputIds", "cameraViewIds", "bundle",
    "provenance", "applicable", "planSha256", "manifestSha256", "archivedAt", "manifest",
    "entrySha256", "byteLength",
  ], "camera calibration manifest archive entry");
  if (value.schemaVersion !== ENTRY_SCHEMA_VERSION || value.provenance !== "measured" || value.applicable !== true) {
    fail(
      "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID",
      "Archive entry schema/provenance/applicability is invalid",
    );
  }
  const manifest = normalizeCameraCalibrationManifest(value.manifest);
  if (manifest.provenance !== "measured" || manifest.applicable !== true) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID", "Archive manifest is not measured and applicable");
  }
  const sessionId = text(value.sessionId, "entry.sessionId");
  const nodeId = text(value.nodeId, "entry.nodeId");
  const project = normalizeProjectBinding(value.project, "entry.project");
  const outputIds = sortedUniqueText(value.outputIds, "entry.outputIds");
  const cameraViewIds = Array.isArray(value.cameraViewIds) && value.cameraViewIds.length === 0
    ? []
    : sortedUniqueText(value.cameraViewIds, "entry.cameraViewIds");
  const bundle = normalizeCameraCalibrationBundleArchiveBinding(value.bundle);
  const archivedAt = isoTimestamp(value.archivedAt, "entry.archivedAt");
  const planSha256 = sha256(value.planSha256, "entry.planSha256");
  const manifestSha256 = sha256(value.manifestSha256, "entry.manifestSha256");
  if (sessionId !== manifest.sessionId
    || canonicalJson(project) !== canonicalJson(manifest.project)
    || canonicalJson(outputIds) !== canonicalJson(manifest.outputs.map((output) => output.outputId).sort())
    || canonicalJson(cameraViewIds) !== canonicalJson(cameraViewIdsForManifest(manifest))
    || (bundle != null && (cameraViewIds.length !== 1 || cameraViewIds[0] !== bundle.cameraViewId))
    || Date.parse(archivedAt) < Date.parse(manifest.completedAt)) {
    fail(
      "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_BINDING_MISMATCH",
      "Archive identity does not match its exact measured manifest evidence",
      { sessionId },
    );
  }
  if (manifestSha256 !== sha256Json(manifest)) {
    fail(
      "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_HASH_MISMATCH",
      "Archived camera calibration manifest hash is invalid",
      { sessionId },
    );
  }
  const core = archiveEntryCore({
    sessionId,
    nodeId,
    project,
    outputIds,
    cameraViewIds,
    bundle,
    planSha256,
    manifestSha256,
    archivedAt,
    manifest,
  });
  const entrySha256 = sha256(value.entrySha256, "entry.entrySha256");
  if (entrySha256 !== sha256Json(core)) {
    fail(
      "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_HASH_MISMATCH",
      "Camera calibration archive entry hash is invalid",
      { sessionId },
    );
  }
  const byteLength = exactPositiveInteger(value.byteLength, "entry.byteLength");
  if (byteLength !== serializedEntryBytes(core, entrySha256)) {
    fail(
      "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_SIZE_MISMATCH",
      "Camera calibration archive entry byte length is invalid",
      { sessionId },
    );
  }
  return { ...core, entrySha256, byteLength };
}

function emptyArchive() {
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    entries: [],
    totalBytes: 0,
    updatedAt: null,
  };
}

function normalizeLimits(input = {}) {
  return {
    maxEntries: positiveInteger(
      input.maxEntries ?? CAMERA_CALIBRATION_MANIFEST_ARCHIVE_DEFAULTS.maxEntries,
      "archive maxEntries",
      1_024,
    ),
    maxBytes: positiveInteger(
      input.maxBytes ?? CAMERA_CALIBRATION_MANIFEST_ARCHIVE_DEFAULTS.maxBytes,
      "archive maxBytes",
    ),
  };
}

export function normalizeCameraCalibrationManifestArchive(input, limitsInput = {}) {
  const limits = normalizeLimits(limitsInput);
  if (input == null) return emptyArchive();
  const value = exactObject(
    input,
    ["schemaVersion", "entries", "totalBytes", "updatedAt"],
    "camera calibration manifest archive",
  );
  if (value.schemaVersion !== ARCHIVE_SCHEMA_VERSION || !Array.isArray(value.entries)) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID", "Camera calibration manifest archive is invalid");
  }
  const entries = value.entries.map(normalizeCameraCalibrationManifestArchiveEntry);
  const sessionIds = entries.map((entry) => entry.sessionId);
  if (new Set(sessionIds).size !== sessionIds.length) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID", "Archive session ids must be unique");
  }
  const pinnedViewCaptures = entries.filter((entry) => entry.bundle).map((entry) => entry.bundle.viewCaptureId);
  if (new Set(pinnedViewCaptures).size !== pinnedViewCaptures.length) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID", "Pinned bundle view captures must be unique");
  }
  const pinnedMembers = entries.filter((entry) => entry.bundle)
    .map((entry) => `${entry.bundle.bundleId}\0${entry.bundle.memberId}`);
  if (new Set(pinnedMembers).size !== pinnedMembers.length) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_INVALID", "Pinned bundle members must be unique");
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || value.totalBytes !== totalBytes) {
    fail("CAMERA_CALIBRATION_MANIFEST_ARCHIVE_SIZE_MISMATCH", "Archive total byte count is invalid");
  }
  const normalized = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    entries,
    totalBytes,
    updatedAt: value.updatedAt == null ? null : isoTimestamp(value.updatedAt, "archive.updatedAt"),
  };
  const serializedBytes = Buffer.byteLength(JSON.stringify(normalized), "utf8") + 1;
  if (entries.length > limits.maxEntries || serializedBytes > limits.maxBytes) {
    fail(
      "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_CAPACITY",
      "Camera calibration manifest archive exceeds its configured durable capacity",
      { entries: entries.length, totalBytes, serializedBytes, ...limits },
    );
  }
  return normalized;
}

function appendEntry(archiveInput, entryInput, limitsInput) {
  const limits = normalizeLimits(limitsInput);
  const archive = normalizeCameraCalibrationManifestArchive(archiveInput, limits);
  const entry = normalizeCameraCalibrationManifestArchiveEntry(entryInput);
  const existing = archive.entries.find((candidate) => candidate.sessionId === entry.sessionId);
  if (existing) {
    if (!sameReplayEvidence(existing, entry)) {
      fail(
        "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_REPLAY_MISMATCH",
        "Calibration session replay changed its immutable archive evidence",
        { sessionId: entry.sessionId },
      );
    }
    return archive;
  }
  const entries = [...archive.entries, entry];
  const removable = entries
    .filter((candidate) => candidate.bundle == null && candidate.sessionId !== entry.sessionId)
    .sort((left, right) => (
      Date.parse(left.archivedAt) - Date.parse(right.archivedAt)
      || left.sessionId.localeCompare(right.sessionId)
    ));
  let totalBytes = entries.reduce((sum, candidate) => sum + candidate.byteLength, 0);
  const serializedBytes = () => Buffer.byteLength(JSON.stringify({
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    entries,
    totalBytes,
    updatedAt: entry.archivedAt,
  }), "utf8") + 1;
  while ((entries.length > limits.maxEntries || serializedBytes() > limits.maxBytes) && removable.length > 0) {
    const stale = removable.shift();
    const index = entries.findIndex((candidate) => candidate.sessionId === stale.sessionId);
    if (index < 0) continue;
    totalBytes -= entries[index].byteLength;
    entries.splice(index, 1);
  }
  const finalSerializedBytes = serializedBytes();
  if (entries.length > limits.maxEntries || finalSerializedBytes > limits.maxBytes) {
    fail(
      "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_CAPACITY",
      "Pinned bundle manifests leave insufficient durable archive capacity",
      {
        entries: entries.length,
        pinnedEntries: entries.filter((candidate) => candidate.bundle).length,
        totalBytes,
        serializedBytes: finalSerializedBytes,
        ...limits,
      },
    );
  }
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    entries,
    totalBytes,
    updatedAt: entry.archivedAt,
  };
}

function assertLookupBinding(entry, {
  nodeId = null,
  project = null,
  outputIds = null,
  cameraViewId = null,
  bundle = undefined,
} = {}) {
  const normalizedProject = project == null ? null : normalizeProjectBinding(project, "lookup.project");
  const normalizedOutputIds = outputIds == null ? null : sortedUniqueText(outputIds, "lookup.outputIds");
  const normalizedBundle = bundle === undefined
    ? undefined
    : normalizeCameraCalibrationBundleArchiveBinding(bundle);
  if ((nodeId != null && entry.nodeId !== text(nodeId, "lookup.nodeId"))
    || (normalizedProject != null && canonicalJson(entry.project) !== canonicalJson(normalizedProject))
    || (normalizedOutputIds != null && canonicalJson(entry.outputIds) !== canonicalJson(normalizedOutputIds))
    || (cameraViewId != null && !entry.cameraViewIds.includes(text(cameraViewId, "lookup.cameraViewId")))
    || (normalizedBundle !== undefined && canonicalJson(entry.bundle) !== canonicalJson(normalizedBundle))) {
    fail(
      "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_BINDING_MISMATCH",
      "Archived manifest does not match the exact requested session binding",
      { sessionId: entry.sessionId },
    );
  }
}

export class CameraCalibrationManifestArchiveStore {
  constructor(pathname, {
    maxEntries = CAMERA_CALIBRATION_MANIFEST_ARCHIVE_DEFAULTS.maxEntries,
    maxBytes = CAMERA_CALIBRATION_MANIFEST_ARCHIVE_DEFAULTS.maxBytes,
  } = {}) {
    this.pathname = pathname;
    this.directory = dirname(pathname);
    this.limits = normalizeLimits({ maxEntries, maxBytes });
    this.committed = emptyArchive();
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try {
      const file = await stat(this.pathname);
      if (!file.isFile() || file.size > this.limits.maxBytes) {
        fail(
          "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_CAPACITY",
          "Camera calibration manifest archive file exceeds its configured byte boundary",
          { fileBytes: file.size, maxBytes: this.limits.maxBytes },
        );
      }
      const document = await readFile(this.pathname, "utf8");
      if (Buffer.byteLength(document, "utf8") > this.limits.maxBytes) {
        fail(
          "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_CAPACITY",
          "Camera calibration manifest archive content exceeds its configured byte boundary",
        );
      }
      this.committed = normalizeCameraCalibrationManifestArchive(
        JSON.parse(document),
        this.limits,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.#save(emptyArchive());
    }
    return this.summary();
  }

  async append(input) {
    const entry = createCameraCalibrationManifestArchiveEntry(input);
    const operation = this.writeChain.then(async () => {
      const existing = this.committed.entries.find((candidate) => candidate.sessionId === entry.sessionId);
      if (existing) {
        if (!sameReplayEvidence(existing, entry)) {
          fail(
            "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_REPLAY_MISMATCH",
            "Calibration session replay changed its immutable archive evidence",
            { sessionId: entry.sessionId },
          );
        }
        return this.get(entry.sessionId);
      }
      const candidate = appendEntry(this.committed, entry, this.limits);
      await this.#save(candidate);
      return this.get(entry.sessionId);
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  get(sessionIdInput, binding = {}) {
    const sessionId = text(sessionIdInput, "lookup.sessionId");
    const archive = normalizeCameraCalibrationManifestArchive(this.committed, this.limits);
    const entry = archive.entries.find((candidate) => candidate.sessionId === sessionId);
    if (!entry) {
      fail(
        "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_NOT_FOUND",
        `Measured calibration manifest ${sessionId} is not in the durable archive`,
        { sessionId },
      );
    }
    assertLookupBinding(entry, binding);
    return structuredClone(entry);
  }

  has(sessionIdInput, binding = {}) {
    try {
      this.get(sessionIdInput, binding);
      return true;
    } catch (error) {
      if (error?.code === "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_NOT_FOUND") return false;
      throw error;
    }
  }

  summary() {
    const archive = normalizeCameraCalibrationManifestArchive(this.committed, this.limits);
    return {
      schemaVersion: archive.schemaVersion,
      entries: archive.entries.length,
      pinnedEntries: archive.entries.filter((entry) => entry.bundle).length,
      totalBytes: archive.totalBytes,
      serializedBytes: Buffer.byteLength(JSON.stringify(archive), "utf8") + 1,
      maxEntries: this.limits.maxEntries,
      maxBytes: this.limits.maxBytes,
      updatedAt: archive.updatedAt,
      releaseProtocol: "unavailable-permanent-bundle-pins",
    };
  }

  async flush() {
    await this.writeChain;
  }

  async #syncDirectory() {
    let handle;
    try {
      handle = await open(this.directory, "r");
      await handle.sync();
    } catch (error) {
      if (!new Set(["EISDIR", "EINVAL", "EPERM", "EACCES", "ENOTSUP"]).has(error?.code)) throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async #save(input) {
    const candidate = normalizeCameraCalibrationManifestArchive(input, this.limits);
    const temporary = `${this.pathname}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const document = `${JSON.stringify(candidate)}\n`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(document, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.pathname);
      await this.#syncDirectory();
      this.committed = candidate;
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}
