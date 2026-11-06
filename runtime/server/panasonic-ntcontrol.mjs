import { createHash } from "node:crypto";
import { createConnection as createTcpConnection } from "node:net";

export const PANASONIC_NTCONTROL_DEFAULT_PORT = 1024;

export const PANASONIC_NTCONTROL_COMMANDS = Object.freeze([
  "PON",
  "POF",
  "QPW",
  "QSH",
  "QIN",
  "Q$S",
  "Q$L",
  "OSH:0",
  "OSH:1",
  "IIS:HD1",
  "IIS:HD2",
  "IIS:DL1",
]);

const ALLOWED_COMMANDS = new Set(PANASONIC_NTCONTROL_COMMANDS);
const MUTATING_COMMANDS = new Set([
  "PON",
  "POF",
  "OSH:0",
  "OSH:1",
  "IIS:HD1",
  "IIS:HD2",
  "IIS:DL1",
]);
const MAX_FRAME_BYTES = 4_096;

const DEVICE_ERRORS = Object.freeze({
  ERR1: {
    code: "PANASONIC_UNDEFINED_COMMAND",
    message: "The projector rejected an undefined command",
    retryable: false,
  },
  ERR2: {
    code: "PANASONIC_PARAMETER_OUT_OF_RANGE",
    message: "The projector rejected a command parameter",
    retryable: false,
  },
  ERR3: {
    code: "PANASONIC_PROJECTOR_BUSY",
    message: "The projector is busy or cannot accept this command yet",
    retryable: true,
  },
  ERR4: {
    code: "PANASONIC_PROJECTOR_TIMEOUT",
    message: "The projector could not complete the command in time",
    retryable: true,
  },
  ERR5: {
    code: "PANASONIC_INVALID_COMMAND_LENGTH",
    message: "The projector rejected the command length",
    retryable: false,
  },
  ERRA: {
    code: "PANASONIC_AUTH_FAILED",
    message: "The projector rejected the administrator credentials",
    retryable: false,
  },
});

function containsControl(value) {
  for (const character of String(value ?? "")) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeErrorText(value, fallback) {
  let sanitized = "";
  for (const character of String(value ?? "")) {
    const code = character.charCodeAt(0);
    sanitized += code <= 0x1f || code === 0x7f ? " " : character;
  }
  const text = sanitized.trim().slice(0, 512);
  return text || fallback;
}

export class PanasonicNtControlError extends Error {
  constructor(message, code = "PANASONIC_NTCONTROL_FAILED", {
    phase = null,
    deviceCode = null,
    retryable = false,
    outcomeUnknown = false,
    cause = undefined,
  } = {}) {
    super(safeErrorText(message, "Panasonic projector command failed"), cause ? { cause } : undefined);
    this.name = "PanasonicNtControlError";
    this.code = code;
    this.phase = phase;
    this.deviceCode = deviceCode;
    this.retryable = Boolean(retryable);
    this.outcomeUnknown = Boolean(outcomeUnknown);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      phase: this.phase,
      deviceCode: this.deviceCode,
      retryable: this.retryable,
      outcomeUnknown: this.outcomeUnknown,
    };
  }
}

function invalidArgument(message) {
  return new PanasonicNtControlError(message, "PANASONIC_INVALID_ARGUMENT", { phase: "validation" });
}

function normalizeOptions(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidArgument("Panasonic command options must be an object");
  }
  const host = typeof input.host === "string" ? input.host : "";
  if (!host || host.length > 255 || /\s/.test(host) || containsControl(host)) {
    throw invalidArgument("Panasonic projector host is invalid");
  }
  const port = input.port == null ? PANASONIC_NTCONTROL_DEFAULT_PORT : Number(input.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw invalidArgument("Panasonic projector port must be an integer from 1 to 65535");
  }
  if (typeof input.command !== "string" || !ALLOWED_COMMANDS.has(input.command)) {
    throw invalidArgument("Panasonic projector command is not allowlisted");
  }
  const timeoutMs = input.timeoutMs == null ? 3_000 : Number(input.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw invalidArgument("Panasonic projector timeoutMs must be an integer from 1 to 120000");
  }
  if (input.createConnection != null && typeof input.createConnection !== "function") {
    throw invalidArgument("Panasonic createConnection must be a function");
  }
  if (input.signal != null
      && (typeof input.signal !== "object"
        || typeof input.signal.addEventListener !== "function"
        || typeof input.signal.removeEventListener !== "function")) {
    throw invalidArgument("Panasonic signal must be an AbortSignal");
  }
  return {
    host,
    port,
    command: input.command,
    timeoutMs,
    username: input.username,
    password: input.password,
    createConnection: input.createConnection || createTcpConnection,
    signal: input.signal || null,
  };
}

function credential(value, field) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256
      || containsControl(value)) {
    throw new PanasonicNtControlError(
      `Panasonic protected mode requires a valid ${field}`,
      "PANASONIC_CREDENTIALS_REQUIRED",
      { phase: "authentication" },
    );
  }
  return value;
}

function parseGreeting(frame) {
  if (frame === "NTCONTROL 0") return { protected: false, nonce: null };
  const protectedMatch = /^NTCONTROL 1 ([0-9a-fA-F]{8})$/.exec(frame);
  if (protectedMatch) return { protected: true, nonce: protectedMatch[1] };
  throw new PanasonicNtControlError(
    "Projector returned an invalid NTCONTROL greeting",
    "PANASONIC_PROTOCOL_ERROR",
    { phase: "greeting" },
  );
}

function deviceError(frame, command) {
  const mapped = DEVICE_ERRORS[frame];
  if (!mapped) return null;
  return new PanasonicNtControlError(mapped.message, mapped.code, {
    phase: "response",
    deviceCode: frame,
    retryable: mapped.retryable && !MUTATING_COMMANDS.has(command),
    outcomeUnknown: false,
  });
}

function validateResponse(command, response) {
  const valid = (() => {
    switch (command) {
      case "QPW":
        return /^(?:000|001)$/.test(response);
      case "QSH":
        return /^[01]$/.test(response);
      case "QIN":
        return /^(?:RG1|RG2|HD1|HD2|DL1(?::(?:PC1|PC2|VID|HD1|HD2|SVD))?|MV1|NWP)$/.test(response);
      case "Q$S":
        return /^[0-3]$/.test(response);
      case "Q$L":
        return /^\d{1,5}$/.test(response) && Number(response) <= 99_999;
      default:
        // Control-command acknowledgements vary by projector firmware. Their
        // framing and printable-ASCII constraints are still enforced here.
        return response.length > 0;
    }
  })();
  if (!valid) {
    throw new PanasonicNtControlError(
      "Projector returned an invalid response for the requested command",
      "PANASONIC_PROTOCOL_ERROR",
      { phase: "response" },
    );
  }
  return response;
}

function networkError(error, phase, command) {
  if (error instanceof PanasonicNtControlError) return error;
  const systemCode = typeof error?.code === "string" ? error.code.slice(0, 64) : null;
  const suffix = systemCode ? ` (${systemCode})` : "";
  return new PanasonicNtControlError(
    `Panasonic projector connection failed${suffix}`,
    "PANASONIC_CONNECTION_FAILED",
    {
      phase,
      retryable: !MUTATING_COMMANDS.has(command) || phase !== "response",
      outcomeUnknown: phase === "response" && MUTATING_COMMANDS.has(command),
      cause: error instanceof Error ? error : undefined,
    },
  );
}

function frameText(frame, phase) {
  for (const byte of frame) {
    if (byte < 0x20 || byte > 0x7e) {
      throw new PanasonicNtControlError(
        "Projector returned non-ASCII control data",
        "PANASONIC_PROTOCOL_ERROR",
        { phase },
      );
    }
  }
  return frame.toString("ascii");
}

/**
 * Sends exactly one allowlisted Panasonic NTCONTROL command over one TCP
 * connection. A new call always creates a new connection, as required by the
 * PT-VMZ51 command-control flow. The returned response excludes the `00` wire
 * header, and no credential or authentication digest is exposed.
 */
export function sendPanasonicCommand(input = {}) {
  let options;
  try {
    options = normalizeOptions(input);
  } catch (error) {
    return Promise.reject(error);
  }

  const {
    host,
    port,
    command,
    timeoutMs,
    username,
    password,
    createConnection,
    signal,
  } = options;

  return new Promise((resolve, reject) => {
    let socket = null;
    let phase = "connect";
    let pending = Buffer.alloc(0);
    let settled = false;
    let protectedMode = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (socket) {
        socket.removeListener("connect", onConnect);
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        socket.removeListener("end", onEnd);
        socket.removeListener("close", onClose);
        if (!socket.destroyed) socket.destroy();
      }
    };

    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };

    const failProtocol = (message) => finish(new PanasonicNtControlError(
      message,
      "PANASONIC_PROTOCOL_ERROR",
      { phase },
    ));

    const onAbort = () => finish(new PanasonicNtControlError(
      "Panasonic projector command was aborted",
      "PANASONIC_ABORTED",
      {
        phase,
        outcomeUnknown: phase === "response" && MUTATING_COMMANDS.has(command),
      },
    ));

    const onConnect = () => {
      phase = "greeting";
      socket.setNoDelay?.(true);
    };

    const sendCommand = ({ protected: isProtected, nonce }) => {
      protectedMode = isProtected;
      let authentication = "";
      if (isProtected) {
        let safeUsername;
        let safePassword;
        try {
          safeUsername = credential(username, "username");
          safePassword = credential(password, "password");
        } catch (error) {
          finish(error);
          return;
        }
        authentication = createHash("md5")
          .update(`${safeUsername}:${safePassword}:${nonce}`, "utf8")
          .digest("hex");
      }
      phase = "response";
      const wire = Buffer.from(`${authentication}00${command}\r`, "ascii");
      try {
        socket.write(wire, (error) => {
          if (error) finish(networkError(error, phase, command));
        });
      } catch (error) {
        finish(networkError(error, phase, command));
      }
    };

    const acceptFrame = (frame) => {
      let text;
      try {
        text = frameText(frame, phase);
      } catch (error) {
        finish(error);
        return;
      }
      if (phase === "greeting") {
        let greeting;
        try {
          greeting = parseGreeting(text);
        } catch (error) {
          finish(error);
          return;
        }
        sendCommand(greeting);
        return;
      }
      if (phase !== "response") {
        failProtocol("Projector sent data before the NTCONTROL connection was ready");
        return;
      }
      const projectorError = deviceError(text, command);
      if (projectorError) {
        finish(projectorError);
        return;
      }
      if (!text.startsWith("00")) {
        failProtocol("Projector response is missing the NTCONTROL header");
        return;
      }
      let response;
      try {
        response = validateResponse(command, text.slice(2));
      } catch (error) {
        finish(error);
        return;
      }
      finish(null, {
        command,
        response,
        protected: protectedMode,
      });
    };

    const onData = (chunkInput) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(chunkInput) ? chunkInput : Buffer.from(chunkInput);
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      if (pending.length > MAX_FRAME_BYTES) {
        failProtocol("Projector response exceeded the NTCONTROL frame limit");
        return;
      }
      const terminator = pending.indexOf(0x0d);
      if (terminator < 0) {
        for (const byte of pending) {
          if (byte < 0x20 || byte > 0x7e) {
            failProtocol("Projector returned an invalid unterminated NTCONTROL frame");
            return;
          }
        }
        return;
      }
      if (terminator !== pending.length - 1) {
        failProtocol("Projector returned more than one NTCONTROL frame");
        return;
      }
      const frame = pending.subarray(0, terminator);
      pending = Buffer.alloc(0);
      acceptFrame(frame);
    };

    const onError = (error) => finish(networkError(error, phase, command));
    const closed = () => {
      if (settled) return;
      finish(new PanasonicNtControlError(
        "Projector closed the NTCONTROL connection before replying",
        "PANASONIC_CONNECTION_CLOSED",
        {
          phase,
          retryable: !MUTATING_COMMANDS.has(command) || phase !== "response",
          outcomeUnknown: phase === "response" && MUTATING_COMMANDS.has(command),
        },
      ));
    };
    const onEnd = () => closed();
    const onClose = () => closed();

    const timer = setTimeout(() => finish(new PanasonicNtControlError(
      `Panasonic projector ${phase} timed out after ${timeoutMs} ms`,
      "PANASONIC_TIMEOUT",
      {
        phase,
        retryable: !MUTATING_COMMANDS.has(command) || phase !== "response",
        outcomeUnknown: phase === "response" && MUTATING_COMMANDS.has(command),
      },
    )), timeoutMs);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const candidate = createConnection({ host, port });
      if (!candidate
        || typeof candidate.on !== "function"
        || typeof candidate.once !== "function"
        || typeof candidate.removeListener !== "function"
        || typeof candidate.write !== "function"
        || typeof candidate.destroy !== "function") {
        throw new TypeError("createConnection did not return a socket");
      }
      socket = candidate;
      socket.once("connect", onConnect);
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("end", onEnd);
      socket.once("close", onClose);
    } catch (error) {
      finish(networkError(error, phase, command));
    }
  });
}
