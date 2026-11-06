#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve,dirname,join } from 'node:path';
import { localReadiness } from '../runtime/shared/local-readiness.mjs';
if(process.platform!=='win32' || process.argv.length!==2) throw new Error('Run on the Windows Control PC, without arguments');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const errors=[];
async function get(path){
  try{const r=await fetch('http://127.0.0.1:4101'+path,{signal:AbortSignal.timeout(10000)});
    if(!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json();
  }catch(e){errors.push(`${path}: ${e.message}`);return null;}
}
const [health,uvc,projectors,schedule]=await Promise.all([
  get('/v1/health'),get('/v1/calibrations/uvc-geometry'),get('/v1/projectors'),get('/v1/show-schedule')]);
let devices=[];
try{devices=JSON.parse((await promisify(execFile)(join(root,'native/windows/bin/pixel-brightness-uvc.exe'),['--list'],
  {timeout:20000,maxBuffer:262144,windowsHide:true})).stdout).devices;}catch(e){errors.push(`USB enumeration: ${e.message}`);}
const report=localReadiness({health,devices,routing:uvc?.routing,projectors,schedule,errors});
console.log(JSON.stringify({...report,checkedAt:new Date().toISOString(),devices:devices.map(d=>({name:d.name})),
  note:'Read-only. No capture, routing, Arena Save/Close, projector power or Windows shutdown was performed.'},null,2));
process.exitCode=report.configurationReady?0:2;
