import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SHA_PATTERN = /^[a-f0-9]{64}$/;
const PREFIX_PATTERN = /^[a-f0-9]{2}$/;

function normalizeSha(value) {
  const sha = String(value || "").toLowerCase().replace(/^sha256:/, "");
  if (!SHA_PATTERN.test(sha)) throw new Error(`Invalid SHA-256 asset id: ${value}`);
  return sha;
}

function normalizeByteLimit(value, fallback, label) {
  const bytes = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return bytes;
}

function sizeHint(value) {
  if (value === undefined || value === null || value === "") return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

function isCanonicalAssetPath(pathname) {
  const name = basename(pathname);
  const prefix = basename(dirname(pathname));
  return SHA_PATTERN.test(name) && PREFIX_PATTERN.test(prefix) && name.startsWith(prefix);
}

function isMetadataPath(pathname) {
  const name = basename(pathname);
  const prefix = basename(dirname(pathname));
  const match = /^([a-f0-9]{64})\.json(?:\.[^.]+(?:\.[^.]+)?\.tmp)?$/.exec(name);
  return match != null && PREFIX_PATTERN.test(prefix) && match[1].startsWith(prefix);
}

async function hashFile(pathname) {
  const hash = createHash("sha256");
  const handle = await open(pathname, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.nlink !== 1) {
      throw new AssetCachePathError(`Cached asset is not an exclusive regular file: ${pathname}`, { path: pathname });
    }
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest("hex");
}

async function regularFileDetails(pathname) {
  try {
    const details = await lstat(pathname);
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
      throw new AssetCachePathError(`Cache entry is not an exclusive regular file: ${pathname}`, { path: pathname });
    }
    return details;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export class AssetCachePathError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AssetCachePathError";
    this.code = "ASSET_CACHE_UNSAFE_PATH";
    this.details = details;
  }
}

async function listFiles(root) {
  const files = [];
  const prefixes = await readdir(root, { withFileTypes: true });
  for (const prefix of prefixes) {
    const prefixPath = join(root, prefix.name);
    const prefixDetails = await lstat(prefixPath);
    if (!PREFIX_PATTERN.test(prefix.name)
      || !prefix.isDirectory()
      || prefix.isSymbolicLink()
      || !prefixDetails.isDirectory()
      || prefixDetails.isSymbolicLink()) {
      throw new AssetCachePathError(`Unsafe cache prefix entry: ${prefixPath}`, { path: prefixPath });
    }
    const entries = await readdir(prefixPath, { withFileTypes: true });
    for (const entry of entries) {
      const pathname = join(prefixPath, entry.name);
      const details = await lstat(pathname);
      if (!entry.isFile() || entry.isSymbolicLink() || !details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
        throw new AssetCachePathError(`Unsafe cache payload entry: ${pathname}`, { path: pathname });
      }
      files.push(pathname);
    }
  }
  return files;
}

function samePath(first, second) {
  const left = resolve(first);
  const right = resolve(second);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function pathIsWithin(parent, child) {
  const offset = relative(parent, child);
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
}

function boundedMetadataText(value, maximumLength) {
  if (value === undefined || value === null || value === "") return null;
  return String(value).slice(0, maximumLength);
}

export class AssetCacheCapacityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AssetCacheCapacityError";
    this.code = "ASSET_CACHE_CAPACITY_EXCEEDED";
    this.details = details;
  }
}

export class AssetCache {
  constructor({
    root,
    client,
    maxAssetBytes = 50 * 1024 * 1024 * 1024,
    maxCacheBytes = 100 * 1024 * 1024 * 1024,
    syncDirectory = null,
    log = () => {},
  }) {
    if (typeof root !== "string" || root.length === 0) throw new Error("Asset cache root is required");
    this.root = resolve(root);
    this.contentRoot = join(this.root, "sha256");
    this.canonicalRoot = null;
    this.canonicalContentRoot = null;
    this.client = client;
    this.maxAssetBytes = normalizeByteLimit(maxAssetBytes, 50 * 1024 * 1024 * 1024, "maxAssetBytes");
    this.maxCacheBytes = normalizeByteLimit(maxCacheBytes, 100 * 1024 * 1024 * 1024, "maxCacheBytes");
    this.syncDirectory = syncDirectory;
    this.log = log;
    this.inflight = new Map();
    this.occupied = new Map();
    this.committedBytes = 0;
    this.reservedBytes = 0;
    this.orphanedBytes = 0;
    this.initialization = null;
    this.stats = { files: 0, bytes: 0, downloads: 0, failures: 0, verified: 0 };
  }

  initialize() {
    if (!this.initialization) this.initialization = this.#initializeOnce();
    return this.initialization;
  }

  async #initializeOnce() {
    await mkdir(this.root, { recursive: true });
    const rootDetails = await lstat(this.root);
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
      throw new AssetCachePathError(`Asset cache root must be a real directory: ${this.root}`, { path: this.root });
    }
    this.canonicalRoot = await realpath(this.root);
    try {
      await mkdir(this.contentRoot);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await this.#assertCacheTopology();
    const files = await listFiles(this.contentRoot);
    for (const pathname of files) {
      const details = await regularFileDetails(pathname);
      if (isMetadataPath(pathname)) continue;
      if (isCanonicalAssetPath(pathname)) {
        this.#recordOccupied(pathname, details.size, { sha256: basename(pathname) });
      } else {
        // A crash-left partial or unknown regular file still consumes cache
        // payload capacity. Keep it in place and fail closed rather than
        // deleting something another operator may need for diagnosis.
        this.#recordOccupied(pathname, details.size, { orphan: true });
      }
    }
    this.log("info", "asset.cache.inventory", this.#capacitySnapshot());
    return this.snapshot();
  }

  pathFor(value) {
    const sha = normalizeSha(value);
    return join(this.contentRoot, sha.slice(0, 2), sha);
  }

  async #assertCacheTopology() {
    const rootDetails = await lstat(this.root);
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
      throw new AssetCachePathError(`Asset cache root is no longer a real directory: ${this.root}`, { path: this.root });
    }
    const currentRoot = await realpath(this.root);
    if (this.canonicalRoot && !samePath(currentRoot, this.canonicalRoot)) {
      throw new AssetCachePathError(`Asset cache root changed after initialization: ${this.root}`, { path: this.root });
    }
    this.canonicalRoot ||= currentRoot;

    const contentDetails = await lstat(this.contentRoot);
    if (!contentDetails.isDirectory() || contentDetails.isSymbolicLink()) {
      throw new AssetCachePathError(`Asset cache content root must be a real directory: ${this.contentRoot}`, { path: this.contentRoot });
    }
    const currentContentRoot = await realpath(this.contentRoot);
    if (!pathIsWithin(this.canonicalRoot, currentContentRoot)
      || (this.canonicalContentRoot && !samePath(currentContentRoot, this.canonicalContentRoot))) {
      throw new AssetCachePathError(`Asset cache content root escaped or changed: ${this.contentRoot}`, { path: this.contentRoot });
    }
    this.canonicalContentRoot ||= currentContentRoot;
  }

  async #assertSafePrefix(sha, { create = false } = {}) {
    await this.#assertCacheTopology();
    const prefixPath = join(this.contentRoot, sha.slice(0, 2));
    if (create) {
      try {
        await mkdir(prefixPath);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    let details;
    try {
      details = await lstat(prefixPath);
    } catch (error) {
      if (!create && error.code === "ENOENT") return null;
      throw error;
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new AssetCachePathError(`Asset cache prefix must be a real directory: ${prefixPath}`, { path: prefixPath });
    }
    const canonicalPrefix = await realpath(prefixPath);
    if (!pathIsWithin(this.canonicalContentRoot, canonicalPrefix)
      || !samePath(dirname(canonicalPrefix), this.canonicalContentRoot)
      || basename(canonicalPrefix) !== sha.slice(0, 2)) {
      throw new AssetCachePathError(`Asset cache prefix escaped its canonical root: ${prefixPath}`, { path: prefixPath });
    }
    return prefixPath;
  }

  async #syncAssetDirectory(pathname) {
    const sha = basename(pathname);
    if (!SHA_PATTERN.test(sha)) {
      throw new AssetCachePathError(`Cannot sync a non-canonical asset path: ${pathname}`, { path: pathname });
    }
    await this.#assertSafePrefix(sha);
    const directory = dirname(pathname);
    if (this.syncDirectory) return this.syncDirectory(directory);
    let handle;
    try {
      handle = await open(directory, "r");
      await handle.sync();
    } catch (error) {
      if (!["EISDIR", "EINVAL", "EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async has(value, { verify = false } = {}) {
    await this.initialize();
    const sha = normalizeSha(value);
    const pathname = this.pathFor(sha);
    const prefix = await this.#assertSafePrefix(sha);
    if (!prefix) {
      this.#removeOccupied(pathname);
      return false;
    }
    const details = await regularFileDetails(pathname);
    if (!details) {
      this.#removeOccupied(pathname);
      return false;
    }
    this.#recordOccupied(pathname, details.size, { sha256: sha });
    if (verify && await hashFile(pathname) !== sha) {
      try {
        await this.#assertSafePrefix(sha);
        await unlink(pathname);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw new Error(`Cannot remove corrupt cached asset ${sha}: ${error.message}`, { cause: error });
        }
      }
      this.#removeOccupied(pathname);
      return false;
    }
    if (verify) this.stats.verified += 1;
    return true;
  }

  ensure(asset) {
    const sha = normalizeSha(asset?.sha256 || asset?.sha || asset?.hash || asset?.id);
    if (!this.inflight.has(sha)) {
      const task = this.#ensureOne({ ...asset, sha256: sha }).finally(() => this.inflight.delete(sha));
      this.inflight.set(sha, task);
    }
    return this.inflight.get(sha);
  }

  async #ensureOne(asset) {
    await this.initialize();
    const sha = asset.sha256;
    const finalPath = this.pathFor(sha);
    if (await this.has(sha, { verify: true })) {
      // This may be a verified entry left by an earlier attempt that crashed
      // after rename but before the directory entry became durable.
      await this.#syncAssetDirectory(finalPath);
      return { sha256: sha, path: finalPath, cached: true };
    }

    const effectiveAssetLimit = Math.min(this.maxAssetBytes, this.maxCacheBytes);
    const advertisedAssetSize = sizeHint(asset.size);
    if (advertisedAssetSize !== null && advertisedAssetSize > effectiveAssetLimit) {
      this.stats.failures += 1;
      throw this.#capacityError(sha, advertisedAssetSize, "asset manifest size");
    }

    const reservation = { sha256: sha, bytes: 0, closed: false };
    let temporaryPath = null;
    let handle;
    let response;
    let published = false;
    let downloadedBytes = 0;
    try {
      // Unknown-length bodies reserve the complete effective per-asset ceiling.
      // A supplied size reserves at least that amount before the HTTP request.
      this.#reserveTo(reservation, advertisedAssetSize ?? effectiveAssetLimit, "asset manifest size");
      await this.#assertSafePrefix(sha, { create: true });
      temporaryPath = `${finalPath}.${process.pid}.${randomUUID()}.partial`;
      const source = asset.url || asset.downloadUrl || this.client.assetUrl(sha);
      this.log("info", "asset.download.start", { sha256: sha, source, name: asset.name || null });
      response = await this.client.download(source, Number(asset.timeoutMs || 120_000));
      const responseSize = sizeHint(response.headers.get("content-length"));
      if (responseSize !== null) {
        if (responseSize > effectiveAssetLimit) {
          throw this.#capacityError(sha, responseSize, "HTTP Content-Length");
        }
        this.#reserveTo(reservation, Math.max(reservation.bytes, responseSize), "HTTP Content-Length");
      }

      handle = await open(temporaryPath, "wx", 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        const nextBytes = bytes + buffer.length;
        if (!Number.isSafeInteger(nextBytes) || nextBytes > effectiveAssetLimit) {
          throw this.#capacityError(sha, nextBytes, "downloaded body");
        }
        // A lying Content-Length can only consume disk after the extra bytes
        // have been atomically reserved against every other in-flight asset.
        this.#reserveTo(reservation, nextBytes, "downloaded body");
        hash.update(buffer);
        await handle.writeFile(buffer);
        bytes = nextBytes;
      }
      await handle.sync();
      await handle.close();
      handle = null;
      const actual = hash.digest("hex");
      downloadedBytes = bytes;
      if (actual !== sha) throw new Error(`SHA-256 mismatch for ${sha}; received ${actual}`);

      // A second process is unsupported, but if one published the same valid
      // SHA while this process downloaded it, retain that copy and discard only
      // our private partial rather than replacing a cached asset.
      if (await this.has(sha, { verify: true })) {
        await unlink(temporaryPath).catch(() => {});
        temporaryPath = null;
        await this.#syncAssetDirectory(finalPath);
        this.#releaseReservation(reservation);
        return { sha256: sha, path: finalPath, cached: true };
      }

      await this.#assertSafePrefix(sha);
      await rename(temporaryPath, finalPath);
      temporaryPath = null;
      published = true;
      await this.#syncAssetDirectory(finalPath);
      this.#commitReservation(reservation, finalPath, bytes, sha);
      await this.#writeMetadata(finalPath, { ...asset, bytes, cachedAt: new Date().toISOString() });
      this.stats.downloads += 1;
      this.stats.verified += 1;
      this.log("info", "asset.download.complete", { sha256: sha, bytes });
      return { sha256: sha, path: finalPath, cached: false, bytes };
    } catch (error) {
      this.stats.failures += 1;
      try {
        await response?.body?.cancel?.(error);
      } catch (cancelError) {
        this.log("warn", "asset.download.cancel.failed", { sha256: sha, error: cancelError.message });
      }
      await handle?.close().catch(() => {});
      if (temporaryPath) await this.#removePartialOrAccount(temporaryPath, reservation);
      if (published && !reservation.closed) {
        // rename() already made the verified payload reachable. A later
        // directory-sync failure means durability is unknown, not that the
        // bytes disappeared. Retain exact capacity ownership until a retry
        // verifies and syncs the final entry.
        this.#commitReservation(reservation, finalPath, downloadedBytes, sha);
      }
      this.#releaseReservation(reservation);
      throw error;
    }
  }

  #capacityError(sha256, requestedBytes, source) {
    return new AssetCacheCapacityError(
      `Asset ${sha256} cannot reserve ${requestedBytes} bytes from the configured ${this.maxCacheBytes} byte cache`,
      {
        sha256,
        source,
        requestedBytes,
        ...this.#capacitySnapshot(),
      },
    );
  }

  #reserveTo(reservation, targetBytes, source) {
    if (reservation.closed) throw new Error(`Asset reservation for ${reservation.sha256} is already closed`);
    if (!Number.isSafeInteger(targetBytes) || targetBytes < 0) {
      throw this.#capacityError(reservation.sha256, targetBytes, source);
    }
    if (targetBytes <= reservation.bytes) return;
    const additionalBytes = targetBytes - reservation.bytes;
    if (this.committedBytes + this.reservedBytes + additionalBytes > this.maxCacheBytes) {
      throw this.#capacityError(reservation.sha256, targetBytes, source);
    }
    reservation.bytes = targetBytes;
    this.reservedBytes += additionalBytes;
  }

  #releaseReservation(reservation) {
    if (reservation.closed) return;
    this.reservedBytes -= reservation.bytes;
    reservation.bytes = 0;
    reservation.closed = true;
  }

  #commitReservation(reservation, pathname, bytes, sha256) {
    if (bytes > reservation.bytes) {
      throw new Error(`Asset ${sha256} wrote beyond its cache reservation`);
    }
    this.reservedBytes -= reservation.bytes;
    reservation.bytes = 0;
    reservation.closed = true;
    this.#recordOccupied(pathname, bytes, { sha256 });
  }

  async #removePartialOrAccount(pathname, reservation) {
    try {
      await this.#assertSafePrefix(reservation.sha256);
    } catch (error) {
      const accountedBytes = reservation.bytes;
      this.reservedBytes -= reservation.bytes;
      reservation.bytes = 0;
      reservation.closed = true;
      this.#recordOccupied(pathname, accountedBytes, { orphan: true });
      this.log("error", "asset.partial.path-unsafe", {
        path: pathname,
        error: error.message,
        accountedBytes,
      });
      return;
    }
    try {
      await unlink(pathname);
      return;
    } catch (error) {
      if (error.code === "ENOENT") return;
      const details = await regularFileDetails(pathname).catch(() => null);
      const accountedBytes = details?.size ?? reservation.bytes;
      this.reservedBytes -= reservation.bytes;
      reservation.bytes = 0;
      reservation.closed = true;
      this.#recordOccupied(pathname, accountedBytes, { orphan: true });
      this.log("error", "asset.partial.cleanup.failed", {
        path: pathname,
        error: error.message,
        accountedBytes,
      });
    }
  }

  #recordOccupied(pathname, bytes, { sha256 = null, orphan = false } = {}) {
    const existing = this.occupied.get(pathname);
    if (existing) {
      this.committedBytes -= existing.bytes;
      if (existing.sha256) {
        this.stats.files -= 1;
        this.stats.bytes -= existing.bytes;
      }
      if (existing.orphan) this.orphanedBytes -= existing.bytes;
    }
    this.occupied.set(pathname, { bytes, sha256, orphan });
    this.committedBytes += bytes;
    if (sha256) {
      this.stats.files += 1;
      this.stats.bytes += bytes;
    }
    if (orphan) this.orphanedBytes += bytes;
  }

  #removeOccupied(pathname) {
    const existing = this.occupied.get(pathname);
    if (!existing) return;
    this.occupied.delete(pathname);
    this.committedBytes -= existing.bytes;
    if (existing.sha256) {
      this.stats.files -= 1;
      this.stats.bytes -= existing.bytes;
    }
    if (existing.orphan) this.orphanedBytes -= existing.bytes;
  }

  async #writeMetadata(pathname, metadata) {
    const safe = {
      sha256: metadata.sha256,
      name: boundedMetadataText(metadata.name, 1_024),
      mimeType: boundedMetadataText(metadata.mimeType || metadata.type, 255),
      bytes: metadata.bytes,
      cachedAt: metadata.cachedAt,
    };
    await this.#assertSafePrefix(metadata.sha256);
    const temporary = `${pathname}.json.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(safe, null, 2)}\n`, "utf8");
      await handle.close();
      handle = null;
      await this.#assertSafePrefix(metadata.sha256);
      await rename(temporary, `${pathname}.json`);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      // Metadata is bounded and advisory. A verified, atomically published
      // content file remains a valid cache hit even if metadata persistence
      // fails; do not delete or redownload it.
      this.log("warn", "asset.metadata.write.failed", { sha256: metadata.sha256, error: error.message });
    }
  }

  async metadata(value) {
    await this.initialize();
    const sha = normalizeSha(value);
    await this.#assertSafePrefix(sha);
    const pathname = `${this.pathFor(sha)}.json`;
    await regularFileDetails(pathname);
    const handle = await open(pathname, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.nlink !== 1) {
        throw new AssetCachePathError(`Cache metadata is not an exclusive regular file: ${pathname}`, { path: pathname });
      }
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async ensureAll(assets, { concurrency = 3 } = {}) {
    const queue = Array.from(new Map((assets || []).map((asset) => {
      const sha = normalizeSha(asset?.sha256 || asset?.sha || asset?.hash || asset?.id);
      return [sha, { ...asset, sha256: sha }];
    })).values());
    const results = new Array(queue.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await this.ensure(queue[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return results;
  }

  #capacitySnapshot() {
    const availableBytes = Math.max(0, this.maxCacheBytes - this.committedBytes - this.reservedBytes);
    return {
      committedBytes: this.committedBytes,
      reservedBytes: this.reservedBytes,
      capacityBytes: this.maxCacheBytes,
      availableBytes,
      overCapacityBytes: Math.max(0, this.committedBytes + this.reservedBytes - this.maxCacheBytes),
      orphanedBytes: this.orphanedBytes,
    };
  }

  snapshot() {
    return { ...this.stats, ...this.#capacitySnapshot(), inflight: this.inflight.size, root: this.root };
  }
}

export { normalizeSha };
