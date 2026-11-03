'use strict';
// Recovery V3: public, exact-signed-transaction metadata ONLY.
// No seed, private key, signed payload, initializer arguments or broadcasts.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {accountId,networkConfig}=require('./core.cjs');
const B58=/^[1-9A-HJ-NP-Za-km-z]{35,65}$/;
const SHA=/^[a-f0-9]{64}$/;
const PUB=/^ed25519:[1-9A-HJ-NP-Za-km-z]{35,65}$/;
const LIMIT=4096;
const digest=(network,target)=>createHash('sha256').update(network+'\0'+target).digest('hex');
const corrupt=()=>Error('Corrupt or unreadable recovery evidence. Signing blocked. Preserve files for inspection.');
function validate(r){
 if(!r||r.schemaVersion!==3||typeof r.id!=='string'||!/^[-0-9a-f]{36}$/i.test(r.id))throw corrupt();
 const net=networkConfig(r.network).id;accountId(r.target,net);accountId(r.signer,net);
 if(!PUB.test(r.publicKey||'')||!SHA.test(r.wasmSha256||'')||!B58.test(r.expectedCodeHash||'')||
   !B58.test(r.txHash||'')||!B58.test(r.blockHash||'')||
   typeof r.nonce!=='string'||!/^[1-9][0-9]{0,29}$/.test(r.nonce))throw corrupt();
 if(!['new','existing'].includes(r.mode)||!['controlled','keyless'].includes(r.keyMode))throw corrupt();
 if(typeof r.initMethod!=='string'||r.initMethod.length>81||
   (r.initMethod&&!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(r.initMethod)))throw corrupt();
 if(r.state!=='prepared'||!Number.isFinite(Date.parse(r.createdAt)))throw corrupt();
 return r;
}
async function durableNew(file,text){
 const fd=await fs.open(file,'wx',0o600);
 try{await fd.writeFile(text,'utf8');await fd.sync();}
 finally{await fd.close();}
}
class RecoveryJournalV3{
 constructor(userData){
  if(typeof userData!=='string'||!path.isAbsolute(userData))throw Error('Absolute profile directory required.');
  this.root=path.join(userData,'recovery-v3');
  this.active=path.join(this.root,'active');
  this.history=path.join(this.root,'history');
  this.legacy=path.join(userData,'deployment-journal','active');
 }
 file(network,target){networkConfig(network);accountId(target,network);return path.join(this.active,digest(network,target)+'.json');}
 async init(){await fs.mkdir(this.active,{recursive:true,mode:0o700});await fs.mkdir(this.history,{recursive:true,mode:0o700});}
 async readNew(file){
  try{
   const stat=await fs.lstat(file);
   if(!stat.isFile()||stat.size<10||stat.size>LIMIT)throw corrupt();
   return validate(JSON.parse(await fs.readFile(file,'utf8')));
  }catch(e){if(e.code==='ENOENT')return null;throw corrupt();}
 }
 async get(network,target){
  const r=await this.readNew(this.file(network,target));
  if(r&&(r.network!==network||r.target!==target))throw corrupt();
  return r;
 }
 async legacyRecords(){
  let names;
  try{names=await fs.readdir(this.legacy);}catch(e){
   if(e.code==='ENOENT')return [];
   throw Error('Unidentifiable legacy recovery directory. Signing blocked.');
  }
  if(names.length>1000)throw corrupt();
  const old=[];
  for(const name of names.filter(x=>x.endsWith('.json'))){
   if(!/^[a-f0-9]{64}\.json$/.test(name))throw corrupt();
   let r;
   try{
    const filename=path.join(this.legacy,name),st=await fs.lstat(filename);
    if(!st.isFile()||st.size>LIMIT||st.size<5)throw corrupt();
    r=JSON.parse(await fs.readFile(filename,'utf8'));
    const network=networkConfig(r.network).id;
    accountId(r.target,network);accountId(r.signer,network);
    if(r.schemaVersion!==1||digest(network,r.target)+'.json'!==name)throw corrupt();
   }catch{throw Error('Unidentifiable or corrupted legacy v0.8.2 attempt. Signing blocked until forensic review.');}
   old.push({legacy:true,network:r.network,target:r.target,signer:r.signer,
    txHash:typeof r.txHash==='string'&&B58.test(r.txHash)?r.txHash:null,
    createdAt:r.createdAt||null,status:r.status||'unknown',id:r.id||null});
  }
  return old;
 }
 async list(network){
  networkConfig(network);
  await this.init();
  // Legacy records are visible but cannot be silently auto-migrated or cleared.
  const legacy=await this.legacyRecords();
  const names=(await fs.readdir(this.active)).filter(x=>x.endsWith('.json'));
  if(names.length>1000)throw corrupt();
  const current=[];
  for(const name of names){
   if(!/^[a-f0-9]{64}\.json$/.test(name))throw corrupt();
   const record=await this.readNew(path.join(this.active,name));
   if(!record||digest(record.network,record.target)+'.json'!==name)throw corrupt();
   current.push(record);
  }
  return [...current,...legacy].filter(r=>r.network===network);
 }
 async assertClear(network,target){
  accountId(target,network);
  const records=await this.list(network);
  const old=records.find(r=>r.legacy&&r.target===target);
  if(old)throw Error('Legacy v0.8.2 recovery is unresolved for this target. Other accounts remain usable; investigate this transaction.');
  if(records.some(r=>!r.legacy&&r.target===target))
   throw Error('Recovery pending for this target. Verify and resolve exact signed transaction first.');
 }
 async start(input){
  // No broadcast has occurred at this point. Signed hash and nonce are mandatory.
  const record=validate({schemaVersion:3,id:randomUUID(),
   network:input.network,target:input.target,signer:input.signer,publicKey:input.publicKey,
   mode:input.mode,keyMode:input.keyMode,initMethod:input.initMethod||'',
   wasmSha256:input.wasmSha256,expectedCodeHash:input.expectedCodeHash,
   txHash:input.txHash,nonce:String(input.nonce),blockHash:input.blockHash,
   createdAt:new Date().toISOString(),state:'prepared'});
  await this.assertClear(record.network,record.target);
  await this.init();
  try{await durableNew(this.file(record.network,record.target),JSON.stringify(record)+'\n');}
  catch(e){
   if(e.code==='EEXIST')throw Error('Recovery pending for this target. An attempt already owns the durable guard.');
   throw Error('Unable to durably prepare transaction guard. Broadcast forbidden: '+e.message);
  }
  return record;
 }
 async archive(network,target,txHash,kind){
  if(!['verified-success','reviewed-final-failure'].includes(kind))throw Error('Unknown recovery resolution.');
  const rec=await this.get(network,target);
  if(!rec||rec.txHash!==txHash)throw Error('Exact signed transaction hash must match the saved recovery record.');
  await this.init();
  const archived=path.join(this.history,rec.id+'.json');
  const copy={...rec,resolution:kind,resolvedAt:new Date().toISOString()};
  try{await durableNew(archived,JSON.stringify(copy)+'\n');}
  catch(e){
   if(e.code!=='EEXIST')throw Error('Could not preserve recovery archive. Guard retained.');
   let prior;try{prior=JSON.parse(await fs.readFile(archived,'utf8'));}catch{throw corrupt();}
   if(prior.id!==rec.id||prior.txHash!==rec.txHash||prior.network!==network||prior.target!==target||prior.resolution!==kind)
    throw Error('Conflicting prior archive. Guard retained.');
  }
  await fs.unlink(this.file(network,target));
  return {resolved:true,kind,txHash};
 }
 async completeSuccess(network,target,txHash,{verified}={}){
  if(verified!==true)throw Error('Independently verified successful result required.');
  return this.archive(network,target,txHash,'verified-success');
 }
 async completeFailure(network,target,txHash,{reviewed,finalFailure}={}){
  if(reviewed!==true)throw Error('Explicit review required for confirmed failure.');
  if(finalFailure!==true)throw Error('Exact signed transaction must be independently confirmed FINAL and failed.');
  return this.archive(network,target,txHash,'reviewed-final-failure');
 }
}
module.exports={RecoveryJournalV3};
