import test from "node:test";
import assert from "node:assert/strict";
import { HostTelemetryCollector, collectDrmConnectors, parseEdid, parseNvidiaSmiCsv } from "../runtime/node/host-telemetry.mjs";

function sampleEdid() {
  const edid = Buffer.alloc(128);
  Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]).copy(edid);
  const manufacturer = (1 << 10) | (2 << 5) | 3; // ABC
  edid.writeUInt16BE(manufacturer, 8);
  edid.writeUInt16LE(0x1234, 10);
  edid.writeUInt32LE(987654, 12);
  edid[16] = 12;
  edid[17] = 34;
  edid.writeUInt16LE(14_850, 54);
  edid[56] = 0x80;
  edid[57] = 0x18;
  edid[58] = 0x71;
  edid[59] = 0x38;
  edid[60] = 0x2d;
  edid[61] = 0x40;
  edid[72] = 0;
  edid[73] = 0;
  edid[75] = 0xfc;
  Buffer.from("Projector One\n", "ascii").copy(edid, 77, 0, 13);
  return edid;
}

test("parseEdid extracts identity and preferred timing without returning raw EDID", () => {
  const parsed = parseEdid(sampleEdid());
  assert.equal(parsed.valid, true);
  assert.equal(parsed.manufacturer, "ABC");
  assert.equal(parsed.productCode, "1234");
  assert.equal(parsed.serialNumber, "987654");
  assert.equal(parsed.monitorName, "Projector One");
  assert.equal(parsed.preferredMode.width, 1920);
  assert.equal(parsed.preferredMode.height, 1080);
  assert.equal(parsed.sha256.length, 64);
  assert.equal("raw" in parsed, false);
});

test("collectDrmConnectors reads connector state, modes, EDID and driver from injected sysfs", async () => {
  const edid = sampleEdid();
  const values = new Map([
    ["/fake/drm/card0-DP-1/status", "connected\n"],
    ["/fake/drm/card0-DP-1/enabled", "enabled\n"],
    ["/fake/drm/card0-DP-1/dpms", "On\n"],
    ["/fake/drm/card0-DP-1/modes", "1920x1080\n1280x720\nnot-a-mode\n"],
    ["/fake/drm/card0-DP-1/connector_id", "42\n"],
    ["/fake/drm/card0-DP-1/edid", edid],
  ]);
  const fsApi = {
    readdir: async () => ["card0", "card0-DP-1", "renderD128", "version"],
    readFile: async (pathname) => {
      if (!values.has(pathname)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return values.get(pathname);
    },
    readlink: async () => "/sys/bus/pci/drivers/nvidia",
  };
  const result = await collectDrmConnectors({ fsApi, root: "/fake/drm" });
  assert.equal(result.available, true);
  assert.equal(result.connectors.length, 1);
  assert.deepEqual(result.connectors[0].modes, ["1920x1080", "1280x720"]);
  assert.equal(result.connectors[0].connector, "DP-1");
  assert.equal(result.connectors[0].connectorId, 42);
  assert.equal(result.connectors[0].driver, "nvidia");
  assert.equal(result.connectors[0].edid.monitorName, "Projector One");
});

test("NVIDIA CSV parser returns bounded numeric telemetry", () => {
  const [gpu] = parseNvidiaSmiCsv("0, GPU-123, NVIDIA RTX 4000, 550.54, 16384, 2048, 37, 62, P2, Enabled\n");
  assert.equal(gpu.index, 0);
  assert.equal(gpu.memoryTotalMiB, 16384);
  assert.equal(gpu.utilizationPercent, 37);
  assert.equal(gpu.displayActive, true);
});

test("HostTelemetryCollector returns a complete Linux snapshot and degrades optional probes", async () => {
  const calls = [];
  const runner = {
    run: async (executable, args) => {
      calls.push({ executable, args });
      if (executable.endsWith("nvidia-smi")) {
        return { stdout: "0, GPU-1, RTX Test, 555.1, 8192, 1024, 10, 48, P8, Disabled\n", durationMs: 1 };
      }
      return {
        stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=100\nExecMainStatus=0\n",
        durationMs: 1,
      };
    },
  };
  const fsApi = {
    readFile: async (pathname) => {
      if (pathname === "/etc/os-release") return 'ID=ubuntu\nNAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04 LTS"\nVERSION_ID="24.04"\n';
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    readdir: async () => [],
    readlink: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    statfs: async () => ({ bsize: 4096n, blocks: 1000n, bfree: 250n, bavail: 200n }),
  };
  const osApi = {
    hostname: () => "render-01",
    arch: () => "x64",
    release: () => "6.8.0-test",
    uptime: () => 1234.4,
    loadavg: () => [0.1, 0.2, 0.3],
    cpus: () => [{}, {}, {}, {}],
    totalmem: () => 16_000,
    freemem: () => 4_000,
  };
  const collector = new HostTelemetryCollector({
    dataDir: "/data",
    serviceNames: ["pixel-brightness-node.service"],
    runner,
    fsApi,
    osApi,
    platform: "linux",
    env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" },
    drmRoot: "/fake/drm",
  });
  const snapshot = await collector.collect({ renderer: { backend: "test" } });
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.host.hostname, "render-01");
  assert.equal(snapshot.host.os.versionId, "24.04");
  assert.equal(snapshot.memory.usedBytes, "12000");
  assert.equal(snapshot.disk.usedPercent, 75);
  assert.equal(snapshot.gpu.gpus[0].name, "RTX Test");
  assert.equal(snapshot.services[0].activeState, "active");
  assert.equal(snapshot.session.type, "wayland");
  assert.equal(snapshot.renderer.backend, "test");
  assert.equal(calls.length, 2);
});

test("HostTelemetryCollector has an explicit non-Linux fallback", async () => {
  const collector = new HostTelemetryCollector({
    dataDir: "/data",
    platform: "darwin",
    serviceNames: [],
    runner: { run: async () => { throw new Error("runner must not be called"); } },
    fsApi: {
      readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      readdir: async () => [],
      readlink: async () => "",
      statfs: async () => ({ bsize: 1n, blocks: 1n, bfree: 1n, bavail: 1n }),
    },
  });
  const snapshot = await collector.collect();
  assert.equal(snapshot.host.platform, "darwin");
  assert.equal(snapshot.drm.supported, false);
  assert.equal(snapshot.gpu.reason, "linux-only");
});
