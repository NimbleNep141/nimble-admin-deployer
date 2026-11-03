'use strict';
// Recovery is read-only on chain. It can only archive the EXACT transaction
// whose signed hash and nonce were durably fixed before broadcast.
const {accountId}=require('./core.cjs');
const {verifyDeployment}=require('./deployment-verification.cjs');
function exact(tx,a){
 const t=tx?.transaction;
 return Boolean(t&&t.hash===a.txHash&&t.signer_id===a.signer&&
  t.receiver_id===a.target&&t.public_key===a.publicKey&&
  String(t.nonce)===a.nonce&&(!t.block_hash||t.block_hash===a.blockHash));
}
async function lookup({journal,network,target,rpc}){
 accountId(target,network);
 const a=await journal.unresolved(network,target);
 if(!a)throw Error('No unresolved v4 record for this target. Legacy attempts require independent review.');
 if(a.phase!=='broadcast-intent')
  throw Error('Broadcast was never claimed. Use the separate cancel-prebroadcast review instead.');
 const tx=await rpc('tx',{tx_hash:a.txHash,sender_account_id:a.signer,wait_until:'FINAL'},network);
 if(!exact(tx,a))throw Error('On-chain transaction hash, signer, nonce, key or target does not match. Guard preserved.');
 return {a,tx};
}
async function verifySuccessful({journal,network,target,rpc,queryAccount}){
 const {a,tx}=await lookup({journal,network,target,rpc});
 const [q,k]=await Promise.allSettled([
  queryAccount(target),
  rpc('query',{request_type:'view_access_key_list',finality:'final',account_id:target},network)
 ]);
 const review=verifyDeployment({tx,txHash:a.txHash,signer:a.signer,target:a.target,
  publicKey:a.publicKey,mode:a.mode,keyMode:a.keyMode,
  initMethod:a.initMethod,expectedCodeHash:a.expectedCodeHash,
  account:q.status==='fulfilled'?q.value:null,
  keys:k.status==='fulfilled'?k.value:null});
 if(q.status==='rejected')review.reasons.push('Final account query failed.');
 if(k.status==='rejected')review.reasons.push('Final access key query failed.');
 if(!review.verified||review.reasons.length)
  return {resolved:false,txHash:a.txHash,network,target,
   note:'Unverified. No retry or guard removal. '+review.reasons.join(' ').slice(0,650)};
 await journal.resolveVerified(a,'verified-success',{
  id:a.id,txHash:a.txHash,kind:'verified-success',finalized:true,receiptCount:review.receiptCount||0,
  verified:true,codeHash:a.expectedCodeHash});
 return {resolved:true,network,target,txHash:a.txHash,
  note:'Exact signed transaction, all finalized receipts, code hash and owner-key policy independently verified.'};
}
function receiptComplete(tx){
 const root=tx?.transaction_outcome?.outcome;
 if(!root||!root.status||!Array.isArray(tx.receipts_outcome)||!Array.isArray(root.receipt_ids))return false;
 const seen=new Set(),links=[...root.receipt_ids];
 for(const r of tx.receipts_outcome){
  if(!r||typeof r.id!=='string'||seen.has(r.id)||!r.outcome?.status||
     !Array.isArray(r.outcome.receipt_ids))return false;
  seen.add(r.id);
  links.push(...r.outcome.receipt_ids);
 }
 return links.every(id=>typeof id==='string'&&seen.has(id));
}
function clipped(value,max=950){
 let str;try{str=JSON.stringify(value)}catch{str='unavailable'}
 return String(str||'unavailable').slice(0,max);
}
async function inspectFailure({journal,network,target,rpc,queryAccount}){
 const {a,tx}=await lookup({journal,network,target,rpc});
 if(tx.final_execution_status!=='FINAL'||!tx.status||
   !Object.prototype.hasOwnProperty.call(tx.status,'Failure')||!receiptComplete(tx))
  throw Error('Final failed transaction and full receipt graph not independently established; guard retained.');
 const state=await queryAccount(target);
 let keys=[];
 if(state){
  const data=await rpc('query',{request_type:'view_access_key_list',finality:'final',account_id:target},network);
  if(!Array.isArray(data?.keys))throw Error('Cannot inspect access keys after failure.');
  keys=data.keys.map(k=>({publicKey:k.public_key,permission:k.access_key?.permission}));
 }
 const receipts=tx.receipts_outcome.map(r=>({
  id:r.id,executor:r.outcome?.executor_id||'unknown',
  result:clipped(r.outcome?.status,350)
 }));
 const report={network,target,signer:a.signer,txHash:a.txHash,nonce:a.nonce,
  accountExists:Boolean(state),codeHash:state?.code_hash||null,
  amount:state?.amount||null,locked:state?.locked||null,storageUsage:state?.storage_usage??null,
  keyCount:keys.length,keys,receipts,txFailure:clipped(tx.status?.Failure)};
 const {createHash}=require('node:crypto');
 const fingerprint=createHash('sha256').update(JSON.stringify(report)).digest('hex');
 return {attempt:a,report,fingerprint};
}
module.exports={exact,verifySuccessful,inspectFailure,receiptComplete};
