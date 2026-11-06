import * as os from "node:os";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { readFile, readdir, readlink, statfs } from "node:fs/promises";
import { SafeCommandRunner } from "./safe-exec.mjs";
import { WindowsHostTelemetryAdapter } from "./windows-host-telemetry.mjs";

const NVIDIA_SMI = "/usr/bin/nvidia-smi";
const SYSTEMCTL = "/usr/bin/systemctl";
const DRM_ROOT = "/sys/class/drm";
const MAX_CONNECTORS = 128;

function text(value, maximum = 512) {
  let output = "";
  for (const character of String(value ?? "")) {
    const code = character.charCodeAt(0);
    output += code <= 0x1f || code === 0x7f ? " " : character;
  }
  return output.trim().slice(0, maximum);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeCall(callback, fallback) {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

function parseKeyValue(input, separator = "=") {
  const result = {};
  for (const line of String(input || "").split(/\r?\n/)) {
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + separator.length).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    result[key] = value.replace(/\\n/g, " ");
  }
  return result;
}

function edidManufacturer(first, second) {
  const encoded = (first << 8) | second;
  return [10, 5, 0].map((shift) => String.fromCharCode(64 + ((encoded >> shift) & 0x1f))).join("");
}

export function parseEdid(input) {
  const bytes = Buffer.from(input || []);
  const validHeader = bytes.length >= 128 && bytes.subarray(0, 8).equals(Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]));
  if (!validHeader) {
    return {
      present: bytes.length > 0,
      valid: false,
      bytes: bytes.length,
      sha256: bytes.length ? createHash("sha256").update(bytes).digest("hex") : null,
    };
  }
  let monitorName = null;
  for (let offset = 54; offset + 18 <= Math.min(bytes.length, 126); offset += 18) {
    if (bytes[offset] === 0 && bytes[offset + 1] === 0 && bytes[offset + 3] === 0xfc) {
      monitorName = text(bytes.subarray(offset + 5, offset + 18).toString("ascii").replace(/\n/g, " "), 128) || null;
    }
  }
  const pixelClockKhz = bytes.readUInt16LE(54) * 10;
  let preferredMode = null;
  if (pixelClockKhz > 0) {
    const width = bytes[56] + ((bytes[58] & 0xf0) << 4);
    const horizontalBlank = bytes[57] + ((bytes[58] & 0x0f) << 8);
    const height = bytes[59] + ((bytes[61] & 0xf0) << 4);
    const verticalBlank = bytes[60] + ((bytes[61] & 0x0f) << 8);
    const totals = (width + horizontalBlank) * (height + verticalBlank);
    preferredMode = {
      width,
      height,
      refreshHz: totals > 0 ? Math.round(pixelClockKhz * 1000 / totals * 1000) / 1000 : null,
      pixelClockKhz,
    };
  }
  const serial = bytes.readUInt32LE(12);
  return {
    present: true,
    valid: true,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    manufacturer: edidManufacturer(bytes[8], bytes[9]),
    productCode: bytes.readUInt16LE(10).toString(16).padStart(4, "0"),
    serialNumber: serial === 0 ? null : String(serial),
    manufactured: {
      week: bytes[16] || null,
      year: 1990 + bytes[17],
    },
    monitorName,
    preferredMode,
    extensions: bytes[126],
  };
}

async function optionalRead(fsApi, pathname, encoding = "utf8") {
  try {
    return await fsApi.readFile(pathname, encoding);
  } catch {
    return null;
  }
}

function drmEntryName(entry) {
  return typeof entry === "string" ? entry : entry?.name;
}

export async function collectDrmConnectors({ fsApi, root = DRM_ROOT } = {}) {
  const filesystem = fsApi || { readFile, readdir, readlink };
  let entries;
  try {
    entries = await filesystem.readdir(root, { withFileTypes: true });
  } catch (error) {
    return { supported: false, available: false, root, connectors: [], error: text(error.message, 1024) };
  }
  const connectors = [];
  for (const entry of entries) {
    if (connectors.length >= MAX_CONNECTORS) break;
    const name = drmEntryName(entry);
    const match = /^(card\d+)-(.+)$/.exec(name || "");
    if (!match || /^renderD|^controlD|^card\d+$/.test(name)) continue;
    const directory = join(root, name);
    const [statusValue, enabledValue, dpmsValue, modesValue, idValue, edidValue] = await Promise.all([
      optionalRead(filesystem, join(directory, "status")),
      optionalRead(filesystem, join(directory, "enabled")),
      optionalRead(filesystem, join(directory, "dpms")),
      optionalRead(filesystem, join(directory, "modes")),
      optionalRead(filesystem, join(directory, "connector_id")),
      optionalRead(filesystem, join(directory, "edid"), null),
    ]);
    if (statusValue == null && enabledValue == null && modesValue == null) continue;
    let driver = null;
    try {
      driver = basename(await filesystem.readlink(join(root, match[1], "device", "driver")));
    } catch {
      // Virtual DRM and some container mounts do not expose the device driver.
    }
    const modes = String(modesValue || "")
      .split(/\r?\n/)
      .map((mode) => text(mode, 64))
      .filter((mode) => /^\d{2,5}x\d{2,5}(?:[ip])?$/.test(mode))
      .slice(0, 128);
    connectors.push({
      sysfsName: name,
      card: match[1],
      connector: match[2],
      connectorId: numberOrNull(String(idValue || "").trim()),
      status: text(statusValue || "unknown", 32).toLowerCase(),
      enabled: text(enabledValue || "unknown", 32).toLowerCase(),
      dpms: text(dpmsValue || "unknown", 32),
      driver,
      modes,
      edid: parseEdid(edidValue || []),
    });
  }
  return { supported: true, available: true, root, connectors };
}

export function parseNvidiaSmiCsv(input) {
  const fields = ["index", "uuid", "name", "driverVersion", "memoryTotalMiB", "memoryUsedMiB", "utilizationPercent", "temperatureC", "performanceState", "displayActive"];
  return String(input || "").split(/\r?\n/).filter(Boolean).slice(0, 32).map((line) => {
    const values = line.split(",").map((value) => value.trim());
    const gpu = Object.fromEntries(fields.map((field, index) => [field, values[index] ?? null]));
    for (const key of ["index", "memoryTotalMiB", "memoryUsedMiB", "utilizationPercent", "temperatureC"]) {
      gpu[key] = numberOrNull(gpu[key]);
    }
    gpu.displayActive = /^(enabled|active|yes|1)$/i.test(gpu.displayActive || "");
    return gpu;
  });
}

async function collectNvidia(runner, platform) {
  if (platform !== "linux") return { supported: false, available: false, gpus: [], reason: "linux-only" };
  try {
    const result = await runner.run(NVIDIA_SMI, [
      "--query-gpu=index,uuid,name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,pstate,display_active",
      "--format=csv,noheader,nounits",
    ], { timeoutMs: 4_000, maxOutputBytes: 256 * 1024 });
    return { supported: true, available: true, gpus: parseNvidiaSmiCsv(result.stdout) };
  } catch (error) {
    return { supported: true, available: false, gpus: [], reason: error.code || "nvidia-smi-failed" };
  }
}

async function collectService(runner, name, platform) {
  if (platform !== "linux") return { name, supported: false, available: false };
  if (!/^[A-Za-z0-9@_.:-]+\.service$/.test(name)) return { name, supported: true, available: false, error: "invalid-service-name" };
  try {
    const result = await runner.run(SYSTEMCTL, [
      "show", name, "--no-page",
      "--property=LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStatus,ActiveEnterTimestamp",
    ], { timeoutMs: 3_000, maxOutputBytes: 64 * 1024 });
    const values = parseKeyValue(result.stdout);
    return {
      name,
      supported: true,
      available: true,
      loadState: values.LoadState || null,
      activeState: values.ActiveState || null,
      subState: values.SubState || null,
      unitFileState: values.UnitFileState || null,
      mainPid: numberOrNull(values.MainPID),
      exitStatus: numberOrNull(values.ExecMainStatus),
      activeSince: values.ActiveEnterTimestamp || null,
    };
  } catch (error) {
    return { name, supported: true, available: false, error: error.code || "systemctl-failed" };
  }
}

async function collectDisk(fsApi, pathname) {
  try {
    const details = await fsApi.statfs(pathname, { bigint: true });
    const blockSize = details.bsize;
    const total = details.blocks * blockSize;
    const free = details.bfree * blockSize;
    const available = details.bavail * blockSize;
    return {
      path: pathname,
      available: true,
      totalBytes: total.toString(),
      freeBytes: free.toString(),
      availableBytes: available.toString(),
      usedBytes: (total - free).toString(),
      usedPercent: total > 0n ? Math.round(Number((total - free) * 10_000n / total)) / 100 : null,
    };
  } catch (error) {
    return { path: pathname, available: false, error: text(error.message, 512) };
  }
}

async function collectOsRelease(fsApi) {
  const input = await optionalRead(fsApi, "/etc/os-release");
  if (!input) return null;
  const values = parseKeyValue(input);
  return {
    id: values.ID || null,
    name: values.NAME || null,
    prettyName: values.PRETTY_NAME || null,
    versionId: values.VERSION_ID || null,
  };
}

export class HostTelemetryCollector {
  constructor({
    dataDir,
    serviceNames,
    runner,
    fsApi,
    osApi = os,
    platform = process.platform,
    env = process.env,
    drmRoot = DRM_ROOT,
    windowsAdapter,
    log = () => {},
  } = {}) {
    this.dataDir = dataDir || process.cwd();
    const selectedServices = serviceNames || [platform === "win32" ? "PixelBrightnessNode" : "pixel-brightness-node.service"];
    this.serviceNames = Array.from(new Set(selectedServices)).slice(0, 16);
    this.runner = runner || (platform === "linux"
      ? new SafeCommandRunner({ allowedExecutables: [NVIDIA_SMI, SYSTEMCTL], platform: "linux" })
      : { run: async () => { throw new Error("Linux command runner is unavailable on this platform"); } });
    this.fsApi = fsApi || { readFile, readdir, readlink, statfs };
    this.osApi = osApi;
    this.platform = platform;
    this.env = env;
    this.drmRoot = drmRoot;
    this.windowsAdapter = windowsAdapter || (platform === "win32"
      ? new WindowsHostTelemetryAdapter({ serviceNames: this.serviceNames, env })
      : null);
    this.log = log;
    this.lastSnapshot = null;
  }

  async collect({ renderer = null } = {}) {
    const startedNs = process.hrtime.bigint();
    const windowsPromise = this.platform === "win32"
      ? this.windowsAdapter.collect()
      : Promise.resolve(null);
    const [windows, linuxOsRelease, disk, drm, linuxNvidia, linuxServices] = await Promise.all([
      windowsPromise,
      this.platform === "linux" ? collectOsRelease(this.fsApi) : Promise.resolve(null),
      collectDisk(this.fsApi, this.dataDir),
      this.platform === "linux"
        ? collectDrmConnectors({ fsApi: this.fsApi, root: this.drmRoot })
        : Promise.resolve({ supported: false, available: false, root: this.drmRoot, connectors: [], reason: "linux-only" }),
      collectNvidia(this.runner, this.platform),
      Promise.all(this.serviceNames.map((name) => collectService(this.runner, name, this.platform))),
    ]);
    const osRelease = windows?.os || linuxOsRelease;
    const nvidia = windows?.gpu || linuxNvidia;
    const services = windows?.services || linuxServices;
    const totalMemory = safeCall(() => this.osApi.totalmem(), 0);
    const freeMemory = safeCall(() => this.osApi.freemem(), 0);
    const uptime = safeCall(() => this.osApi.uptime(), 0);
    const loadAverage = safeCall(() => this.osApi.loadavg(), [0, 0, 0]);
    const cpus = safeCall(() => this.osApi.cpus(), []);
    const snapshot = {
      schemaVersion: 2,
      collectedAt: new Date().toISOString(),
      collectionDurationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
      host: {
        hostname: text(safeCall(() => this.osApi.hostname(), "unknown"), 255),
        platform: this.platform,
        architecture: safeCall(() => this.osApi.arch(), process.arch),
        kernelRelease: safeCall(() => this.osApi.release(), "unknown"),
        os: osRelease,
        uptimeSeconds: Math.max(0, Math.round(uptime)),
        loadAverage: loadAverage.map((value) => Math.round(value * 1000) / 1000),
        cpuCount: cpus.length,
      },
      memory: {
        totalBytes: String(totalMemory),
        freeBytes: String(freeMemory),
        usedBytes: String(Math.max(0, totalMemory - freeMemory)),
        usedPercent: totalMemory > 0 ? Math.round((totalMemory - freeMemory) / totalMemory * 10_000) / 100 : null,
        processRssBytes: String(process.memoryUsage().rss),
      },
      disk,
      gpu: nvidia,
      drm,
      dxgi: windows?.dxgi || {
        supported: false,
        available: false,
        provider: null,
        outputs: [],
        reason: this.platform === "win32" ? windows?.reason || "windows-telemetry-unavailable" : "windows-only",
      },
      services,
      session: {
        type: windows?.session?.type || text(this.env.XDG_SESSION_TYPE || (this.env.WAYLAND_DISPLAY ? "wayland" : this.env.DISPLAY ? "x11" : "headless"), 32),
        id: windows?.session?.id || text(this.env.XDG_SESSION_ID || "", 128) || null,
        interactive: windows?.session?.interactive ?? null,
        display: text(this.env.DISPLAY || "", 128) || null,
        waylandDisplay: text(this.env.WAYLAND_DISPLAY || "", 128) || null,
        runtimeDirectory: text(this.env.XDG_RUNTIME_DIR || "", 512) || null,
      },
      process: {
        pid: process.pid,
        nodeVersion: process.version,
        uid: process.getuid?.() ?? null,
        gid: process.getgid?.() ?? null,
      },
      renderer,
      ...(windows?.computer ? { computer: windows.computer } : {}),
    };
    this.lastSnapshot = snapshot;
    this.log("debug", "host.telemetry.collected", {
      durationMs: snapshot.collectionDurationMs,
      drmConnectors: snapshot.drm.connectors.length,
      dxgiOutputs: snapshot.dxgi.outputs.length,
      gpus: snapshot.gpu.gpus.length,
    });
    return snapshot;
  }

  snapshot() {
    return this.lastSnapshot;
  }
}

export const HOST_TELEMETRY_EXECUTABLES = Object.freeze({ NVIDIA_SMI, SYSTEMCTL });
