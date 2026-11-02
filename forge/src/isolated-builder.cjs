'use strict';
// Optional isolated Linux Docker builds from staged, secret-filtered project copies.
// No privileged containers, host wallets, or main profile directories are mounted.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash,randomUUID}=require('node:crypto');
const {run}=require('./compiler-manager.cjs');
const {projectInfo}=require('./js-toolchain.cjs');

const NODE_IMAGE='node:22.21.0-bookworm';
const RUST_IMAGE='sourcescan/cargo-near:0.22.0-rust-1.97.1@sha256:7467038bdddc86484b73b416eeadce926ff59013e128e53dec5a19e1cb4b2234';
const HIDDEN=new Set(['.git','.github','.cargo','.rustup','.npm','.ssh','.aws','.config','.near','.env','.vscode','.idea','.next','.turbo']);
const IGNORED=new Set(['node_modules','target','dist','build','out','coverage','vendor','venv','__pycache__']);
const ALLOWED=new Set(['.rs','.js','.ts','.jsx','.tsx','.json','.toml','.lock','.md','.txt','.html','.css','.yaml','.yml','.wasm','.wit','.proto','.png','.svg','.webp','.jpg','.jpeg','.gitignore']);
const SECRET=/^(\.env.*|\.npmrc|\.pypirc|id_rsa.*|.*\.(pem|key|p12|pfx|crt)|.*credentials?.*|.*secrets?.*|.*wallet.*|.*private.*|.*api[_-]?key.*|.*seed.*|.*mnemonic.*|.*keystore.*)$/i;
const STAGE_LIMIT=65_000_000,FILE_LIMIT=14_000_000,ENTRY_LIMIT=7000;
const HASH=x=>createHash('sha256').update(x).digest('hex');
function allowed(rel){
 const parts=rel.replace(/\\/g,'/').split('/');
 if(parts.some(x=>!x||x==='..'||x==='.'||x.startsWith('.')||HIDDEN.has(x)||IGNORED.has(x)||SECRET.test(x)))return false;
 const name=parts.at(-1),ext=path.extname(name).toLowerCase();
 return ALLOWED.has(ext)||['Cargo.lock','package-lock.json','pnpm-lock.yaml','yarn.lock','Cargo.toml','rust-toolchain.toml'].includes(name);
}
async function stageProject(project,userData){
 const root=await fs.realpath(project.root);
 const state={files:0,bytes:0,manifest:[]};
 const stage=await fs.mkdtemp(path.join(os.tmpdir(),'forge-isolated-'));
 const workspace=path.join(stage,'workspace');await fs.mkdir(workspace);
 try{
  async function copy(src,rel,depth){
   if(depth>14)throw Error('Project directory nesting exceeds safety limits.');
   for(const entry of await fs.readdir(src,{withFileTypes:true})){
    if(++state.files>ENTRY_LIMIT)throw Error('Project has too many files for isolated staging.');
    const r=rel?rel+'/'+entry.name:entry.name;
    if(!allowed(r)&&(!entry.isDirectory()||entry.name.startsWith('.')||HIDDEN.has(entry.name)||IGNORED.has(entry.name)))continue;
    if(entry.isSymbolicLink())continue;
    const full=path.join(src,entry.name);
    if(entry.isDirectory()){if(!allowed(r+'/index.rs')&&!allowed(r+'/main.js'))continue;await copy(full,r,depth+1);}
    else if(entry.isFile()&&allowed(r)){
     const st=await fs.stat(full);
     if(st.size>FILE_LIMIT)throw Error('Source file too large to stage: '+r);
     state.bytes+=st.size;if(state.bytes>STAGE_LIMIT)throw Error('Staged source exceeds 65 MB limit.');
     const to=path.join(workspace,...r.split('/'));
     await fs.mkdir(path.dirname(to),{recursive:true});
     const data=await fs.readFile(full);
     await fs.writeFile(to,data,{flag:'wx'});
     state.manifest.push(r+':'+HASH(data));
    }
   }
  }
  await copy(root,'',0);
  state.manifest.sort();
  if(!state.manifest.some(x=>x.startsWith(project.kind==='rust'?'Cargo.toml:':'package.json:')))
   throw Error('Staged project is missing its required Cargo.toml or package.json.');
  return {stage,workspace,files:state.manifest.length,bytes:state.bytes,
   sourceSha256:HASH(state.manifest.join('\n')),kind:project.kind};
 }catch(e){await fs.rm(stage,{force:true,recursive:true}).catch(()=>{});throw e;}
}
function dockerArgs({workspace,image,command,network=false,name,user='1000:1000',memory='4g'}){
 if(!path.isAbsolute(workspace)||!/^forge-[a-f0-9-]{36}$/.test(name||''))
  throw Error('Invalid isolated Docker workspace or container name.');
 const flags=['run','--rm','--name',name,'--init','--pull=never','--cap-drop=ALL',
  '--security-opt=no-new-privileges','--pids-limit=192','--memory='+memory,'--cpus=2',
  '--network='+ (network?'bridge':'none'),'--read-only',
  '--tmpfs=/tmp:rw,nosuid,size=512m','--user='+user,
  '--mount','type=bind,source='+workspace+',target=/work',
  '-w','/work','-e','CI=true','-e','HOME=/tmp','-e','npm_config_cache=/tmp/.npm-cache',
  '-e','CARGO_HOME=/work/.cargo-home','-e','COREPACK_HOME=/work/.corepack'];
 if(image===RUST_IMAGE)flags.push('-e','CARGO_TARGET_DIR=/work/target');
 return [...flags,image,...command];
}
async function dockerStatus(){
 if(process.platform!=='win32'||process.arch!=='x64')return {ready:false,reason:'Docker isolation is currently supported by Forge on Windows x64.'};
 try{
  const out=await run('docker',['info','--format','{{.OSType}}'],{timeout:10000});
  if(out.trim()!=='linux')return {ready:false,reason:'Switch Docker Desktop to Linux containers.'};
  return {ready:true,reason:'Linux Docker daemon is available. Builds use disposable restricted containers.'};
 }catch(e){return {ready:false,reason:'Docker Desktop Linux engine not available. Install/start Docker Desktop first.'};}
}
async function runDocker(args,onLog,timeout){
 return run('docker',args,{timeout,onLog:line=>onLog?.({stage:'isolated',message:String(line).slice(-450)})});
}
async function dockerRun(opts,onLog,timeout){
 const name='forge-'+randomUUID();
 const args=dockerArgs({...opts,name});
 try{return await runDocker(args,onLog,timeout);}
 finally{await run('docker',['rm','-f',name],{timeout:15000}).catch(()=>{});}
}
async function pull(image,onLog){
 return runDocker(['pull',image],onLog,600000);
}
async function wasmCandidates(workspace){
 const result=[];let count=0;
 async function scan(folder,depth=0){
  if(depth>10)return;
  for(const item of await fs.readdir(folder,{withFileTypes:true}).catch(()=>[])){
   if(++count>10000)throw Error('Too many generated files to scan.');
   if(item.isSymbolicLink())continue;
   const file=path.join(folder,item.name);
   if(item.isDirectory())await scan(file,depth+1);
   else if(item.isFile()&&item.name.toLowerCase().endsWith('.wasm')){
    const st=await fs.stat(file);
    if(st.size>8&&st.size<=3_500_000)
     result.push({file,name:path.relative(workspace,file).replace(/\\/g,'/'),mtime:st.mtimeMs,size:st.size});
   }
  }
 }
 await scan(workspace);
 return result.sort((a,b)=>a.name.localeCompare(b.name));
}
async function build(project,userData,{kind,script,onLog=()=>{}}={}){
 const d=await dockerStatus();
 if(!d.ready)throw Error(d.reason);
 if(kind!==project.kind)throw Error('Project kind changed. Open the correct project first.');
 if(project.kind==='javascript'){
  const info=await projectInfo(project);
  if(!info.scripts.some(x=>x.name===script))throw Error('Select a supported project build script.');
 }
 const staged=await stageProject(project,userData);
 const image=project.kind==='rust'?RUST_IMAGE:NODE_IMAGE;
 const before=new Map();
 for(const candidate of await wasmCandidates(staged.workspace))before.set(candidate.name,HASH(await fs.readFile(candidate.file)));
 try{
  onLog({stage:'isolated',message:'Staged '+staged.files+' source files without wallet credentials. Pulling pinned toolchain image.'});
  await pull(image,onLog);
  if(project.kind==='rust'){
   if(!(await fs.stat(path.join(staged.workspace,'Cargo.lock')).catch(()=>null)))
    throw Error('Isolated Rust builds require Cargo.lock to pin dependencies.');
   onLog({stage:'isolated',message:'Fetching locked Rust dependencies inside a restricted container (network enabled for download stage).'});
   await dockerRun({workspace:staged.workspace,image,network:true,command:['cargo','fetch','--locked'],user:'0:0'},onLog,900000);
   onLog({stage:'isolated',message:'Compiling Rust offline. No network or wallet secrets are exposed to the compiler.'});
   await dockerRun({workspace:staged.workspace,image,network:false,
    command:['cargo','near','build','non-reproducible-wasm','--locked','--no-abi'],user:'0:0'},onLog,1200000);
  }else{
   const info=await projectInfo(project),hasLock=info.hasLock;
   const pkg=JSON.parse(await fs.readFile(path.join(project.root,'package.json'),'utf8'));
   const pnpmLock=Boolean(await fs.stat(path.join(project.root,'pnpm-lock.yaml')).catch(()=>null));
   const usePnpm=info.legacySdk||pnpmLock||String(pkg.packageManager||'').startsWith('pnpm@');
   const packageCommand=usePnpm?'pnpm via Corepack':'npm';
   onLog({stage:'isolated',message:'Installing dependencies with '+packageCommand+' in a disposable Linux container. Network is enabled for downloads only.'});
   // Legacy near-sdk-js runs a Linux-only postinstall; it must be isolated, explicitly approved and treated as experimental.
   const dependencyCommand=usePnpm?['corepack','pnpm','install',...(pnpmLock?['--frozen-lockfile']:[])]:
    (hasLock?['npm','ci','--no-audit','--no-fund']:['npm','install','--no-audit','--no-fund']);
   if(!info.legacySdk)dependencyCommand.push('--ignore-scripts');
   await dockerRun({workspace:staged.workspace,image,network:true,command:dependencyCommand},onLog,900000);
   onLog({stage:'isolated',message:'Building with '+packageCommand+' offline inside a restricted Linux container.'});
   await dockerRun({workspace:staged.workspace,image,network:false,
    command:usePnpm?['corepack','pnpm','run',script]:['npm','run',script]},onLog,900000);
  }
  const files=[];
  for(const candidate of await wasmCandidates(staged.workspace)){
   const digest=HASH(await fs.readFile(candidate.file));
   if(before.get(candidate.name)!==digest)files.push({...candidate,sha256:digest});
  }
  if(!files.length)throw Error('Build completed but no new or modified WASM artifact was produced. Check the build output; Forge will not reuse a stale binary.');
  return {staged,files,kind:project.kind,image,script:script||'cargo near build'};
 }catch(e){
  await fs.rm(staged.stage,{recursive:true,force:true}).catch(()=>{});
  throw e;
 }
}
module.exports={RUST_IMAGE,NODE_IMAGE,stageProject,dockerArgs,dockerStatus,build,wasmCandidates,allowed};
