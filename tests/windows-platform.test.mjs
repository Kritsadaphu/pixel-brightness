import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { loadNodeConfig } from "../runtime/node/config.mjs";
import { displayPlan, validateDisplayConfig } from "../runtime/node/display-config.mjs";
import { HostTelemetryCollector } from "../runtime/node/host-telemetry.mjs";
import { SafeCommandRunner } from "../runtime/node/safe-exec.mjs";
import {
  platformDefaults,
  windowsRendererPipeName,
} from "../runtime/node/platform-contract.mjs";
import {
  WINDOWS_RENDERER_MAX_MESSAGE_BYTES,
  WindowsRendererIpcClient,
  decodeWindowsRendererMessage,
  encodeWindowsRendererMessage,
  normalizeWindowsRendererConfig,
  rendererLaunchArgs,
} from "../runtime/node/windows-renderer-contract.mjs";
import {
  WindowsHostTelemetryAdapter,
  parseWindowsTelemetryJson,
} from "../runtime/node/windows-host-telemetry.mjs";

const compositionSource = {
  type: "spout",
  senderName: "PB-COMPOSITION",
  width: 5280,
  height: 1080,
  frameRateNum: 60,
  frameRateDen: 1,
  acceptedFormats: [
    "DXGI_FORMAT_R16G16B16A16_FLOAT",
    "DXGI_FORMAT_R8G8B8A8_UNORM",
    "DXGI_FORMAT_B8G8R8A8_UNORM",
  ],
  colorEncoding: "srgb",
  alphaMode: "ignore",
  timeoutMs: 500,
  startupGraceMs: 10000,
  onMissing: "black",
  onMismatch: "black",
  allowAutoSelect: false,
};

const ADAPTER_LUID = "00000000:00000001";

function output(id, number, x) {
  return {
    id,
    name: `Projector ${id}`,
    connector: `\\\\.\\DISPLAY${number}`,
    display: { gdiName: `\\\\.\\DISPLAY${number}` },
    enabled: true,
    resolution: { width: 1920, height: 1080, refreshNum: 60, refreshDen: 1 },
    sourceViewport: { x, y: 0, width: 1920, height: 1080 },
    overlap: { left: id === "A" ? 0 : 240, right: id === "B" ? 0 : 240, top: 0, bottom: 0 },
    warp: { columns: 2, rows: 2, points: null },
  };
}

test("Windows node defaults use ProgramData, DXGI and a stable renderer pipe", async () => {
  const env = {
    PROGRAMDATA: "D:\\ProgramData",
    PROGRAMFILES: "D:\\Program Files",
    PIXEL_BRIGHTNESS_NODE_ID: "Arena Node 01",
  };
  const config = await loadNodeConfig({ argv: [], env, cwd: "C:\\work", platform: "win32" });
  assert.equal(config.nodeId, "arena-node-01");
  assert.equal(config.dataDir, "D:\\ProgramData\\Pixel Brightness\\nodes\\arena-node-01");
  assert.equal(config.displayBackend, "dxgi");
  assert.equal(config.rendererBackend, "dxgi");
  assert.equal(config.nodeService, "PixelBrightnessNode");
  assert.equal(config.hostActionsDryRun, false);
  assert.equal(config.rendererPipe, "\\\\.\\pipe\\pixel-brightness-renderer-arena-node-01");
  assert.equal(config.rendererBootToken, null);
  assert.equal(config.renderer.bootTokenConfigured, false);
  assert.equal(config.renderer.command, "D:\\Program Files\\Pixel Brightness\\bin\\pixel-brightness-renderer.exe");
  assert.equal(config.canvas.width, 5280);
  assert.equal(config.compositionSource.senderName, "PB-COMPOSITION");
  assert.equal(config.compositionSource.width, config.canvas.width);
  assert.equal(config.outputs[0].display.gdiName, "\\\\.\\DISPLAY1");
  assert.equal(config.cameraBackend, "sony-sdk");
  assert.equal(config.cameraExpectedModel, "ILCE-7M4");
  assert.equal(config.cameraExpectedSerial, null);
  assert.equal(config.cameraExpectedLensModel, null);
  assert.equal(config.cameraExpectedLensSerial, null);
  assert.equal(config.cameraHelperCommand, null);
  assert.equal(config.cameraCaptureDir, "D:\\ProgramData\\Pixel Brightness\\nodes\\arena-node-01\\camera-captures");

  const defaults = platformDefaults({ platform: "win32", env, nodeId: "Arena Node 01" });
  assert.equal(defaults.rendererPipe, config.rendererPipe);
  assert.equal(windowsRendererPipeName("Arena Node 01"), config.rendererPipe);

  const authorized = await loadNodeConfig({
    argv: [],
    env: { ...env, PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN: "A".repeat(43) },
    cwd: "C:\\work",
    platform: "win32",
  });
  assert.equal(authorized.rendererBootToken, "A".repeat(43));
  assert.equal(authorized.renderer.bootTokenConfigured, true);
  await assert.rejects(loadNodeConfig({
    argv: [],
    env: { ...env, PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN: "persistent-or-short" },
    cwd: "C:\\work",
    platform: "win32",
  }), /43-128 base64url/);
});

test("Windows camera helper is explicit, absolute and process-isolated by configuration", async () => {
  const env = {
    PROGRAMDATA: "D:\\ProgramData",
    PROGRAMFILES: "D:\\Program Files",
    PIXEL_BRIGHTNESS_NODE_ID: "camera-node",
  };
  const config = await loadNodeConfig({
    platform: "win32",
    cwd: "C:\\work",
    env,
    argv: [
      "--camera-backend", "sony-sdk",
      "--camera-helper-command", "D:\\Program Files\\Pixel Brightness\\bin\\PixelBrightnessCamera.exe",
      "--camera-helper-timeout-ms", "45000",
    ],
  });
  assert.equal(config.cameraBackend, "sony-sdk");
  assert.equal(config.cameraHelperCommand, "D:\\Program Files\\Pixel Brightness\\bin\\PixelBrightnessCamera.exe");
  assert.equal(config.cameraHelperTimeoutMs, 45_000);
  await assert.rejects(loadNodeConfig({
    platform: "win32",
    cwd: "C:\\work",
    env,
    argv: ["--camera-backend", "webcam"],
  }), /Invalid camera backend/);
});

test("Windows Canon helper defaults to the exact EOS R50 and RF-S 10-18 binding", async () => {
  const env = {
    PROGRAMDATA: "D:\\ProgramData",
    PROGRAMFILES: "D:\\Program Files",
    PIXEL_BRIGHTNESS_NODE_ID: "canon-node",
  };
  const config = await loadNodeConfig({
    platform: "win32",
    cwd: "C:\\work",
    env,
    argv: [
      "--camera-backend", "canon-edsdk",
      "--camera-helper-command", "D:\\Program Files\\Pixel Brightness\\bin\\PixelBrightnessCanonCamera.exe",
      "--camera-expected-serial", "R50-000123",
      "--camera-expected-lens-serial", "RFS1018-000456",
      "--camera-expected-focal-length-mm", "10",
      "--camera-runtime-manifest", "D:\\Program Files\\Pixel Brightness\\camera-runtimes\\canon\\runtime-manifest.json",
    ],
  });
  assert.equal(config.cameraBackend, "canon-edsdk");
  assert.equal(config.cameraExpectedModel, "EOS R50");
  assert.equal(config.cameraExpectedSerial, "R50-000123");
  assert.equal(config.cameraExpectedLensModel, "RF-S10-18mm F4.5-6.3 IS STM");
  assert.equal(config.cameraExpectedLensSerial, "RFS1018-000456");
  assert.equal(config.cameraExpectedFocalLengthMm, 10);
  assert.equal(
    config.cameraRuntimeManifestPath,
    "D:\\Program Files\\Pixel Brightness\\camera-runtimes\\canon\\runtime-manifest.json",
  );

  await assert.rejects(loadNodeConfig({
    platform: "win32",
    cwd: "C:\\work",
    env,
    argv: [
      "--camera-backend", "canon-edsdk",
      "--camera-helper-command", "D:\\Program Files\\Pixel Brightness\\bin\\PixelBrightnessCanonCamera.exe",
    ],
  }), /requires cameraRuntimeManifestPath and cameraExpectedFocalLengthMm/);
  await assert.rejects(loadNodeConfig({
    platform: "win32",
    cwd: "C:\\work",
    env,
    argv: [
      "--camera-backend", "canon-edsdk",
      "--camera-helper-command", "D:\\Program Files\\Pixel Brightness\\bin\\PixelBrightnessCanonCamera.exe",
      "--camera-expected-focal-length-mm", "10",
      "--camera-runtime-manifest", "camera-runtimes\\canon\\runtime-manifest.json",
    ],
  }), /cameraRuntimeManifestPath must be an absolute platform path/);

  await assert.rejects(loadNodeConfig({
    platform: "win32",
    cwd: "C:\\work",
    env,
    argv: ["--camera-backend", "canon-edsdk", "--camera-expected-model", "EOS R7"],
  }), /supports exact camera model EOS R50/);
  await assert.rejects(loadNodeConfig({
    platform: "win32",
    cwd: "C:\\work",
    env,
    argv: ["--camera-backend", "canon-edsdk", "--camera-expected-serial", "R50\nBAD"],
  }), /cameraExpectedSerial is invalid/);
});

test("Windows node derives one bound renderer adapter and rejects split or mismatched GPUs", async () => {
  const baseEnv = {
    PROGRAMDATA: "D:\\ProgramData",
    PROGRAMFILES: "D:\\Program Files",
    PIXEL_BRIGHTNESS_NODE_ID: "node-01",
  };
  const boundOutputs = [
    { ...output("A", 1, 0), display: { gdiName: "\\\\.\\DISPLAY1", adapterLuid: ADAPTER_LUID.toLowerCase(), targetId: 11 } },
    { ...output("B", 2, 1680), display: { gdiName: "\\\\.\\DISPLAY2", adapterLuid: ADAPTER_LUID, targetId: 12 } },
  ];
  const config = await loadNodeConfig({
    platform: "win32",
    cwd: "C:\\show",
    argv: ["--renderer-adapter-luid", ADAPTER_LUID.toLowerCase()],
    env: { ...baseEnv, PIXEL_BRIGHTNESS_OUTPUTS: JSON.stringify(boundOutputs) },
  });
  assert.equal(config.adapterLuid, ADAPTER_LUID);
  assert.equal(config.renderer.adapterLuid, ADAPTER_LUID);
  assert.equal(config.outputs[0].display.adapterLuid, ADAPTER_LUID);

  await assert.rejects(loadNodeConfig({
    platform: "win32",
    cwd: "C:\\show",
    env: {
      ...baseEnv,
      PIXEL_BRIGHTNESS_OUTPUTS: JSON.stringify([
        boundOutputs[0],
        { ...boundOutputs[1], display: { ...boundOutputs[1].display, adapterLuid: "00000000:00000002" } },
      ]),
    },
  }), /must use one GPU adapter LUID/);

  await assert.rejects(loadNodeConfig({
    platform: "win32",
    cwd: "C:\\show",
    argv: ["--renderer-adapter-luid", "00000000:00000002"],
    env: { ...baseEnv, PIXEL_BRIGHTNESS_OUTPUTS: JSON.stringify(boundOutputs) },
  }), /does not match the physical output GPU adapter LUID/);
});

test("Windows renderer DTO has one master Spout and strips outer JS-only fields", () => {
  const corrected = {
    ...output("A", 1, 0),
    resolution: { width: 1920, height: 1080, refreshNum: 60_000, refreshDen: 1_001 },
    blend: {
      enabled: true,
      feather: 0.78,
      gamma: 2.2,
      map: { path: "maps\\blend-A.r32", width: 1920, height: 1080, format: "r32_float" },
    },
    blackUniformity: {
      enabled: true,
      lift: 0.1,
      map: { path: "maps\\black-A.rgba", width: 64, height: 36, format: "rgba32_float" },
    },
    mask: {
      enabled: true,
      map: { path: "maps\\mask-A.r32", width: 1920, height: 1080, format: "r32_float" },
    },
    color: {
      gain: [1, 1, 1],
      offset: [0, 0, 0],
      gamma: [1, 1, 1],
      lut: { path: "luts\\projector-A.rgba", size: 33, format: "rgba32_float" },
    },
    processing: { bypass: true },
  };
  const config = normalizeWindowsRendererConfig({
    revision: 7,
    nodeId: "node-01",
    canvas: { width: 5280, height: 1080, frameRateNum: 60, frameRateDen: 1 },
    compositionSource,
    telemetry: { path: "C:\\ProgramData\\Pixel Brightness\\renderer-status.json", intervalMs: 750 },
    outputs: [corrected, output("B", 2, 3360)],
  });
  assert.equal(config.compositionSource.senderName, "PB-COMPOSITION");
  assert.equal("source" in config.outputs[0], false);
  assert.deepEqual(Object.keys(config.outputs[0]).sort(), [
    "blackUniformity", "blend", "color", "display", "enabled", "id", "mask",
    "overlap", "processing", "resolution", "sourceViewport", "warp",
  ].sort());
  assert.deepEqual(config.outputs[0].processing, {
    bypass: true,
    order: ["sourceViewport", "warp", "blend", "blackUniformity", "color", "mask"],
  });
  assert.equal(config.outputs[0].display.gdiName, "\\\\.\\DISPLAY1");
  assert.equal(config.outputs[0].warp.points.length, 9);
  assert.equal(config.outputs[0].warp.enabled, true);
  assert.equal(config.outputs[0].resolution.refreshNum, 60_000);
  assert.equal(config.outputs[0].resolution.refreshDen, 1_001);
  assert.equal(config.outputs[0].mask.map.format, "r32_float");
  assert.equal(config.outputs[0].blend.map.path, "maps\\blend-A.r32");
  assert.equal(config.outputs[0].blackUniformity.map.format, "rgba32_float");
  assert.equal(config.outputs[0].color.lut.size, 33);
  assert.deepEqual(config.telemetry, {
    path: "C:\\ProgramData\\Pixel Brightness\\renderer-status.json",
    intervalMs: 750,
  });
  assert.equal(config.pipeName, "\\\\.\\pipe\\pixel-brightness-renderer-node-01");
  assert.throws(() => normalizeWindowsRendererConfig({
    revision: 1,
    nodeId: "node-01",
    canvas: { width: 5280, height: 1080, frameRateNum: 60, frameRateDen: 1 },
    compositionSource: { ...compositionSource, width: 1920 },
    outputs: [output("A", 1, 0)],
  }), /must match the project canvas/);
  assert.throws(() => normalizeWindowsRendererConfig({
    revision: 1,
    nodeId: "node-01",
    canvas: { width: 5280, height: 1080, frameRateNum: 60, frameRateDen: 1 },
    compositionSource,
    outputs: [{ ...output("A", 1, 0), mask: { enabled: true } }],
  }), /enabled mask requires/);
});

test("DXGI display schema accepts stable selectors and rejects per-output sources", () => {
  const payload = {
    backend: "dxgi",
    compositionSource,
    outputs: [output("A", 1, 0), output("B", 2, 1680)],
  };
  const config = validateDisplayConfig(payload);
  const plan = displayPlan(config, { platform: "win32" });
  assert.equal(config.backend, "dxgi");
  assert.equal(plan.preferredBackend, "dxgi");
  assert.equal(plan.requiresInteractiveSession, true);
  assert.equal(plan.requiresNativeRenderer, true);
  assert.equal(plan.platformSupported, true);
  assert.throws(() => validateDisplayConfig({
    ...payload,
    outputs: [{ ...output("A", 1, 0), source: compositionSource }],
  }), /top-level compositionSource/);
});

test("renderer IPC contract is bounded NDJSON and client correlates request IDs", async () => {
  assert.equal(WINDOWS_RENDERER_MAX_MESSAGE_BYTES, 64 * 1024 * 1024);
  assert.doesNotThrow(() => encodeWindowsRendererMessage({
    schemaVersion: 1,
    requestId: "req-dense-mesh",
    type: "apply-config",
    payload: { denseMeshFixture: "x".repeat(2 * 1024 * 1024) },
  }), "a multi-output dense mesh must not be rejected by the former 1 MiB limit");
  const request = encodeWindowsRendererMessage({
    schemaVersion: 1,
    requestId: "req-1",
    type: "get-status",
    payload: {},
  });
  assert.equal(request.endsWith("\n"), true);
  const response = decodeWindowsRendererMessage(`${JSON.stringify({
    schemaVersion: 1,
    requestId: "req-1",
    type: "result",
    ok: true,
    payload: { state: "ready" },
  })}\n`);
  assert.equal(response.payload.state, "ready");
  assert.deepEqual(rendererLaunchArgs({ configPath: "C:\\ProgramData\\renderer.json", nodeId: "Node 01" }), [
    "--config", "C:\\ProgramData\\renderer.json",
    "--pipe", "\\\\.\\pipe\\pixel-brightness-renderer-node-01",
    "--node-id", "node-01",
  ]);

  let written = "";
  const socket = new EventEmitter();
  socket.write = (message) => {
    written = message;
    const decoded = JSON.parse(message);
    queueMicrotask(() => socket.emit("data", Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      requestId: decoded.requestId,
      type: "result",
      ok: true,
      payload: { backend: "dxgi" },
    })}\n`)));
  };
  socket.destroy = () => {};
  const client = new WindowsRendererIpcClient({
    nodeId: "node-01",
    createConnectionImpl: () => {
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  const result = await client.request("hello", {}, { requestId: "req-client" });
  assert.equal(JSON.parse(written).type, "hello");
  assert.equal(result.payload.backend, "dxgi");
});

test("SafeCommandRunner accepts Windows executables and never uses a shell", async () => {
  let invocation;
  const executable = "C:\\Pixel Brightness\\probe.exe";
  const runner = new SafeCommandRunner({
    platform: "win32",
    allowedExecutables: [executable],
    execFileImpl: (file, args, options, callback) => {
      invocation = { file, args, options };
      callback(null, "ok", "");
    },
  });
  await runner.run(executable, ["$(not-a-shell)"]);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.args, ["$(not-a-shell)"]);
});

test("Windows telemetry uses one fixed encoded PowerShell program and normalizes host data", async () => {
  const payload = {
    os: { caption: "Microsoft Windows 11 Pro", version: "10.0.26100", buildNumber: "26100", architecture: "64-bit" },
    computer: { manufacturer: "Test", model: "Render Node", totalPhysicalMemoryBytes: "68719476736" },
    gpus: [{ name: "NVIDIA RTX A400", pnpDeviceId: "PCI\\VEN_10DE", driverVersion: "32.0", adapterRamBytes: "4294967296", status: "OK" }],
    outputs: [{ deviceId: "\\\\.\\DISPLAY1", pnpDeviceId: "DISPLAY\\ABC123", name: "Projector", width: 1920, height: 1080, status: "OK" }],
    services: [{ name: "PixelBrightnessNode", displayName: "Pixel Brightness Node", available: true, status: "Running", startType: "Automatic", canStop: true }],
    session: { name: "Console", userInteractive: true },
  };
  const parsed = parseWindowsTelemetryJson(JSON.stringify(payload));
  assert.equal(parsed.os.buildNumber, "26100");
  assert.equal(parsed.gpu.gpus[0].name, "NVIDIA RTX A400");
  assert.equal(parsed.dxgi.outputs[0].resolution.width, 1920);
  assert.equal(parsed.services[0].activeState, "active");

  let invocation;
  const adapter = new WindowsHostTelemetryAdapter({
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    serviceNames: ["PixelBrightnessNode"],
    runner: {
      run: async (executable, args, options) => {
        invocation = { executable, args, options };
        return { stdout: JSON.stringify(payload) };
      },
    },
  });
  const result = await adapter.collect();
  assert.equal(result.available, true);
  assert.equal(invocation.args.includes("-EncodedCommand"), true);
  assert.equal(invocation.args.includes("-Command"), false);
  assert.deepEqual(JSON.parse(invocation.options.env.PIXEL_BRIGHTNESS_TELEMETRY_SERVICES), ["PixelBrightnessNode"]);

  const collector = new HostTelemetryCollector({
    platform: "win32",
    dataDir: "C:\\ProgramData\\Pixel Brightness",
    windowsAdapter: adapter,
    serviceNames: ["PixelBrightnessNode"],
    fsApi: {
      statfs: async () => ({ bsize: 1n, blocks: 100n, bfree: 25n, bavail: 20n }),
      readFile: async () => null,
      readdir: async () => [],
      readlink: async () => "",
    },
    osApi: {
      hostname: () => "pb-win-01",
      arch: () => "x64",
      release: () => "10.0.26100",
      uptime: () => 100,
      loadavg: () => [0, 0, 0],
      cpus: () => [{}, {}],
      totalmem: () => 1000,
      freemem: () => 250,
    },
  });
  const snapshot = await collector.collect();
  assert.equal(snapshot.host.platform, "win32");
  assert.equal(snapshot.dxgi.outputs.length, 1);
  assert.equal(snapshot.gpu.gpus[0].name, "NVIDIA RTX A400");
  assert.equal(snapshot.session.interactive, true);
});
