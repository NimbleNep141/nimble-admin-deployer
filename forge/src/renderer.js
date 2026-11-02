'use strict';
const el=id=>document.getElementById(id);
let active='home',view='deploy',artifact=null,localSigner=null,review=null,working=false,selectedNetwork='testnet';
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
 if(next==='build'){refreshCompiler();refreshNodeStatus();refreshIsolationStatus();}
 if(next==='verify'&&!el('verify-address').value.trim())el('verify-address').value=targetId();
}
function targetId(){
 const owner=el('owner').value.trim(),prefix=el('prefix').value.trim(),mode=el('mode').value;
 if(!owner.endsWith(selectedNetwork==='mainnet'?'.near':'.testnet'))return '';
 return mode==='new'?prefix+'.'+owner:owner;
}
function modeUpdate(){
 const isNew=el('mode').value==='new';
 display('child-options',isNew);display('existing-options',!isNew);
 setText('target',targetId()||'Enter a valid '+selectedNetwork+' account');
}
function config(){
 return {network:selectedNetwork,owner:el('owner').value.trim(),mode:el('mode').value,
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
 const migrationReady=!review?.upgrade||el('upgrade-ack').checked;
 const mainnetReady=selectedNetwork!=='mainnet'||(el('mainnet-ack').checked&&el('mainnet-word').value.trim()==='MAINNET');
 const enabled=!working&&Boolean(review)&&review.network===selectedNetwork&&exact&&ack&&migrationReady&&mainnetReady;
 el('deploy').disabled=!enabled;
 const hint=working?'An operation is in progress. Do not submit again.':
   !artifact?'Import a contract WASM or compile a Rust project first.':
   !localSigner?'Connect a locally authorized '+selectedNetwork+' signing key first.':
   !review?'Run Preflight Check to verify target and build the transaction preview.':
   !exact?'Type the exact target address from the preflight results.':
   !ack?'Check the transaction review and acknowledgment box.':
   !migrationReady?'Review and acknowledge state migration risks before replacing this contract.':
    !mainnetReady?'Check real-funds approval and type MAINNET exactly.':
   'Ready. The next step is a native Windows confirmation; Cancel is the default.';
 setText('deploy-hint',hint);
}
function busy(value){
 working=value;
 for(const id of ['wasm-import','rust-compile','wasm-import-build','rust-compile-build','key-connect','key-file','key-disconnect','preflight','save-current','saved-load','saved-delete','saved-refresh','saved-verify','verify-button','deploy','isolated-build','isolated-check','upgrade-start','network-select'])el(id).disabled=value;
 if(!value){el('upgrade-start').disabled=!artifact||sourceDirty;updateDeploy();}
}
function artifactUpdate(meta){
 artifact=meta;lastDeployment=null;
 if(meta){
  setText('artifact-status','WASM VERIFIED');el('artifact-status').className='status-dot live';
  setText('mini-wasm',meta.name);setText('artifact-detail',meta.name+' · '+meta.bytes.toLocaleString('en-US')+' bytes\nSHA-256 '+meta.hash);
  setText('build-detail','Name: '+meta.name+'\nSize: '+meta.bytes.toLocaleString('en-US')+' bytes\nSHA-256: '+meta.hash+'\nSource: '+meta.source+'\nBUILD MODE: '+(meta.provenance?.mode||'imported / unverified')+'\nSOURCE FINGERPRINT: '+(meta.provenance?.sourceSha256||'not recorded'));
  if(!el('save-name').value.trim())el('save-name').value=meta.name.replace(/\.wasm$/i,'');
 }else{
  setText('mini-wasm','None selected');
  setText('artifact-status','NO WASM');el('artifact-status').className='status-dot neutral';
  setText('artifact-detail','No compiled WASM imported.');
  setText('build-detail','No WASM loaded.');
 }
 el('upgrade-start').disabled=!meta;
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
 if(progress.stage==='node'||progress.stage==='javascript')setText('js-log',progress.message);
 if(progress.stage==='isolated')setText('isolated-log',progress.message);
});

let sourceProject=null,sourceFile=null,sourceDirty=false,jsUIBusy=false;
function setSourceDirty(changed){
 sourceDirty=Boolean(changed);
 setText('source-dirty',!sourceFile?'NO FILE':sourceDirty?'UNSAVED CHANGES':'SAVED');
 setText('source-status',sourceProject?(sourceDirty?'UNSAVED':'LOCAL PROJECT'):'NO PROJECT');
 el('source-save').disabled=!sourceDirty;
 el('upgrade-start').disabled=sourceDirty||!artifact;
}
function selectOptions(select,items){
 select.replaceChildren();
 for(const item of items){
  const option=document.createElement('option');
  option.value=item.value;option.textContent=item.label;
  select.appendChild(option);
 }
}
function fillProject(project){
 sourceProject=project;sourceFile=null;artifactUpdate(null);setSourceDirty(false);
 el('source-code').value='';el('source-code').disabled=true;
 setText('source-project-path',project.root+' · '+(project.kind==='rust'?'RUST':'JAVASCRIPT / TYPESCRIPT'));
 selectOptions(el('source-file'),project.files.map(f=>({value:f,label:f})));
 if(project.files.length===0)selectOptions(el('source-file'),[{value:'',label:'No editable source files found'}]);
 const config=project.config;
 if(project.kind==='javascript'&&config){
  setText('js-dependency-state',config.hasModules?'node_modules present':'Not installed');
  setText('js-script-state',config.legacySdk?'near-sdk-js needs Linux/WSL':config.scripts.length?config.scripts.map(x=>x.name).join(', '):'No build script');
  if(config.legacySdk)setText('js-log','This project depends on deprecated near-sdk-js, whose official compiler is not supported on native Windows. Build in an isolated WSL/Linux environment and import the WASM, or use a Rust contract instead.');
  selectOptions(el('js-build-script'),config.scripts.length?config.scripts.map(x=>({value:x.name,label:x.name+' · '+x.command.slice(0,55)})):[{value:'',label:'No supported contract build script'}]);
 }else{
  setText('js-dependency-state','Open a JS/TS project');
  setText('js-script-state','Open a JS/TS project');
  selectOptions(el('js-build-script'),[{value:'',label:'Open a JS/TS project first'}]);
 }
}
async function openSourceFile(file){
 if(sourceDirty){el('source-file').value=sourceFile?.file||'';notify('Save or discard your unsaved changes before switching files.',true);return;}
 if(!file)return;
 try{
  const loaded=await call('sourceOpen',file);
  sourceFile=loaded;el('source-file').value=loaded.file;
  el('source-code').value=loaded.text;el('source-code').disabled=false;
  setSourceDirty(false);
 }catch(e){notify('Cannot open source: '+e.message,true);}
}
async function openProjectUI(){
 if(sourceDirty){notify('Save or discard your changes before opening another project.',true);return;}
 try{
  const project=await call('projectOpen');
  if(project.cancelled)return;
  fillProject(project);
  if(project.files.length)await openSourceFile(project.files[0]);
  notify('Local '+project.kind+' project opened. Source files remain on your PC.');
 }catch(e){notify('Project selection failed: '+e.message,true);}
}
async function saveSourceUI(){
 if(!sourceFile||!sourceDirty)return;
 try{
  const value=el('source-code').value;
  const result=await call('sourceSave',{file:sourceFile.file,text:value});
  if(result.cancelled)return;
  sourceFile={...sourceFile,text:value,hash:result.hash};
  if(result.artifactInvalidated)artifactUpdate(null);
  setSourceDirty(el('source-code').value!==value);
  notify(result.unchanged?'No source changes detected.':'Source saved; older WASM cleared. Recompile before deployment.');
 }catch(e){notify('Save failed: '+e.message,true);}
}
async function discardSourceUI(){
 if(!sourceFile)return;
 sourceDirty=false;
 await openSourceFile(sourceFile.file);
 notify('Source code reloaded from the saved file.');
}
async function refreshNodeStatus(){
 try{
  const state=await call('nodeStatus');
  setText('node-state',state.ready?'Ready · '+state.version:'Missing · '+state.version);
  setText('js-status',state.ready?'NODE READY':'NODE SETUP');
 }catch(e){
  setText('node-state','Unavailable');
  setText('js-status','NODE ERROR');
  setText('js-log',e.message);
 }
}
async function jsAction(action,label,arg=null){
 if(jsUIBusy)return;
 if(sourceDirty){notify('Save or discard source changes before running JavaScript project tools.',true);return;}
 jsUIBusy=true;busy(true);
 for(const id of ['node-install','js-dependencies','js-compile'])el(id).disabled=true;
 setText('js-log',label+' ...');
 try{
  const res=await call(action,arg);
  if(res.cancelled){setText('js-log','Operation cancelled.');return;}
  if(res.contract){
   artifactUpdate(res.contract);
   setText('js-log','Compiled and imported '+res.contract.name+' from the local JavaScript/TypeScript project.');
   notify('JS/TS WASM compiled and imported. Review its hash before deployment.');
  }else{
   setText('js-log',(res.description||res.log||'Operation completed.').slice(-1400));
   notify(label+' completed.');
  }
  await refreshNodeStatus();
 }catch(e){setText('js-log',e.message);notify(label+' failed: '+e.message,true);}
 finally{
  jsUIBusy=false;busy(false);
  for(const id of ['node-install','js-dependencies','js-compile'])el(id).disabled=false;
 }
}

async function refreshIsolationStatus(){
 try{
  const state=await call('isolatedStatus');
  el('isolation-status').className='status-dot '+(state.ready?'live':'neutral');
  setText('isolation-status',state.ready?'DOCKER READY':'DOCKER NEEDED');
  setText('isolated-log',state.reason);
 }catch(e){setText('isolation-status','CHECK FAILED');setText('isolated-log',e.message);}
}
async function runIsolatedBuild(){
 if(!sourceProject){notify('Open a local source project first.',true);return;}
 if(sourceDirty){notify('Save or discard source changes before building.',true);return;}
 busy(true);setText('isolated-log','Preparing restricted Docker build. Windows approval will appear.');
 try{
  const result=await call('isolatedBuild',{script:el('js-build-script').value});
  if(result.cancelled){setText('isolated-log','Isolated build cancelled. No artifact was imported.');return;}
  if(result.contract){
   artifactUpdate(result.contract);
   setText('isolated-log',result.log||'Isolated build completed. Contract imported.');
   notify('Compiled WASM selected and verified. Review its hash and proceed to preflight before any deployment.');
  }
 }catch(e){setText('isolated-log',e.message);notify('Isolated build failed: '+e.message,true);}
 finally{busy(false);}
}
function startUpgradeReview(){
 const target=el('upgrade-target').value.trim();
 if(!new RegExp('^[a-z0-9]+(?:[._-][a-z0-9]+)*\\.'+(selectedNetwork==='mainnet'?'near':'testnet')+'$').test(target)){notify('Enter the exact '+selectedNetwork+' contract account.',true);return;}
 if(!artifact){notify('Compile or import a WASM before reviewing an upgrade.',true);return;}
 if(sourceDirty){notify('Save source edits and recompile before reviewing an upgrade.',true);return;}
 el('owner').value=target;
 el('mode').value='existing';el('replace-code').checked=false;
 el('init-method').value='';el('init-args').value='{}';el('init-deposit').value='0';
 el('ack').checked=false;el('upgrade-ack').checked=false;display('upgrade-ack-row',false);
 el('confirmation').value='';modeUpdate();invalidate();showView('deploy');
 notify('Review the target account, compare the old on-chain code hash with the selected WASM, check upgrade acknowledgments, and run preflight. No transaction has been sent.');
}
async function compileRust(){
 if(sourceDirty){notify('Save or discard source changes before compiling Rust. The unsaved editor buffer is not part of a build.',true);return;}
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
  setText('signer-detail','Verified on-chain FullAccess '+selectedNetwork+' key · '+res.publicKey+'\nBalance: '+(res.balance||'check preflight')+' Ⓝ · This key is kept in session memory only.');
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
    'NETWORK                 NEAR '+report.network.toUpperCase(),
    'TARGET                  '+report.target,
    'OWNER                   '+report.owner,
    'WASM                    '+report.artifact.name+' ('+report.artifact.bytes+' bytes)',
    'WASM SHA-256             '+report.artifact.hash,
    'AVAILABLE BALANCE       '+report.spendable+' NEAR',
    'REQUIRED + GAS RESERVE  '+report.required+' NEAR',
    'UPGRADE                 '+(report.upgrade?'YES, existing code will be replaced':'NO')+(report.upgrade?'\nPREVIOUS CODE HASH      '+(report.existingCodeHash||'unavailable')+'\nSOURCE FINGERPRINT      '+(report.artifact?.provenance?.sourceSha256||'not recorded')+'\nSTORAGE MIGRATION       NOT AUTOMATIC':''),
    'ACCOUNT POLICY          '+report.keyMode,
    'ACTIONS\n  '+report.actions.join('\n  '),
    '\nPREFLIGHT PASSED. A transaction has NOT been signed or sent.'
  ].join('\n');
  display('upgrade-ack-row',Boolean(report.upgrade));el('upgrade-ack').checked=false;
  setReview(txt,'good');
  setText('preflight-status','READY');el('preflight-status').className='status-dot live';
  setText('target',report.target);setText('pipeline-hint','Preflight passed. Review and confirm the exact account.');
  notify('Preflight passed. Check every action before deploying.');
 }catch(e){
  display('upgrade-ack-row',false);
  setReview('PREFLIGHT BLOCKED\n'+e.message+'\nNo transaction was submitted.','error');
  setText('preflight-status','BLOCKED');el('preflight-status').className='status-dot error';
  notify(e.message,true);
 }finally{busy(false);updateDeploy()}
}
async function doDeploy(){
 if(!review){setResult('Run Preflight first.','error');return;}
 if(!el('ack').checked||el('confirmation').value.trim()!==review.target){setResult('Type the exact account address and acknowledge the risks.','error');return;}
 if(submittedTarget===selectedNetwork+':'+review.target){setResult('This target already had a deployment attempt in this session. Verify blockchain receipts before retrying.','error');return;}
 busy(true);
 setResult('Opening native Windows confirmation. Nothing is signed or sent until you choose Deploy Contract.');
 try{
  const report=await call('deploy',{config:config(),token:review.token,confirm:el('confirmation').value.trim(),ack:true,ackMigration:el('upgrade-ack').checked,ackMainnet:el('mainnet-ack').checked,confirmNetwork:el('mainnet-word').value.trim()});
  if(report.cancelled){setResult('Cancelled by user. No transaction was submitted.');notify('Deployment cancelled.');return;}
  submittedTarget=report.network+':'+report.target;
  lastDeployment={network:report.network,address:report.target,txHash:report.txHash,verified:report.verified};
  setResult('TARGET          '+report.target+
    '\nTX HASH         '+(report.txHash||'unavailable')+
    '\nSTATUS          '+(report.verified?'DEPLOYED · CODE HASH VERIFIED':'NEEDS INVESTIGATION')+
    '\nON-CHAIN HASH   '+(report.codeHash||'unknown')+
    '\nEXPECTED HASH   '+report.expectedCodeHash+
    '\nACCESS KEYS     '+String(report.keyCount??'unknown')+
    '\n'+report.warning,report.verified?'good':'error');
  setText('verify-address',report.target);
  notify(report.verified?'Contract deployed. On-chain WASM hash verified.':'A transaction was attempted but not fully verified. Inspect receipts and do not retry.',!report.verified);
 }catch(e){setResult('DEPLOYMENT DID NOT CONFIRM\n'+e.message+'\nNever retry without verifying account and receipts on NEAR '+selectedNetwork+'.','error');notify(e.message,true)}
 finally{review=null;el('ack').checked=false;el('upgrade-ack').checked=false;display('upgrade-ack-row',false);el('confirmation').value='';el('mainnet-ack').checked=false;el('mainnet-word').value='';busy(false);updateDeploy()}
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
 if(entry)setText('saved-detail',entry.name+'\nSHA-256 '+entry.sha256+'\n'+entry.bytes+' bytes · '+(entry.preset?.network||'testnet').toUpperCase()+' · Added '+entry.created+(entry.deployment?'\nDeployed: '+entry.deployment.address+'\nTransaction: '+(entry.deployment.txHash||'not recorded'):''));
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
 if((p.network||'testnet')!==selectedNetwork){notify('Saved preset uses '+(p.network||'testnet')+'. Switch to that network first.',true);return false;}
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
  const x=await call('load',id);artifactUpdate(x.contract);if(usePreset(x.entry.preset)===false){el('owner').value='';showView('deploy');return;}
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
 busy(true);setText('verify-output','Inspecting account directly on NEAR '+selectedNetwork+'…');
 try{
  const o=await call('inspect',id);
  const message=!o.exists?'Account does not exist on NEAR '+o.network+': '+o.account:
    'CONTRACT ADDRESS      '+o.account+
    '\nNETWORK               NEAR '+o.network.toUpperCase()+
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
function paintNetwork(status=null){
 const mainnet=selectedNetwork==='mainnet',label=mainnet?'Mainnet':'Testnet',suffix=mainnet?'.near':'.testnet';
 el('network-select').value=selectedNetwork;
 document.body.classList.toggle('mainnet-active',mainnet);
 display('mainnet-warning',mainnet);display('mainnet-gate',mainnet);
 setText('env-label','● NEAR '+selectedNetwork.toUpperCase());
 setText('mini-network','NEAR '+label);
 setText('pipeline-network',mainnet?'MAINNET · REAL NEAR':'TESTNET MODE');
 setText('owner-label',label+' account address');
 setText('secret-label','Full-access '+label+' private key (session only)');
 el('owner').placeholder='youraccount'+suffix;
 el('verify-address').placeholder='contract.youraccount'+suffix;
 el('upgrade-target').placeholder='contract.youraccount'+suffix;
 setText('preflight-network-label',label);
 setText('network-status',status?'Connected · '+selectedNetwork.toUpperCase()+(status.blockHeight?' · Block '+status.blockHeight:''):'Selected: '+label);
 modeUpdate();updateDeploy();
}
async function changeNetwork(){
 const requested=el('network-select').value;
 busy(true);
 try{
  const state=await call('setNetwork',requested);
  selectedNetwork=state.network;
  localSigner=null;lastDeployment=null;
  for(const id of ['owner','secret','confirmation','verify-address','upgrade-target','mainnet-word'])el(id).value='';
  el('mainnet-ack').checked=false;el('ack').checked=false;el('upgrade-ack').checked=false;el('replace-code').checked=false;
  display('upgrade-ack-row',false);
  setText('mini-signer','Not connected');setText('signer-status','DISCONNECTED');el('signer-status').className='status-dot neutral';
  setText('signer-detail','Network changed. Import a FullAccess '+selectedNetwork+' key. Never use recovery phrases.');
  setResult('Network switched. No transaction was submitted. New account, signer and preflight approval are required.');
  setText('verify-output','Select an account on the active network to inspect.');
  invalidate();paintNetwork(state);
  notify('Network selected: '+selectedNetwork.toUpperCase()+'. Signing key disconnected. '+(selectedNetwork==='mainnet'?'CAUTION: real funds are at risk.':'Test NEAR only.'));
 }catch(e){paintNetwork();notify('Cannot switch network: '+e.message,true)}
 finally{busy(false)}
}
function wire(id,action){el(id).addEventListener('click',action)}
wire('enter-studio',()=>studio('deploy'));wire('open-library-home',()=>studio('library'));wire('back-home',home);
document.querySelectorAll('.nav-link').forEach(n=>n.addEventListener('click',()=>showView(n.dataset.view)));
for(const id of ['wasm-import','wasm-import-build'])wire(id,importWasm);
for(const id of ['rust-compile','rust-compile-build'])wire(id,compileRust);
wire('toggle-secret',()=>{el('secret').type=el('secret').type==='password'?'text':'password'});
wire('key-connect',()=>connectKey(false));wire('key-file',()=>connectKey(true));wire('key-disconnect',disconnectKey);
wire('compiler-check',refreshCompiler);wire('compiler-install',setupCompilerUI);
wire('isolated-check',refreshIsolationStatus);wire('isolated-build',runIsolatedBuild);wire('upgrade-start',startUpgradeReview);
wire('node-check',refreshNodeStatus);
wire('node-install',()=>jsAction('nodeSetup','Managed Node.js installation'));
wire('js-dependencies',()=>jsAction('jsInstall','Project dependency setup'));
wire('js-compile',()=>jsAction('jsBuild','JS/TS compilation',{script:el('js-build-script').value}));
wire('source-project',openProjectUI);wire('source-save',saveSourceUI);wire('source-reload',discardSourceUI);
el('source-file').addEventListener('change',()=>openSourceFile(el('source-file').value));
el('source-code').addEventListener('input',()=>setSourceDirty(Boolean(sourceFile&&el('source-code').value!==sourceFile.text)));
wire('preflight',doPreflight);wire('deploy',doDeploy);wire('save-current',saveCurrent);
wire('saved-load',loadSaved);wire('saved-delete',deleteSaved);wire('saved-refresh',refreshLibrary);wire('verify-button',verify);
 el('network-select').addEventListener('change',changeNetwork);
wire('saved-verify',()=>{const entry=saved.find(x=>x.id===el('saved-select').value);if(!entry?.deployment?.address)return;
 if((entry.deployment.network||'testnet')!==selectedNetwork){notify('Saved deployment is on '+(entry.deployment.network||'testnet')+'. Switch networks before verifying.',true);return;}
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
for(const id of ['confirmation','ack','upgrade-ack','mainnet-ack','mainnet-word']){
 for(const event of ['input','change'])el(id).addEventListener(event,updateDeploy);
}
async function initialize(){
 modeUpdate();paintNetwork();updateDeploy();
 try{
  const n=await call('network');selectedNetwork=n.network;paintNetwork(n);
 }catch(e){setText('network-status',selectedNetwork+' unavailable');notify('Network check failed: '+e.message,true)}
 await refreshLibrary();
}
initialize();
