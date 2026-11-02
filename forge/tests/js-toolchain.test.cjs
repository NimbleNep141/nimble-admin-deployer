'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const node=require('../src/js-toolchain.cjs');
test('managed Windows Node release and official download paths are pinned',()=>{
 assert.equal(node.VERSION,'v22.21.0');
 assert.match(node.BASE,/^https:\/\/nodejs\.org\/dist\/v22\.21\.0\/$/);
 assert.equal(node.manifestDigest('a'.repeat(64)+'  node-v22.21.0-win-x64.zip\n'),'a'.repeat(64));
 assert.throws(()=>node.manifestDigest('a'.repeat(64)+'  node-v22.22.0-win-x64.zip'),/missing/);
});
test('project build script parsing recognizes build and build:contract only',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'forge-js-test-'));
 try{
  await fs.writeFile(path.join(temp,'package.json'),JSON.stringify({
   name:'sample',scripts:{build:'near-sdk-js build src/contract.ts output/contract.wasm',
    'build:contract':'npm run build',test:'echo no'},
   dependencies:{'near-sdk-js':'2.0.0'}}));
  const info=await node.projectInfo({kind:'javascript',root:temp});
  assert.equal(info.scripts.length,2);
  assert.equal(info.legacySdk,true);
  assert.equal(info.hasLock,false);
  const out=path.join(temp,'build');await fs.mkdir(out);
  await fs.writeFile(path.join(out,'contract.wasm'),Buffer.alloc(100));
  const candidates=await node.wasmFiles({kind:'javascript',root:temp});
  assert.equal(candidates.length,1);
  assert.equal(path.basename(candidates[0].file),'contract.wasm');
  await assert.rejects(()=>node.projectInfo({kind:'rust',root:temp}),/JavaScript/);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
test('Node child-process environment removes known sensitive credentials',()=>{
 const vars=['NEAR_PRIVATE_KEY','NEAR_SECRET_KEY','NEAR_SEED_PHRASE'];
 const previous=vars.map(x=>process.env[x]);vars.forEach(x=>process.env[x]='secret');
 try{
  const env=node.environment('/sample/user');
  for(const x of vars)assert.equal(env[x],undefined);
  assert.equal(env.npm_config_ignore_scripts,'true');
 }finally{vars.forEach((x,i)=>previous[i]===undefined?delete process.env[x]:process.env[x]=previous[i]);}
});
test('managed runtime status requires Windows x64 and refuses other architectures',async()=>{
 if(process.platform==='win32'&&process.arch==='x64')return;
 await assert.rejects(()=>node.status('/fake'),/Windows x64/);
 await assert.rejects(()=>node.install('/fake'),/Windows x64/);
});
test('Forge exposes JS/TS build actions and local project editing without eval',async()=>{
 const main=await fs.readFile(path.join(__dirname,'../src/main.cjs'),'utf8');
 const preload=await fs.readFile(path.join(__dirname,'../src/preload.cjs'),'utf8');
 const html=await fs.readFile(path.join(__dirname,'../src/index.html'),'utf8');
 for(const name of ['project-open','source-open','source-save','node-status','node-setup','js-install','js-build'])
  assert.ok(main.includes("'"+name+"'"),name);
 for(const id of ['source-code','source-project','source-save','source-file','node-check','node-install','js-dependencies','js-compile','js-log'])
  assert.ok(html.includes('id="'+id+'"'),id);
 assert.match(main,/if\(signer\)throw Error\('Disconnect the local signer before compiling a JavaScript/);
 assert.match(main,/sourceEditor\.saveSource/);
 assert.match(preload,/sourceOpen:file=>invoke\('source-open',file\)/);
 assert.doesNotMatch(preload,/eval\(|spawn\(/);
});
