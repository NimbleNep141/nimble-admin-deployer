'use strict';
const {contextBridge,ipcRenderer}=require('electron');
function invoke(action,data){return ipcRenderer.invoke('forge:'+action,data);}
contextBridge.exposeInMainWorld('forge',Object.freeze({
 network:()=>invoke('network'),
 setNetwork:network=>invoke('set-network',network),
 inspect:id=>invoke('inspect',id),
 openWasm:()=>invoke('open-wasm'),
 isolatedStatus:()=>invoke('isolated-status'),
 isolatedBuild:args=>invoke('isolated-build',args),
 reproducibleStatus:()=>invoke('reproducible-status'),
 reproducibleSetup:()=>invoke('reproducible-setup'),
 projectOpen:()=>invoke('project-open'),
 sourceOpen:file=>invoke('source-open',file),
 sourceSave:data=>invoke('source-save',data),
 onCompilerProgress:listener=>{
  if(typeof listener!=='function')return ()=>{};
  const handler=(_event,data)=>{if(data&&typeof data.message==='string')listener(data);};
  ipcRenderer.on('forge:compiler-progress',handler);
  return ()=>ipcRenderer.removeListener('forge:compiler-progress',handler);
 },
 artifact:()=>invoke('artifact'),
 importKey:data=>invoke('import-key',data),
 keyFile:owner=>invoke('key-file',owner),
 disconnect:()=>invoke('disconnect'),
 preflight:data=>invoke('preflight',data),
 upgradeContext:data=>invoke('upgrade-context',data),
 upgradePrepare:data=>invoke('upgrade-prepare',data),
 deploy:data=>invoke('deploy',data),
 recoveryList:()=>invoke('recovery-list'),
 recoveryVerify:data=>invoke('recovery-verify',data),
 recoveryReviewFailure:data=>invoke('recovery-review-failure',data),
 recoveryCancelPrepared:data=>invoke('recovery-cancel-prepared',data),
 list:()=>invoke('library-list'),
 save:data=>invoke('library-save',data),
 load:id=>invoke('library-load',id),
 delete:id=>invoke('library-delete',id)
}));
