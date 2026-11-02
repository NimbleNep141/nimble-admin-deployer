'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createHash}=require('node:crypto'),c=require('../src/core.cjs'),u=require('../src/upgrade-safety.cjs');
const OLD=Buffer.from([0,97,115,109,1,0,0,0,1,2]),NEW=Buffer.from([0,97,115,109,1,0,0,0,3,4]);
const ACCOUNT='contract.owner.testnet',TARGET='contract.owner.near',PUB='ed25519:testowner';
const hash=x=>createHash('sha256').update(x).digest();
async function fixture(){
 const {baseEncode}=await import('near-api-js');
 const oldHash=baseEncode(hash(OLD)),newCodeHash=baseEncode(hash(NEW));
 const baselineTx=baseEncode(hash(Buffer.from('baseline'))),upgradeTx=baseEncode(hash(Buffer.from('upgrade')));
 const receipt=id=>[{id,outcome:{executor_id:ACCOUNT,status:{SuccessValue:''},receipt_ids:[]}}];
 const tx=(id,actions,block)=>{
  const receipts=receipt('receipt-'+id.slice(0,8));
  return {final_execution_status:'FINAL',status:{SuccessValue:''},
   transaction:{hash:id,signer_id:ACCOUNT,receiver_id:ACCOUNT,public_key:PUB,actions},
   transaction_outcome:{block_hash:block,outcome:{status:{SuccessReceiptId:receipts[0].id},receipt_ids:[receipts[0].id]}},
   receipts_outcome:receipts};
 };
 const oldTx=tx(baselineTx,[{DeployContract:{code:OLD.toString('base64')}}],'oldblock');
 const newTx=tx(upgradeTx,[{DeployContract:{code:NEW.toString('base64')}},
  {FunctionCall:{method_name:'migrate',args:Buffer.from('{"version":2}').toString('base64')}}],'newblock');
 const statement='The old and new persistent states have been compared and tested using Testnet state records.';
 const input={approvedTarget:TARGET,approvedOldHash:oldHash,approvedNewSha:c.sha(NEW),
  stateSchema:statement,migrationPlan:statement,rollbackPlan:statement,testCoverage:statement,
  testnetAccount:ACCOUNT,baselineTx,upgradeTx,viewMethod:'get_version',viewArgs:'{}',
  expectedView:'{"version":2}',ackCompatible:true,ackRollback:true,ackNotGuaranteed:true};
 const params={target:TARGET,oldCodeHash:oldHash,newSha:c.sha(NEW),initMethod:'migrate',initArgs:'{"version":2}'};
 const proof={...u.validateEvidence(input,params),oldSha:c.sha(OLD)};
 const rpc=async(method,args,chain)=>{
  assert.equal(chain,'testnet');
  if(method==='status')return {chain_id:'testnet'};
  if(method==='tx')return args.tx_hash===baselineTx?oldTx:args.tx_hash===upgradeTx?newTx:null;
  if(method==='block')return {header:{height:args.block_id==='oldblock'?1000:1010}};
  if(method==='query'&&args.request_type==='view_code')return {hash:newCodeHash,code_base64:NEW.toString('base64')};
  if(method==='query'&&args.request_type==='call_function')return {result:[...Buffer.from('{"version":2}')]};
  throw Error('Unexpected RPC '+method);
 };
 return {baseEncode,oldHash,newCodeHash,input,params,proof,rpc,oldTx,newTx};
}
test('report requires state documentation, exact hashes and explicit consent',async()=>{
 const f=await fixture();
 assert.equal(u.validateEvidence(f.input,f.params).mainnetTarget,TARGET);
 assert.throws(()=>u.validateEvidence({...f.input,approvedOldHash:'wrong'},f.params),/hash/);
 assert.throws(()=>u.validateEvidence({...f.input,ackNotGuaranteed:false},f.params),/Acknowledge/);
 assert.throws(()=>u.validateEvidence({...f.input,stateSchema:'brief'},f.params),/schema/i);
 assert.throws(()=>u.validateEvidence({...f.input,testnetAccount:'someone.near'},f.params),/Testnet/i);
});
test('valid Testnet baseline, finalized migration and state view are verified read-only',async()=>{
 const f=await fixture(),p=await u.verifyTestnetRehearsal(f.proof,{rpc:f.rpc,baseEncode:f.baseEncode});
 assert.equal(p.oldHeight,1000);assert.equal(p.newHeight,1010);
 assert.equal(p.oldCodeHash,f.oldHash);assert.equal(p.actualView.version,2);
});
test('failed initializer receipt rejects Testnet evidence',async()=>{
 const f=await fixture();f.newTx.receipts_outcome[0].outcome.status={Failure:{}};
 await assert.rejects(u.verifyTestnetRehearsal(f.proof,{rpc:f.rpc,baseEncode:f.baseEncode}),/receipts failed/);
});
test('mismatched migration method, argument or new WASM fail',async()=>{
 for(const field of ['method','args','code']){
  const f=await fixture();
  if(field==='method')f.newTx.transaction.actions[1].FunctionCall.method_name='other';
  if(field==='args')f.newTx.transaction.actions[1].FunctionCall.args=Buffer.from('{}').toString('base64');
  if(field==='code')f.newTx.transaction.actions[0].DeployContract.code=OLD.toString('base64');
  await assert.rejects(u.verifyTestnetRehearsal(f.proof,{rpc:f.rpc,baseEncode:f.baseEncode}));
 }
});
test('changed view output, historical baseline mismatch or wrong chain fail closed',async()=>{
 const f=await fixture();
 await assert.rejects(u.verifyTestnetRehearsal({...f.proof,expectedView:{version:5}},{rpc:f.rpc,baseEncode:f.baseEncode}),/unexpected state/);
 await assert.rejects(u.verifyTestnetRehearsal({...f.proof,oldSha:c.sha(NEW)},{rpc:f.rpc,baseEncode:f.baseEncode}),/different WASM/);
 const wrongChain=async(method,args,net)=>method==='status'?{chain_id:'mainnet'}:f.rpc(method,args,net);
 await assert.rejects(u.verifyTestnetRehearsal(f.proof,{rpc:wrongChain,baseEncode:f.baseEncode}),/not on NEAR Testnet/);
});
test('WASM code hash and saved rollback report are verified byte-for-byte',async()=>{
 const f=await fixture(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-rollback-'));
 try{
  assert.deepEqual(u.decodeCodeResponse({hash:f.oldHash,code_base64:OLD.toString('base64')},f.baseEncode),OLD);
  assert.throws(()=>u.decodeCodeResponse({hash:f.newCodeHash,code_base64:OLD.toString('base64')},f.baseEncode),/do not match/);
  const archive=await u.retainRollback(dir,{target:TARGET,oldCodeHash:f.oldHash,oldWasm:OLD,report:{newSha:c.sha(NEW)}});
  assert.equal((await u.verifyArchive(archive)).oldSha256,c.sha(OLD));
  await fs.writeFile(archive.file,NEW);
  await assert.rejects(u.verifyArchive(archive),/changed or is damaged/);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
test('Mainnet upgrade is gated during preflight, before native approval and after approval',()=>{
 const main=require('node:fs').readFileSync(path.join(__dirname,'../src/main.cjs'),'utf8');
 for(const token of ['MAINNET UPGRADE BLOCKED','verifyTestnetRehearsal','retainRollback',
   'const prepared=await requireUpgradeReview(data,details)',
   'const prepared=await requireUpgradeReview(data.config,report)',
   'await requireUpgradeReview(data.config,fresh)'])
  assert.ok(main.includes(token),token);
});
