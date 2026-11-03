'use strict';
// Read-only verification for crash recovery. Never signs, sends or retries a transaction.
const {accountId}=require('./core.cjs');
const {verifyDeployment}=require('./deployment-verification.cjs');
const B58=/^[1-9A-HJ-NP-Za-km-z]{35,65}$/;
function sameActions(tx,record){
 const actions=Array.isArray(tx?.transaction?.actions)?tx.transaction.actions:[];
 const expected=record.mode==='new'?['CreateAccount','Transfer',...(record.keyMode==='controlled'?['AddKey']:[]),'DeployContract']:['DeployContract'];
 if(record.initMethod)expected.push('FunctionCall');
 const actual=actions.map(a=>typeof a==='string'?a:a&&typeof a==='object'&&Object.keys(a).length===1?Object.keys(a)[0]:null);
 return actual.length===expected.length&&expected.every((action,i)=>action===actual[i])&&
  (!record.initMethod||actions.at(-1)?.FunctionCall?.method_name===record.initMethod);
}
async function reconcile({journal,network,target,providedHash,rpc,queryAccount}){
 accountId(target,network);
 const record=await journal.get(network,target);
 if(!record)throw Error('No pending recovery record for the selected target and network.');
 if(record.txHash&&providedHash&&record.txHash!==providedHash)
  throw Error('Provided transaction hash conflicts with the protected recovery record.');
 const txHash=record.txHash||providedHash;
 if(!B58.test(txHash||''))
  throw Error('A transaction hash is not saved. Find the hash in a trusted NEAR explorer and enter it to verify.');
 const tx=await rpc('tx',{tx_hash:txHash,sender_account_id:record.signer,wait_until:'FINAL'},network);
 const signed=tx?.transaction;
 if(!signed||signed.hash!==txHash||signed.signer_id!==record.signer||
    signed.receiver_id!==record.target||signed.public_key!==record.publicKey||
    !sameActions(tx,record))
  throw Error('On-chain identity or deployment actions do not match the saved recovery attempt. Guard retained.');
 // Only persist a user-supplied hash after exact public identity/action checks.
 if(!record.txHash)await journal.rememberHash(network,target,txHash);
 const [accountResult,keyResult]=await Promise.allSettled([
  queryAccount(target),
  rpc('query',{request_type:'view_access_key_list',finality:'final',account_id:target},network)
 ]);
 const review=verifyDeployment({
  tx,txHash,signer:record.signer,target,publicKey:record.publicKey,
  mode:record.mode,keyMode:record.keyMode,initMethod:record.initMethod,
  account:accountResult.status==='fulfilled'?accountResult.value:null,
  keys:keyResult.status==='fulfilled'?keyResult.value:null,
  expectedCodeHash:record.expectedCodeHash
 });
 if(accountResult.status!=='fulfilled')review.reasons.push('On-chain account lookup failed.');
 if(keyResult.status!=='fulfilled')review.reasons.push('On-chain access key lookup failed.');
 if(review.verified&&review.reasons.length===0){
  await journal.complete(network,target,{verified:true,txHash});
  return {verified:true,resolved:true,network,target,txHash,
   note:'Final receipts, deployed WASM and account key policy independently verified. Recovery archived.'};
 }
 return {verified:false,resolved:false,network,target,txHash,
  note:'Recovery remains BLOCKED. No transaction was retried. '+review.reasons.join(' ').slice(0,650)};
}
module.exports={reconcile,sameActions};
