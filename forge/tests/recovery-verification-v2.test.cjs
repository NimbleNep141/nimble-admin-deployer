'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {RecoveryJournal}=require('../src/recovery-journal.cjs');
const {reconcile}=require('../src/recovery-verification.cjs');
const TARGET='child.owner.testnet',SIGNER='owner.testnet',PUB='ed25519:'+'3'.repeat(44);
const TX='2'.repeat(44),CODE='4'.repeat(44);
const plan=()=>({network:'testnet',target:TARGET,signer:SIGNER,publicKey:PUB,
 mode:'new',keyMode:'controlled',initMethod:'new',wasmSha256:'a'.repeat(64),expectedCodeHash:CODE});
const fixture=()=>({
 final_execution_status:'FINAL',status:{SuccessValue:''},
 transaction:{hash:TX,signer_id:SIGNER,receiver_id:TARGET,public_key:PUB,
  actions:[{CreateAccount:{}},{Transfer:{deposit:'1000'}},{AddKey:{public_key:PUB}},
   {DeployContract:{code:'AGFzbQEAAAA='}},{FunctionCall:{method_name:'new',args:'e30='}}]},
 transaction_outcome:{id:TX,outcome:{status:{SuccessReceiptId:'receipt-1'},receipt_ids:['receipt-1']}},
 receipts_outcome:[{id:'receipt-1',outcome:{executor_id:TARGET,status:{SuccessValue:''},receipt_ids:[]}}]
});
const keys={keys:[{public_key:PUB,access_key:{permission:'FullAccess'}}]};
const rpc=async(method)=>method==='tx'?fixture():method==='query'?keys:Promise.reject(Error('unexpected RPC'));
const account=async()=>({code_hash:CODE});
async function run(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-reconcile-test-'));
 try{const journal=new RecoveryJournal(dir);await journal.start(plan());await fn(journal);}
 finally{await fs.rm(dir,{recursive:true,force:true});}}
test('read-only recovery verifies receipts, code and owner key before archiving',async()=>{
 await run(async journal=>{
  const result=await reconcile({journal,network:'testnet',target:TARGET,providedHash:TX,rpc,queryAccount:account});
  assert.equal(result.verified,true);assert.equal(result.resolved,true);
  await journal.assertClear('testnet',TARGET);
 });
});
test('lost RPC connection retains guard and hash remains unknown',async()=>{
 await run(async journal=>{
  await assert.rejects(()=>reconcile({journal,network:'testnet',target:TARGET,providedHash:TX,
   rpc:async()=>{throw Error('offline')},queryAccount:account}),/offline/);
  assert.equal((await journal.get('testnet',TARGET)).txHash,null);
 });
});
test('wrong signer, receiver, public key or extra action cannot attach explorer hash',async()=>{
 for(const mutate of [
  t=>t.transaction.signer_id='other.testnet',
  t=>t.transaction.receiver_id='other.testnet',
  t=>t.transaction.public_key='ed25519:'+'5'.repeat(44),
  t=>t.transaction.actions.push({DeleteAccount:{beneficiary_id:'evil.testnet'}})
 ]){
  await run(async journal=>{
   const r=async m=>{if(m==='query')return keys;const tx=fixture();mutate(tx);return tx;};
   await assert.rejects(()=>reconcile({journal,network:'testnet',target:TARGET,providedHash:TX,rpc:r,queryAccount:account}),/identity|actions|match/);
   assert.equal((await journal.get('testnet',TARGET)).txHash,null);
  });
 }
});
test('wrong on-chain code hash retains the guard even with successful receipts',async()=>{
 await run(async journal=>{
  const r=await reconcile({journal,network:'testnet',target:TARGET,providedHash:TX,rpc,
   queryAccount:async()=>({code_hash:'wrong'})});
  assert.equal(r.resolved,false);
  assert.equal((await journal.get('testnet',TARGET)).txHash,TX);
 });
});
test('failed initializer receipt cannot unblock target',async()=>{
 await run(async journal=>{
  const r=await reconcile({journal,network:'testnet',target:TARGET,providedHash:TX,
   rpc:async m=>{if(m==='query')return keys;const tx=fixture();
    tx.receipts_outcome[0].outcome.status={Failure:{ActionError:{}}};return tx;},
   queryAccount:account});
  assert.equal(r.verified,false);await assert.rejects(()=>journal.assertClear('testnet',TARGET),/recover|blocked/i);
 });
});
