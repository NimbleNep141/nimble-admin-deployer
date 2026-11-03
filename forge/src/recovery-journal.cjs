'use strict';
// v2: durable fail-closed guard, independent of Electron and the signing path.
// Stores ONLY public transaction identity metadata; it never retries a transaction.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {accountId,networkConfig}=require('./core.cjs');
const SHA=/^[a-f0-9]{64}$/;
const B58=/^[1-9A-HJ-NP-Za-km-z]{35,65}$/;
const PUB=/^ed25519:[1-9A-HJ-NP-Za-km-z]{35,65}$/;
const MAX_BYTES=4000;
const digest=s=>createHash('sha256').update(s).digest('hex');
const safeError=()=>Error('Recovery guard is corrupt or unreadable. Deployment blocked; preserve the file for investigation.');
function validate(record){
 if(!record||typeof record!=='object'||record.schemaVersion!==2||!/^[-a-f0-9]{36}$/.test(record.id||''))throw safeError();
 const net=networkConfig(record.network).id;
 accountId(record.target,net);accountId(record.signer,net);
 if(!PUB.test(record.publicKey||'')||!SHA.test(record.wasmSha256||'')||!B58.test(record.expectedCodeHash||''))throw safeError();
 if(!['new','existing'].includes(record.mode)||!['controlled','keyless'].includes(record.keyMode))throw safeError();
 if(typeof record.initMethod!=='string'||record.initMethod.length>81||!/^[A-Za-z_][A-Za-z_0-9]*$/.test(record.initMethod||'a'))throw safeError();
 if(record.txHash!==null&&!B58.test(record.txHash||''))throw safeError();
 if(record.state!==(record.txHash?'submitted':'uncertain')||typeof record.createdAt!=='string')throw safeError();
 return record;
}
async function writeSynced(file,bytes,flag){
 const fd=await fs.open(file,flag,0o600);
 try{await fd.writeFile(bytes,{encoding:'utf8'});await fd.sync();}
 finally{await fd.close();}
}
class RecoveryJournal{
 constructor(userData){
  if(!path.isAbsolute(userData))throw Error('Recovery requires an absolute Windows profile directory.');
  this.root=path.join(userData,'recovery-journal-v2');
  this.active=path.join(this.root,'active');
  this.history=path.join(this.root,'history');
  // v0.8.2 used a different directory. Never silently ignore its unresolved records.
  this.legacyActive=path.join(userData,'deployment-journal','active');
 }
 key(network,target){
  networkConfig(network);accountId(target,network);
  return path.join(this.active,digest(network+'\0'+target)+'.json');
 }
 async init(){await fs.mkdir(this.active,{recursive:true,mode:0o700});await fs.mkdir(this.history,{recursive:true,mode:0o700});}
 async assertLegacyClear(){
  let files;
  try{files=await fs.readdir(this.legacyActive);}catch(e){if(e.code==='ENOENT')return;throw Error('Legacy v0.8.2 recovery records unreadable: deployment blocked.');}
  if(files.some(name=>name.endsWith('.json')))
   throw Error('Legacy v0.8.2 unresolved recovery records found. Preserve and investigate before deploying; they cannot be silently discarded.');
 }
 async get(network,target){
  const file=this.key(network,target);
  let data;
  try{const size=(await fs.stat(file)).size;if(size<8||size>MAX_BYTES)throw safeError();data=await fs.readFile(file,'utf8');}
  catch(e){if(e.code==='ENOENT')return null;throw safeError();}
  try{
   const record=validate(JSON.parse(data));
   if(record.network!==network||record.target!==target)throw safeError();
   return record;
  }catch{throw safeError();}
 }
 async assertClear(network,target){
  // Any file, even a damaged or unreadable one, is an active blocking marker.
  await this.list(network); // Check legacy and damaged records across both networks first.
  const file=this.key(network,target);
  try{await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return;throw safeError();}
  await this.get(network,target); // distinguish normal guard from a corrupt one
  throw Error('Recovery pending for this target. Inspect/verify its existing transaction; never submit automatically.');
 }
 async start(input){
  const record=validate({
   schemaVersion:2,id:randomUUID(),network:input.network,target:input.target,
   signer:input.signer,publicKey:input.publicKey,mode:input.mode,
   keyMode:input.keyMode,initMethod:input.initMethod||'',wasmSha256:input.wasmSha256,
   expectedCodeHash:input.expectedCodeHash,createdAt:new Date().toISOString(),
   state:'uncertain',txHash:null
  });
  await this.list(record.network); // Fail closed on legacy, corrupt or contradictory records.
  const file=this.key(record.network,record.target);
  try{await writeSynced(file,JSON.stringify(record)+'\n','wx');}
  catch(e){
   if(e.code==='EEXIST')throw Error('Recovery pending for this target. Previous attempt is still protected.');
   // If a write failed AFTER file creation, keep its partial marker to fail closed.
   throw Error('Unable to durably record the attempt; signing was blocked: '+e.message);
  }
  return record;
 }
 async replace(record){
  validate(record);
  const file=this.key(record.network,record.target);
  const current=await this.get(record.network,record.target);
  if(!current||current.id!==record.id)throw Error('Recovery guard changed; refusing to overwrite evidence.');
  const tmp=path.join(this.active,'.'+record.id+'-'+randomUUID()+'.tmp');
  try{
   await writeSynced(tmp,JSON.stringify(record)+'\n','wx');
   // This method is only called by the single guarded main-process transaction.
   await fs.rename(tmp,file);
  }finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
 }
 async rememberHash(network,target,txHash){
  if(!B58.test(txHash||''))throw Error('Invalid NEAR transaction hash.');
  const prev=await this.get(network,target);
  if(!prev)throw Error('No pending recovery record.');
  if(prev.txHash&&prev.txHash!==txHash)throw Error('Different transaction hash conflicts with the persistent recovery record.');
  if(prev.txHash===txHash)return prev;
  const record={...prev,txHash,state:'submitted'};
  await this.replace(record);
  return record;
 }
 async complete(network,target,{verified,txHash}={}){
  if(verified!==true)throw Error('A transaction must be independently verified before recovery is cleared.');
  const prev=await this.get(network,target);
  if(!prev||!prev.txHash||prev.txHash!==txHash)throw Error('Verified hash is missing or does not match recovery evidence.');
  await this.init();
  const archive=path.join(this.history,prev.id+'.json');
  const record={...prev,resolvedAt:new Date().toISOString(),resolution:'independently-verified-success'};
  // First archive a complete fsynced record; only then remove the active guard.
  // Any failure before unlink leaves the attempt blocked.
  try{await writeSynced(archive,JSON.stringify(record)+'\n','wx');}
  catch(e){
   if(e.code!=='EEXIST')throw Error('Cannot archive verified recovery; original guard retained: '+e.message);
   // A crash may happen between archiving and unlinking. Reconcile safely on restart.
   let existing;
   try{existing=JSON.parse(await fs.readFile(archive,'utf8'));}
   catch{throw Error('Existing recovery archive is damaged; original guard retained.');}
   if(existing.schemaVersion!==2||existing.id!==prev.id||existing.network!==network||
      existing.target!==target||existing.txHash!==txHash||
      existing.resolution!=='independently-verified-success')
    throw Error('Conflicting recovery archive; original guard retained.');
  }
  await fs.unlink(this.key(network,target));
  return {resolved:true,txHash,archive};
 }
 async list(network){
  networkConfig(network);
  await this.assertLegacyClear();
  await this.init();
  const names=(await fs.readdir(this.active)).filter(x=>x.endsWith('.json'));
  if(names.length>1000)throw Error('Recovery directory exceeds 1000 records; deploys blocked.');
  const records=[];
  for(const name of names){
   if(!/^[a-f0-9]{64}\.json$/.test(name))throw safeError();
   const file=path.join(this.active,name);
   let data;
   try{const s=await fs.stat(file);if(s.size<8||s.size>MAX_BYTES)throw safeError();data=validate(JSON.parse(await fs.readFile(file,'utf8')));}
   catch{throw safeError();}
   if(path.basename(this.key(data.network,data.target))!==name)throw safeError();
   if(data.network===network)records.push(data);
  }
  return records.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
 }
}
module.exports={RecoveryJournal};
