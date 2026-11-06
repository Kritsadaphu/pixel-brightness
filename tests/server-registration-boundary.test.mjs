import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_OUTPUTS_PER_RENDER_NODE, PROTOCOL_VERSION } from "../runtime/shared/protocol.mjs";
import { createPixelBrightnessServer } from "../runtime/server/server.mjs";

test("oversized Node capability advertisements cannot poison durable Server state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pb-registration-boundary-"));
  let server = await createPixelBrightnessServer({ dataDir });
  try {
    const oversizedOutputs = Array.from({ length: 257 }, (_, index) => ({
      id: `output-${index}`,
      name: "n".repeat(1_000),
      connector: `DP-${index}`,
      resolution: { width: 1920, height: 1080, refreshNum: 60, refreshDen: 1 },
      untrustedExtra: "must-not-persist",
    }));
    const before = JSON.stringify(server.store.state);
    await assert.rejects(
      server.control.register({
        protocolVersion: PROTOCOL_VERSION,
        nodeId: "oversized-node",
        name: "x".repeat(1_000),
        capabilities: {
          outputs: oversizedOutputs,
          codecs: Array.from({ length: 100 }, (_, index) => `codec/${index}`),
        },
      }),
      new RegExp(`at most ${MAX_OUTPUTS_PER_RENDER_NODE}`),
    );
    assert.equal(JSON.stringify(server.store.state), before,
      "rejected registration must not mutate nodes, queues, cursors or timestamps");

    await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "normal-node",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    await server.close();
    server = await createPixelBrightnessServer({ dataDir });
    assert.equal(server.store.state.nodes["oversized-node"], undefined);
    assert.equal(server.store.state.nodes["normal-node"].nodeId, "normal-node");
  } finally {
    await server.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
