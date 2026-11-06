import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { controlServerPort } from "../app/lib/server-port.mjs";

const projectRoot = new URL("../", import.meta.url);

test("Pixel Server URL keeps the server render and first hydration snapshot identical", async () => {
  const [hook, client] = await Promise.all([
    readFile(new URL("app/hooks/use-pixel-server.ts", projectRoot), "utf8"),
    readFile(new URL("app/lib/pixel-server.ts", projectRoot), "utf8"),
  ]);

  assert.match(
    hook,
    /const subscribeStaticBrowserLocation = \(\) => \(\) => undefined;/,
    "the browser-location store must be inert because navigation cannot change this endpoint",
  );
  assert.match(
    hook,
    /const baseUrl = useSyncExternalStore\(subscribeStaticBrowserLocation, pixelServerUrl, initialPixelServerUrl\);/,
    "SSR and the first hydration pass must use initialPixelServerUrl before React reads window.location",
  );
  assert.doesNotMatch(
    hook,
    /useMemo\(\(\) => pixelServerUrl\(\), \[\]\)/,
    "render-time window.location must not choose different SSR and client markup",
  );

  const initialSnapshot = client.match(/export function initialPixelServerUrl\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.ok(initialSnapshot, "initialPixelServerUrl must remain an explicit server snapshot");
  assert.doesNotMatch(initialSnapshot, /\bwindow\b|location\./, "the server snapshot must be browser-independent");
  assert.doesNotMatch(client, /NEXT_PUBLIC_PIXEL_SERVER_URL/,
    "the public build must never bake a controller-specific loopback or stale endpoint");
  assert.match(initialSnapshot, /`http:\/\/localhost:\$\{pixelServerPort\}`/);
  assert.match(client, /typeof __PIXEL_SERVER_PORT__ === "number" \? __PIXEL_SERVER_PORT__ : 4100/);

  assert.match(
    client,
    /return `\$\{window\.location\.protocol\}\/\/\$\{window\.location\.hostname\}:\$\{pixelServerPort\}`;/,
    "the post-hydration snapshot must still select the controller host for remote browsers",
  );
});

test("preview API port is build-time, bounded and cannot contain a host or URL", () => {
  assert.equal(controlServerPort(), 4100); assert.equal(controlServerPort('4101'), 4101);
  for (const bad of ['http://evil:4100', '4100/path', '0', '65536', '1.5']) assert.throws(() => controlServerPort(bad));
});
