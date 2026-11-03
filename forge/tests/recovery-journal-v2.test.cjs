'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {RecoveryJournal}=require('../src/recovery-journal.cjs');

const hash='2'.repeat(44);
function plan(network='testnet',target=network==='testnet'?'child.owner.testnet':'child.owner.near'){
 return {network,target,signer:network==='testnet'?'owner.testnet':'owner.near',
  publicKey:'ed25519:'+'3'.repeat(44),mode:'new',keyMode:'controlled',
  initMethod:'new',wasmSha256:'a'.repeat(64),expectedCodeHash:'4'.repeat(44),
  privateKey:'PRIVATE_CANARY_MUST_NOT_BE_STORED',initArgs:{password:'SECRET_CANARY'}};
}
async function withTemp(fn){
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'forge-recovery-v2-test-'));
 try{return await fn(folder);}finally{await fs.rm(folder,{force:true,recursive:true});}
}

test('TDD: pending attempt persists across a fresh process instance and blocks repeats',async()=>{
 await withTemp(async dir=>{
  const j1=new RecoveryJournal(dir);await j1.start(plan());
  const j2=new RecoveryJournal(dir);
  const saved=await j2.get('testnet','child.owner.testnet');
  assert.equal(saved.state,'uncertain');
  assert.equal(saved.txHash,null);
  await assert.rejects(()=>j2.assertClear('testnet','child.owner.testnet'),/recover|pending|blocked/i);
  await assert.rejects(()=>j2.start(plan()),/recover|pending|exists|blocked/i);
 });
});

test('TDD: attempts are isolated by chain and address',async()=>{
 await withTemp(async dir=>{
  const j=new RecoveryJournal(dir);await j.start(plan());
  await j.assertClear('mainnet','child.owner.near');
  await j.start(plan('mainnet'));
  assert.equal((await j.list('mainnet')).length,1);
  assert.equal((await j.list('testnet')).length,1);
 });
});

test('TDD: crash before hash is known retains an uncertain, unresolvable guard',async()=>{
 await withTemp(async dir=>{
  const j=new RecoveryJournal(dir);await j.start(plan());
  const restarted=new RecoveryJournal(dir);
  assert.equal((await restarted.get('testnet','child.owner.testnet')).txHash,null);
  await assert.rejects(()=>restarted.complete('testnet','child.owner.testnet',{verified:true,txHash:hash}),/hash|missing|match/i);
 });
});

test('TDD: known transaction hash survives restart without any automatic submission',async()=>{
 await withTemp(async dir=>{
  const j=new RecoveryJournal(dir);await j.start(plan());await j.rememberHash('testnet','child.owner.testnet',hash);
  const again=new RecoveryJournal(dir);const saved=await again.get('testnet','child.owner.testnet');
  assert.equal(saved.txHash,hash);
  assert.equal(saved.state,'submitted');
  await assert.rejects(()=>again.start(plan()),/recover|pending|exists|blocked/i);
 });
});

test('TDD: wrong, malformed or conflicting tx hashes cannot replace a recorded hash',async()=>{
 await withTemp(async dir=>{
  const j=new RecoveryJournal(dir);await j.start(plan());
  await assert.rejects(()=>j.rememberHash('testnet','child.owner.testnet','bad'),/hash/i);
  await j.rememberHash('testnet','child.owner.testnet',hash);
  await assert.rejects(()=>j.rememberHash('testnet','child.owner.testnet','5'.repeat(44)),/different|conflict|hash/i);
  assert.equal((await j.get('testnet','child.owner.testnet')).txHash,hash);
 });
});

test('TDD: only independently verified matching transaction can unblock a target',async()=>{
 await withTemp(async dir=>{
  const j=new RecoveryJournal(dir);await j.start(plan());await j.rememberHash('testnet','child.owner.testnet',hash);
  await assert.rejects(()=>j.complete('testnet','child.owner.testnet',{verified:false,txHash:hash}),/verified/i);
  await assert.rejects(()=>j.complete('testnet','child.owner.testnet',{verified:true,txHash:'6'.repeat(44)}),/hash|match/i);
  await j.complete('testnet','child.owner.testnet',{verified:true,txHash:hash});
  await j.assertClear('testnet','child.owner.testnet');
  assert.equal((await j.list('testnet')).length,0);
  const files=await fs.readdir(path.join(dir,'recovery-journal-v2','history'));
  assert.equal(files.length,1);
 });
});

test('TDD: corrupt guard fails closed rather than being discarded',async()=>{
 await withTemp(async dir=>{
  const j=new RecoveryJournal(dir);await j.start(plan());
  const active=path.join(dir,'recovery-journal-v2','active');
  const files=await fs.readdir(active);
  await fs.writeFile(path.join(active,files[0]),'{broken');
  const restarted=new RecoveryJournal(dir);
  await assert.rejects(()=>restarted.assertClear('testnet','child.owner.testnet'),/corrupt|invalid|recovery|blocked/i);
  await assert.rejects(()=>restarted.start(plan()),/recover|pending|exists|blocked/i);
 });
});

test('TDD: only public metadata reaches disk, with no seed, private key or init arguments',async()=>{
 await withTemp(async dir=>{
  const j=new RecoveryJournal(dir);await j.start(plan());
  const raw=(await fs.readFile(path.join(dir,'recovery-journal-v2','active',(await fs.readdir(path.join(dir,'recovery-journal-v2','active')))[0]))).toString('utf8');
  assert.ok(!raw.includes('PRIVATE_CANARY')&&!raw.includes('SECRET_CANARY')&&!raw.includes('privateKey')&&!raw.includes('initArgs'));
  assert.ok(raw.includes('child.owner.testnet'));
 });
});

test('TDD: failed guard creation prevents signing and never silently clears an old attempt',async()=>{
 await withTemp(async dir=>{
  const j=new RecoveryJournal(dir);await j.start(plan());
  await assert.rejects(()=>j.start(plan()),/recover|pending|exists|blocked/i);
  assert.equal((await j.get('testnet','child.owner.testnet')).state,'uncertain');
 });
});

test('TDD: concurrent begin calls allow only one owner for a target',async()=>{
 await withTemp(async dir=>{
  const j=new RecoveryJournal(dir);
  const result=await Promise.allSettled([j.start(plan()),j.start(plan())]);
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(result.filter(x=>x.status==='rejected').length,1);
 });
});

test('TDD: unresolved v0.8.2 journal records cannot be bypassed by v2',async()=>{
 await withTemp(async dir=>{
  const old=path.join(dir,'deployment-journal','active');await fs.mkdir(old,{recursive:true});
  await fs.writeFile(path.join(old,'prior-transaction.json'),'{}');
  const j=new RecoveryJournal(dir);
  await assert.rejects(()=>j.assertClear('testnet','child.owner.testnet'),/legacy|v0\.8\.2/i);
  await assert.rejects(()=>j.start(plan()),/legacy|v0\.8\.2/i);
  await assert.rejects(()=>j.list('testnet'),/legacy|v0\.8\.2/i);
 });
});
test('TDD: corrupted record on a different target blocks all new deployments',async()=>{
 await withTemp(async dir=>{
  const j=new RecoveryJournal(dir);await j.start(plan());
  const folder=path.join(dir,'recovery-journal-v2','active');
  const file=(await fs.readdir(folder))[0];await fs.writeFile(path.join(folder,file),'damaged');
  await assert.rejects(()=>j.assertClear('mainnet','child.owner.near'),/corrupt|blocked|invalid/i);
 });
});
test('TDD: storage-path failure refuses to begin an attempt rather than bypassing the guard',async()=>{
 await withTemp(async dir=>{
  const bad=path.join(dir,'not-a-directory');await fs.writeFile(bad,'x');
  const j=new RecoveryJournal(bad);
  await assert.rejects(()=>j.start(plan()));
 });
});

test('TDD: restart after archive fsync but before unlink can safely finish recovery',async()=>{
 await withTemp(async dir=>{
  const j=new RecoveryJournal(dir),saved=await j.start(plan());
  await j.rememberHash('testnet','child.owner.testnet',hash);
  const archive=path.join(dir,'recovery-journal-v2','history',saved.id+'.json');
  await fs.writeFile(archive,JSON.stringify({...await j.get('testnet','child.owner.testnet'),resolvedAt:new Date().toISOString(),resolution:'independently-verified-success'}));
  const restarted=new RecoveryJournal(dir);
  const ok=await restarted.complete('testnet','child.owner.testnet',{verified:true,txHash:hash});
  assert.equal(ok.resolved,true);await restarted.assertClear('testnet','child.owner.testnet');
 });
});
test('TDD: conflicting preexisting archive never clears a pending guard',async()=>{
 await withTemp(async dir=>{
  const j=new RecoveryJournal(dir),saved=await j.start(plan());
  await j.rememberHash('testnet','child.owner.testnet',hash);
  const archive=path.join(dir,'recovery-journal-v2','history',saved.id+'.json');
  await fs.writeFile(archive,JSON.stringify({...await j.get('testnet','child.owner.testnet'),txHash:'5'.repeat(44),resolution:'independently-verified-success'}));
  await assert.rejects(()=>j.complete('testnet','child.owner.testnet',{verified:true,txHash:hash}),/conflict/i);
  await assert.rejects(()=>j.assertClear('testnet','child.owner.testnet'),/recover|pending/i);
 });
});
