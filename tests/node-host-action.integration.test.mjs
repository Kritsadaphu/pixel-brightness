import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PixelBrightnessNode } from "../runtime/node/daemon.mjs";
import { hostActionResultId } from "../runtime/node/host-actions.mjs";
import { defaultProject } from "../runtime/shared/protocol.mjs";
import { epochNowNs } from "../runtime/shared/timecore.mjs";
import { validateDisplayConfig } from "../runtime/node/display-config.mjs";
import { MAX_PENDING_HOST_ACTION_RESULTS } from "../runtime/node/state-store.mjs";

let executionLeaseCounter = 0;
function executionLease(nodeId) {
  const issuedAtNs = epochNowNs();
  executionLeaseCounter += 1;
  return {
    schemaVersion: 1,
    leaseId: `execution_lease_${executionLeaseCounter.toString(16).padStart(32, "0")}`,
    nodeId,
    fenceGeneration: 0,
    issuedAtNs: issuedAtNs.toString(),
    expiresAtNs: (issuedAtNs + 5_000_000_000n).toString(),
  };
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

test("node executes queued HOST_ACTION, heartbeats host/result, persists ack, then clears acknowledged result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-node-host-action-"));
  const project = defaultProject();
  const heartbeatPayloads = [];
  let sent = false;
  let aborted = false;
  const actionCalls = [];
  const hostActionExecutor = {
    dryRun: true,
    allowPowerActions: false,
    allowXrandrFallback: false,
    displayStore: { initialize: async () => null, snapshot: () => null, flush: async () => {} },
    initialize: async () => null,
    execute: async ({ commandId, sequence, action }) => {
      actionCalls.push({ commandId, sequence, action });
      return {
        resultId: hostActionResultId(commandId, sequence, action.id),
        commandId,
        sequence,
        actionId: action.id,
        actionType: action.type,
        status: "dry-run",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        result: { dryRun: true },
      };
    },
  };
  const hostTelemetryCollector = {
    collect: async ({ renderer }) => ({ schemaVersion: 2, host: { hostname: "node-test" }, renderer }),
  };
  const fakeClient = {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: 1 },
      commandSequence: 1,
      executionLease: executionLease("node-host-test"),
      project,
    }),
    state: async () => ({ project, timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async (payload) => {
      heartbeatPayloads.push(payload);
      return {
        serverTimeNs: epochNowNs().toString(),
        failClosedFence: null,
        executionLease: executionLease("node-host-test"),
        acknowledgedActionResultIds: payload.actionResults.map((result) => result.resultId),
      };
    },
    pollCommands: async () => {
      if (!sent) {
        sent = true;
        return {
          protocolVersion: 1,
          failClosedFence: null,
          executionLease: executionLease("node-host-test"),
          commands: [{
            protocolVersion: 1,
            id: "cmd-host-1",
            sequence: 1,
            type: "HOST_ACTION",
            action: { id: "action-host-1", type: "COLLECT_DIAGNOSTICS", payload: {} },
          }],
        };
      }
      while (!aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("aborted");
    },
    assetUrl: (sha) => `/v1/assets/${sha}`,
    download: async () => { throw new Error("unexpected download"); },
    abort: () => { aborted = true; },
  };
  const config = {
    nodeId: "node-host-test",
    name: "Node Host Test",
    version: "0.2.0",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: directory,
    outputs: [{ id: "A", connector: "DP-1" }],
    heartbeatMs: 25,
    hostTelemetryMs: 1_000,
    clockSyncMs: 5_000,
    clockSyncRounds: 3,
    pollWaitMs: 25,
    requestTimeoutMs: 500,
    maxAssetBytes: 1_000_000,
    logLevel: "error",
    nodeToken: null,
  };
  const node = new PixelBrightnessNode(config, { hostActionExecutor, hostTelemetryCollector });
  node.client = fakeClient;
  node.cache.client = fakeClient;
  await node.start();
  await waitFor(() => heartbeatPayloads.some((payload) => payload.actionResults.some((result) => (
    result.resultId === hostActionResultId("cmd-host-1", 1, "action-host-1")
  ))));
  await waitFor(() => node.diagnostics().actionResults.length === 0);
  const diagnostics = node.diagnostics();
  await node.stop();

  assert.equal(actionCalls.length, 1);
  assert.equal(actionCalls[0].action.type, "COLLECT_DIAGNOSTICS");
  assert.equal(diagnostics.ackSequence, 1);
  assert.ok(heartbeatPayloads.some((payload) => payload.host?.host?.hostname === "node-test"));
  assert.ok(heartbeatPayloads.some((payload) => payload.actionResults.some((result) => (
    result.resultId === hostActionResultId("cmd-host-1", 1, "action-host-1")
  ))));
  assert.equal(diagnostics.actionResults.length, 0);
});

test("node backpressures the 129th host mutation without evicting unacknowledged results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-node-host-action-backpressure-"));
  const project = defaultProject();
  const commandCount = MAX_PENDING_HOST_ACTION_RESULTS + 1;
  const commands = Array.from({ length: commandCount }, (_unused, index) => {
    const sequence = index + 1;
    return {
      protocolVersion: 1,
      id: `cmd-host-capacity-${sequence}`,
      sequence,
      type: "HOST_ACTION",
      action: {
        id: `action-host-capacity-${sequence}`,
        type: "COLLECT_DIAGNOSTICS",
        payload: {},
      },
    };
  });
  const actionCalls = [];
  let acceptHeartbeats = false;
  let aborted = false;
  const publishedBeforeRelease = [];
  const hostActionExecutor = {
    dryRun: true,
    allowPowerActions: false,
    allowXrandrFallback: false,
    displayStore: { initialize: async () => null, snapshot: () => null, flush: async () => {} },
    initialize: async () => null,
    execute: async ({ commandId, sequence, action }) => {
      actionCalls.push(sequence);
      const timestamp = new Date().toISOString();
      return {
        resultId: hostActionResultId(commandId, sequence, action.id),
        commandId,
        sequence,
        actionId: action.id,
        actionType: action.type,
        status: "dry-run",
        startedAt: timestamp,
        completedAt: timestamp,
        result: { dryRun: true, sequence },
      };
    },
  };
  const fakeClient = {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: commandCount },
      commandSequence: commandCount,
      executionLease: executionLease("node-host-capacity"),
      project,
    }),
    state: async () => ({ project, timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async (payload) => {
      if (!acceptHeartbeats) {
        publishedBeforeRelease.push(payload.actionResults.map((result) => result.resultId));
      }
      return {
        serverTimeNs: epochNowNs().toString(),
        failClosedFence: null,
        executionLease: executionLease("node-host-capacity"),
        acknowledgedActionResultIds: acceptHeartbeats
          ? payload.actionResults.map((result) => result.resultId)
          : [],
      };
    },
    pollCommands: async (after) => {
      const pending = commands.filter((command) => command.sequence > after);
      if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
      return {
        protocolVersion: 1,
        commandSequence: commandCount,
        failClosedFence: null,
        executionLease: executionLease("node-host-capacity"),
        commands: pending,
      };
    },
    assetUrl: (sha) => `/v1/assets/${sha}`,
    download: async () => { throw new Error("unexpected download"); },
    abort: () => { aborted = true; },
  };
  const node = new PixelBrightnessNode({
    nodeId: "node-host-capacity",
    name: "Node Host Capacity",
    version: "0.2.0",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: directory,
    outputs: [{ id: "A", connector: "DP-1" }],
    heartbeatMs: 10,
    hostTelemetryMs: 60_000,
    clockSyncMs: 60_000,
    clockSyncRounds: 1,
    pollWaitMs: 5,
    requestTimeoutMs: 500,
    maxAssetBytes: 1_000_000,
    logLevel: "error",
    nodeToken: null,
  }, {
    hostActionExecutor,
    hostTelemetryCollector: {
      collect: async ({ renderer }) => ({ schemaVersion: 2, host: { hostname: "capacity" }, renderer }),
    },
  });
  node.client = fakeClient;
  node.cache.client = fakeClient;
  await node.start();
  try {
    await waitFor(() => actionCalls.length === MAX_PENDING_HOST_ACTION_RESULTS, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const blocked = node.diagnostics();
    const firstResultId = hostActionResultId(
      commands[0].id,
      commands[0].sequence,
      commands[0].action.id,
    );
    assert.equal(actionCalls.length, MAX_PENDING_HOST_ACTION_RESULTS);
    assert.equal(blocked.ackSequence, MAX_PENDING_HOST_ACTION_RESULTS);
    assert.equal(blocked.actionResults.length, MAX_PENDING_HOST_ACTION_RESULTS);
    assert.equal(blocked.actionResults[0].resultId, firstResultId);
    assert.equal(blocked.metrics.commandFailures, 0);
    assert.deepEqual(blocked.pendingCommandDeadLetters, []);
    assert.ok(publishedBeforeRelease.some((ids) => ids.includes(firstResultId)));

    acceptHeartbeats = true;
    await waitFor(() => (
      actionCalls.length === commandCount
      && node.diagnostics().ackSequence === commandCount
      && node.diagnostics().actionResults.length === 0
    ), 10_000);
    assert.deepEqual(actionCalls, Array.from({ length: commandCount }, (_unused, index) => index + 1));
    assert.equal(node.diagnostics().metrics.commandFailures, 0);
  } finally {
    if (!aborted) await node.stop();
  }
});

test("live Linux startup reconciles persisted display config once and surfaces an unapplied fault", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-node-display-reconcile-"));
  const project = defaultProject();
  const savedDisplay = validateDisplayConfig({
    backend: "kms",
    outputs: [{
      id: "A",
      connector: "DP-1",
      enabled: true,
      x: 0,
      y: 0,
      resolution: { width: 1920, height: 1080, refreshNum: 60, refreshDen: 1 },
    }],
  });
  const actionCalls = [];
  const hostActionExecutor = {
    dryRun: false,
    platform: "linux",
    allowPowerActions: false,
    allowXrandrFallback: false,
    displayStore: { initialize: async () => savedDisplay, snapshot: () => savedDisplay, flush: async () => {} },
    initialize: async function initialize() { return this.displayStore.initialize(); },
    execute: async ({ commandId, action }) => {
      actionCalls.push({ commandId, action });
      return {
        resultId: "startup-display-result",
        commandId,
        sequence: 0,
        actionId: action.id,
        actionType: action.type,
        status: "failed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: { code: "KMS_APPLY_FAILED", message: "KMS helper unavailable", details: null },
      };
    },
  };
  const hostTelemetryCollector = {
    collect: async ({ renderer }) => ({
      schemaVersion: 2,
      host: { hostname: "node-display" },
      drm: { available: true, connectors: [{ connector: "DP-1", status: "connected" }] },
      renderer,
    }),
  };
  let aborted = false;
  const fakeClient = {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: 0 },
      commandSequence: 0,
      executionLease: executionLease("node-display-test"),
      project,
    }),
    state: async () => ({ project, timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async () => ({
      serverTimeNs: epochNowNs().toString(),
      failClosedFence: null,
      executionLease: executionLease("node-display-test"),
      acknowledgedActionResultIds: [],
    }),
    pollCommands: async () => {
      while (!aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("aborted");
    },
    assetUrl: (sha) => `/v1/assets/${sha}`,
    download: async () => { throw new Error("unexpected download"); },
    abort: () => { aborted = true; },
  };
  const config = {
    nodeId: "node-display-test",
    name: "Node Display Test",
    version: "0.2.0",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: directory,
    outputs: [{ id: "A", connector: "DP-1" }],
    heartbeatMs: 25,
    hostTelemetryMs: 1_000,
    clockSyncMs: 5_000,
    clockSyncRounds: 3,
    pollWaitMs: 25,
    requestTimeoutMs: 500,
    maxAssetBytes: 1_000_000,
    logLevel: "error",
    nodeToken: null,
  };
  const node = new PixelBrightnessNode(config, { hostActionExecutor, hostTelemetryCollector });
  node.client = fakeClient;
  node.cache.client = fakeClient;
  await node.start();
  const readyDeadline = Date.now() + 2_000;
  while (Date.now() < readyDeadline) {
    const current = node.diagnostics();
    if (current.connected && current.status === "degraded") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const diagnostics = node.diagnostics();
  await node.stop();

  assert.equal(actionCalls.length, 1);
  assert.equal(actionCalls[0].action.type, "APPLY_DISPLAY_CONFIG");
  assert.equal(diagnostics.display.configured, true);
  assert.equal(diagnostics.display.applied, false);
  assert.equal(diagnostics.display.status, "failed");
  assert.equal(diagnostics.host.display.error.code, "KMS_APPLY_FAILED");
  assert.equal(diagnostics.host.display.faults[0].code, "KMS_APPLY_FAILED");
  assert.equal(diagnostics.status, "degraded");
});
