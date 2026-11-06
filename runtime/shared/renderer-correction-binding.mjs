export const RENDERER_CORRECTION_BINDING_SCHEMA_VERSION = 1;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OUTPUT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const TOP_LEVEL_KEYS = ["schemaVersion", "algorithm", "configSha256", "fingerprint", "outputs"];
const OUTPUT_KEYS = ["id", "processingBypass", "artifacts"];
const ARTIFACT_KEYS = [
  "warpMeshSha256",
  "blendMapSha256",
  "blackMapSha256",
  "maskSha256",
  "colorLutSha256",
];
const SHA256_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class RendererCorrectionBindingError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "RendererCorrectionBindingError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new RendererCorrectionBindingError(code, message, details);
}

function exactObject(value, field, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_RENDERER_CORRECTION_BINDING", `${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(
      "INVALID_RENDERER_CORRECTION_BINDING",
      `${field} must contain exactly: ${expected.join(", ")}`,
      { actual, expected },
    );
  }
  return value;
}

function digest(value, field, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("INVALID_RENDERER_CORRECTION_BINDING", `${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rotateRight(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256(text) {
  const source = new TextEncoder().encode(text);
  const bitLength = source.length * 8;
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const first = words[index - 15];
      const second = words[index - 2];
      const sigma0 = rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3);
      const sigma1 = rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return [...state].map((value) => value.toString(16).padStart(8, "0")).join("");
}

function normalizeArtifacts(input, field) {
  const value = exactObject(input, field, ARTIFACT_KEYS);
  return {
    warpMeshSha256: digest(value.warpMeshSha256, `${field}.warpMeshSha256`),
    blendMapSha256: digest(value.blendMapSha256, `${field}.blendMapSha256`, { nullable: true }),
    blackMapSha256: digest(value.blackMapSha256, `${field}.blackMapSha256`, { nullable: true }),
    maskSha256: digest(value.maskSha256, `${field}.maskSha256`, { nullable: true }),
    colorLutSha256: digest(value.colorLutSha256, `${field}.colorLutSha256`, { nullable: true }),
  };
}

/**
 * Normalize and cryptographically verify the native renderer's bounded active
 * correction receipt without importing Node or browser crypto APIs.
 */
export function normalizeRendererCorrectionBinding(input, field = "rendererCorrectionBinding") {
  const value = exactObject(input, field, TOP_LEVEL_KEYS);
  if (value.schemaVersion !== RENDERER_CORRECTION_BINDING_SCHEMA_VERSION) {
    fail(
      "INVALID_RENDERER_CORRECTION_BINDING",
      `${field}.schemaVersion must be ${RENDERER_CORRECTION_BINDING_SCHEMA_VERSION}`,
    );
  }
  if (value.algorithm !== "sha256") {
    fail("INVALID_RENDERER_CORRECTION_BINDING", `${field}.algorithm must be sha256`);
  }
  if (!Array.isArray(value.outputs) || value.outputs.length < 1 || value.outputs.length > 32) {
    fail("INVALID_RENDERER_CORRECTION_BINDING", `${field}.outputs must contain 1-32 active outputs`);
  }
  const ids = new Set();
  const outputs = value.outputs.map((entry, index) => {
    const outputField = `${field}.outputs[${index}]`;
    const output = exactObject(entry, outputField, OUTPUT_KEYS);
    if (typeof output.id !== "string" || !OUTPUT_ID.test(output.id) || ids.has(output.id)) {
      fail(
        "INVALID_RENDERER_CORRECTION_BINDING",
        `${outputField}.id must be a unique canonical renderer output id`,
      );
    }
    ids.add(output.id);
    if (typeof output.processingBypass !== "boolean") {
      fail("INVALID_RENDERER_CORRECTION_BINDING", `${outputField}.processingBypass must be boolean`);
    }
    return {
      id: output.id,
      processingBypass: output.processingBypass,
      artifacts: normalizeArtifacts(output.artifacts, `${outputField}.artifacts`),
    };
  });
  const normalized = {
    schemaVersion: RENDERER_CORRECTION_BINDING_SCHEMA_VERSION,
    algorithm: "sha256",
    configSha256: digest(value.configSha256, `${field}.configSha256`),
    fingerprint: digest(value.fingerprint, `${field}.fingerprint`),
    outputs,
  };
  const fingerprintPayload = { ...normalized };
  delete fingerprintPayload.fingerprint;
  const computedFingerprint = sha256(canonicalJson(fingerprintPayload));
  if (normalized.fingerprint !== computedFingerprint) {
    fail(
      "RENDERER_CORRECTION_FINGERPRINT_MISMATCH",
      `${field}.fingerprint does not bind its config and ordered artifact digests`,
      { supplied: normalized.fingerprint, computed: computedFingerprint },
    );
  }
  return normalized;
}
