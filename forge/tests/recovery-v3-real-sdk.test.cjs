'use strict';
// Uses the actual near-api-js 7.4 signer + Transaction implementation.
// No external RPC, network broadcast, wallet key or Mainnet assets.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {RecoveryJournalV3}=require('../src/recovery-v3-journal.cjs');
const {signPersistSend}=require('../src/recovery-v3-broadcast.cjs');
test('near-api-js 7.x actual signature hash is saved BEFORE provider sees signed bytes',async()=>{
 const {KeyPair,KeyPairSigner,Transaction,baseEncode}=await import('near-api-js');
 assert.equal(typeof Transaction,'function','near-api-js Transaction API must be available');
 const key=KeyPair.fromRandom('ed25519'),signer=KeyPairSigner.fromSecretKey(key.toString());
 const publicKey=await signer.getPublicKey();
 const unsigned=new Transaction({
  signerId:'owner.testnet',receiverId:'contract.owner.testnet',nonce:15n,
  publicKey,blockHash:new Uint8Array(32).fill(3),actions:[]
 });
 const expectedHash=baseEncode(createHash('sha256').update(unsigned.encode()).digest());
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-v3-sdk-'));
 try{
  const journal=new RecoveryJournalV3(root);let submitted=0;
  const account={getSigner:()=>signer,createTransaction:async()=>unsigned,
   provider:{sendTransactionUntil:async(signed,waitUntil)=>{
    submitted++;
    assert.equal(waitUntil,'FINAL');assert.equal(signed.transaction.nonce,15n);
    const saved=await new RecoveryJournalV3(root).get('testnet','contract.owner.testnet');
    assert.equal(saved?.txHash,expectedHash);
    assert.equal(saved?.publicKey,publicKey.toString());
    return {transaction:{hash:expectedHash}};
   }}};
  const result=await signPersistSend({account,journal,approved:{
   network:'testnet',target:'contract.owner.testnet',signer:'owner.testnet',
   publicKey:publicKey.toString(),mode:'new',keyMode:'controlled',initMethod:'',
   wasmSha256:'a'.repeat(64),expectedCodeHash:'4'.repeat(44)
  },actions:[],baseEncode});
  assert.equal(submitted,1);assert.equal(result.transaction.hash,expectedHash);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
