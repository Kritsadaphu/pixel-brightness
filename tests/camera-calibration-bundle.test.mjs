import assert from "node:assert/strict";
import test from "node:test";

import {
  CAMERA_CALIBRATION_BUNDLE_EVENT,
  CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE,
  CAMERA_CALIBRATION_BUNDLE_STATE,
  CameraCalibrationBundleError,
  cameraCalibrationBundleSurveySha256,
  createCameraCalibrationBundle,
  createServerCameraViewCaptureId,
  normalizeCameraCalibrationBundle,
  reduceCameraCalibrationBundle,
} from "../runtime/shared/camera-calibration-bundle.mjs";

const digest = (character) => character.repeat(64);
const baseProject = { id: "immersive-room", revision: 7 };
const frame = { width: 2_432, height: 1_621 };
const lensProfileSha256 = digest("a");

function preview(id, artifactCharacter, capturedAt = "2026-08-24T10:00:00.000Z") {
  return {
    id,
    artifactSha256: digest(artifactCharacter),
    capturedAt,
    authenticatedAt: new Date(Date.parse(capturedAt) + 1_000).toISOString(),
    authentication: "server-verified-preview-artifact-v1",
  };
}

function survey({ id, wallId, cameraViewId, x = 0.1 }) {
  return {
    id,
    wallId,
    cameraViewId,
    frame,
    lensProfileSha256,
    boundary: [
      { x, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x, y: 0.9 },
    ],
    method: "operator-four-corner-planar-v1",
  };
}

function member({
  memberId,
  cameraViewId,
  viewCaptureId,
  wallId,
  outputIds,
  artifactCharacter,
}) {
  return {
    memberId,
    cameraViewId,
    viewCaptureId,
    viewCaptureAuthority: "server",
    poseRegistration: "independent-planar",
    lensProfileSha256,
    frame,
    outputIds,
    preview: preview(`preview-${memberId}`, artifactCharacter),
    survey: survey({ id: `survey-${memberId}`, wallId, cameraViewId }),
  };
}

function input(overrides = {}) {
  return {
    bundleId: "bundle-001",
    baseProject,
    expectedOutputIds: ["north-a", "north-b", "east-a", "east-b"],
    members: [
      member({
        memberId: "north",
        cameraViewId: "camera-view-north",
        viewCaptureId: "viewcap_11111111-1111-4111-8111-111111111111",
        wallId: "wall-north",
        outputIds: ["north-a", "north-b"],
        artifactCharacter: "b",
      }),
      member({
        memberId: "east",
        cameraViewId: "camera-view-east",
        viewCaptureId: "viewcap_22222222-2222-4222-8222-222222222222",
        wallId: "wall-east",
        outputIds: ["east-a", "east-b"],
        artifactCharacter: "c",
      }),
    ],
    sameWallOverlaps: [
      { id: "north-overlap", wallId: "wall-north", outputIds: ["north-a", "north-b"] },
      { id: "east-overlap", wallId: "wall-east", outputIds: ["east-a", "east-b"] },
    ],
    physicalAdjacencies: [
      { id: "north-east-seam", wallIds: ["wall-north", "wall-east"], outputIds: ["north-b", "east-a"] },
    ],
    createdAt: "2026-08-24T10:01:00.000Z",
    ...overrides,
  };
}

function create(overrides = {}) {
  return createCameraCalibrationBundle(input(overrides), { currentProject: baseProject });
}

function calibrationEvent(memberId, character, minute) {
  const completedAt = `2026-08-24T10:0${minute}:00.000Z`;
  return {
    type: CAMERA_CALIBRATION_BUNDLE_EVENT.MEMBER_CALIBRATED,
    memberId,
    evidence: {
      sessionId: `session-${memberId}`,
      manifestSha256: digest(character),
      baseProjectRevision: baseProject.revision,
      completedAt,
    },
    at: completedAt,
  };
}

function finalEvent() {
  return {
    type: CAMERA_CALIBRATION_BUNDLE_EVENT.FINAL_RENDERER_ACKNOWLEDGED,
    evidence: {
      commitId: "commit-bundle-001",
      projectRevision: 8,
      rendererCorrectionFingerprint: digest("f"),
      acknowledgedAt: "2026-08-24T10:04:00.000Z",
    },
    at: "2026-08-24T10:04:00.000Z",
  };
}

function verificationEvent(memberId, character, minute) {
  const completedAt = `2026-08-24T10:0${minute}:00.000Z`;
  return {
    type: CAMERA_CALIBRATION_BUNDLE_EVENT.MEMBER_VERIFIED,
    memberId,
    evidence: {
      verificationId: `verification-${memberId}`,
      reportSha256: digest(character),
      projectRevision: 8,
      rendererCorrectionFingerprint: digest("f"),
      completedAt,
    },
    at: completedAt,
  };
}

function reachPerViewVerified(bundle = create()) {
  let next = reduceCameraCalibrationBundle(bundle, calibrationEvent("north", "d", 2), { currentProject: baseProject });
  next = reduceCameraCalibrationBundle(next, calibrationEvent("east", "e", 3), { currentProject: baseProject });
  assert.equal(next.aggregateState, CAMERA_CALIBRATION_BUNDLE_STATE.CALIBRATED);
  next = reduceCameraCalibrationBundle(next, finalEvent(), { currentProject: { id: baseProject.id, revision: 8 } });
  next = reduceCameraCalibrationBundle(next, verificationEvent("north", "1", 5), {
    currentProject: { id: baseProject.id, revision: 8 },
  });
  return reduceCameraCalibrationBundle(next, verificationEvent("east", "2", 6), {
    currentProject: { id: baseProject.id, revision: 8 },
  });
}

test("creates a strict immutable-base bundle with exact survey identity", () => {
  const bundle = create();
  assert.equal(bundle.aggregateState, CAMERA_CALIBRATION_BUNDLE_STATE.COLLECTING);
  assert.equal(bundle.members[0].state, CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.PENDING);
  assert.equal(bundle.members[0].survey.sha256, cameraCalibrationBundleSurveySha256(input().members[0].survey));
  assert.equal(Object.isFrozen(bundle.baseProject), true);
  assert.deepEqual(normalizeCameraCalibrationBundle(bundle, { expectedBaseProject: baseProject }), bundle);
  assert.throws(
    () => normalizeCameraCalibrationBundle(bundle, { expectedBaseProject: { ...baseProject, revision: 8 } }),
    (error) => error.code === "STALE_CAMERA_CALIBRATION_BUNDLE_BASE",
  );
  assert.throws(
    () => createCameraCalibrationBundle(input(), { currentProject: { ...baseProject, revision: 8 } }),
    (error) => error instanceof CameraCalibrationBundleError
      && error.code === "STALE_CAMERA_CALIBRATION_BUNDLE_BASE",
  );
  assert.match(
    createServerCameraViewCaptureId({ randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    /^viewcap_/,
  );
});

test("rejects duplicate, missing and reused view/capture evidence", () => {
  const duplicateOutputs = input();
  duplicateOutputs.members[1].outputIds[0] = "north-b";
  assert.throws(
    () => createCameraCalibrationBundle(duplicateOutputs, { currentProject: baseProject }),
    (error) => error.code === "DUPLICATE_BUNDLE_OUTPUT",
  );

  const missingOutput = input({ expectedOutputIds: ["north-a", "north-b", "east-a", "east-b", "ceiling-a"] });
  assert.throws(
    () => createCameraCalibrationBundle(missingOutput, { currentProject: baseProject }),
    (error) => error.code === "BUNDLE_OUTPUT_COVERAGE_MISMATCH"
      && error.details.missing.includes("ceiling-a"),
  );

  for (const mutate of [
    (value) => { value.members[1].cameraViewId = value.members[0].cameraViewId; value.members[1].survey.cameraViewId = value.members[0].cameraViewId; },
    (value) => { value.members[1].viewCaptureId = value.members[0].viewCaptureId; },
    (value) => { value.members[1].preview.id = value.members[0].preview.id; },
    (value) => { value.members[1].preview.artifactSha256 = value.members[0].preview.artifactSha256; },
  ]) {
    const reused = input();
    mutate(reused);
    assert.throws(
      () => createCameraCalibrationBundle(reused, { currentProject: baseProject }),
      (error) => error.code === "REUSED_CAMERA_VIEW_CAPTURE",
    );
  }
});

test("rejects a declared same-wall overlap split across fixed views", () => {
  const split = input();
  split.members[1].survey.wallId = "wall-north";
  split.sameWallOverlaps = [
    { id: "illegal-split", wallId: "wall-north", outputIds: ["north-b", "east-a"] },
  ];
  split.physicalAdjacencies = [];
  assert.throws(
    () => createCameraCalibrationBundle(split, { currentProject: baseProject }),
    (error) => error.code === "SAME_WALL_OVERLAP_SPLIT",
  );
});

test("reducers preserve per-view evidence and require final revision/fingerprint binding", () => {
  let bundle = create();
  bundle = reduceCameraCalibrationBundle(bundle, calibrationEvent("north", "d", 2), { currentProject: baseProject });
  assert.equal(bundle.aggregateState, CAMERA_CALIBRATION_BUNDLE_STATE.COLLECTING);
  bundle = reduceCameraCalibrationBundle(bundle, calibrationEvent("east", "e", 3), { currentProject: baseProject });
  assert.equal(bundle.aggregateState, CAMERA_CALIBRATION_BUNDLE_STATE.CALIBRATED);
  assert.equal(bundle.members[0].calibrationEvidence.manifestSha256, digest("d"));

  bundle = reduceCameraCalibrationBundle(bundle, finalEvent(), { currentProject: { id: baseProject.id, revision: 8 } });
  assert.equal(bundle.finalEvidence.rendererCorrectionFingerprint, digest("f"));
  const wrongFingerprint = verificationEvent("north", "1", 5);
  wrongFingerprint.evidence.rendererCorrectionFingerprint = digest("0");
  assert.throws(
    () => reduceCameraCalibrationBundle(bundle, wrongFingerprint, { currentProject: { id: baseProject.id, revision: 8 } }),
    (error) => error.code === "FINAL_BUNDLE_EVIDENCE_MISMATCH",
  );
  assert.throws(
    () => reduceCameraCalibrationBundle(bundle, verificationEvent("north", "1", 5), { currentProject: baseProject }),
    (error) => error.code === "STALE_CAMERA_CALIBRATION_BUNDLE_BASE",
  );
});

test("all per-view checks still report cross-view seams unverified until every adjacency passes", () => {
  let bundle = reachPerViewVerified();
  assert.equal(bundle.aggregateState, CAMERA_CALIBRATION_BUNDLE_STATE.SEAMS_UNVERIFIED);
  bundle = reduceCameraCalibrationBundle(bundle, {
    type: CAMERA_CALIBRATION_BUNDLE_EVENT.ADJACENCY_OBSERVED,
    adjacencyId: "north-east-seam",
    observation: {
      observationId: "observation-north-east-001",
      cameraViewId: "bridge-view-north-east",
      viewCaptureId: "viewcap_33333333-3333-4333-8333-333333333333",
      viewCaptureAuthority: "server",
      preview: preview("preview-bridge-north-east", "3", "2026-08-24T10:06:20.000Z"),
      evidenceSha256: digest("4"),
      status: "passed",
      projectRevision: 8,
      rendererCorrectionFingerprint: digest("f"),
      observedAt: "2026-08-24T10:07:00.000Z",
    },
    at: "2026-08-24T10:07:00.000Z",
  }, { currentProject: { id: baseProject.id, revision: 8 } });
  assert.equal(bundle.aggregateState, CAMERA_CALIBRATION_BUNDLE_STATE.ROOM_VERIFIED);
  assert.equal(bundle.physicalAdjacencies[0].observations.length, 1);
});

test("without declared physical adjacencies the strongest claim is per-view-verified", () => {
  const bundle = reachPerViewVerified(create({ physicalAdjacencies: [] }));
  assert.equal(bundle.aggregateState, CAMERA_CALIBRATION_BUNDLE_STATE.VERIFIED);
});

test("forged room verification and reused bridge captures are rejected", () => {
  const perView = reachPerViewVerified();
  const forged = structuredClone(perView);
  forged.aggregateState = CAMERA_CALIBRATION_BUNDLE_STATE.ROOM_VERIFIED;
  assert.throws(
    () => normalizeCameraCalibrationBundle(forged),
    (error) => error.code === "ROOM_VERIFICATION_EVIDENCE_MISSING",
  );

  const reused = {
    type: CAMERA_CALIBRATION_BUNDLE_EVENT.ADJACENCY_OBSERVED,
    adjacencyId: "north-east-seam",
    observation: {
      observationId: "observation-reused",
      cameraViewId: perView.members[0].cameraViewId,
      viewCaptureId: "viewcap_44444444-4444-4444-8444-444444444444",
      viewCaptureAuthority: "server",
      preview: preview("preview-bridge-duplicate", "5", "2026-08-24T10:06:20.000Z"),
      evidenceSha256: digest("6"),
      status: "passed",
      projectRevision: 8,
      rendererCorrectionFingerprint: digest("f"),
      observedAt: "2026-08-24T10:07:00.000Z",
    },
    at: "2026-08-24T10:07:00.000Z",
  };
  assert.throws(
    () => reduceCameraCalibrationBundle(perView, reused, { currentProject: { id: baseProject.id, revision: 8 } }),
    (error) => error.code === "REUSED_CAMERA_VIEW_CAPTURE",
  );
});

test("invalid ordering and member failure produce explicit states", () => {
  assert.throws(
    () => reduceCameraCalibrationBundle(create(), finalEvent(), { currentProject: { id: baseProject.id, revision: 8 } }),
    (error) => error.code === "INVALID_BUNDLE_TRANSITION",
  );
  const failed = reduceCameraCalibrationBundle(create(), {
    type: CAMERA_CALIBRATION_BUNDLE_EVENT.MEMBER_FAILED,
    memberId: "north",
    failure: {
      code: "CAMERA_DISCONNECTED",
      message: "Camera disconnected during capture",
      failedAt: "2026-08-24T10:02:00.000Z",
    },
    at: "2026-08-24T10:02:00.000Z",
  }, { currentProject: baseProject });
  assert.equal(failed.aggregateState, CAMERA_CALIBRATION_BUNDLE_STATE.FAILED);
});

test("strict normalization rejects unknown fields and a tampered survey digest", () => {
  const bundle = create();
  const unknown = structuredClone(bundle);
  unknown.members[0].clientHint = true;
  assert.throws(() => normalizeCameraCalibrationBundle(unknown), /must contain exactly/);

  const tampered = structuredClone(bundle);
  tampered.members[0].survey.boundary[0].x += 0.01;
  assert.throws(
    () => normalizeCameraCalibrationBundle(tampered),
    (error) => error.code === "SURVEY_IDENTITY_MISMATCH",
  );
});
