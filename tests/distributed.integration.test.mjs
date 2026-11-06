import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PixelBrightnessNode } from "../runtime/node/daemon.mjs";
import { createPixelBrightnessServer } from "../runtime/server/server.mjs";

async function waitFor(predicate, { timeoutMs = 8_000, intervalMs = 25, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}; last value: ${JSON.stringify(lastValue)}`);
}

function nodeConfig({ nodeId, serverUrl, dataDir, output }) {
  return {
    protocolVersion: 1,
    nodeId,
    name: nodeId,
    version: "0.1.0-test",
    serverUrl,
    dataDir,
    outputs: [{
      id: output,
      name: `Projector ${output}`,
      connector: `DP-${output === "A" ? 1 : 2}`,
      enabled: true,
      resolution: { width: 320, height: 180, refreshNum: 60, refreshDen: 1 },
    }],
    heartbeatMs: 100,
    clockSyncMs: 60_000,
    clockSyncRounds: 3,
    pollWaitMs: 250,
    requestTimeoutMs: 2_000,
    maxAssetBytes: 64 * 1024 * 1024,
    logLevel: "error",
    nodeToken: null,
  };
}

test("two render nodes cache locally and hold the same authoritative frame", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-cluster-"));
  const server = await createPixelBrightnessServer({ dataDir: join(root, "server"), offlineAfterMs: 2_000 });
  const nodes = [];
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const serverUrl = `http://127.0.0.1:${address.port}`;
    nodes.push(
      new PixelBrightnessNode(nodeConfig({ nodeId: "render-01", serverUrl, dataDir: join(root, "node-01"), output: "A" })),
      new PixelBrightnessNode(nodeConfig({ nodeId: "render-02", serverUrl, dataDir: join(root, "node-02"), output: "B" })),
    );
    await Promise.all(nodes.map((node) => node.start()));

    await waitFor(() => {
      const state = server.control.stateSnapshot();
      return state.nodes.length === 2
        && state.nodes.every((node) => node.status !== "offline")
        && nodes[0].store.state.project?.outputs?.map((output) => output.id).join(",") === "A"
        && nodes[1].store.state.project?.outputs?.map((output) => output.id).join(",") === "B";
    }, { message: "both node registrations and initial project sync" });
    assert.deepEqual(nodes[0].store.state.project.outputs.map((output) => output.id), ["A"]);
    assert.deepEqual(nodes[1].store.state.project.outputs.map((output) => output.id), ["B"]);
    const editedProject = server.control.getProject();
    editedProject.name = "Node-sharded dense wall";
    const fixture = Buffer.from("cluster media asset\n");
    const fixtureA = Buffer.from("wall A cue asset\n");
    const fixtureB = Buffer.from("wall B cue asset\n");
    const sha256 = createHash("sha256").update(fixture).digest("hex");
    const sha256A = createHash("sha256").update(fixtureA).digest("hex");
    const sha256B = createHash("sha256").update(fixtureB).digest("hex");
    editedProject.timeline.cues = [
      { id: "cue-a", assetSha256: sha256A, startFrame: 0, durationFrames: 120, outputIds: ["A"] },
      { id: "cue-b", assetSha256: sha256B, startFrame: 0, durationFrames: 120, outputIds: ["B"] },
      { id: "cue-broadcast", assetSha256: sha256, startFrame: 120, durationFrames: 120, outputIds: [] },
    ];
    const savedProject = await server.control.saveProject(editedProject, {
      ifMatchRevision: editedProject.revision,
    });
    assert.deepEqual(savedProject.syncTargets.map((target) => target.nodeId).sort(), ["render-01", "render-02"]);
    assert.equal(new Set(savedProject.syncTargets.map((target) => target.commandSequence)).size, 2,
      "each renderer must receive its own acknowledgement sequence");
    await waitFor(() => nodes.every((node) => (
      node.store.state.project?.revision === savedProject.project.revision
      && node.store.state.project.outputs.length === 1
    )), { message: "node-scoped project sync" });

    for (const [name, body] of [["cluster.bin", fixture], ["wall-a.bin", fixtureA], ["wall-b.bin", fixtureB]]) {
      const upload = await fetch(`${serverUrl}/v1/media/upload`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-file-name": name },
        body,
      });
      assert.equal(upload.status, 201);
    }

    await server.control.prepare({ assetSha256: sha256, baseFrame: 0 });
    await waitFor(() => server.control.stateSnapshot().timeline.readiness.allReady, {
      message: "two-node PREPARE readiness barrier",
    });
    assert.deepEqual(nodes[0].store.state.project.outputs.map((output) => output.id), ["A"]);
    assert.deepEqual(nodes[1].store.state.project.outputs.map((output) => output.id), ["B"]);
    assert.deepEqual(nodes[0].store.state.project.timeline.cues.map((cue) => cue.id), ["cue-a", "cue-broadcast"]);
    assert.deepEqual(nodes[1].store.state.project.timeline.cues.map((cue) => cue.id), ["cue-b", "cue-broadcast"]);
    assert.equal(await nodes[0].cache.has(sha256, { verify: true }), true);
    assert.equal(await nodes[1].cache.has(sha256, { verify: true }), true);
    assert.equal(await nodes[0].cache.has(sha256A, { verify: true }), true);
    assert.equal(await nodes[0].cache.has(sha256B, { verify: true }), false);
    assert.equal(await nodes[1].cache.has(sha256A, { verify: true }), false);
    assert.equal(await nodes[1].cache.has(sha256B, { verify: true }), true);
    for (const node of nodes) {
      assert.equal(node.diagnostics().projectRevision, server.store.state.project.revision);
    }

    const pattern = await server.control.outputPattern("A", { enabled: true, type: "grid", cellSize: 32 });
    assert.deepEqual(pattern.nodeIds, ["render-01"]);
    const patternSequence = pattern.commands[0].sequence;
    await waitFor(() => nodes[0].diagnostics().render.outputs[0]?.mode === "grid", {
      message: "per-projector 32 px grid pattern",
    });
    await waitFor(() => Number(server.control.getNodeDetail("render-01").node.ackSequence) >= patternSequence, {
      message: "pattern command acknowledgement",
    });
    assert.equal(nodes[1].diagnostics().render.outputs[0].mode, "content");
    const restore = await server.control.outputPattern("A", { enabled: false });
    const restoreSequence = restore.commands[0].sequence;
    await waitFor(() => (
      nodes[0].diagnostics().render.outputs[0]?.mode === "content"
      && Number(server.control.getNodeDetail("render-01").node.ackSequence) >= restoreSequence
    ), { message: "pattern content restoration acknowledgement" });

    const play = await server.control.play({ delayMs: 250, baseFrame: 600 });
    assert.equal(play.timeline.status, "scheduled");
    await waitFor(() => nodes.every((node) => {
      const diagnostics = node.diagnostics();
      return diagnostics.status === "playing" && Number(diagnostics.transport.currentFrame) >= 606;
    }), { message: "frame-locked playback" });

    const frames = nodes.map((node) => BigInt(node.diagnostics().transport.currentFrame));
    const spread = frames.reduce((maximum, frame) => frame > maximum ? frame : maximum, frames[0])
      - frames.reduce((minimum, frame) => frame < minimum ? frame : minimum, frames[0]);
    assert.ok(spread <= 1n, `software-clock frame spread was ${spread} frames`);
    assert.ok(nodes.every((node) => node.diagnostics().render.framesRendered > 0));

    const pause = await server.control.pause({ delayMs: 100 });
    const expectedPauseFrame = BigInt(pause.timeline.pauseFrame);
    await waitFor(() => nodes.every((node) => node.diagnostics().status === "paused"), {
      message: "coordinated pause",
    });
    const pausedFrames = nodes.map((node) => BigInt(node.diagnostics().transport.currentFrame));
    assert.deepEqual(pausedFrames, [expectedPauseFrame, expectedPauseFrame]);
  } finally {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
