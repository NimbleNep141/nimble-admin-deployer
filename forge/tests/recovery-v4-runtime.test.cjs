'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const {V4Journal}=require('../src/recovery-v4-journal.cjs');
const {signAndSubmitExact}=require('../src/recovery-v4-broadcast.cjs');
const a={network:'testnet',target:'child.owner.testnet',signer:'owner.testnet',
 publicKey:'ed25519:'+'3'.repeat(44),mode:'new',keyMode:'controlled',
 initMethod:'new',wasmSha256:'a'.repeat(64),expectedCodeHash:'4'.repeat(44),
 txHash:'2'.repeat(44),nonce:'15',blockHash:'5'.repeat(44)};
async function temp(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-v4-runtime-'));
 try{await fn(dir)}finally{await fs.rm(dir,{force:true,recursive:true})}}
async function spawnCheckpoint(dir,phase){
 const mod=path.resolve(__dirname,'../src/recovery-v4-journal.cjs');
 const code=[
 "'use strict';",
 "const {V4Journal}=require(process.argv[1]);",
 "(async()=>{const j=new V4Journal(process.argv[2]);const p=JSON.parse(process.argv[3]);",
 " const a=await j.start(p);",
 " if(process.argv[4]==='intent')await j.claimBroadcast(a);",
 " process.stdout.write('CHECKPOINT\\n');setInterval(()=>{},10000);",
 "})().catch(e=>{process.stderr.write(String(e));process.exitCode=7})"
 ].join('\n');
 const child=spawn(process.execPath,['-e',code,mod,dir,JSON.stringify(a),phase],
  {stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='',errors='',timer;
 child.stderr.on('data',d=>{errors+=d.toString()});
 try{
  await Promise.race([
   new Promise((resolve,reject)=>{
    child.stdout.on('data',d=>{output+=d.toString();if(output.includes('CHECKPOINT'))resolve()});
    child.once('error',reject);child.once('exit',x=>reject(Error('Unexpected exit '+x+' '+errors)));
   }),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Checkpoint timeout '+errors)),10000)})
  ]);
 }finally{
  clearTimeout(timer);child.kill('SIGKILL');
  await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();
   child.once('exit',()=>resolve());setTimeout(resolve,1200)});
 }
}
test('real near-api-js 7.4 signature is saved with exclusive intent before any send',async()=>{
 const {KeyPair,KeyPairSigner,Transaction,baseEncode}=await import('near-api-js');
 const key=KeyPair.fromRandom('ed25519'),signer=KeyPairSigner.fromSecretKey(key.toString());
 const pub=await signer.getPublicKey();
 const tx=new Transaction({signerId:'owner.testnet',receiverId:'child.owner.testnet',
  publicKey:pub,nonce:15n,blockHash:new Uint8Array(32).fill(8),actions:[]});
 const hash=baseEncode(createHash('sha256').update(tx.encode()).digest());
 await temp(async dir=>{
  const j=new V4Journal(dir);let seen=0;
  const account={getSigner:()=>signer,createTransaction:async()=>tx,
   provider:{sendTransactionUntil:async(encoded,wait)=>{
    seen++;assert.equal(wait,'FINAL');assert.equal(encoded.transaction.nonce,15n);
    const saved=await new V4Journal(dir).unresolved('testnet','child.owner.testnet');
    assert.equal(saved?.txHash,hash);assert.equal(saved?.phase,'broadcast-intent');
    return {transaction:{hash}};
   }}};
  const result=await signAndSubmitExact({account,journal:j,
   approved:{...a,publicKey:pub.toString()},actions:[],baseEncode});
  assert.equal(result.transaction.hash,hash);assert.equal(seen,1);
 });
});
test('child process SIGKILL after signed record but before intent is cancelable',async()=>{
 await temp(async dir=>{
  await spawnCheckpoint(dir,'prepared');
  const j=new V4Journal(dir),saved=await j.unresolved(a.network,a.target);
  assert.equal(saved?.phase,null);assert.equal(saved?.txHash,a.txHash);
  await j.cancelBeforeBroadcast(saved);await j.resolveBeforeBroadcast(saved);
  await j.assertClear(a.network,a.target);
 });
});
test('child process SIGKILL after intent always stays uncertain and un-cancelable',async()=>{
 await temp(async dir=>{
  await spawnCheckpoint(dir,'intent');
  const j=new V4Journal(dir),saved=await j.unresolved(a.network,a.target);
  assert.equal(saved?.phase,'broadcast-intent');
  await assert.rejects(()=>j.cancelBeforeBroadcast(saved),/phase|claimed|broadcast/i);
  await assert.rejects(()=>j.assertClear(a.network,a.target),/pending|recovery/i);
 });
});
test('an interrupted immutable resolution cannot be mistaken for verified success',async()=>{
 await temp(async dir=>{
  const j=new V4Journal(dir),saved=await j.start(a);await j.claimBroadcast(saved);
  const file=j.resolutionFile(saved);
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,'{interrupted');
  await assert.rejects(()=>j.assertClear(a.network,a.target),/invalid|corrupt|blocked/i);
 });
});
