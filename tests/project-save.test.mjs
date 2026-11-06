import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogProjectSurfaces,
  createPhysicalSurface,
  exactOverlapVector,
  mergeAuthoritativeOutputs,
  projectSyncReadiness,
  rebuildPhysicalSurfaceSeams,
  renamePhysicalSurface,
  resolvePhysicalSurfaceLayout,
  setPhysicalSurfaceLayout,
  validatePhysicalSurfaceTopology,
} from "../app/lib/project-save.mjs";

const resolution = { width: 1920, height: 1080 };
const zero = { left: 0, right: 0, top: 0, bottom: 0 };
const output = (id, wallId, x, y, overlap = zero, width = 1920, height = 1080) => ({
  id,
  wallId,
  sourceViewport: { x, y, width, height },
  resolution,
  overlap: exactOverlapVector(overlap),
});

test("spatial output merge preserves hidden authoritative table and wall topology", () => {
  const wall = { id: "wall-A", wallId: "surface-wall", overlap: { right: 120 } };
  const hiddenTable = { id: "table-hidden", wallId: "surface-table", overlap: { left: 0, right: 0 } };

  const merged = mergeAuthoritativeOutputs(
    [wall, hiddenTable],
    "wall-A",
    (output) => output.id === "wall-A" ? { ...output, overlap: { right: 240 } } : output,
    { id: "wall-A" },
  );

  assert.deepEqual(merged.map((output) => output.id), ["wall-A", "table-hidden"]);
  assert.equal(merged[0].overlap.right, 240);
  assert.deepEqual(merged[1], hiddenTable, "an output omitted from the current UI remains authoritative");
});

test("surface catalog supports arbitrary unique surfaces and safe display-name renames", () => {
  const catalog = catalogProjectSurfaces(
    [{ id: "surface-stage", name: "Stage", layout: "horizontal", calibration: { locked: true } }],
    [{ id: "A", wallId: "surface-stage" }, { id: "B", wallId: "surface-balcony" }],
  );
  assert.deepEqual(catalog.map(({ id, name }) => ({ id, name })), [
    { id: "surface-stage", name: "Stage" },
    { id: "surface-balcony", name: "surface-balcony" },
  ]);

  const created = createPhysicalSurface(catalog, { id: "surface-floor.2", name: "Floor Two" });
  assert.equal(created.surface.id, "surface-floor.2");
  assert.equal(created.surface.layout, "independent", "new surfaces must fail safe with no inferred seams");
  assert.throws(
    () => createPhysicalSurface(created.surfaces, { id: "surface-stage", name: "Duplicate ID" }),
    /already exists/,
  );
  assert.throws(
    () => createPhysicalSurface(created.surfaces, { id: "Surface Upper", name: "Upper" }),
    /lowercase letters/,
  );
  assert.throws(
    () => createPhysicalSurface(created.surfaces, { id: "surface-upper", name: "floor two" }),
    /name .* already exists/i,
  );

  const renamed = renamePhysicalSurface(created.surfaces, "surface-stage", "Main Stage");
  assert.equal(renamed[0].id, "surface-stage", "safe rename keeps the assignment ID immutable");
  assert.equal(renamed[0].name, "Main Stage");
  assert.deepEqual(renamed[0].calibration, { locked: true }, "safe rename preserves surface metadata");
  assert.throws(() => renamePhysicalSurface(renamed, "surface-stage", "Floor Two"), /already exists/);
  const vertical = setPhysicalSurfaceLayout(renamed, "surface-stage", "vertical");
  assert.equal(vertical[0].layout, "vertical");
  assert.throws(() => setPhysicalSurfaceLayout(vertical, "surface-stage", "grid"), /independent, horizontal, or vertical/);
});

test("legacy layout inference uses committed edge vectors and rejects both-axis ambiguity", () => {
  const omitted = { id: "legacy", name: "Legacy" };
  assert.equal(resolvePhysicalSurfaceLayout(omitted, [output("A", "legacy", 0, 0)]).layout, "independent");
  assert.equal(resolvePhysicalSurfaceLayout(omitted, [output("A", "legacy", 0, 0, { right: 10 })]).layout, "horizontal");
  assert.equal(resolvePhysicalSurfaceLayout(omitted, [output("A", "legacy", 0, 0, { bottom: 10 })]).layout, "vertical");
  const ambiguous = resolvePhysicalSurfaceLayout(omitted, [output("A", "legacy", 0, 0, { right: 10, bottom: 10 })]);
  assert.equal(ambiguous.layout, null);
  assert.match(ambiguous.issue, /both axes/);
});

test("exact overlap vectors round-trip asymmetric values without max-collapse", () => {
  assert.deepEqual(exactOverlapVector({ left: 120, right: 240, top: 7, bottom: 9 }), {
    left: 120,
    right: 240,
    top: 7,
    bottom: 9,
  });
});

test("horizontal reassignment clears stale four-edge state and accepts only the actual 240px intersection", () => {
  const surfaces = [
    { id: "surface-old", name: "Old", layout: "vertical" },
    { id: "surface-new", name: "New", layout: "horizontal" },
  ];
  const topology = [
    output("old-top", "surface-old", 0, 0, { bottom: 120 }),
    output("active", "surface-old", 0, 960, { left: 9, right: 8, top: 120, bottom: 120 }),
    output("old-bottom", "surface-old", 0, 1920, { top: 120 }),
    output("new-left", "surface-new", 0, 0),
  ];
  const rebuilt = rebuildPhysicalSurfaceSeams(topology, {
    activeId: "active",
    targetSurfaceId: "surface-new",
    targetLayout: "horizontal",
    surfaces,
    overlap: { left: 240, right: 0, top: 777, bottom: 888 },
    sourceViewport: { x: 1680, y: 0, width: 1920, height: 1080 },
  });
  const byId = Object.fromEntries(rebuilt.map((output) => [output.id, output]));
  assert.deepEqual(rebuilt.map((item) => item.id), topology.map((item) => item.id));
  assert.equal(byId.active.wallId, "surface-new");
  assert.deepEqual(byId.active.overlap, { left: 240, right: 0, top: 0, bottom: 0 });
  assert.equal(byId["old-top"].overlap.bottom, 0);
  assert.equal(byId["old-bottom"].overlap.top, 0);
  assert.equal(byId["new-left"].overlap.right, 240);
  const valid = validatePhysicalSurfaceTopology(surfaces, rebuilt);
  assert.equal(valid.valid, true, valid.issues.map((issue) => issue.message).join("; "));

  const gap = rebuildPhysicalSurfaceSeams(topology, {
    activeId: "active",
    targetSurfaceId: "surface-new",
    targetLayout: "horizontal",
    surfaces,
    overlap: { left: 240, right: 0, top: 0, bottom: 0 },
    sourceViewport: { x: 2160, y: 0, width: 1920, height: 1080 },
  });
  const rejected = validatePhysicalSurfaceTopology(surfaces, gap);
  assert.equal(rejected.valid, false);
  assert.match(rejected.issues.map((issue) => issue.message).join("; "), /gap or only touch.*0px/i);
});

test("vertical in-surface reorder clears stale top/bottom reciprocals before applying new neighbours", () => {
  const surfaces = [{ id: "surface-stage", name: "Stage", layout: "vertical" }];
  const rebuilt = rebuildPhysicalSurfaceSeams([
    output("A", "surface-stage", 0, 0, { bottom: 240 }),
    output("B", "surface-stage", 0, 840, { left: 91, right: 92, top: 240, bottom: 240 }),
    output("C", "surface-stage", 0, 1680, { top: 240 }),
  ], {
    activeId: "B",
    targetSurfaceId: "surface-stage",
    targetLayout: "vertical",
    surfaces,
    overlap: { left: 99, right: 98, top: 240, bottom: 0 },
    sourceViewport: { x: 0, y: 2520, width: 1920, height: 1080 },
  });
  const byId = Object.fromEntries(rebuilt.map((item) => [item.id, item]));
  assert.equal(byId.A.overlap.bottom, 0, "former top neighbour is cleared");
  assert.equal(byId.C.overlap.top, 0, "C's former reciprocal edge is cleared");
  assert.equal(byId.C.overlap.bottom, 240, "C becomes the newly measured top neighbour");
  assert.deepEqual(byId.B.overlap, { left: 0, right: 0, top: 240, bottom: 0 });
  const validation = validatePhysicalSurfaceTopology(surfaces, rebuilt);
  assert.equal(validation.valid, true, validation.issues.map((issue) => issue.message).join("; "));
});

test("layout changes atomically clear all old-axis ramps and derive every new-axis seam", () => {
  const horizontalSurface = [{ id: "surface-stage", name: "Stage", layout: "horizontal" }];
  const horizontal = [
    output("A", "surface-stage", 0, 0, { right: 240 }),
    output("B", "surface-stage", 1680, 0, { left: 240, right: 240 }),
    output("C", "surface-stage", 3360, 0, { left: 240 }),
  ];
  const independent = rebuildPhysicalSurfaceSeams(horizontal, {
    activeId: "B",
    targetSurfaceId: "surface-stage",
    targetLayout: "independent",
    surfaces: horizontalSurface,
    overlap: { left: 240, right: 240, top: 10, bottom: 10 },
    sourceViewport: horizontal[1].sourceViewport,
  });
  assert.deepEqual(independent.map((item) => item.overlap), [zero, zero, zero]);
  assert.equal(validatePhysicalSurfaceTopology(
    [{ ...horizontalSurface[0], layout: "independent" }],
    independent,
  ).valid, true);

  const verticalGeometryWithStaleHorizontalRamps = [
    output("A", "surface-stage", 0, 0, { right: 17 }),
    output("B", "surface-stage", 0, 840, { left: 17, right: 19 }),
    output("C", "surface-stage", 0, 1680, { left: 19 }),
  ];
  const vertical = rebuildPhysicalSurfaceSeams(verticalGeometryWithStaleHorizontalRamps, {
    activeId: "B",
    targetSurfaceId: "surface-stage",
    targetLayout: "vertical",
    surfaces: horizontalSurface,
    overlap: zero,
    sourceViewport: verticalGeometryWithStaleHorizontalRamps[1].sourceViewport,
  });
  assert.deepEqual(vertical.map((item) => item.overlap), [
    { left: 0, right: 0, top: 0, bottom: 240 },
    { left: 0, right: 0, top: 240, bottom: 240 },
    { left: 0, right: 0, top: 240, bottom: 0 },
  ]);
  const verticalValidation = validatePhysicalSurfaceTopology(
    [{ ...horizontalSurface[0], layout: "vertical" }],
    vertical,
  );
  assert.equal(verticalValidation.valid, true, verticalValidation.issues.map((issue) => issue.message).join("; "));
});

test("project-wide validation allows zero-edge transition singletons but rejects orphan, reciprocal, 2D, and axis-sum hazards", () => {
  const surface = [{ id: "row", name: "Row", layout: "horizontal" }];
  const singleton = validatePhysicalSurfaceTopology(surface, [output("A", "row", 0, 0)]);
  assert.equal(singleton.valid, true, "a zero-edge singleton must not deadlock moving its former partner away");

  const unsafe = [
    output("A", "row", 0, 0, { left: 1, right: 240, top: 1 }),
    output("B", "row", 1680, 10, { left: 120, right: 1800 }),
  ];
  const validation = validatePhysicalSurfaceTopology(surface, unsafe);
  const codes = validation.issues.map((issue) => issue.code);
  assert.equal(validation.valid, false);
  assert.ok(codes.includes("orphan-leading-edge"));
  assert.ok(codes.includes("inactive-edge"));
  assert.ok(codes.includes("reciprocal-mismatch"));
  assert.ok(codes.includes("ambiguous-2d"));
  assert.ok(codes.includes("axis-sum"));
});

test("moving one output out of a pair clears the old reciprocal and leaves a valid singleton", () => {
  const surfaces = [
    { id: "row", name: "Row", layout: "horizontal" },
    { id: "solo", name: "Solo", layout: "independent" },
  ];
  const topology = [
    output("A", "row", 0, 0, { right: 240 }),
    output("B", "row", 1680, 0, { left: 240 }),
  ];
  const rebuilt = rebuildPhysicalSurfaceSeams(topology, {
    activeId: "B",
    targetSurfaceId: "solo",
    targetLayout: "independent",
    surfaces,
    overlap: { left: 240, right: 0, top: 13, bottom: 14 },
    sourceViewport: topology[1].sourceViewport,
  });
  const byId = Object.fromEntries(rebuilt.map((item) => [item.id, item]));
  assert.deepEqual(byId.A.overlap, zero);
  assert.deepEqual(byId.B.overlap, zero);
  const validation = validatePhysicalSurfaceTopology(surfaces, rebuilt);
  assert.equal(validation.valid, true, validation.issues.map((issue) => issue.message).join("; "));
});

test("reassignment clears stale reciprocal edges on both axes even when the old explicit layout is wrong", () => {
  const surfaces = [
    { id: "wrong", name: "Wrong legacy state", layout: "independent" },
    { id: "target", name: "Target", layout: "independent" },
  ];
  const topology = [
    output("top", "wrong", 0, 0, { bottom: 80 }),
    output("active", "wrong", 0, 1000, { left: 70, right: 70, top: 80, bottom: 80 }),
    output("bottom", "wrong", 0, 2000, { top: 80 }),
  ];
  const rebuilt = rebuildPhysicalSurfaceSeams(topology, {
    activeId: "active",
    targetSurfaceId: "target",
    targetLayout: "independent",
    surfaces,
    overlap: { left: 70, right: 70, top: 80, bottom: 80 },
    sourceViewport: topology[1].sourceViewport,
  });
  const byId = Object.fromEntries(rebuilt.map((item) => [item.id, item]));
  assert.equal(byId.top.overlap.bottom, 0);
  assert.equal(byId.bottom.overlap.top, 0);
  assert.deepEqual(byId.active.overlap, zero);
});

test("legacy inferred layouts require explicit operator confirmation before Save/LIVE", () => {
  const legacy = [{ id: "legacy", name: "Legacy" }];
  const topology = [output("A", "legacy", 0, 0)];
  const blocked = validatePhysicalSurfaceTopology(legacy, topology);
  assert.equal(blocked.valid, false);
  assert.ok(blocked.issues.some((issue) => issue.code === "layout-confirmation-required"));
  assert.equal(validatePhysicalSurfaceTopology(legacy, topology, { requireExplicitLayouts: false }).valid, true);
});

test("horizontal rows accept asymmetric seams and convert equal scaled source intersections", () => {
  const surfaces = [{ id: "row", name: "Row", layout: "horizontal" }];
  const asymmetric = [
    output("A", "row", 0, 0, { right: 240 }),
    output("B", "row", 1680, 0, { left: 240, right: 120 }),
    output("C", "row", 3480, 0, { left: 120 }),
  ];
  const asymmetricValidation = validatePhysicalSurfaceTopology(surfaces, asymmetric);
  assert.equal(asymmetricValidation.valid, true, asymmetricValidation.issues.map((issue) => issue.message).join("; "));
  assert.deepEqual(asymmetricValidation.surfaces[0].seams.map((seam) => seam.expectedPixels), [240, 120]);

  const scaled = [
    { ...output("A", "row", 0, 0, { right: 240 }, 3840, 2160), resolution },
    { ...output("B", "row", 3360, 0, { left: 240 }, 3840, 2160), resolution },
  ];
  const scaledValidation = validatePhysicalSurfaceTopology(surfaces, scaled);
  assert.equal(scaledValidation.valid, true, scaledValidation.issues.map((issue) => issue.message).join("; "));
  assert.equal(scaledValidation.surfaces[0].seams[0].sourceIntersectionPixels, 480);
  assert.equal(scaledValidation.surfaces[0].seams[0].expectedPixels, 240);

  const unequalScale = [{ ...scaled[0] }, { ...scaled[1], sourceViewport: { x: 3360, y: 0, width: 1920, height: 1080 } }];
  assert.ok(validatePhysicalSurfaceTopology(surfaces, unequalScale).issues.some((issue) => issue.code === "scale-mismatch"));
});

test("project save is LIVE only after every target ACKs the exact native revision and binding", () => {
  const targets = [
    { nodeId: "wall-node", commandSequence: 41 },
    { nodeId: "table-node", commandSequence: 42 },
  ];
  const renderer = (projectRevision) => ({
    connected: true,
    ready: true,
    projectRevision,
    correctionBindingMatches: true,
  });
  const state = {
    nodes: [
      {
        nodeId: "wall-node",
        status: "ready",
        ackSequence: 41,
        telemetry: { projectRevision: 9, renderer: renderer(8) },
      },
      {
        nodeId: "table-node",
        status: "ready",
        ackSequence: 42,
        telemetry: { projectRevision: 9, renderer: renderer(9) },
      },
    ],
  };

  const pending = projectSyncReadiness(state, targets, 9);
  assert.equal(pending.live, false);
  assert.deepEqual(pending.pendingNodeIds, ["wall-node"]);
  assert.match(pending.details[0].reasons.join("; "), /renderer revision is 8, expected 9/);

  state.nodes[0].telemetry.renderer.projectRevision = 9;
  const live = projectSyncReadiness(state, targets, 9);
  assert.equal(live.live, true);
  assert.deepEqual(live.pendingNodeIds, []);
});
