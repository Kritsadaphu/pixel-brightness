import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { AssetCache, AssetCacheCapacityError, AssetCachePathError } from "../runtime/node/asset-cache.mjs";
import { loadNodeConfig, nodeHelp } from "../runtime/node/config.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function responseFor(payload, { declaredSize = payload.length, gate = null, onFinally = () => {} } = {}) {
  return {
    headers: new Headers(declaredSize === null ? {} : { "content-length": String(declaredSize) }),
    body: {
      async *[Symbol.asyncIterator]() {
        try {
          if (gate) await gate.promise;
          yield payload;
        } finally {
          onFinally();
        }
      },
    },
  };
}

function cacheClient(download) {
  return {
    assetUrl: (sha) => `/assets/${sha}`,
    download,
  };
}

async function withRoot(name, callback) {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("startup inventory charges canonical payloads and crash-left partials without charging metadata", async () => {
  await withRoot("pb-cache-inventory", async (root) => {
    const payload = Buffer.from("known");
    const sha = sha256(payload);
    const cache = new AssetCache({
      root,
      client: cacheClient(async () => { throw new Error("unexpected download"); }),
      maxAssetBytes: 20,
      maxCacheBytes: 20,
    });
    const pathname = cache.pathFor(sha);
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(pathname, payload);
    await writeFile(`${pathname}.json`, "x".repeat(1_000));
    await writeFile(`${pathname}.123.crash.partial`, "part");

    await cache.initialize();
    assert.deepEqual(cache.snapshot(), {
      files: 1,
      bytes: 5,
      downloads: 0,
      failures: 0,
      verified: 0,
      committedBytes: 9,
      reservedBytes: 0,
      capacityBytes: 20,
      availableBytes: 11,
      overCapacityBytes: 0,
      orphanedBytes: 4,
      inflight: 0,
      root,
    });
    assert.equal(await cache.has(sha, { verify: true }), true);
    assert.equal(cache.snapshot().committedBytes, 9);
  });
});

test("an over-capacity crash inventory fails closed without deleting cached or partial files", async () => {
  await withRoot("pb-cache-overfull", async (root) => {
    const payload = Buffer.from("12345678");
    const sha = sha256(payload);
    const cache = new AssetCache({
      root,
      client: cacheClient(async () => responseFor(Buffer.from("x"))),
      maxAssetBytes: 20,
      maxCacheBytes: 5,
    });
    const pathname = cache.pathFor(sha);
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(pathname, payload);
    await cache.initialize();

    const next = Buffer.from("n");
    await assert.rejects(cache.ensure({ sha256: sha256(next), size: 1 }), (error) => {
      assert.equal(error.code, "ASSET_CACHE_CAPACITY_EXCEEDED");
      return true;
    });
    assert.equal(await cache.has(sha, { verify: true }), true);
    assert.equal(cache.snapshot().overCapacityBytes, 3);
  });
});

test("inventory excludes only prefix-bound metadata and its current crash-temp shape", async () => {
  await withRoot("pb-cache-metadata-inventory", async (root) => {
    const payload = Buffer.from("payload");
    const sha = sha256(payload);
    const pathname = join(root, "sha256", sha.slice(0, 2), sha);
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(pathname, payload);
    await writeFile(`${pathname}.json`, "metadata");
    await writeFile(`${pathname}.json.123.00000000-0000-4000-8000-000000000000.tmp`, "crash-metadata");
    const wrongPrefixSha = `${sha.slice(0, 2) === "ff" ? "ee" : "ff"}${sha.slice(2)}`;
    await writeFile(join(dirname(pathname), `${wrongPrefixSha}.json`), "orphan");

    const cache = new AssetCache({
      root,
      client: cacheClient(async () => { throw new Error("unexpected download"); }),
      maxAssetBytes: 1_000,
      maxCacheBytes: 1_000,
    });
    await cache.initialize();
    assert.equal(cache.snapshot().bytes, payload.length);
    assert.equal(cache.snapshot().orphanedBytes, Buffer.byteLength("orphan"));
    assert.equal(cache.snapshot().committedBytes, payload.length + Buffer.byteLength("orphan"));
  });
});

test("concurrent known-size downloads reserve aggregate capacity before opening a body", async () => {
  await withRoot("pb-cache-concurrent", async (root) => {
    const first = Buffer.from("123456");
    const second = Buffer.from("abcde");
    const firstGate = deferred();
    let firstBodyOpened = false;
    let secondRequested = false;
    const client = cacheClient(async (url) => {
      if (url.endsWith(sha256(first))) {
        return responseFor(first, {
          gate: firstGate,
          onFinally: () => { firstBodyOpened = true; },
        });
      }
      secondRequested = true;
      return responseFor(second);
    });
    const cache = new AssetCache({ root, client, maxAssetBytes: 10, maxCacheBytes: 10 });
    const firstTask = cache.ensure({ sha256: sha256(first), size: first.length });
    await waitFor(() => cache.snapshot().reservedBytes === 6, "first reservation");

    await assert.rejects(cache.ensure({ sha256: sha256(second), size: second.length }), AssetCacheCapacityError);
    assert.equal(secondRequested, false, "a rejected reservation must not issue the HTTP request");
    assert.equal(firstBodyOpened, false);
    firstGate.resolve();
    await firstTask;
    assert.equal(firstBodyOpened, true);
    assert.equal(cache.snapshot().committedBytes, 6);
    assert.equal(cache.snapshot().reservedBytes, 0);
  });
});

test("unknown-size download reserves its full ceiling and releases unused capacity at commit", async () => {
  await withRoot("pb-cache-unknown", async (root) => {
    const payload = Buffer.from("abc");
    const gate = deferred();
    let otherRequested = false;
    const client = cacheClient(async (url) => {
      if (url.endsWith(sha256(payload))) return responseFor(payload, { declaredSize: null, gate });
      otherRequested = true;
      return responseFor(Buffer.from("xyz"));
    });
    const cache = new AssetCache({ root, client, maxAssetBytes: 8, maxCacheBytes: 10 });
    const task = cache.ensure({ sha256: sha256(payload) });
    await waitFor(() => cache.snapshot().reservedBytes === 8, "unknown-size ceiling reservation");

    const other = Buffer.from("xyz");
    await assert.rejects(cache.ensure({ sha256: sha256(other), size: 3 }), AssetCacheCapacityError);
    assert.equal(otherRequested, false);
    gate.resolve();
    await task;
    assert.equal(cache.snapshot().committedBytes, 3);
    assert.equal(cache.snapshot().availableBytes, 7);
  });
});

test("a body larger than Content-Length cannot write past aggregate capacity", async () => {
  await withRoot("pb-cache-misdeclared", async (root) => {
    const existing = Buffer.from("123456");
    const target = Buffer.from("abcde");
    const cache = new AssetCache({
      root,
      client: cacheClient(async () => responseFor(target, { declaredSize: 2 })),
      maxAssetBytes: 10,
      maxCacheBytes: 10,
    });
    const existingPath = cache.pathFor(sha256(existing));
    await mkdir(dirname(existingPath), { recursive: true });
    await writeFile(existingPath, existing);
    await cache.initialize();

    await assert.rejects(cache.ensure({ sha256: sha256(target), size: 2 }), (error) => {
      assert.equal(error.code, "ASSET_CACHE_CAPACITY_EXCEEDED");
      assert.equal(error.details.source, "downloaded body");
      return true;
    });
    assert.equal(cache.snapshot().committedBytes, 6);
    assert.equal(cache.snapshot().reservedBytes, 0);
    const targetDirectory = dirname(cache.pathFor(sha256(target)));
    const leftovers = await readdir(targetDirectory).catch(() => []);
    assert.deepEqual(leftovers, []);
    assert.equal(await cache.has(sha256(existing), { verify: true }), true);
  });
});

test("an oversized response header cancels the unconsumed body and releases its reservation", async () => {
  await withRoot("pb-cache-header", async (root) => {
    const payload = Buffer.from("ok");
    let cancelled = false;
    let consumed = false;
    const cache = new AssetCache({
      root,
      client: cacheClient(async () => ({
        headers: new Headers({ "content-length": "11" }),
        body: {
          async cancel() {
            cancelled = true;
          },
          async *[Symbol.asyncIterator]() {
            consumed = true;
            yield payload;
          },
        },
      })),
      maxAssetBytes: 10,
      maxCacheBytes: 10,
    });
    await assert.rejects(cache.ensure({ sha256: sha256(payload), size: 2 }), AssetCacheCapacityError);
    assert.equal(cancelled, true);
    assert.equal(consumed, false);
    assert.equal(cache.snapshot().reservedBytes, 0);
    assert.equal(cache.snapshot().committedBytes, 0);
  });
});

test("same-SHA callers share one download and capacity reservation", async () => {
  await withRoot("pb-cache-dedupe", async (root) => {
    const payload = Buffer.from("deduplicated");
    const gate = deferred();
    let downloads = 0;
    const cache = new AssetCache({
      root,
      client: cacheClient(async () => {
        downloads += 1;
        return responseFor(payload, { gate });
      }),
      maxAssetBytes: 20,
      maxCacheBytes: 20,
    });
    const asset = { sha256: sha256(payload), size: payload.length };
    const one = cache.ensure(asset);
    const two = cache.ensure(asset);
    assert.equal(one, two);
    await waitFor(() => cache.snapshot().reservedBytes === payload.length, "deduplicated reservation");
    gate.resolve();
    const [first, second] = await Promise.all([one, two]);
    assert.deepEqual(first, second);
    assert.equal(downloads, 1);
    assert.equal(cache.snapshot().downloads, 1);
  });
});

test("hash failure removes its partial and releases capacity for a later asset", async () => {
  await withRoot("pb-cache-release", async (root) => {
    const wrong = Buffer.from("wrong");
    const valid = Buffer.from("valid");
    let response = wrong;
    const cache = new AssetCache({
      root,
      client: cacheClient(async () => responseFor(response)),
      maxAssetBytes: 5,
      maxCacheBytes: 5,
    });
    await assert.rejects(
      cache.ensure({ sha256: sha256(valid), size: 5 }),
      /SHA-256 mismatch/,
    );
    assert.equal(cache.snapshot().committedBytes, 0);
    assert.equal(cache.snapshot().reservedBytes, 0);

    response = valid;
    const result = await cache.ensure({ sha256: sha256(valid), size: 5 });
    assert.equal(result.cached, false);
    assert.equal(cache.snapshot().committedBytes, 5);
  });
});

test("payload publication does not complete before the digest directory is durable", async () => {
  await withRoot("pb-cache-directory-sync", async (root) => {
    const payload = Buffer.from("durable-cache-entry");
    const sha = sha256(payload);
    let directorySyncs = 0;
    let unexpectedDownloads = 0;
    const cache = new AssetCache({
      root,
      client: cacheClient(async (url) => {
        if (!url.endsWith(sha)) unexpectedDownloads += 1;
        return responseFor(payload);
      }),
      maxAssetBytes: payload.length,
      maxCacheBytes: payload.length,
      syncDirectory: async () => {
        directorySyncs += 1;
        if (directorySyncs === 1) {
          const error = new Error("injected cache directory sync failure");
          error.code = "EIO";
          throw error;
        }
      },
    });

    await assert.rejects(
      cache.ensure({ sha256: sha, size: payload.length }),
      /injected cache directory sync failure/,
    );
    assert.equal(cache.snapshot().reservedBytes, 0);
    assert.equal(cache.snapshot().committedBytes, payload.length,
      "a published but not directory-synced payload must retain capacity ownership");

    const distinct = Buffer.alloc(payload.length, 0x78);
    await assert.rejects(
      cache.ensure({ sha256: sha256(distinct), size: distinct.length }),
      AssetCacheCapacityError,
    );
    assert.equal(unexpectedDownloads, 0,
      "post-rename uncertainty must prevent a distinct download from exceeding physical capacity");

    const recovered = await cache.ensure({ sha256: sha, size: payload.length });
    assert.equal(recovered.cached, true);
    assert.equal(directorySyncs, 2);
    assert.equal(cache.snapshot().committedBytes, payload.length);
  });
});

test("cache rejects root and digest-prefix links before network or outside writes", async (t) => {
  await t.test("digest prefix link", async (t) => {
    await withRoot("pb-cache-prefix-link", async (parent) => {
      const root = join(parent, "cache");
      const outside = join(parent, "outside");
      await mkdir(join(root, "sha256"), { recursive: true });
      await mkdir(outside);
      try {
        await symlink(outside, join(root, "sha256", "ab"), process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
          t.skip(`directory links are unavailable in this environment: ${error.code}`);
          return;
        }
        throw error;
      }
      let downloads = 0;
      const cache = new AssetCache({
        root,
        client: cacheClient(async () => {
          downloads += 1;
          return responseFor(Buffer.from("outside"));
        }),
        maxAssetBytes: 32,
        maxCacheBytes: 32,
      });
      await assert.rejects(cache.initialize(), AssetCachePathError);
      await assert.rejects(cache.ensure({ sha256: `ab${"0".repeat(62)}`, size: 7 }), AssetCachePathError);
      assert.equal(downloads, 0);
      assert.deepEqual(await readdir(outside), []);
    });
  });

  await t.test("cache root link", async (t) => {
    await withRoot("pb-cache-root-link", async (parent) => {
      const actual = join(parent, "actual");
      const linked = join(parent, "linked");
      await mkdir(actual);
      try {
        await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
          t.skip(`directory links are unavailable in this environment: ${error.code}`);
          return;
        }
        throw error;
      }
      const cache = new AssetCache({
        root: linked,
        client: cacheClient(async () => { throw new Error("network must remain unused"); }),
      });
      await assert.rejects(cache.initialize(), AssetCachePathError);
      assert.deepEqual(await readdir(actual), []);
    });
  });
});

test("restart rebuilds the committed ledger from published payloads", async () => {
  await withRoot("pb-cache-restart", async (root) => {
    const payload = Buffer.from("cold");
    const sha = sha256(payload);
    const first = new AssetCache({
      root,
      client: cacheClient(async () => responseFor(payload)),
      maxAssetBytes: 4,
      maxCacheBytes: 4,
    });
    await first.ensure({ sha256: sha, size: 4 });
    assert.equal(first.snapshot().committedBytes, 4);

    const restarted = new AssetCache({
      root,
      client: cacheClient(async () => { throw new Error("published asset must not redownload"); }),
      maxAssetBytes: 4,
      maxCacheBytes: 4,
    });
    await restarted.initialize();
    assert.equal(restarted.snapshot().committedBytes, 4);
    assert.equal(restarted.snapshot().reservedBytes, 0);
    assert.equal((await restarted.ensure({ sha256: sha, size: 4 })).cached, true);
  });
});

test("verified corruption removal updates inventory before replacement reservation", async () => {
  await withRoot("pb-cache-corrupt", async (root) => {
    const valid = Buffer.from("good");
    const sha = sha256(valid);
    const cache = new AssetCache({
      root,
      client: cacheClient(async () => responseFor(valid)),
      maxAssetBytes: 4,
      maxCacheBytes: 4,
    });
    const pathname = cache.pathFor(sha);
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(pathname, "evil");
    await cache.initialize();
    assert.equal(cache.snapshot().committedBytes, 4);

    const result = await cache.ensure({ sha256: sha, size: 4 });
    assert.equal(result.cached, false);
    assert.equal(cache.snapshot().committedBytes, 4);
    assert.equal(cache.snapshot().files, 1);
  });
});

test("cache byte limits are configurable by environment and CLI", async () => {
  const envConfig = await loadNodeConfig({
    argv: [],
    env: {
      PIXEL_BRIGHTNESS_MAX_ASSET_BYTES: "2097152",
      PIXEL_BRIGHTNESS_MAX_CACHE_BYTES: "4194304",
    },
    cwd: "/tmp/pb-cache-config",
    platform: "darwin",
  });
  assert.equal(envConfig.maxAssetBytes, 2_097_152);
  assert.equal(envConfig.maxCacheBytes, 4_194_304);

  const cliConfig = await loadNodeConfig({
    argv: ["--max-asset-bytes", "3145728", "--max-cache-bytes", "6291456"],
    env: {},
    cwd: "/tmp/pb-cache-config",
    platform: "darwin",
  });
  assert.equal(cliConfig.maxAssetBytes, 3_145_728);
  assert.equal(cliConfig.maxCacheBytes, 6_291_456);
  assert.match(nodeHelp(), /--max-cache-bytes <bytes>/);
});
