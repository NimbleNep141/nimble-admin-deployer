'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {DeploymentJournal}=require('../src/deployment-journal.cjs');

const target='widget.owner.testnet',signer='owner.testnet';
const codeHash='1'.repeat(44),sha256='a'.repeat(64),hash='2'.repeat(44);
function approval(network='testnet',address=target){
 const owner=network==='mainnet'?'owner.near':signer;
 return {network,target:address,signer:owner,publicKey:'ed25519:'+'3'.repeat(44),
  mode:'new',keyMode:'controlled',initMethod:'new',wasmSha256:sha256,expectedCodeHash:codeHash};
}
async function workspace(fn){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-journal-test-'));
 try{await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}
}
test('journal claim is durable BEFORE a transaction is submitted and survives a clean or abrupt restart',async()=>{
 await workspace(async root=>{
  const first=new DeploymentJournal(root);
  const record=await first.start(approval());
  assert.equal(record.status,'broadcast-uncertain');
  assert.equal(record.txHash,null);
  assert.equal((await first.list()).length,1);
  const restarted=new DeploymentJournal(root);
  await assert.rejects(()=>restarted.assertClear('testnet',target),/RECOVERY REQUIRED/);
  await assert.rejects(()=>restarted.start(approval()),/RECOVERY REQUIRED/);
  const same=await restarted.byId(record.id);
  assert.equal(same.wasmSha256,sha256);
  assert.equal(same.txHash,null);
 });
});
test('hash updates survive restart and never silently overwrite the original hash',async()=>{
 await workspace(async root=>{
  const j=new DeploymentJournal(root),record=await j.start(approval());
  const updated=await j.rememberHash(record,hash);
  assert.equal(updated.status,'submitted');
  const again=new DeploymentJournal(root),loaded=await again.get('testnet',target);
  assert.equal(loaded.txHash,hash);
  await assert.rejects(()=>again.rememberHash(loaded,'4'.repeat(44)),/already recorded/);
  assert.equal((await again.get('testnet',target)).txHash,hash);
  await again.note(loaded,'finalized-unverified','RPC not available');
  const checked=await new DeploymentJournal(root).get('testnet',target);
  assert.equal(checked.status,'finalized-unverified');
  await assert.rejects(()=>again.assertClear('testnet',target),/RECOVERY REQUIRED/);
 });
});
test('only verified success is auto-archived; unverified, hashless and premature failure clearance are refused',async()=>{
 await workspace(async root=>{
  const j=new DeploymentJournal(root),record=await j.start(approval());
  await assert.rejects(()=>j.complete(record,'verified-success'),/hashless/);
  const h=await j.rememberHash(record,hash);
  await assert.rejects(()=>j.complete(h,'reviewed-finalized-failure'),/independently confirmed/);
  await j.note(h,'finalized-unverified','Wrong contract');
  await assert.rejects(()=>j.assertClear('testnet',target),/RECOVERY REQUIRED/);
  const saved=await j.complete(h,'verified-success');
  assert.equal(saved.status,'verified-success');
  await assert.doesNotReject(()=>j.assertClear('testnet',target));
  assert.equal((await j.list()).length,0);
  const archived=await fs.readFile(path.join(root,'deployment-journal','history',record.id+'.json'),'utf8');
  assert.equal(JSON.parse(archived).txHash,hash);
  const second=await j.start(approval());
  assert.notEqual(second.id,record.id);
 });
});
test('finalized failures require a confirmed persisted state before reviewed closure',async()=>{
 await workspace(async root=>{
  const j=new DeploymentJournal(root),r=await j.start(approval());
  await j.rememberHash(r,hash);
  await j.note(r,'finalized-failure','FINAL failure');
  await assert.rejects(()=>j.assertClear('testnet',target),/RECOVERY REQUIRED/);
  const archived=await j.complete(r,'reviewed-finalized-failure');
  assert.equal(archived.status,'reviewed-finalized-failure');
  assert.equal((await j.list()).length,0);
  assert.ok((await fs.readFile(path.join(j.history,r.id+'.json'),'utf8')).includes('reviewed-finalized-failure'));
 });
});
test('same target on different chains gets independent guards, no secrets are ever persisted',async()=>{
 await workspace(async root=>{
  const j=new DeploymentJournal(root);
  const a=await j.start(approval());
  const b=await j.start(approval('mainnet','widget.owner.near'));
  assert.notEqual(j.file(a.network,a.target),j.file(b.network,b.target));
  assert.equal((await new DeploymentJournal(root).list()).length,2);
  await assert.doesNotReject(()=>j.assertClear('testnet','different.owner.testnet'));
  const raw=await fs.readFile(j.file(a.network,a.target),'utf8');
  assert.equal(raw.includes('private_key'),false);
  assert.equal(raw.includes('secret_key'),false);
  assert.equal(raw.includes('seed_phrase'),false);
 });
});
test('malformed or truncated journal fails CLOSED after restart, without resetting pending status',async()=>{
 await workspace(async root=>{
  const j=new DeploymentJournal(root),r=await j.start(approval());
  await fs.writeFile(j.file(r.network,r.target),'{"schemaVersion":1,"incomplete":');
  const fresh=new DeploymentJournal(root);
  await assert.rejects(()=>fresh.assertClear(r.network,r.target),/journal (?:is damaged|file is corrupt)/);
  await assert.rejects(()=>fresh.list(),/corrupt/);
  await assert.rejects(()=>fresh.start(approval()),/RECOVERY REQUIRED/);
 });
});
test('recovery is wired to the desktop and absent from auto-retry pathways',async()=>{
 const main=await fs.readFile(path.join(__dirname,'../src/main.cjs'),'utf8');
 const preload=await fs.readFile(path.join(__dirname,'../src/preload.cjs'),'utf8');
 const renderer=await fs.readFile(path.join(__dirname,'../src/renderer.js'),'utf8');
 const html=await fs.readFile(path.join(__dirname,'../src/index.html'),'utf8');
 assert.match(main,/await journal\.start\(/);
 assert.match(main,/if\(txHash\)await journal\.rememberHash\(entry,txHash\)/);
 assert.match(main,/await journal\.complete\(entry,'verified-success'\)/);
 assert.match(main,/await journal\.assertClear\(activeNetwork,p\.target\)/);
 assert.match(main,/bind\('recovery-reconcile',recoveryReconcile\)/);
 assert.match(main,/retries:0/);
 assert.match(preload,/recoveryList:.*invoke\('recovery-list'\)/);
 assert.match(preload,/recoveryRelease:.*invoke\('recovery-release'/);
 assert.match(renderer,/refreshRecovery\(/);
 for(const id of ['recovery-select','recovery-status','recovery-detail','recovery-check','recovery-hash','recovery-attach','recovery-release','recovery-target'])
  assert.ok(html.includes('id="'+id+'"'),id);
 assert.doesNotMatch(main,/attemptedTargets/);
});
