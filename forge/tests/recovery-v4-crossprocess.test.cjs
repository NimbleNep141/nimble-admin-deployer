'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {V4Journal}=require('../src/recovery-v4-journal.cjs');
const approval={network:'testnet',target:'child.owner.testnet',signer:'owner.testnet',
 publicKey:'ed25519:'+'3'.repeat(44),mode:'new',keyMode:'controlled',
 initMethod:'new',wasmSha256:'a'.repeat(64),expectedCodeHash:'4'.repeat(44),
 txHash:'2'.repeat(44),nonce:'15',blockHash:'5'.repeat(44)};
const modulePath=path.resolve(__dirname,'../src/recovery-v4-journal.cjs');
const script=[
 "'use strict';",
 "const {V4Journal}=require(process.argv[1]);",
 "(async()=>{const j=new V4Journal(process.argv[2]);const a=JSON.parse(process.argv[3]);",
 "const operation=process.argv[4];",
 "if(operation==='start')await j.start(a);",
 "else {const saved=await j.unresolved(a.network,a.target);",
 "if(operation==='intent')await j.claimBroadcast(saved);",
 "else if(operation==='cancel')await j.cancelBeforeBroadcast(saved);",
 "else throw Error('Invalid operation')}",
 "process.stdout.write('WON');",
 "})().catch(e=>{process.stdout.write('BLOCKED:'+e.message)});"
].join('\n');
async function child(root,operation){
 return new Promise((resolve,reject)=>{
  const proc=spawn(process.execPath,['-e',script,modulePath,root,JSON.stringify(approval),operation],
   {stdio:['ignore','pipe','pipe'],windowsHide:true});
  let out='',err='';
  proc.stdout.on('data',d=>out+=d.toString());proc.stderr.on('data',d=>err+=d.toString());
  proc.once('error',reject);
  proc.once('exit',code=>{if(code!==0)reject(Error('Child exit '+code+' '+err));else resolve(out)});
 });
}
async function temp(fn){const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-v4-crossprocess-'));
 try{await fn(root)}finally{await fs.rm(root,{recursive:true,force:true})}}
test('two actual Windows Node processes racing to begin cannot create two attempts',async()=>{
 await temp(async root=>{
  const results=await Promise.all([child(root,'start'),child(root,'start')]);
  assert.equal(results.filter(x=>x==='WON').length,1,JSON.stringify(results));
  assert.equal(results.filter(x=>x.startsWith('BLOCKED:')).length,1,JSON.stringify(results));
  const rows=await new V4Journal(root).listTarget(approval.network,approval.target);
  assert.equal(rows.length,1);
 });
});
test('broadcast versus cancel in two actual processes yields exactly one exclusive phase',async()=>{
 await temp(async root=>{
  const j=new V4Journal(root);await j.start(approval);
  const result=await Promise.all([child(root,'intent'),child(root,'cancel')]);
  assert.equal(result.filter(x=>x==='WON').length,1,JSON.stringify(result));
  assert.equal(result.filter(x=>x.startsWith('BLOCKED:')).length,1,JSON.stringify(result));
  const pending=await j.unresolved(approval.network,approval.target);
  assert.ok(['broadcast-intent','cancelled-prebroadcast'].includes(pending.phase));
  if(pending.phase==='broadcast-intent')await assert.rejects(()=>j.resolveBeforeBroadcast(pending),/cannot|broadcast/i);
  else await assert.rejects(()=>j.claimBroadcast(pending),/phase|claimed|cancel/i);
 });
});
