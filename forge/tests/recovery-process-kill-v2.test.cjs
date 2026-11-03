'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {RecoveryJournal}=require('../src/recovery-journal.cjs');

const target='child.owner.testnet',txHash='2'.repeat(44);
const info={network:'testnet',target,signer:'owner.testnet',
 publicKey:'ed25519:'+'3'.repeat(44),mode:'new',keyMode:'controlled',
 initMethod:'new',wasmSha256:'a'.repeat(64),expectedCodeHash:'4'.repeat(44)};
const modulePath=path.resolve(__dirname,'../src/recovery-journal.cjs');
const script=[
 "const {RecoveryJournal}=require(process.argv[1]);",
 "(async()=>{",
 " const j=new RecoveryJournal(process.argv[2]);const p=JSON.parse(process.argv[3]);",
 " await j.start(p);",
 " if(process.argv[4]==='hash')await j.rememberHash(p.network,p.target,'2'.repeat(44));",
 " process.stdout.write('GUARD_READY\\n');",
 " setInterval(()=>{},10000);",
 "})().catch(e=>{console.error(e);process.exitCode=5;});"
].join('\n');
async function killedProcess(dir,phase){
 const child=spawn(process.execPath,['-e',script,modulePath,dir,JSON.stringify(info),phase],
  {stdio:['ignore','pipe','pipe'],windowsHide:true});
 let stderr='';
 child.stderr.on('data',chunk=>{stderr+=chunk.toString()});
 let timer;
 try{
  await Promise.race([
   new Promise((resolve,reject)=>{
    let text='';
    child.stdout.on('data',chunk=>{text+=chunk.toString();if(text.includes('GUARD_READY'))resolve();});
    child.once('error',reject);
    child.once('exit',code=>reject(Error('Child exited before guard: '+code+' '+stderr)));
   }),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Child guard creation timed out: '+stderr)),10000);})
  ]);
 }finally{
  clearTimeout(timer);
  child.kill('SIGKILL');
  if(child.exitCode===null)await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,1000))]);
 }
}
async function temp(fn){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-kill-test-'));
 try{await fn(dir)}finally{await fs.rm(dir,{recursive:true,force:true})}
}
test('Windows real child-process kill after guard creation survives restart',async()=>{
 await temp(async dir=>{
  await killedProcess(dir,'before-hash');
  const j=new RecoveryJournal(dir),record=await j.get('testnet',target);
  assert.equal(record?.state,'uncertain');assert.equal(record.txHash,null);
  await assert.rejects(()=>j.assertClear('testnet',target),/recover|blocked/i);
 });
});
test('Windows child-process kill after saving tx hash still preserves transaction evidence',async()=>{
 await temp(async dir=>{
  await killedProcess(dir,'hash');
  const j=new RecoveryJournal(dir),record=await j.get('testnet',target);
  assert.equal(record?.state,'submitted');assert.equal(record?.txHash,txHash);
  await assert.rejects(()=>j.start(info),/recover|pending|exists|blocked/i);
 });
});
