import { PROTOCOL_VERSION } from "../shared/protocol.mjs";

export class HttpError extends Error {
  constructor(message, { status = null, body = null, cause = null } = {}) {
    super(message, { cause });
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

async function parseResponse(response) {
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) return response.json();
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class ServerClient {
  constructor({ baseUrl, nodeId, requestTimeoutMs = 10_000, nodeToken = null }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.nodeId = nodeId;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nodeToken = nodeToken;
    this.controllers = new Set();
  }

  url(pathname) {
    return new URL(pathname, `${this.baseUrl}/`).toString();
  }

  async request(pathname, {
    method = "GET",
    body,
    headers = {},
    timeoutMs = this.requestTimeoutMs,
    authenticate = true,
  } = {}) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
    try {
      const authorization = authenticate && this.nodeToken ? { authorization: `Bearer ${this.nodeToken}` } : {};
      const response = await fetch(this.url(pathname), {
        method,
        headers: body === undefined
          ? { ...authorization, ...headers }
          : { ...authorization, "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorBody = await parseResponse(response).catch(() => null);
        throw new HttpError(`Server returned HTTP ${response.status} for ${method} ${pathname}`, {
          status: response.status,
          body: errorBody,
        });
      }
      return parseResponse(response);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(`Cannot reach Pixel Brightness server at ${this.baseUrl}: ${error.message}`, { cause: error });
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  time() {
    return this.request("/v1/time");
  }

  state({ includeProject = true } = {}) {
    return this.request(includeProject ? "/v1/state" : "/v1/state?includeProject=0");
  }

  register(registration) {
    return this.request("/v1/nodes/register", { method: "POST", body: registration });
  }

  heartbeat(payload) {
    return this.request(`/v1/nodes/${encodeURIComponent(this.nodeId)}/heartbeat`, {
      method: "POST",
      body: { protocolVersion: PROTOCOL_VERSION, ...payload },
    });
  }

  pollCommands(after, waitMs) {
    const query = new URLSearchParams({ after: String(after), waitMs: String(waitMs) });
    return this.request(`/v1/nodes/${encodeURIComponent(this.nodeId)}/commands?${query}`, {
      timeoutMs: waitMs + this.requestTimeoutMs,
    });
  }

  submitCameraSurveyPreview(requestId, report) {
    return this.request(
      `/v1/nodes/${encodeURIComponent(this.nodeId)}/camera-survey-previews/${encodeURIComponent(requestId)}/result`,
      {
        method: "POST",
        body: report,
        timeoutMs: Math.max(this.requestTimeoutMs, 60_000),
      },
    );
  }

  assetUrl(sha256) {
    return this.url(`/v1/assets/${encodeURIComponent(sha256)}`);
  }

  async download(url, timeoutMs = 120_000) {
    const absolute = /^https?:\/\//i.test(url) ? url : this.url(url);
    const target = new URL(absolute);
    const server = new URL(this.baseUrl);
    const sameOrigin = target.origin === server.origin;
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      this.controllers.delete(controller);
    };
    timer = setTimeout(() => {
      controller.abort(new Error(`Asset download timed out after ${timeoutMs} ms`));
      release();
    }, timeoutMs);
    timer.unref?.();
    try {
      // Never forward the node bearer credential to a third-party asset URL.
      const headers = sameOrigin && this.nodeToken ? { authorization: `Bearer ${this.nodeToken}` } : {};
      const response = await fetch(target, { headers, signal: controller.signal });
      if (!response.ok) {
        const errorBody = await parseResponse(response).catch(() => null);
        release();
        throw new HttpError(`Server returned HTTP ${response.status} for asset ${target.pathname}`, {
          status: response.status,
          body: errorBody,
        });
      }
      if (!response.body) {
        release();
        throw new HttpError(`Asset response ${target.pathname} did not contain a body`);
      }
      const sourceBody = response.body;
      const trackedBody = {
        async cancel(reason = new Error("Asset body was rejected before completion")) {
          if (!released) controller.abort(reason);
          release();
        },
        async *[Symbol.asyncIterator]() {
          try {
            for await (const chunk of sourceBody) yield chunk;
          } finally {
            release();
          }
        },
      };
      return { ok: true, status: response.status, headers: response.headers, body: trackedBody };
    } catch (error) {
      release();
      if (error instanceof HttpError) throw error;
      throw new HttpError(`Cannot download asset from ${target.origin}: ${error.message}`, { cause: error });
    }
  }

  abort() {
    for (const controller of this.controllers) controller.abort(new Error("Node is shutting down"));
    this.controllers.clear();
  }
}
