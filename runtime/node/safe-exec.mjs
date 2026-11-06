import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolutePlatformPath } from "./platform-contract.mjs";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

function validateExecutable(executable, platform = process.platform) {
  if (typeof executable !== "string" || !isAbsolutePlatformPath(executable, platform) || executable.includes("\0")) {
    throw new SafeExecError("Executable must be an absolute path", { code: "EXECUTABLE_NOT_ALLOWED" });
  }
  return executable;
}

function validateArguments(args) {
  if (!Array.isArray(args) || args.length > 256) {
    throw new SafeExecError("Command arguments must be an array of at most 256 entries", { code: "INVALID_ARGUMENTS" });
  }
  return args.map((argument) => {
    const value = String(argument);
    if (value.includes("\0") || Buffer.byteLength(value) > 16_384) {
      throw new SafeExecError("Command argument is invalid or too large", { code: "INVALID_ARGUMENTS" });
    }
    return value;
  });
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function safeEnvironment(input, inherited = process.env, platform = process.platform) {
  const allowed = [
    "LANG", "LC_ALL", "LC_CTYPE", "PATH", "HOME", "USER", "LOGNAME",
    "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE",
    "DBUS_SESSION_BUS_ADDRESS",
    "SystemRoot", "SYSTEMROOT", "WINDIR", "ProgramData", "PROGRAMDATA", "ProgramFiles", "PROGRAMFILES",
    "USERPROFILE", "USERNAME", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "SESSIONNAME",
    "PIXEL_BRIGHTNESS_TELEMETRY_SERVICES",
  ];
  const environment = {};
  for (const key of allowed) {
    const value = input?.[key] ?? inherited?.[key];
    if (value != null && !String(value).includes("\0")) environment[key] = String(value);
  }
  environment.PATH ||= platform === "win32"
    ? `${environment.SystemRoot || environment.SYSTEMROOT || "C:\\Windows"}\\System32;${environment.SystemRoot || environment.SYSTEMROOT || "C:\\Windows"}`
    : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  if (platform !== "win32") environment.LANG ||= "C.UTF-8";
  return environment;
}

export class SafeExecError extends Error {
  constructor(message, { code = "EXEC_FAILED", executable = null, args = [], exitCode = null, signal = null, stderr = "", cause } = {}) {
    super(message, { cause });
    this.name = "SafeExecError";
    this.code = code;
    this.executable = executable;
    this.args = args;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = stderr;
  }
}

/**
 * Strict execFile wrapper. Every executable must be allowlisted by absolute
 * path, arguments are passed as an argv array, and `shell` is always false.
 */
export class SafeCommandRunner {
  constructor({ allowedExecutables = [], defaultTimeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, execFileImpl = execFile, platform = process.platform } = {}) {
    this.platform = platform;
    this.allowedExecutables = new Set(allowedExecutables.map((executable) => validateExecutable(executable, platform)));
    this.defaultTimeoutMs = boundedInteger(defaultTimeoutMs, DEFAULT_TIMEOUT_MS, 100, 120_000);
    this.maxOutputBytes = boundedInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1024, 16 * 1024 * 1024);
    this.execFileImpl = execFileImpl;
  }

  allow(executable) {
    this.allowedExecutables.add(validateExecutable(executable, this.platform));
    return this;
  }

  async available(executable) {
    const target = validateExecutable(executable, this.platform);
    if (!this.allowedExecutables.has(target)) return false;
    try {
      await access(target, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  run(executable, args = [], options = {}) {
    const target = validateExecutable(executable, this.platform);
    if (!this.allowedExecutables.has(target)) {
      throw new SafeExecError(`Executable is not allowlisted: ${target}`, {
        code: "EXECUTABLE_NOT_ALLOWED",
        executable: target,
      });
    }
    const argv = validateArguments(args);
    const timeoutMs = boundedInteger(options.timeoutMs, this.defaultTimeoutMs, 100, 120_000);
    const maxBuffer = boundedInteger(options.maxOutputBytes, this.maxOutputBytes, 1024, 16 * 1024 * 1024);
    const environment = safeEnvironment(options.env, process.env, this.platform);
    const startedNs = process.hrtime.bigint();
    return new Promise((resolve, reject) => {
      this.execFileImpl(target, argv, {
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer,
        encoding: "utf8",
        cwd: options.cwd,
        env: environment,
      }, (error, stdout = "", stderr = "") => {
        const durationMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
        if (error) {
          const code = error.code === "ENOENT"
            ? "EXECUTABLE_NOT_FOUND"
            : error.killed || error.signal === "SIGKILL"
              ? "EXEC_TIMEOUT"
              : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? "OUTPUT_LIMIT"
                : "EXEC_FAILED";
          reject(new SafeExecError(`${target} failed: ${String(stderr || error.message).trim()}`, {
            code,
            executable: target,
            args: argv,
            exitCode: Number.isInteger(error.code) ? error.code : null,
            signal: error.signal || null,
            stderr: String(stderr).slice(0, 4096),
            cause: error,
          }));
          return;
        }
        resolve({
          executable: target,
          args: argv,
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: 0,
          durationMs,
        });
      });
    });
  }
}

export { safeEnvironment };
