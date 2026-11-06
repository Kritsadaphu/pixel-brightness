import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyControlBundle } from '../scripts/verify-control-bundle.mjs';
test('Control bundle verifier rejects tampering, extras, duplicate names and traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-bundle-verify-'));
  const sha = createHash('sha256').update('hello').digest('hex');
  const manifest = join(root, 'CONTROL-BUNDLE-SHA256.txt');
  try {
    await writeFile(join(root, 'app.js'), 'hello'); await writeFile(manifest, sha + '  app.js\n');
    assert.deepEqual(await verifyControlBundle(root), ['app.js']);
    await writeFile(join(root, 'app.js'), 'bad'); await assert.rejects(verifyControlBundle(root), /digest/);
    await writeFile(join(root, 'app.js'), 'hello'); await writeFile(join(root, 'extra'), 'x');
    await assert.rejects(verifyControlBundle(root), /Extra/); await rm(join(root, 'extra'));
    for (const value of [sha + '  ../app.js\n', sha + '  app.js\n' + sha + '  APP.js\n']) {
      await writeFile(manifest, value); await assert.rejects(verifyControlBundle(root), /Unsafe/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
