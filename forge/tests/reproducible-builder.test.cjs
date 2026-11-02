'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const reproducible=require('../src/reproducible-builder.cjs');

function git(cwd,...args){
 const r=spawnSync('git',args,{cwd,encoding:'utf8'});
 if(r.status!==0)throw Error('git '+args.join(' ')+' failed: '+r.stderr);
 return r.stdout.trim();
}
async function fixture(run){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-repro-git-'));
 try{
  git(root,'init','-q');
  git(root,'config','user.email','near-forge-test@example.invalid');
  git(root,'config','user.name','Forge CI');
  await fs.writeFile(path.join(root,'Cargo.toml'),'[package]\nname="repro-test"\nversion="0.1.0"\n');
  await fs.writeFile(path.join(root,'Cargo.lock'),'# pinned lockfile\n');
  await fs.mkdir(path.join(root,'src'));
  await fs.writeFile(path.join(root,'src','lib.rs'),'pub fn hello() {}\n');
  git(root,'add','Cargo.toml','Cargo.lock','src/lib.rs');
  git(root,'commit','-qm','create production test fixture');
  await run(root);
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
test('NEAR production mode accepts committed Rust and a tracked lockfile',async()=>{
 await fixture(async(root)=>{
  const gitInfo=await reproducible.gitSnapshot({kind:'rust',root});
  assert.match(gitInfo.commit,/^[0-9a-f]{40}$/);
  assert.equal(gitInfo.repoRoot,path.resolve(root));
  assert.equal(path.basename(gitInfo.manifest),'Cargo.toml');
 });
});
test('NEAR production mode rejects dirty and untracked sources rather than silently building stale Git commits',async()=>{
 await fixture(async(root)=>{
  await fs.appendFile(path.join(root,'src','lib.rs'),'pub fn changed(){}\n');
  await assert.rejects(()=>reproducible.gitSnapshot({kind:'rust',root}),/commit or discard ALL/);
  git(root,'checkout','--','src/lib.rs');
  await fs.writeFile(path.join(root,'src','untracked.rs'),'pub fn hidden() {}\n');
  await assert.rejects(()=>reproducible.gitSnapshot({kind:'rust',root}),/untracked files/);
 });
});
test('NEAR production mode requires Cargo.lock tracked in Git',async()=>{
 await fixture(async(root)=>{
  git(root,'rm','--cached','Cargo.lock');
  git(root,'commit','-qm','untrack lockfile');
  await assert.rejects(()=>reproducible.gitSnapshot({kind:'rust',root}),/Cargo.lock must be committed/);
 });
});
test('official reproducible path uses cargo-near orchestrator, never native host source compilation',async()=>{
 const builder=await fs.readFile(path.join(__dirname,'../src/reproducible-builder.cjs'),'utf8');
 const isolated=await fs.readFile(path.join(__dirname,'../src/isolated-builder.cjs'),'utf8');
 const main=await fs.readFile(path.join(__dirname,'../src/main.cjs'),'utf8');
 const preload=await fs.readFile(path.join(__dirname,'../src/preload.cjs'),'utf8');
 const renderer=await fs.readFile(path.join(__dirname,'../src/renderer.js'),'utf8');
 const ui=await fs.readFile(path.join(__dirname,'../src/index.html'),'utf8');
 assert.match(builder,/\['near','build','reproducible-wasm'/);
 assert.match(builder,/--manifest-path/);
 assert.match(builder,/--out-dir/);
 assert.match(builder,/compilerManager\.paths\(userData\)\.near/);
 assert.doesNotMatch(builder,/spawn\(|'non-reproducible-wasm'/);
 assert.match(isolated,/officialReproducible\.build\(/);
 assert.match(isolated,/command:\['cargo','near','build','non-reproducible-wasm','--locked','--no-abi'\]/);
 assert.match(main,/bind\('reproducible-setup',setupReproducible\)/);
 assert.match(main,/bind\('reproducible-status',reproducibleStatus\)/);
 assert.match(preload,/reproducibleSetup:\(\)=>invoke\('reproducible-setup'\)/);
 assert.match(renderer,/buildMode:sourceProject\.kind==='rust'/);
 for(const id of ['rust-build-mode','reproducible-install','reproducible-check','reproducible-log'])
  assert.ok(ui.includes('id="'+id+'"'),id);
 for(const bad of ["bind('compile-rust'","bind('js-build'","bind('js-install'"])
  assert.ok(!main.includes(bad),bad);
});
