'use strict';
const {createHash}=require('node:crypto');
const YOCTO=10n**24n;
const FACTORY_LIMIT=4_000_000;
const OWNER=/^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?\.testnet$/;
const PREFIX=/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const HASH=/^[0-9a-f]{64}$/;
const MAGIC=Buffer.from([0,97,115,109,1,0,0,0]);
function validateOwner(owner){
  if(typeof owner!=='string'||owner.length>60||!OWNER.test(owner)||owner.startsWith('.')||owner.includes('..'))throw Error('Enter a valid named owner account ending in .testnet.');
  return owner;
}
function factoryId(owner,prefix){
  validateOwner(owner);
  if(typeof prefix!=='string'||prefix.length<3||prefix.length>24||!PREFIX.test(prefix))throw Error('Prefix must be 3–24 lowercase letters, numbers, hyphens or underscores.');
  const id=prefix+'.'+owner;
  if(id.length>64)throw Error('Factory address exceeds 64 characters.');
  return id;
}
function nearAmount(s){
  if(typeof s!=='string'||!/^(0|[1-9]\d*)(?:\.\d{1,24})?$/.test(s))throw Error('Enter a valid NEAR amount (up to 24 decimals).');
  const [whole,part='']=s.split('.');
  return BigInt(whole)*YOCTO+BigInt((part+'0'.repeat(24)).slice(0,24));
}
function formatNear(n){const a=BigInt(n);return (a/YOCTO).toString()+((a%YOCTO)===0n?'':'.'+(a%YOCTO).toString().padStart(24,'0').replace(/0+$/,''));}
function validateWasm(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<8||bytes.length>FACTORY_LIMIT||!bytes.subarray(0,8).equals(MAGIC))throw Error('Not a valid Nearium factory WASM.');
  return bytes;
}
function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
function verifyManifest(manifest,wasm){
  if(!manifest||manifest.network!=='testnet'||manifest.version!=='0.1.0'||!/^[0-9a-f]{40}$/.test(manifest.sourceCommit||''))throw Error('Invalid testnet build manifest.');
  const f=manifest.factory;
  if(!f||f.file!=='factory.wasm'||!HASH.test(f.sha256||'')||!Number.isSafeInteger(f.bytes)||f.bytes<8||f.bytes>FACTORY_LIMIT)throw Error('Unexpected factory entry in the build manifest.');
  validateWasm(wasm);
  if(wasm.length!==f.bytes||sha256(wasm)!==f.sha256)throw Error('Downloaded factory WASM failed SHA-256 verification. Deployment blocked.');
  return {sourceCommit:manifest.sourceCommit,hash:f.sha256,bytes:f.bytes};
}
function preparePlan({owner,prefix,funding,wasmSize,storagePerByte}){
  const target=factoryId(owner,prefix);
  const amount=nearAmount(funding);
  if(amount<YOCTO||amount>100n*YOCTO)throw Error('Factory funding must be between 1 and 100 testnet NEAR.');
  if(!Number.isSafeInteger(wasmSize)||wasmSize<8||wasmSize>FACTORY_LIMIT)throw Error('Load a valid verified factory WASM.');
  const cost=BigInt(storagePerByte);
  if(cost<=0n)throw Error('Invalid testnet storage price.');
  const minimum=(BigInt(wasmSize)+2048n)*cost+YOCTO/2n;
  if(amount<minimum)throw Error('Insufficient factory funding; estimated minimum '+formatNear(minimum)+' testnet NEAR.');
  return {owner,target,amount,funding:formatNear(amount),minFunding:formatNear(minimum)};
}
function factoryActions(api,wasm,plan){
  validateWasm(wasm);
  return [
    api.createAccount(),
    api.transfer(plan.amount),
    api.deployContract(new Uint8Array(wasm)),
    api.functionCall('new',{owner:plan.owner},30n*10n**12n,0n)
  ];
}
module.exports={YOCTO,validateOwner,factoryId,nearAmount,formatNear,validateWasm,sha256,verifyManifest,preparePlan,factoryActions};
