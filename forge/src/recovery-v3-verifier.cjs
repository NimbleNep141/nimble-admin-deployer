'use strict';
// Read-only verified reconciliation. Exact hash and nonce were durably fixed
// BEFORE broadcast. There is no user-supplied hash, auto-resend or re-sign path.
const {accountId}=require('./core.cjs');
const {verifyDeployment}=require('./deployment-verification.cjs');
function exactTransaction(tx,record){
 const signed=tx?.transaction;
 if(!signed||signed.hash!==record.txHash||signed.signer_id!==record.signer||
    signed.receiver_id!==record.target||signed.public_key!==record.publicKey||
    String(signed.nonce)!==record.nonce)return false;
 if(signed.block_hash&&signed.block_hash!==record.blockHash)return false;
 return true;
}
async function loadExact({journal,network,target,rpc}){
 accountId(target,network);
 const record=await journal.get(network,target);
 if(!record)throw Error('No prepared v3 transaction record for this target. Legacy records require separate review.');
 const tx=await rpc('tx',{tx_hash:record.txHash,sender_account_id:record.signer,wait_until:'FINAL'},network);
 if(!exactTransaction(tx,record))
  throw Error('On-chain transaction identity, nonce or hash mismatch. Guard retained.');
 return {record,tx};
}
async function verifyRecovery({journal,network,target,rpc,queryAccount}){
 const {record,tx}=await loadExact({journal,network,target,rpc});
 const [a,k]=await Promise.allSettled([
  queryAccount(target),
  rpc('query',{request_type:'view_access_key_list',finality:'final',account_id:target},network)
 ]);
 const report=verifyDeployment({tx,txHash:record.txHash,signer:record.signer,
  target:record.target,publicKey:record.publicKey,mode:record.mode,keyMode:record.keyMode,
  initMethod:record.initMethod,expectedCodeHash:record.expectedCodeHash,
  account:a.status==='fulfilled'?a.value:null,keys:k.status==='fulfilled'?k.value:null});
 if(a.status==='rejected')report.reasons.push('Account state lookup failed.');
 if(k.status==='rejected')report.reasons.push('Access-key list lookup failed.');
 if(report.verified&&report.reasons.length===0){
  await journal.completeSuccess(network,target,record.txHash,{verified:true});
  return {resolved:true,status:'verified-success',network,target,txHash:record.txHash};
 }
 return {resolved:false,status:'unverified',network,target,txHash:record.txHash,
  note:report.reasons.join(' ').slice(0,700)};
}
function receiptGraphComplete(tx){
 const root=tx?.transaction_outcome?.outcome;
 if(!root||!root.status||!Array.isArray(tx?.receipts_outcome))return false;
 const receipts=tx.receipts_outcome,seen=new Set();
 const ids=[...(Array.isArray(root.receipt_ids)?root.receipt_ids:[])];
 for(const r of receipts){
  if(!r||typeof r.id!=='string'||seen.has(r.id)||!r.outcome||!r.outcome.status)return false;
  seen.add(r.id);
  const status=r.outcome.status;
  if(!('Failure' in status)&&!('SuccessValue' in status)&&!('SuccessReceiptId' in status))return false;
  if(!Array.isArray(r.outcome.receipt_ids))return false;
  ids.push(...r.outcome.receipt_ids);
 }
 return ids.every(id=>typeof id==='string'&&seen.has(id));
}
async function verifyFailure({journal,network,target,rpc,queryAccount}){
 const {record,tx}=await loadExact({journal,network,target,rpc});
 if(tx.final_execution_status!=='FINAL'||!tx.status||typeof tx.status!=='object'||
   !Object.prototype.hasOwnProperty.call(tx.status,'Failure')||!receiptGraphComplete(tx))
  throw Error('Exact transaction is not independently confirmed FINAL with complete failure receipts. Guard retained.');
 // A confirmed failed transaction may have partially created or modified an account.
 // Read current account state so the native review can explicitly display what remains.
 const state=await queryAccount(target);
 let keyCount=null;
 if(state){
  const keys=await rpc('query',{request_type:'view_access_key_list',finality:'final',account_id:target},network);
  if(!Array.isArray(keys?.keys))throw Error('Cannot inspect access keys after failure. Guard retained.');
  keyCount=keys.keys.length;
 }
 return {finalFailure:true,network,target,txHash:record.txHash,
  signer:record.signer,nonce:record.nonce,accountExists:Boolean(state),
  codeHash:state?.code_hash||null,keyCount,
  receiptCount:tx.receipts_outcome.length};
}
module.exports={verifyRecovery,verifyFailure,exactTransaction,receiptGraphComplete};
