import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { UvcCamera } from '../runtime/node/uvc-camera.mjs';
import { NdiPatternTransport } from '../runtime/node/ndi-pattern-transport.mjs';
import { UvcGeometrySession, geometryPlan } from '../runtime/node/uvc-geometry-session.mjs';

// Explicit invocation only. Never runs at startup, rewires a receiver, modifies
// an Arena composition, or applies the resulting candidate to production.
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
let destination;
try {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/run-uvc-geometry.mjs PLAN.json');
  const config = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
  const plan = geometryPlan(config);
  if (!isAbsolute(config.outputDirectory)) throw new Error('Choose a new absolute output directory');
  const camera = new UvcCamera({ command: config.cameraCommand });
  const devices = await camera.list({ signal: controller.signal });
  if (!devices.some(d => d.id === plan.deviceId)) throw new Error('Selected R50 is not connected; no NDI sources were started');
  await mkdir(config.outputDirectory); destination = config.outputDirectory;
  await writeFile(join(destination, 'plan.json'), JSON.stringify(config, null, 2), { flag: 'wx' });
  const transport = new NdiPatternTransport({ command: config.patternCommand, runtimeDirectory: config.runtimeDirectory });
  const artifacts = [];
  const patterns = {
    async begin(value, options) {
      const result = await transport.begin(value, options);
      console.log(JSON.stringify({ state: 'waiting-for-receivers', sources: result.sources,
        notice: 'Route only the test outputs to these sources. Connections do not prove physical presentation. Existing Arena routing is unchanged.' }));
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        controller.signal.throwIfAborted();
        const status = await transport.status();
        if (plan.outputs.every(o => status.connections.some(c => c.outputId === o.id && c.connections > 0))) return result;
        await delay(500, undefined, { signal: controller.signal });
      }
      throw new Error('No receiver on every pattern source within two minutes');
    },
    show: (...args) => transport.show(...args),
    end: () => transport.end(),
  };
  const session = new UvcGeometrySession({ camera, patterns });
  const result = await session.run(plan, { signal: controller.signal,
    onProgress: value => console.log(JSON.stringify(value)),
    async onOutput({ outputId, map, mesh }) {
      const files = {};
      for (const field of ['projectorX', 'projectorY', 'confidence']) {
        const values = map[field], bytes = Buffer.alloc(values.length * 4);
        for (let i = 0; i < values.length; i++) {
          if (field === 'confidence') bytes.writeFloatLE(values[i], i * 4); else bytes.writeInt32LE(values[i], i * 4);
        }
        const file = `${outputId}-${field}.bin`;
        await writeFile(join(destination, file), bytes, { flag: 'wx' });
        files[field] = { file, elements: values.length, encoding: field === 'confidence' ? 'float32-le' : 'int32-le',
          sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      artifacts.push({ outputId, files, cameraWidth: map.cameraWidth, cameraHeight: map.cameraHeight,
        projectorWidth: map.projectorWidth, projectorHeight: map.projectorHeight, mesh });
    },
  });
  await writeFile(join(destination, 'candidate.json'), JSON.stringify({ ...result, artifacts }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ state: 'candidate-saved-not-applied', destination, note: 'Restore test receivers to their previous Arena sources. Physical black/content restoration is not verified.' }));
} catch (e) {
  const failure = { state: 'failed', code: e.code || 'GEOMETRY_FAILED', error: e.message,
    details: e instanceof AggregateError ? e.errors.map(x => x.message) : undefined,
    physicalOutputState: 'unverified', instruction: 'Check receiver routing and restore the original Arena sources.' };
  if (destination) await writeFile(join(destination, 'failure.json'), JSON.stringify(failure, null, 2), { flag: 'wx' }).catch(() => {});
  console.error(JSON.stringify(failure)); process.exitCode = 1;
}
