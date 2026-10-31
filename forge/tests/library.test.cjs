'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,rm,readFile,writeFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');const path=require('node:path');
const {Library}=require('../src/library.cjs');
const binary=Buffer.from([0,97,115,109,1,0,0,0,1,2,3,4]);
test('save/load/delete local contract without storing secrets',async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'near-forge-test-'));
 try{
  const library=new Library(temp);
  const item=await library.save({name:'My NFT',preset:{prefix:'nft',initArgs:'{}'},wasmBytes:binary});
  const list=await library.list();assert.equal(list.length,1);assert.equal(list[0].name,'My NFT');
  const loaded=await library.load(item.id);assert.deepEqual(loaded.bytes,binary);
  assert.equal(loaded.entry.sha256,item.sha256);
  const disk=await readFile(path.join(temp,'forge-library','contracts.json'),'utf8');
  assert.doesNotMatch(disk,/private_key|secret_key|recoveryPhrase/);
  await library.delete(item.id);assert.equal((await library.list()).length,0);
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('reject corrupted saved contract bytes',async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'near-forge-test-'));
 try{
  const library=new Library(temp);
  const item=await library.save({name:'Good',preset:{},wasmBytes:binary});
  await writeFile(path.join(temp,'forge-library','wasm',item.sha256+'.wasm'),Buffer.from([0,97,115,109,1,0,0,0,9,8,7]));
  await assert.rejects(()=>library.load(item.id),/checksum mismatch/);
 }finally{await rm(temp,{recursive:true,force:true});}
});
