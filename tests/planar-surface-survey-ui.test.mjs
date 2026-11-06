import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildPlanarSurfaceSurveyEntry,
  inspectPlanarBoundary,
  normalizePreviewPoint,
  PLANAR_CORNER_LABELS,
} from "../app/components/planar-surface-survey-model.ts";

const digest = "a".repeat(64);
const metadata = {
  id: "north-survey-001",
  wallId: "wall-north",
  cameraViewId: "a7iv-north-session-001",
  frame: { width: 7008, height: 4672 },
  lensProfileSha256: digest,
};

const boundary = [
  { x: 0.1, y: 0.15 },
  { x: 0.9, y: 0.12 },
  { x: 0.86, y: 0.88 },
  { x: 0.14, y: 0.91 },
];

test("survey UI model emits the exact normalized planar-wall runtime entry", () => {
  assert.deepEqual(PLANAR_CORNER_LABELS, ["TL", "TR", "BR", "BL"]);
  assert.deepEqual(buildPlanarSurfaceSurveyEntry(metadata, boundary), {
    ...metadata,
    boundary,
    method: "operator-four-corner-planar-v1",
  });
});

test("pointer positions become bounded 0..1 frame coordinates", () => {
  assert.deepEqual(normalizePreviewPoint(450, 275, { left: 100, top: 50, width: 700, height: 450 }), {
    x: 0.5,
    y: 0.5,
  });
  assert.deepEqual(normalizePreviewPoint(900, -20, { left: 100, top: 50, width: 700, height: 450 }), {
    x: 1,
    y: 0,
  });
  assert.equal(normalizePreviewPoint(1, 1, { left: 0, top: 0, width: 0, height: 100 }), null);
});

test("client inspection rejects folded and tiny quadrilaterals before emission", () => {
  const folded = inspectPlanarBoundary([
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.9 },
    { x: 0.9, y: 0.1 },
    { x: 0.1, y: 0.9 },
  ]);
  assert.equal(folded.valid, false);
  assert.match(folded.reason, /cross or fold/);

  const tinyBoundary = [
    { x: 0.1, y: 0.1 },
    { x: 0.16, y: 0.1 },
    { x: 0.16, y: 0.16 },
    { x: 0.1, y: 0.16 },
  ];
  const tiny = inspectPlanarBoundary(tinyBoundary);
  assert.equal(tiny.valid, false);
  assert.match(tiny.reason, /too small/);
  assert.throws(() => buildPlanarSurfaceSurveyEntry(metadata, tinyBoundary), /too small/i);
});

test("component is bounded to an honest markerless planar workflow", async () => {
  const source = await readFile(new URL("../app/components/planar-surface-survey.tsx", import.meta.url), "utf8");
  assert.match(source, /Click exactly four visible corners/);
  assert.match(source, /TL → TR → BR → BL/);
  assert.match(source, /No physical marker is required at the venue/);
  assert.match(source, /Planar wall only/);
  assert.match(source, /one fixed camera view\/session/);
  assert.match(source, /validated lens profile required/);
  assert.match(source, /Curved or discontinuous surfaces need a dense room\/surface model/);
  assert.match(source, /active\.points\.length >= PLANAR_CORNER_LABELS\.length/,
    "a completed survey must not accept a fifth point");
  assert.match(source, /onSurveyChange\?\./);
  assert.match(source, /onConfirm\(survey\)/);
});
