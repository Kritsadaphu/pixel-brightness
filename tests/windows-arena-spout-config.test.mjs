import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { loadNodeConfig } from "../runtime/node/config.mjs";
import {
  normalizeSpoutSource,
  normalizeWindowsRendererConfig,
} from "../runtime/node/windows-renderer-contract.mjs";

const CONFIG_PATH = new URL("../config/windows-arena-final-processor.example.json", import.meta.url);
const NATIVE_EXAMPLE_PATH = new URL("../native/windows/config/renderer.example.json", import.meta.url);
const NATIVE_SCHEMA_PATH = new URL("../native/windows/config/renderer.schema.json", import.meta.url);
const FORMATS = [
  "DXGI_FORMAT_R16G16B16A16_FLOAT",
  "DXGI_FORMAT_R8G8B8A8_UNORM",
  "DXGI_FORMAT_B8G8R8A8_UNORM",
];

async function readExample() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

function assertStrictObject(value, schema, label) {
  const allowed = new Set(Object.keys(schema.properties || {}));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  assert.deepEqual(extra, [], `${label} contains fields the native schema rejects`);
  for (const key of schema.required || []) {
    assert.ok(Object.hasOwn(value, key), `${label}.${key} is required by the native schema`);
  }
}

function resolveLocalRef(root, ref) {
  return ref.slice(2).split("/").reduce((value, key) => value[key.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

function validateJson(value, inputSchema, root, path = "$") {
  const schema = inputSchema.$ref ? resolveLocalRef(root, inputSchema.$ref) : inputSchema;
  const errors = [];
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validateJson(value, candidate, root, path).length === 0).length;
    return matches === 1 ? [] : [`${path} must match exactly one oneOf branch (matched ${matches})`];
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.some((candidate) => validateJson(value, candidate, root, path).length === 0);
    if (!matches) errors.push(`${path} does not match any anyOf branch`);
  }
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(value, schema.const)) errors.push(`${path} differs from const`);
  if (schema.enum && !schema.enum.some((candidate) => isDeepStrictEqual(value, candidate))) errors.push(`${path} is outside enum`);

  const actualType = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  const allowedTypes = schema.type == null ? null : new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
  const typeMatches = !allowedTypes || allowedTypes.has(actualType) || (actualType === "integer" && allowedTypes.has("number"));
  if (!typeMatches) return [...errors, `${path} has type ${actualType}, expected ${[...allowedTypes].join("|")}`];

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) errors.push(...validateJson(value[key], child, root, `${path}.${key}`));
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path} items are not unique`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateJson(item, schema.items, root, `${path}[${index}]`)));
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} does not match pattern`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} is below minimum`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} is above maximum`);
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) errors.push(`${path} is below exclusiveMinimum`);
    if (schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum) errors.push(`${path} is above exclusiveMaximum`);
  }
  return errors;
}

test("Arena example has one master Spout composition shared by every output", async () => {
  const example = await readExample();
  const source = example.compositionSource;

  assert.equal(source.type, "spout");
  assert.equal(source.senderName, "PB-COMPOSITION");
  assert.equal(source.width, example.canvas.width);
  assert.equal(source.height, example.canvas.height);
  assert.equal(source.frameRateNum, example.canvas.frameRateNum);
  assert.equal(source.frameRateDen, example.canvas.frameRateDen);
  assert.deepEqual(source.acceptedFormats, FORMATS);
  assert.equal(example.outputs.length, 3);
  assert.ok(example.outputs.every((output) => output.source == null));
});

test("master composition and projector crops describe two exact 240px overlaps", async () => {
  const example = await readExample();
  const [a, b, c] = example.outputs;
  assert.deepEqual(
    [a.sourceViewport.x, b.sourceViewport.x, c.sourceViewport.x],
    [0, 1680, 3360],
  );
  assert.ok(example.outputs.every((output) => output.sourceViewport.width === 1920));
  assert.equal(a.sourceViewport.x + a.sourceViewport.width - b.sourceViewport.x, 240);
  assert.equal(b.sourceViewport.x + b.sourceViewport.width - c.sourceViewport.x, 240);
  assert.deepEqual(a.overlap, { left: 0, right: 240, top: 0, bottom: 0 });
  assert.deepEqual(b.overlap, { left: 240, right: 240, top: 0, bottom: 0 });
  assert.deepEqual(c.overlap, { left: 240, right: 0, top: 0, bottom: 0 });
  assert.equal(c.sourceViewport.x + c.sourceViewport.width, example.canvas.width);
});

test("Arena example is fail-closed and forbids active-sender selection", async () => {
  const { compositionSource: source } = await readExample();
  assert.equal(source.onMissing, "black");
  assert.equal(source.onMismatch, "black");
  assert.equal(source.allowAutoSelect, false);
  assert.ok(source.timeoutMs >= 100 && source.timeoutMs <= 2_000);
  assert.ok(source.startupGraceMs >= source.timeoutMs);

  assert.throws(
    () => normalizeSpoutSource({ ...source, allowAutoSelect: true }),
    /allowAutoSelect must be false/,
  );
  assert.throws(
    () => normalizeSpoutSource({ ...source, onMissing: "hold" }),
    /failure policy must be black/,
  );
});

test("Arena outputs retain stable Windows binding and a safe identity baseline", async () => {
  const example = await readExample();
  const displayPaths = new Set();
  for (const output of example.outputs) {
    assert.equal(typeof output.display?.devicePath, "string");
    assert.ok(output.display.devicePath.startsWith("\\\\?\\DISPLAY#"));
    assert.equal(output.connector, output.display.devicePath);
    assert.equal(displayPaths.has(output.display.devicePath), false);
    displayPaths.add(output.display.devicePath);

    assert.equal(output.warp.enabled, false);
    assert.ok(output.warp.columns >= 1 && output.warp.columns <= 128);
    assert.ok(output.warp.rows >= 1 && output.warp.rows <= 128);
    assert.equal(output.warp.points.length, (output.warp.columns + 1) * (output.warp.rows + 1));
    assert.deepEqual(output.warp.points[0], { u: 0, v: 0, x: 0, y: 0 });
    assert.deepEqual(output.warp.points.at(-1), { u: 1, v: 1, x: 1, y: 1 });
    assert.equal(output.blend.enabled, true);
    assert.equal(output.mask.enabled, false);
    assert.equal(output.blackUniformity.enabled, false);
    assert.deepEqual(output.color.gain, [1, 1, 1]);
  }
});

test("native renderer contract normalizes one shared source and strips legacy output sources", async () => {
  const example = await readExample();
  const normalized = normalizeWindowsRendererConfig(example);
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.compositionSource.senderName, "PB-COMPOSITION");
  assert.deepEqual(normalized.canvas, example.canvas);
  assert.equal(normalized.outputs.length, 3);
  assert.ok(normalized.outputs.every((output) => output.source == null));

  assert.throws(
    () => normalizeWindowsRendererConfig({
      ...example,
      compositionSource: { ...example.compositionSource, width: 5760 },
    }),
    /dimensions and frame rate must match.*canvas/,
  );
  assert.throws(
    () => normalizeWindowsRendererConfig({
      ...example,
      compositionSource: { ...example.compositionSource, frameRateNum: 50 },
    }),
    /dimensions and frame rate must match.*canvas/,
  );
});

test("normalized renderer DTO obeys the native strict-object boundary", async () => {
  const [example, nativeExample, schema] = await Promise.all([
    readExample(),
    readFile(NATIVE_EXAMPLE_PATH, "utf8").then(JSON.parse),
    readFile(NATIVE_SCHEMA_PATH, "utf8").then(JSON.parse),
  ]);
  const normalized = normalizeWindowsRendererConfig(example);

  assertStrictObject(normalized, schema, "renderer");
  assertStrictObject(normalized.canvas, schema.properties.canvas, "canvas");
  assertStrictObject(normalized.compositionSource, schema.$defs.compositionSource, "compositionSource");
  assertStrictObject(normalized.telemetry, schema.properties.telemetry, "telemetry");

  for (const output of normalized.outputs) {
    assertStrictObject(output, schema.$defs.output, `output ${output.id}`);
    for (const key of ["display", "resolution", "sourceViewport", "processing", "blend", "blackUniformity", "color", "mask", "warp"]) {
      assertStrictObject(output[key], schema.$defs.output.properties[key], `output ${output.id}.${key}`);
    }
    assertStrictObject(output.overlap, schema.$defs.edges, `output ${output.id}.overlap`);
    for (const [index, point] of output.warp.points.entries()) {
      assertStrictObject(point, schema.$defs.output.properties.warp.properties.points.items, `output ${output.id}.warp.points[${index}]`);
    }
  }

  assert.deepEqual(validateJson(normalized, schema, schema), [], "normalized Node DTO must validate against the native schema");
  assert.deepEqual(validateJson(nativeExample, schema, schema), [], "checked-in native example must validate against its own schema");
  assert.deepEqual(normalized.canvas, nativeExample.canvas);
  assert.equal(normalized.compositionSource.senderName, nativeExample.compositionSource.senderName);
  assert.ok(normalized.outputs.every((output) => output.source == null));
});

test("node config loader preserves the one composition source and output crops", async () => {
  const config = await loadNodeConfig({
    argv: ["--config", fileURLToPath(CONFIG_PATH)],
    env: {},
    cwd: process.cwd(),
  });

  assert.equal(config.compositionSource.senderName, "PB-COMPOSITION");
  assert.deepEqual(config.canvas, {
    width: 5280,
    height: 1080,
    frameRateNum: 60,
    frameRateDen: 1,
  });
  assert.deepEqual(
    config.outputs.map((output) => ({
      id: output.id,
      source: output.source,
      sourceViewport: output.sourceViewport,
    })),
    [
      { id: "A", source: undefined, sourceViewport: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: "B", source: undefined, sourceViewport: { x: 1680, y: 0, width: 1920, height: 1080 } },
      { id: "C", source: undefined, sourceViewport: { x: 3360, y: 0, width: 1920, height: 1080 } },
    ],
  );
});
