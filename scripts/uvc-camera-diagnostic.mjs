import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { UvcCamera, uvcFrameBmp } from '../runtime/node/uvc-camera.mjs';

// Local diagnostic only. No renderer, Arena, projector or RAW calibration writes.
const camera = new UvcCamera({ command: process.argv[2] });
const html = await readFile(new URL('./uvc-camera-diagnostic.html', import.meta.url));
const port = 4310;
const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
const server = createServer(async (req, res) => {
  const send = (status, body, type = 'application/json') => {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:; frame-ancestors 'none'" });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  if (!hosts.has(req.headers.host)) return send(403, { error: 'Local access only' });
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    if (req.method === 'GET' && req.url === '/') return send(200, html, 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/devices') return send(200, { devices: await camera.list({ signal: controller.signal }) });
    if (req.method === 'POST' && req.url === '/capture') {
      if (req.headers.origin !== `http://${req.headers.host}`
          || req.headers['content-type'] !== 'application/json') return send(403, { error: 'Open the local diagnostic page to capture' });
      let input = '';
      for await (const bytes of req) {
        input += bytes.toString('utf8');
        if (Buffer.byteLength(input) > 16384) return send(413, { error: 'Request too large' });
      }
      const { deviceId } = JSON.parse(input);
      const frame = await camera.capture(deviceId, { signal: controller.signal });
      res.setHeader('X-UVC-Received-At', String(frame.metadata.receivedAtUnixMs));
      res.setHeader('X-UVC-SHA256', frame.metadata.sha256);
      return send(200, uvcFrameBmp(frame), 'image/bmp');
    }
    return send(404, { error: 'Not found' });
  } catch (error) {
    return send(error.code === 'UVC_BUSY' ? 409 : 503, { error: error.message, code: error.code || 'UVC_ERROR' });
  }
});
server.requestTimeout = 20000;
server.headersTimeout = 10000;
server.listen(port, '127.0.0.1', () => console.log(`UVC diagnostic: http://localhost:${port}/`));
