'use strict';
// Recovery V4: an append-only attempt ledger. No active record is ever deleted,
// renamed, replaced or overwritten. An older resolver therefore cannot unlink
// the active guard for a newer attempt, even in another process.
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {accountId,networkConfig}=require('./core.cjs');
const B58=/^[1-9A-HJ-NP-Za-km-z]{35,65}$/;
const PUB=/^ed25519:[1-9A-HJ-NP-Za-km-z]{35,65}$/;
const SHA=/^[0-9a-f]{64}$/;
const MAX=4096,MAX_ATTEMPTS=1000;
const key=(n,t)=>createHash('sha256').update(n+'\0'+t).digest('hex');
const corrupt=(why='Invalid or unreadable recovery evidence')=>Error(why+'. Signing blocked; preserve the evidence.');
function identity(n,t){networkConfig(n);accountId(t,n);}
function validate(a){
 if(!a||a.schema!==4||typeof a.id!=='string'||!/^[0-9a-f-]{36}$/i.test(a.id))throw corrupt();
 identity(a.network,a.target);accountId(a.signer,a.network);
 if(!Number.isSafeInteger(a.generation)||a.generation<1||a.generation>MAX_ATTEMPTS||
  !PUB.test(a.publicKey||'')||!SHA.test(a.wasmSha256||'')||
  !B58.test(a.expectedCodeHash||'')||!B58.test(a.txHash||'')||!B58.test(a.blockHash||'')||
  !/^[1-9]\d{0,28}$/.test(a.nonce||''))throw corrupt();
 if(!['new','existing'].includes(a.mode)||!['controlled','keyless'].includes(a.keyMode)||
  typeof a.initMethod!=='string'||a.initMethod.length>90||
  (a.initMethod&&!/^[A-Za-z_][A-Za-z_0-9]*$/.test(a.initMethod)))throw corrupt();
 if(!Number.isFinite(Date.parse(a.createdAt)))throw corrupt();
 return a;
}
async function exclusive(file,obj){
 // Write and flush a PRIVATE temporary inode first; only then atomically publish
 // a hard link at the canonical immutable filename. Link creation is exclusive:
 // another process cannot overwrite an already published guard or resolution.
 // An interrupted write leaves only a .tmp orphan, never a partial guard.
 const staging=path.join(path.dirname(file),'.'+randomUUID()+'.tmp');
 let handle;
 try{
  handle=await fs.open(staging,'wx',0o600);
  await handle.writeFile(JSON.stringify(obj)+'\n','utf8');
  await handle.sync();
  await handle.close();handle=null;
  await fs.link(staging,file);
 }finally{
  if(handle)await handle.close().catch(()=>{});
  await fs.rm(staging,{force:true}).catch(()=>{});
 }
}
async function read(file){
 try{
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.size<8||stat.size>MAX)throw corrupt();
  return JSON.parse(await fs.readFile(file,'utf8'));
 }catch(e){if(e.code==='ENOENT')return null;throw corrupt();}
}
class V4Journal{
 constructor(userData){
  if(typeof userData!=='string'||!path.isAbsolute(userData))throw Error('Absolute profile path required.');
  this.root=path.join(userData,'recovery-v4');
  this.attempts=path.join(this.root,'attempts');
  this.phases=path.join(this.root,'phases');
  this.resolutions=path.join(this.root,'resolutions');
  this.legacy=path.join(userData,'deployment-journal','active');
 }
 targetKey(network,target){identity(network,target);return key(network,target)}
 name(generation){if(!Number.isSafeInteger(generation)||generation<1||generation>MAX_ATTEMPTS)throw corrupt();return String(generation).padStart(6,'0')+'.json'}
 attemptFile(a){return path.join(this.attempts,this.targetKey(a.network,a.target),this.name(a.generation))}
 phaseFile(a){return path.join(this.phases,this.targetKey(a.network,a.target),this.name(a.generation))}
 resolutionFile(a){return path.join(this.resolutions,this.targetKey(a.network,a.target),this.name(a.generation))}
 async ensure(network,target){
  const k=this.targetKey(network,target);
  await Promise.all([this.attempts,this.phases,this.resolutions].map(d=>fs.mkdir(path.join(d,k),{recursive:true,mode:0o700})));
 }
 async legacyList(){
  let names;
  try{names=await fs.readdir(this.legacy)}catch(e){if(e.code==='ENOENT')return [];throw corrupt('Old v0.8.2 journal cannot be inspected')}
  if(names.length>MAX_ATTEMPTS)throw corrupt('Too many legacy records');
  const out=[];
  for(const name of names.filter(x=>x.endsWith('.json'))){
   if(!/^[a-f0-9]{64}\.json$/.test(name))throw corrupt('Unidentified legacy record');
   const a=await read(path.join(this.legacy,name));
   if(!a||a.schemaVersion!==1||typeof a.id!=='string'||!/^[0-9a-f-]{36}$/i.test(a.id))
    throw corrupt('Unidentified legacy record');
   try{identity(a.network,a.target);accountId(a.signer,a.network)}catch{throw corrupt('Unidentified legacy record')}
   if(key(a.network,a.target)+'.json'!==name||!['broadcast-uncertain','submitted','finalized-unverified','finalized-failure'].includes(a.status))
    throw corrupt('Unidentified legacy record');
   out.push({legacy:true,network:a.network,target:a.target,signer:a.signer,id:a.id,
    txHash:typeof a.txHash==='string'&&B58.test(a.txHash)?a.txHash:null,
    createdAt:a.createdAt,status:a.status});
  }
  return out;
 }
 async listTarget(network,target){
  const k=this.targetKey(network,target);
  let files;
  try{files=await fs.readdir(path.join(this.attempts,k))}
  catch(e){if(e.code==='ENOENT')return [];throw corrupt()}
  if(files.length>MAX_ATTEMPTS)throw corrupt('Too many attempts for this target');
  const result=[];
  for(const file of files){
   if(/^\.[0-9a-f-]{36}\.tmp$/.test(file))continue; // orphan from a crash BEFORE immutable publish
   if(!/^\d{6}\.json$/.test(file))throw corrupt('Unexpected attempt filename');
   const a=validate(await read(path.join(this.attempts,k,file)));
   if(a.network!==network||a.target!==target||file!==this.name(a.generation))throw corrupt('Attempt identity changed');
   const phase=await read(this.phaseFile(a));
   if(phase&&(phase.id!==a.id||!['broadcast-intent','cancelled-prebroadcast'].includes(phase.kind)||
      !Number.isFinite(Date.parse(phase.at))))throw corrupt('Attempt phase mismatch');
   const resolved=await read(this.resolutionFile(a));
   if(resolved){
    const proof=resolved.proof;
    if(resolved.id!==a.id||resolved.txHash!==a.txHash||resolved.generation!==a.generation||
       !Number.isFinite(Date.parse(resolved.at))||
       !['verified-success','reviewed-final-failure','cancelled-prebroadcast'].includes(resolved.kind)||
       !proof||proof.id!==a.id||proof.txHash!==a.txHash||proof.kind!==resolved.kind)
     throw corrupt('Resolution identity or evidence mismatch');
    if(resolved.kind==='cancelled-prebroadcast'){
     if(phase?.kind!=='cancelled-prebroadcast'||proof.reason!=='exclusive-cancel-won-before-broadcast')
      throw corrupt('Cancellation evidence incomplete');
    }else{
     if(phase?.kind!=='broadcast-intent'||proof.finalized!==true||
        !Number.isSafeInteger(proof.receiptCount)||proof.receiptCount<0||
        (resolved.kind==='verified-success'&&proof.verified!==true)||
        (resolved.kind==='reviewed-final-failure'&&
         (proof.reviewed!==true||!SHA.test(proof.fingerprint||''))))
      throw corrupt('On-chain resolution proof incomplete');
    }
   }
   result.push({...a,phase:phase?.kind||null,resolution:resolved?.kind||null});
  }
  result.sort((a,b)=>a.generation-b.generation);
  if(result.some((a,i)=>a.generation!==i+1))throw corrupt('Missing historical attempt or unexpected generation');
  return result;
 }
 async list(network){
  networkConfig(network);
  const legacy=await this.legacyList();
  let keys;
  try{keys=await fs.readdir(this.attempts)}
  catch(e){if(e.code==='ENOENT')return legacy.filter(a=>a.network===network);throw corrupt()}
  if(keys.length>MAX_ATTEMPTS)throw corrupt('Too many target directories');
  const records=[];
  for(const name of keys){
   if(!/^[a-f0-9]{64}$/.test(name))throw corrupt('Unidentified attempt directory');
   const files=await fs.readdir(path.join(this.attempts,name));
   for(const file of files){
    if(/^\.[0-9a-f-]{36}\.tmp$/.test(file))continue;
    if(!/^\d{6}\.json$/.test(file))throw corrupt();
    const a=validate(await read(path.join(this.attempts,name,file)));
    if(key(a.network,a.target)!==name)throw corrupt('Attempt directory identity mismatch');
    if(a.network===network){
     const matching=await this.listTarget(a.network,a.target);
     for(const m of matching)if(!records.some(x=>x.id===m.id))records.push(m);
    }
   }
  }
  return [...legacy.filter(a=>a.network===network),...records];
 }
 async assertClear(network,target){
  const legacy=await this.legacyList();
  if(legacy.some(a=>a.network===network&&a.target===target))
   throw Error('Legacy v0.8.2 recovery pending for this target. Other targets remain usable.');
  if((await this.listTarget(network,target)).some(a=>!a.resolution))
   throw Error('Recovery pending for this target. Never create a second signed transaction until reviewed.');
 }
 async unresolved(network,target){
  const records=await this.listTarget(network,target);
  const pending=records.filter(a=>!a.resolution);
  if(pending.length>1)throw corrupt('Multiple unresolved attempts detected');
  return pending[0]||null;
 }
 async start(input){
  identity(input.network,input.target);
  await this.assertClear(input.network,input.target);
  await this.ensure(input.network,input.target);
  // The deterministic next generation plus exclusive creation is a cross-process
  // compare-and-claim: competing writers race for the SAME filename; only one wins.
  const history=await this.listTarget(input.network,input.target);
  if(history.some(x=>!x.resolution))throw Error('Pending recovery prevents another attempt.');
  const generation=history.length+1;
  const a=validate({schema:4,id:randomUUID(),generation,
   network:input.network,target:input.target,signer:input.signer,publicKey:input.publicKey,
   mode:input.mode,keyMode:input.keyMode,initMethod:input.initMethod||'',
   wasmSha256:input.wasmSha256,expectedCodeHash:input.expectedCodeHash,
   txHash:input.txHash,nonce:String(input.nonce),blockHash:input.blockHash,
   createdAt:new Date().toISOString()});
  try{await exclusive(this.attemptFile(a),a);}
  catch(e){
   if(e.code==='EEXIST')throw Error('Another process claimed this target. Recovery/pending attempt blocks signing.');
   throw Error('Failed to durably save signed transaction before broadcast: '+e.message);
  }
  return a;
 }
 async original(a){
  const saved=(await this.listTarget(a.network,a.target)).find(x=>x.generation===a.generation);
  if(!saved||saved.id!==a.id||saved.txHash!==a.txHash)throw corrupt('Attempt identity no longer matches');
  return saved;
 }
 async claim(a,kind){
  if(!['broadcast-intent','cancelled-prebroadcast'].includes(kind))throw Error('Invalid phase transition');
  const saved=await this.original(a);
  if(saved.resolution)throw Error('Attempt already resolved.');
  if(saved.phase)throw Error('Attempt already claimed phase '+saved.phase+'; cannot override or repeat broadcast.');
  await this.ensure(a.network,a.target);
  try{await exclusive(this.phaseFile(a),{id:a.id,kind,at:new Date().toISOString()})}
  catch(e){if(e.code==='EEXIST')throw Error('Attempt phase already claimed. Never broadcast or cancel twice.');throw e}
 }
 async claimBroadcast(a){return this.claim(a,'broadcast-intent')}
 async cancelBeforeBroadcast(a){return this.claim(a,'cancelled-prebroadcast')}
 async resolveBeforeBroadcast(a){
  const saved=await this.original(a);
  if(saved.phase!=='cancelled-prebroadcast')throw Error('Cannot resolve a potentially broadcast transaction as never sent.');
  return this.resolve(a,'cancelled-prebroadcast',{id:a.id,txHash:a.txHash,kind:'cancelled-prebroadcast',reason:'exclusive-cancel-won-before-broadcast'});
 }
 async resolveVerified(a,kind,proof){
  if(!['verified-success','reviewed-final-failure'].includes(kind))throw Error('Invalid on-chain resolution.');
  if(!proof||proof.id!==a.id||proof.txHash!==a.txHash||proof.kind!==kind||proof.finalized!==true||
   !Number.isSafeInteger(proof.receiptCount)||proof.receiptCount<0||
   (kind==='reviewed-final-failure'&&proof.reviewed!==true))
   throw Error('Insufficient independently verified resolution proof.');
  const saved=await this.original(a);
  if(saved.phase!=='broadcast-intent')throw Error('On-chain recovery requires broadcast intent evidence.');
  return this.resolve(a,kind,proof);
 }
 async resolve(a,kind,proof){
  const saved=await this.original(a);
  if(saved.resolution){
   if(saved.resolution===kind)return {resolved:true,id:a.id,kind,alreadyResolved:true};
   throw corrupt('Conflicting resolution');
  }
  const outcome={id:a.id,txHash:a.txHash,kind,generation:a.generation,at:new Date().toISOString(),
   proof:{...proof}};
  try{await exclusive(this.resolutionFile(a),outcome)}
  catch(e){
   if(e.code!=='EEXIST')throw Error('Unable to archive verified result; original attempt remains blocked: '+e.message);
   const prior=await read(this.resolutionFile(a));
   if(!prior||prior.id!==a.id||prior.txHash!==a.txHash||prior.kind!==kind)
    throw corrupt('Conflicting result archive');
  }
  // Intentionally NO unlink or rename of an attempt here. Ever.
  return {resolved:true,id:a.id,kind};
 }
}
module.exports={V4Journal};
