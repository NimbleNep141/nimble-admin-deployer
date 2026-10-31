'use strict';
const {contextBridge,ipcRenderer}=require('electron');
function invoke(action,data){return ipcRenderer.invoke('forge:'+action,data);}
contextBridge.exposeInMainWorld('forge',Object.freeze({
 network:()=>invoke('network'),
 inspect:id=>invoke('inspect',id),
 openWasm:()=>invoke('open-wasm'),
 compileRust:()=>invoke('compile-rust'),
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
