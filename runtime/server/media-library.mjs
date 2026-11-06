import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { HttpError, badRequest, notFound } from "./errors.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function validateSha256(value) {
  const sha256 = String(value ?? "").toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw badRequest("Invalid SHA-256 digest", "invalid_sha256");
  return sha256;
}

export function safeFileName(value) {
  let decoded = String(value ?? "").trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the original header value when it is not URI encoded.
  }
  decoded = decoded.replaceAll("\\", "/");
  const name = [...path.posix.basename(decoded)]
    .filter((character) => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127)
    .join("")
    .trim();
  if (!name || name === "." || name === "..") {
    throw badRequest("x-file-name must contain a safe file name", "invalid_file_name");
  }
  return name.slice(0, 255);
}

export class MediaLibrary {
  constructor(store, {
    maxUploadBytes = 20 * 1024 * 1024 * 1024,
    syncFile = null,
    syncDirectory = null,
  } = {}) {
    this.store = store;
    this.maxUploadBytes = maxUploadBytes;
    this.syncFile = syncFile;
    this.syncDirectory = syncDirectory;
  }

  assetPath(sha256) {
    return path.join(this.store.assetsDir, validateSha256(sha256));
  }

  async #syncFile(pathname) {
    if (this.syncFile) return this.syncFile(pathname);
    // Windows FlushFileBuffers requires a writable handle; r+ never truncates.
    const handle = await open(pathname, process.platform === "win32" ? "r+" : "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #syncAssetsDirectory() {
    if (this.syncDirectory) return this.syncDirectory(this.store.assetsDir);
    let handle;
    try {
      handle = await open(this.store.assetsDir, "r");
      await handle.sync();
    } catch (error) {
      // Windows does not expose durable directory handles through node:fs on
      // every supported runtime. Never suppress an ordinary I/O failure.
      if (!new Set(["EISDIR", "EINVAL", "EPERM", "EACCES", "ENOTSUP"]).has(error?.code)) throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async #verifiedExistingAsset(pathname, expectedSha256, expectedSize) {
    let fileStat;
    try {
      fileStat = await lstat(pathname);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (!fileStat.isFile() || fileStat.size !== expectedSize) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(pathname)) hash.update(chunk);
    return hash.digest("hex") === expectedSha256;
  }

  async #publishVerifiedAsset(temporaryPath, destination, sha256, size) {
    if (await this.#verifiedExistingAsset(destination, sha256, size)) {
      await rm(temporaryPath, { force: true });
      // A valid file can be the result of an earlier attempt that crashed
      // after rename but before its directory entry was flushed.
      await this.#syncAssetsDirectory();
      return;
    }

    const quarantinePath = `${destination}.corrupt-${process.pid}-${randomUUID()}`;
    let quarantined = false;
    try {
      try {
        await rename(destination, quarantinePath);
        quarantined = true;
        await this.#syncAssetsDirectory();
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      try {
        await rename(temporaryPath, destination);
      } catch (error) {
        // Concurrent same-digest uploads may publish the same verified bytes
        // first on platforms that do not replace an existing destination.
        if (await this.#verifiedExistingAsset(destination, sha256, size)) {
          await rm(temporaryPath, { force: true });
        } else {
          throw error;
        }
      }
      await this.#syncAssetsDirectory();
      if (quarantined) {
        await rm(quarantinePath, { force: true });
        await this.#syncAssetsDirectory();
      }
    } catch (error) {
      if (quarantined) {
        try {
          const destinationExists = await this.#verifiedExistingAsset(destination, sha256, size);
          if (!destinationExists) {
            await rename(quarantinePath, destination);
            await this.#syncAssetsDirectory();
          }
        } catch {
          // Preserve the original publication error. The quarantined corrupt
          // payload remains operator-visible and is never accepted as valid.
        }
      }
      throw error;
    }
  }

  async upload(request, { fileName, mimeType, declaredSha256 = null } = {}) {
    const name = safeFileName(fileName);
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxUploadBytes) {
      throw new HttpError(413, "upload_too_large", `Upload exceeds the ${this.maxUploadBytes} byte limit`);
    }

    const temporaryPath = path.join(this.store.uploadsDir, `${process.pid}-${randomUUID()}.upload`);
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform: (chunk, _encoding, callback) => {
        size += chunk.length;
        if (size > this.maxUploadBytes) {
          callback(new HttpError(413, "upload_too_large", `Upload exceeds the ${this.maxUploadBytes} byte limit`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(request, meter, createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }));
      if (size === 0) throw badRequest("Media upload is empty", "empty_upload");
      const sha256 = hash.digest("hex");
      if (declaredSha256 && validateSha256(declaredSha256) !== sha256) {
        throw badRequest("Uploaded bytes do not match x-content-sha256", "checksum_mismatch");
      }
      const destination = this.assetPath(sha256);
      await this.#syncFile(temporaryPath);
      await this.#publishVerifiedAsset(temporaryPath, destination, sha256, size);

      const now = new Date().toISOString();
      const metadata = await this.store.transaction((state) => {
        const existing = state.media[sha256];
        const names = Array.from(new Set([...(existing?.names ?? []), name])).slice(-32);
        state.media[sha256] = {
          sha256,
          name: existing?.name ?? name,
          names,
          size,
          mimeType: String(mimeType || existing?.mimeType || "application/octet-stream").slice(0, 255),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        return state.media[sha256];
      });
      return metadata;
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async describe(sha256) {
    const digest = validateSha256(sha256);
    const filePath = this.assetPath(digest);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") throw notFound("Media asset not found", "asset_not_found");
      throw error;
    }
    const metadata = this.store.state.media[digest];
    return {
      sha256: digest,
      filePath,
      size: fileStat.size,
      mimeType: metadata?.mimeType ?? "application/octet-stream",
      name: metadata?.name ?? digest,
    };
  }

  createReadStream(filePath, options) {
    return createReadStream(filePath, options);
  }
}
