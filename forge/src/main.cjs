'use strict';
const {app,BrowserWindow,ipcMain,dialog,session,shell}=require('electron');
const {readFile,readdir,stat}=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const {Library}=require('./library.cjs');
const compilerManager=require('./compiler-manager.cjs');
const sourceEditor=require('./source-editor.cjs');
const jsToolchain=require('./js-toolchain.cjs');
const {YOCTO,accountId,fmt,wasm,sha,plan,actionsFor,displayActions}=require('./core.cjs');

const RPC='https://rpc.testnet.near.org';
const EMPTY_CODE='11111111111111111111111111111111';
let current=null,signer=null,previewRecord=null,pendingTarget=null,working=false,library=null,compilerSetupBusy=false,compilerBuildBusy=false,jsSetupBusy=false,jsBuildBusy=false,editorProject=null,editorLoaded=null;
function invalidate(){previewRecord=null;}
const result=(code,data)=>({ok:true,data});
function safeError(e){
 let message=typeof e?.message==='string'?e.message:'Unexpected error';
 return message.slice(0,450).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{70,110}/g,'[PRIVATE KEY REDACTED]');
}
function bind(name,handler){
 ipcMain.handle('forge:'+name,async(event,data)=>{
  try{
   if(event.sender.getURL()!==require('node:url').pathToFileURL(path.join(__dirname,'index.html')).toString())
      throw Error('Untrusted application window.');
   return {ok:true,data:await handler(data,event)};
  }catch(e){return {ok:false,error:safeError(e)}}
 });
}
async function api(){return import('near-api-js');}
async function rpc(method,params){
 const res=await fetch(RPC,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},
   signal:AbortSignal.timeout(30000),body:JSON.stringify({jsonrpc:'2.0',id:'nearium-forge',method,params})});
 if(!res.ok)throw Error('NEAR Testnet RPC HTTP '+res.status);
 const json=await res.json();
 if(json.error){const error=Error(json.error?.message||'NEAR RPC error');
   error.rpcName=json.error?.cause?.name||json.error?.name;throw error;}
 return json.result;
}
async function network(){
 const s=await rpc('status',[]);
 if(s.chain_id!=='testnet')throw Error('RPC chain mismatch. Nearium Forge alpha cannot use mainnet.');
 return {network:'testnet',blockHeight:s.sync_info?.latest_block_height??null};
}
async function queryAccount(id){
 try{return await rpc('query',{request_type:'view_account',finality:'final',account_id:id});}
 catch(e){if(e.rpcName==='UNKNOWN_ACCOUNT')return null;throw e;}
}
async function price(){
 const p=await rpc('EXPERIMENTAL_protocol_config',{finality:'final'});
 if(p.chain_id!=='testnet')throw Error('Protocol config returned the wrong network.');
 const n=p.runtime_config?.storage_amount_per_byte;
 if(!n||!/^\\d+$/.test(String(n)))throw Error('Testnet storage price unavailable.');
 return BigInt(n);
}
async function importKey({owner,secret}){
 if(compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy)throw Error('Compiler active. Disconnect signer until compilation is complete.');
 if(working)throw Error('Deployment in progress. Do not change the signer.');
 owner=accountId(owner);
 if(typeof secret!=='string'||secret.length>512||!/^ed25519:[1-9A-HJ-NP-Za-km-z]{70,110}$/.test(secret.trim()))
  throw Error('Use a dedicated NEAR Testnet exported ed25519 private key. Do not enter a seed phrase.');
 const {Account,JsonRpcProvider,KeyPairSigner}=await api();
 const key=KeyPairSigner.fromSecretKey(secret.trim());
 const publicKey=await key.getPublicKey();
 await network();
 const auth=await rpc('query',{request_type:'view_access_key',finality:'final',account_id:owner,public_key:publicKey.toString()});
 if(auth.permission!=='FullAccess')throw Error('This key is not a FullAccess key on that Testnet account.');
 const state=await queryAccount(owner);
 signer={owner,publicKey,account:new Account(owner,new JsonRpcProvider({url:RPC}),key)};
 invalidate();
 return {owner,publicKey:publicKey.toString(),balance:fmt(BigInt(state?.amount||'0'))};
}
async function importKeyFile(owner){
 if(compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy)throw Error('Compiler active.');
 if(working)throw Error('Deployment in progress.');
 accountId(owner);
 const choice=await dialog.showOpenDialog({title:'Select a testnet-only NEAR key file',properties:['openFile'],
   filters:[{name:'NEAR credentials',extensions:['json','txt']}]});
 if(choice.canceled)return {cancelled:true};
 const filename=choice.filePaths[0];
 if((await stat(filename)).size>4096)throw Error('Key file exceeds 4 KB.');
 const text=(await readFile(filename,'utf8')).trim();
 let key=text;
 if(text.startsWith('{')){
  const obj=JSON.parse(text);
  if(obj.account_id&&obj.account_id!==owner)throw Error('Credential file account does not match.');
  key=obj.private_key||obj.secret_key;
 }
 return importKey({owner,secret:key});
}
async function openWasm(){
 if(compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy)throw Error('Compiler is active.');
 if(working)throw Error('Deployment in progress.');
 const choice=await dialog.showOpenDialog({title:'Import any NEAR-compatible compiled contract',properties:['openFile'],
   filters:[{name:'NEAR WebAssembly',extensions:['wasm']}]});
 if(choice.canceled)return {cancelled:true};
 const file=choice.filePaths[0];
 if((await stat(file)).size>3_500_000)throw Error('WASM too large. Maximum 3.5 MB.');
 const b=wasm(await readFile(file));
 current={bytes:b,hash:sha(b),name:path.basename(file),source:file};
 invalidate();
 return contractMetadata();
}
function contractMetadata(){
 if(!current)return null;
 return {name:current.name,bytes:current.bytes.length,hash:current.hash,source:current.source};
}
async function compilerStatus(){return compilerManager.status(app.getPath('userData'));}
async function setupCompiler(_unused,event){
 if(working||compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy)throw Error('Another action is running.');
 if(signer)throw Error('Disconnect the local signer before installing compiler tools.');
 const parent=BrowserWindow.fromWebContents(event.sender);
 if(!parent)throw Error('Native Windows confirmation unavailable.');
 const choice=await dialog.showMessageBox(parent,{title:'Install NEAR Compiler Tools',type:'warning',
  buttons:['Cancel','Install / Repair'],defaultId:0,cancelId:0,noLink:true,
  message:'Install Rust and cargo-near for this Windows user?',
  detail:'Rustup 1.29.0 from the official Rust archive, Rust 1.97.1 with WASM target, and cargo-near 0.22.0 from the official NEAR GitHub release. Both downloads require SHA-256 verification. Rust build scripts can run native code. Microsoft C++ Build Tools may be needed. Disconnect signing keys before setup or compilation.'});
 if(choice.response!==1)return {cancelled:true};
 compilerSetupBusy=true;
 try{return await compilerManager.setup(app.getPath('userData'),progress=>{
  if(!event.sender.isDestroyed())event.sender.send('forge:compiler-progress',progress);
 });}finally{compilerSetupBusy=false;}
}
async function compileRust(_options,event){
 if(working||compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy)throw Error('A compiler operation or deployment is active.');
 if(signer)throw Error('Disconnect the local signer before compiling source.');
 const tools=await compilerStatus();
 if(!tools.ready)throw Error('Compiler not ready. Open Compile / Import and install/repair tools.');
 const selected=await dialog.showOpenDialog({title:'Choose trusted Rust NEAR project containing Cargo.toml',properties:['openDirectory']});
 if(selected.canceled)return {cancelled:true};
 const root=selected.filePaths[0];
 if(!(await stat(path.join(root,'Cargo.toml')).catch(()=>null)))throw Error('Folder must contain a Cargo.toml.');
 // Cargo build scripts and dependencies can execute native code on the host OS.
 const parent=BrowserWindow.fromWebContents(event.sender);
 if(!parent)throw Error('Cannot request native compile permission.');
 const choice=await dialog.showMessageBox(parent,{
   title:'Compile Trusted Rust Source?',type:'warning',
   buttons:['Cancel','Compile Rust Project'],defaultId:0,cancelId:0,
   message:'Compile this Rust project with local cargo-near?',
   detail:'Cargo build.rs and dependencies may execute programs on your Windows computer. Compile only source that you trust.\n\nProject: '+root
 });
 if(choice.response!==1)return {cancelled:true};
 compilerBuildBusy=true;
 try{
 // Rust Cargo build.rs and dependencies can execute native code. Only compile trusted sources.
 const output=await new Promise((resolve,reject)=>{
   const child=spawn('cargo',['near','build','non-reproducible-wasm','--no-abi'],{cwd:root,windowsHide:true,shell:false,
     env:compilerManager.environment(app.getPath('userData'))});
   let stdout='',stderr='',ended=false;
   const cap=(s)=>s.slice(-24000);
   child.stdout.on('data',d=>{stdout=cap(stdout+String(d));if(!event.sender.isDestroyed())event.sender.send('forge:compiler-progress',{stage:'compile',message:String(d).slice(-300)})});
   child.stderr.on('data',d=>{stderr=cap(stderr+String(d));if(!event.sender.isDestroyed())event.sender.send('forge:compiler-progress',{stage:'compile',message:String(d).slice(-300)})});
   const timeout=setTimeout(()=>{child.kill();},900000);
   child.on('error',e=>{if(ended)return;ended=true;clearTimeout(timeout);reject(Error('cargo near could not start. Install Rust and cargo-near locally. '+e.message));});
   child.on('close',code=>{if(ended)return;ended=true;clearTimeout(timeout);
     if(code!==0)return reject(Error('Rust compilation failed (exit '+code+'). '+(stderr||stdout).slice(-1500)));
     resolve({log:(stdout+'\n'+stderr).slice(-12000)});
   });
 });
 async function scan(dir,depth=0){
   if(depth>6)return [];
   let result=[];
   for(const entry of await readdir(dir,{withFileTypes:true}).catch(()=>[])){
     const full=path.join(dir,entry.name);
     if(entry.isDirectory())result.push(...await scan(full,depth+1));
     else if(entry.isFile()&&entry.name.endsWith('.wasm')){
       const info=await stat(full);if(info.size>8&&info.size<=3_500_000)result.push({file:full,mtime:info.mtimeMs});
     }
   }
   return result;
 }
 const files=await scan(path.join(root,'target'));
 files.sort((a,b)=>b.mtime-a.mtime);
 const found=files.find(x=>x.file.includes('near')||x.file.includes('release'));
 if(!found)throw Error('Cargo completed but no .wasm found under the project target directory. Import the WASM manually.');
 const b=wasm(await readFile(found.file));
 current={bytes:b,name:path.basename(found.file),hash:sha(b),source:found.file};invalidate();
 return {contract:contractMetadata(),log:output.log};
 }finally{compilerBuildBusy=false;}
}
function ensureEditorIdle(){
 if(working||compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy)
  throw Error('A compiler or deployment operation is in progress.');
}
async function chooseProject(){
 ensureEditorIdle();
 const selected=await dialog.showOpenDialog({title:'Open a Rust, JavaScript, or TypeScript contract project',properties:['openDirectory']});
 if(selected.canceled)return {cancelled:true};
 const project=await sourceEditor.openProject(selected.filePaths[0]);
 editorProject=project;editorLoaded=null;
 const config=project.kind==='javascript'?await jsToolchain.projectInfo(project):null;
 return {root:project.root,kind:project.kind,files:project.files,config};
}
async function openSource(rel){
 ensureEditorIdle();
 if(!editorProject)throw Error('Open a project first.');
 if(!editorProject.files.includes(rel))throw Error('Select an editable project file.');
 const file=await sourceEditor.readSource(editorProject,rel);
 editorLoaded={file:rel,hash:file.hash};
 return file;
}
async function saveSource(data,event){
 ensureEditorIdle();
 if(!editorProject||!editorLoaded||data?.file!==editorLoaded.file)throw Error('Open an editable source file first.');
 if(typeof data?.text!=='string'||data.text.length>1_000_000)throw Error('Invalid source text.');
 const parent=BrowserWindow.fromWebContents(event.sender);
 if(!parent)throw Error('Cannot show Windows save approval.');
 const answer=await dialog.showMessageBox(parent,{title:'Save Contract Source Code',type:'question',
  buttons:['Cancel','Save Changes'],defaultId:0,cancelId:0,noLink:true,
  message:'Save changes to '+editorLoaded.file+'?',
  detail:'This updates the source file on your computer, not any deployed blockchain contract. The previous version will be backed up in your private Windows Forge profile.'});
 if(answer.response!==1)return {cancelled:true};
 const result=await sourceEditor.saveSource(editorProject,editorLoaded.file,data.text,editorLoaded.hash,app.getPath('userData'));
 editorLoaded.hash=result.hash;
 return {file:result.file,hash:result.hash,unchanged:result.unchanged,backupCreated:Boolean(result.backup)};
}
async function nodeStatus(){
 return jsToolchain.status(app.getPath('userData'));
}
async function nodeSetup(_options,event){
 ensureEditorIdle();
 if(signer)throw Error('Disconnect the local signer before installing JavaScript compiler tools.');
 const parent=BrowserWindow.fromWebContents(event.sender);
 if(!parent)throw Error('Cannot show native Windows confirmation.');
 const answer=await dialog.showMessageBox(parent,{title:'Install Managed Node.js for JS/TS Contracts',type:'warning',
  buttons:['Cancel','Install Node.js'],defaultId:0,cancelId:0,noLink:true,
  message:'Install a local Node.js runtime for legacy JavaScript and TypeScript contract projects?',
  detail:'Forge downloads pinned Node.js v22.21.0 from nodejs.org over HTTPS, verifies its published SHA-256 checksum, and extracts it into your Windows user profile. The official NEAR JavaScript smart contract SDK is archived and deprecated. Do not use experimental JS/TS contracts to hold valuable assets. Installation is local and will not access your signer.'});
 if(answer.response!==1)return {cancelled:true};
 jsSetupBusy=true;
 try{return await jsToolchain.install(app.getPath('userData'),progress=>{
  if(!event.sender.isDestroyed())event.sender.send('forge:compiler-progress',progress);
 });}finally{jsSetupBusy=false;}
}
async function jsInstallDependencies(_options,event){
 ensureEditorIdle();
 if(signer)throw Error('Disconnect the local signer before installing project dependencies.');
 if(!editorProject||editorProject.kind!=='javascript')throw Error('Open a JavaScript or TypeScript project with package.json first.');
 const info=await jsToolchain.projectInfo(editorProject);
 const parent=BrowserWindow.fromWebContents(event.sender);
 if(!parent)throw Error('Native approval is required.');
 const answer=await dialog.showMessageBox(parent,{title:'Install Local JavaScript Project Dependencies',type:'warning',
  buttons:['Cancel','Install Dependencies'],defaultId:0,cancelId:0,noLink:true,
  message:'Install npm dependencies for '+info.name+'?',
  detail:'This downloads dependencies listed by the selected project. npm lifecycle scripts are disabled during installation, but dependency packages may still be unsafe. Only use trusted projects. No signing keys may be connected.\n\n'+(info.hasLock?'Uses npm ci with the project lockfile.':'No package-lock.json found: npm install will resolve current dependency versions and generate a lockfile.')});
 if(answer.response!==1)return {cancelled:true};
 jsBuildBusy=true;
 try{
  const log=await jsToolchain.installDependencies(app.getPath('userData'),editorProject,progress=>{
   if(!event.sender.isDestroyed())event.sender.send('forge:compiler-progress',progress);
  });
  return {ok:true,log:log.slice(-3000)};
 }finally{jsBuildBusy=false;}
}
async function jsBuild(data,event){
 ensureEditorIdle();
 if(signer)throw Error('Disconnect the local signer before compiling a JavaScript or TypeScript project.');
 if(!editorProject||editorProject.kind!=='javascript')throw Error('Open a JavaScript/TypeScript project with package.json first.');
 const info=await jsToolchain.projectInfo(editorProject);
 const script=String(data?.script||'');
 const selected=info.scripts.find(s=>s.name===script);
 if(!selected)throw Error('The selected package.json build script no longer exists.');
 const parent=BrowserWindow.fromWebContents(event.sender);
 if(!parent)throw Error('Native Windows confirmation unavailable.');
 const answer=await dialog.showMessageBox(parent,{title:'Run JavaScript/TypeScript Contract Build',type:'warning',
  buttons:['Cancel','Run Build Script'],defaultId:0,cancelId:0,noLink:true,
  message:'Run npm script '+script+' for '+info.name+'?',
  detail:'Project command:\n'+selected.command+'\n\nThis command may execute arbitrary native code on your computer. Only approve code you trust. NEAR near-sdk-js is archived/deprecated and its contracts should not be trusted with valuable assets. This compiles locally, without deploying or signing any transaction.'});
 if(answer.response!==1)return {cancelled:true};
 const started=Date.now();
 jsBuildBusy=true;
 try{
  const log=await jsToolchain.build(app.getPath('userData'),editorProject,script,progress=>{
   if(!event.sender.isDestroyed())event.sender.send('forge:compiler-progress',progress);
  });
  const candidates=(await jsToolchain.wasmFiles(editorProject)).filter(x=>x.mtime>=started-3000);
  if(candidates.length===0)throw Error('Build finished but no newly built .wasm was found in the selected project. Check your npm build script and outputs.');
  let chosen=candidates[0].file;
  if(candidates.length>1){
   const pick=await dialog.showOpenDialog(parent,{title:'Multiple WASM files were built. Select the intended NEAR contract.',defaultPath:editorProject.root,
    properties:['openFile'],filters:[{name:'Compiled NEAR WebAssembly',extensions:['wasm']}]});
   if(pick.canceled)return {cancelled:true,log:log.slice(-3000)};
   chosen=pick.filePaths[0];
   if(!candidates.some(x=>path.resolve(x.file)===path.resolve(chosen)))throw Error('Select a newly built WASM from this project.');
  }
  const artifact=wasm(await readFile(chosen));
  current={bytes:artifact,name:path.basename(chosen),hash:sha(artifact),source:chosen};
  invalidate();
  return {contract:contractMetadata(),log:log.slice(-4500),script};
 }finally{jsBuildBusy=false;}
}
async function preflight(data){
 if(compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy)throw Error('Compiler is active.');
 await network();
 if(!current)throw Error('Import or compile a NEAR-compatible WASM contract first.');
 if(!signer)throw Error('Connect a dedicated FullAccess Testnet key locally.');
 const storageCost=await price();
 const p=plan(data,current.bytes,storageCost);
 if(signer.owner!==p.signer)throw Error('Signer does not match the selected account.');
 if(p.mode==='existing'&&p.keyMode==='keyless')throw Error('Keyless is supported only for new child accounts.');
 const [target,owner]=await Promise.all([queryAccount(p.target),queryAccount(p.signer)]);
 if(!owner)throw Error('Signer account is missing on NEAR Testnet.');
 const auth=await rpc('query',{request_type:'view_access_key',finality:'final',account_id:p.signer,public_key:signer.publicKey.toString()});
 if(auth.permission!=='FullAccess')throw Error('The connected key no longer has full access.');
 const {baseEncode}=await api();
 const onchainHash=baseEncode(createHash('sha256').update(current.bytes).digest());
 if(p.mode==='new'&&target)throw Error('Target child account already exists. Cannot overwrite through CreateAccount.');
 if(p.mode==='existing'&&!target)throw Error('Existing account does not exist. Use New Child Account mode.');
 const upgrade=Boolean(p.mode==='existing'&&target?.code_hash&&target.code_hash!==EMPTY_CODE);
 if(upgrade&&!p.replace)throw Error('Account already has deployed code. Explicitly enable Replace Existing Code to proceed.');
 const costReserve=YOCTO/4n;
 const ownerStorage=BigInt(owner.storage_usage||0)*storageCost;
 const ownerLocked=BigInt(owner.locked||0);
 const ownerAvailable=BigInt(owner.amount)-ownerStorage-ownerLocked;
 const required=p.funding+p.init.deposit+costReserve;
 if(ownerAvailable<required)throw Error('Insufficient spendable NEAR: need '+fmt(required)+' including a 0.25 NEAR gas margin.');
 if(p.mode==='existing'){
   const existingStorage=BigInt(target.storage_usage||0)*storageCost;
   const oldCodeDeposit=BigInt(target.amount)-existingStorage-BigInt(target.locked||0);
   const newCodeBudget=BigInt(current.bytes.length)*storageCost;
   // Do not block upgrades on a simplified estimate; report explicitly so user can top up.
   if(oldCodeDeposit<newCodeBudget/2n)throw Error('Existing account may lack storage budget for this WASM. Top up before deploying.');
 }
 return {p,upgrade,onchainHash,existingCodeHash:target?.code_hash||null,
   spendable:fmt(ownerAvailable),required:fmt(required),actions:displayActions(p),
   artifact:contractMetadata(),targetExists:Boolean(target)};
}
async function check(data){
 if(working)throw Error('Deployment is in progress.');
 const details=await preflight(data);
 const token=randomUUID();
 previewRecord={token,signature:JSON.stringify(data),hash:current.hash,owner:signer.owner,target:details.p.target};
 return {token,target:details.p.target,owner:details.p.signer,upgrade:details.upgrade,
   existingCodeHash:details.existingCodeHash,actions:details.actions,
   artifact:details.artifact,spendable:details.spendable,required:details.required,
   keyMode:details.p.keyMode,init:details.p.init.method||'none'};
}
async function deploy(data,event){
 if(compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy)throw Error('Compiler is active.');
 if(working)throw Error('Another deployment is running.');
 working=true;let attempted=false;
 try{
  if(!data?.ack)throw Error('Review and acknowledge deployment risks first.');
  if(!previewRecord||data.token!==previewRecord.token||JSON.stringify(data.config)!==previewRecord.signature)
    throw Error('Configuration changed. Re-run Preflight before deploying.');
  const report=await preflight(data.config);
  const p=report.p;
  if(data.confirm!==p.target)throw Error('Type the exact contract address to approve.');
  if(p.target!==previewRecord.target||signer.owner!==previewRecord.owner||current.hash!==previewRecord.hash)
    throw Error('Signer, contract or target changed. Re-run Preflight.');
  if(pendingTarget===p.target)throw Error('This target has a prior deployment attempt this session. Inspect receipts before doing anything else.');
  const parent=BrowserWindow.fromWebContents(event.sender);
  if(!parent)throw Error('Cannot display native Windows confirmation.');
  const selection=await dialog.showMessageBox(parent,{title:'Nearium Forge · Sign Testnet Deployment',type:'warning',
    buttons:['Cancel','Deploy Contract'],defaultId:0,cancelId:0,noLink:true,
    message:(report.upgrade?'Replace code on ':'Deploy to ')+p.target+'?',
    detail:'NETWORK: NEAR TESTNET\nWASM SHA-256: '+p.wasmHash+
      '\nACTIONS:\n'+report.actions.map(x=>'  • '+x).join('\n')+
      '\n\nPrivate signing stays on this computer. Failed transactions may create or leave a funded account. Do not retry blindly.'});
  if(selection.response!==1)return {cancelled:true};
  // Explicitly recheck after UI approval. No transaction sent yet.
  const fresh=await preflight(data.config);
  if(fresh.p.target!==p.target)throw Error('Target changed after approval.');
  const {actions}=await api();
  const list=actionsFor(actions,current.bytes,p,signer.publicKey);
  previewRecord=null;
  attempted=true;
  pendingTarget=p.target;
  // retries=0 is vital for create-account transactions, no automatic resubmission.
  const tx=await signer.account.signAndSendTransaction({
    receiverId:p.target,actions:list,retries:0,waitUntil:'FINAL',throwOnFailure:false
  });
  const txHash=tx?.transaction?.hash||tx?.transaction_outcome?.id||null;
  const account=await queryAccount(p.target);
  const keys=await rpc('query',{request_type:'view_access_key_list',finality:'final',account_id:p.target});
  const {baseEncode}=await api();
  const expected=baseEncode(createHash('sha256').update(current.bytes).digest());
  const hashMatches=account?.code_hash===expected;
  const keyCount=keys?.keys?.length??null;
  const keyValid=p.mode==='existing'||p.keyMode==='keyless'?p.mode==='existing'||keyCount===0:keyCount===1;
  const failed=Boolean(tx?.status?.Failure);
  // Successful status doesn't prove contract initialization is semantically correct.
  const verified=Boolean(!failed&&hashMatches&&keyValid);
  return {cancelled:false,target:p.target,txHash,codeHash:account?.code_hash||null,
   expectedCodeHash:expected,hashMatches,keyCount,verified,failed,
   warning:verified?'Code hash and access-key checks passed. Review any initialization receipts separately.':
   'Execution or post-deployment checks need review. Do not retry without investigating receipts.'};
 }catch(e){
  if(attempted)throw Error('Submission/verification is uncertain: '+safeError(e)+'. Check testnet explorer BEFORE another attempt.');
  throw e;
 }finally{working=false;previewRecord=null}
}
async function inspectContract(value){
 await network();
 const id=accountId(value);
 const state=await queryAccount(id);
 if(!state)return {account:id,exists:false};
 const keys=await rpc('query',{request_type:'view_access_key_list',finality:'final',account_id:id});
 const apiInstance=await api();
 const expected=current?apiInstance.baseEncode(createHash('sha256').update(current.bytes).digest()):null;
 return {account:id,exists:true,codeHash:state.code_hash,keys:keys.keys?.length??null,
  balance:fmt(BigInt(state.amount)),storageUsage:state.storage_usage,
  expectedCodeHash:expected,matchesImported:expected?state.code_hash===expected:null};
}
async function saveContract(data){
 if(!current)throw Error('Import or compile a WASM first.');
 if(working)throw Error('Deployment in progress.');
 const x=await library.save({name:data?.name||current.name,preset:data?.preset||{},wasmBytes:current.bytes,deployment:data?.deployment||null});
 return x;
}
async function selectSaved(id){
 if(working)throw Error('Deployment in progress.');
 const {entry,bytes}=await library.load(id);
 current={bytes,name:entry.name,hash:entry.sha256,source:'Saved in local library'};
 invalidate();return {entry,contract:contractMetadata()};
}
function register(){
 bind('network',network);
 bind('inspect',inspectContract);
 bind('open-wasm',openWasm);
 bind('compile-rust',compileRust);
 bind('compiler-status',compilerStatus);
 bind('compiler-setup',setupCompiler);
 bind('project-open',chooseProject);
 bind('source-open',openSource);
 bind('source-save',saveSource);
 bind('node-status',nodeStatus);
 bind('node-setup',nodeSetup);
 bind('js-install',jsInstallDependencies);
 bind('js-build',jsBuild);
 bind('artifact',contractMetadata);
 bind('import-key',importKey);
 bind('key-file',importKeyFile);
 bind('disconnect',async()=>{if(working)throw Error('Deployment running.');signer=null;invalidate();return {cleared:true}});
 bind('preflight',check);
 bind('deploy',deploy);
 bind('library-list',()=>library.list());
 bind('library-save',saveContract);
 bind('library-load',selectSaved);
 bind('library-delete',async id=>{if(working)throw Error('Deployment in progress.');return library.delete(id)});
}
app.whenReady().then(async()=>{
 library=new Library(app.getPath('userData'));await library.init();register();
 session.defaultSession.setPermissionRequestHandler((_web,permission,done)=>done(false));
 session.defaultSession.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_request,done)=>done({cancel:true}));
 const win=new BrowserWindow({width:1190,height:880,minWidth:870,minHeight:680,backgroundColor:'#070e17',
   icon:path.join(__dirname,'assets','nearium-forge-logo.png'),
   show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,
     contextIsolation:true,nodeIntegration:false,webSecurity:true}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',e=>e.preventDefault());
 win.removeMenu();win.once('ready-to-show',()=>win.show());await win.loadFile(path.join(__dirname,'index.html'));
}).catch(error=>{dialog.showErrorBox('Nearium Forge startup failed',safeError(error));app.quit()});
app.on('window-all-closed',()=>{signer=null;current=null;app.quit()});
