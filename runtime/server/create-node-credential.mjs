#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createNodeCredential } from "../shared/node-auth.mjs";

function usage() {
  return `Create one Pixel Brightness Render Node credential

Usage:
  node runtime/server/create-node-credential.mjs --node-id <id> --secret-file <path>

The signing key is read from a protected file and is never accepted in argv.
`;
}

function argumentsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--node-id" && flag !== "--secret-file") throw new Error(`Unknown option: ${flag}`);
    const value = argv[++index];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--node-id") result.nodeId = value;
    else result.secretFile = value;
  }
  if (!result.nodeId) throw new Error("--node-id is required");
  if (!result.secretFile) throw new Error("--secret-file is required");
  return result;
}

try {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
  } else {
    const secret = (await readFile(path.resolve(options.secretFile), "utf8")).trim();
    process.stdout.write(`${createNodeCredential(options.nodeId, secret)}\n`);
  }
} catch (error) {
  process.stderr.write(`pixel-brightness-node-credential: ${error.message}\n`);
  process.exitCode = 2;
}
