'use strict';
// Persistent deployment journal. A per-network/target active file is an
// exclusive, crash-surviving guard. Never remove an uncertain attempt.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {accountId,networkConfig}=require('./core.cjs');

const TX=/^[1-9A-HJ-NP-Za-km-z]{35,65}$/;
const SHA=/^[0-9a-f]{64}$/;
const STATES=new Set(['broadcast-uncertain','submitted','finalized-unverified','finalized-failure']);
const MAX_RECORDS=1000;

function validate(r){
 if(!r||r.schemaVersion!==1||typeof r.id!=='string'||!/^[0-9a-f-]{36}$/i.test(r.id))throw Error('Invalid journal record. Deployment is blocked.');
 const net=networkConfig(r.network).id;
 accountId(r.target,net);accountId(r.signer,net);
 if(r.mode!=='new'&&r.mode!=='existing')throw Error('Malformed journal deployment mode. Deployment blocked.');
 if(r.keyMode!=='keyless'&&r.keyMode!=='controlled')throw Error('Malformed journal account policy. Deployment blocked.');
 if(typeof r.publicKey!=='string'||!r.publicKey.startsWith('ed25519:'))throw Error('Malformed journal owner public key. Deployment blocked.');
 if(typeof r.wasmSha256!=='string'||!SHA.test(r.wasmSha256))throw Error('Malformed journal WASM hash. Deployment blocked.');
 if(typeof r.expectedCodeHash!=='string'||!TX.test(r.expectedCodeHash))throw Error('Malformed journal expected on-chain code hash. Deployment blocked.');
 if(!STATES.has(r.status))throw Error('Malformed journal status. Deployment blocked.');
 if(r.txHash!==null&&(!r.txHash||!TX.test(r.txHash)))throw Error('Malformed journal transaction hash. Deployment blocked.');
 if(typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt)))throw Error('Malformed journal timestamp. Deployment blocked.');
 return r;
}
async function durableNew(file,record){
 const h=await fs.open(file,'wx',0o600);
 try{await h.writeFile(JSON.stringify(record,null,2)+'\n');await h.sync();}
 finally{await h.close();}
}
async function durableReplace(file,record){
 const temp=file+'.'+randomUUID()+'.tmp';
 try{
  await durableNew(temp,record);
  await fs.rename(temp,file);
 }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
}
class DeploymentJournal{
 constructor(userData){
  this.dir=path.join(userData,'deployment-journal');
  this.active=path.join(this.dir,'active');
  this.history=path.join(this.dir,'history');
 }
 async init(){await fs.mkdir(this.active,{recursive:true});await fs.mkdir(this.history,{recursive:true});}
 key(network,target){
  networkConfig(network);accountId(target,network);
  return createHash('sha256').update(network+'\0'+target).digest('hex');
 }
 file(network,target){return path.join(this.active,this.key(network,target)+'.json');}
 async get(network,target){
  const file=this.file(network,target);
  let raw;
  try{raw=await fs.readFile(file,'utf8');}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
  let record;
  try{record=validate(JSON.parse(raw));}
  catch{throw Error('Deployment journal is damaged for '+network+' '+target+'. Do not retry or delete it; restore or inspect this profile before proceeding.');}
  if(record.network!==network||record.target!==target)throw Error('Journal target mismatch. Deployment blocked.');
  return record;
 }
 async assertClear(network,target){
  // Any corrupted active journal record is a global fail-closed condition:
  // we cannot safely identify which target it was intended to guard.
  await this.list();
  const record=await this.get(network,target);
  if(record)throw Error('RECOVERY REQUIRED: '+network+' '+target+' has an unresolved saved deployment attempt'+(record.txHash?' (tx '+record.txHash+')':' (no confirmed transaction hash)')+'. Open Transaction Recovery and inspect the record. Never retry blindly.');
 }
 async start(data){
  await this.init();
  const network=networkConfig(data.network).id,target=accountId(data.target,network);
  const record=validate({
   schemaVersion:1,id:randomUUID(),network,target,signer:accountId(data.signer,network),
   publicKey:data.publicKey,mode:data.mode,keyMode:data.keyMode,initMethod:data.initMethod||null,
   wasmSha256:data.wasmSha256,expectedCodeHash:data.expectedCodeHash,
   createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
   status:'broadcast-uncertain',txHash:null,lastCheck:null,note:'Recorded before signing and broadcast. Outcome may be unknown.'
  });
  const file=this.file(network,target);
  try{await durableNew(file,record);}
  catch(e){if(e.code==='EEXIST')throw Error('RECOVERY REQUIRED: This network and target already has an unresolved deployment. Check Transaction Recovery.');throw e;}
  return record;
 }
 async update(network,target,id,patch){
  const previous=await this.get(network,target);
  if(!previous||previous.id!==id)throw Error('Journal attempt missing or changed. Deployment blocked.');
  if(patch.txHash!==undefined&&previous.txHash&&previous.txHash!==patch.txHash)
   throw Error('Transaction hash already recorded. It cannot be replaced without independent investigation.');
  const next=validate({...previous,...patch,network:previous.network,target:previous.target,id:previous.id,
   updatedAt:new Date().toISOString()});
  await durableReplace(this.file(network,target),next);
  return next;
 }
 async rememberHash(r,hash){
  if(!TX.test(hash||''))throw Error('Invalid transaction hash. Journal remains blocked.');
  return this.update(r.network,r.target,r.id,{txHash:hash,status:'submitted',note:'Hash saved. Await independent on-chain verification.'});
 }
 async note(r,status,note){
  if(!STATES.has(status))throw Error('Invalid recovery status.');
  return this.update(r.network,r.target,r.id,{
   status,lastCheck:new Date().toISOString(),note:String(note||'').slice(0,800)
  });
 }
 async complete(r,kind){
  if(kind!=='verified-success'&&kind!=='reviewed-finalized-failure')throw Error('Cannot complete an unresolved journal entry.');
  const active=await this.get(r.network,r.target);
  if(!active||active.id!==r.id||!active.txHash)throw Error('Cannot archive an unverified or hashless attempt.');
  if(kind==='reviewed-finalized-failure'&&active.status!=='finalized-failure')throw Error('Only independently confirmed failed transactions can be manually reviewed.');
  const record={...active,status:kind,resolvedAt:new Date().toISOString()};
  const archived=path.join(this.history,r.id+'.json');
  try{await durableNew(archived,record);}
  catch(e){
   if(e.code!=='EEXIST')throw e;
   const old=JSON.parse(await fs.readFile(archived,'utf8'));
   if(old.id!==r.id||old.txHash!==r.txHash||old.status!==kind)
    throw Error('Conflicting archived transaction. Journal remains blocked.');
  }
  // Archive first, remove active guard last. A crash can only leave a blocked
  // target, never an ambiguously-unblocked one.
  await fs.unlink(this.file(r.network,r.target));
  return record;
 }
 async list(){
  await this.init();
  const names=(await fs.readdir(this.active)).filter(n=>n.endsWith('.json'));
  if(names.length>MAX_RECORDS)throw Error('Too many active deployment records. Inspect your journal before proceeding.');
  const records=[];
  for(const name of names){
   const text=await fs.readFile(path.join(this.active,name),'utf8');
   let rec;
   try{rec=validate(JSON.parse(text));}catch{throw Error('A deployment journal file is corrupt. Deployment is blocked until repaired.');}
   if(name!==this.key(rec.network,rec.target)+'.json')throw Error('Deployment journal filename mismatch. Recovery blocked.');
   records.push(rec);
  }
  return records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 }
 async byId(id){
  if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))throw Error('Invalid recovery record ID.');
  const list=await this.list();
  const found=list.find(r=>r.id===id);
  if(!found)throw Error('No active recovery record matches the selected ID.');
  return found;
 }
}
module.exports={DeploymentJournal,validate,TX};
