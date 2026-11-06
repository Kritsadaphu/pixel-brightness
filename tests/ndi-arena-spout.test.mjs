import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

test("NDI show guidance preserves the Arena-to-local-Spout boundary", async () => {
  const [guide, acceptance] = await Promise.all([
    readFile(new URL("docs/windows/ndi-arena-spout.md", projectRoot), "utf8"),
    readFile(new URL("deploy/windows/Test-PixelBrightness.ps1", projectRoot), "utf8"),
  ]);

  assert.match(guide, /exact NDI sender[\s\S]{0,220}Resolume Arena[\s\S]{0,220}PB-COMPOSITION \(Spout\)/);
  assert.match(guide, /Direct NDI input to Pixel Brightness is unsupported/);
  assert.match(guide, /## Supported one-PC and two-PC topologies/);
  assert.match(guide, /Spout cannot cross PCs/);
  assert.match(guide, /dedicated wired show network/);
  assert.match(guide, /1 Gbps LAN as a baseline/);
  assert.match(guide, /Studio Monitor[\s\S]{0,500}exact\s+recorded source/);
  assert.match(guide, /authoritative only from the local[\s\S]{0,100}`PB-COMPOSITION` handoff onward/);
  assert.match(guide, /Never[\s\S]{0,100}“NDI ready.”/);
  assert.match(guide, /NDI fails but Arena continues publishing[\s\S]{0,300}cannot\s+distinguish/);
  assert.match(acceptance, /compositionSource\.state -ne 'connected'/);
  assert.match(acceptance, /Spout receivedFrames did not advance/);
  assert.doesNotMatch(acceptance, /NDI ready/i,
    "Windows acceptance must not claim visibility into Arena's upstream NDI receiver");
});
