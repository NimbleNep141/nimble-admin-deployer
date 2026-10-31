'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const run=(channel,data)=>ipcRenderer.invoke(channel,data);
contextBridge.exposeInMainWorld('nearium',Object.freeze({
  loadBuild:()=>run('nearium:load-build'),
  importKey:data=>run('nearium:import-key',data),
  importFile:owner=>run('nearium:import-file',owner),
  clearKey:()=>run('nearium:clear-key'),
  preview:data=>run('nearium:preview',data),
  deploy:data=>run('nearium:deploy',data)
}));
