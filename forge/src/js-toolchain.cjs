'use strict';
// User-profile Node.js manager and npm project runner for legacy NEAR JS/TS projects.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash,randomUUID}=require('node:crypto');
const {run}=require('./compiler-manager.cjs');
const VERSION='v22.21.0';
const DIST='node-'+VERSION+'-win-x64';
const BASE='https://nodejs.org/dist/'+VERSION+'/';
const ARCHIVE=DIST+'.zip';
const PINNED_SHA256='84d31df6571c3c7156707265bf51e2a021656fa1584bf6f4486b792dcde54d7d';
const BLOCKED_ENV=/^(NEAR_PRIVATE_KEY|NEAR_SECRET_KEY|NEAR_SEED_PHRASE|NEAR_WALLET_SEED|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN)$/i;
function assertWindows(){if(process.platform!=='win32'||process.arch!=='x64')throw Error('Managed Node compiler is Windows x64 only.');}
function root(userData){return path.join(userData,'compiler',DIST);}
function binary(userData){return path.join(root(userData),'node.exe');}
function npmCli(userData){return path.join(root(userData),'node_modules','npm','bin','npm-cli.js');}
async function exists(file){try{return (await fs.stat(file)).isFile();}catch{return false;}}
function environment(userData){
 const env={...process.env};const key=Object.keys(env).find(x=>x.toLowerCase()==='path')||'PATH';
 env[key]=[root(userData),env[key]||''].join(path.delimiter);
 env.npm_config_ignore_scripts='true';env.npm_config_audit='false';env.npm_config_fund='false';
 for(const key of Object.keys(env))if(BLOCKED_ENV.test(key))delete env[key];
 return env;
}
async function status(userData){
 assertWindows();
 if(!await exists(binary(userData))||!await exists(npmCli(userData)))
  return {ready:false,version:VERSION,description:'Managed Node.js '+VERSION+' is not installed.'};
 try{
  const output=await run(binary(userData),['--version'],{env:environment(userData),timeout:12000});
  if(output.trim()===VERSION)return {ready:true,version:VERSION,description:'Managed Node.js '+VERSION+' and npm are available.'};
 }catch{}
 return {ready:false,version:VERSION,description:'Managed Node.js installation failed validation.'};
}
async function download(url,limit,progress){
 const parsed=new URL(url);
 if(parsed.protocol!=='https:'||parsed.hostname!=='nodejs.org'||!parsed.pathname.startsWith('/dist/'+VERSION+'/'))
  throw Error('Non-official Node.js download URL rejected.');
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(240000)});
 if(!response.ok||!response.body)throw Error('Node.js download failed: HTTP '+response.status);
 if(Number(response.headers.get('content-length')||0)>limit)throw Error('Node.js download exceeded size limit.');
 const chunks=[];let size=0;
 for await(const piece of response.body){
  size+=piece.byteLength;
  if(size>limit)throw Error('Node.js download is too large.');
  chunks.push(Buffer.from(piece));
  if(progress)progress(size,Number(response.headers.get('content-length')||0));
 }
 return Buffer.concat(chunks,size);
}
function manifestDigest(manifest){
 const line=String(manifest).split(/\r?\n/).find(s=>s.trim().endsWith('  '+ARCHIVE));
 if(!line||!/^[0-9a-fA-F]{64}\s\s/.test(line))throw Error('Official SHA-256 manifest is missing the expected Windows ZIP.');
 return line.slice(0,64).toLowerCase();
}
async function install(userData,onProgress=()=>{}){
 assertWindows();
 const first=await status(userData);
 if(first.ready)return first;
 const work=await fs.mkdtemp(path.join(os.tmpdir(),'forge-node-'));
 const report=(stage,message)=>onProgress({stage,message});
 try{
  report('node','Checking the official Node.js SHA-256 manifest.');
  const list=(await download(BASE+'SHASUMS256.txt',100000)).toString('utf8');
  const expected=manifestDigest(list);
  if(expected!==PINNED_SHA256)throw Error('The official Node.js checksum manifest does not match the release-pinned SHA-256. Installation cancelled.');
  report('node','Downloading the official Windows x64 Node.js runtime.');
  let last=0;
  const zip=await download(BASE+ARCHIVE,100_000_000,(n,total)=>{
   if(Date.now()-last>500){last=Date.now();report('node','Downloaded '+(n/1048576).toFixed(1)+' MB'+(total?' of '+(total/1048576).toFixed(1)+' MB':''));}
  });
  if(createHash('sha256').update(zip).digest('hex')!==expected)
   throw Error('Node.js ZIP checksum mismatch. Installation cancelled.');
  const zipFile=path.join(work,ARCHIVE);
  await fs.writeFile(zipFile,zip,{flag:'wx'});
  report('node','Extracting the verified Node.js ZIP into your Windows user profile.');
  await run('tar.exe',['-xf',zipFile,'-C',work],{cwd:work,timeout:180000});
  const extracted=path.join(work,DIST);
  if(!await exists(path.join(extracted,'node.exe'))||!await exists(path.join(extracted,'node_modules','npm','bin','npm-cli.js')))
   throw Error('Node.js archive missing required node.exe or npm files.');
  const version=(await run(path.join(extracted,'node.exe'),['--version'],{timeout:15000})).trim();
  if(version!==VERSION)throw Error('Node.js runtime version does not match the pinned release.');
  await fs.mkdir(path.dirname(root(userData)),{recursive:true,mode:0o700});
  if(await exists(binary(userData)))throw Error('A different managed Node.js installation already exists. Remove it manually after reviewing.');
  await fs.rename(extracted,root(userData));
  const result=await status(userData);
  if(!result.ready)throw Error('Node.js setup did not pass the final readiness check.');
  report('complete','Node.js installed locally. JavaScript/TypeScript project builds are available.');
  return result;
 }finally{await fs.rm(work,{recursive:true,force:true}).catch(()=>{});}
}
async function projectInfo(project){
 if(project.kind!=='javascript')throw Error('Select a JavaScript/TypeScript project containing package.json.');
 const file=path.join(project.root,'package.json');
 if((await fs.stat(file)).size>300000)throw Error('Project package.json is too large.');
 const parsed=JSON.parse(await fs.readFile(file,'utf8'));
 const scripts=parsed.scripts||{};
 const buildScripts=['build:contract','build'].filter(x=>typeof scripts[x]==='string'&&scripts[x].trim());
 return {name:String(parsed.name||path.basename(project.root)).slice(0,100),
  scripts:buildScripts.map(name=>({name,command:scripts[name].slice(0,400)})),
  hasLock:await exists(path.join(project.root,'package-lock.json')),
  hasModules:(await fs.stat(path.join(project.root,'node_modules')).catch(()=>null))?.isDirectory()||false,
  legacySdk:!!(parsed.dependencies?.['near-sdk-js']||parsed.devDependencies?.['near-sdk-js'])};
}
async function npmRun(userData,project,args,onLog){
 const ready=await status(userData);
 if(!ready.ready)throw Error('Install the managed Node.js runtime first.');
 return run(binary(userData),[npmCli(userData),...args],{
  cwd:project.root,env:environment(userData),timeout:900000,
  onLog:msg=>onLog?.({stage:'javascript',message:msg.slice(-450)})
 });
}
async function installDependencies(userData,project,onLog){
 const info=await projectInfo(project);
 const args=info.hasLock?['ci','--ignore-scripts','--no-audit','--no-fund','--no-progress']:
  ['install','--ignore-scripts','--no-audit','--no-fund','--no-progress'];
 return npmRun(userData,project,args,onLog);
}
async function build(userData,project,script,onLog){
 const info=await projectInfo(project);
 const matched=info.scripts.find(x=>x.name===script);
 if(!matched)throw Error('Build script is missing or changed. Reopen project and review package.json.');
 return npmRun(userData,project,['run',script,'--ignore-scripts'],onLog);
}
async function wasmFiles(project){
 const files=[];let scanned=0;
 const ignored=new Set(['node_modules','.git','target','.next','coverage','.turbo','vendor']);
 async function walk(dir,depth){
  if(depth>8)return;
  for(const entry of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){
   if(++scanned>14000)throw Error('Project contains too many files to scan for WASM artifacts.');
   if(entry.isSymbolicLink()||ignored.has(entry.name))continue;
   const full=path.join(dir,entry.name);
   if(entry.isDirectory())await walk(full,depth+1);
   else if(entry.isFile()&&entry.name.toLowerCase().endsWith('.wasm')){
    const st=await fs.stat(full);
    if(st.size>8&&st.size<=3_500_000)files.push({file:full,mtime:st.mtimeMs});
   }
  }
 }
 await walk(project.root,0);
 return files.sort((a,b)=>b.mtime-a.mtime);
}
module.exports={VERSION,DIST,ARCHIVE,BASE,PINNED_SHA256,manifestDigest,status,install,environment,projectInfo,
 installDependencies,build,wasmFiles,root,binary,npmCli};
