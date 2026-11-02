'use strict';
// Local, user-scoped toolchain manager for Windows x64. No wallet or NEAR RPC access.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {createHash, randomUUID} = require('node:crypto');
const {gunzipSync} = require('node:zlib');

const TOOLCHAIN = '1.97.1';
const TARGET = 'wasm32-unknown-unknown';
const CARGO_NEAR = '0.22.0';
const RUSTUP = '1.29.0';
const RUSTUP_BASE = 'https://static.rust-lang.org/rustup/archive/' + RUSTUP + '/x86_64-pc-windows-msvc/rustup-init.exe';
const NEAR_ARCHIVE = 'https://github.com/near/cargo-near/releases/download/cargo-near-v' + CARGO_NEAR + '/cargo-near-x86_64-pc-windows-msvc.tar.gz';
const NEAR_SHA256 = 'c50ad7e3e220923db006c43668f25bdbe0c4612ca6d6b48d08e3c0b7532bf122';

function assertWindows() {
 if(process.platform !== 'win32' || process.arch !== 'x64')
  throw Error('Integrated compiler setup is currently supported on Windows 10/11 x64 only.');
}
function paths(userData) {
 const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
 return {cargoHome, rustup:path.join(cargoHome,'bin','rustup.exe'),
  near:path.join(userData,'compiler','bin','cargo-near.exe'),
  nearDir:path.join(userData,'compiler','bin')};
}
function environment(userData) {
 const p=paths(userData);
 const env={...process.env};
 const pathKey=Object.keys(env).find(k=>k.toLowerCase()==='path')||'PATH';
 env[pathKey]=[p.nearDir,path.join(p.cargoHome,'bin'),env[pathKey]||''].join(path.delimiter);
 env.CARGO_TERM_COLOR='never';
 // Keep deployment secrets out of child environment where possible.
 for(const key of Object.keys(env))if(/^(NEAR_PRIVATE_KEY|NEAR_SECRET_KEY|NEAR_SEED_PHRASE|NEAR_WALLET_SEED)$/i.test(key))delete env[key];
 return env;
}
async function exists(file) {try{return (await fs.stat(file)).isFile();}catch{return false;}}
function trimLog(s){return String(s||'').replace(/\x1b\[[0-9;]*m/g,'').slice(-22000)}
function run(command,args,{cwd=os.homedir(),env=process.env,timeout=30_000,onLog}={}) {
 return new Promise((resolve,reject)=>{
  let out='',finished=false,timedOut=false,child;
  const finish=(error,value)=>{
   if(finished)return;finished=true;clearTimeout(timer);
   if(error)reject(error);else resolve(value);
  };
  try{child=spawn(command,args,{cwd,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}
  catch(e){reject(e);return;}
  const handle=data=>{
   const str=String(data);out=trimLog(out+str);
   if(onLog)onLog(trimLog(str).slice(-250));
  };
  child.stdout.on('data',handle);
  child.stderr.on('data',handle);
  child.on('error',e=>finish(Error('Unable to launch '+path.basename(command)+': '+e.message)));
  child.on('close',code=>{
   if(timedOut)return finish(Error(path.basename(command)+' timed out. '+out.slice(-650)));
   if(code!==0)return finish(Error(path.basename(command)+' exited with code '+code+'. '+out.slice(-1200)));
   finish(null,out);
  });
  const timer=setTimeout(()=>{timedOut=true;child.kill();},timeout);
 });
}
async function probe(command,args,options){
 try{return {ok:true,output:(await run(command,args,{...options,timeout:10_000})).trim().slice(0,250)};}
 catch{return {ok:false,output:''};}
}
async function status(userData){
 assertWindows();
 const p=paths(userData),env=environment(userData);
 const rustupExe=await exists(p.rustup)?p.rustup:'rustup';
 const rustup=await probe(rustupExe,['--version'],{env});
 const toolchains=rustup.ok?await probe(rustupExe,['toolchain','list'],{env}):{ok:false,output:''};
 const installed=toolchains.ok && toolchains.output.split('\n').some(s=>s.trim().startsWith(TOOLCHAIN+'-')||s.trim()===TOOLCHAIN);
 const wasm=installed?await probe(rustupExe,['target','list','--installed','--toolchain',TOOLCHAIN],{env}):{ok:false,output:''};
 const cargo=installed?await probe('cargo',['+'+TOOLCHAIN,'--version'],{env}):{ok:false,output:''};
 const nearExe=await exists(p.near)?p.near:'cargo';
 const nearArgs=nearExe===p.near?['--version']:['near','--version'];
 const near=await probe(nearExe,nearArgs,{env});
 const ready=Boolean(rustup.ok&&installed&&wasm.ok&&wasm.output.includes(TARGET)&&cargo.ok&&near.ok);
 return {supported:true,ready,
  rustup:{installed:rustup.ok,detail:rustup.output||'Not installed'},
  rust:{installed:installed&&cargo.ok,detail:cargo.output||('Rust '+TOOLCHAIN+' required')},
  wasm:{installed:wasm.ok&&wasm.output.includes(TARGET),detail:TARGET},
  cargoNear:{installed:near.ok,detail:near.output||('cargo-near '+CARGO_NEAR+' required')},
  versions:{rustup:RUSTUP,rust:TOOLCHAIN,cargoNear:CARGO_NEAR},managedCargoNear:await exists(p.near)};
}
function checkFinalUrl(finalUrl,provider){
 const u=new URL(finalUrl);
 if(u.protocol!=='https:')throw Error('Download refused: insecure transport.');
 if(provider==='rust'&&u.hostname!=='static.rust-lang.org')throw Error('Unexpected Rust installer host.');
 if(provider==='github'&&u.hostname!=='github.com'&&!u.hostname.endsWith('.githubusercontent.com'))
  throw Error('Unexpected GitHub release asset host.');
}
async function download(url,{provider,limit=35_000_000,onProgress}={}){
 const response=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(240_000)});
 checkFinalUrl(response.url,provider);
 if(!response.ok||!response.body)throw Error('Tool download failed: HTTP '+response.status);
 const length=Number(response.headers.get('content-length')||0);
 if(length>limit)throw Error('Tool download exceeds size limit.');
 let total=0;const parts=[];
 for await (const chunk of response.body){
  total+=chunk.byteLength;
  if(total>limit)throw Error('Tool download exceeded size limit.');
  parts.push(Buffer.from(chunk));
  if(onProgress)onProgress(total,length);
 }
 return Buffer.concat(parts,total);
}
async function rustupInstaller(onProgress){
 const checksumBytes=await download(RUSTUP_BASE+'.sha256',{provider:'rust',limit:4096});
 const checksumText=checksumBytes.toString('ascii').trim();
 const match=checksumText.match(/^([0-9a-fA-F]{64})(?:\s|$)/);
 if(!match)throw Error('Official Rustup checksum is missing or malformed.');
 const bin=await download(RUSTUP_BASE,{provider:'rust',limit:35_000_000,onProgress});
 if(createHash('sha256').update(bin).digest('hex')!==match[1].toLowerCase())
  throw Error('Rustup checksum mismatch. Installation cancelled.');
 if(bin.subarray(0,2).toString('ascii')!=='MZ')throw Error('Rustup executable signature is invalid.');
 return bin;
}
function cargoNearFromArchive(tarGz){
 const raw=gunzipSync(tarGz,{maxOutputLength:120_000_000});
 let offset=0,found=null;
 while(offset+512<=raw.length){
  const header=raw.subarray(offset,offset+512);
  if(header.every(b=>b===0))break;
  const name=header.toString('utf8',0,100).split('\0')[0].replace(/\\/g,'/');
  const sizeField=header.toString('ascii',124,136).split('\0')[0].trim();
  if(!/^[0-7]+$/.test(sizeField))throw Error('Invalid TAR member length.');
  const size=parseInt(sizeField,8);
  const type=header.toString('ascii',156,157);
  if(!Number.isSafeInteger(size)||size<0||offset+512+size>raw.length)throw Error('Invalid TAR member boundaries.');
  if(name.split('/').pop().toLowerCase()==='cargo-near.exe'){
   if(found||!(type==='\0'||type==='0')||size<50_000||size>85_000_000)
    throw Error('Unexpected cargo-near archive layout.');
   found=Buffer.from(raw.subarray(offset+512,offset+512+size));
  }
  offset+=512+Math.ceil(size/512)*512;
 }
 if(!found||found.subarray(0,2).toString('ascii')!=='MZ')
  throw Error('Verified archive does not contain a Windows cargo-near executable.');
 return found;
}
async function setup(userData,onProgress=()=>{}){
 assertWindows();
 let last=0;
 const progress=(stage,message,bytes=undefined,total=undefined)=>{
  const now=Date.now();if(stage==='download'&&now-last<180)return;last=now;
  onProgress({stage,message:String(message).slice(-380),bytes,total});
 };
 const workDir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-compiler-'));
 try{
  const p=paths(userData),env=environment(userData);
  const current=await status(userData);
  if(current.ready){progress('complete','All compiler components are already ready.');return current;}
  if(!current.rustup.installed){
   progress('rustup','Downloading official Rustup installer and SHA-256 checksum.');
   const installer=await rustupInstaller((n,t)=>progress('download','Downloading Rustup',n,t));
   const exe=path.join(workDir,'rustup-init.exe');
   await fs.writeFile(exe,installer,{flag:'wx'});
   progress('rustup','Installing Rustup and Rust '+TOOLCHAIN+' in your Windows user profile.');
   await run(exe,['-y','--no-modify-path','--profile','minimal','--default-toolchain',TOOLCHAIN,
    '--target',TARGET],{env,timeout:900_000,onLog:s=>progress('rustup',s)});
  }
  const rustupExe=await exists(p.rustup)?p.rustup:'rustup';
  progress('rust','Ensuring Rust '+TOOLCHAIN+' and the NEAR WebAssembly target are installed.');
  await run(rustupExe,['toolchain','install',TOOLCHAIN,'--profile','minimal','--target',TARGET],
   {env,timeout:900_000,onLog:s=>progress('rust',s)});
  if(!current.cargoNear.installed){
   progress('cargo-near','Downloading official cargo-near '+CARGO_NEAR+' and checking pinned SHA-256.');
   const archive=await download(NEAR_ARCHIVE,{provider:'github',limit:25_000_000,
    onProgress:(n,t)=>progress('download','Downloading cargo-near',n,t)});
   if(createHash('sha256').update(archive).digest('hex')!==NEAR_SHA256)
    throw Error('cargo-near SHA-256 mismatch. Executable was not installed.');
   const executable=cargoNearFromArchive(archive);
   await fs.mkdir(p.nearDir,{recursive:true,mode:0o700});
   const temp=path.join(p.nearDir,'cargo-near-'+randomUUID()+'.tmp');
   try{
    await fs.writeFile(temp,executable,{flag:'wx',mode:0o700});
    await fs.rename(temp,p.near);
   }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
   progress('cargo-near','Verified cargo-near binary installed in your local Forge compiler folder.');
  }
  const final=await status(userData);
  if(!final.ready)throw Error('Tool installation finished, but readiness checks are incomplete. Restart Forge, click Check Compiler, and verify Visual Studio C++ tools if builds still fail.');
  progress('complete','Compiler ready. You can compile a trusted Rust NEAR project.');
  return final;
 }finally{await fs.rm(workDir,{recursive:true,force:true}).catch(()=>{});}
}
module.exports={TOOLCHAIN,TARGET,CARGO_NEAR,RUSTUP_BASE,NEAR_ARCHIVE,NEAR_SHA256,paths,environment,
 run,status,setup,cargoNearFromArchive,checkFinalUrl};
