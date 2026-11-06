import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "pbnode.v1";
const SIGNING_DOMAIN = "pixel-brightness/render-node/v1\0";
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function signingKey(value) {
  const key = String(value ?? "");
  if (Buffer.byteLength(key) < 32 || Buffer.byteLength(key) > 512 || key.includes("\0")) {
    throw new Error("Render-node signing key must contain 32-512 bytes and no NUL characters");
  }
  return key;
}

function nodeIdValue(value) {
  const nodeId = String(value ?? "");
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new Error("Render-node id must match [A-Za-z0-9][A-Za-z0-9_.-]{0,63}");
  }
  return nodeId;
}

function signatureFor(nodeId, secret) {
  return createHmac("sha256", signingKey(secret))
    .update(SIGNING_DOMAIN)
    .update(nodeId)
    .digest();
}

/** Create a bearer credential which is cryptographically bound to one node id. */
export function createNodeCredential(nodeIdInput, secret) {
  const nodeId = nodeIdValue(nodeIdInput);
  const encodedNodeId = Buffer.from(nodeId, "utf8").toString("base64url");
  const signature = signatureFor(nodeId, secret).toString("base64url");
  return `${TOKEN_PREFIX}.${encodedNodeId}.${signature}`;
}

/** Decode the asserted identity for local configuration checks (not authentication). */
export function nodeIdFromNodeCredential(tokenInput) {
  const token = String(tokenInput ?? "");
  if (token.length < 32 || token.length > 1024 || token.includes("\0")) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== TOKEN_PREFIX) return null;
  try {
    const nodeBytes = Buffer.from(parts[2], "base64url");
    if (nodeBytes.toString("base64url") !== parts[2]) return null;
    const nodeId = nodeIdValue(nodeBytes.toString("utf8"));
    if (Buffer.from(nodeId, "utf8").toString("base64url") !== parts[2]) return null;
    const signature = Buffer.from(parts[3], "base64url");
    if (signature.length !== 32 || signature.toString("base64url") !== parts[3]) return null;
    return nodeId;
  } catch {
    return null;
  }
}

/** Return the bound node id only when the credential is canonical and authentic. */
export function verifyNodeCredential(tokenInput, secret) {
  let secretValue;
  try {
    secretValue = signingKey(secret);
  } catch {
    return null;
  }
  const token = String(tokenInput ?? "");
  const nodeId = nodeIdFromNodeCredential(token);
  if (!nodeId) return null;
  const parts = token.split(".");
  try {
    const actual = Buffer.from(parts[3], "base64url");
    const expected = signatureFor(nodeId, secretValue);
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? nodeId : null;
  } catch {
    return null;
  }
}

export function validateNodeSigningKey(secret) {
  return signingKey(secret);
}
