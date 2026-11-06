// Bounded physical diagnostic: explicit --run, known receiver profiles, no
// project edits. Runs three black/white pairs and restores original sources.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {UvcCamera,uvcFrameBmp} from '../runtime/node/uvc-camera.mjs';
import {NdiPatternTransport} from '../runtime/node/ndi-pattern-transport.mjs';
import {NdiReceiverRouting} from '../runtime/server/ndi-receiver-routing.mjs';
if(process.platform!=='win32'||process.argv[2]!=='--run'||process.argv.length!==3)throw Error('Windows only: --run is required');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const data=resolve(root,'..','preview-data'),headers={Origin:'http://127.0.0.1:3001'};
for(const path of ['/v1/calibrations/uvc-geometry','/v1/outputs/ndi-preview']){
 const response=await fetch('http://127.0.0.1:4101'+path,{headers,signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error('Preview status unavailable');
 const s=await response.json();
 if(s.routing?.pendingRecovery||(s.job&&!['failed','cancelled','stopped','candidate-not-applied'].includes(s.job.state)))throw Error('Preview is busy');
}
const profiles=JSON.parse(await readFile(join(data,'ndi-receivers.json'),'utf8'));
if(profiles.length!==2||!profiles.some(p=>p.outputId==='A')||!profiles.some(p=>p.outputId==='B'))throw Error('This diagnostic requires the configured A/B receiver pair');
const camera=new UvcCamera({command:join(root,'native/windows/bin/pixel-brightness-uvc.exe')});
const device=(await camera.list()).find(d=>d.name==='Canon Digital Camera');if(!device)throw Error('Canon camera unavailable');
const patterns=new NdiPatternTransport({command:join(root,'native/windows/bin/pixel-brightness-ndi-patterns.exe'),runtimeDirectory:join(process.env.ProgramFiles,'NDI/NDI 6 SDK/Bin/x64')});
const router=await new NdiReceiverRouting({dataDir:data,profiles}).initialize();
const id=randomUUID(),directory=join(data,'reference-check',id);await mkdir(directory,{recursive:true});
const report={id,startedAt:new Date().toISOString(),captures:[],projectChanged:false,manualLockVerified:false};
const frames=[];
try{
 const receipt=await patterns.begin({outputs:[{id:'A',width:1920,height:1080},{id:'B',width:1920,height:1080}]});
 await router.route(id,receipt.sources);
 let connected=false;for(let n=0;n<25;n++){const s=await patterns.status();if(['A','B'].every(id=>s.connections.some(c=>c.outputId===id&&c.connections>0))){connected=true;break;}await delay(200);}
 if(!connected)throw Error('Both pattern receivers must connect');
 for(let i=0;i<6;i++){
  const level=i%2?255:0;
  const stepId='reference-'+i;
  const ack=await patterns.show({id:stepId,outputId:'A',pattern:{kind:'solid',level}});
  if(ack.stepId!==stepId||!ack.submitted||!ack.otherOutputsBlack)throw Error('Invalid pattern acknowledgement');
  await delay(2000);const frame=await camera.capture(device.id);frames.push(frame.data);
  await writeFile(join(directory,stepId+'.bmp'),uvcFrameBmp(frame));
  let mean=0;for(const v of frame.data)mean+=v;
  report.captures.push({level,sha256:frame.metadata.sha256,meanRGB:mean/frame.data.length,time:frame.metadata.receivedAtUnixMs});
 }
 let difference=0,reference=0,eligible=0;
 for(let i=0;i<frames[0].length;i+=3){
  const l=f=>(54*f[i]+183*f[i+1]+19*f[i+2]+128)>>8;
  const black=l(frames[0]),white=l(frames[1]);if(white-black<36)continue;
  eligible++;difference+=Math.abs(white-l(frames[5]))+Math.abs(black-l(frames[4]));reference+=2*(white-black);
 }
 report.eligiblePixels=eligible;report.referenceDrift=reference?difference/reference:null;report.withinEightPercent=Boolean(reference&&difference/reference<=0.08);
}catch(e){report.error=e.message;process.exitCode=1;}
finally{
 try{await patterns.end();}catch(e){report.patternCleanupError=e.message;process.exitCode=1;}
 if(router.snapshot().jobId===id&&router.snapshot().pendingRecovery){try{await router.restore(id);}catch(e){report.restoreError=e.message;process.exitCode=1;}}
 report.routing=router.snapshot();report.finishedAt=new Date().toISOString();
 await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({directory,...report}));
}
