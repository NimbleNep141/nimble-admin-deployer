'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {verifyAccessKeys,verifyFinalizedTransaction,verifyDeployment}=require('../src/deployment-verification.cjs');
const OWNER='alice.near';
const TARGET='contract.alice.near';
const PUB='ed25519:6hY14aExpectedFullAccessKey';
const WRONG='ed25519:6hY14aWrongKey';
const TX='7YuZyExpectedFinalizedTransactionHash';
const CODE_HASH='5qWasmHash';
const full=key=>({public_key:key,access_key:{nonce:1,permission:'FullAccess'}});
const restricted=key=>({public_key:key,access_key:{nonce:1,permission:{FunctionCall:{receiver_id:TARGET,method_names:['new']}}}});
const clone=x=>JSON.parse(JSON.stringify(x));
const cfg={txHash:TX,signer:OWNER,target:TARGET,publicKey:PUB,mode:'new',keyMode:'controlled',initMethod:'new'};
const account={code_hash:CODE_HASH};
const keys={keys:[full(PUB)]};
function fixture(options={}){
 const actions=[{CreateAccount:{}},{Transfer:{deposit:'1000000000000000000000000'}},
   {AddKey:{public_key:PUB,access_key:{permission:'FullAccess'}}},{DeployContract:{code:'AGFzbQEAAAA='}},
   {FunctionCall:{method_name:'new',args:'e30=',gas:'30000000000000',deposit:'0'}}];
 if(options.noInit)actions.pop();
 return {final_execution_status:'FINAL',status:{SuccessValue:''},
  transaction:{hash:TX,signer_id:OWNER,receiver_id:TARGET,public_key:PUB,actions},
  transaction_outcome:{id:TX,outcome:{status:{SuccessReceiptId:'receipt-1'},receipt_ids:['receipt-1']}},
  receipts_outcome:[{id:'receipt-1',outcome:{executor_id:TARGET,status:{SuccessValue:''},receipt_ids:[]}}]};
}
function evaluate(tx=fixture(),customCfg={},customKeys=keys,customAccount=account){
 return verifyDeployment({tx,...cfg,...customCfg,keys:customKeys,account:customAccount,expectedCodeHash:CODE_HASH});
}
test('matching FullAccess owner key + finalized transaction and initializer receipts is verified',()=>{
 const report=evaluate();
 assert.equal(report.verified,true);
 assert.equal(report.ownerKeyVerified,true);
 assert.equal(report.transactionVerified,true);
 assert.equal(report.initializationVerified,true);
 assert.equal(report.finalityVerified,true);
 assert.equal(report.receiptCount,1);
 assert.deepEqual(report.reasons,[]);
});
test('wrong FullAccess key with correct key count is NOT verified',()=>{
 const report=evaluate(fixture(),{}, {keys:[full(WRONG)]});
 assert.equal(report.verified,false);
 assert.equal(report.keyCount,1);
 assert.equal(report.ownerKeyVerified,false);
 assert.match(report.reasons.join(' '),/public key/i);
});
test('correct public key without FullAccess permission is rejected',()=>{
 const report=evaluate(fixture(),{}, {keys:[restricted(PUB)]});
 assert.equal(report.verified,false);
 assert.equal(report.ownerKeyVerified,false);
});
test('new recoverable account rejects other unexpected access keys',()=>{
 const report=evaluate(fixture(),{}, {keys:[full(PUB),restricted(WRONG)]});
 assert.equal(report.verified,false);
 assert.equal(report.ownerKeyVerified,false);
 assert.equal(report.otherKeyCount,1);
});
test('existing account may have other keys but must retain expected FullAccess signer',()=>{
 const tx=fixture({noInit:true});
 tx.transaction.actions=[{DeployContract:{code:'AGFzbQEAAAA='}}];
 const report=evaluate(tx,{mode:'existing',initMethod:''},{keys:[restricted(WRONG),full(PUB)]});
 assert.equal(report.verified,true);
 assert.equal(report.ownerKeyVerified,true);
 assert.equal(report.otherKeyCount,1);
 assert.equal(report.initializationVerified,null);
 const missing=evaluate(tx,{mode:'existing',initMethod:''},{keys:[full(WRONG)]});
 assert.equal(missing.verified,false);
 assert.equal(missing.ownerKeyVerified,false);
});
test('intentionally keyless contract must contain no keys; never claims owner-key verification',()=>{
 const tx=fixture();
 tx.transaction.actions=tx.transaction.actions.filter(a=>!Object.hasOwn(a,'AddKey'));
 const report=evaluate(tx,{keyMode:'keyless'},{keys:[]});
 assert.equal(report.verified,true);
 assert.equal(report.keyless,true);
 assert.equal(report.ownerKeyVerified,false);
 assert.match(report.keyStatus,/not recoverable/i);
 assert.equal(evaluate(tx,{keyMode:'keyless'},{keys:[full(PUB)]}).verified,false);
});
test('missing or malformed key lists must never verify',()=>{
 for(const k of [null,{}, {keys:null},{keys:{length:1}},{keys:[]}])
  assert.equal(evaluate(fixture(),{},k).verified,false);
});
test('missing or mismatched code hash fails even with correct owner key and receipts',()=>{
 assert.equal(evaluate(fixture(),{},keys,null).verified,false);
 assert.equal(evaluate(fixture(),{},keys,{code_hash:'wrong'}).verified,false);
});
test('pending, unknown or failed final transaction status is NOT verified',()=>{
 for(const [field,value] of [
  ['final_execution_status','EXECUTED'],['status',{Failure:{ActionError:{}}}],
  ['status','Started'],['status',{SuccessReceiptId:'receipt-1'}]
 ]){
  const tx=fixture();tx[field]=value;
  assert.equal(evaluate(tx).verified,false,field);
 }
 assert.equal(evaluate(null).verified,false);
});
test('wrong transaction hash, signer, receiver or signing public key cannot verify',()=>{
 for(const [field,value]of [['hash','bad'],['signer_id','attacker.near'],['receiver_id','other.near'],['public_key',WRONG]]){
  const tx=fixture();tx.transaction[field]=value;
  assert.equal(evaluate(tx).verified,false,field);
 }
});
test('a successful outer transaction cannot mask a failed initializer receipt',()=>{
 const tx=fixture();
 tx.receipts_outcome[0].outcome.status={Failure:{ActionError:{kind:{FunctionCallError:'MethodNotFound'}}}};
 const report=evaluate(tx);
 assert.equal(report.verified,false);
 assert.equal(report.initializationVerified,false);
 assert.match(report.reasons.join(' '),/Receipt/);
});
test('missing, unknown and incomplete receipt graphs fail closed',()=>{
 const cases=[];
 let tx=fixture();delete tx.receipts_outcome;cases.push(tx);
 tx=fixture();tx.receipts_outcome=[];cases.push(tx);
 tx=fixture();tx.receipts_outcome[0].outcome.status='Unknown';cases.push(tx);
 tx=fixture();tx.transaction_outcome.outcome.receipt_ids=['receipt-1','receipt-2'];cases.push(tx);
 tx=fixture();tx.receipts_outcome[0].outcome.receipt_ids=['receipt-2'];cases.push(tx);
 tx=fixture();tx.receipts_outcome[0].outcome.executor_id='other.near';cases.push(tx);
 tx=fixture();tx.transaction_outcome.outcome.status='Unknown';cases.push(tx);
 for(const item of cases)assert.equal(evaluate(item).verified,false);
});
test('initializer function must be present and match the approved method',()=>{
 const tx=fixture();
 tx.transaction.actions.at(-1).FunctionCall.method_name='evil';
 assert.equal(evaluate(tx).verified,false);
 const missing=fixture({noInit:true});
 assert.equal(evaluate(missing).verified,false);
});
test('unexpected additional transaction actions cannot verify',()=>{
 const tx=fixture();tx.transaction.actions.push({DeleteKey:{public_key:PUB}});
 assert.equal(evaluate(tx).verified,false);
});
test('malformed transaction action list does not produce a false success',()=>{
 const tx=fixture();delete tx.transaction.actions;
 assert.equal(evaluate(tx).verified,false);
});
