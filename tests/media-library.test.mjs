import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { MediaLibrary } from "../runtime/server/media-library.mjs";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = {
    assetsDir: join(root, "assets"),
    uploadsDir: join(root, "uploads"),
    state: { media: {} },
    async transaction(mutator) {
      return mutator(this.state);
    },
  };
  await mkdir(store.assetsDir, { recursive: true });
  await mkdir(store.uploadsDir, { recursive: true });
  return { root, store };
}

function uploadRequest(bytes) {
  const request = Readable.from([bytes]);
  request.headers = { "content-length": String(bytes.length) };
  return request;
}

test("media upload repairs a corrupt digest-named asset before committing metadata", async () => {
  const { root, store } = await fixture("pixel-media-repair-");
  try {
    const bytes = Buffer.from("verified media payload");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(store.assetsDir, sha256), Buffer.alloc(bytes.length, 0x78));

    const library = new MediaLibrary(store);
    const metadata = await library.upload(uploadRequest(bytes), {
      fileName: "verified.bin",
      mimeType: "application/octet-stream",
      declaredSha256: sha256,
    });

    assert.equal(metadata.sha256, sha256);
    assert.equal(metadata.size, bytes.length);
    assert.deepEqual(await readFile(join(store.assetsDir, sha256)), bytes);
    assert.deepEqual(await readdir(store.assetsDir), [sha256]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("media metadata never advances before file and directory durability gates", async () => {
  const { root, store } = await fixture("pixel-media-durability-");
  try {
    const bytes = Buffer.from("durable media payload");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let directorySyncs = 0;
    const library = new MediaLibrary(store, {
      syncDirectory: async () => {
        directorySyncs += 1;
        if (directorySyncs === 1) {
          const error = new Error("injected directory sync failure");
          error.code = "EIO";
          throw error;
        }
      },
    });

    await assert.rejects(
      library.upload(uploadRequest(bytes), {
        fileName: "durable.bin",
        declaredSha256: sha256,
      }),
      /injected directory sync failure/,
    );
    assert.equal(store.state.media[sha256], undefined);
    assert.equal((await stat(join(store.assetsDir, sha256))).isFile(), true,
      "a crash-stage retry may find the already-renamed verified payload");

    const metadata = await library.upload(uploadRequest(bytes), {
      fileName: "durable.bin",
      declaredSha256: sha256,
    });
    assert.equal(metadata.sha256, sha256);
    assert.equal(directorySyncs, 2);
    assert.deepEqual(await readFile(join(store.assetsDir, sha256)), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

