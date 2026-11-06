import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Web routes never fabricate renderer status or claim an unauthenticated config save", async () => {
  const [status, config] = await Promise.all([
    readFile(new URL("app/api/status/route.ts", root), "utf8"),
    readFile(new URL("app/api/config/route.ts", root), "utf8"),
  ]);

  assert.match(status, /PIXEL_SERVER_ROUTE_REQUIRED/);
  assert.match(status, /status:\s*410/);
  assert.doesNotMatch(status, /engine:\s*["']online["']/);
  assert.doesNotMatch(status, /connector:\s*["'](?:DP|HDMI)-/);

  assert.match(config, /PIXEL_SERVER_ROUTE_REQUIRED/);
  assert.match(config, /authenticated Pixel Server \/v1\/projects API/);
  assert.match(config, /status:\s*410/);
  assert.doesNotMatch(config, /saved:\s*true/);
  assert.doesNotMatch(config, /await request\.json/);
});
