'use strict';
const {contextBridge,ipcRenderer}=require('electron');
function invoke(action,data){return ipcRenderer.invoke('forge:'+action,data);}
contextBridge.exposeInMainWorld('forge',Object.freeze({
 network:()=>invoke('network'),
 setNetwork:network=>invoke('set-network',network),
 inspect:id=>invoke('inspect',id),
 openWasm:()=>invoke('open-wasm'),
 compileRust:()=>invoke('compile-rust'),
 isolatedStatus:()=>invoke('isolated-status'),
 isolatedBuild:args=>invoke('isolated-build',args),
 compilerStatus:()=>invoke('compiler-status'),
 compilerSetup:()=>invoke('compiler-setup'),
 projectOpen:()=>invoke('project-open'),
 sourceOpen:file=>invoke('source-open',file),
 sourceSave:data=>invoke('source-save',data),
 nodeStatus:()=>invoke('node-status'),
 nodeSetup:()=>invoke('node-setup'),
 jsInstall:()=>invoke('js-install'),
 jsBuild:config=>invoke('js-build',config),
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
 deploy:data=>invoke('deploy',data),
 list:()=>invoke('library-list'),
 save:data=>invoke('library-save',data),
 load:id=>invoke('library-load',id),
 delete:id=>invoke('library-delete',id)
}));
