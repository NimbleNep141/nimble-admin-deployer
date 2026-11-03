'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createHash}=require('node:crypto');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const HASH='2'.repeat(44),BLOCK='5'.repeat(44),PUB='ed25519:'+'3'.repeat(44);
const record={network:'testnet',target:'widget.owner.testnet',signer:'owner.testnet',
 publicKey:PUB,mode:'new',keyMode:'controlled',initMethod:'new',
 wasmSha256:'a'.repeat(64),expectedCodeHash:'4'.repeat(44),
 txHash:HASH,nonce:'15',blockHash:BLOCK};
const moduleJournal=path.resolve(__dirname,'../src/recovery-v3-journal.cjs');
const moduleBroadcast=path.resolve(__dirname,'../src/recovery-v3-broadcast.cjs');
const script=[
 "'use strict';",
 "const {RecoveryJournalV3}=require(process.argv[1]);",
 "const {signPersistSend}=require(process.argv[2]);",
 "const {createHash}=require('node:crypto');",
 "(async()=>{const journal=new RecoveryJournalV3(process.argv[3]);const info=JSON.parse(process.argv[4]);",
 " if(process.argv[5]==='guard'){await journal.start(info);process.stdout.write('PERSISTED\\n');}",
 " else {",
 " const bytes=Buffer.from('signed-fixture');",
 " const hash=createHash('sha256').update(bytes).digest();",
 " const unsigned={signerId:info.signer,receiverId:info.target,",
 " publicKey:{toString:()=>info.publicKey},nonce:15n,blockHash:new Uint8Array(32).fill(2),encode:()=>bytes};",
 " const account={createTransaction:async()=>unsigned,",
 " getSigner:()=>({signTransaction:async()=>({txHash:new Uint8Array(hash),signedTransaction:{transaction:unsigned}})}),",
 " provider:{sendTransactionUntil:async()=>{process.stdout.write('BROADCAST_CALLED\\n');return new Promise(()=>{});}}};",
 " await signPersistSend({account,journal,approved:info,actions:[],",
 " baseEncode:v=>Buffer.from(v).equals(hash)?info.txHash:info.blockHash});",
 " }setInterval(()=>{},10000);",
 "})().catch(e=>{console.error(e);process.exitCode=9})"
].join('\n');
async function killAtCheckpoint(root,mode,checkpoint){
 const child=spawn(process.execPath,['-e',script,moduleJournal,moduleBroadcast,root,JSON.stringify(record),mode],
  {stdio:['ignore','pipe','pipe'],windowsHide:true});
 let error='',stdout='',timer;
 child.stderr.on('data',x=>error+=x.toString());
 try{
  await Promise.race([new Promise((resolve,reject)=>{
   child.stdout.on('data',x=>{stdout+=x.toString();if(stdout.includes(checkpoint))resolve()});
   child.once('error',reject);
   child.once('exit',code=>reject(Error('Child exited before checkpoint '+code+': '+error)));
  }),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out before checkpoint: '+error)),10000)})]);
 }finally{
  clearTimeout(timer);child.kill('SIGKILL');
  if(child.exitCode===null&&child.signalCode===null)
   await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,1500))]);
 }
}
async function temporary(fn){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-v3-kill-'));
 try{await fn(root)}finally{await fs.rm(root,{recursive:true,force:true})}
}
test('actual Windows child termination keeps pre-broadcast signed hash and nonce intact',async()=>{
 await temporary(async root=>{
  await killAtCheckpoint(root,'guard','PERSISTED');
  const {RecoveryJournalV3}=require('../src/recovery-v3-journal.cjs');
  const j=new RecoveryJournalV3(root),saved=await j.get(record.network,record.target);
  assert.equal(saved?.txHash,HASH);assert.equal(saved?.nonce,'15');
  await assert.rejects(()=>j.assertClear(record.network,record.target),/recovery|pending/i);
 });
});
test('kill while provider broadcast is awaiting an RPC response still retains exact transaction identity',async()=>{
 await temporary(async root=>{
  await killAtCheckpoint(root,'broadcast','BROADCAST_CALLED');
  const {RecoveryJournalV3}=require('../src/recovery-v3-journal.cjs');
  const saved=await new RecoveryJournalV3(root).get(record.network,record.target);
  assert.equal(saved?.txHash,HASH);assert.equal(saved?.blockHash,BLOCK);
 });
});
