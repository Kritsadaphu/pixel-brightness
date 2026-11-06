import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);

test("native Spout input remains black until cadence validation completes", async () => {
  const [header, source] = await Promise.all([
    readFile(new URL("native/windows/include/pbwin/SpoutInput.hpp", projectRoot), "utf8"),
    readFile(new URL("native/windows/src/SpoutInput.cpp", projectRoot), "utf8"),
  ]);

  assert.match(header, /InputState \{[^}]*validating[^}]*connected/,
    "telemetry must distinguish cadence validation from a connected source");
  const settlingGuard = source.indexOf("if (validationFrames_ < kFrameRateSettlingFrames)");
  const settlingReturn = source.indexOf("return {};", settlingGuard);
  const connectedState = source.indexOf("status_.state = InputState::connected");
  const createView = source.indexOf("CreateShaderResourceView");
  assert.ok(settlingGuard >= 0, "a bounded cadence-settling gate is required");
  assert.ok(connectedState > settlingGuard, "connected must be unreachable before cadence settling");
  assert.ok(createView > settlingGuard, "the sender SRV must not be exposed during cadence settling");
  assert.ok(settlingReturn > settlingGuard && settlingReturn < createView,
    "validation must return an empty texture so the renderer outputs black");
  assert.match(source, /frameRateDelta > tolerance[\s\S]{0,700}validationFrames_ = 0;[\s\S]{0,180}return \{\};/,
    "a wrong-rate sender must reset proof and remain black before it can retry");
  assert.match(source, /validationTexture_\.Get\(\) != received[\s\S]{0,240}frameRateValidated = false/,
    "a replaced sender texture must not inherit cadence proof from its predecessor");
  assert.match(source, /case InputState::validating: return "validating"/);
});
