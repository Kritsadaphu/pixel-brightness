import path from "node:path";
import { createHash } from "node:crypto";
import { SafeCommandRunner } from "./safe-exec.mjs";
import { normalizePlatformServiceName } from "./platform-contract.mjs";

const WINDOWS_TELEMETRY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$serviceNames = @()
$serviceJson = [Environment]::GetEnvironmentVariable('PIXEL_BRIGHTNESS_TELEMETRY_SERVICES')
if ($serviceJson) {
  try { $serviceNames = @(ConvertFrom-Json -InputObject $serviceJson) } catch { $serviceNames = @() }
}
$os = Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object -First 1
$computer = Get-CimInstance -ClassName Win32_ComputerSystem | Select-Object -First 1
$gpus = @(Get-CimInstance -ClassName Win32_VideoController | ForEach-Object {
  [ordered]@{
    name = [string]$_.Name
    pnpDeviceId = [string]$_.PNPDeviceID
    driverVersion = [string]$_.DriverVersion
    adapterRamBytes = if ($null -eq $_.AdapterRAM) { $null } else { [string]$_.AdapterRAM }
    currentHorizontalResolution = $_.CurrentHorizontalResolution
    currentVerticalResolution = $_.CurrentVerticalResolution
    currentRefreshRate = $_.CurrentRefreshRate
    status = [string]$_.Status
  }
})
$outputs = @(Get-CimInstance -ClassName Win32_DesktopMonitor | ForEach-Object {
  [ordered]@{
    deviceId = [string]$_.DeviceID
    pnpDeviceId = [string]$_.PNPDeviceID
    name = [string]$_.Name
    monitorType = [string]$_.MonitorType
    width = $_.ScreenWidth
    height = $_.ScreenHeight
    status = [string]$_.Status
    availability = $_.Availability
  }
})
$services = @($serviceNames | ForEach-Object {
  $requestedName = [string]$_
  $service = Get-Service -Name $requestedName -ErrorAction SilentlyContinue
  if ($null -eq $service) {
    [ordered]@{ name = $requestedName; available = $false }
  } else {
    [ordered]@{
      name = [string]$service.Name
      displayName = [string]$service.DisplayName
      available = $true
      status = [string]$service.Status
      startType = [string]$service.StartType
      canStop = [bool]$service.CanStop
    }
  }
})
$result = [ordered]@{
  os = [ordered]@{
    caption = [string]$os.Caption
    version = [string]$os.Version
    buildNumber = [string]$os.BuildNumber
    architecture = [string]$os.OSArchitecture
    lastBootUpTime = if ($null -eq $os.LastBootUpTime) { $null } else { $os.LastBootUpTime.ToString('o') }
  }
  computer = [ordered]@{
    manufacturer = [string]$computer.Manufacturer
    model = [string]$computer.Model
    totalPhysicalMemoryBytes = if ($null -eq $computer.TotalPhysicalMemory) { $null } else { [string]$computer.TotalPhysicalMemory }
  }
  gpus = $gpus
  outputs = $outputs
  services = $services
  session = [ordered]@{
    name = [string][Environment]::GetEnvironmentVariable('SESSIONNAME')
    userInteractive = [Environment]::UserInteractive
  }
}
$result | ConvertTo-Json -Depth 8 -Compress
`;

export const WINDOWS_TELEMETRY_SCRIPT_SHA256 = createHash("sha256").update(WINDOWS_TELEMETRY_SCRIPT).digest("hex");
export const WINDOWS_TELEMETRY_ENCODED_COMMAND = Buffer.from(WINDOWS_TELEMETRY_SCRIPT, "utf16le").toString("base64");

function clean(value, maximum = 1024) {
  let output = "";
  for (const character of String(value ?? "")) {
    const code = character.charCodeAt(0);
    output += code <= 0x1f || code === 0x7f ? " " : character;
  }
  return output.trim().slice(0, maximum);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function array(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

export function windowsPowerShellPath(env = process.env) {
  const root = String(env.SystemRoot || env.SYSTEMROOT || env.WINDIR || "C:\\Windows");
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function parseWindowsTelemetryJson(input) {
  const text = String(input || "").replace(/^\uFEFF/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Windows telemetry returned no JSON object");
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`Windows telemetry returned invalid JSON: ${error.message}`);
  }
  const gpus = array(parsed.gpus).slice(0, 32).map((gpu, index) => ({
    index,
    uuid: clean(gpu?.pnpDeviceId, 512) || null,
    name: clean(gpu?.name, 256) || "Unknown GPU",
    driverVersion: clean(gpu?.driverVersion, 128) || null,
    memoryTotalBytes: gpu?.adapterRamBytes == null ? null : clean(gpu.adapterRamBytes, 32),
    currentMode: gpu?.currentHorizontalResolution && gpu?.currentVerticalResolution ? {
      width: finite(gpu.currentHorizontalResolution),
      height: finite(gpu.currentVerticalResolution),
      refreshHz: finite(gpu.currentRefreshRate),
    } : null,
    status: clean(gpu?.status, 64).toLowerCase() || null,
    displayActive: /^ok$/i.test(String(gpu?.status || "")),
  }));
  const outputs = array(parsed.outputs).slice(0, 128).map((output) => ({
    devicePath: clean(output?.pnpDeviceId || output?.deviceId, 1024) || null,
    gdiName: clean(output?.deviceId, 256) || null,
    name: clean(output?.name || output?.monitorType, 256) || "Unknown display",
    resolution: output?.width && output?.height ? {
      width: finite(output.width),
      height: finite(output.height),
    } : null,
    status: clean(output?.status, 64).toLowerCase() || "unknown",
    availability: finite(output?.availability),
  }));
  const services = array(parsed.services).slice(0, 16).map((service) => {
    const status = clean(service?.status, 64).toLowerCase();
    return {
      name: clean(service?.name, 128),
      displayName: clean(service?.displayName, 256) || null,
      supported: true,
      available: service?.available === true,
      activeState: status === "running" ? "active" : status === "stopped" ? "inactive" : status || null,
      subState: status || null,
      startType: clean(service?.startType, 64).toLowerCase() || null,
      canStop: service?.canStop === true,
    };
  });
  return {
    os: {
      id: "windows",
      name: clean(parsed.os?.caption, 256) || "Microsoft Windows",
      prettyName: clean(parsed.os?.caption, 256) || "Microsoft Windows",
      versionId: clean(parsed.os?.version, 128) || null,
      buildNumber: clean(parsed.os?.buildNumber, 64) || null,
      architecture: clean(parsed.os?.architecture, 64) || null,
      lastBootUpTime: clean(parsed.os?.lastBootUpTime, 128) || null,
    },
    computer: {
      manufacturer: clean(parsed.computer?.manufacturer, 256) || null,
      model: clean(parsed.computer?.model, 256) || null,
      totalPhysicalMemoryBytes: parsed.computer?.totalPhysicalMemoryBytes == null
        ? null
        : clean(parsed.computer.totalPhysicalMemoryBytes, 32),
    },
    gpu: { supported: true, available: gpus.length > 0, gpus },
    dxgi: { supported: true, available: true, provider: "win32-cim", outputs },
    services,
    session: {
      type: "windows-interactive",
      id: clean(parsed.session?.name, 128) || null,
      interactive: parsed.session?.userInteractive === true,
    },
  };
}

export class WindowsHostTelemetryAdapter {
  constructor({
    serviceNames = ["PixelBrightnessNode"],
    runner,
    env = process.env,
    powershellPath = windowsPowerShellPath(env),
  } = {}) {
    this.serviceNames = Array.from(new Set(serviceNames.map((name) => normalizePlatformServiceName(name, {
      platform: "win32",
      fallback: "PixelBrightnessNode",
    })))).slice(0, 16);
    this.env = env;
    this.powershellPath = powershellPath;
    this.runner = runner || new SafeCommandRunner({
      allowedExecutables: [powershellPath],
      platform: "win32",
      defaultTimeoutMs: 8_000,
      maxOutputBytes: 1024 * 1024,
    });
  }

  async collect() {
    try {
      const result = await this.runner.run(this.powershellPath, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        WINDOWS_TELEMETRY_ENCODED_COMMAND,
      ], {
        timeoutMs: 8_000,
        maxOutputBytes: 1024 * 1024,
        env: {
          ...this.env,
          PIXEL_BRIGHTNESS_TELEMETRY_SERVICES: JSON.stringify(this.serviceNames),
        },
      });
      return { supported: true, available: true, ...parseWindowsTelemetryJson(result.stdout) };
    } catch (error) {
      return {
        supported: true,
        available: false,
        error: clean(error.message, 1024),
        reason: error.code || "powershell-telemetry-failed",
        os: null,
        gpu: { supported: true, available: false, gpus: [] },
        dxgi: { supported: true, available: false, provider: "win32-cim", outputs: [] },
        services: this.serviceNames.map((name) => ({ name, supported: true, available: false })),
        session: { type: "windows-interactive", id: null, interactive: false },
      };
    }
  }
}
