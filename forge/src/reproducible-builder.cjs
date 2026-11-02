'use strict';
// Production builds delegate Git snapshot selection, Docker orchestration, and NEP-0330
// metadata to the official pinned cargo-near CLI. Contract code is NEVER compiled
// on Windows; cargo-near is only the host-side orchestrator of its Docker build.
const fs=require('node:fs/promises');
const path=require('node:path');
const compilerManager=require('./compiler-manager.cjs');

async function gitSnapshot(project,run=compilerManager.run){
 if(!project||project.kind!=='rust'||!path.isAbsolute(project.root))
  throw Error('Production reproducible builds require an open Rust project.');
 const invoke=(args,cwd=project.root)=>run('git',args,{cwd,timeout:15_000});
 let repoRoot;
 try{repoRoot=(await invoke(['rev-parse','--show-toplevel'])).trim();}
 catch{throw Error('Production builds require Git installed and the Rust project committed to a Git repository.');}
 const relative=path.relative(repoRoot,project.root);
 if(relative.startsWith('..')||path.isAbsolute(relative))
  throw Error('Project folder must be inside the Git repository selected for reproducible compilation.');
 const commit=(await invoke(['rev-parse','--verify','HEAD'])).trim();
 if(!/^[a-f0-9]{40,64}$/.test(commit))throw Error('Git HEAD must be a valid committed revision.');
 const dirty=(await invoke(['status','--porcelain','--untracked-files=all'])).trim();
 if(dirty)throw Error('Production build blocked: commit or discard ALL project changes and untracked files first. cargo-near otherwise builds committed code, not unsaved edits. Git status: '+dirty.slice(0,250));
 const manifest=path.join(project.root,'Cargo.toml');
 const lock=(await fs.stat(path.join(project.root,'Cargo.lock')).catch(()=>null))?
   path.join(project.root,'Cargo.lock'):path.join(repoRoot,'Cargo.lock');
 if(!(await fs.stat(lock).catch(()=>null)))throw Error('Production build requires a committed Cargo.lock in the project or workspace root.');
 for(const file of [manifest,lock]){
  const rel=path.relative(repoRoot,file).replace(/\\/g,'/');
  try{await invoke(['ls-files','--error-unmatch','--',rel],repoRoot);}
  catch{throw Error('Production build blocked: '+rel+' must be committed to Git.');}
 }
 return {repoRoot,commit,manifest,lock,projectRelative:relative};
}
async function status(userData){
 if(process.platform!=='win32'||process.arch!=='x64')
  return {ready:false,reason:'Official reproducible build orchestration currently requires Windows 10/11 x64.'};
 try{
  const tool=await compilerManager.status(userData);
  const ready=Boolean(tool.ready&&tool.managedCargoNear&&String(tool.cargoNear.detail).includes(compilerManager.CARGO_NEAR));
  return {ready,reason:ready?'Official cargo-near '+compilerManager.CARGO_NEAR+' ready to orchestrate Docker reproducible builds.':
   'Install the verified official cargo-near/Rust build orchestrator using the Production Toolchain button. No project build scripts run on Windows.',
   version:compilerManager.CARGO_NEAR};
 }catch(e){return {ready:false,reason:'Production toolchain not ready: '+e.message};}
}
async function build(project,userData,helpers,{onLog=()=>{}}={}){
 const ready=await status(userData);
 if(!ready.ready)throw Error(ready.reason);
 // The official CLI independently checks metadata, clones the committed source,
 // and launches its own Docker build. We never recreate that pipeline ourselves.
 const git=await gitSnapshot(project);
 const staged=await helpers.stageProject(project,userData);
 try{
  const outDir=path.join(staged.stage,'official-reproducible-output');
  await fs.mkdir(outDir,{recursive:true});
  onLog({stage:'reproducible',message:'NEAR production build from Git commit '+git.commit.slice(0,12)+'. cargo-near manages the Docker image and source checkout.'});
  const args=['near','build','reproducible-wasm','--manifest-path',git.manifest,'--out-dir',outDir,'--color','never'];
  const log=await compilerManager.run(compilerManager.paths(userData).near,args,{
   cwd:project.root,env:compilerManager.environment(userData),timeout:1_800_000,
   onLog:msg=>onLog({stage:'reproducible',message:String(msg).slice(-450)})
  });
  const files=await helpers.wasmCandidates(outDir);
  if(!files.length)throw Error('Official cargo-near production build did not write a fresh WASM into the designated output directory.');
  return {staged,files,kind:'rust',mode:'reproducible',image:'Cargo.toml [package.metadata.near.reproducible_build]',
   script:'cargo near build reproducible-wasm',gitCommit:git.commit,log:log.slice(-2000)};
 }catch(e){await fs.rm(staged.stage,{recursive:true,force:true}).catch(()=>{});throw e;}
}
module.exports={gitSnapshot,status,build};
