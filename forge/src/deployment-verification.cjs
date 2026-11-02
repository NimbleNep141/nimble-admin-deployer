'use strict';
// Fail-closed, read-only verification of a finalized NEAR deployment.
// Does not sign, retry or submit transactions.
const own=(value,key)=>Boolean(value&&typeof value==='object'&&Object.prototype.hasOwnProperty.call(value,key));
const successValue=status=>own(status,'SuccessValue')&&typeof status.SuccessValue==='string';
const successReceipt=status=>own(status,'SuccessReceiptId')&&typeof status.SuccessReceiptId==='string'&&status.SuccessReceiptId.length>0;
const successAction=status=>successValue(status)||successReceipt(status);
function actionName(action){
 if(typeof action==='string')return action;
 if(!action||typeof action!=='object'||Array.isArray(action))return null;
 const keys=Object.keys(action);
 return keys.length===1?keys[0]:null;
}
function verifyAccessKeys(keys,{mode,keyMode,publicKey}){
 const entries=Array.isArray(keys?.keys)?keys.keys:null;
 const keyCount=entries?.length??null;
 const keyless=mode==='new'&&keyMode==='keyless';
 if(!entries)return {valid:false,ownerKeyVerified:false,keyless,keyCount,otherKeyCount:null,note:'Account access-key list is missing or malformed.'};
 if(keyless)return {
  valid:keyCount===0,ownerKeyVerified:false,keyless:true,keyCount,otherKeyCount:keyCount,
  note:keyCount===0?'Intentionally keyless: no FullAccess owner key; this contract is not recoverable using a normal key.':'Keyless deployment unexpectedly contains access keys.'
 };
 if(typeof publicKey!=='string'||!publicKey.startsWith('ed25519:'))
  return {valid:false,ownerKeyVerified:false,keyless:false,keyCount,otherKeyCount:keyCount,note:'Expected signing public key is missing.'};
 const matching=entries.filter(entry=>entry&&entry.public_key===publicKey&&entry.access_key?.permission==='FullAccess');
 const otherKeyCount=entries.filter(entry=>!entry||entry.public_key!==publicKey).length;
 const exact=matching.length===1&&(mode!=='new'||otherKeyCount===0&&keyCount===1);
 return {valid:exact,ownerKeyVerified:exact,keyless:false,keyCount,otherKeyCount,
  note:exact?(otherKeyCount?'Expected FullAccess owner key confirmed; '+otherKeyCount+' additional access key(s) remain.':'Expected FullAccess owner key confirmed.'):
   matching.length!==1?'Expected owner public key with FullAccess permission was NOT found.':
   'A newly created recoverable account has unexpected additional access keys.'
 };
}
function verifyFinalizedTransaction(tx,{txHash,signer,target,publicKey,mode,keyMode,initMethod}){
 const issues=[];
 if(!tx||typeof tx!=='object')return {valid:false,issues:['Independent on-chain transaction result was not available.'],receiptCount:null,initializationVerified:false,finalityVerified:false};
 const finalized=tx.final_execution_status==='FINAL';
 if(!finalized)issues.push('Independent transaction result has not reached FINAL finality.');
 if(!successValue(tx.status))issues.push('Final transaction status is missing, failed, or not a completed SuccessValue.');
 const signed=tx.transaction;
 if(!signed||signed.hash!==txHash||signed.signer_id!==signer||signed.receiver_id!==target||signed.public_key!==publicKey)
  issues.push('The finalized transaction identity or signing public key does not match the approved deployment.');
 const actions=Array.isArray(signed?.actions)?signed.actions:[];
 const expected=mode==='new'?['CreateAccount','Transfer',...(keyMode==='controlled'?['AddKey']:[]),'DeployContract']:['DeployContract'];
 if(initMethod)expected.push('FunctionCall');
 const actual=actions.map(actionName);
 const actionsMatch=expected.length===actual.length&&expected.every((name,index)=>name===actual[index]);
 if(!actionsMatch)issues.push('Finalized transaction actions differ from the approved deployment plan.');
 const initAction=initMethod&&actions.at(-1);
 const methodCorrect=!initMethod||Boolean(
  typeof initAction==='object'&&initAction?.FunctionCall?.method_name===initMethod
 );
 if(!methodCorrect)issues.push('Initialization method is missing or does not match the approved method.');
 const root=tx.transaction_outcome?.outcome;
 if(!successAction(root?.status))issues.push('Transaction execution outcome is missing or unsuccessful.');
 const receipts=Array.isArray(tx.receipts_outcome)?tx.receipts_outcome:null;
 if(!receipts?.length)issues.push('Finalized receipt outcomes are missing.');
 const receiptIds=new Set();
 let successfulTargetReceipt=false;
 if(receipts){
  for(const item of receipts){
   if(!item||typeof item.id!=='string'||receiptIds.has(item.id)||!item.outcome){
    issues.push('Malformed or duplicated receipt outcome.');continue;
   }
   receiptIds.add(item.id);
   if(!successAction(item.outcome.status))issues.push('Receipt '+item.id+' failed or has an unknown/pending status.');
   if(item.outcome.executor_id===target&&successAction(item.outcome.status))successfulTargetReceipt=true;
  }
 }
 if(!successfulTargetReceipt)issues.push('No successful execution receipt was found for the intended contract account.');
 const ids=[...(Array.isArray(root?.receipt_ids)?root.receipt_ids:[])];
 if(!ids.length)issues.push('Transaction did not report the contract execution receipt.');
 if(receipts)for(const receipt of receipts)if(Array.isArray(receipt?.outcome?.receipt_ids))ids.push(...receipt.outcome.receipt_ids);
 if(ids.some(id=>typeof id!=='string'||!receiptIds.has(id)))issues.push('At least one downstream receipt was not confirmed.');
 // An initializer is independently verified only when the entire finalized execution
 // and its receipt chain match the approved transaction, including the FunctionCall.
 const initializationVerified=initMethod?issues.length===0:null;
 return {valid:issues.length===0,issues,receiptCount:receipts?.length??null,initializationVerified,finalityVerified:finalized};
}
function verifyDeployment({tx,txHash,signer,target,publicKey,mode,keyMode,initMethod,account,keys,expectedCodeHash}){
 const receipts=verifyFinalizedTransaction(tx,{txHash,signer,target,publicKey,mode,keyMode,initMethod});
 const access=verifyAccessKeys(keys,{mode,keyMode,publicKey});
 const hashMatches=Boolean(account&&typeof expectedCodeHash==='string'&&expectedCodeHash&&account.code_hash===expectedCodeHash);
 const reasons=[...receipts.issues];
 if(!hashMatches)reasons.push('On-chain contract code hash does not match the approved WASM.');
 if(!access.valid)reasons.push(access.note);
 return {
  verified:reasons.length===0,
  hashMatches,
  keyValid:access.valid,
  ownerKeyVerified:access.ownerKeyVerified,
  keyless:access.keyless,
  keyCount:access.keyCount,
  otherKeyCount:access.otherKeyCount,
  keyStatus:access.note,
  receiptCount:receipts.receiptCount,
  finalityVerified:receipts.finalityVerified,
  transactionVerified:receipts.valid,
  initializationVerified:receipts.initializationVerified,
  reasons
 };
}
module.exports={verifyAccessKeys,verifyFinalizedTransaction,verifyDeployment};
