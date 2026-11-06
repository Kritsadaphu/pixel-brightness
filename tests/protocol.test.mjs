import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMAND,
  PROTOCOL_VERSION,
  createCommand,
  defaultProject,
  normalizeNativePatternCommand,
  normalizeProject,
  normalizeRegistration,
} from "../runtime/shared/protocol.mjs";

test("node registrations advertise concrete output capabilities", () => {
  const registration = normalizeRegistration({
    protocolVersion: PROTOCOL_VERSION,
    nodeId: "render-01",
    capabilities: { outputs: [{ id: "A", connector: "DP-1" }], ndi: true },
  });
  assert.equal(registration.nodeId, "render-01");
  assert.equal(registration.capabilities.outputs[0].connector, "DP-1");
  assert.equal(registration.capabilities.ndi, true);
});

test("commands reject unknown operations", () => {
  assert.equal(createCommand(COMMAND.PREPARE).type, "prepare");
  assert.throws(() => createCommand("erase-everything"), /Unsupported command/);
});

test("corrected native patterns are explicit, solid-only, and fail closed", () => {
  assert.deepEqual(normalizeNativePatternCommand({
    outputId: "A",
    type: "solid",
    rgb: [0.0039, 0.18, 1],
    applyCorrections: true,
  }), {
    outputId: "A",
    enabled: true,
    type: "solid",
    rgb: [0.0039, 0.18, 1],
    applyCorrections: true,
  });
  assert.equal(normalizeNativePatternCommand({
    type: "solid",
    rgb: [0, 0, 0],
  }).applyCorrections, false, "omission must retain the raw calibration path");
  assert.throws(
    () => normalizeNativePatternCommand({ type: "grid", applyCorrections: true }),
    /only valid for a solid/,
  );
  assert.throws(
    () => normalizeNativePatternCommand({ type: "gray-code", axis: "x", bit: 0, applyCorrections: false }),
    /only valid for a solid/,
  );
  assert.throws(
    () => normalizeNativePatternCommand({ type: "solid", rgb: [0, 0, 2], applyCorrections: true }),
    /0-1 range/,
  );
  assert.throws(
    () => normalizeNativePatternCommand({ type: "solid", rgb: [0, 0, 0], applyCorrections: "yes" }),
    /must be boolean/,
  );

  const command = createCommand(COMMAND.CALIBRATION_PATTERN, {
    outputId: "A",
    type: "solid",
    rgb: [0.18, 0.18, 0.18],
    applyCorrections: true,
  });
  assert.equal(command.payload.applyCorrections, true);
  assert.throws(
    () => createCommand(COMMAND.CALIBRATION_PATTERN, { type: "identify", applyCorrections: true }),
    /only valid for a solid/,
  );
  assert.throws(
    () => createCommand(COMMAND.IDENTIFY_OUTPUT, { outputId: "A", applyCorrections: true }),
    /only valid for a solid/,
  );
});

test("project normalization creates a bounded distributed output model", () => {
  const source = defaultProject();
  source.outputs[0].nodeId = "render-01";
  source.outputs[0].warp = { columns: 32, rows: 32, points: null };
  const project = normalizeProject(source);
  assert.equal(project.canvas.width, 5_280);
  assert.equal(project.outputs.length, 3);
  assert.equal(project.outputs[0].nodeId, "render-01");
  assert.equal(project.outputs[0].warp.points.length, 33 * 33);
});

test("project normalization refuses duplicate output ids", () => {
  const source = defaultProject();
  source.outputs.push({ ...source.outputs[0] });
  assert.throws(() => normalizeProject(source), /Duplicate output id/);
});

test("project normalization preserves membership across arbitrary physical surfaces", () => {
  const source = defaultProject();
  source.walls = [
    { id: "stage-left", name: "Stage Left", layout: "horizontal" },
    { id: "column-01", name: "Column 01", layout: "vertical" },
    { id: "floor-zone-a", name: "Floor Zone A", layout: "independent" },
  ];
  source.outputs[0].wallId = "stage-left";
  source.outputs[1].wallId = "column-01";
  source.outputs[2].wallId = "floor-zone-a";

  const project = normalizeProject(source);
  assert.deepEqual(project.walls, source.walls);
  assert.deepEqual(
    project.outputs.map(({ id, wallId }) => ({ id, wallId })),
    [
      { id: "A", wallId: "stage-left" },
      { id: "B", wallId: "column-01" },
      { id: "C", wallId: "floor-zone-a" },
    ],
  );
});

test("project normalization rejects duplicate explicit surface ids", () => {
  const source = defaultProject();
  source.walls = [
    { id: "stage-left", name: "Stage Left" },
    { id: "stage-left", name: "Duplicate Stage" },
  ];
  assert.throws(() => normalizeProject(source), /Duplicate surface id: stage-left/);
});

test("project normalization rejects an explicit unknown output surface membership", () => {
  const source = defaultProject();
  source.walls = [
    { id: "stage-left", name: "Stage Left" },
    { id: "floor-zone-a", name: "Floor Zone A" },
  ];
  source.outputs.forEach((output) => { output.wallId = "stage-left"; });
  source.outputs[2].wallId = "ceiling-grid";

  assert.throws(
    () => normalizeProject(source),
    /Output C wallId references unknown surface id: ceiling-grid/,
  );
});

test("project normalization keeps the first-wall fallback for a missing legacy wallId", () => {
  const source = defaultProject();
  source.walls = [
    { id: "stage-left", name: "Stage Left" },
    { id: "floor-zone-a", name: "Floor Zone A" },
  ];
  delete source.outputs[0].wallId;
  source.outputs[1].wallId = "stage-left";
  source.outputs[2].wallId = "floor-zone-a";

  const project = normalizeProject(source);
  assert.equal(project.outputs[0].wallId, "stage-left");
});

test("project normalization infers legacy topology from explicit output memberships", () => {
  const source = defaultProject();
  delete source.walls;
  source.outputs[0].wallId = "stage-left";
  source.outputs[1].wallId = "column-01";
  source.outputs[2].wallId = "stage-left";

  const project = normalizeProject(source);
  assert.deepEqual(project.walls, [
    { id: "stage-left", name: "stage-left" },
    { id: "column-01", name: "column-01" },
  ]);
  assert.deepEqual(project.outputs.map((output) => output.wallId), [
    "stage-left", "column-01", "stage-left",
  ]);
});

test("project normalization accepts historical surface ids containing colon", () => {
  const source = defaultProject();
  source.walls = [{ id: "venue:render-01-wall", name: "Venue Render 01" }];
  source.outputs.forEach((output) => { output.wallId = "venue:render-01-wall"; });

  const project = normalizeProject(source);
  assert.equal(project.walls[0].id, "venue:render-01-wall");
  assert.ok(project.outputs.every((output) => output.wallId === "venue:render-01-wall"));
});

test("project normalization retains the legacy default when topology and memberships are absent", () => {
  const source = defaultProject();
  delete source.walls;
  source.outputs.forEach((output) => { delete output.wallId; });

  const project = normalizeProject(source);
  assert.deepEqual(project.walls, defaultProject().walls);
  assert.equal(Object.prototype.hasOwnProperty.call(project.walls[0], "layout"), false);
  assert.deepEqual(project.outputs.map((output) => output.wallId), [
    "wall-north", "wall-north", "wall-north",
  ]);
});

test("project normalization preserves an omitted layout as an explicit legacy compatibility state", () => {
  const source = defaultProject();
  source.walls = [
    { id: "stage-left", name: "Stage Left" },
    { id: "floor-zone-a", name: "Floor Zone A" },
  ];
  source.outputs.forEach((output, index) => {
    output.wallId = index < 2 ? "stage-left" : "floor-zone-a";
  });

  const project = normalizeProject(source);
  assert.deepEqual(project.walls, source.walls);
  assert.ok(project.walls.every((surface) => (
    !Object.prototype.hasOwnProperty.call(surface, "layout")
  )));
});

test("project normalization rejects every explicitly invalid surface layout", () => {
  for (const layout of ["diagonal", "Horizontal", "", null, undefined, 1]) {
    const source = defaultProject();
    source.walls = [{ id: "stage-left", name: "Stage Left", layout }];
    source.outputs.forEach((output) => { output.wallId = "stage-left"; });
    assert.throws(
      () => normalizeProject(source),
      /entry 1 layout must be independent, horizontal, or vertical/,
    );
  }
});

test("project normalization requires a non-empty bounded surface topology", () => {
  const empty = defaultProject();
  empty.walls = [];
  assert.throws(() => normalizeProject(empty), /surface topology must be a non-empty array/);

  const notAnArray = defaultProject();
  notAnArray.walls = { id: "stage-left", name: "Stage Left" };
  assert.throws(() => normalizeProject(notAnArray), /surface topology must be a non-empty array/);

  const overLimit = defaultProject();
  overLimit.walls = Array.from({ length: 129 }, (_value, index) => ({
    id: `surface-${index + 1}`,
    name: `Surface ${index + 1}`,
  }));
  assert.throws(() => normalizeProject(overLimit), /at most 128 surfaces/);

  const inferredOverLimit = defaultProject();
  delete inferredOverLimit.walls;
  inferredOverLimit.outputs = Array.from({ length: 129 }, (_value, index) => ({
    ...structuredClone(inferredOverLimit.outputs[0]),
    id: `output-${index + 1}`,
    wallId: `surface-${index + 1}`,
  }));
  assert.throws(() => normalizeProject(inferredOverLimit), /at most 128 surfaces/);
});

test("project normalization rejects unsafe surface ids and display names", () => {
  const unsafeId = defaultProject();
  unsafeId.walls = [{ id: "stage/../left", name: "Stage Left" }];
  assert.throws(() => normalizeProject(unsafeId), /entry 1 id must be 1-128/);

  const missingId = defaultProject();
  missingId.walls = [{ name: "Stage Left" }];
  assert.throws(() => normalizeProject(missingId), /entry 1 id must be 1-128/);

  for (const name of ["", " Stage Left", "Stage\nLeft", "x".repeat(257)]) {
    const unsafeName = defaultProject();
    unsafeName.walls = [{ id: "stage-left", name }];
    assert.throws(() => normalizeProject(unsafeName), /entry 1 name must be canonical display text/);
  }

  const unsafeMembership = defaultProject();
  unsafeMembership.outputs[0].wallId = "stage/../left";
  assert.throws(() => normalizeProject(unsafeMembership), /Output A wallId must be 1-128/);

  for (const wallId of [undefined, null, ""]) {
    const missingMembership = defaultProject();
    missingMembership.outputs[0].wallId = wallId;
    assert.throws(() => normalizeProject(missingMembership), /Output A wallId must be 1-128/);
  }
});

test("project normalization requires case-insensitively unique normalized surface names", () => {
  const differentCase = defaultProject();
  differentCase.walls = [
    { id: "stage-left", name: "Stage Left" },
    { id: "column-01", name: "stage left" },
  ];
  assert.throws(() => normalizeProject(differentCase), /Duplicate surface name \(case-insensitive\)/);

  const equivalentUnicode = defaultProject();
  equivalentUnicode.walls = [
    { id: "stage-left", name: "A" },
    { id: "column-01", name: "Ａ" },
  ];
  assert.throws(() => normalizeProject(equivalentUnicode), /Duplicate surface name \(case-insensitive\)/);
});

test("project normalization uses a safe surface id as the legacy missing-name fallback", () => {
  const source = defaultProject();
  source.walls = [{ id: "floor-zone-a" }];
  source.outputs.forEach((output) => { output.wallId = "floor-zone-a"; });

  assert.deepEqual(normalizeProject(source).walls, [
    { id: "floor-zone-a", name: "floor-zone-a" },
  ]);
});

test("project normalization rejects source areas outside the master canvas", () => {
  const negative = defaultProject();
  negative.outputs[0].sourceViewport.x = -1;
  assert.throws(() => normalizeProject(negative), /sourceViewport must stay inside/);

  const overflow = defaultProject();
  overflow.outputs[2].sourceViewport.width = 2_000;
  assert.throws(() => normalizeProject(overflow), /sourceViewport must stay inside/);
});

test("project normalization rejects configurations a native render node cannot apply", () => {
  const invalidId = defaultProject();
  invalidId.outputs[0].id = "projector A/../../renderer";
  assert.throws(() => normalizeProject(invalidId), /Output id must be 1-64/);

  const emptyMask = defaultProject();
  emptyMask.outputs[0].mask = { enabled: true, map: null, path: [] };
  assert.throws(() => normalizeProject(emptyMask), /enabled mask requires/);

  const tooManyForOneNode = defaultProject();
  tooManyForOneNode.outputs = Array.from({ length: 33 }, (_value, index) => ({
    ...structuredClone(tooManyForOneNode.outputs[0]),
    id: `render-01-${index + 1}`,
    nodeId: "render-01",
  }));
  assert.throws(() => normalizeProject(tooManyForOneNode), /supports at most 32 outputs/);
});
