'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {V4Journal}=require('../src/recovery-v4-journal.cjs');
const {signAndSubmitExact}=require('../src/recovery-v4-broadcast.cjs');
const BASE={network:'testnet',signer:'owner.testnet',target:'child.owner.testnet',publicKey:'ed25519:'+'3'.repeat(44),
 mode:'new',keyMode:'controlled',initMethod:'new',wasmSha256:'a'.repeat(64),
 expectedCodeHash:'4'.repeat(44),txHash:'2'.repeat(44),nonce:'15',blockHash:'5'.repeat(44)};
async function temporary(fn){const p=await fs.mkdtemp(path.join(os.tmpdir(),'forge-v4-'));try{return await fn(p)}finally{await fs.rm(p,{recursive:true,force:true})}}
const proof=(id,hash,kind)=>({id,txHash:hash,kind,finalized:true,receiptCount:1,reviewed:true,verified:true,fingerprint:'a'.repeat(64)});
test('red: exact transaction ID remains durable after restart and blocks a duplicate',async()=>{
 await temporary(async dir=>{
  const a=new V4Journal(dir),first=await a.start(BASE);
  const b=new V4Journal(dir);assert.equal((await b.unresolved(BASE.network,BASE.target)).id,first.id);
  await assert.rejects(()=>b.start(BASE),/pending|recover|blocked/i);
 });
});
test('red: prepared-before-broadcast can be cancelled, with immutable exclusive phase',async()=>{
 await temporary(async dir=>{
  const j=new V4Journal(dir),a=await j.start(BASE);
  await j.cancelBeforeBroadcast(a);
  await assert.rejects(()=>j.claimBroadcast(a),/cancel|phase|claimed/i);
  await j.resolveBeforeBroadcast(a);
  assert.equal(await j.unresolved(BASE.network,BASE.target),null);
 });
});
test('red: after broadcast intent the prepared attempt can NEVER be cancelled as unsent',async()=>{
 await temporary(async dir=>{
  const j=new V4Journal(dir),a=await j.start(BASE);
  await j.claimBroadcast(a);
  await assert.rejects(()=>j.cancelBeforeBroadcast(a),/broadcast|phase|claimed/i);
  await assert.rejects(()=>j.resolveBeforeBroadcast(a),/broadcast|phase|claimed/i);
 });
});
test('red: an older concurrent archive cannot delete a new attempt',async()=>{
 await temporary(async dir=>{
  const j=new V4Journal(dir),a=await j.start(BASE);
  await j.claimBroadcast(a);await j.resolveVerified(a,'verified-success',proof(a.id,a.txHash,'verified-success'));
  const newer=await j.start({...BASE,nonce:'16',txHash:'6'.repeat(44)});
  await j.resolveVerified(a,'verified-success',proof(a.id,a.txHash,'verified-success'));
  assert.equal((await j.unresolved(BASE.network,BASE.target)).id,newer.id);
  const attempts=await j.listTarget(BASE.network,BASE.target);
  assert.equal(attempts.length,2);
  assert.equal(attempts[0].id,a.id);
 });
});
test('red: two concurrent starts select one generation and cannot double-send',async()=>{
 await temporary(async dir=>{
  const j=new V4Journal(dir);
  const result=await Promise.allSettled([j.start(BASE),j.start(BASE)]);
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(result.filter(x=>x.status==='rejected').length,1);
 });
});
test('red: approved final failure can close without retry, while uncertain failure cannot',async()=>{
 await temporary(async dir=>{
  const j=new V4Journal(dir),a=await j.start(BASE);await j.claimBroadcast(a);
  await assert.rejects(()=>j.resolveVerified(a,'reviewed-final-failure',{id:a.id,txHash:a.txHash}),/proof|verified|review/i);
  await j.resolveVerified(a,'reviewed-final-failure',proof(a.id,a.txHash,'reviewed-final-failure'));
  assert.equal(await j.unresolved(BASE.network,BASE.target),null);
 });
});
test('red: valid legacy records block only their same target',async()=>{
 await temporary(async dir=>{
  const {createHash}=require('node:crypto');
  const p=path.join(dir,'deployment-journal','active');await fs.mkdir(p,{recursive:true});
  const digest=createHash('sha256').update(BASE.network+'\0'+BASE.target).digest('hex');
  await fs.writeFile(path.join(p,digest+'.json'),JSON.stringify({schemaVersion:1,id:'11111111-1111-4111-8111-111111111111',
   network:BASE.network,target:BASE.target,signer:BASE.signer,publicKey:BASE.publicKey,mode:BASE.mode,keyMode:BASE.keyMode,
   initMethod:'new',wasmSha256:BASE.wasmSha256,expectedCodeHash:BASE.expectedCodeHash,
   status:'broadcast-uncertain',createdAt:new Date().toISOString(),txHash:null}));
  const j=new V4Journal(dir);
  await j.assertClear('testnet','other.owner.testnet');
  await assert.rejects(()=>j.assertClear(BASE.network,BASE.target),/legacy|recover|blocked/i);
 });
});
test('red: corruption never yields a clear target just because parsing failed',async()=>{
 await temporary(async dir=>{
  const j=new V4Journal(dir),a=await j.start(BASE);
  const filename=j.attemptFile(a);
  await fs.writeFile(filename,'{not JSON');
  await assert.rejects(()=>j.assertClear(BASE.network,BASE.target),/corrupt|blocked|invalid/i);
 });
});
test('red: no sensitive payloads or private key in persistent records',async()=>{
 await temporary(async dir=>{
  const j=new V4Journal(dir),a=await j.start({...BASE,privateKey:'SECRET_KEY_MARKER',initArgs:{secret:'SECRET_ARGUMENT_MARKER'}});
  const raw=await fs.readFile(j.attemptFile(a),'utf8');
  assert.ok(!/SECRET_KEY_MARKER|SECRET_ARGUMENT_MARKER|privateKey|initArgs/.test(raw));
 });
});
test('red: no session guard, no original sign-and-send retry path',async()=>{
 const m=await fs.readFile(path.join(__dirname,'../src/main.cjs'),'utf8');
 const r=await fs.readFile(path.join(__dirname,'../src/renderer.js'),'utf8');
 assert.doesNotMatch(m,/attemptedTargets/);assert.doesNotMatch(r,/submittedTarget/);
 assert.match(m,/signAndSubmitExact/);assert.doesNotMatch(m,/signer\.account\.signAndSendTransaction/);
 assert.match(m,/requestSingleInstanceLock/);
});

test('red: forged or incomplete JSON resolution can never clear an attempt',async()=>{
 await temporary(async dir=>{
  const j=new V4Journal(dir),a=await j.start(BASE);await j.claimBroadcast(a);
  await fs.writeFile(j.resolutionFile(a),JSON.stringify({id:a.id,txHash:a.txHash,kind:'verified-success'}));
  await assert.rejects(()=>j.assertClear(a.network,a.target),/corrupt|incomplete|invalid|blocked/i);
 });
});
test('red: a success resolution must carry independent finalized proof',async()=>{
 await temporary(async dir=>{
  const j=new V4Journal(dir),a=await j.start(BASE);await j.claimBroadcast(a);
  await fs.writeFile(j.resolutionFile(a),JSON.stringify({id:a.id,txHash:a.txHash,
   generation:a.generation,at:new Date().toISOString(),kind:'verified-success',
   proof:{id:a.id,txHash:a.txHash,kind:'verified-success',finalized:false,verified:false,receiptCount:1}}));
  await assert.rejects(()=>j.assertClear(a.network,a.target),/corrupt|incomplete|invalid|blocked/i);
 });
});

test('red: crash orphan .tmp files never masquerade as published signed attempts or resolutions',async()=>{
 await temporary(async dir=>{
  const j=new V4Journal(dir),a=await j.start(BASE);
  const pending=path.dirname(j.attemptFile(a));
  const tmp='.'+'11111111-1111-4111-8111-111111111111'+'.tmp';
  await fs.writeFile(path.join(pending,tmp),'{incomplete-stage');
  const p=path.dirname(j.resolutionFile(a));
  await fs.mkdir(p,{recursive:true});
  await fs.writeFile(path.join(p,tmp),'{incomplete-archive-stage');
  await assert.rejects(()=>j.assertClear(a.network,a.target),/pending|recovery/i);
  assert.equal((await j.listTarget(a.network,a.target)).length,1);
 });
});
test('red: a canonical attempt file cannot be replaced by a second generation claimant',async()=>{
 await temporary(async dir=>{
  const j=new V4Journal(dir),a=await j.start(BASE);
  const raw=await fs.readFile(j.attemptFile(a),'utf8');
  await assert.rejects(()=>j.start(BASE),/pending|recovery|blocked/i);
  assert.equal(await fs.readFile(j.attemptFile(a),'utf8'),raw);
 });
});
