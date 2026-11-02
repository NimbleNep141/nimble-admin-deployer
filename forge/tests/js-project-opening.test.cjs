'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const sourceEditor=require('../src/source-editor.cjs');
const jsToolchain=require('../src/js-toolchain.cjs');

test('opening a real TypeScript project finds files and metadata without running build scripts',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'forge-js-open-'));
 try{
  await fs.mkdir(path.join(temp,'src'));
  await fs.writeFile(path.join(temp,'src','contract.ts'),'export const message = "hello";\n');
  await fs.writeFile(path.join(temp,'package-lock.json'),'{"name":"contract-fixture","lockfileVersion":3}\n');
  await fs.writeFile(path.join(temp,'package.json'),JSON.stringify({
   name:'sample-near-ts-contract',
   scripts:{
    'build:contract':'node -e "require(\'fs\').writeFileSync(\'UNSAFE_SCRIPT_RAN\',\'yes\')"',
    build:'echo build'
   },
   dependencies:{'near-sdk-js':'2.0.0'}
  }));
  // Exercise exactly the source-discovery and metadata-reader functions called by
  // the application's chooseProject handler. Neither should run any npm commands.
  const project=await sourceEditor.openProject(temp);
  const config=project.kind==='javascript'?await jsToolchain.projectInfo(project):null;
  assert.equal(project.kind,'javascript');
  assert.ok(project.files.includes('src/contract.ts'));
  assert.equal(config.name,'sample-near-ts-contract');
  assert.deepEqual(config.scripts.map(x=>x.name),['build:contract','build']);
  assert.equal(config.hasLock,true);
  assert.equal(config.legacySdk,true);
  await assert.rejects(()=>fs.stat(path.join(temp,'UNSAFE_SCRIPT_RAN')),{code:'ENOENT'});
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('the JS project opening handler has its metadata import and never exposes native compilation',async()=>{
 const main=await fs.readFile(path.join(__dirname,'../src/main.cjs'),'utf8');
 const preload=await fs.readFile(path.join(__dirname,'../src/preload.cjs'),'utf8');
 const renderer=await fs.readFile(path.join(__dirname,'../src/renderer.js'),'utf8');
 assert.match(main,/const jsToolchain=require\('\.\/js-toolchain\.cjs'\);/);
 assert.match(main,/const config=project\.kind==='javascript'\?await jsToolchain\.projectInfo\(project\):null;/);
 assert.match(main,/bind\('project-open',chooseProject\)/);
 assert.match(main,/bind\('isolated-build',isolatedBuild\)/);
 assert.match(preload,/projectOpen:\(\)=>invoke\('project-open'\)/);
 assert.match(renderer,/wire\('js-compile',async\(\)=>/);
 for(const name of ['compile-rust','compiler-setup','node-setup','js-install','js-build']){
  assert.doesNotMatch(main,new RegExp("bind\\('"+name+"'"));
  assert.doesNotMatch(preload,new RegExp("invoke\\('"+name+"'"));
 }
});
