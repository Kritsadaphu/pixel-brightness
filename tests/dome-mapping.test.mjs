import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analyzeDomeCoverage,
  buildDomeCorrectionMaps,
  buildDomeWarpMesh,
  domeElevationDeg,
  domePointFromAngles,
  domemasterPixel,
  normalizeDomeProfile,
  projectWorldPoint,
  projectorBasis,
  projectorRay,
  renderDomeGrid,
  solveProjectorPose,
} from "../runtime/shared/dome-mapping.mjs";

const example = JSON.parse(await readFile(new URL("../config/dome.example.json", import.meta.url), "utf8"));

function exampleProfile(overrides = {}) {
  return normalizeDomeProfile({ ...structuredClone(example), ...overrides });
}

test("domemaster convention: zenith at centre, front at bottom, left on the left", () => {
  const profile = exampleProfile();
  const zenith = domemasterPixel(profile, domePointFromAngles(profile.dome, 0, 90));
  assert.ok(Math.abs(zenith.x - 2048) < 1e-6 && Math.abs(zenith.y - 2048) < 1e-6);
  const front = domemasterPixel(profile, domePointFromAngles(profile.dome, 0, 0));
  assert.ok(Math.abs(front.x - 2048) < 1e-6 && Math.abs(front.y - (2048 + 1920)) < 1e-6);
  const left = domemasterPixel(profile, domePointFromAngles(profile.dome, 90, 0));
  assert.ok(Math.abs(left.x - (2048 - 1920)) < 1e-6);
  const halfway = domemasterPixel(profile, domePointFromAngles(profile.dome, 0, 45));
  assert.ok(Math.abs(halfway.y - (2048 + 960)) < 1e-6, "equidistant fisheye radius");
});

test("rays below the spring line stay inside the canvas black margin", () => {
  const profile = exampleProfile();
  const below = domemasterPixel(profile, domePointFromAngles(profile.dome, 90, -60));
  assert.ok(below.radius > 1);
  assert.ok(below.x > 0 && below.x < 128, `expected margin x, got ${below.x}`);
});

test("projector projection inverts its own rays", () => {
  const profile = exampleProfile();
  const projector = profile.projectors[2];
  const basis = projectorBasis(projector);
  for (const [x, y] of [[0, 0], [0.3, 0.7], [1, 1], [0.5, 0.5]]) {
    const ray = projectorRay(projector, x, y, basis);
    const point = projector.positionM.map((value, axis) => value + ray[axis] * 2);
    const pixel = projectWorldPoint(projector, point, basis);
    assert.ok(Math.abs(pixel.x - x) < 1e-9 && Math.abs(pixel.y - y) < 1e-9);
  }
});

test("example layout covers the whole dome and every mesh is unfolded", () => {
  const profile = exampleProfile();
  const coverage = analyzeDomeCoverage(profile, { samples: 4000 });
  assert.equal(coverage.uncoveredFraction, 0);
  for (const projector of profile.projectors) {
    const mesh = buildDomeWarpMesh(profile, projector);
    assert.equal(mesh.enabled, true);
    assert.equal(mesh.points.length, (mesh.columns + 1) * (mesh.rows + 1));
  }
});

test("dense mesh reproduces exact fisheye sampling within a canvas pixel", () => {
  const profile = exampleProfile({ build: { ...example.build, meshColumns: 128, meshRows: 80 } });
  const projector = profile.projectors[0];
  const mesh = buildDomeWarpMesh(profile, projector);
  const basis = projectorBasis(projector);
  const stride = mesh.columns + 1;
  const point = (column, row) => mesh.points[row * stride + column];
  let worst = 0;
  for (let sample = 0; sample < 400; sample += 1) {
    const x = (((sample * 37) % 397) + 0.5) / 397, y = (((sample * 91) % 389) + 0.5) / 389;
    const gx = x * mesh.columns, gy = y * mesh.rows;
    const column = Math.min(mesh.columns - 1, Math.floor(gx)), row = Math.min(mesh.rows - 1, Math.floor(gy));
    const tx = gx - column, ty = gy - row;
    // FinalPipeline splits each cell into (TL,TR,BL) and (TR,BR,BL).
    const tl = point(column, row), tr = point(column + 1, row);
    const bl = point(column, row + 1), br = point(column + 1, row + 1);
    const [u, v] = tx + ty <= 1
      ? [tl.u + (tr.u - tl.u) * tx + (bl.u - tl.u) * ty, tl.v + (tr.v - tl.v) * tx + (bl.v - tl.v) * ty]
      : [br.u + (bl.u - br.u) * (1 - tx) + (tr.u - br.u) * (1 - ty),
        br.v + (bl.v - br.v) * (1 - tx) + (tr.v - br.v) * (1 - ty)];
    const exact = exactPixel(profile, projector.positionM, projectorRay(projector, x, y, basis));
    if (exact.radius < 0.98) worst = Math.max(worst, Math.hypot(u * 4096 - exact.x, v * 4096 - exact.y));
  }
  assert.ok(worst < 1.5, `mesh interpolation error ${worst.toFixed(3)} px`);
});

function exactPixel(profile, origin, ray) {
  const b = origin[0] * ray[0] + origin[1] * ray[1] + origin[2] * ray[2];
  const c = origin[0] ** 2 + origin[1] ** 2 + origin[2] ** 2 - profile.dome.radiusM ** 2;
  const t = -b + Math.sqrt(b * b - c);
  return domemasterPixel(profile, origin.map((value, axis) => value + ray[axis] * t));
}

test("blend maps form a partition of unity on the dome surface", () => {
  const profile = exampleProfile({ build: { ...example.build, mapScale: 0.25 } });
  const maps = profile.projectors.map((_, index) => buildDomeCorrectionMaps(profile, index));
  const bases = profile.projectors.map((projector) => projectorBasis(projector));
  let checked = 0;
  for (let az = 0; az < 360; az += 7) {
    for (let el = 3; el <= 88; el += 5) {
      const point = domePointFromAngles(profile.dome, az, el);
      let sum = 0;
      profile.projectors.forEach((projector, index) => {
        const pixel = projectWorldPoint(projector, point, bases[index]);
        if (!pixel || pixel.x <= 0 || pixel.x >= 1 || pixel.y <= 0 || pixel.y >= 1) return;
        const map = maps[index];
        const column = Math.min(map.width - 1, Math.floor(pixel.x * map.width));
        const row = Math.min(map.height - 1, Math.floor(pixel.y * map.height));
        sum += map.blend[row * map.width + column];
      });
      assert.ok(Math.abs(sum - 1) < 0.08, `blend sum ${sum.toFixed(3)} at az ${az} el ${el}`);
      checked += 1;
    }
  }
  assert.ok(checked > 800);
  for (const map of maps) assert.ok(map.overlapPixels > 0 && map.coveredPixels > 0);
});

test("mask is zero below the spring line", () => {
  const profile = exampleProfile({ build: { ...example.build, mapScale: 0.25 } });
  const projector = profile.projectors[0];
  const map = buildDomeCorrectionMaps(profile, 0);
  const basis = projectorBasis(projector);
  let below = 0;
  for (let row = 0; row < map.height; row += 3) {
    for (let column = 0; column < map.width; column += 3) {
      const ray = projectorRay(projector, (column + 0.5) / map.width, (row + 0.5) / map.height, basis);
      const b = projector.positionM.reduce((sum, value, axis) => sum + value * ray[axis], 0);
      const c = projector.positionM.reduce((sum, value) => sum + value * value, 0) - 16;
      const t = -b + Math.sqrt(b * b - c);
      const hit = projector.positionM.map((value, axis) => value + ray[axis] * t);
      if (domeElevationDeg(profile.dome, hit) < -0.5) {
        below += 1;
        assert.equal(map.mask[row * map.width + column], 0);
        assert.equal(map.blend[row * map.width + column], 0);
      }
    }
  }
  assert.ok(below > 0, "example projector should see some wall below the spring line");
});

test("camera-free pose solve recovers a perturbed projector from dome marks", () => {
  const profile = exampleProfile();
  const truth = profile.projectors[1];
  const basis = projectorBasis(truth);
  const marks = [[0, 90], [72, 60], [252, 20], [200, 40], [300, 35], [240, 65], [160, 30], [270, 10]];
  const points = marks.flatMap(([azimuthDeg, elevationDeg], index) => {
    const pixel = projectWorldPoint(truth, domePointFromAngles(profile.dome, azimuthDeg, elevationDeg), basis);
    if (!pixel || pixel.x < 0 || pixel.x > 1 || pixel.y < 0 || pixel.y > 1) return [];
    return [{ label: `M${index}`, azimuthDeg, elevationDeg, x: pixel.x * 1920, y: pixel.y * 1200 }];
  });
  assert.ok(points.length >= 5, `only ${points.length} marks visible`);
  const guess = {
    ...truth,
    positionM: [truth.positionM[0] + 0.15, truth.positionM[1] - 0.2, truth.positionM[2] + 0.1],
    yawDeg: truth.yawDeg + 4,
    pitchDeg: truth.pitchDeg - 3,
    rollDeg: 2,
  };
  const result = solveProjectorPose(profile, guess, { points });
  assert.ok(result.rmsPx < 0.05, `RMS ${result.rmsPx}`);
  assert.ok(Math.abs(result.projector.yawDeg - truth.yawDeg) < 0.05);
  assert.ok(Math.abs(result.projector.pitchDeg - truth.pitchDeg) < 0.05);
  assert.ok(Math.hypot(...result.projector.positionM.map((value, axis) => value - truth.positionM[axis])) < 0.005);
});

test("pose solve refuses too few points", () => {
  const profile = exampleProfile();
  assert.throws(() => solveProjectorPose(profile, profile.projectors[0], {
    points: [{ label: "Z", azimuthDeg: 0, elevationDeg: 90, x: 960, y: 600 }],
  }), /need at least/);
});

test("profile validation fails closed", () => {
  assert.throws(() => exampleProfile({ fisheye: { radiusPx: 2048 } }), /black margin/);
  assert.throws(() => exampleProfile({ projectors: [] }), /projectors must contain/);
  const outside = structuredClone(example);
  outside.projectors[0].pose.positionM = [5, 0, 0];
  assert.throws(() => normalizeDomeProfile(outside), /inside the dome sphere/);
  const duplicate = structuredClone(example);
  duplicate.projectors[1].id = "PJ1";
  assert.throws(() => normalizeDomeProfile(duplicate), /Duplicate projector id/);
});

test("a frame that reaches the nadir singularity is rejected as folded", () => {
  const profile = exampleProfile();
  const projector = { ...profile.projectors[0], positionM: [0, 0, 0.5], pitchDeg: -89, throwRatio: 0.3 };
  assert.throws(() => buildDomeWarpMesh(profile, projector), /folded|degenerate/);
});

test("alignment grid marks the zenith and cardinal spokes", () => {
  const profile = exampleProfile();
  const grid = renderDomeGrid(profile, 512);
  const pixel = (x, y) => Array.from(grid.rgb.subarray((y * 512 + x) * 3, (y * 512 + x) * 3 + 3));
  assert.deepEqual(pixel(256, 256), [255, 255, 255]);
  assert.deepEqual(pixel(256, 420), [255, 40, 40], "front spoke is red at the bottom");
  assert.deepEqual(pixel(0, 0), [0, 0, 0], "outside the circle is black");
});
