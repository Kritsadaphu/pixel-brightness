export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message, code = "bad_request", details = undefined) {
  return new HttpError(400, code, message, details);
}

export function notFound(message = "Resource not found", code = "not_found") {
  return new HttpError(404, code, message);
}

export function conflict(message, code = "conflict", details = undefined) {
  return new HttpError(409, code, message, details);
}

export function forbidden(message, code = "forbidden", details = undefined) {
  return new HttpError(403, code, message, details);
}
