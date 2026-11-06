import { HttpError, badRequest } from "./errors.mjs";

export function setCors(response, allowedOrigin = null) {
  if (allowedOrigin) {
    response.setHeader("access-control-allow-origin", allowedOrigin);
    response.setHeader("vary", "Origin");
  }
  response.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization, content-type, if-match, x-file-name, x-content-sha256, x-pixel-token");
  response.setHeader("access-control-expose-headers", "content-length, content-range, accept-ranges, etag");
  response.setHeader("access-control-max-age", "86400");
}

export function sendJson(response, status, value, extraHeaders = {}) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

export function sendNoContent(response, status = 204) {
  response.writeHead(status);
  response.end();
}

export async function readJson(request, maxBytes = 32 * 1024 * 1024) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, "body_too_large", `JSON body exceeds ${maxBytes} bytes`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "body_too_large", `JSON body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("object required");
    }
    return value;
  } catch {
    throw badRequest("Request body must be a JSON object", "invalid_json");
  }
}

export function sendError(response, error, requestId) {
  if (response.headersSent || response.destroyed) {
    response.destroy(error);
    return;
  }
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : "internal_error";
  const message = error instanceof HttpError ? error.message : "Internal server error";
  sendJson(response, status, {
    error: { code, message, ...(error?.details === undefined ? {} : { details: error.details }) },
    requestId,
  });
}

export function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) throw new HttpError(416, "invalid_range", "Invalid byte range");
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new HttpError(416, "invalid_range", "Invalid byte range");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw new HttpError(416, "invalid_range", "Requested range is not satisfiable");
  }
  return { start, end: Math.min(end, size - 1) };
}
