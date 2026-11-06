import test from 'node:test';
import assert from 'node:assert/strict';
import {localReadiness} from '../runtime/shared/local-readiness.mjs';
const ready=()=>({health:{ok:true},devices:[{name:'Canon EOS R50'}],routing:{enabled:true,outputIds:['A','B','C','D','E'],pendingRecovery:false},
  projectors:{credential:{configured:true},projectors:Array.from({length:5},(_,i)=>({enabled:true,host:`192.168.1.${i+10}`}))},
  schedule:{config:{enabled:true,arenaExecutablePath:'C:\\Arena.exe',arenaCompositionPath:'C:\\Show.avc',days:Array.from({length:7},()=>({enabled:true}))}}});
test('configured devices never claim optical or power-cycle acceptance',()=>{
  const r=localReadiness(ready());assert.equal(r.configurationReady,true);assert.equal(r.productionAutoReady,false);assert.equal(r.cameraImageVerified,false);
});
test('NDI virtual camera is not accepted as a real Canon camera',()=>{
  const data=ready();data.devices=[{name:'NDI Webcam Video 1'},{name:'Virtual Canon R50'}];assert.equal(localReadiness(data).checks.canonUsbDetected,false);
});
test('disabled schedule, blank projector, pending restore and read failure block readiness',()=>{
  for(const change of [d=>d.schedule.config.enabled=false,d=>d.projectors.projectors[0].host='',d=>d.routing.pendingRecovery=true,d=>d.errors=['API failure']]){
    const d=ready();change(d);assert.equal(localReadiness(d).configurationReady,false);
  }
});
