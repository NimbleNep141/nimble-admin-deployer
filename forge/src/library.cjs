'use strict';
const {readFile,writeFile,mkdir,rename,copyFile,stat,unlink}=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {wasm,sha,accountId,networkConfig}=require('./core.cjs');
const MAX_ITEMS=500;
function validTitle(s){if(typeof s!=='string'||!s.trim()||s.trim().length>70)throw Error('Saved contract name must be 1–70 characters.');return s.trim();}
function validPreset(p){
 if(!p||typeof p!=='object')throw Error('Invalid contract preset.');
 return {network:networkConfig(p.network||'testnet').id,mode:p.mode==='existing'?'existing':'new',prefix:typeof p.prefix==='string'?p.prefix.slice(0,24):'contract',
   funding:typeof p.funding==='string'?p.funding.slice(0,40):'6',keyMode:p.keyMode==='keyless'?'keyless':'controlled',
   initMethod:typeof p.initMethod==='string'?p.initMethod.slice(0,80):'',
   initArgs:typeof p.initArgs==='string'?p.initArgs.slice(0,16000):'{}',
   initDeposit:typeof p.initDeposit==='string'?p.initDeposit.slice(0,40):'0',
   gas:typeof p.gas==='string'?p.gas.slice(0,3):'30'};
}
class Library{
 constructor(userData){this.dir=path.join(userData,'forge-library');this.entriesFile=path.join(this.dir,'contracts.json');this.assets=path.join(this.dir,'wasm');}
 async init(){await mkdir(this.assets,{recursive:true});}
 async list(){
  await this.init();
  try{
   const content=await readFile(this.entriesFile,'utf8');
   const items=JSON.parse(content);
   if(!Array.isArray(items))throw Error('Saved contract library is not an array.');
   return items.slice(0,MAX_ITEMS).map(({id,name,sha256,bytes,preset,deployment,created})=>({id,name,sha256,bytes,preset,deployment:deployment||null,created}));
  }catch(e){if(e.code==='ENOENT')return [];throw e;}
 }
 async save({name,preset,wasmBytes,deployment=null}){
  validTitle(name);const binary=wasm(wasmBytes),hash=sha(binary);
  const entries=await this.list();if(entries.length>=MAX_ITEMS)throw Error('Library limit of 500 entries reached.');
  const file=path.join(this.assets,hash+'.wasm');
  try{await writeFile(file,binary,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  let deploymentRecord=null;
  if(deployment&&typeof deployment==='object'){
   const network=networkConfig(deployment.network||'testnet').id;
    const address=accountId(deployment.address,network);
   const txHash=typeof deployment.txHash==='string'&&/^[1-9A-HJ-NP-Za-km-z]{35,65}$/.test(deployment.txHash)?deployment.txHash:null;
   deploymentRecord={network,address,txHash,verified:deployment.verified===true};
  }
  const entry={id:randomUUID(),name:validTitle(name),sha256:hash,bytes:binary.length,preset:validPreset(preset),deployment:deploymentRecord,created:new Date().toISOString()};
  entries.unshift(entry);
  await this.store(entries);
  return entry;
 }
 async load(id){
  const entry=(await this.list()).find(x=>x.id===id);
  if(!entry)throw Error('Saved contract not found.');
  const f=path.join(this.assets,entry.sha256+'.wasm');
  if((await stat(f)).size>3_500_000)throw Error('Stored WASM too large.');
  const bytes=wasm(await readFile(f));
  if(sha(bytes)!==entry.sha256)throw Error('Saved WASM checksum mismatch. Do not deploy.');
  return {entry,bytes};
 }
 async delete(id){
  const entries=await this.list();const filtered=entries.filter(x=>x.id!==id);
  if(filtered.length===entries.length)throw Error('Saved contract not found.');
  await this.store(filtered); // Don't delete WASM assets automatically: other presets may refer to same file.
  return {removed:true};
 }
 async store(entries){
  const temp=path.join(this.dir,'contracts-'+randomUUID()+'.json');
  await writeFile(temp,JSON.stringify(entries,null,2)+'\n',{mode:0o600,flag:'wx'});
  try{await rename(temp,this.entriesFile)}catch(e){await unlink(temp).catch(()=>{});throw e;}
 }
}
module.exports={Library,validTitle,validPreset};
