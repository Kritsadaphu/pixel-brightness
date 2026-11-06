#!/usr/bin/env node
// Sustained real-composition diagnostic: never changes Arena, project data,
// receiver selections, show schedules or the installed production release.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { NdiVideoTransport } from '../runtime/node/ndi-video-transport.mjs';
import { createIdentityMesh } from '../runtime/shared/mapping.mjs';
const exec = promisify(execFile);
const keys = ['PB_NDI_RUNTIME_DIR','PB_NDI_VIDEO_EXE','PB_NDI_PROBE_EXE','PB_NDI_SHADER_DIR','PB_NDI_ACCEPTANCE_SOURCE','PB_NDI_ACCEPTANCE_REPORT'];
if (process.platform !== 'win32' || keys.some(k => !process.env[k])) throw new Error('Explicit Windows native paths, source and NEW report path required');
const seconds = Number(process.env.PB_NDI_ACCEPTANCE_SECONDS ?? 300);
if (!Number.isInteger(seconds) || seconds < 5 || seconds > 600) throw new Error('Duration must be 5..600 seconds');
const fps = Number(process.env.PB_NDI_ACCEPTANCE_FPS ?? 30);
if (![30,60].includes(fps)) throw new Error('Target fps must be 30 or 60');
const options = { windowsHide:true, maxBuffer:1024*1024, timeout:(seconds+30)*1000,
  env:{...process.env,PATH:process.env.PB_NDI_RUNTIME_DIR+';'+process.env.PATH} };
const probe = async args => JSON.parse((await exec(process.env.PB_NDI_PROBE_EXE,args,options)).stdout);
const video = new NdiVideoTransport({command:process.env.PB_NDI_VIDEO_EXE,runtimeDirectory:process.env.PB_NDI_RUNTIME_DIR,
  shaderDirectory:process.env.PB_NDI_SHADER_DIR,assetDirectory:process.env.PB_NDI_SHADER_DIR,timeoutMs:20000});
const report = {schema:'pb-continuous-acceptance-v1',startedAt:new Date().toISOString(),seconds,targetFps:fps,
  path:'real Arena NDI -> GPU warp/color -> five local decoded NDI streams',
  physicalProjectorVerified:false,receiverRoutingChanged:false,scheduleVerified:false,samples:[]};
let done=false;
try {
  const matches=(await probe(['--list'])).sources.filter(s=>s.name===process.env.PB_NDI_ACCEPTANCE_SOURCE);
  if(matches.length!==1) throw new Error('Exact Arena source absent or ambiguous');
  const initial=(await probe(['--receive',matches[0].name])).receive;
  if(initial.formats.length!==1 || initial.receivedFrames===0) throw new Error('Input has no stable frames');
  report.input=initial;
  if(initial.formats[0].fpsNumerator !== fps*initial.formats[0].fpsDenominator)
    throw new Error(`Input cadence does not match ${fps} fps. Match the diagnostic to Arena; no automatic composition changes are made.`);
  const {width,height}=initial.formats[0];
  if(width<1920 || height<1200) throw new Error('Real composition must be at least 1920x1200');
  const outputs=Array.from({length:5},(_,i)=>({id:`acceptance${i+1}`,enabled:true,
    resolution:{width:1920,height:1200,refreshNum:fps,refreshDen:1},
    sourceViewport:{x:Math.round(i*(width-1920)/4),y:0,width:1920,height:1200},
    warp:{...createIdentityMesh(32,18),enabled:true},blend:{enabled:false},
    color:{gain:[1,1,1],gamma:[1,1,1],offset:[0,0,0]}}));
  report.ready=await video.begin({source:{...matches[0],sourceIsSrgb:true,timeoutMs:2000},
    canvas:{width,height,frameRateNum:fps,frameRateDen:1},outputs});
  await video.setBlank(false);
  let telemetryError;
  const telemetry=(async()=>{
    while(!done){
      const status=await video.status();
      report.samples.push({at:new Date().toISOString(),status});
      console.log(JSON.stringify({event:'acceptance-progress',elapsedSamples:report.samples.length,sourceValid:status.sourceValid,black:status.black}));
      await delay(5000);
    }
  })().catch(e=>{telemetryError=e;done=true;});
  try {
    const received=await Promise.allSettled(video.sources.map(async s=>{
      const r=(await probe(['--receive',s.name,'--seconds',String(seconds)])).receive;
      return {...r,outputId:s.outputId,observedFps:r.receivedFrames/r.observedSeconds};
    }));
    const failed=received.find(r=>r.status==='rejected');
    if(failed) throw failed.reason;
    report.outputs=received.map(r=>r.value);
  } finally { done=true; await telemetry; }
  if(telemetryError) throw telemetryError;
  report.passedThroughput=report.samples.slice(1).every(s=>s.status.sourceValid===true && s.status.black===false)
    && report.outputs.every(o=>o.observedSeconds>=seconds && o.observedFps>=fps*0.95 && o.timecodeRegressions===0
      && o.sdkDroppedVideoFrames===0 && o.formats.length===1 && o.formats[0].width===1920 && o.formats[0].height===1200);
  // A dark/static show source cannot certify visible dynamic content correctness.
  report.dynamicContentVerified=false;
  report.productionAutoReady=false;
  if(!report.passedThroughput) process.exitCode=2;
} catch(e){report.error=e.message;process.exitCode=1;}
finally {
  try{report.cleanup=await video.end();}catch(e){report.cleanup={error:e.message};process.exitCode=1;}
  report.finishedAt=new Date().toISOString();
  await writeFile(process.env.PB_NDI_ACCEPTANCE_REPORT,JSON.stringify(report,null,2),{flag:'wx'});
  console.log(JSON.stringify(report));
}
