#!/usr/bin/env node
// Builds dome (domemaster fisheye) correction assets for the existing final
// pipeline: per-projector warp mesh, r32_float blend + mask maps, a coverage
// report, an SVG footprint preview and optionally an alignment grid PNG.
//
//   node scripts/dome-build.mjs --profile config/dome.example.json --out outputs/dome/site
//        [--renderer-base native/windows/config/renderer.example.json]
//        [--project-asset-prefix dome/site] [--grid] [--grid-size 2048]
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { parseArgs } from "node:util";

import {
  DOME_MAPPING_METHOD,
  analyzeDomeCoverage,
  buildDomeCorrectionMaps,
  buildDomeWarpMesh,
  normalizeDomeProfile,
  projectorCenter,
  projectorFootprint,
  renderDomeGrid,
  solveProjectorPose,
} from "../runtime/shared/dome-mapping.mjs";

const USAGE = "Usage: node scripts/dome-build.mjs --profile <dome.json> --out <dir> "
  + "[--renderer-base <renderer.json>] [--project-asset-prefix <path>] [--grid] [--grid-size <px>]\n";
const COLORS = ["#ff5a5a", "#46d160", "#4f8dff", "#ffd23f", "#c86bff", "#3fe0d0", "#ff9f40", "#f06aa6"];

function floatBytes(values) {
  const bytes = Buffer.alloc(values.length * 4);
  for (let index = 0; index < values.length; index += 1) bytes.writeFloatLE(values[index], index * 4);
  return bytes;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, crc]);
}

function encodePng({ width, height, rgb }) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + row * width * 3, width * 3).copy(raw, row * (width * 3 + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function coverageSvg(profile) {
  const { width, height } = profile.canvas;
  const { centerX, centerY, radiusPx } = profile.fisheye;
  const shapes = profile.projectors.map((projector, index) => {
    const color = COLORS[index % COLORS.length];
    const points = projectorFootprint(profile, projector).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    return `<polygon points="${points}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="${width / 400}"/>`;
  });
  const labels = profile.projectors.map((projector, index) => {
    const { x: cx, y: cy } = projectorCenter(profile, projector);
    return `<text x="${cx.toFixed(0)}" y="${cy.toFixed(0)}" fill="${COLORS[index % COLORS.length]}" font-size="${width / 30}" `
      + `font-family="sans-serif" text-anchor="middle">${projector.id}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="1024" height="${Math.round(1024 * height / width)}">
<rect width="${width}" height="${height}" fill="#0b0d12"/>
<circle cx="${centerX}" cy="${centerY}" r="${radiusPx}" fill="#161a22" stroke="#888" stroke-width="${width / 500}"/>
<text x="${centerX}" y="${centerY + radiusPx + width / 40}" fill="#ccc" font-size="${width / 45}" font-family="sans-serif" text-anchor="middle">FRONT (azimuth 0)</text>
${shapes.join("\n")}
${labels.join("\n")}
</svg>
`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: "string" },
      out: { type: "string" },
      "renderer-base": { type: "string" },
      "project-asset-prefix": { type: "string" },
      grid: { type: "boolean", default: false },
      "grid-size": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.profile || !values.out) {
    process.stderr.write(USAGE);
    process.exitCode = values.help ? 0 : 2;
    return;
  }
  const outDir = resolve(values.out);
  await mkdir(outDir, { recursive: true });
  const rawProfile = JSON.parse(await readFile(resolve(values.profile), "utf8"));
  const profile = normalizeDomeProfile(rawProfile);

  // Camera-free refinement from operator-marked dome points.
  const solves = [];
  const solvedRaw = structuredClone(rawProfile);
  profile.projectors = profile.projectors.map((projector, index) => {
    if (projector.calibrationPoints.length === 0) return projector;
    const result = solveProjectorPose(profile, projector, { free: projector.solve?.free });
    const p = result.projector;
    solvedRaw.projectors[index].pose = {
      positionM: p.positionM.map((value) => Number(value.toFixed(4))),
      yawDeg: Number(p.yawDeg.toFixed(3)),
      pitchDeg: Number(p.pitchDeg.toFixed(3)),
      rollDeg: Number(p.rollDeg.toFixed(3)),
    };
    solvedRaw.projectors[index].lens = {
      throwRatio: Number(p.throwRatio.toFixed(4)),
      shiftX: Number(p.shiftX.toFixed(4)),
      shiftY: Number(p.shiftY.toFixed(4)),
    };
    solves.push({ id: projector.id, rmsPx: result.rmsPx, maxErrorPx: result.maxErrorPx, free: result.free, perPoint: result.perPoint });
    return p;
  });
  if (solves.length) await writeFile(join(outDir, "solved-profile.json"), `${JSON.stringify(solvedRaw, null, 2)}\n`);

  const coverage = analyzeDomeCoverage(profile);
  const assetPrefix = values["project-asset-prefix"] ?? "dome";
  const projectOutputs = [];
  const rendererOutputs = [];
  const perOutput = [];
  for (let index = 0; index < profile.projectors.length; index += 1) {
    const projector = profile.projectors[index];
    const warp = buildDomeWarpMesh(profile, projector);
    const maps = buildDomeCorrectionMaps(profile, index);
    const assets = {};
    for (const kind of ["blend", "mask"]) {
      const bytes = floatBytes(maps[kind]);
      const file = `${projector.id}-${kind}.r32f`;
      await writeFile(join(outDir, file), bytes);
      assets[kind] = {
        file,
        width: maps.width,
        height: maps.height,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.length,
      };
    }
    const projectRef = (asset) => ({
      path: `${assetPrefix}/${asset.file}`, sha256: asset.sha256, format: "r32_float",
      width: asset.width, height: asset.height, byteLength: asset.byteLength,
    });
    const rendererRef = (asset) => ({ path: asset.file, width: asset.width, height: asset.height, format: "r32_float" });
    const resolution = { ...projector.resolution, refreshNum: 60, refreshDen: 1, ...projector.renderer?.resolution };
    const common = {
      id: projector.id,
      enabled: true,
      resolution,
      sourceViewport: { x: 0, y: 0, width: profile.canvas.width, height: profile.canvas.height },
      overlap: { left: 0, right: 0, top: 0, bottom: 0 },
      blackUniformity: { enabled: false, lift: 0, map: null },
      color: { gain: [1, 1, 1], offset: [0, 0, 0], gamma: [1, 1, 1], lut: null },
      warp,
    };
    projectOutputs.push({
      ...common,
      name: projector.name,
      blend: { enabled: true, feather: 0.78, gamma: 2.2, map: projectRef(assets.blend) },
      mask: { enabled: true, map: projectRef(assets.mask), path: null, softness: 0 },
    });
    rendererOutputs.push({
      ...common,
      display: projector.renderer?.display ?? {
        devicePath: "\\\\?\\DISPLAY#replace-with-list-displays-value",
        gdiName: null,
        adapterLuid: null,
        targetId: null,
      },
      processing: { bypass: false, order: ["sourceViewport", "warp", "blend", "blackUniformity", "color", "mask"] },
      blend: { enabled: true, feather: 0.78, gamma: 2.2, map: rendererRef(assets.blend) },
      mask: { enabled: true, map: rendererRef(assets.mask), path: null, softness: 0 },
    });
    perOutput.push({
      id: projector.id,
      mapWidth: maps.width,
      mapHeight: maps.height,
      domeCoveredFraction: maps.coveredPixels / (maps.width * maps.height),
      overlapFraction: maps.overlapPixels / (maps.width * maps.height),
      assets,
    });
  }

  await writeFile(join(outDir, "project-outputs.json"), `${JSON.stringify(projectOutputs, null, 2)}\n`);
  await writeFile(join(outDir, "renderer-outputs.json"), `${JSON.stringify(rendererOutputs, null, 2)}\n`);
  if (values["renderer-base"]) {
    const base = JSON.parse(await readFile(resolve(values["renderer-base"]), "utf8"));
    const { width, height } = profile.canvas;
    const config = {
      ...base,
      revision: (Number(base.revision) || 0) + 1,
      canvas: { ...base.canvas, width, height },
      compositionSource: { ...base.compositionSource, width, height },
      outputs: rendererOutputs,
    };
    await writeFile(join(outDir, "renderer.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  await writeFile(join(outDir, "coverage.svg"), coverageSvg(profile));
  if (values.grid) {
    const size = values["grid-size"] ? Number(values["grid-size"]) : profile.canvas.width;
    if (!Number.isInteger(size) || size < 256 || size > 16384) throw new Error("--grid-size must be an integer 256..16384");
    await writeFile(join(outDir, "dome-grid.png"), encodePng(renderDomeGrid(profile, size)));
  }
  const report = {
    method: DOME_MAPPING_METHOD,
    generatedAt: new Date().toISOString(),
    canvas: profile.canvas,
    fisheye: { ...profile.fisheye, margin: undefined, halfFovRad: undefined, rotationRad: undefined },
    coverage,
    poseSolves: solves,
    outputs: perOutput,
    radiometryVerified: false,
  };
  await writeFile(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  const percent = (value) => `${(value * 100).toFixed(2)}%`;
  process.stdout.write(`Dome build written to ${outDir}\n`);
  process.stdout.write(`  dome coverage ${percent(coverage.coveredFraction)}, projectors per point ${JSON.stringify(coverage.projectorCountHistogram)}\n`);
  for (const solve of solves) {
    process.stdout.write(`  ${solve.id} pose solve: RMS ${solve.rmsPx.toFixed(2)} px, max ${solve.maxErrorPx.toFixed(2)} px\n`);
  }
  if (coverage.uncoveredFraction > 0) {
    process.stdout.write(`  WARNING: ${percent(coverage.uncoveredFraction)} of the dome has no projector, e.g. `
      + `${JSON.stringify(coverage.uncoveredExamples.slice(0, 3))}\n`);
    process.exitCode = 3;
  }
}

main().catch((error) => {
  process.stderr.write(`dome-build failed: ${error.message}\n`);
  process.exitCode = 1;
});
