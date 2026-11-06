#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createPixelBrightnessServer } from "./server.mjs";

function environmentBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function environmentList(value) {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

async function secretValue({ value, file, label }) {
  if (value && file) throw new Error(`${label} must be configured by value or file, never both`);
  const secret = file ? (await readFile(path.resolve(file), "utf8")).trim() : String(value ?? "").trim();
  if (secret && (secret.includes("\0") || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 512)) {
    throw new Error(`${label} must contain 32-512 bytes and no NUL characters`);
  }
  return secret || null;
}

async function credentialValue({ value, file, label }) {
  if (value && file) throw new Error(`${label} must be configured by value or file, never both`);
  const secret = file ? (await readFile(path.resolve(file), "utf8")).trim() : String(value ?? "").trim();
  if (secret && (secret.includes("\0") || Buffer.byteLength(secret) > 512)) {
    throw new Error(`${label} must contain at most 512 bytes and no NUL characters`);
  }
  return secret;
}

function parseArguments(argv) {
  const defaults = {
    host: process.env.PB_SERVER_HOST || "127.0.0.1",
    port: Number(process.env.PB_SERVER_PORT || 4100),
    webControlPort: Number(process.env.PB_WEB_CONTROL_PORT || 3000),
    dataDir: process.env.PB_SERVER_DATA_DIR
      || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "server"),
    maxUploadBytes: Number(process.env.PB_MAX_UPLOAD_BYTES || 20 * 1024 * 1024 * 1024),
    maxJsonBytes: Number(process.env.PB_MAX_JSON_BYTES || 64 * 1024 * 1024),
    controlToken: process.env.PIXEL_CONTROL_TOKEN || null,
    controlTokenFile: process.env.PB_CONTROL_TOKEN_FILE || null,
    nodeSigningKey: process.env.PIXEL_NODE_SIGNING_KEY || null,
    nodeSigningKeyFile: process.env.PB_NODE_SIGNING_KEY_FILE || null,
    legacyAuthToken: process.env.PIXEL_AUTH_TOKEN || null,
    allowInsecureNetwork: environmentBoolean(process.env.PB_ALLOW_INSECURE_NETWORK, false),
    trustedLocalWeb: environmentBoolean(process.env.PB_TRUST_LOCAL_WEB, false),
    trustedWebClients: environmentList(process.env.PB_TRUSTED_WEB_CLIENTS),
    trustedWebHosts: environmentList(process.env.PB_TRUSTED_WEB_HOSTS),
    allowPowerActions: environmentBoolean(process.env.PB_ALLOW_POWER_ACTIONS, false),
    powerActionToken: process.env.PB_POWER_ACTION_TOKEN || process.env.PIXEL_POWER_ACTION_TOKEN || null,
    maxActionAudit: Number(process.env.PB_MAX_ACTION_AUDIT || 10_000),
    projectorUsername: process.env.PB_PROJECTOR_CONTROL_USERNAME || "dispadmin",
    projectorPassword: process.env.PB_PROJECTOR_CONTROL_PASSWORD || null,
    projectorPasswordFile: process.env.PB_PROJECTOR_CONTROL_PASSWORD_FILE || null,
    projectorCommandTimeoutMs: Number(process.env.PB_PROJECTOR_COMMAND_TIMEOUT_MS || 3_000),
    projectorCommandGapMs: Number(process.env.PB_PROJECTOR_COMMAND_GAP_MS || 500),
    uvcGeometry: environmentBoolean(process.env.PB_UVC_GEOMETRY_ENABLED, false) ? {
      cameraCommand: process.env.PB_UVC_CAMERA_COMMAND,
      patternCommand: process.env.PB_NDI_PATTERN_COMMAND,
      runtimeDirectory: process.env.PB_NDI_RUNTIME_DIRECTORY,
    } : null,
    ndiVideo: environmentBoolean(process.env.PB_NDI_VIDEO_ENABLED, false) ? {
      command: process.env.PB_NDI_VIDEO_COMMAND,
      probeCommand: process.env.PB_NDI_PROBE_COMMAND,
      runtimeDirectory: process.env.PB_NDI_RUNTIME_DIRECTORY,
      shaderDirectory: process.env.PB_NDI_SHADER_DIRECTORY,
    } : null,
    ndiReceiverProfilesFile: process.env.PB_NDI_RECEIVER_PROFILES_FILE || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { ...defaults, help: true };
    if (argument === "--host") defaults.host = argv[++index];
    else if (argument === "--port") defaults.port = Number(argv[++index]);
    else if (argument === "--data-dir") defaults.dataDir = path.resolve(argv[++index]);
    else if (argument === "--max-upload-bytes") defaults.maxUploadBytes = Number(argv[++index]);
    else if (argument === "--max-json-bytes") defaults.maxJsonBytes = Number(argv[++index]);
    else if (argument === "--allow-insecure-network") defaults.allowInsecureNetwork = true;
    else if (argument === "--allow-power-actions") defaults.allowPowerActions = true;
    else if (argument === "--deny-power-actions") defaults.allowPowerActions = false;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!defaults.host) throw new Error("--host cannot be empty");
  if (!Number.isInteger(defaults.port) || defaults.port < 0 || defaults.port > 65535) throw new Error("--port must be 0-65535");
  if (!Number.isSafeInteger(defaults.maxUploadBytes) || defaults.maxUploadBytes <= 0) {
    throw new Error("--max-upload-bytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(defaults.maxJsonBytes) || defaults.maxJsonBytes < 1024 * 1024 || defaults.maxJsonBytes > 128 * 1024 * 1024) {
    throw new Error("--max-json-bytes must be between 1 MiB and 128 MiB");
  }
  if (!Number.isSafeInteger(defaults.maxActionAudit) || defaults.maxActionAudit < 100) {
    throw new Error("PB_MAX_ACTION_AUDIT must be an integer of at least 100");
  }
  if (!Number.isSafeInteger(defaults.projectorCommandTimeoutMs)
    || defaults.projectorCommandTimeoutMs < 500 || defaults.projectorCommandTimeoutMs > 15_000) {
    throw new Error("PB_PROJECTOR_COMMAND_TIMEOUT_MS must be 500-15000");
  }
  if (!Number.isSafeInteger(defaults.projectorCommandGapMs)
    || defaults.projectorCommandGapMs < 0 || defaults.projectorCommandGapMs > 2_000) {
    throw new Error("PB_PROJECTOR_COMMAND_GAP_MS must be 0-2000");
  }
  return defaults;
}

function usage() {
  return `Pixel Brightness V3 control-plane server

Usage: node runtime/server/index.mjs [options]

  --host <address>          Bind address (default 127.0.0.1)
  --port <number>           HTTP port (default 4100)
  --data-dir <path>         Persistent state and content-addressed media
  --max-upload-bytes <n>    Raw media upload limit
  --max-json-bytes <n>      JSON/project request limit (default 64 MiB)
  --allow-insecure-network  Permit a non-loopback listener without a token (unsafe)
  --allow-power-actions     Permit confirmed reboot/shutdown actions
  --deny-power-actions      Explicitly disable reboot/shutdown (default)
  -h, --help                Show this help

Environment: PB_SERVER_HOST, PB_SERVER_PORT, PB_SERVER_DATA_DIR, PB_MAX_UPLOAD_BYTES, PB_MAX_JSON_BYTES
Local Web Control browser port: PB_WEB_CONTROL_PORT (default 3000)
Unsafe development override: PB_ALLOW_INSECURE_NETWORK
Control authentication: PIXEL_CONTROL_TOKEN or PB_CONTROL_TOKEN_FILE
Render-node authentication: PIXEL_NODE_SIGNING_KEY or PB_NODE_SIGNING_KEY_FILE
Legacy PIXEL_AUTH_TOKEN is rejected; rotate it during the credential split.
Trusted Web Control: PB_TRUST_LOCAL_WEB, PB_TRUSTED_WEB_CLIENTS, PB_TRUSTED_WEB_HOSTS
Fleet controls: PB_ALLOW_POWER_ACTIONS, PB_POWER_ACTION_TOKEN, PB_MAX_ACTION_AUDIT
Panasonic LAN control: PB_PROJECTOR_CONTROL_USERNAME, PB_PROJECTOR_CONTROL_PASSWORD or PB_PROJECTOR_CONTROL_PASSWORD_FILE
Panasonic timing: PB_PROJECTOR_COMMAND_TIMEOUT_MS, PB_PROJECTOR_COMMAND_GAP_MS
Experimental Windows geometry: PB_UVC_GEOMETRY_ENABLED, PB_UVC_CAMERA_COMMAND, PB_NDI_PATTERN_COMMAND, PB_NDI_RUNTIME_DIRECTORY
Experimental corrected NDI: PB_NDI_VIDEO_ENABLED, PB_NDI_VIDEO_COMMAND, PB_NDI_PROBE_COMMAND, PB_NDI_SHADER_DIRECTORY
Optional receiver routing: PB_NDI_RECEIVER_PROFILES_FILE (server-local JSON array; credentials referenced by environment name)
`;
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`pixel-brightness-server: ${error.message}\n`);
  process.exitCode = 2;
}

if (options?.help) {
  process.stdout.write(usage());
} else if (options) {
  if (options.legacyAuthToken) {
    throw new Error(
      "PIXEL_AUTH_TOKEN was shared with Render Nodes and cannot retain control authority; "
      + "rotate it into PIXEL_CONTROL_TOKEN and provision per-node credentials",
    );
  }
  const controlToken = await secretValue({
    value: options.controlToken,
    file: options.controlTokenFile,
    label: "Control token",
  });
  const nodeSigningKey = await secretValue({
    value: options.nodeSigningKey,
    file: options.nodeSigningKeyFile,
    label: "Render-node signing key",
  });
  const projectorPassword = await credentialValue({
    value: options.projectorPassword,
    file: options.projectorPasswordFile,
    label: "Panasonic projector control password",
  });
  const service = await createPixelBrightnessServer({
    dataDir: options.dataDir,
    maxUploadBytes: options.maxUploadBytes,
    maxJsonBytes: options.maxJsonBytes,
    controlToken,
    nodeSigningKey,
    allowInsecureNetwork: options.allowInsecureNetwork,
    trustedLocalWeb: options.trustedLocalWeb,
    webControlPort: options.webControlPort,
    trustedWebClients: options.trustedWebClients,
    trustedWebHosts: options.trustedWebHosts,
    allowPowerActions: options.allowPowerActions,
    powerActionToken: options.powerActionToken,
    maxActionAudit: options.maxActionAudit,
    projectorUsername: options.projectorUsername,
    projectorPassword,
    projectorCommandTimeoutMs: options.projectorCommandTimeoutMs,
    projectorCommandGapMs: options.projectorCommandGapMs,
    uvcGeometry: options.uvcGeometry,
    ndiVideo: options.ndiVideo,
    ndiReceiverProfiles: options.ndiReceiverProfilesFile ? JSON.parse(await readFile(path.resolve(options.ndiReceiverProfilesFile), 'utf8')) : [],
    onError: (error) => process.stderr.write(`[server] ${error.stack || error.message}\n`),
  });
  const address = await service.listen({ host: options.host, port: options.port });
  const shownHost = typeof address === "object" && address ? address.address : options.host;
  const shownPort = typeof address === "object" && address ? address.port : options.port;
  process.stdout.write(`Pixel Brightness Server V3 listening on http://${shownHost}:${shownPort}\n`);
  process.stdout.write(`Data: ${service.dataDir}\n`);
  process.stdout.write(`Power actions: ${options.allowPowerActions ? "enabled" : "disabled"}\n`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n${signal}: shutting down Pixel Brightness Server...\n`);
    try {
      await service.close();
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
