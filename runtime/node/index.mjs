#!/usr/bin/env node
import process from "node:process";
import { loadNodeConfig, nodeHelp } from "./config.mjs";
import { PixelBrightnessNode } from "./daemon.mjs";

const LEVEL = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function createLogger(minimum = "info") {
  return (level, event, details = {}) => {
    if (LEVEL[level] < LEVEL[minimum]) return;
    const record = { at: new Date().toISOString(), level, event, ...details };
    const output = level === "error" || level === "warn" ? process.stderr : process.stdout;
    output.write(`${JSON.stringify(record)}\n`);
  };
}

let config;
try {
  config = await loadNodeConfig();
} catch (error) {
  process.stderr.write(`pixel-brightness-node: ${error.message}\n\n${nodeHelp()}\n`);
  process.exitCode = 2;
}

if (config?.help) {
  process.stdout.write(`${nodeHelp()}\n`);
} else if (config) {
  const log = createLogger(config.logLevel);
  const node = new PixelBrightnessNode(config, { log });
  try {
    await node.start();
  } catch (error) {
    log("error", "node.start.failed", { error: error.stack || error.message });
    process.exitCode = 1;
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log("info", "node.shutdown", { signal });
    try {
      await node.stop();
    } catch (error) {
      log("error", "node.shutdown.failed", { error: error.stack || error.message });
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
