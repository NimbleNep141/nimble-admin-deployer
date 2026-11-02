'use strict';
const el=id=>document.getElementById(id);
let active='home',view='deploy',artifact=null,localSigner=null,review=null,working=false;
let saved=[],deletePending=null,submittedTarget=null,lastDeployment=null;
const names={deploy:'Deployment Studio',library:'My Contract Library',verify:'Verify On-chain',build:'Compile / Import'};
const descriptions={
 deploy:'A precision workflow from compiled bytecode to verified contract.',
 library:'Your NEAR contracts and presets, saved locally in a compact library.',
 verify:'Independent on-chain inspection of account code, keys and balance.',
 build:'Compile trusted Rust projects or import precompiled NEAR-compatible WASM.'
};
function setText(id,text){el(id).textContent=text;}
function display(id,show){el(id).hidden=!show;}
function notify(message,error=false){const n=el('notice');n.hidden=false;n.className='notice'+(error?' error':'');n.textContent=message;}
function setReview(message,kind=''){el('preflight-output').className='review-box '+kind;setText('preflight-output',message);}
function setResult(message,kind=''){el('deployment-result').className='result-box '+kind;setText('deployment-result',message);}
async function call(name,arg){
 const response=await window.forge[name](arg);
 if(!response||response.ok!==true)throw Error(response?.error||'Desktop operation failed.');
 return response.data;
}
function home(){
 active='home';display('home',true);display('studio',false);
}
function studio(tab='deploy'){
 active='studio';display('home',false);display('studio',true);showView(tab);
}
function showView(next){
 if(!names[next])return;
 view=next;
 for(const key of Object.keys(names))display('view-'+key,key===next);
 document.querySelectorAll('.nav-link').forEach(n=>n.classList.toggle('selected',n.dataset.view===next));
 setText('workspace-title',names[next]);setText('workspace-desc',descriptions[next]);setText('crumb-page',next.toUpperCase());
 if(next==='library')refreshLibrary();
 if(next==='build')refreshCompiler();
 if(next==='verify'&&!el('verify-address').value.trim())el('verify-address').value=targetId();
}
function targetId(){
 const owner=el('owner').value.trim(),prefix=el('prefix').value.trim(),mode=el('mode').value;
 if(!owner.endsWith('.testnet'))return '';
 return mode==='new'?prefix+'.'+owner:owner;
}
function modeUpdate(){
 const isNew=el('mode').value==='new';
 display('child-options',isNew);display('existing-options',!isNew);
 setText('target',targetId()||'Enter a valid owner.testnet account');
}
function config(){
 return {owner:el('owner').value.trim(),mode:el('mode').value,
  prefix:el('prefix').value.trim(),funding:el('funding').value.trim(),
  keyMode:el('key-mode').value,replace:el('replace-code').checked,
  initMethod:el('init-method').value.trim(),initArgs:el('init-args').value.trim(),
  gas:el('gas').value.trim(),initDeposit:el('init-deposit').value.trim()};
}
function invalidate(){
 review=null;
 setText('preflight-status','NOT CHECKED');el('preflight-status').className='status-dot neutral';
 setReview('Settings changed. Run Preflight again before attempting deployment.');
 updateDeploy();
}
function updateDeploy(){
 const exact=Boolean(review&&el('confirmation').value.trim()===review.target);
 const ack=el('ack').checked;
 const enabled=!working&&Boolean(review)&&exact&&ack;
 el('deploy').disabled=!enabled;
 const hint=working?'An operation is in progress. Do not submit again.':
   !artifact?'Import a contract WASM or compile a Rust project first.':
   !localSigner?'Connect a locally authorized testnet signing key first.':
   !review?'Run Preflight Check to verify target and build the transaction preview.':
   !exact?'Type the exact target address from the preflight results.':
   !ack?'Check the transaction review and acknowledgment box.':
   'Ready. The next step is a native Windows confirmation; Cancel is the default.';
 setText('deploy-hint',hint);
}
function busy(value){
 working=value;
 for(const id of ['wasm-import','rust-compile','wasm-import-build','rust-compile-build','key-connect','key-file','key-disconnect','preflight','save-current','saved-load','saved-delete','saved-refresh','saved-verify','verify-button','deploy'])el(id).disabled=value;
 if(!value)updateDeploy();
}
function artifactUpdate(meta){
 artifact=meta;lastDeployment=null;
 if(meta){
  setText('artifact-status','WASM VERIFIED');el('artifact-status').className='status-dot live';
  setText('mini-wasm',meta.name);setText('artifact-detail',meta.name+' · '+meta.bytes.toLocaleString('en-US')+' bytes\nSHA-256 '+meta.hash);
  setText('build-detail','Name: '+meta.name+'\nSize: '+meta.bytes.toLocaleString('en-US')+' bytes\nSHA-256: '+meta.hash+'\nSource: '+meta.source);
  if(!el('save-name').value.trim())el('save-name').value=meta.name.replace(/\.wasm$/i,'');
 }else{
  setText('mini-wasm','None selected');
  setText('artifact-status','NO WASM');el('artifact-status').className='status-dot neutral';
  setText('artifact-detail','No compiled WASM imported.');
  setText('build-detail','No WASM loaded.');
 }
 invalidate();
}
async function importWasm(){
 busy(true);notify('Opening local WASM selection. No key or code is uploaded.');
 try{
  const res=await call('openWasm');
  if(!res.cancelled){artifactUpdate(res);notify('Verified WebAssembly file imported: '+res.name);}
 }catch(e){notify(e.message,true)}finally{busy(false)}
}
let compilerBusy=false;
function compilerView(state){
 setText('rustup-state',state.rustup.installed?'Installed · '+state.rustup.detail:'Not installed');
 setText('rust-state',state.rust.installed?'Ready · '+state.rust.detail:'Not installed');
 setText('wasm-state',state.wasm.installed?'Installed':'Missing');
 setText('cargo-near-state',state.cargoNear.installed?'Ready · '+state.cargoNear.detail:'Not installed');
 el('compiler-ready').className='status-dot '+(state.ready?'live':'neutral');
 setText('compiler-ready',state.ready?'READY':'SETUP NEEDED');
}
async function refreshCompiler(){
 if(compilerBusy)return;
 try{compilerView(await call('compilerStatus'));}
 catch(e){setText('compiler-ready','CHECK FAILED');setText('compiler-log',e.message);}
}
async function setupCompilerUI(){
 if(compilerBusy)return;
 compilerBusy=true;busy(true);
 el('compiler-check').disabled=true;el('compiler-install').disabled=true;
 setText('compiler-stage','INSTALLING');
 setText('compiler-log','Preparing official compiler components. A native Windows approval will appear.');
 try{
  const result=await call('compilerSetup');
  if(result.cancelled)setText('compiler-log','Installation cancelled. No tool installations were started.');
  else{compilerView(result);setText('compiler-log','Compiler ready. Select a trusted Rust project to build its WASM.');notify('Compiler Manager setup completed.');}
 }catch(e){setText('compiler-log','Setup failed: '+e.message);notify('Compiler setup failed: '+e.message,true);}
 finally{
  compilerBusy=false;busy(false);
  el('compiler-check').disabled=false;el('compiler-install').disabled=false;
  await refreshCompiler();
 }
}
window.forge.onCompilerProgress(progress=>{
 if(!progress||typeof progress.message!=='string')return;
 setText('compiler-stage',String(progress.stage||'RUNNING').toUpperCase());
 setText('compiler-log',progress.message);
});
async function compileRust(){
 busy(true);notify('Choose a trusted Rust project. Cargo build scripts can run code on your PC. Never compile unknown projects.');
 try{
  const res=await call('compileRust');
  if(!res.cancelled){artifactUpdate(res.contract);notify('Rust contract compiled and imported.\n'+res.log.slice(-950));}
 }catch(e){notify('Compile failed: '+e.message,true)}finally{busy(false)}
}
async function connectKey(useFile=false){
 const owner=el('owner').value.trim(),secret=el('secret').value;
 el('secret').value='';busy(true);
 try{
  const res=useFile?await call('keyFile',owner):await call('importKey',{owner,secret});
  if(res.cancelled)return;
  localSigner=res;
  setText('signer-status','KEY READY');el('signer-status').className='status-dot live';
  setText('mini-signer',res.owner);
  setText('signer-detail','Verified on-chain FullAccess testnet key · '+res.publicKey+'\nBalance: '+(res.balance||'check preflight')+' Ⓝ · This key is kept in session memory only.');
  notify('Local signer connected. No credentials are saved in the Forge library.');
  invalidate();
 }catch(e){notify('Could not connect signer: '+e.message,true)}
 finally{busy(false)}
}
async function disconnectKey(){
 busy(true);
 try{await call('disconnect');localSigner=null;
  setText('mini-signer','Not connected');setText('signer-status','DISCONNECTED');el('signer-status').className='status-dot neutral';
  setText('signer-detail','Signer disconnected. Close the app to end the session.');invalidate();notify('Local signing session disconnected.');
 }catch(e){notify(e.message,true)}finally{busy(false)}
}
async function doPreflight(){
 invalidate();busy(true);setReview('Checking on-chain account, storage price, signature permissions and deployment safety…');
 try{
  const report=await call('preflight',config());review=report;
  const txt=[
    'NETWORK                 NEAR Testnet',
    'TARGET                  '+report.target,
    'OWNER                   '+report.owner,
    'WASM                    '+report.artifact.name+' ('+report.artifact.bytes+' bytes)',
    'WASM SHA-256             '+report.artifact.hash,
    'AVAILABLE BALANCE       '+report.spendable+' NEAR',
    'REQUIRED + GAS RESERVE  '+report.required+' NEAR',
    'UPGRADE                 '+(report.upgrade?'YES, existing code will be replaced':'NO'),
    'ACCOUNT POLICY          '+report.keyMode,
    'ACTIONS\n  '+report.actions.join('\n  '),
    '\nPREFLIGHT PASSED. A transaction has NOT been signed or sent.'
  ].join('\n');
  setReview(txt,'good');
  setText('preflight-status','READY');el('preflight-status').className='status-dot live';
  setText('target',report.target);setText('pipeline-hint','Preflight passed. Review and confirm the exact account.');
  notify('Preflight passed. Check every action before deploying.');
 }catch(e){
  setReview('PREFLIGHT BLOCKED\n'+e.message+'\nNo transaction was submitted.','error');
  setText('preflight-status','BLOCKED');el('preflight-status').className='status-dot error';
  notify(e.message,true);
 }finally{busy(false);updateDeploy()}
}
async function doDeploy(){
 if(!review){setResult('Run Preflight first.','error');return;}
 if(!el('ack').checked||el('confirmation').value.trim()!==review.target){setResult('Type the exact account address and acknowledge the risks.','error');return;}
 if(submittedTarget===review.target){setResult('This target already had a deployment attempt in this session. Verify blockchain receipts before retrying.','error');return;}
 busy(true);
 setResult('Opening native Windows confirmation. Nothing is signed or sent until you choose Deploy Contract.');
 try{
  const report=await call('deploy',{config:config(),token:review.token,confirm:el('confirmation').value.trim(),ack:true});
  if(report.cancelled){setResult('Cancelled by user. No transaction was submitted.');notify('Deployment cancelled.');return;}
  submittedTarget=report.target;
  lastDeployment={address:report.target,txHash:report.txHash,verified:report.verified};
  setResult('TARGET          '+report.target+
    '\nTX HASH         '+(report.txHash||'unavailable')+
    '\nSTATUS          '+(report.verified?'DEPLOYED · CODE HASH VERIFIED':'NEEDS INVESTIGATION')+
    '\nON-CHAIN HASH   '+(report.codeHash||'unknown')+
    '\nEXPECTED HASH   '+report.expectedCodeHash+
    '\nACCESS KEYS     '+String(report.keyCount??'unknown')+
    '\n'+report.warning,report.verified?'good':'error');
  setText('verify-address',report.target);
  notify(report.verified?'Contract deployed. On-chain WASM hash verified.':'A transaction was attempted but not fully verified. Inspect receipts and do not retry.',!report.verified);
 }catch(e){setResult('DEPLOYMENT DID NOT CONFIRM\n'+e.message+'\nNever retry without verifying account and receipts on NEAR Testnet.','error');notify(e.message,true)}
 finally{review=null;el('ack').checked=false;el('confirmation').value='';busy(false);updateDeploy()}
}
async function refreshLibrary(){
 try{
  saved=await call('list');
  const box=el('saved-select'),previous=box.value;
  while(box.options.length>1)box.remove(1);
  for(const item of saved){const option=document.createElement('option');option.value=item.id;option.textContent=item.name+' · '+item.bytes.toLocaleString('en-US')+' B';box.add(option);}
  if(saved.some(x=>x.id===previous))box.value=previous;
  setText('library-count',saved.length+' SAVED');
  savedUpdate();
 }catch(e){notify('Could not read contract library: '+e.message,true)}
}
function savedUpdate(){
 const entry=saved.find(x=>x.id===el('saved-select').value);
 if(entry)setText('saved-detail',entry.name+'\nSHA-256 '+entry.sha256+'\n'+entry.bytes+' bytes · Added '+entry.created+(entry.deployment?'\nDeployed: '+entry.deployment.address+'\nTransaction: '+(entry.deployment.txHash||'not recorded'):''));
 else setText('saved-detail','Select a saved contract to view its WASM hash and deployment preset.');
 el('saved-load').disabled=!entry;el('saved-delete').disabled=!entry;el('saved-verify').disabled=!entry?.deployment?.address;
 deletePending=null;setText('saved-delete','Remove from Library');
}
async function saveCurrent(){
 busy(true);
 try{
  const item=await call('save',{name:el('save-name').value.trim(),preset:config(),deployment:lastDeployment});
  notify('Saved '+item.name+' to your local contract library. No signing keys were saved.');
  await refreshLibrary();el('saved-select').value=item.id;savedUpdate();showView('library');
 }catch(e){notify('Save failed: '+e.message,true)}finally{busy(false)}
}
function usePreset(p){
 const values={mode:p.mode||'new',prefix:p.prefix||'contract',funding:p.funding||'6',
  'key-mode':p.keyMode||'controlled','init-method':p.initMethod||'','init-args':p.initArgs||'{}',
  gas:p.gas||'30','init-deposit':p.initDeposit||'0'};
 for(const [id,val]of Object.entries(values))el(id).value=val;
 el('replace-code').checked=false;
 el('keyless-warning').hidden=el('key-mode').value!=='keyless';
 modeUpdate();
}
async function loadSaved(){
 const id=el('saved-select').value;if(!id)return;busy(true);
 try{
  const x=await call('load',id);artifactUpdate(x.contract);usePreset(x.entry.preset);
  el('save-name').value=x.entry.name;showView('deploy');notify('Loaded '+x.entry.name+' with saved deployment settings. Run preflight before deployment.');
 }catch(e){notify('Cannot load saved contract: '+e.message,true)}finally{busy(false)}
}
async function deleteSaved(){
 const id=el('saved-select').value;if(!id)return;
 if(deletePending!==id){deletePending=id;setText('saved-delete','Confirm removal');setText('library-remove-warning','Click Confirm removal again to remove this library entry. On-chain contracts and shared WASM files are not deleted.');return;}
 busy(true);
 try{await call('delete',id);deletePending=null;await refreshLibrary();notify('Removed saved contract entry. This did not delete any blockchain account.')}
 catch(e){notify(e.message,true)}finally{busy(false)}
}
async function verify(){
 const id=el('verify-address').value.trim();
 busy(true);setText('verify-output','Inspecting account directly on NEAR Testnet…');
 try{
  const o=await call('inspect',id);
  const message=!o.exists?'Account does not exist on NEAR Testnet: '+o.account:
    'CONTRACT ADDRESS      '+o.account+
    '\nNETWORK               NEAR Testnet'+
    '\nCODE HASH             '+o.codeHash+
    '\nACCESS KEYS           '+o.keys+
    '\nACCOUNT BALANCE       '+o.balance+' NEAR'+
    '\nSTORAGE BYTES         '+o.storageUsage+
    (o.expectedCodeHash?'\nIMPORTED WASM HASH    '+o.expectedCodeHash+
      '\nCODE HASH MATCH       '+(o.matchesImported?'YES ✓':'NO ✕'):'\nImport a WASM to compare its code hash.');
  el('verify-output').className='review-box spacious '+(o.exists?'good':'error');
  setText('verify-output',message);
 }catch(e){el('verify-output').className='review-box spacious error';setText('verify-output',e.message)}finally{busy(false)}
}
function wire(id,action){el(id).addEventListener('click',action)}
wire('enter-studio',()=>studio('deploy'));wire('open-library-home',()=>studio('library'));wire('back-home',home);
document.querySelectorAll('.nav-link').forEach(n=>n.addEventListener('click',()=>showView(n.dataset.view)));
for(const id of ['wasm-import','wasm-import-build'])wire(id,importWasm);
for(const id of ['rust-compile','rust-compile-build'])wire(id,compileRust);
wire('toggle-secret',()=>{el('secret').type=el('secret').type==='password'?'text':'password'});
wire('key-connect',()=>connectKey(false));wire('key-file',()=>connectKey(true));wire('key-disconnect',disconnectKey);
wire('compiler-check',refreshCompiler);wire('compiler-install',setupCompilerUI);
wire('preflight',doPreflight);wire('deploy',doDeploy);wire('save-current',saveCurrent);
wire('saved-load',loadSaved);wire('saved-delete',deleteSaved);wire('saved-refresh',refreshLibrary);wire('verify-button',verify);
wire('saved-verify',()=>{const entry=saved.find(x=>x.id===el('saved-select').value);if(!entry?.deployment?.address)return;
 el('verify-address').value=entry.deployment.address;showView('verify');verify();});
el('saved-select').addEventListener('change',savedUpdate);
const inputs=['owner','mode','prefix','funding','key-mode','replace-code','init-method','init-args','gas','init-deposit'];
for(const id of inputs){
 for(const event of ['input','change'])el(id).addEventListener(event,()=>{
  if(id==='mode')modeUpdate();
  if(id==='owner'||id==='prefix')setText('target',targetId()||'Enter a valid signer account');
  if(id==='key-mode')display('keyless-warning',el('key-mode').value==='keyless');
  invalidate();
 });
}
for(const id of ['confirmation','ack']){
 for(const event of ['input','change'])el(id).addEventListener(event,updateDeploy);
}
async function initialize(){
 modeUpdate();updateDeploy();
 try{
  const n=await call('network');
  setText('network-status','Connected · '+n.network.toUpperCase()+(n.blockHeight?' · Block '+n.blockHeight:''));
 }catch(e){setText('network-status','Testnet unavailable');notify('Network check failed: '+e.message,true)}
 await refreshLibrary();
}
initialize();
