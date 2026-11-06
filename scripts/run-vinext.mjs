#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "node_modules", "vinext", "dist", "cli.js");
const command = process.argv[2];
if (!new Set(["dev", "build", "start"]).has(command)) {
  process.stderr.write("Usage: node scripts/run-vinext.mjs <dev|build|start>\n");
  process.exitCode = 2;
} else {
  const child = spawn(process.execPath, [cli, command, ...process.argv.slice(3)], {
    cwd: root,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || join(root, ".wrangler", "wrangler.log"),
    },
    stdio: "inherit",
    windowsHide: false,
  });
  child.once("error", (error) => {
    process.stderr.write(`Unable to launch vinext: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.stderr.write(`vinext stopped by ${signal}\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = code ?? 1;
    }
  });
}
