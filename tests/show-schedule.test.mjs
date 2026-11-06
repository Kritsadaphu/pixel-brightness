import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SHOW_SCHEDULE_DAYS,
  ShowScheduleControl,
  ShowScheduleError,
  defaultShowSchedule,
  normalizeShowSchedule,
} from "../runtime/server/show-schedule.mjs";

function configuredSchedule(overrides = {}) {
  return {
    ...defaultShowSchedule(),
    enabled: true,
    nodeId: "render-01",
    arenaExecutablePath: "C:\\Program Files\\Resolume Arena\\Arena.exe",
    arenaCompositionPath: "C:\\Shows\\Customer Main.avc",
    days: SHOW_SCHEDULE_DAYS.map((day, index) => ({
      day,
      enabled: index < 6,
      startTime: "09:00",
      shutdownTime: "20:00",
    })),
    ...overrides,
  };
}

test("show schedule defaults disabled and normalizes one complete weekly plan", () => {
  const defaults = defaultShowSchedule();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.days.length, 7);
  assert.deepEqual(defaults.days.map((row) => row.day), SHOW_SCHEDULE_DAYS);

  const schedule = normalizeShowSchedule(configuredSchedule());
  assert.equal(schedule.nodeId, "render-01");
  assert.equal(schedule.days[5].enabled, true);
  assert.equal(schedule.days[6].enabled, false);
  assert.equal(schedule.projectorStaggerMs, 1_000);
});

test("show schedule rejects ambiguous days, times, paths and response-only fields", () => {
  const invalidInputs = [
    { value: { ...configuredSchedule(), schemaVersion: 2 }, pattern: /schemaVersion/ },
    { value: { ...configuredSchedule(), updatedAt: new Date().toISOString() }, pattern: /unsupported fields/ },
    { value: { ...configuredSchedule(), nodeId: "bad node" }, pattern: /nodeId/ },
    { value: { ...configuredSchedule(), arenaExecutablePath: "Arena.exe" }, pattern: /absolute Windows/ },
    { value: { ...configuredSchedule(), arenaExecutablePath: "C:\\Arena.cmd" }, pattern: /\.exe/ },
    { value: { ...configuredSchedule(), arenaCompositionPath: "C:\\Shows\\main.txt" }, pattern: /\.avc/ },
    { value: { ...configuredSchedule(), projectorStaggerMs: 2_001 }, pattern: /0 to 2000/ },
    { value: { ...configuredSchedule(), projectorWarmupSeconds: -1 }, pattern: /0 to 600/ },
    { value: { ...configuredSchedule(), days: configuredSchedule().days.slice(0, 6) }, pattern: /seven rows/ },
    {
      value: {
        ...configuredSchedule(),
        days: configuredSchedule().days.map((row, index) => (
          index === 0 ? { ...row, day: "tuesday" } : row
        )),
      },
      pattern: /canonical order/,
    },
    {
      value: {
        ...configuredSchedule(),
        days: configuredSchedule().days.map((row, index) => (
          index === 0 ? { ...row, startTime: "9:00" } : row
        )),
      },
      pattern: /HH:MM/,
    },
    {
      value: {
        ...configuredSchedule(),
        days: configuredSchedule().days.map((row, index) => (
          index === 0 ? { ...row, startTime: "20:00", shutdownTime: "09:00" } : row
        )),
      },
      pattern: /start before shutdown/,
    },
    {
      value: { ...configuredSchedule(), days: configuredSchedule().days.map((row) => ({ ...row, enabled: false })) },
      pattern: /at least one enabled weekday/,
    },
  ];
  for (const entry of invalidInputs) {
    assert.throws(
      () => normalizeShowSchedule(entry.value),
      (error) => error instanceof ShowScheduleError && entry.pattern.test(error.message),
    );
  }
});

test("show schedule persists and calculates the next local weekly event", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-show-schedule-"));
  let now = new Date(2026, 8, 7, 8, 30, 0, 0); // Monday in the machine's local timezone.
  try {
    const control = new ShowScheduleControl({ dataDir, clock: () => new Date(now) });
    await control.init();
    assert.equal((await control.snapshot()).nextEvent, null);
    const saved = await control.configure(configuredSchedule(), { ifMatchRevision: 0 });
    assert.equal(saved.revision, 1);
    assert.equal(saved.nextEvent.type, "start");
    assert.equal(saved.nextEvent.day, "monday");
    assert.equal(saved.nextEvent.localTime, "09:00");

    now = new Date(2026, 8, 7, 10, 0, 0, 0);
    const shutdown = await control.snapshot();
    assert.equal(shutdown.nextEvent.type, "shutdown");
    assert.equal(shutdown.nextEvent.localTime, "20:00");

    now = new Date(2026, 8, 7, 21, 0, 0, 0);
    const nextDay = await control.snapshot();
    assert.equal(nextDay.nextEvent.day, "tuesday");
    assert.equal(nextDay.nextEvent.type, "start");

    const restored = new ShowScheduleControl({ dataDir, clock: () => new Date(now) });
    await restored.init();
    assert.equal((await restored.snapshot()).arenaCompositionPath, "C:\\Shows\\Customer Main.avc");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("show schedule exposes only a bounded, valid Windows worker runtime snapshot", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-show-runtime-"));
  try {
    const control = new ShowScheduleControl({ dataDir });
    await control.init();
    const now = new Date().toISOString();
    const validRuntime = {
      schemaVersion: 1,
      state: "running",
      phase: "ready",
      localDate: "2026-09-07",
      lastAction: {
        type: "start",
        scheduleDate: "2026-09-07",
        status: "succeeded",
        startedAt: now,
        completedAt: now,
        message: "Show ready",
        secret: "must-not-escape",
      },
      arenaProcessId: 4321,
      updatedAt: now,
      scheduleUpdatedAt: null,
      dailyLedger: {
        scheduleDate: "2026-09-07",
        startStatus: "succeeded",
        shutdownStatus: "not-attempted",
      },
      activeRun: {
        scheduleDate: "2026-09-07",
        shutdownTime: "20:00",
        nodeId: "render-01",
        scheduleRevision: 1,
        scheduleUpdatedAt: now,
        arenaExecutablePath: "C:\\Program Files\\Resolume Arena\\Arena.exe",
        arenaCompositionPath: "C:\\Shows\\Customer Main.avc",
        projectorStartupEnabled: true,
        projectorStandbyEnabled: true,
        projectorStaggerMs: 1_000,
        projectorWarmupSeconds: 60,
        projectorConfigurationRevision: 1,
        projectorIds: ["p1", "p2", "p3", "p4", "p5"],
        startupStage: "ready",
        shutdownStage: "pending",
        runBootId: now,
        arenaProcessId: 4321,
        arenaProcessStartTimeUtc: now,
      },
      workerMessage: null,
      token: "must-not-escape",
    };
    await writeFile(join(dataDir, "show-schedule-runtime.json"), JSON.stringify(validRuntime));
    const snapshot = await control.snapshot();
    assert.equal(snapshot.runtime.state, "running");
    assert.equal(snapshot.runtime.arenaProcessId, 4321);
    assert.equal(snapshot.runtime.activeRun.projectorConfigurationRevision, 1);
    assert.equal(JSON.stringify(snapshot.runtime).includes("must-not-escape"), false);

    const missingProjectorRevision = structuredClone(validRuntime);
    delete missingProjectorRevision.activeRun.projectorConfigurationRevision;
    await writeFile(join(dataDir, "show-schedule-runtime.json"), JSON.stringify(missingProjectorRevision));
    assert.equal((await control.snapshot()).runtime, null,
      "an active projector run without a pinned IP-binding revision must fail closed");

    const zeroProjectorRevision = structuredClone(validRuntime);
    zeroProjectorRevision.activeRun.projectorConfigurationRevision = 0;
    await writeFile(join(dataDir, "show-schedule-runtime.json"), JSON.stringify(zeroProjectorRevision));
    assert.equal((await control.snapshot()).runtime, null,
      "an active projector run cannot use the unconfigured revision");

    const projectorsDisabled = structuredClone(validRuntime);
    projectorsDisabled.activeRun.projectorStartupEnabled = false;
    projectorsDisabled.activeRun.projectorStandbyEnabled = false;
    projectorsDisabled.activeRun.projectorConfigurationRevision = 0;
    projectorsDisabled.activeRun.projectorIds = [];
    await writeFile(join(dataDir, "show-schedule-runtime.json"), JSON.stringify(projectorsDisabled));
    assert.equal((await control.snapshot()).runtime.activeRun.projectorConfigurationRevision, 0,
      "revision zero is valid only when scheduled projector control is disabled");

    const contradictoryCheckpoint = structuredClone(validRuntime);
    contradictoryCheckpoint.activeRun.shutdownStage = "arena-closed";
    await writeFile(join(dataDir, "show-schedule-runtime.json"), JSON.stringify(contradictoryCheckpoint));
    assert.equal((await control.snapshot()).runtime, null,
      "a checkpoint that skips Arena close while retaining its PID must fail closed");

    const misplacedBootIdentity = structuredClone(validRuntime);
    misplacedBootIdentity.activeRun.shutdownRequestBootId = now;
    await writeFile(join(dataDir, "show-schedule-runtime.json"), JSON.stringify(misplacedBootIdentity));
    assert.equal((await control.snapshot()).runtime, null,
      "a shutdown boot identity is valid only at the shutdown-requested checkpoint");

    await writeFile(join(dataDir, "show-schedule-runtime.json"), "{partial");
    assert.equal((await control.snapshot()).runtime, null);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("show schedule revisions reject stale writers and mid-window saves wait for the next active day", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-show-revision-"));
  let now = new Date(2026, 8, 7, 10, 0, 0, 0); // Monday, after the 09:00 boundary.
  try {
    const control = new ShowScheduleControl({ dataDir, clock: () => new Date(now) });
    await control.init();
    const saved = await control.configure(configuredSchedule(), { ifMatchRevision: 0 });
    assert.equal(saved.revision, 1);
    assert.equal(saved.nextEvent.day, "tuesday");
    assert.equal(saved.nextEvent.type, "start");
    await assert.rejects(
      control.configure(configuredSchedule({ nodeId: "render-02" }), { ifMatchRevision: 0 }),
      (error) => error instanceof ShowScheduleError
        && error.code === "show_schedule_revision_mismatch"
        && error.status === 412,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("show schedule next event prefers the active run's pinned shutdown", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-show-pinned-"));
  let now = new Date(2026, 8, 7, 10, 0, 0, 0);
  try {
    const control = new ShowScheduleControl({ dataDir, clock: () => new Date(now) });
    await control.init();
    await control.configure(configuredSchedule(), { ifMatchRevision: 0 });
    const timestamp = now.toISOString();
    await writeFile(join(dataDir, "show-schedule-runtime.json"), JSON.stringify({
      schemaVersion: 1,
      state: "running",
      phase: "ready",
      localDate: "2026-09-07",
      lastAction: null,
      dailyLedger: { scheduleDate: "2026-09-07", startStatus: "succeeded", shutdownStatus: "not-attempted" },
      activeRun: {
        scheduleDate: "2026-09-07",
        shutdownTime: "20:00",
        nodeId: "render-01",
        scheduleRevision: 1,
        scheduleUpdatedAt: timestamp,
        arenaExecutablePath: "C:\\Program Files\\Resolume Arena\\Arena.exe",
        arenaCompositionPath: "C:\\Shows\\Customer Main.avc",
        projectorStartupEnabled: true,
        projectorStandbyEnabled: true,
        projectorStaggerMs: 1_000,
        projectorWarmupSeconds: 60,
        projectorConfigurationRevision: 1,
        startupStage: "ready",
        shutdownStage: "pending",
        runBootId: timestamp,
        projectorIds: ["p1", "p2", "p3", "p4", "p5"],
        arenaProcessId: 4321,
        arenaProcessStartTimeUtc: timestamp,
      },
      arenaProcessId: 4321,
      workerMessage: null,
      updatedAt: timestamp,
      scheduleUpdatedAt: timestamp,
    }));
    const snapshot = await control.snapshot();
    assert.equal(snapshot.nextEvent.type, "shutdown");
    assert.equal(snapshot.nextEvent.localTime, "20:00");
    assert.equal(snapshot.nextEvent.pinned, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("show schedule next event does not advertise a same-day action already recorded by the worker", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-show-ledger-"));
  let now = new Date(2026, 8, 7, 8, 30, 0, 0); // Monday before start.
  try {
    const control = new ShowScheduleControl({ dataDir, clock: () => new Date(now) });
    await control.init();
    const saved = await control.configure(configuredSchedule(), { ifMatchRevision: 0 });
    now = new Date(2026, 8, 7, 10, 0, 0, 0);
    const timestamp = now.toISOString();
    await writeFile(join(dataDir, "show-schedule-runtime.json"), JSON.stringify({
      schemaVersion: 1,
      state: "error",
      phase: "failed",
      localDate: "2026-09-07",
      lastAction: {
        type: "start",
        scheduleDate: "2026-09-07",
        status: "failed",
        startedAt: timestamp,
        completedAt: timestamp,
        message: "Operator inspection required",
      },
      dailyLedger: { scheduleDate: "2026-09-07", startStatus: "failed", shutdownStatus: "not-attempted" },
      activeRun: null,
      arenaProcessId: null,
      workerMessage: "Operator inspection required",
      updatedAt: timestamp,
      scheduleUpdatedAt: saved.updatedAt,
    }));
    const snapshot = await control.snapshot();
    assert.equal(snapshot.nextEvent.day, "tuesday");
    assert.equal(snapshot.nextEvent.type, "start");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
