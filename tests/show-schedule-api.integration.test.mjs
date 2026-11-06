import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPixelBrightnessServer } from "../runtime/server/server.mjs";
import { SHOW_SCHEDULE_DAYS, defaultShowSchedule } from "../runtime/server/show-schedule.mjs";

const token = "show-schedule-control-token-long-enough-for-tests";

function schedule() {
  return {
    ...defaultShowSchedule(),
    enabled: true,
    nodeId: "render-01",
    arenaExecutablePath: "C:\\Program Files\\Resolume Arena\\Arena.exe",
    arenaCompositionPath: "C:\\Shows\\Main.avc",
    days: SHOW_SCHEDULE_DAYS.map((day, index) => ({
      day,
      enabled: index < 5,
      startTime: "08:30",
      shutdownTime: "21:30",
    })),
  };
}

async function request(baseUrl, pathname, { method = "GET", body, authorized = true, ifMatch } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(authorized ? { authorization: `Bearer ${token}` } : {}),
      ...(body == null ? {} : { "content-type": "application/json" }),
      ...(ifMatch == null ? {} : { "if-match": String(ifMatch) }),
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
}

test("authenticated weekly schedule API persists and appears in compact server state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-show-schedule-api-"));
  const server = await createPixelBrightnessServer({ dataDir, controlToken: token });
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;

    assert.equal((await request(baseUrl, "/v1/show-schedule", { authorized: false })).response.status, 401);
    assert.equal((await request(baseUrl, "/v1/show-schedule", {
      method: "PUT", body: schedule(), authorized: false, ifMatch: 0,
    })).response.status, 401);
    assert.equal((await request(baseUrl, "/v1/show-schedule", {
      method: "PUT", body: schedule(),
    })).response.status, 428);
    const saved = await request(baseUrl, "/v1/show-schedule", { method: "PUT", body: schedule(), ifMatch: 0 });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.revision, 1);
    assert.equal(saved.payload.enabled, true);
    assert.equal(saved.payload.days.length, 7);

    const loaded = await request(baseUrl, "/v1/show-schedule");
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.payload.nodeId, "render-01");

    const state = await request(baseUrl, "/v1/state?includeProject=0");
    assert.equal(state.payload.showSchedule.arenaCompositionPath, "C:\\Shows\\Main.avc");

    const responseOnly = await request(baseUrl, "/v1/show-schedule", {
      method: "PUT",
      body: { ...schedule(), nextEvent: null },
      ifMatch: 1,
    });
    assert.equal(responseOnly.response.status, 400);
    assert.equal(responseOnly.payload.error.code, "invalid_show_schedule");

    const stale = await request(baseUrl, "/v1/show-schedule", {
      method: "PUT", body: schedule(), ifMatch: 0,
    });
    assert.equal(stale.response.status, 412);
    assert.equal(stale.payload.error.code, "show_schedule_revision_mismatch");

    const preflight = await fetch(`${baseUrl}/v1/show-schedule`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "PUT" },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /PUT/);
  } finally {
    await server.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
