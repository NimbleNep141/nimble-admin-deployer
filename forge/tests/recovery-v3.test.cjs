'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {RecoveryJournalV3}=require('../src/recovery-v3-journal.cjs');
const {signPersistSend}=require('../src/recovery-v3-broadcast.cjs');
const {verifyRecovery,verifyFailure}=require('../src/recovery-v3-verifier.cjs');
const HASH='2'.repeat(44),BLOCK='5'.repeat(44),CODE='4'.repeat(44),PUB='ed25519:'+'3'.repeat(44);
const base={network:'testnet',target:'widget.owner.testnet',signer:'owner.testnet',
 publicKey:PUB,mode:'new',keyMode:'controlled',initMethod:'new',
 wasmSha256:'a'.repeat(64),expectedCodeHash:CODE,txHash:HASH,nonce:'15',blockHash:BLOCK};
const args=()=>({...base});
const MOCK_ENCODED=Buffer.from('near-v3-signed-fixture');
const MOCK_TX_HASH=createHash('sha256').update(MOCK_ENCODED).digest();
const stubUnsigned=()=>({signerId:base.signer,receiverId:base.target,
 publicKey:{toString:()=>PUB},nonce:15n,blockHash:new Uint8Array(32).fill(2),
 encode:()=>MOCK_ENCODED});
const stubSigner=()=>({signTransaction:async unsigned=>({
 txHash:new Uint8Array(MOCK_TX_HASH),signedTransaction:{transaction:unsigned}})});
const stubEncode=bytes=>Buffer.from(bytes).equals(MOCK_TX_HASH)?HASH:BLOCK;
async function workspace(fn){const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-v3-'));
 try{return await fn(root)}finally{await fs.rm(root,{recursive:true,force:true})}}
function outcome(status={SuccessValue:''}){
 return {final_execution_status:'FINAL',status,
  transaction:{hash:HASH,signer_id:base.signer,receiver_id:base.target,public_key:PUB,nonce:15,
  actions:[{CreateAccount:{}},{Transfer:{deposit:'1'}},{AddKey:{public_key:PUB}},{DeployContract:{code:'AGFzbQEAAAA='}},{FunctionCall:{method_name:'new',args:'e30='}}]},
  transaction_outcome:{outcome:{status:{SuccessReceiptId:'r'},receipt_ids:['r']}},
  receipts_outcome:[{id:'r',outcome:{status:{SuccessValue:''},executor_id:base.target,receipt_ids:[]}}]};
}
const access={keys:[{public_key:PUB,access_key:{permission:'FullAccess'}}]};
const mockRpc=async(method)=>method==='tx'?outcome():access;
test('exact signed transaction hash and nonce are stored BEFORE broadcast and survive restart',async()=>{
 await workspace(async root=>{
  const journal=new RecoveryJournalV3(root);let sendCount=0,storedAtSend=null;
  const account={
   getSigner:stubSigner,
   createTransaction:async()=>stubUnsigned(),
   provider:{sendTransactionUntil:async()=>{sendCount++;storedAtSend=await new RecoveryJournalV3(root).get(base.network,base.target);return outcome();}}
  };
  const tx=await signPersistSend({account,journal,approved:base,actions:[],baseEncode:stubEncode});
  assert.equal(tx.transaction.hash,HASH);assert.equal(sendCount,1);
  assert.equal(storedAtSend.txHash,HASH);assert.equal(storedAtSend.nonce,'15');
  await assert.rejects(()=>journal.assertClear(base.network,base.target),/recovery|pending|blocked/i);
 });
});
test('storage failure prevents ANY broadcast, even after signing',async()=>{
 await workspace(async root=>{
  const journal=new RecoveryJournalV3(root);await journal.start(base);
  let sent=0;
  const account={createTransaction:async()=>stubUnsigned(),
   getSigner:stubSigner,
   provider:{sendTransactionUntil:async()=>{sent++}}};
  await assert.rejects(()=>signPersistSend({account,journal,approved:base,actions:[],baseEncode:stubEncode}),/pending|recover|blocked/i);
  assert.equal(sent,0);
 });
});
test('journal never stores signing secrets or initializer data',async()=>{
 await workspace(async root=>{
  const journal=new RecoveryJournalV3(root);await journal.start({...base,privateKey:'PRIVATE_CANARY',initArgs:{secret:'SECRET_CANARY'}});
  const p=path.join(root,'recovery-v3','active');const filename=(await fs.readdir(p))[0];
  const text=await fs.readFile(path.join(p,filename),'utf8');
  assert.ok(!/PRIVATE_CANARY|SECRET_CANARY|privateKey|initArgs/.test(text));
 });
});
test('legacy records block only their own identifiable target, not other targets',async()=>{
 await workspace(async root=>{
  const old=path.join(root,'deployment-journal','active');await fs.mkdir(old,{recursive:true});
  const {createHash}=require('node:crypto');
  const file=createHash('sha256').update(base.network+'\0'+base.target).digest('hex')+'.json';
  await fs.writeFile(path.join(old,file),JSON.stringify({schemaVersion:1,network:base.network,target:base.target,
   signer:base.signer,id:'11111111-1111-4111-8111-111111111111',status:'submitted',txHash:HASH}));
  const journal=new RecoveryJournalV3(root);
  await assert.doesNotReject(()=>journal.assertClear('testnet','other.owner.testnet'));
  await assert.rejects(()=>journal.assertClear('testnet',base.target),/legacy|recovery|blocked/i);
  const list=await journal.list('testnet');assert.equal(list[0].legacy,true);
 });
});
test('corrupt legacy identity is a fail-closed exception, never silently dropped',async()=>{
 await workspace(async root=>{
  const old=path.join(root,'deployment-journal','active');await fs.mkdir(old,{recursive:true});
  await fs.writeFile(path.join(old,'bad.json'),'oops');
  const journal=new RecoveryJournalV3(root);
  await assert.rejects(()=>journal.assertClear('testnet','other.owner.testnet'),/corrupt|legacy|unreadable/i);
 });
});
test('exact hash and nonce disallow older identical-action transactions',async()=>{
 await workspace(async root=>{
  const journal=new RecoveryJournalV3(root);await journal.start(base);
  const wrong=outcome();wrong.transaction.hash='6'.repeat(44);
  await assert.rejects(()=>verifyRecovery({journal,network:base.network,target:base.target,
   rpc:async method=>method==='tx'?wrong:access,queryAccount:async()=>({code_hash:CODE})}),/identity|hash|match/i);
  assert.ok(await journal.get(base.network,base.target));
 });
});
test('verified successful transaction archives and unlocks same target without old session guard',async()=>{
 await workspace(async root=>{
  const journal=new RecoveryJournalV3(root);await journal.start(base);
  const result=await verifyRecovery({journal,network:base.network,target:base.target,
   rpc:mockRpc,queryAccount:async()=>({code_hash:CODE})});
  assert.equal(result.resolved,true);
  await journal.assertClear(base.network,base.target);
  await journal.start(base);
 });
});
test('confirmed FINAL failure is reviewable, but does not clear before explicit approval',async()=>{
 await workspace(async root=>{
  const journal=new RecoveryJournalV3(root);await journal.start(base);
  const failure=outcome({Failure:{ActionError:{}}});
  const inspected=await verifyFailure({journal,network:base.network,target:base.target,
   rpc:async method=>method==='tx'?failure:access,queryAccount:async()=>({code_hash:CODE})});
  assert.equal(inspected.finalFailure,true);
  await assert.rejects(()=>journal.assertClear(base.network,base.target),/pending|recovery|blocked/i);
  await journal.completeFailure(base.network,base.target,HASH,{reviewed:true,finalFailure:true});
  await journal.assertClear(base.network,base.target);
 });
});
test('unconfirmed failure and uncertain/hashless legacy attempts cannot be released',async()=>{
 await workspace(async root=>{
  const journal=new RecoveryJournalV3(root);await journal.start(base);
  await assert.rejects(()=>journal.completeFailure(base.network,base.target,HASH,{reviewed:false,finalFailure:true}),/review/i);
  await assert.rejects(()=>journal.completeFailure(base.network,base.target,HASH,{reviewed:true,finalFailure:false}),/final|failed/i);
  assert.ok(await journal.get(base.network,base.target));
 });
});
test('only one concurrent attempt can claim a target',async()=>{
 await workspace(async root=>{
  const journal=new RecoveryJournalV3(root);
  const r=await Promise.allSettled([journal.start(base),journal.start(base)]);
  assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
 });
});
test('main/preload/renderer have no old session-only deployment target guard',async()=>{
 const main=await fs.readFile(path.join(__dirname,'../src/main.cjs'),'utf8');
 const renderer=await fs.readFile(path.join(__dirname,'../src/renderer.js'),'utf8');
 assert.doesNotMatch(main,/attemptedTargets/);
 assert.doesNotMatch(renderer,/submittedTarget/);
 assert.match(main,/signPersistSend/);
 assert.doesNotMatch(main,/signer\.account\.signAndSendTransaction/);
});

test('tampered signed transaction payload is rejected before any journal write or broadcast',async()=>{
 await workspace(async root=>{
  const journal=new RecoveryJournalV3(root);let sent=0;
  const account={createTransaction:async()=>stubUnsigned(),
   getSigner:()=>({signTransaction:async unsigned=>({
    txHash:new Uint8Array(MOCK_TX_HASH),
    signedTransaction:{transaction:{...unsigned,encode:()=>Buffer.from('tampered payload')}}})}),
   provider:{sendTransactionUntil:async()=>{sent++}}};
  await assert.rejects(()=>signPersistSend({account,journal,approved:base,actions:[],baseEncode:stubEncode}),/Signer returned different/);
  assert.equal(sent,0);assert.equal(await journal.get(base.network,base.target),null);
 });
});
test('a signer-returned incorrect SHA-256 cannot be used to authorize broadcast',async()=>{
 await workspace(async root=>{
  const journal=new RecoveryJournalV3(root);let sent=0;
  const account={createTransaction:async()=>stubUnsigned(),
   getSigner:()=>({signTransaction:async unsigned=>({
    txHash:new Uint8Array(32).fill(9),signedTransaction:{transaction:unsigned}})}),
   provider:{sendTransactionUntil:async()=>{sent++}}};
  await assert.rejects(()=>signPersistSend({account,journal,approved:base,actions:[],baseEncode:stubEncode}),/hash/);
  assert.equal(sent,0);assert.equal(await journal.get(base.network,base.target),null);
 });
});
test('same signer, target and action types with a DIFFERENT nonce cannot resolve recovery',async()=>{
 await workspace(async root=>{
  const journal=new RecoveryJournalV3(root);await journal.start(base);
  const wrong=outcome();wrong.transaction.nonce=14;
  await assert.rejects(()=>verifyRecovery({journal,network:base.network,target:base.target,
   rpc:async method=>method==='tx'?wrong:access,queryAccount:async()=>({code_hash:CODE})}),/nonce|identity|hash/i);
  assert.ok(await journal.get(base.network,base.target));
 });
});
test('failed transaction with incomplete receipt evidence cannot be manually released',async()=>{
 await workspace(async root=>{
  const journal=new RecoveryJournalV3(root);await journal.start(base);
  const tx=outcome({Failure:{ActionError:{}}});
  tx.receipts_outcome=[];
  await assert.rejects(()=>verifyFailure({journal,network:base.network,target:base.target,
   rpc:async method=>method==='tx'?tx:access,queryAccount:async()=>({code_hash:CODE})}),/complete|receipt|failure/i);
  await assert.rejects(()=>journal.assertClear(base.network,base.target),/pending|recovery/i);
 });
});
test('corrupt v3 evidence blocks unrelated submissions until data is inspected',async()=>{
 await workspace(async root=>{
  const journal=new RecoveryJournalV3(root);await journal.start(base);
  const folder=path.join(root,'recovery-v3','active');
  const name=(await fs.readdir(folder))[0];await fs.writeFile(path.join(folder,name),'{broken');
  await assert.rejects(()=>journal.assertClear('testnet','other.owner.testnet'),/corrupt|unreadable/i);
 });
});
