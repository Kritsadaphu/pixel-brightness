#!/usr/bin/env node
import process from "node:process";
import { resolve } from "node:path";

import { PixelBrightnessNode } from "./node/daemon.mjs";
import { createPixelBrightnessServer } from "./server/server.mjs";
import { SOFTWARE_VERSION } from "./shared/protocol.mjs";

const dataRoot = resolve(process.env.PIXEL_DEMO_DATA_DIR || "runtime/data/demo");
const host = process.env.PIXEL_DEMO_HOST || "127.0.0.1";
const port = Number(process.env.PIXEL_DEMO_PORT || 4100);
const quietEvents = new Set(["clock.synced"]);
const log = (level, event, details = {}) => {
  if (level === "debug" || quietEvents.has(event)) return;
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level, event, ...details })}\n`);
};

const server = await createPixelBrightnessServer({ dataDir: resolve(dataRoot, "server") });
await server.listen({ host, port });

const node = new PixelBrightnessNode({
  protocolVersion: 1,
  nodeId: "render-01",
  name: "Demo Mini PC · North wall",
  version: SOFTWARE_VERSION,
  serverUrl: `http://${host}:${port}`,
  dataDir: resolve(dataRoot, "render-01"),
  outputs: ["A", "B", "C"].map((id, index) => ({
    id,
    name: `Projector ${id}`,
    connector: `DP-${index + 1}`,
    enabled: true,
    resolution: { width: 1920, height: 1080, refreshNum: 60, refreshDen: 1 },
  })),
  heartbeatMs: 1_000,
  clockSyncMs: 60_000,
  clockSyncRounds: 8,
  pollWaitMs: 20_000,
  requestTimeoutMs: 10_000,
  maxAssetBytes: 50 * 1024 * 1024 * 1024,
  logLevel: "info",
  nodeToken: null,
}, { log });
await node.start();

process.stdout.write(`\nPixel Brightness V3 demo is running:\n`);
process.stdout.write(`  Server API  http://${host}:${port}/v1/state\n`);
process.stdout.write(`  Web Control  npm run dev  →  http://localhost:3000\n`);
process.stdout.write(`  Node         render-01 / DP-1, DP-2, DP-3\n\n`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${signal}: stopping demo cluster...\n`);
  await node.stop();
  await server.close();
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
