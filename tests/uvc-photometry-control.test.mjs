import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { UvcGeometryControl } from '../runtime/server/uvc-geometry-control.mjs';
import { UvcGeometrySession } from '../runtime/node/uvc-geometry-session.mjs';
import { createIdentityMesh } from '../runtime/shared/mapping.mjs';
import { createGrayCodeFrame } from '../runtime/shared/calibration.mjs';
import { srgbDecode } from '../runtime/node/uvc-photometry.mjs';

test('processed USB capture -> measured Black/LUT artifacts -> atomic Apply/Restore, with digest checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-usb-photometry-'));
  const width = 64, height = 64; let step, time = 0, ends = 0;
  let project = { revision: 1, canvas: { width, height }, outputs: [{ id: 'left', resolution: { width, height }, warp: createIdentityMesh(2, 2),
    sourceViewport: { x: 0, y: 0, width, height }, color: { gain: [0.8, 0.8, 0.8] }, blackUniformity: { lift: 0.02 } }] };
  const camera = { async list() { return [{ id: 'fixture' }]; }, async capture(deviceId) {
    const pattern = step.pattern;
    const pixels = pattern.kind === 'solid' ? new Uint8Array(width * height).fill(pattern.level) : createGrayCodeFrame({ width, height, ...pattern });
    const data = Buffer.alloc(width * height * 3);
    for (let i = 0; i < pixels.length; i++) for (let c = 0; c < 3; c++) {
      const linear = 0.01 + [0.55, 0.5, 0.45][c] * srgbDecode(pixels[i] / 255);
      data[i * 3 + c] = Math.round((1.055 * linear ** (1 / 2.4) - 0.055) * 255);
    }
    return { data, metadata: { deviceId, width, height, pixelFormat: 'rgb24-encoded', raw: false, linearized: false,
      receivedAtUnixMs: time = Math.max(Date.now(), time + 1), sha256: createHash('sha256').update(data).digest('hex') } };
  } };
  const control = new UvcGeometryControl({ dataDir: root, camera, getProject: () => project,
    saveProject: async (p, { ifMatchRevision }) => { assert.equal(ifMatchRevision, project.revision); project = { ...p, revision: project.revision + 1 }; return { project }; },
    transportFactory: () => ({ async begin() { return { sources: [{ outputId: 'left', name: 'fixture' }] }; },
      async status() { return { connections: [{ outputId: 'left', connections: 1 }] }; },
      async show(value) { step = value; return { stepId: value.id, submitted: true, otherOutputsBlack: true }; },
      async end() { ends++; return { blackSubmitted: true }; } }),
    sessionFactory: options => new UvcGeometrySession({ ...options, wait: async () => {} }),
  });
  const acquire = async () => {
    const { job } = await control.start({ deviceId: 'fixture', outputs: [{ id: 'left', width, height }], sampleStride: 1, settleMs: 100,
      targetArea: { x: 0, y: 0, width: 1, height: 1 }, expectedRevision: project.revision, autoBlend: true,
      autoPhotometry: true, cameraResponse: 'srgb-assumed', cameraSettingsLocked: true });
    for (let i = 0; i < 100 && control.snapshot().job.state !== 'awaiting-routing'; i++) await delay(10);
    await control.confirmRouting(job.id);
    for (let i = 0; i < 200 && !control.snapshot().job.finishedAt; i++) await delay(10);
    assert.equal(control.snapshot().job.state, 'candidate-not-applied', control.snapshot().job.error);
    return job.id;
  };
  try {
    const id = await acquire();
    assert.equal(control.snapshot().job.photometryGenerated, true); assert.equal(ends, 1);
    assert.equal(control.snapshot().productionAutoReady, false);
    const candidate = JSON.parse(await readFile(join(root, 'uvc-geometry', id, 'candidate.json'), 'utf8'));
    assert.equal(candidate.usbPhotometry.radiometryVerified, false);
    assert.equal(candidate.captures.length, 40);
    await control.apply({ id, expectedRevision: 1 });
    assert.equal(project.outputs[0].color.lut.size, 33); assert.equal(project.outputs[0].blackUniformity.map.format, 'rgba32_float');
    assert.equal(project.outputs[0].blackUniformity.lift, 0);
    await control.restore({ id, expectedRevision: 2 });
    assert.deepEqual(project.outputs[0].color.gain, [0.8, 0.8, 0.8]); assert.equal(project.outputs[0].blackUniformity.lift, 0.02);
    const second = await acquire();
    const black = join(root, 'uvc-geometry', second, 'left-usb-black.bin');
    const bytes = await readFile(black); bytes.writeFloatLE(0.5, 0); await writeFile(black, bytes);
    await assert.rejects(control.apply({ id: second, expectedRevision: 3 }), /digest/); assert.equal(project.revision, 3);
  } finally { await control.close(); await rm(root, { recursive: true, force: true }); }
});
