'use strict';
const {app,BrowserWindow,ipcMain,dialog,session,shell}=require('electron');
const {readFile,stat,rm}=require('node:fs/promises');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {Library}=require('./library.cjs');
const {DeploymentJournal,TX}=require('./deployment-journal.cjs');
const sourceEditor=require('./source-editor.cjs');
// Metadata parser only. Native Windows Node/npm compiler IPC remains disabled.
const jsToolchain=require('./js-toolchain.cjs');
const isolatedBuilder=require('./isolated-builder.cjs');
const reproducibleBuilder=require('./reproducible-builder.cjs');
const compilerManager=require('./compiler-manager.cjs');
const {YOCTO,networkConfig,accountId,fmt,wasm,sha,plan,actionsFor,displayActions}=require('./core.cjs');
const {verifyDeployment}=require('./deployment-verification.cjs');
const upgradeSafety=require('./upgrade-safety.cjs');

let activeNetwork='testnet',switchingNetwork=false,networkOperations=0;
const networkOperationNames=new Set(['network','inspect','import-key','key-file','preflight','deploy','upgrade-context','upgrade-prepare','recovery-reconcile','recovery-attach','recovery-release']);
const EMPTY_CODE='11111111111111111111111111111111';
let current=null,signer=null,previewRecord=null,upgradeReview=null,working=false,library=null,journal=null,compilerSetupBusy=false,compilerBuildBusy=false,jsSetupBusy=false,jsBuildBusy=false,isolateBusy=false,editorProject=null,editorLoaded=null;
function invalidate(){previewRecord=null;upgradeReview=null;}
const result=(code,data)=>({ok:true,data});
function safeError(e){
 let message=typeof e?.message==='string'?e.message:'Unexpected error';
 return message.slice(0,450).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{70,110}/g,'[PRIVATE KEY REDACTED]');
}
function bind(name,handler){
 ipcMain.handle('forge:'+name,async(event,data)=>{
  let guarded=false;
  try{
   if(event.sender.getURL()!==require('node:url').pathToFileURL(path.join(__dirname,'index.html')).toString())
    throw Error('Untrusted application window.');
   if(networkOperationNames.has(name)){
    if(switchingNetwork)throw Error('Network change in progress. Try again after it finishes.');
    networkOperations++;guarded=true;
   }
   return {ok:true,data:await handler(data,event)};
  }catch(e){return {ok:false,error:safeError(e)}}
  finally{if(guarded)networkOperations--;}
 });
}
async function api(){return import('near-api-js');}
async function rpc(method,params,selected=activeNetwork){
 const chain=networkConfig(selected);
 const res=await fetch(chain.rpc,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},
   signal:AbortSignal.timeout(30000),body:JSON.stringify({jsonrpc:'2.0',id:'nearium-forge',method,params})});
 if(!res.ok)throw Error(chain.label+' RPC HTTP '+res.status);
 const json=await res.json();
 if(json.error){const error=Error(json.error?.message||'NEAR RPC error');
   error.rpcName=json.error?.cause?.name||json.error?.name;throw error;}
 return json.result;
}
async function network(selected=activeNetwork){
 const chain=networkConfig(selected);
 const s=await rpc('status',[],selected);
 if(s?.chain_id!==chain.id)throw Error('RPC chain mismatch. Refusing to connect to an unexpected network.');
 return {network:chain.id,blockHeight:s.sync_info?.latest_block_height??null,rpc:chain.rpc};
}
async function selectNetwork(requested){
 const chain=networkConfig(requested);
 if(working||networkOperations||switchingNetwork||compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy||isolateBusy)
  throw Error('Finish the current operation before switching blockchain networks.');
 switchingNetwork=true;
 try{
  const checked=await network(chain.id);
  if(chain.id!==activeNetwork){
   signer=null;invalidate();activeNetwork=chain.id;
   // Attempted targets remain blocked for this session even across network changes.
  }
  return {...checked,signerDisconnected:true};
 }finally{switchingNetwork=false;}
}
async function queryAccount(id){
 try{return await rpc('query',{request_type:'view_account',finality:'final',account_id:id});}
 catch(e){if(e.rpcName==='UNKNOWN_ACCOUNT')return null;throw e;}
}
async function price(){
 const p=await rpc('EXPERIMENTAL_protocol_config',{finality:'final'});
 if(p.chain_id!==activeNetwork)throw Error('Protocol config returned the wrong network.');
 const n=p.runtime_config?.storage_amount_per_byte;
 if(!n||!/^\\d+$/.test(String(n)))throw Error('Network storage price unavailable.');
 return BigInt(n);
}
async function importKey({owner,secret}){
 if(compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy||isolateBusy)throw Error('Compiler active. Disconnect signer until compilation is complete.');
 if(working)throw Error('Deployment in progress. Do not change the signer.');
 owner=accountId(owner,activeNetwork);
 if(typeof secret!=='string'||secret.length>512||!/^ed25519:[1-9A-HJ-NP-Za-km-z]{70,110}$/.test(secret.trim()))
  throw Error('Use an exported FullAccess ed25519 private key for the selected network. Never enter a seed phrase.');
 const {Account,JsonRpcProvider,KeyPairSigner}=await api();
 const key=KeyPairSigner.fromSecretKey(secret.trim());
 const publicKey=await key.getPublicKey();
 await network();
 const auth=await rpc('query',{request_type:'view_access_key',finality:'final',account_id:owner,public_key:publicKey.toString()});
 if(auth.permission!=='FullAccess')throw Error('This key is not a FullAccess key on that '+activeNetwork+' account.');
 const state=await queryAccount(owner);
 signer={owner,network:activeNetwork,publicKey,account:new Account(owner,new JsonRpcProvider({url:networkConfig(activeNetwork).rpc}),key)};
 invalidate();
 return {owner,network:activeNetwork,publicKey:publicKey.toString(),balance:fmt(BigInt(state?.amount||'0'))};
}
async function importKeyFile(owner){
 if(compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy||isolateBusy)throw Error('Compiler active.');
 if(working)throw Error('Deployment in progress.');
 accountId(owner,activeNetwork);
 const choice=await dialog.showOpenDialog({title:'Select a '+activeNetwork+' NEAR key file',properties:['openFile'],
   filters:[{name:'NEAR credentials',extensions:['json','txt']}]});
 if(choice.canceled)return {cancelled:true};
 const filename=choice.filePaths[0];
 if((await stat(filename)).size>4096)throw Error('Key file exceeds 4 KB.');
 const text=(await readFile(filename,'utf8')).trim();
 let key=text;
 if(text.startsWith('{')){
  const obj=JSON.parse(text);
  if(obj.account_id&&obj.account_id!==owner)throw Error('Credential file account does not match.');
   if((obj.network_id||obj.network)&&(obj.network_id||obj.network)!==activeNetwork)throw Error('Credential file network does not match the selected network.');
  key=obj.private_key||obj.secret_key;
 }
 return importKey({owner,secret:key});
}
async function openWasm(){
 if(compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy||isolateBusy)throw Error('Compiler is active.');
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
 return {name:current.name,bytes:current.bytes.length,hash:current.hash,source:current.source,provenance:current.provenance||null};
}
// v0.7: Native Windows compiler setup and project execution are intentionally absent.
// Host compilation is not a fallback if Docker is unavailable.
async function selectCompiledWasm(candidates,parent,origin){
 if(!Array.isArray(candidates)||!candidates.length)throw Error('No newly generated contract WASM was found.');
 if(!parent)throw Error('Native contract selection unavailable.');
 let selected=candidates[0];
 if(candidates.length>1){
  const pick=await dialog.showOpenDialog(parent,{title:'Select the correct newly compiled NEAR WASM',
   defaultPath:selected.file,properties:['openFile'],filters:[{name:'NEAR WebAssembly',extensions:['wasm']}]});
  if(pick.canceled)return {cancelled:true};
  selected=candidates.find(x=>path.resolve(x.file)===path.resolve(pick.filePaths[0]));
  if(!selected)throw Error('Only fresh WASM files from this completed build can be selected.');
 }
 const first=wasm(await readFile(selected.file));
 const firstHash=sha(first);
 const choice=await dialog.showMessageBox(parent,{title:'Review Compiled Contract Artifact',type:'warning',
  buttons:['Cancel','Use This WASM'],defaultId:0,cancelId:0,noLink:true,
  message:'Select '+path.basename(selected.file)+' for deployment?',
  detail:'CONTRACT FILE: '+(selected.name||selected.file)+
   '\nSHA-256: '+firstHash+
   '\nBYTES: '+first.length+
   '\nBUILD: '+(origin?.mode||'local')+
   '\nPROJECT: '+(origin?.project||'not recorded')+
   '\n\nThis only loads the WASM. It does not deploy or sign any transaction.'});
 if(choice.response!==1)return {cancelled:true};
 const fresh=wasm(await readFile(selected.file));
 if(sha(fresh)!==firstHash)throw Error('WASM changed during artifact review. Rebuild and select again.');
 current={bytes:fresh,name:path.basename(selected.file),hash:firstHash,
  source:['isolated','reproducible'].includes(origin?.mode)?(origin.project+' / '+(selected.name||path.basename(selected.file))):selected.file,
  provenance:{mode:origin?.mode||'local',kind:origin?.kind||'unknown',project:origin?.project||null,
   sourceSha256:origin?.sourceSha256||null,image:origin?.image||null,script:origin?.script||null,
    gitCommit:origin?.gitCommit||null}};
 invalidate();return {contract:contractMetadata()};
}
// Source compilation is ONLY available through isolatedBuild, never via native cargo.
function ensureEditorIdle(){
 if(working||compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy||isolateBusy)
  throw Error('A compiler or deployment operation is in progress.');
}
async function chooseProject(){
 ensureEditorIdle();
 const selected=await dialog.showOpenDialog({title:'Open a Rust, JavaScript, or TypeScript contract project',properties:['openDirectory']});
 if(selected.canceled)return {cancelled:true};
 const project=await sourceEditor.openProject(selected.filePaths[0]);
 const config=project.kind==='javascript'?await jsToolchain.projectInfo(project):null;
 editorProject=project;editorLoaded=null;current=null;invalidate();
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
 if(!result.unchanged){current=null;invalidate();}
 return {file:result.file,hash:result.hash,unchanged:result.unchanged,backupCreated:Boolean(result.backup),artifactInvalidated:!result.unchanged};
}
// Native Node.js dependency installation and npm build scripts are disabled.
// The Docker builder installs dependencies within its container and builds offline.
async function isolatedStatus(){return isolatedBuilder.dockerStatus();}
async function reproducibleStatus(){return reproducibleBuilder.status(app.getPath('userData'));}
async function setupReproducible(_data,event){
 if(working||compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy||isolateBusy)
  throw Error('Finish the current operation before setting up production build tools.');
 if(signer)throw Error('Disconnect the Mainnet/Testnet signer before installing production build tools.');
 const parent=BrowserWindow.fromWebContents(event.sender);
 if(!parent)throw Error('Native Windows confirmation unavailable.');
 // Block key connections and network changes during user approval as well as installation.
 compilerSetupBusy=true;
 try{
  const answer=await dialog.showMessageBox(parent,{
   title:'Install Official NEAR Production Build Orchestrator',type:'warning',
   buttons:['Cancel','Install Verified Tools'],defaultId:0,cancelId:0,noLink:true,
   message:'Install official Rust/Cargo and pinned cargo-near on Windows for reproducible Docker builds?',
   detail:'Forge uses official verified Rustup/Rust and cargo-near 0.22.0 packages. The Windows cargo-near CLI orchestrates Git and Docker; smart-contract compilation and project build scripts remain inside Docker. No native Windows project compilation is enabled. An internet connection and Git/Docker Desktop are needed.'});
  if(answer.response!==1)return {cancelled:true};
  return await compilerManager.setup(app.getPath('userData'),progress=>{
   if(!event.sender.isDestroyed())event.sender.send('forge:compiler-progress',progress);
  },{requireManaged:true});
 }finally{compilerSetupBusy=false;}
}
async function isolatedBuild(data,event){
 ensureEditorIdle();
 if(signer)throw Error('Disconnect the Mainnet/Testnet signer before any Docker build. Do not build while a signing key is loaded.');
 if(!editorProject)throw Error('Open a Rust or JS/TS source project first.');
 const kind=editorProject.kind,script=String(data?.script||'');
 const buildMode=data?.buildMode||'development';
 if(!['development','production'].includes(buildMode))throw Error('Select a supported build mode.');
 if(buildMode==='production'&&kind!=='rust')throw Error('Official cargo-near reproducible builds are available for Rust projects only.');
 // Set the guard BEFORE any async Docker query or approval dialog, to prevent
 // connecting a signer or starting a deployment during a build-start race.
 isolateBusy=true;let result=null;
 try{
  const ready=await isolatedBuilder.dockerStatus();
  if(!ready.ready)throw Error('ISOLATED BUILD REQUIRED: '+ready.reason+' No Windows native compilation fallback.');
  if(buildMode==='production'){
   const tools=await reproducibleStatus();
   if(!tools.ready)throw Error('Production toolchain is not ready: '+tools.reason);
  }
  const parent=BrowserWindow.fromWebContents(event.sender);
  if(!parent)throw Error('Native Windows approval unavailable.');
  const production=buildMode==='production';
  const warning=production?
   'OFFICIAL NEAR REPRODUCIBLE MODE: cargo-near runs on Windows only to orchestrate Git and Docker. It compiles the Git-committed Rust contract in its own Docker build. ALL changes must be committed, Cargo.lock tracked, and Cargo.toml must contain reproducible_build metadata including a pinned image digest. The build ignores unsaved source edits. Official cargo-near controls its Docker network and runtime options.':
   kind==='javascript'?
    'Dependencies are installed in disposable Docker Linux containers. Legacy near-sdk-js may execute install scripts. The compilation stage runs without container network access.':
    'RUST DEVELOPMENT MODE: Forge stages allowed source into a disposable Docker workspace, downloads Cargo.lock dependencies, then runs the official cargo-near non-reproducible-wasm build offline.';
  const choice=await dialog.showMessageBox(parent,{
   title:production?'Review Official NEAR Reproducible Build':'Review Isolated NEAR Development Build',type:'warning',
   buttons:['Cancel',production?'Build Committed Production WASM':'Build in Restricted Container'],
   defaultId:0,cancelId:0,noLink:true,
   message:production?'Run official cargo-near reproducible-wasm inside Docker?':'Build source in a restricted Docker Linux container?',
   detail:'PROJECT: '+editorProject.root+'\nLANGUAGE: '+kind+
    '\nMODE: '+(production?'PRODUCTION / GIT COMMIT':'DEVELOPMENT')+
    '\nCOMMAND: '+(production?'cargo near build reproducible-wasm':kind==='rust'?'cargo near build non-reproducible-wasm':script)+
    '\n\n'+warning+
    '\n\nNothing is deployed or signed. Docker isolation and official reproducible tooling do not independently audit contract security.'});
  if(choice.response!==1)return {cancelled:true};
  result=await isolatedBuilder.build(editorProject,app.getPath('userData'),{kind,script,buildMode,
   onLog:progress=>{if(!event.sender.isDestroyed())event.sender.send('forge:compiler-progress',progress);}});
  const picked=await selectCompiledWasm(result.files,parent,{
   mode:result.mode||'isolated',kind,project:editorProject.root,
   sourceSha256:result.staged.sourceSha256,image:result.image,script:result.script,
   gitCommit:result.gitCommit||null});
  return {...picked,log:(result.mode==='reproducible'?
   'Official cargo-near reproducible build from Git '+result.gitCommit+'. ':
   'Restricted Docker development build. ')+
   result.files.length+' newly built WASM artifact(s). Source fingerprint: '+result.staged.sourceSha256};
 }finally{
  if(result?.staged?.stage)await rm(result.staged.stage,{recursive:true,force:true}).catch(()=>{});
  isolateBusy=false;
 }
}
async function preflight(data){
 if(compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy||isolateBusy)throw Error('Compiler is active.');
 if(data?.network!==activeNetwork)throw Error('Deployment network differs from the active network. Reselect and run preflight.');
 await network();
 if(!current)throw Error('Import or compile a NEAR-compatible WASM contract first.');
 if(current.provenance?.sourceSha256){
  if(!editorProject||current.provenance.project!==editorProject.root)
   throw Error('The selected WASM no longer matches the current source project. Reopen and compile the intended project.');
  const snapshot=await isolatedBuilder.stageProject(editorProject,app.getPath('userData'));
  try{
   if(snapshot.sourceSha256!==current.provenance.sourceSha256)
    throw Error('Source files changed after the selected WASM was compiled. Recompile before deployment.');
  }finally{await rm(snapshot.stage,{recursive:true,force:true}).catch(()=>{});}
 }
 if(!signer)throw Error('Connect a FullAccess '+activeNetwork+' key locally.');
 if(signer.network!==activeNetwork)throw Error('Signer belongs to a different blockchain network.');
 const storageCost=await price();
 const p=plan(data,current.bytes,storageCost);
 if(signer.owner!==p.signer||p.network!==activeNetwork)throw Error('Signer or deployment network does not match.');
 if(p.mode==='existing'&&p.keyMode==='keyless')throw Error('Keyless is supported only for new child accounts.');
 const [target,owner]=await Promise.all([queryAccount(p.target),queryAccount(p.signer)]);
 if(!owner)throw Error('Signer account is missing on NEAR '+activeNetwork+'.');
 const auth=await rpc('query',{request_type:'view_access_key',finality:'final',account_id:p.signer,public_key:signer.publicKey.toString()});
 if(auth.permission!=='FullAccess')throw Error('The connected key no longer has full access.');
 await journal.assertClear(activeNetwork,p.target);
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
// Existing Mainnet code can be replaced only after a documented Testnet migration rehearsal
// and a verified, retained byte-for-byte copy of the previously deployed Mainnet WASM.
async function upgradeContext(data){
 if(working)throw Error('Finish the current operation before inspecting a Mainnet upgrade.');
 if(activeNetwork!=='mainnet')throw Error('Upgrade compatibility review is exclusive to Mainnet.');
 const details=await preflight({...data,replace:true});
 if(!details.upgrade||details.p.mode!=='existing')throw Error('Select an existing Mainnet contract that already has deployed code.');
 if(details.onchainHash===details.existingCodeHash)throw Error('The selected WASM is already installed; no upgrade is required.');
 return {network:'mainnet',target:details.p.target,oldCodeHash:details.existingCodeHash,
  newSha256:details.p.wasmHash,initMethod:details.p.init.method||null,
  notice:'A matching code hash does not prove stored-state compatibility. Rehearse on Testnet before approving Mainnet.'};
}
async function prepareUpgrade(data){
 if(working)throw Error('A transaction or upgrade review is running.');
 if(activeNetwork!=='mainnet')throw Error('Mainnet upgrade review requires Mainnet selection.');
 working=true;upgradeReview=null;previewRecord=null;
 try{
  const config=data?.config;
  const details=await preflight(config);
  if(details.p.mode!=='existing'||!details.upgrade||!details.existingCodeHash||details.existingCodeHash===EMPTY_CODE)
   throw Error('Upgrade review requires an existing Mainnet contract with deployed code.');
  if(details.onchainHash===details.existingCodeHash)throw Error('No code change detected. Select a different WASM.');
  if(JSON.stringify(config.upgradeEvidence)!==JSON.stringify(data.evidence))
   throw Error('Compatibility report changed between the form and signed deployment configuration.');
  const parsed=upgradeSafety.validateEvidence(data.evidence,{
   target:details.p.target,oldCodeHash:details.existingCodeHash,
   newSha:details.p.wasmHash,initMethod:details.p.init.method,
   initArgs:JSON.stringify(details.p.init.args)});
  const {baseEncode}=await api();
  // Fetch bytes from the ACTUAL Mainnet account, not a user-selected local file.
  const raw=await rpc('query',{request_type:'view_code',finality:'final',account_id:details.p.target},'mainnet');
  const bytes=upgradeSafety.decodeCodeResponse(raw,baseEncode);
  if(raw.hash!==details.existingCodeHash||baseEncode(createHash('sha256').update(bytes).digest())!==details.existingCodeHash)
   throw Error('Mainnet contract code changed during review. Restart the upgrade review.');
  const evidence={...parsed,oldSha:sha(bytes)};
  const tested=await upgradeSafety.verifyTestnetRehearsal(evidence,{rpc,baseEncode});
  // Repeat the Mainnet preflight after Testnet reads to detect external code replacement.
  const again=await preflight(config);
  if(again.existingCodeHash!==details.existingCodeHash||again.p.wasmHash!==details.p.wasmHash||again.p.target!==details.p.target)
   throw Error('Mainnet contract or selected WASM changed during review. Review aborted.');
  const report={
   reportType:'Nearium Forge Mainnet Upgrade Compatibility',
   mainnetTarget:details.p.target,oldCodeHash:details.existingCodeHash,
   oldSha256:sha(bytes),newSha256:details.p.wasmHash,
   network:'mainnet',initMethod:details.p.init.method||null,
   initArgs:details.p.init.args,
   reviewerStatements:parsed.report,testnetEvidence:tested,
   limitations:'Testnet receipt and view checks cannot prove that Mainnet stored state matches Testnet or that a downgrade will safely revert state. Human source/schema review is required.'
  };
  const archive=await upgradeSafety.retainRollback(app.getPath('userData'),{
   target:details.p.target,oldCodeHash:details.existingCodeHash,oldWasm:bytes,report});
  const token=randomUUID();
  upgradeReview={token,signature:JSON.stringify(config),oldCodeHash:details.existingCodeHash,
   newSha256:details.p.wasmHash,target:details.p.target,archive,tested,network:'mainnet'};
  return {approved:true,token,target:details.p.target,oldCodeHash:details.existingCodeHash,
   oldSha256:archive.oldSha256,newSha256:details.p.wasmHash,
   backupFolder:archive.folder,backupFile:archive.file,reportFile:archive.metadata,
   backupReportHash:archive.reportSha256,testnetEvidence:tested,
   warning:'Testnet proof and byte-for-byte backup confirmed. This does NOT automatically migrate Mainnet state or guarantee that rollback restores previous storage.'};
 }finally{working=false;}
}
async function requireUpgradeReview(config,details){
 if(activeNetwork!=='mainnet'||!details.upgrade)return null;
 if(!upgradeReview||upgradeReview.network!=='mainnet'||upgradeReview.signature!==JSON.stringify(config)||
   upgradeReview.target!==details.p.target||upgradeReview.oldCodeHash!==details.existingCodeHash||
   upgradeReview.newSha256!==details.p.wasmHash)
  throw Error('MAINNET UPGRADE BLOCKED: prepare a matching compatibility report, independently verified Testnet migration and retained rollback WASM before preflight.');
 await upgradeSafety.verifyArchive(upgradeReview.archive);
 return upgradeReview;
}
async function check(data){
 if(working)throw Error('Deployment is in progress.');
 const details=await preflight(data);
 const prepared=await requireUpgradeReview(data,details);
 const token=randomUUID();
 previewRecord={token,signature:JSON.stringify(data),hash:current.hash,owner:signer.owner,target:details.p.target,network:activeNetwork};
 return {token,network:activeNetwork,target:details.p.target,owner:details.p.signer,upgrade:details.upgrade,
   existingCodeHash:details.existingCodeHash,actions:details.actions,
   artifact:details.artifact,spendable:details.spendable,required:details.required,
   keyMode:details.p.keyMode,init:details.p.init.method||'none',
  upgradeToken:prepared?.token||null,
  rollbackFolder:prepared?.archive.folder||null,
  testnetProof:prepared?.tested.upgradeTx||null};
}
async function deploy(data,event){
 if(compilerSetupBusy||compilerBuildBusy||jsSetupBusy||jsBuildBusy||isolateBusy)throw Error('Compiler is active.');
 if(working)throw Error('Another deployment is running.');
 working=true;let attempted=false;
 try{
  if(!data?.ack)throw Error('Review and acknowledge deployment risks first.');
  if(data?.config?.network!==activeNetwork)throw Error('Active network changed. Run preflight again.');
  if(activeNetwork==='mainnet'&&(!data.ackMainnet||data.confirmNetwork!=='MAINNET'))
   throw Error('Mainnet requires the additional real-funds acknowledgment and exact MAINNET confirmation.');
  if(!previewRecord||data.token!==previewRecord.token||JSON.stringify(data.config)!==previewRecord.signature)
    throw Error('Configuration changed. Re-run Preflight before deploying.');
  const report=await preflight(data.config);
  const prepared=await requireUpgradeReview(data.config,report);
  if(prepared&&data.upgradeToken!==prepared.token)throw Error('Mainnet upgrade compatibility approval token does not match. Run Preflight again.');
  const p=report.p;
  if(report.upgrade&&!data.ackMigration)throw Error('Explicitly acknowledge stored-state migration risks before upgrading an existing contract.');
  if(data.confirm!==p.target)throw Error('Type the exact contract address to approve.');
  if(p.target!==previewRecord.target||signer.owner!==previewRecord.owner||current.hash!==previewRecord.hash||previewRecord.network!==activeNetwork||signer.network!==activeNetwork)
    throw Error('Signer, contract or target changed. Re-run Preflight.');
  await journal.assertClear(activeNetwork,p.target);
  const parent=BrowserWindow.fromWebContents(event.sender);
  if(!parent)throw Error('Cannot display native Windows confirmation.');
  const mainnet=activeNetwork==='mainnet';
  const selection=await dialog.showMessageBox(parent,{title:mainnet?'Nearium Forge · MAINNET REAL FUNDS':'Nearium Forge · Sign Testnet Deployment',type:'warning',
    buttons:['Cancel',mainnet?'DEPLOY ON MAINNET':'Deploy Contract'],defaultId:0,cancelId:0,noLink:true,
    message:(mainnet?'REAL NEAR / MAINNET: ':'')+(report.upgrade?'Replace code on ':'Deploy to ')+p.target+'?',
    detail:'NETWORK: '+networkConfig(activeNetwork).label.toUpperCase()+(mainnet?' — REAL FUNDS, IRREVERSIBLE TRANSACTION':'')+
      '\nRPC: '+networkConfig(activeNetwork).rpc+
      '\nPREVIOUS CODE HASH: '+(report.existingCodeHash||'none')+'\nNEW WASM SHA-256: '+p.wasmHash+
      '\nBUILD MODE: '+(current.provenance?.mode||'imported / unverified')+'\nSTORAGE MIGRATION: NOT AUTOMATIC'+
      (prepared?'\nROLLBACK WASM: '+prepared.archive.file+'\nTESTNET MIGRATION TX: '+prepared.tested.upgradeTx+'\nTESTNET STATE VIEW: '+prepared.tested.viewMethod:'')+
      '\nACTIONS:\n'+report.actions.map(x=>'  • '+x).join('\n')+
      '\n\nPrivate signing stays on this computer. Failed transactions may create or leave a funded account. Do not retry blindly.'});
  if(selection.response!==1)return {cancelled:true};
  // Explicitly recheck after UI approval. No transaction sent yet.
  const fresh=await preflight(data.config);
  await requireUpgradeReview(data.config,fresh);
  if(fresh.p.target!==p.target||fresh.p.network!==activeNetwork||fresh.existingCodeHash!==report.existingCodeHash)
   throw Error('Target, network or old code hash changed after approval.');
  const {actions,baseEncode}=await api();
  const expected=baseEncode(createHash('sha256').update(current.bytes).digest());
  const approvedPublicKey=signer.publicKey.toString();
  const list=actionsFor(actions,current.bytes,p,signer.publicKey);
  previewRecord=null;
  const entry=await journal.start({network:activeNetwork,target:p.target,signer:p.signer,
   publicKey:approvedPublicKey,mode:p.mode,keyMode:p.keyMode,initMethod:p.init.method,
   wasmSha256:p.wasmHash,expectedCodeHash:expected});
  attempted=true;
  // No automatic retries. Do not resubmit if a post-send read or receipt check fails.
  const tx=await signer.account.signAndSendTransaction({
    receiverId:p.target,actions:list,retries:0,waitUntil:'FINAL',throwOnFailure:false
  });
  const txHash=tx?.transaction?.hash||tx?.transaction_outcome?.id||null;
  if(txHash)await journal.rememberHash(entry,txHash);
  // Independently re-query the canonical transaction including all executed receipts.
  let finalized=null,transactionLookupError=null;
  if(!txHash)transactionLookupError='Submission did not return a transaction hash.';
  else{
   try{finalized=await rpc('tx',{tx_hash:txHash,sender_account_id:p.signer,wait_until:'FINAL'});}
   catch(e){transactionLookupError='Independent final transaction lookup failed: '+safeError(e);}
  }
  // Fail closed, but still attempt read-only state checks after an unsuccessful lookup.
  const [accountResult,keyResult]=await Promise.allSettled([
   queryAccount(p.target),
   rpc('query',{request_type:'view_access_key_list',finality:'final',account_id:p.target})
  ]);
  const account=accountResult.status==='fulfilled'?accountResult.value:null;
  const keys=keyResult.status==='fulfilled'?keyResult.value:null;
  const review=verifyDeployment({
   tx:finalized,txHash,signer:p.signer,target:p.target,publicKey:approvedPublicKey,
   mode:p.mode,keyMode:p.keyMode,initMethod:p.init.method,account,keys,
   expectedCodeHash:expected
  });
  if(transactionLookupError)review.reasons.unshift(transactionLookupError);
  if(tx?.status?.Failure)review.reasons.push('The original signed transaction response reported an execution failure.');
  if(accountResult.status==='rejected')review.reasons.push('On-chain account lookup failed: '+safeError(accountResult.reason));
  if(keyResult.status==='rejected')review.reasons.push('On-chain access-key lookup failed: '+safeError(keyResult.reason));
  const verified=review.verified&&review.reasons.length===0;
  if(verified)await journal.complete(entry,'verified-success');
  else if(finalized?.final_execution_status==='FINAL'&&finalized?.status?.Failure)
   await journal.note(entry,'finalized-failure','Finalized transaction failed. Partial side effects require manual on-chain inspection.');
  else await journal.note(entry,'finalized-unverified',review.reasons.join(' ').slice(0,750)||'Finality or action verification incomplete.');
  const warning=verified?
   (review.keyless?'Code and receipts verified. INTENTIONALLY KEYLESS: no owner has a normal access key.':
    'Code, finalized receipt outcomes and expected FullAccess owner key verified.'+
     (review.otherKeyCount?' '+review.otherKeyCount+' additional key(s) remain on the existing account.':'')+
     (p.init.method?' Initializer completed on chain; application state is not audited.':'')):
   'NOT VERIFIED: '+review.reasons.join(' ').slice(0,1000)+' Do not retry without inspecting the transaction and receipts.';
  return {cancelled:false,network:activeNetwork,target:p.target,txHash,codeHash:account?.code_hash||null,
   expectedCodeHash:expected,hashMatches:review.hashMatches,keyCount:review.keyCount,
   ownerKeyVerified:review.ownerKeyVerified,keyless:review.keyless,keyStatus:review.keyStatus,
   finalityVerified:review.finalityVerified,transactionVerified:review.transactionVerified,
   initializationVerified:review.initializationVerified,receiptCount:review.receiptCount,
   verified,failed:Boolean(finalized?.status?.Failure||tx?.status?.Failure),warning};
 }catch(e){
  if(attempted)throw Error('Submission/verification is uncertain: '+safeError(e)+'. A durable recovery record remains on disk. Open Transaction Recovery and inspect the blockchain BEFORE another attempt.');
  throw e;
 }finally{working=false;previewRecord=null}
}
async function inspectContract(value){
 await network();
 const id=accountId(value,activeNetwork);
 const state=await queryAccount(id);
 if(!state)return {account:id,network:activeNetwork,exists:false};
 const keys=await rpc('query',{request_type:'view_access_key_list',finality:'final',account_id:id});
 const apiInstance=await api();
 const expected=current?apiInstance.baseEncode(createHash('sha256').update(current.bytes).digest()):null;
 return {account:id,network:activeNetwork,exists:true,codeHash:state.code_hash,keys:keys.keys?.length??null,
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
 bind('set-network',selectNetwork);
 bind('inspect',inspectContract);
 bind('open-wasm',openWasm);
 // Disabled: 'compile-rust',compileRust (no native compilation IPC)
 bind('isolated-status',isolatedStatus);
 bind('reproducible-status',reproducibleStatus);
 bind('reproducible-setup',setupReproducible);
 bind('isolated-build',isolatedBuild);
 // Disabled: 'compiler-status',compilerStatus (no native compilation IPC)
 // Disabled: 'compiler-setup',setupCompiler (no native compilation IPC)
 bind('project-open',chooseProject);
 bind('source-open',openSource);
 bind('source-save',saveSource);
 // Disabled: 'node-status',nodeStatus (no native compilation IPC)
 // Disabled: 'node-setup',nodeSetup (no native compilation IPC)
 // Disabled: 'js-install',jsInstallDependencies (no native compilation IPC)
 // Disabled: 'js-build',jsBuild (no native compilation IPC)
 bind('artifact',contractMetadata);
 bind('import-key',importKey);
 bind('key-file',importKeyFile);
 bind('disconnect',async()=>{if(working)throw Error('Deployment running.');signer=null;invalidate();return {cleared:true}});
 bind('preflight',check);
 bind('upgrade-context',upgradeContext);
 bind('upgrade-prepare',prepareUpgrade);
 bind('deploy',deploy);
 bind('recovery-list',recoveryList);
 bind('recovery-reconcile',recoveryReconcile);
 bind('recovery-attach',recoveryAttachHash);
 bind('recovery-release',recoveryReleaseFailure);
 bind('library-list',()=>library.list());
 bind('library-save',saveContract);
 bind('library-load',selectSaved);
 bind('library-delete',async id=>{if(working)throw Error('Deployment in progress.');return library.delete(id)});
}
app.whenReady().then(async()=>{
 library=new Library(app.getPath('userData'));await library.init();
 journal=new DeploymentJournal(app.getPath('userData'));await journal.init();register();
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
