import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UvcCamera, uvcFrameBmp } from '../runtime/node/uvc-camera.mjs';

// Usage: node scripts/probe-uvc-camera.mjs <helper.exe> [exact-device-id] [new-output.bmp]
const [command, deviceId, destination] = process.argv.slice(2);
const camera = new UvcCamera({ command });
try {
  if (!deviceId) console.log(JSON.stringify({ devices: await camera.list() }));
  else {
    if (!destination) throw new Error('Specify a new BMP output file');
    const frame = await camera.capture(deviceId);
    const output = resolve(destination);
    await writeFile(output, uvcFrameBmp(frame), { flag: 'wx' });
    await writeFile(`${output}.json`, JSON.stringify(frame.metadata, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ output, metadata: frame.metadata }));
  }
} catch (error) {
  console.error(JSON.stringify({ code: error.code || 'UVC_PROBE_FAILED', error: error.message }));
  process.exitCode = 1;
}
