import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PixelBrightnessNode } from "../runtime/node/daemon.mjs";
import { COMMAND, PROTOCOL_VERSION, defaultProject } from "../runtime/shared/protocol.mjs";
import { epochNowNs } from "../runtime/shared/timecore.mjs";

let leaseCounter = 0;

function executionLease(nodeId, ttlMs = 1_000) {
  const issuedAtNs = epochNowNs();
  leaseCounter += 1;
  return {
    schemaVersion: 1,
    leaseId: `execution_lease_${leaseCounter.toString(16).padStart(32, "0")}`,
    nodeId,
    fenceGeneration: 0,
    issuedAtNs: issuedAtNs.toString(),
    expiresAtNs: (issuedAtNs + BigInt(ttlMs) * 1_000_000n).toString(),
  };
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

class LeaseTestEngine {
  constructor({ patternDelayMs = 0 } = {}) {
    this.adapters = new Map();
    this.externalCadence = true;
    this.patternDelayMs = patternDelayMs;
    this.events = [];
    this.bootBlackLocked = true;
    this.visible = "black";
    this.onPatternStarted = null;
  }

  async initialize() { this.events.push("initialize"); }

  async configure(project) {
    this.projectRevision = project.revision;
    this.events.push(`configure:${project.revision}`);
  }

  async prepare() { this.events.push("prepare"); }

  async setPattern() {
    this.events.push("pattern:start");
    this.onPatternStarted?.();
    await new Promise((resolve) => setTimeout(resolve, this.patternDelayMs));
    this.visible = "pattern";
    this.events.push("pattern:visible");
  }

  async clearPattern() {
    this.visible = "content";
    this.events.push("pattern:clear");
  }

  async blank(enabled) {
    if (enabled) this.visible = "black";
    this.events.push(`blank:${enabled === true}`);
  }

  async releaseBootBlack() {
    this.bootBlackLocked = false;
    this.events.push("release");
  }

  discardBootBlackAuthorization() {
    this.bootBlackLocked = true;
    this.events.push("discard");
  }

  renderFrame() { return []; }

  async stop() { this.events.push("stop"); }

  diagnostics() {
    return {
      backend: "execution-lease-test",
      ready: true,
      connected: true,
      bootBlackLocked: this.bootBlackLocked,
      projectRevision: this.projectRevision ?? null,
      droppedFrames: 0,
      framesRendered: 0,
      outputs: [],
    };
  }
}

function config(directory, nodeId) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    nodeId,
    name: "Execution lease test node",
    version: "0.3.0-test",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: directory,
    outputs: [{ id: "A", connector: "DP-1" }],
    heartbeatMs: 20,
    hostTelemetryMs: 60_000,
    clockSyncMs: 60_000,
    clockSyncRounds: 1,
    pollWaitMs: 20,
    requestTimeoutMs: 500,
    maxAssetBytes: 1_000_000,
    maxCacheBytes: 2_000_000,
    hostActionsDryRun: true,
    platform: "darwin",
    logLevel: "error",
    nodeToken: null,
  };
}

function dependencies(engine) {
  return {
    renderEngineFactory: () => engine,
    hostTelemetryCollector: {
      collect: async ({ renderer }) => ({ schemaVersion: 2, host: { hostname: "lease-test" }, renderer }),
    },
    hostActionExecutor: {
      dryRun: true,
      allowPowerActions: false,
      allowXrandrFallback: false,
      displayStore: { initialize: async () => null, snapshot: () => null, flush: async () => {} },
      initialize: async () => null,
      execute: async () => { throw new Error("unexpected host action"); },
    },
  };
}

test("lease loss during an unabortable renderer mutation re-blacks last and suppresses the cursor ACK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-node-execution-lease-mutation-"));
  const nodeId = "lease-delayed-pattern";
  const project = defaultProject();
  const engine = new LeaseTestEngine({ patternDelayMs: 250 });
  let patternStarted = false;
  let commandSent = false;
  let aborted = false;
  engine.onPatternStarted = () => { patternStarted = true; };
  const command = {
    protocolVersion: PROTOCOL_VERSION,
    id: "lease-delayed-pattern-command",
    sequence: 1,
    type: COMMAND.CALIBRATION_PATTERN,
    createdAtNs: epochNowNs().toString(),
    effectiveAtNs: null,
    payload: { outputId: "A", enabled: true, type: "solid", rgb: [0.2, 0.2, 0.2] },
  };
  const client = {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      node: { ackSequence: 0, commandSequence: 1, failClosedFence: null },
      commandSequence: 1,
      executionLease: executionLease(nodeId),
      project,
    }),
    state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async () => {
      if (patternStarted) throw new Error("simulated lease-renewal partition");
      return {
        serverTimeNs: epochNowNs().toString(),
        failClosedFence: null,
        executionLease: executionLease(nodeId),
        acknowledgedActionResultIds: [],
      };
    },
    pollCommands: async () => {
      if (!commandSent) {
        commandSent = true;
        return {
          protocolVersion: PROTOCOL_VERSION,
          commandSequence: 1,
          failClosedFence: null,
          executionLease: executionLease(nodeId),
          commands: [command],
        };
      }
      while (!aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("aborted");
    },
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async () => { throw new Error("unexpected download"); },
    abort: () => { aborted = true; },
  };
  const node = new PixelBrightnessNode(config(directory, nodeId), dependencies(engine));
  node.client = client;
  node.cache.client = client;
  try {
    await node.start();
    await waitFor(() => engine.events.includes("pattern:visible"), "delayed pattern did not complete");
    await waitFor(() => {
      const visibleIndex = engine.events.lastIndexOf("pattern:visible");
      return engine.events.slice(visibleIndex + 1).includes("blank:true");
    }, "lease expiry did not reassert black after the delayed mutation");
    const diagnostics = node.diagnostics();
    assert.equal(engine.visible, "black");
    assert.equal(diagnostics.ackSequence, 0,
      "a command which crossed its execution authority boundary must not advance the cursor");
    assert.equal(diagnostics.metrics.commandsProcessed, 0);
    assert.equal(diagnostics.metrics.commandFailures, 0,
      "lease backpressure is not poison-command retry/dead-letter evidence");
    const visibleIndex = engine.events.lastIndexOf("pattern:visible");
    assert.equal(engine.events.slice(visibleIndex + 1).filter((event) => (
      event.startsWith("pattern:") || event.startsWith("blank:")
    )).at(-1), "blank:true");
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("an authenticated fence is black before a failing Node-state publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-node-fence-persist-failure-"));
  const nodeId = "lease-fence-persist-failure";
  const project = defaultProject();
  const engine = new LeaseTestEngine();
  let aborted = false;
  let currentFence = null;
  let releasePoll;
  const client = {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      node: { ackSequence: 0, commandSequence: 0, failClosedFence: currentFence },
      commandSequence: 0,
      executionLease: currentFence == null ? executionLease(nodeId, 5_000) : null,
      project,
    }),
    state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async () => ({
      serverTimeNs: epochNowNs().toString(),
      failClosedFence: currentFence,
      executionLease: currentFence == null ? executionLease(nodeId, 5_000) : null,
      acknowledgedActionResultIds: [],
    }),
    pollCommands: async () => {
      if (currentFence != null) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          commandSequence: 0,
          failClosedFence: currentFence,
          executionLease: null,
          commands: [],
        };
      }
      await new Promise((resolve) => { releasePoll = resolve; });
      if (aborted) throw new Error("aborted");
      return {
        protocolVersion: PROTOCOL_VERSION,
        commandSequence: 0,
        failClosedFence: currentFence,
        executionLease: null,
        commands: [],
      };
    },
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async () => { throw new Error("unexpected download"); },
    abort: () => { aborted = true; releasePoll?.(); },
  };
  const node = new PixelBrightnessNode(config(directory, nodeId), dependencies(engine));
  node.client = client;
  node.cache.client = client;
  try {
    await node.start();
    await waitFor(() => node.diagnostics().connected, "Node did not finish its authoritative registration");
    const originalSave = node.store.save.bind(node.store);
    let rejectedFenceWrite = false;
    node.store.save = async (candidate) => {
      if (!rejectedFenceWrite && candidate?.serverFailClosedFence?.status === "active") {
        rejectedFenceWrite = true;
        engine.events.push("state-save:rejected");
        const error = new Error("simulated fence fsync failure");
        error.code = "ENOSPC";
        throw error;
      }
      return originalSave(candidate);
    };
    const activatedAt = new Date().toISOString();
    currentFence = {
      status: "active",
      generation: 1,
      deadLetterId: "command_dead_letter_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      activatedAt,
      effectiveAtNs: (epochNowNs() + 5_000_000_000n).toString(),
      sourceCommand: { nodeId: "peer-node", id: "poison-play", sequence: 1, type: COMMAND.PLAY_AT },
    };
    releasePoll?.();
    await waitFor(() => rejectedFenceWrite, "fence persistence failure was not injected");
    const rejectedIndex = engine.events.indexOf("state-save:rejected");
    assert.ok(engine.events.slice(0, rejectedIndex).includes("blank:true"),
      "authenticated black must precede the first fallible fence-state write");
    await waitFor(() => node.diagnostics().serverFailClosedFence?.generation === 1,
      "Node did not retain authenticated fence authority in RAM");
    assert.equal(engine.visible, "black");
    assert.equal(node.diagnostics().ackSequence, 0);
    assert.equal(node.diagnostics().stateRecoverySafetyLock?.status, "active");
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Server LKG recovery marker establishes durable Node sticky black without a lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-node-server-state-recovery-"));
  const nodeId = "lease-server-recovery";
  const project = defaultProject();
  const engine = new LeaseTestEngine();
  let aborted = false;
  const marker = {
    schemaVersion: 1,
    status: "active",
    generation: 1,
    recoveryId: "server_state_recovery_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    detectedAt: "2026-08-25T00:00:01.000Z",
    reason: "primary-invalid-lkg-rollback",
    recoveredStateUpdatedAt: "2026-08-25T00:00:00.000Z",
    recoveredStateSha256: "b".repeat(64),
  };
  const client = {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      node: { ackSequence: 0, commandSequence: 0, failClosedFence: null },
      commandSequence: 0,
      serverStateRecovery: marker,
      executionLease: null,
      project,
    }),
    state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async () => ({
      serverTimeNs: epochNowNs().toString(),
      serverStateRecovery: marker,
      failClosedFence: null,
      executionLease: null,
      acknowledgedActionResultIds: [],
    }),
    pollCommands: async () => {
      while (!aborted) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          protocolVersion: PROTOCOL_VERSION,
          commandSequence: 0,
          serverStateRecovery: marker,
          failClosedFence: null,
          executionLease: null,
          commands: [],
        };
      }
      throw new Error("aborted");
    },
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async () => { throw new Error("unexpected download"); },
    abort: () => { aborted = true; },
  };
  const node = new PixelBrightnessNode(config(directory, nodeId), dependencies(engine));
  node.client = client;
  node.cache.client = client;
  try {
    await node.start();
    await waitFor(() => node.store.snapshot().stateRecoverySafetyLock?.status === "active",
      "Server recovery marker did not establish the durable Node safety lock");
    assert.equal(node.executionLeaseExpired, true);
    assert.equal(engine.visible, "black");
    assert.equal(engine.events.includes("release"), false);
    assert.equal(node.store.snapshot().stateRecoverySafetyLock.reason.code,
      "SERVER_STATE_RECOVERY_REQUIRED");
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
