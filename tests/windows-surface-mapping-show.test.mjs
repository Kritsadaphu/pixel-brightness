import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("Windows manual mapping accepts every output on arbitrary named surfaces", async () => {
  const [guide, compatibility, acceptance] = await Promise.all([
    source("docs/windows/surface-mapping-show.md"),
    source("docs/windows/table-wall-show.md"),
    source("deploy/windows/Test-PixelBrightness.ps1"),
  ]);

  assert.match(guide, /walls, tables, floors, ceilings, scrims/);
  assert.match(guide, /2 September 2026/);
  assert.match(guide, /historical field names `walls` and `wallId`/);
  assert.match(guide, /Manual mapping does not require a camera/);
  assert.match(guide, /use \*\*Create surface\*\*/);
  assert.match(guide, /Normal creation, renaming, assignment, and spatial edits use Web Control/);
  assert.match(guide, /guarded complete-project import/i);
  assert.match(compatibility, /named-surface Windows show runbook/);

  assert.match(acceptance, /Authenticated identify and content restore for every committed output/);
  assert.match(acceptance, /\$outputIds = @\(\$binding\.outputs/);
  assert.match(acceptance, /foreach \(\$targetOutputId in \$outputIds\)/);
  assert.doesNotMatch(acceptance, /\$targetOutputId = \$outputIds\[0\]/);
  assert.match(acceptance, /finally \{[\s\S]{0,900}-Enabled \$false[\s\S]{0,180}-Type 'content'/);
  assert.match(acceptance, /Wait-NativeOutputPatterns[\s\S]{0,180}-Mode 'content'/);

  const identifyGate = acceptance.slice(
    acceptance.indexOf("Test-Item 'Authenticated identify and content restore for every committed output'"),
    acceptance.indexOf("if ($failures.Count -gt 0)"),
  );
  assert.doesNotMatch(identifyGate, /wallId|surfaceId|surface-wall|surface-table/,
    "physical Identify acceptance must not branch on logical surface membership");
});

test("show documentation fixes one-dimensional layout authority and rejects guessed seams", async () => {
  const [guide, readme, architecture, ndiGuide] = await Promise.all([
    source("docs/windows/surface-mapping-show.md"),
    source("README.md"),
    source("ARCHITECTURE.md"),
    source("docs/windows/ndi-arena-spout.md"),
  ]);

  for (const document of [guide, readme, architecture]) {
    assert.match(document, /Independent/i);
    assert.match(document, /Horizontal row|horizontal/);
    assert.match(document, /Vertical column|vertical/);
    assert.match(document, /2 September 2026/);
    assert.match(document, /camera/i);
  }

  assert.match(guide, /new surface[\s\S]{0,120}defaults to \*\*Independent\*\*/i);
  assert.match(guide, /same surface ID/);
  assert.match(guide, /reciprocal and equal/);
  assert.match(guide, /aligned on the other axis/);
  assert.match(guide, /`sourceViewport` rectangles have a real positive intersection/);
  assert.match(guide, /future versioned explicit edge[\s\n]+graph/);
  assert.match(guide, /must reject an ambiguous topology; they must not[\s\n]+guess/);

  assert.match(architecture, /defaults to `independent`/);
  assert.match(architecture, /reciprocal and equal/);
  assert.match(architecture, /future versioned explicit edge graph/);
  assert.match(readme, /local NDI source → Resolume Arena[\s\S]{0,140}local Spout → Pixel Brightness/);
  assert.match(ndiGuide, /Direct NDI input to Pixel Brightness is unsupported/);
  assert.match(architecture, /Pixel exposes no upstream “NDI ready” guard/);
});

test("guarded project import validates 1:1 layout and seam topology before POST", async () => {
  const guide = await source("docs/windows/surface-mapping-show.md");
  const block = guide.match(/## Guarded complete-project import[\s\S]*?```js\n([\s\S]*?)\n```/)?.[1];
  assert.ok(block, "guarded JavaScript import block must remain present");

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction(block), "documented recovery code must parse");
  assert.match(guide, /deliberately \*\*1:1 only\*\*/);
  assert.match(block, /layouts = new Set\(\["independent", "horizontal", "vertical"\]\)/);
  assert.match(block, /needs an explicit independent\/horizontal\/vertical layout/);
  assert.match(block, /Independent surface[\s\S]{0,100}all-zero overlap/);
  assert.match(block, /forbiddenEdges = horizontal \? \["top", "bottom"\] : \["left", "right"\]/);
  assert.match(block, /is not orthogonally aligned/);
  assert.match(block, /seam is not reciprocal and equal/);
  assert.match(block, /claims a seam without a real viewport intersection/);
  assert.match(block, /seam does not equal its viewport intersection/);
  assert.match(block, /secondIndex = firstIndex \+ 2/);
  assert.match(block, /non-adjacent\/triple overlap/);
  assert.match(block, /claims a seam without a neighbour/);
  assert.match(block, /viewport\.width !== liveOutput\.resolution\?\.width/);
  assert.match(block, /viewport\.height !== liveOutput\.resolution\?\.height/);
  assert.match(block, /sourceViewport is outside the live master canvas/);

  const validation = block.indexOf("validatePreset(project, preset);");
  const post = block.indexOf('method: "POST"');
  assert.ok(validation >= 0 && post > validation,
    "complete preset validation must finish before the recovery POST");

  const validatorText = block.slice(
    block.indexOf("const layouts ="),
    block.indexOf("const response ="),
  );
  const { validatePreset } = new Function(
    `${validatorText}\nreturn { validatePreset };`,
  )();
  const project = {
    canvas: { width: 3600, height: 1080 },
    outputs: [
      { id: "A", resolution: { width: 1920, height: 1080 } },
      { id: "B", resolution: { width: 1920, height: 1080 } },
    ],
  };
  const preset = {
    surfaces: [{ id: "surface-main", name: "Main", layout: "horizontal" }],
    outputs: {
      A: {
        surfaceId: "surface-main",
        sourceViewport: { x: 0, y: 0, width: 1920, height: 1080 },
        overlap: { left: 0, right: 240, top: 0, bottom: 0 },
      },
      B: {
        surfaceId: "surface-main",
        sourceViewport: { x: 1680, y: 0, width: 1920, height: 1080 },
        overlap: { left: 240, right: 0, top: 0, bottom: 0 },
      },
    },
  };
  assert.doesNotThrow(() => validatePreset(project, preset));

  const rejects = (mutate, expected) => {
    const candidateProject = structuredClone(project);
    const candidatePreset = structuredClone(preset);
    mutate(candidatePreset, candidateProject);
    assert.throws(() => validatePreset(candidateProject, candidatePreset), expected);
  };
  rejects((candidate) => { delete candidate.surfaces[0].layout; }, /needs an explicit/);
  rejects((candidate) => { candidate.surfaces[0].layout = "independent"; }, /all-zero overlap/);
  rejects((candidate) => { candidate.outputs.A.overlap.top = 1; }, /wrong-axis seam/);
  rejects((candidate, candidateProject) => {
    candidateProject.canvas.height = 1180;
    candidate.outputs.B.sourceViewport.y = 100;
  }, /not orthogonally aligned/);
  rejects((candidate) => { candidate.outputs.B.overlap.left = 239; }, /not reciprocal and equal/);
  rejects((candidate, candidateProject) => {
    candidateProject.canvas.width = 3840;
    candidate.outputs.B.sourceViewport.x = 1920;
  }, /without a real viewport intersection/);
  rejects((candidate) => { candidate.outputs.A.overlap.left = 1; }, /without a neighbour/);
  rejects((candidate) => { candidate.outputs.A.sourceViewport.width = 1919; }, /not 1:1/);
  rejects((candidate) => {
    candidate.surfaces.push({ id: "surface-other", name: "Other", layout: "horizontal" });
    candidate.outputs.B.surfaceId = "surface-other";
  }, /without a neighbour/);
  rejects((candidate, candidateProject) => {
    candidateProject.outputs.push({ id: "C", resolution: { width: 1920, height: 1080 } });
    candidate.outputs.A.overlap.right = 920;
    candidate.outputs.B.sourceViewport.x = 1000;
    candidate.outputs.B.overlap = { left: 920, right: 1240, top: 0, bottom: 0 };
    candidate.outputs.C = {
      surfaceId: "surface-main",
      sourceViewport: { x: 1680, y: 0, width: 1920, height: 1080 },
      overlap: { left: 1240, right: 0, top: 0, bottom: 0 },
    };
  }, /non-adjacent\/triple overlap/);

  const verticalProject = structuredClone(project);
  verticalProject.canvas = { width: 1920, height: 1920 };
  const verticalPreset = structuredClone(preset);
  verticalPreset.surfaces[0].layout = "vertical";
  verticalPreset.outputs.A.sourceViewport = { x: 0, y: 0, width: 1920, height: 1080 };
  verticalPreset.outputs.A.overlap = { left: 0, right: 0, top: 0, bottom: 240 };
  verticalPreset.outputs.B.sourceViewport = { x: 0, y: 840, width: 1920, height: 1080 };
  verticalPreset.outputs.B.overlap = { left: 0, right: 0, top: 240, bottom: 0 };
  assert.doesNotThrow(() => validatePreset(verticalProject, verticalPreset));
});
