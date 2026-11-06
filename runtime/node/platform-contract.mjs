import path from "node:path";

const WINDOWS_SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/;
const SYSTEMD_SERVICE_PATTERN = /^[A-Za-z0-9@_.:-]+\.service$/;

function clean(value, maximum = 32_767) {
  const output = String(value ?? "");
  if (output.includes("\0") || output.length > maximum) throw new Error("Platform path contains invalid text");
  return output;
}

export function sanitizePlatformNodeId(value) {
  const normalized = String(value || "pixel-node")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || "pixel-node";
}

export function pathApiForPlatform(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function resolvePlatformPath(value, { cwd = process.cwd(), platform = process.platform } = {}) {
  const pathname = clean(value);
  const pathApi = pathApiForPlatform(platform);
  return pathApi.resolve(clean(cwd), pathname);
}

export function joinPlatformPath(platform, ...segments) {
  return pathApiForPlatform(platform).join(...segments.map((segment) => clean(segment)));
}

export function isAbsolutePlatformPath(value, platform = process.platform) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (platform === "win32") return path.win32.isAbsolute(value);
  return path.posix.isAbsolute(value);
}

export function normalizePlatformServiceName(value, {
  platform = process.platform,
  fallback,
} = {}) {
  const name = String(value || fallback || (platform === "win32" ? "PixelBrightnessNode" : "pixel-brightness-node.service"));
  const valid = platform === "win32" ? WINDOWS_SERVICE_PATTERN.test(name) : SYSTEMD_SERVICE_PATTERN.test(name);
  if (!valid) throw new Error(platform === "win32" ? "Invalid Windows service name" : "Invalid systemd service name");
  return name;
}

export function windowsRendererPipeName(nodeId) {
  return `\\\\.\\pipe\\pixel-brightness-renderer-${sanitizePlatformNodeId(nodeId)}`;
}

export function platformDefaults({
  platform = process.platform,
  env = process.env,
  cwd = process.cwd(),
  nodeId = "pixel-node",
} = {}) {
  const safeNodeId = sanitizePlatformNodeId(nodeId);
  if (platform === "win32") {
    const systemDrive = String(env.SystemDrive || env.SYSTEMDRIVE || "C:");
    const programData = String(env.ProgramData || env.PROGRAMDATA || path.win32.join(systemDrive, "ProgramData"));
    const programFiles = String(env.ProgramFiles || env.PROGRAMFILES || path.win32.join(systemDrive, "Program Files"));
    const installDir = String(env.PIXEL_BRIGHTNESS_INSTALL_DIR || path.win32.join(programFiles, "Pixel Brightness"));
    const dataDir = path.win32.join(programData, "Pixel Brightness", "nodes", safeNodeId);
    return Object.freeze({
      platform,
      dataDir,
      displayConfigPath: path.win32.join(dataDir, "display-config.json"),
      diagnosticsDir: path.win32.join(dataDir, "diagnostics"),
      nodeService: "PixelBrightnessNode",
      hostControlCommand: path.win32.join(installDir, "bin", "pixel-brightness-hostctl.exe"),
      rendererCommand: path.win32.join(installDir, "bin", "pixel-brightness-renderer.exe"),
      rendererConfigPath: path.win32.join(dataDir, "renderer-config.json"),
      rendererPipe: windowsRendererPipeName(safeNodeId),
      displayBackend: "dxgi",
      rendererBackend: "dxgi",
    });
  }
  const dataDir = resolvePlatformPath(`.pixel-brightness/nodes/${safeNodeId}`, { cwd, platform });
  return Object.freeze({
    platform,
    dataDir,
    displayConfigPath: joinPlatformPath(platform, dataDir, "display-config.json"),
    diagnosticsDir: joinPlatformPath(platform, dataDir, "diagnostics"),
    nodeService: "pixel-brightness-node.service",
    hostControlCommand: "/usr/local/sbin/pixel-brightness-hostctl",
    rendererCommand: null,
    rendererConfigPath: joinPlatformPath(platform, dataDir, "renderer-config.json"),
    rendererPipe: null,
    displayBackend: "kms",
    rendererBackend: "simulator",
  });
}

export const PLATFORM_SERVICE_PATTERNS = Object.freeze({
  win32: WINDOWS_SERVICE_PATTERN,
  linux: SYSTEMD_SERVICE_PATTERN,
});
