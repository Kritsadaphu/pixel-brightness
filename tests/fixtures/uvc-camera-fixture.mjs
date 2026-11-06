#!/usr/bin/env node
// Process-boundary test only; never installed or exposed as a real camera.
const [operation, device] = process.argv.slice(2);
if (operation === '--list') console.log(JSON.stringify({ schema: 'pb-uvc-devices-v1', devices: [{ id: 'test-only', name: 'Fixture only' }] }));
else if(operation==='--controls') console.log(JSON.stringify({schema:'pb-uvc-controls-v1',deviceId:device==='wrong-identity'?'another-camera':device,settingsChanged:false,manualLockVerified:device==='false-claim',controls:Object.fromEntries(['exposure','focus','iris','whiteBalance','gain','gamma'].map(k=>[k,{supported:false}]))}));
else if (device === 'wait') setInterval(() => {}, 1000);
else if (device === 'overflow') process.stdout.write(Buffer.alloc(7 * 1024 * 1024));
else { console.error('fixture capture failure'); process.exitCode = 1; }
