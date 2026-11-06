import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPixelBrightnessServer } from "../runtime/server/server.mjs";
import { createNodeCredential } from "../runtime/shared/node-auth.mjs";

const CONTROL_TOKEN = "explicit-owner-control-token-00000000000001";
const NODE_SIGNING_KEY = "explicit-owner-node-signing-key-0000000001";

function controlHeaders(extra = {}) {
  return { authorization: `Bearer ${CONTROL_TOKEN}`, ...extra };
}

async function jsonRequest(baseUrl, pathname, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() };
}

async function register(baseUrl, nodeId, token, outputs) {
  return jsonRequest(baseUrl, "/v1/nodes/register", {
    token,
    method: "POST",
    body: {
      protocolVersion: 1,
      nodeId,
      capabilities: { outputs },
    },
  });
}

async function upload(baseUrl, name, bytes) {
  const response = await fetch(`${baseUrl}/v1/media/upload`, {
    method: "POST",
    headers: controlHeaders({
      "content-type": "application/octet-stream",
      "x-file-name": name,
    }),
    body: bytes,
  });
  assert.equal(response.status, 201);
  return (await response.json()).media.sha256;
}

test("secured output ownership ignores self-claimed capabilities across every routing boundary", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-explicit-output-owner-"));
  const server = await createPixelBrightnessServer({
    dataDir,
    controlToken: CONTROL_TOKEN,
    nodeSigningKey: NODE_SIGNING_KEY,
    offlineAfterMs: 60_000,
  });
  const credentials = Object.fromEntries(["render-a", "render-b", "render-unassigned"].map((nodeId) => (
    [nodeId, createNodeCredential(nodeId, NODE_SIGNING_KEY)]
  )));
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    assert.equal((await register(baseUrl, "render-a", credentials["render-a"], [
      { id: "A", connector: "DP-1" },
    ])).response.status, 201);
    assert.equal((await register(baseUrl, "render-b", credentials["render-b"], [
      { id: "B", connector: "DP-2" },
    ])).response.status, 201);
    assert.equal((await register(baseUrl, "render-unassigned", credentials["render-unassigned"], [
      { id: "C", connector: "DP-3" },
    ])).response.status, 201);

    const initial = server.control.getProject();
    initial.outputs = initial.outputs.map((output) => ({
      ...output,
      nodeId: output.id === "A"
        ? "render-a"
        : output.id === "B" ? "render-b" : null,
    }));
    await server.control.saveProject(initial, { ifMatchRevision: initial.revision });

    const poisonedRegistration = await register(
      baseUrl,
      "render-a",
      credentials["render-a"],
      [
        { id: "A", connector: "DP-1" },
        { id: "B", connector: "DP-2" },
        { id: "C", connector: "DP-3" },
      ],
    );
    assert.equal(poisonedRegistration.response.status, 201);
    assert.deepEqual(poisonedRegistration.body.project.outputs.map((output) => output.id), ["A"]);
    const authoritativeSync = server.store.state.commandQueues["render-a"].findLast((command) => (
      command.type === "sync-project"
      && command.payload.project.revision === server.store.state.project.revision
    ));
    assert.ok(authoritativeSync);
    assert.deepEqual(authoritativeSync.payload.project.outputs.map((output) => output.id), ["A"]);

    const prepared = await server.control.prepare({ baseFrame: 0 });
    assert.deepEqual([...prepared.nodeIds].sort(), ["render-a", "render-b"]);
    const beforeRejectedPrepare = {
      timeline: structuredClone(server.store.state.timeline),
      queues: structuredClone(server.store.state.commandQueues),
    };
    await assert.rejects(
      server.control.prepare({ nodeIds: ["render-unassigned"], baseFrame: 0 }),
      (error) => error?.status === 409
        && error?.code === "timeline_target_output_ownership_required",
    );
    assert.deepEqual(server.store.state.timeline, beforeRejectedPrepare.timeline);
    assert.deepEqual(server.store.state.commandQueues, beforeRejectedPrepare.queues);

    const queueBeforePattern = structuredClone(server.store.state.commandQueues);
    await assert.rejects(
      server.control.outputPattern("B", {
        nodeIds: ["render-a"],
        enabled: true,
        type: "grid",
      }),
      (error) => error?.status === 409 && error?.code === "output_node_ownership_mismatch",
    );
    assert.deepEqual(server.store.state.commandQueues, queueBeforePattern);
    const calibrationsBefore = structuredClone(server.store.state.cameraCalibrations);
    await assert.rejects(
      server.control.startCameraCalibration({
        nodeId: "render-a",
        outputIds: ["B"],
        mode: "simulation",
      }),
      (error) => error?.status === 400 && error?.code === "invalid_camera_calibration_outputs",
    );
    assert.deepEqual(server.store.state.cameraCalibrations, calibrationsBefore);

    const oldWallBBytes = Buffer.from("old wall B cue that must be revoked\n");
    const oldWallBSha256 = await upload(baseUrl, "old-wall-b.bin", oldWallBBytes);
    assert.equal(oldWallBSha256, createHash("sha256").update(oldWallBBytes).digest("hex"));
    const temporarilyAssigned = server.control.getProject();
    temporarilyAssigned.outputs = temporarilyAssigned.outputs.map((output) => ({
      ...output,
      nodeId: output.id === "B" ? "render-a" : output.nodeId,
    }));
    temporarilyAssigned.timeline.cues = [{
      id: "old-wall-b",
      assetSha256: oldWallBSha256,
      startFrame: 0,
      durationFrames: 1,
      outputIds: ["B"],
    }];
    await server.control.saveProject(temporarilyAssigned, {
      ifMatchRevision: temporarilyAssigned.revision,
    });
    await server.control.outputPattern("A", { enabled: true, type: "identify" });
    const reassigned = server.control.getProject();
    reassigned.outputs = reassigned.outputs.map((output) => ({
      ...output,
      nodeId: output.id === "B" ? "render-b" : output.nodeId,
    }));
    await server.control.saveProject(reassigned, { ifMatchRevision: reassigned.revision });

    assert.ok(server.store.state.commandQueues["render-a"].some((command) => (
      command.payload?.project?.timeline?.cues?.some((cue) => cue.assetSha256 === oldWallBSha256)
    )), "the adversarial fixture must retain an old authorized cue in A's durable queue");
    const repoisoned = await register(
      baseUrl,
      "render-a",
      credentials["render-a"],
      [{ id: "A", connector: "DP-1" }, { id: "B", connector: "DP-2" }],
    );
    assert.equal(repoisoned.response.status, 201);
    assert.deepEqual(repoisoned.body.project.outputs.map((output) => output.id), ["A"]);
    assert.equal((await fetch(`${baseUrl}/v1/assets/${oldWallBSha256}`, {
      headers: { authorization: `Bearer ${credentials["render-a"]}` },
    })).status, 403, "a stale queued cue and forged capability must not retain B's asset");
    assert.equal((await fetch(`${baseUrl}/v1/assets/${oldWallBSha256}`, {
      headers: { authorization: `Bearer ${credentials["render-b"]}` },
    })).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/assets/${oldWallBSha256}`, {
      headers: { authorization: `Bearer ${credentials["render-unassigned"]}` },
    })).status, 403);

    const mainBytes = Buffer.from("explicit render-a prepared main asset\n");
    const mainSha256 = await upload(baseUrl, "render-a-main.bin", mainBytes);
    await server.control.prepare({ nodeIds: ["render-a"], assetSha256: mainSha256, baseFrame: 0 });
    assert.equal((await fetch(`${baseUrl}/v1/assets/${mainSha256}`, {
      headers: { authorization: `Bearer ${credentials["render-a"]}` },
    })).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/assets/${mainSha256}`, {
      headers: { authorization: `Bearer ${credentials["render-b"]}` },
    })).status, 403);

    const invalidatingProject = server.control.getProject();
    invalidatingProject.name = `${invalidatingProject.name} ownership revocation`;
    await server.control.saveProject(invalidatingProject, {
      ifMatchRevision: invalidatingProject.revision,
    });
    assert.ok(server.store.state.commandQueues["render-a"].some((command) => (
      command.payload?.assetSha256 === mainSha256
    )), "the invalidation fixture must retain the old PREPARE command");
    assert.equal((await fetch(`${baseUrl}/v1/assets/${mainSha256}`, {
      headers: { authorization: `Bearer ${credentials["render-a"]}` },
    })).status, 403, "an invalidated queued PREPARE must not remain an authorization grant");
  } finally {
    await server.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
