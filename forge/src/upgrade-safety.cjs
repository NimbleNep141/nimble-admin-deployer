'use strict';
// Read-only Testnet rehearsal proofs and local, durable Mainnet rollback archives.
// This module NEVER sends a NEAR transaction or claims that automated checks prove state compatibility.
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {wasm,accountId,sha}=require('./core.cjs');
const {verifyFinalizedTransaction}=require('./deployment-verification.cjs');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const B58=/^[1-9A-HJ-NP-Za-km-z]{35,65}$/;
const FIELD=/^[a-zA-Z_][a-zA-Z0-9_]{0,80}$/;
function requiredText(value,name,min=30,max=2500){
 if(typeof value!=='string'||value.trim().length<min||value.length>max)
  throw Error(name+' must explain the verification in '+min+'–'+max+' characters.');
 return value.trim();
}
function parseObject(json,name){
 if(typeof json!=='string'||json.length>8000)throw Error(name+' must be a JSON object under 8 KB.');
 let obj;try{obj=JSON.parse(json);}catch{throw Error(name+' must contain valid JSON.');}
 if(!obj||typeof obj!=='object'||Array.isArray(obj))throw Error(name+' must contain a JSON object.');
 return obj;
}
function stable(value){
 if(Array.isArray(value))return value.map(stable);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
 return value;
}
function canonical(value){return JSON.stringify(stable(value));}
function actionType(action){
 if(typeof action==='string')return action;
 if(!action||typeof action!=='object')return null;
 const keys=Object.keys(action);return keys.length===1?keys[0]:null;
}
function decodeActionCode(action){
 if(typeof action?.DeployContract?.code!=='string'||action.DeployContract.code.length>6_000_000)
  throw Error('Proof transaction does not expose a valid DeployContract.code payload.');
 const encoded=action.DeployContract.code;
 if(!/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded)||encoded.length%4!==0)
  throw Error('Proof DeployContract code is not canonical Base64.');
 const bytes=Buffer.from(encoded,'base64');
 if(bytes.toString('base64')!==encoded)throw Error('Proof DeployContract code cannot be decoded canonically.');
 return wasm(bytes);
}
function verifyProofTx(tx,{hash,account,initMethod='',initArgs='{}',expectedSha,baseline=false,baseEncode}){
 if(!tx||typeof tx!=='object'||tx.transaction?.hash!==hash||tx.transaction?.receiver_id!==account)
  throw Error('Testnet proof transaction is missing or has the wrong hash/receiver.');
 const signed=tx.transaction;
 if(!accountId(signed.signer_id,'testnet')||typeof signed.public_key!=='string')
  throw Error('Testnet proof signer identity is invalid.');
 const actions=Array.isArray(signed.actions)?signed.actions:[];
 const deploy=actions.filter(a=>actionType(a)==='DeployContract');
 if(deploy.length!==1)throw Error('Testnet proof must contain exactly one contract deployment action.');
 const actualCode=decodeActionCode(deploy[0]);
 if(sha(actualCode)!==expectedSha)throw Error('Testnet proof deployed different WASM bytes from the required version.');
 if(!baseline){
  const receiptReview=verifyFinalizedTransaction(tx,{
   txHash:hash,signer:signed.signer_id,target:account,publicKey:signed.public_key,
   mode:'existing',keyMode:'controlled',initMethod
  });
  if(!receiptReview.valid)throw Error('Testnet migration receipts failed: '+receiptReview.issues.join(' '));
  if(initMethod){
   const method=actions.at(-1)?.FunctionCall;
   if(method?.method_name!==initMethod)throw Error('Testnet migration used a different initializer/migration method.');
   const expected=Buffer.from(JSON.stringify(parseObject(initArgs,'Migration arguments'))).toString('base64');
   if(method.args!==expected)throw Error('Testnet migration arguments differ from the proposed Mainnet migration.');
  }
 }else{
  if(tx.final_execution_status!=='FINAL'||!Object.prototype.hasOwnProperty.call(tx.status||{},'SuccessValue'))
   throw Error('Testnet baseline deployment is not finalized and successful.');
  const root=tx.transaction_outcome?.outcome;
  if(!root||!('SuccessValue'in(root.status||{})||'SuccessReceiptId'in(root.status||{})))
   throw Error('Testnet baseline execution was not successful.');
  if(!Array.isArray(tx.receipts_outcome)||!tx.receipts_outcome.length||tx.receipts_outcome.some(x=>!x?.outcome||!('SuccessValue'in(x.outcome.status||{})||'SuccessReceiptId'in(x.outcome.status||{}))))
   throw Error('Testnet baseline receipt outcomes are missing or failed.');
  const receiptIds=new Set(tx.receipts_outcome.map(x=>x.id));
  const pending=[...(root.receipt_ids||[]),...tx.receipts_outcome.flatMap(x=>x.outcome?.receipt_ids||[])];
  if(!pending.length||pending.some(id=>!receiptIds.has(id)))throw Error('Testnet baseline receipt graph is incomplete.');
 }
 return {hash,account,signer:signed.signer_id,sha256:expectedSha,blockHash:tx.transaction_outcome?.block_hash||null,receiptCount:tx.receipts_outcome?.length||0,chainCodeHash:baseEncode(createHash('sha256').update(actualCode).digest())};
}
function validateEvidence(data,{target,oldCodeHash,newSha,initMethod,initArgs}){
 if(!data||typeof data!=='object')throw Error('Complete the dedicated Mainnet compatibility report.');
 const testnetAccount=accountId(data.testnetAccount,'testnet');
 const baselineTx=data.baselineTx,upgradeTx=data.upgradeTx;
 if(!B58.test(baselineTx||'')||!B58.test(upgradeTx||'')||baselineTx===upgradeTx)
  throw Error('Provide separate valid Testnet baseline and upgrade transaction hashes.');
 const viewMethod=data.viewMethod;
 if(typeof viewMethod!=='string'||!FIELD.test(viewMethod))throw Error('Provide a safe Testnet read-only view method.');
 const viewArgs=parseObject(data.viewArgs||'{}','Testnet view arguments');
 let expectedView;
 try{expectedView=JSON.parse(data.expectedView);}catch{throw Error('Expected Testnet view response must be valid JSON.');}
 if(expectedView===undefined)throw Error('Expected Testnet view response is required.');
 if(typeof data.expectedView!=='string'||data.expectedView.length>8000)throw Error('Testnet expected view is too long.');
 const report={
  stateSchema:requiredText(data.stateSchema,'Persistent state/schema review'),
  migrationPlan:requiredText(data.migrationPlan,'Migration plan'),
  rollbackPlan:requiredText(data.rollbackPlan,'Rollback/recovery plan'),
  testCoverage:requiredText(data.testCoverage,'Testnet state and invariants exercised'),
 };
 if(data.approvedOldHash!==oldCodeHash||data.approvedNewSha!==newSha)
  throw Error('Report hash fields must exactly match current Mainnet old code and selected new WASM.');
 if(data.approvedTarget!==target)throw Error('Compatibility report is for a different Mainnet contract.');
 if(data.ackCompatible!==true||data.ackRollback!==true||data.ackNotGuaranteed!==true)
  throw Error('Acknowledge state compatibility, archive retention, and remaining Mainnet risk.');
 return {testnetAccount,baselineTx,upgradeTx,viewMethod,viewArgs,expectedView,report,
  mainnetTarget:target,oldCodeHash,newSha,initMethod,initArgs};
}
async function verifyTestnetRehearsal(evidence,{rpc,baseEncode}){
 const testnetStatus=await rpc('status',[],'testnet');
 if(testnetStatus?.chain_id!=='testnet')throw Error('Testnet proof RPC is not on NEAR Testnet.');
 const [baseTx,upgradeTx,viewResult,testCode]=await Promise.all([
  rpc('tx',{tx_hash:evidence.baselineTx,sender_account_id:evidence.testnetAccount,wait_until:'FINAL'},'testnet'),
  rpc('tx',{tx_hash:evidence.upgradeTx,sender_account_id:evidence.testnetAccount,wait_until:'FINAL'},'testnet'),
  rpc('query',{request_type:'call_function',finality:'final',account_id:evidence.testnetAccount,
   method_name:evidence.viewMethod,args_base64:Buffer.from(JSON.stringify(evidence.viewArgs)).toString('base64')},'testnet'),
  rpc('query',{request_type:'view_code',finality:'final',account_id:evidence.testnetAccount},'testnet')
 ]);
 // Sender may be an authorized separate account, but both proof transaction receivers
 // MUST be the SAME Testnet contract. Never trust a user-supplied receipt status.
 const oldProof=verifyProofTx(baseTx,{hash:evidence.baselineTx,account:evidence.testnetAccount,
  expectedSha:evidence.oldSha,baseline:true,baseEncode});
 const newProof=verifyProofTx(upgradeTx,{hash:evidence.upgradeTx,account:evidence.testnetAccount,
  expectedSha:evidence.newSha,initMethod:evidence.initMethod,initArgs:evidence.initArgs,baseEncode});
 if(oldProof.chainCodeHash!==evidence.oldCodeHash)throw Error('Testnet baseline contract code differs from the Mainnet old contract.');
 const testBytes=decodeCodeResponse(testCode,baseEncode);
 if(sha(testBytes)!==evidence.newSha||testCode.hash!==newProof.chainCodeHash)
  throw Error('Current Testnet contract does not have the new WASM deployed.');
 const [oldBlock,newBlock]=await Promise.all([
  rpc('block',{block_id:oldProof.blockHash},'testnet'),
  rpc('block',{block_id:newProof.blockHash},'testnet')
 ]);
 const oldHeight=Number(oldBlock?.header?.height),newHeight=Number(newBlock?.header?.height);
 if(!Number.isSafeInteger(oldHeight)||!Number.isSafeInteger(newHeight)||oldHeight>=newHeight)
  throw Error('Baseline Testnet deployment must precede the migration upgrade.');
 let actual;
 try{actual=JSON.parse(Buffer.from(viewResult?.result||[]).toString('utf8'));}
 catch{throw Error('Testnet post-upgrade view did not return valid JSON.');}
 if(canonical(actual)!==canonical(evidence.expectedView))throw Error('Post-upgrade Testnet view method returned unexpected state.');
 return {testnetAccount:evidence.testnetAccount,baselineTx:evidence.baselineTx,
  upgradeTx:evidence.upgradeTx,oldHeight,newHeight,oldCodeHash:evidence.oldCodeHash,
  newSha:evidence.newSha,viewMethod:evidence.viewMethod,viewArgs:evidence.viewArgs,
  expectedView:evidence.expectedView,actualView:actual,verifiedAt:new Date().toISOString(),
  note:'Receipt and view evidence verified; cannot prove complete equivalence of all Mainnet storage.'};
}
function decodeCodeResponse(response,baseEncode){
 if(!response||typeof response.code_base64!=='string'||response.code_base64.length>6_000_000)
  throw Error('On-chain contract code was not returned in full.');
 const raw=response.code_base64;
 if(!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)||raw.length%4!==0)throw Error('Malformed on-chain code Base64.');
 const bytes=Buffer.from(raw,'base64');
 if(bytes.toString('base64')!==raw)throw Error('On-chain WASM Base64 is not canonical.');
 wasm(bytes);
 if(baseEncode(createHash('sha256').update(bytes).digest())!==response.hash)
  throw Error('On-chain WASM bytes do not match the account code hash.');
 return bytes;
}
async function retainRollback(userData,{target,oldCodeHash,oldWasm,report}){
 const binary=wasm(oldWasm);
 const parent=path.join(userData,'upgrade-backups');
 await fs.mkdir(parent,{recursive:true,mode:0o700});
 const folder=path.join(parent,Date.now()+'-'+randomUUID());
 await fs.mkdir(folder,{mode:0o700});
 const file=path.join(folder,'previous-contract.wasm');
 const metadata=path.join(folder,'compatibility-report.json');
 const record={schemaVersion:1,network:'mainnet',target,oldCodeHash,oldSha256:sha(binary),
  newSha256:report.newSha,createdAt:new Date().toISOString(),report};
 try{
  await fs.writeFile(file,binary,{flag:'wx',mode:0o600});
  await fs.writeFile(metadata,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
  const verification=await fs.readFile(file);
  if(sha(verification)!==record.oldSha256)throw Error('Old contract WASM archive checksum verification failed.');
  const reportText=await fs.readFile(metadata);
  return {folder,file,metadata,oldSha256:record.oldSha256,reportSha256:digest(reportText),record};
 }catch(e){await fs.rm(folder,{recursive:true,force:true}).catch(()=>{});throw e;}
}
async function verifyArchive(archive){
 if(!archive||typeof archive.file!=='string'||typeof archive.metadata!=='string')throw Error('No retained rollback archive exists.');
 const [bytes,text]=await Promise.all([fs.readFile(archive.file),fs.readFile(archive.metadata)]);
 if(sha(wasm(bytes))!==archive.oldSha256||digest(text)!==archive.reportSha256)
  throw Error('Rollback archive changed or is damaged. Mainnet upgrade blocked.');
 const record=JSON.parse(text.toString('utf8'));
 if(record.network!=='mainnet'||record.oldSha256!==archive.oldSha256||record.oldCodeHash!==archive.record?.oldCodeHash)
  throw Error('Rollback archive metadata is inconsistent.');
 return {oldSha256:record.oldSha256,reportSha256:archive.reportSha256,folder:archive.folder};
}
module.exports={validateEvidence,verifyProofTx,verifyTestnetRehearsal,decodeCodeResponse,retainRollback,verifyArchive,canonical};
