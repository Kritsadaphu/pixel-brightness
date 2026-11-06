import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { CameraCalibrationError } from "../shared/camera-calibration.mjs";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new CameraCalibrationError("CAMERA_RUNTIME_MANIFEST_INVALID", message);
}

function exactKeys(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${field} must contain exactly: ${expected.join(", ")}`);
  }
  return value;
}

function text(value, field, maximum = 256) {
  const output = String(value ?? "").trim();
  if (!output || output.length > maximum || [...output].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  })) fail(`${field} is invalid`);
  return output;
}

async function sha256File(pathname) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(pathname)) hash.update(chunk);
  return hash.digest("hex");
}

export async function loadCanonCameraRuntimeManifest(pathname) {
  if (!pathname || !isAbsolute(pathname)) {
    fail("Canon EDSDK runtime manifest path must be absolute");
  }
  const requestedPath = String(pathname);
  const information = await lstat(requestedPath).catch(() => null);
  if (!information?.isFile() || information.isSymbolicLink()
    || information.size < 2 || information.size > MAX_MANIFEST_BYTES) {
    fail("Canon EDSDK runtime manifest must be one bounded regular non-symlink file");
  }
  const manifestPath = await realpath(requestedPath);
  const bytes = await readFile(manifestPath);
  if (bytes.byteLength !== information.size) fail("Canon EDSDK runtime manifest changed while it was read");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`Canon EDSDK runtime manifest JSON is invalid: ${error.message}`);
  }
  exactKeys(value, ["schema", "sdkVersion", "architecture", "entry", "files"], "runtime manifest");
  if (value.schema !== "pixel-brightness.canon-edsdk-runtime.v1" || value.architecture !== "x64") {
    fail("Canon runtime manifest must use the v1 x64 EDSDK schema");
  }
  const sdkVersion = text(value.sdkVersion, "runtime manifest sdkVersion", 64);
  const entry = text(value.entry, "runtime manifest entry", 128);
  if (basename(entry) !== entry || !entry.toLowerCase().endsWith(".dll")) {
    fail("Canon runtime manifest entry must be one DLL basename");
  }
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 256) {
    fail("Canon runtime manifest files must contain 1-256 DLL bindings");
  }
  const files = value.files.map((item, index) => {
    exactKeys(item, ["name", "sha256"], `runtime manifest files[${index}]`);
    const name = text(item.name, `runtime manifest files[${index}].name`, 128);
    const sha256 = String(item.sha256 || "");
    if (basename(name) !== name || !name.toLowerCase().endsWith(".dll") || !SHA256_PATTERN.test(sha256)) {
      fail(`runtime manifest files[${index}] must bind one DLL basename and lowercase SHA-256`);
    }
    return { name, sha256 };
  });
  const foldedNames = files.map((file) => file.name.toLowerCase());
  if (new Set(foldedNames).size !== files.length || !foldedNames.includes(entry.toLowerCase())) {
    fail("Canon runtime manifest DLL names must be case-insensitively unique and include its entry");
  }

  const runtimeDirectory = dirname(manifestPath);
  const directoryDlls = (await readdir(runtimeDirectory, { withFileTypes: true }))
    .filter((item) => item.name.toLowerCase().endsWith(".dll"))
    .map((item) => item.name.toLowerCase())
    .sort();
  if (JSON.stringify(directoryDlls) !== JSON.stringify([...foldedNames].sort())) {
    fail("Every DLL beside the Canon runtime manifest must be listed exactly once");
  }
  for (const file of files) {
    const filePath = join(runtimeDirectory, file.name);
    const fileInformation = await lstat(filePath).catch(() => null);
    if (!fileInformation?.isFile() || fileInformation.isSymbolicLink()) {
      fail(`Canon runtime file ${file.name} must be regular and non-symlink`);
    }
    if (await sha256File(filePath) !== file.sha256) {
      fail(`Canon runtime file ${file.name} failed SHA-256 verification`);
    }
  }

  return {
    path: manifestPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    manifest: {
      schema: value.schema,
      sdkVersion,
      architecture: "x64",
      entry,
      files,
    },
  };
}
