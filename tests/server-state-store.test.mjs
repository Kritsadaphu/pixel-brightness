import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PersistentStore } from "../runtime/server/store.mjs";
import { createPixelBrightnessServer } from "../runtime/server/server.mjs";
import { COMMAND, createCommand, normalizeRegistration } from "../runtime/shared/protocol.mjs";

async function withStore(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "pixel-brightness-server-store-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("server state rejects an unsupported schema instead of silently resetting the project", async () => {
  await withStore(async (directory) => {
    const statePath = path.join(directory, "state.json");
    const original = `${JSON.stringify({ schemaVersion: 99, project: { id: "do-not-overwrite" } })}\n`;
    await writeFile(statePath, original, "utf8");

    const store = new PersistentStore(directory);
    await assert.rejects(store.init(), (error) => {
      assert.equal(error.code, "SERVER_STATE_RECOVERY_FAILED");
      assert.match(error.message, /schema 99 is unsupported/);
      return true;
    });
    assert.equal(await readFile(statePath, "utf8"), original);
  });
});

test("server state restores the last-known-good file and quarantines a damaged primary", async () => {
  await withStore(async (directory) => {
    const first = new PersistentStore(directory);
    await first.init();
    await first.transaction((state) => {
      state.project.name = "durable revision one";
      state.project.revision += 1;
    });
    await first.transaction((state) => {
      state.project.name = "durable revision two";
      state.project.revision += 1;
    });

    const backup = JSON.parse(await readFile(path.join(directory, "state.last-known-good.json"), "utf8"));
    assert.equal(backup.project.name, "durable revision one");
    await writeFile(path.join(directory, "state.json"), "{ damaged", "utf8");

    const recovered = new PersistentStore(directory);
    await recovered.init();
    assert.equal(recovered.state.project.name, "durable revision one");
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")).project.name,
      "durable revision one",
    );
    const entries = await readdir(directory);
    assert.ok(entries.some((entry) => entry.startsWith("state.json.invalid-")));
  });
});

test("server state restores LKG when the primary is missing in the quarantine crash window", async () => {
  await withStore(async (directory) => {
    const first = new PersistentStore(directory);
    await first.init();
    await first.transaction((state) => {
      state.project.name = "durable state retained in LKG";
      state.project.revision += 1;
    });
    await first.transaction((state) => {
      state.project.name = "newer primary removed by simulated crash";
      state.project.revision += 1;
    });
    await rm(path.join(directory, "state.json"));

    const recovered = new PersistentStore(directory);
    await recovered.init();
    assert.equal(recovered.state.project.name, "durable state retained in LKG");
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")).project.name,
      "durable state retained in LKG",
    );
  });
});

test("server state initializes defaults only when both primary and LKG are absent", async () => {
  await withStore(async (directory) => {
    const store = new PersistentStore(directory);
    await store.init();
    assert.equal(store.state.project.name, "Pixel Brightness Room");
    assert.equal(store.state.project.revision, 1);
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")).project.name,
      "Pixel Brightness Room",
    );
  });
});

test("server state fails closed when a missing primary has an invalid LKG", async () => {
  await withStore(async (directory) => {
    await writeFile(path.join(directory, "state.last-known-good.json"), "{ invalid", "utf8");
    const store = new PersistentStore(directory);
    await assert.rejects(store.init(), (error) => {
      assert.equal(error.code, "SERVER_STATE_RECOVERY_FAILED");
      assert.match(error.message, /primary state is missing/i);
      return true;
    });
  });
});

test("server state rejects valid JSON with a malformed nested command queue and restores LKG", async () => {
  await withStore(async (directory) => {
    const first = new PersistentStore(directory);
    await first.init();
    await first.transaction((state) => {
      state.project.name = "valid primary before nested corruption";
      state.project.revision += 1;
    });

    const statePath = path.join(directory, "state.json");
    const malformed = JSON.parse(await readFile(statePath, "utf8"));
    malformed.commandQueues = { forged_node: {} };
    await writeFile(statePath, `${JSON.stringify(malformed)}\n`, "utf8");

    const recovered = new PersistentStore(directory);
    await recovered.init();
    assert.equal(recovered.state.project.name, "Pixel Brightness Room");
    assert.deepEqual(recovered.state.commandQueues, {});
    assert.ok((await readdir(directory)).some((entry) => entry.startsWith("state.json.invalid-")));
  });
});

test("server state restores LKG instead of repairing a malformed authoritative project", async () => {
  await withStore(async (directory) => {
    const first = new PersistentStore(directory);
    await first.init();
    await first.transaction((state) => {
      state.project.name = "valid project before canonical corruption";
      state.project.revision += 1;
    });

    const statePath = path.join(directory, "state.json");
    const malformed = JSON.parse(await readFile(statePath, "utf8"));
    malformed.project = {};
    await writeFile(statePath, `${JSON.stringify(malformed)}\n`, "utf8");

    const recovered = new PersistentStore(directory);
    await recovered.init();
    assert.equal(recovered.state.project.name, "Pixel Brightness Room");
    assert.equal(recovered.state.project.revision, 1);
    assert.ok((await readdir(directory)).some((entry) => entry.startsWith("state.json.invalid-")));
  });
});

test("server state rejects forged timeline authority instead of repairing it", async (t) => {
  const corruptions = [
    {
      name: "idle changed to scheduled without PREPARE authority",
      apply(state) {
        state.timeline.status = "scheduled";
        state.timeline.playAtNs = "1";
      },
    },
    {
      name: "persisted frame rate differs from the authoritative project",
      apply(state) {
        state.timeline.frameRateNum += 1;
      },
    },
    {
      name: "idle retains an invented target and prepare lease",
      apply(state) {
        state.timeline.targetNodeIds = ["forged-node"];
        state.timeline.prepareSequences = { "forged-node": 1 };
      },
    },
  ];

  for (const scenario of corruptions) {
    await t.test(scenario.name, async () => {
      await withStore(async (directory) => {
        const first = new PersistentStore(directory);
        await first.init();
        await first.transaction((state) => {
          state.project.name = "valid timeline LKG";
          state.project.revision += 1;
        });
        const statePath = path.join(directory, "state.json");
        const malformed = JSON.parse(await readFile(statePath, "utf8"));
        scenario.apply(malformed);
        await writeFile(statePath, `${JSON.stringify(malformed)}\n`, "utf8");

        const recovered = new PersistentStore(directory);
        await recovered.init();
        assert.equal(recovered.state.timeline.status, "idle");
        assert.equal(recovered.state.project.name, "Pixel Brightness Room");
        assert.ok((await readdir(directory)).some((entry) => entry.startsWith("state.json.invalid-")));
      });
    });
  }
});

test("server state restores LKG when node command cursors cannot describe the durable queue", async (t) => {
  const corruptions = [
    {
      name: "acknowledgement exceeds command cursor",
      apply(state) {
        state.nodes.node_one.ackSequence = 2;
      },
    },
    {
      name: "command cursor reaches the next global sequence",
      apply(state) {
        state.nodes.node_one.commandSequence = 2;
      },
    },
    {
      name: "queued command is already acknowledged",
      apply(state) {
        state.nodes.node_one.ackSequence = 1;
      },
    },
    {
      name: "queued command exceeds the node command cursor",
      apply(state) {
        state.nodes.node_one.commandSequence = 0;
      },
    },
    {
      name: "cursor encoded as a string is not canonical",
      apply(state) {
        state.nodes.node_one.ackSequence = "0";
      },
    },
  ];

  for (const scenario of corruptions) {
    await t.test(scenario.name, async () => {
      await withStore(async (directory) => {
        const first = new PersistentStore(directory);
        await first.init();
        await first.transaction((state) => {
          const registration = normalizeRegistration({
            protocolVersion: 1,
            nodeId: "node_one",
            capabilities: { outputs: [] },
          });
          state.nodes.node_one = {
            ...registration,
            ackSequence: 0,
            commandSequence: 1,
            requiresResync: false,
          };
          const nodeProject = {
            ...state.project,
            outputs: [],
            timeline: { ...state.project.timeline, cues: [] },
          };
          state.commandQueues.node_one = [createCommand(COMMAND.SYNC_PROJECT, {
            project: nodeProject,
            revision: state.project.revision,
          }, {
            id: "cmd_cursor_fixture",
            sequence: 1,
            createdAtNs: "1",
          })];
          state.nextCommandSequence = 2;
        });

        const statePath = path.join(directory, "state.json");
        const malformed = JSON.parse(await readFile(statePath, "utf8"));
        scenario.apply(malformed);
        await writeFile(statePath, `${JSON.stringify(malformed)}\n`, "utf8");

        const recovered = new PersistentStore(directory);
        await recovered.init();
        assert.deepEqual(recovered.state.nodes, {});
        assert.deepEqual(recovered.state.commandQueues, {});
        assert.equal(recovered.state.nextCommandSequence, 1);
        assert.ok((await readdir(directory)).some((entry) => entry.startsWith("state.json.invalid-")));
      });
    });
  }
});

test("legacy command-history gaps are recovered from LKG instead of advancing a discontinuous cursor", async () => {
  await withStore(async (directory) => {
    const first = new PersistentStore(directory);
    await first.init();
    await first.transaction((state) => {
      state.project.name = "valid state before legacy gap";
      state.project.revision += 1;
    });
    const statePath = path.join(directory, "state.json");
    const malformed = JSON.parse(await readFile(statePath, "utf8"));
    malformed.nodes.legacy_node = {
      ...normalizeRegistration({
        protocolVersion: 1,
        nodeId: "legacy_node",
        capabilities: { outputs: [] },
      }),
      ackSequence: 0,
      commandSequence: 0,
      requiresResync: true,
    };
    malformed.commandQueues.legacy_node = [];
    await writeFile(statePath, `${JSON.stringify(malformed)}\n`, "utf8");

    const recovered = new PersistentStore(directory);
    await recovered.init();
    assert.deepEqual(recovered.state.nodes, {});
    assert.deepEqual(recovered.state.commandQueues, {});
    assert.ok((await readdir(directory)).some((entry) => entry.startsWith("state.json.invalid-")));
  });
});

test("server state rejects canonical-looking forged queued timeline commands and restores LKG", async (t) => {
  const corruptions = [
    {
      name: "PLAY base frame differs from Server timeline authority",
      apply(command) { command.payload.baseFrame = String(BigInt(command.payload.baseFrame) + 1n); },
    },
    {
      name: "PLAY effective instant differs from Server timeline authority",
      apply(command) { command.effectiveAtNs = String(BigInt(command.effectiveAtNs) + 1n); },
    },
    {
      name: "PLAY carries an unvalidated payload field",
      apply(command) { command.payload.forged = true; },
    },
  ];

  for (const scenario of corruptions) {
    await t.test(scenario.name, async () => {
      await withStore(async (directory) => {
        let server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
        const registration = await server.control.register({
          protocolVersion: 1,
          nodeId: "timeline-node",
          capabilities: { outputs: [] },
        });
        await server.control.heartbeat("timeline-node", { ackSequence: registration.commandSequence });
        await server.control.prepare({ nodeIds: ["timeline-node"], baseFrame: "12" });
        await server.control.play({ nodeIds: ["timeline-node"], baseFrame: "12", delayMs: 500 });
        await server.close();

        const statePath = path.join(directory, "state.json");
        const malformed = JSON.parse(await readFile(statePath, "utf8"));
        const play = malformed.commandQueues["timeline-node"].find((command) => command.type === COMMAND.PLAY_AT);
        assert.ok(play, "fixture must retain the scheduled PLAY command");
        scenario.apply(play);
        await writeFile(statePath, `${JSON.stringify(malformed)}\n`, "utf8");

        server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
        assert.equal(server.store.state.timeline.status, "prepared", "corrupt scheduled primary must recover PREPARE LKG");
        assert.equal(server.store.state.timeline.baseFrame, "12");
        assert.ok((await readdir(directory)).some((entry) => entry.startsWith("state.json.invalid-")));
        await server.close();
      });
    });
  }
});

test("server state rejects a canonical but unscoped pending SYNC project and restores LKG", async () => {
  await withStore(async (directory) => {
    let server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
    await server.control.register({
      protocolVersion: 1,
      nodeId: "sync-node",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    await server.store.transaction((state) => {
      state.nodes["sync-node"].lastSeenAt = "2099-01-01T00:00:00.000Z";
    });
    await server.close();

    const statePath = path.join(directory, "state.json");
    const malformed = JSON.parse(await readFile(statePath, "utf8"));
    const sync = malformed.commandQueues["sync-node"].find((command) => command.type === COMMAND.SYNC_PROJECT);
    sync.payload.project.name = "forged but canonical scoped snapshot";
    await writeFile(statePath, `${JSON.stringify(malformed)}\n`, "utf8");

    server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
    assert.equal(server.store.state.commandQueues["sync-node"][0].payload.project.name, "Pixel Brightness Room");
    assert.ok((await readdir(directory)).some((entry) => entry.startsWith("state.json.invalid-")));
    await server.close();
  });
});

test("server state rotates only a fully flushed prior primary into the backup", async () => {
  await withStore(async (directory) => {
    const store = new PersistentStore(directory);
    await store.init();
    await store.transaction((state) => {
      state.project.name = "first committed";
      state.project.revision += 1;
    });
    const firstPrimary = await readFile(path.join(directory, "state.json"), "utf8");
    await store.transaction((state) => {
      state.project.name = "second committed";
      state.project.revision += 1;
    });
    assert.equal(await readFile(path.join(directory, "state.last-known-good.json"), "utf8"), firstPrimary);
  });
});

test("LKG rollback raises a durable Server recovery lock and never mints execution authority", async () => {
  await withStore(async (directory) => {
    let server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
    const registration = await server.control.register({
      protocolVersion: 1,
      nodeId: "recovery-fence-node",
      capabilities: { outputs: [] },
    });
    await server.control.heartbeat("recovery-fence-node", {
      ackSequence: registration.commandSequence,
      status: "ready",
    });
    await server.control.prepare({ nodeIds: ["recovery-fence-node"], baseFrame: "0" });
    const prepareSequence = server.store.state.timeline.prepareSequences["recovery-fence-node"];
    await server.control.heartbeat("recovery-fence-node", { ackSequence: prepareSequence });
    await server.control.play({ nodeIds: ["recovery-fence-node"], baseFrame: "0", delayMs: 10_000 });
    const command = server.store.state.commandQueues["recovery-fence-node"]
      .find((candidate) => candidate.type === COMMAND.PLAY_AT);
    const failedAt = new Date().toISOString();
    await server.control.heartbeat("recovery-fence-node", {
      commandDeadLetters: [{
        schemaVersion: 1,
        deadLetterId: "command_dead_letter_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        nodeId: "recovery-fence-node",
        command: { id: command.id, sequence: command.sequence, type: command.type },
        attempts: 2,
        retryBudget: 2,
        safetyCritical: true,
        firstFailedAt: failedAt,
        lastFailedAt: failedAt,
        deadLetteredAt: failedAt,
        errors: [
          { attempt: 2, failedAt, name: "Error", code: "POISON", message: "fixture poison" },
        ],
        failClosed: { active: true, blackApplied: true, enforcementError: null },
      }],
    });
    assert.equal(server.store.state.nodes["recovery-fence-node"].failClosedFence.status, "active");
    await server.close();

    await writeFile(path.join(directory, "state.json"), "{corrupt-primary", "utf8");
    server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
    const marker = server.store.recoverySnapshot();
    assert.equal(marker.status, "active");
    assert.equal(marker.generation, 1);
    assert.equal(marker.reason, "primary-invalid-lkg-rollback");
    const recoveredRegistration = await server.control.register({
      protocolVersion: 1,
      nodeId: "recovery-fence-node",
      capabilities: { outputs: [] },
    });
    assert.deepEqual(recoveredRegistration.serverStateRecovery, marker);
    assert.equal(recoveredRegistration.executionLease, null);
    const poll = await server.control.pollCommands("recovery-fence-node", 0, 0);
    assert.deepEqual(poll.commands, []);
    assert.equal(poll.executionLease, null);
    assert.deepEqual(poll.serverStateRecovery, marker);
    assert.equal(server.control.nodeReadiness("recovery-fence-node").ready, false);
    assert.ok(server.control.nodeReadiness("recovery-fence-node").faults.some((fault) => (
      fault.code === "SERVER_STATE_RECOVERY_REQUIRED"
    )));
    await server.close();

    server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
    assert.deepEqual(server.store.recoverySnapshot(), marker,
      "the independent recovery sidecar must survive another clean restart");
    await server.close();

    await rm(path.join(directory, "state.recovery-lock.json"));
    server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
    assert.deepEqual(server.store.recoverySnapshot(), marker,
      "the primary recovery marker must reconstruct a missing monotonic sidecar without unlocking");
    assert.equal((await readFile(path.join(directory, "state.recovery-lock.json"), "utf8")).includes(
      marker.recoveryId,
    ), true);
    await server.close();
  });
});
