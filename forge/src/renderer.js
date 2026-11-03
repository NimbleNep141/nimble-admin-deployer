'use strict';
const el=id=>document.getElementById(id);
let active='home',view='deploy',artifact=null,localSigner=null,review=null,working=false,selectedNetwork='testnet';
let saved=[],deletePending=null,lastDeployment=null;
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
 if(next==='deploy')refreshRecovery();
 if(next==='build'){refreshCompiler();refreshNodeStatus();refreshIsolationStatus();refreshReproducibleStatus();}
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
 display('mainnet-upgrade-review',!isNew&&selectedNetwork==='mainnet');
 setText('target',targetId()||'Enter a valid '+selectedNetwork+' account');
}
function upgradeEvidence(){
 return {approvedTarget:el('upgrade-approved-target').value.trim(),
  approvedOldHash:el('upgrade-approved-old').value.trim(),approvedNewSha:el('upgrade-approved-new').value.trim(),
  stateSchema:el('upgrade-state-schema').value.trim(),migrationPlan:el('upgrade-migration-plan').value.trim(),
  rollbackPlan:el('upgrade-rollback-plan').value.trim(),testCoverage:el('upgrade-test-coverage').value.trim(),
  testnetAccount:el('upgrade-testnet-account').value.trim(),baselineTx:el('upgrade-baseline-tx').value.trim(),
  upgradeTx:el('upgrade-testnet-tx').value.trim(),viewMethod:el('upgrade-view-method').value.trim(),
  viewArgs:el('upgrade-view-args').value.trim(),expectedView:el('upgrade-expected-view').value.trim(),
  ackCompatible:el('upgrade-compatible').checked,ackRollback:el('upgrade-rollback-ack').checked,
  ackNotGuaranteed:el('upgrade-risk-ack').checked};
}
function config(){
 return {network:selectedNetwork,owner:el('owner').value.trim(),mode:el('mode').value,
  prefix:el('prefix').value.trim(),funding:el('funding').value.trim(),
  keyMode:el('key-mode').value,replace:el('replace-code').checked,
  initMethod:el('init-method').value.trim(),initArgs:el('init-args').value.trim(),
  gas:el('gas').value.trim(),initDeposit:el('init-deposit').value.trim(),
  upgradeEvidence:selectedNetwork==='mainnet'&&el('mode').value==='existing'?upgradeEvidence():null};
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
 const upgradePrepared=selectedNetwork!=='mainnet'||!review?.upgrade||Boolean(review.upgradeToken&&review.rollbackFolder&&review.testnetProof);
 const enabled=!working&&Boolean(review)&&review.network===selectedNetwork&&exact&&ack&&migrationReady&&mainnetReady&&upgradePrepared;
 el('deploy').disabled=!enabled;
 const hint=working?'An operation is in progress. Do not submit again.':
   !artifact?'Import a contract WASM or compile a Rust project first.':
   !localSigner?'Connect a locally authorized '+selectedNetwork+' signing key first.':
   !review?'Run Preflight Check to verify target and build the transaction preview.':
   !exact?'Type the exact target address from the preflight results.':
   !ack?'Check the transaction review and acknowledgment box.':
   !migrationReady?'Review and acknowledge state migration risks before replacing this contract.':
    !upgradePrepared?'Mainnet upgrade is BLOCKED. Complete Testnet rehearsal and preserve the old WASM first.':
    !mainnetReady?'Check real-funds approval and type MAINNET exactly.':
   'Ready. The next step is a native Windows confirmation; Cancel is the default.';
 setText('deploy-hint',hint);
}
function busy(value){
 working=value;
 for(const id of ['wasm-import','rust-compile','wasm-import-build','rust-compile-build','key-connect','key-file','key-disconnect','preflight','save-current','saved-load','saved-delete','saved-refresh','saved-verify','verify-button','deploy','isolated-build','isolated-check','reproducible-check','reproducible-install','upgrade-start','network-select','upgrade-inspect','upgrade-prepare','recovery-refresh','recovery-verify','recovery-cancel-prepared','recovery-review-failure'])el(id).disabled=value;
 if(!value){el('upgrade-start').disabled=!artifact||sourceDirty;updateDeploy();}
}
function artifactUpdate(meta){
 artifact=meta;lastDeployment=null;
 if(meta){
  setText('artifact-status','WASM VERIFIED');el('artifact-status').className='status-dot live';
  setText('mini-wasm',meta.name);setText('artifact-detail',meta.name+' · '+meta.bytes.toLocaleString('en-US')+' bytes\nSHA-256 '+meta.hash);
  setText('build-detail','Name: '+meta.name+'\nSize: '+meta.bytes.toLocaleString('en-US')+' bytes\nSHA-256: '+meta.hash+'\nSource: '+meta.source+'\nBUILD MODE: '+(meta.provenance?.mode||'imported / unverified')+'\nSOURCE FINGERPRINT: '+(meta.provenance?.sourceSha256||'not recorded')+'\nGIT COMMIT: '+(meta.provenance?.gitCommit||'development / imported'));
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
// The Windows host compiler has been removed. Docker is required and no fallback exists.
async function refreshCompiler(){
 await refreshIsolationStatus();
 const label=el('isolation-status').textContent;
 setText('compiler-ready',label);
 el('compiler-ready').className=el('isolation-status').className;
 setText('compiler-log','NEAR cargo-near development and production build modes both compile contracts in Docker. No Windows project compilation fallback.');
}
window.forge.onCompilerProgress(progress=>{
 if(!progress||typeof progress.message!=='string')return;
 setText('compiler-stage',String(progress.stage||'RUNNING').toUpperCase());
 setText('compiler-log',progress.message);
 if(progress.stage==='node'||progress.stage==='javascript')setText('js-log',progress.message);
 if(progress.stage==='isolated'||progress.stage==='reproducible')setText('isolated-log',progress.message);
 if(['reproducible','cargo-near','rustup','rust'].includes(progress.stage))setText('reproducible-log',progress.message);
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
 el('rust-build-mode').disabled=project.kind!=='rust';
 if(project.kind!=='rust')el('rust-build-mode').value='development';
 el('source-code').value='';el('source-code').disabled=true;
 setText('source-project-path',project.root+' · '+(project.kind==='rust'?'RUST':'JAVASCRIPT / TYPESCRIPT'));
 selectOptions(el('source-file'),project.files.map(f=>({value:f,label:f})));
 if(project.files.length===0)selectOptions(el('source-file'),[{value:'',label:'No editable source files found'}]);
 const config=project.config;
 if(project.kind==='javascript'&&config){
  setText('js-dependency-state',config.hasModules?'node_modules present':'Not installed');
  setText('js-script-state',config.legacySdk?'near-sdk-js needs Linux/WSL':config.scripts.length?config.scripts.map(x=>x.name).join(', '):'No build script');
  if(config.legacySdk)setText('js-log','This project depends on archived near-sdk-js. Docker Linux may support its build scripts, but production safety is not assured.');
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
 const ready=await call('isolatedStatus').catch(()=>({ready:false,reason:'Docker Desktop check failed.'}));
 setText('node-state',ready.ready?'Docker Node image · available on build':'Docker Desktop required');
 setText('js-status',ready.ready?'ISOLATED BUILD':'DOCKER NEEDED');
 setText('js-log',ready.ready?
   'JS/TS dependencies and npm build scripts run in a restricted Docker Linux container. No native Node.js install required.':
   'Docker-only security policy: '+ready.reason+' No Windows fallback is available.');
}
async function refreshIsolationStatus(){
 try{
  const state=await call('isolatedStatus');
  el('isolation-status').className='status-dot '+(state.ready?'live':'neutral');
  setText('isolation-status',state.ready?'DOCKER READY':'DOCKER NEEDED');
  setText('isolated-log',state.reason);
 }catch(e){setText('isolation-status','CHECK FAILED');setText('isolated-log',e.message);}
}
async function refreshReproducibleStatus(){
 try{
  const state=await call('reproducibleStatus');
  setText('reproducible-log',state.reason);
  el('reproducible-check').textContent=state.ready?'Official cargo-near Ready · Check Again':'Check Official cargo-near';
 }catch(e){setText('reproducible-log','Production toolchain check failed: '+e.message);}
}
async function setupReproducibleUI(){
 if(working)return;
 busy(true);
 setText('reproducible-log','Requesting Windows approval for verified official Rust/cargo-near build orchestration tools...');
 try{
  const result=await call('reproducibleSetup');
  if(result.cancelled){setText('reproducible-log','Production toolchain installation cancelled.');return;}
  setText('reproducible-log','Official cargo-near production tools installed. Your Git repository and Cargo.toml must be ready for reproducible-wasm.');
  notify('Verified official cargo-near build orchestrator is ready. Builds continue inside Docker.');
 }catch(e){setText('reproducible-log',e.message);notify('Production tooling installation failed: '+e.message,true);}
 finally{busy(false);await refreshReproducibleStatus();}
}
async function runIsolatedBuild(){
 if(!sourceProject){notify('Open a local Rust or JS/TS project first. Docker-only compilation has no Windows fallback.',true);return;}
 if(sourceDirty){notify('Save or discard source changes before building.',true);return;}
 busy(true);setText('isolated-log','Checking Docker Desktop and preparing restricted container build. Never use native fallback.');
 try{
  const result=await call('isolatedBuild',{script:el('js-build-script').value,
   buildMode:sourceProject.kind==='rust'?el('rust-build-mode').value:'development'});
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
 if(sourceDirty){notify('Save or discard source changes before building.',true);return;}
 if(!sourceProject||sourceProject.kind!=='rust'){
  await openProjectUI();
  if(!sourceProject||sourceProject.kind!=='rust'){
   notify('Select a Rust project containing Cargo.toml. Windows compilation is disabled.',true);
   return;
  }
 }
 await runIsolatedBuild();
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
async function inspectMainnetUpgrade(){
 busy(true);
 setText('upgrade-context-output','Checking existing Mainnet code hash against the selected WASM...');
 try{
  const data=await call('upgradeContext',config());
  setText('upgrade-context-output',
   'MAINNET TARGET     '+data.target+
   '\nPREVIOUS CODE HASH '+data.oldCodeHash+
   '\nNEW WASM SHA-256   '+data.newSha256+
   '\nMIGRATION METHOD  '+(data.initMethod||'None')+
   '\n\nCopy the exact hashes and target into the confirmation fields, then complete the required report and Testnet rehearsal proof.');
  notify('Mainnet old/new code hashes inspected. No blockchain transaction was submitted.');
 }catch(e){setText('upgrade-context-output','INSPECTION FAILED: '+e.message);notify(e.message,true)}
 finally{busy(false)}
}
async function prepareMainnetUpgrade(){
 invalidate();busy(true);
 setText('upgrade-report-output','Validating Mainnet old code, Testnet baseline and migration receipts, state assertion, and secure rollback archive...');
 try{
  const data=await call('upgradePrepare',{config:config(),evidence:upgradeEvidence()});
  setText('upgrade-report-output','UPGRADE COMPATIBILITY PACKAGE READY'+
   '\nMAINNET TARGET           '+data.target+
   '\nPREVIOUS MAINNET HASH    '+data.oldCodeHash+
   '\nOLD WASM SHA-256         '+data.oldSha256+
   '\nNEW WASM SHA-256         '+data.newSha256+
   '\nTESTNET BASELINE TX      '+data.testnetEvidence.baselineTx+
   '\nTESTNET MIGRATION TX     '+data.testnetEvidence.upgradeTx+
   '\nTESTNET BLOCK RANGE      '+data.testnetEvidence.oldHeight+' → '+data.testnetEvidence.newHeight+
   '\nTESTNET POST-UPGRADE VIEW '+data.testnetEvidence.viewMethod+
   '\nLOCAL ROLLBACK WASM      '+data.backupFile+
   '\nLOCAL REPORT             '+data.reportFile+
   '\nREPORT SHA-256           '+data.backupReportHash+
   '\n\nTESTNET EVIDENCE VALIDATED. You must now run Preflight again. Backup does NOT restore Mainnet persistent state.');
  notify('Compatibility report, independently verified Testnet rehearsal and old Mainnet WASM backup prepared. Run Preflight.');
 }catch(e){
  setText('upgrade-report-output','MAINNET UPGRADE BLOCKED\n'+e.message+'\nNo Mainnet transaction was signed.');
  notify('Mainnet upgrade evidence failed: '+e.message,true);
 }finally{busy(false)}
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
    'UPGRADE                 '+(report.upgrade?'YES, existing code will be replaced':'NO')+(report.upgrade?'\nPREVIOUS CODE HASH      '+(report.existingCodeHash||'unavailable')+'\nSOURCE FINGERPRINT      '+(report.artifact?.provenance?.sourceSha256||'not recorded')+'\nSTORAGE MIGRATION       NOT AUTOMATIC'+(report.rollbackFolder?'\nVERIFIED ROLLBACK WASM  '+report.rollbackFolder+'\nTESTNET MIGRATION TX    '+report.testnetProof+'\nCOMPATIBILITY REPORT    VERIFIED ON LOCAL DISK':''):''),
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
 busy(true);
 setResult('Opening native Windows confirmation. Nothing is signed or sent until you choose Deploy Contract.');
 try{
  const report=await call('deploy',{config:config(),token:review.token,confirm:el('confirmation').value.trim(),ack:true,ackMigration:el('upgrade-ack').checked,upgradeToken:review.upgradeToken,ackMainnet:el('mainnet-ack').checked,confirmNetwork:el('mainnet-word').value.trim()});
  if(report.cancelled){setResult('Cancelled by user. No transaction was submitted.');notify('Deployment cancelled.');return;}
  lastDeployment={network:report.network,address:report.target,txHash:report.txHash,verified:report.verified};
  const status=report.verified?
    (report.keyless?'CONFIRMED · INTENTIONALLY KEYLESS (NO OWNER KEY)':'CONFIRMED · OWNER KEY + RECEIPTS VERIFIED'):
    'NOT VERIFIED · INSPECT TRANSACTION & RECEIPTS';
  setResult('NETWORK          '+report.network.toUpperCase()+
    '\nTARGET           '+report.target+
    '\nTX HASH          '+(report.txHash||'unavailable')+
    '\nSTATUS           '+status+
    '\nFINALIZED        '+(report.finalityVerified?'YES':'NOT CONFIRMED')+
    '\nRECEIPTS         '+(report.transactionVerified?'ALL SUCCESSFUL':'NOT CONFIRMED')+
    '\nRECEIPT COUNT    '+String(report.receiptCount??'unknown')+
    '\nINITIALIZER      '+(report.initializationVerified===null?'NOT REQUESTED':report.initializationVerified?'SUCCEEDED':'NOT CONFIRMED')+
    '\nEXPECTED OWNER   '+(report.ownerKeyVerified?'FULLACCESS VERIFIED':report.keyless?'INTENTIONALLY KEYLESS':'NOT VERIFIED')+
    '\nACCESS KEYS      '+String(report.keyCount??'unknown')+
    '\nKEY DETAILS      '+(report.keyStatus||'not available')+
    '\nON-CHAIN HASH    '+(report.codeHash||'unknown')+
    '\nEXPECTED HASH    '+report.expectedCodeHash+
    '\n\n'+report.warning,report.verified?'good':'error');
  setText('verify-address',report.target);
  notify(report.verified?
    (report.keyless?'Contract code and receipts verified. This account has NO OWNER KEY.':'Expected FullAccess owner key, deployed code, and finalized receipts verified.'):
    'Transaction or ownership verification incomplete. Inspect receipts and do not retry automatically.',!report.verified);
 }catch(e){setResult('DEPLOYMENT DID NOT CONFIRM\n'+e.message+'\nNever retry without verifying account and receipts on NEAR '+selectedNetwork+'.','error');notify(e.message,true)}
 finally{await refreshRecovery();review=null;el('ack').checked=false;el('upgrade-ack').checked=false;display('upgrade-ack-row',false);el('confirmation').value='';el('mainnet-ack').checked=false;el('mainnet-word').value='';busy(false);updateDeploy()}
}
async function refreshRecovery(){
 try{
  const records=await call('recoveryList');
  const active=records.filter(r=>r.legacy||!r.resolution);
  const lines=active.map(r=>
    'NETWORK '+r.network.toUpperCase()+'\nTARGET '+r.target+
    '\nSTATUS '+(r.legacy?'LEGACY V0.8.2 · PRESERVE FOR REVIEW':
      r.phase==='broadcast-intent'?'BROADCAST OUTCOME UNCERTAIN':
      r.phase==='cancelled-prebroadcast'?'NEVER BROADCAST · ARCHIVE PENDING':'PREPARED / NO BROADCAST INTENT')+
    '\nEXACT TX '+(r.txHash||'UNKNOWN · legacy')+
    '\nCREATED '+(r.createdAt||'unknown')).join('\n\n');
  setText('recovery-output',lines||'No unresolved attempts on '+selectedNetwork.toUpperCase()+'.');
  if(active.length===1)el('recovery-target').value=active[0].target;
 }catch(e){setText('recovery-output','RECOVERY RECORD ERROR: '+e.message+
  '\nDo not attempt another deployment until protected evidence is reviewed.');}
}
async function reviewRecovery(method,intro){
 const target=el('recovery-target').value.trim()||targetId();
 const typedTarget=el('recovery-confirm-target').value.trim();
 busy(true);setText('recovery-output',intro);
 try{
  const result=await call(method,{target,typedTarget});
  if(result.cancelled){notify('Recovery review cancelled. No record released.');return;}
  if(result.resolved){el('recovery-confirm-target').value='';review=null;
   setText('recovery-output','RECOVERY ARCHIVED: '+result.kind+'\nTARGET '+result.target+
   '\n\nAny new deployment requires a fresh preflight and Windows confirmation.');
   notify('Reviewed recovery evidence archived. Immutable history preserved.');
  }else setText('recovery-output','Recovery remains protected: '+JSON.stringify(result));
 }catch(e){setText('recovery-output','RECOVERY BLOCKED: '+e.message+'\nNo transaction was retried or erased.');notify(e.message,true)}
 finally{busy(false)}
}
async function verifyRecovered(){
 const target=el('recovery-target').value.trim()||targetId();
 busy(true);setText('recovery-output','Independently checking exact signed transaction and final receipts...');
 try{
  const result=await call('recoveryVerify',{target});
  setText('recovery-output',(result.resolved?'VERIFIED / ARCHIVED':'UNRESOLVED / GUARDED')+
   '\nTARGET '+result.target+'\nTRANSACTION '+result.txHash+'\n'+(result.note||''));
  notify(result.resolved?'Independently verified. A new preflight is required.':
   'Unresolved. Guard retained; nothing retried.',!result.resolved);
 }catch(e){setText('recovery-output','VERIFICATION INCOMPLETE: '+e.message+
  '\nThe durable guard is unchanged.');notify(e.message,true)}
 finally{busy(false)}
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
  el('mode').value='new';el('key-mode').value='controlled';
  el('funding').value=selectedNetwork==='mainnet'?'1':'6';
  el('init-method').value='';el('init-args').value='{}';el('init-deposit').value='0';
  display('keyless-warning',false);
  display('upgrade-ack-row',false);
  setText('mini-signer','Not connected');setText('signer-status','DISCONNECTED');el('signer-status').className='status-dot neutral';
  setText('signer-detail','Network changed. Import a FullAccess '+selectedNetwork+' key. Never use recovery phrases.');
  setResult('Network switched. No transaction was submitted. New account, signer and preflight approval are required.');
  setText('upgrade-report-output','No upgrade compatibility report active on this network.');
  setText('upgrade-context-output','Select an existing Mainnet account and inspect old/new code hashes again.');
  setText('verify-output','Select an account on the active network to inspect.');
  invalidate();paintNetwork(state);
  await refreshRecovery();
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
wire('compiler-check',refreshCompiler);
wire('isolated-check',refreshIsolationStatus);wire('isolated-build',runIsolatedBuild);
 wire('reproducible-check',refreshReproducibleStatus);wire('reproducible-install',setupReproducibleUI);wire('upgrade-start',startUpgradeReview);
wire('upgrade-inspect',inspectMainnetUpgrade);wire('upgrade-prepare',prepareMainnetUpgrade);
wire('node-check',refreshNodeStatus);
wire('js-compile',async()=>{if(!sourceProject||sourceProject.kind!=='javascript'){notify('Open a JavaScript / TypeScript project first.',true);return;}await runIsolatedBuild();});
wire('source-project',openProjectUI);wire('source-save',saveSourceUI);wire('source-reload',discardSourceUI);
el('source-file').addEventListener('change',()=>openSourceFile(el('source-file').value));
el('source-code').addEventListener('input',()=>setSourceDirty(Boolean(sourceFile&&el('source-code').value!==sourceFile.text)));
wire('preflight',doPreflight);wire('deploy',doDeploy);wire('save-current',saveCurrent);
 wire('recovery-refresh',refreshRecovery);wire('recovery-verify',verifyRecovered);
 wire('recovery-cancel-prepared',()=>reviewRecovery('recoveryCancelPrepared','Checking exclusive pre-broadcast cancellation...'));
 wire('recovery-review-failure',()=>reviewRecovery('recoveryReviewFailure','Inspecting finalized failure receipts and account state...'));
wire('saved-load',loadSaved);wire('saved-delete',deleteSaved);wire('saved-refresh',refreshLibrary);wire('verify-button',verify);
 el('network-select').addEventListener('change',changeNetwork);
wire('saved-verify',()=>{const entry=saved.find(x=>x.id===el('saved-select').value);if(!entry?.deployment?.address)return;
 if((entry.deployment.network||'testnet')!==selectedNetwork){notify('Saved deployment is on '+(entry.deployment.network||'testnet')+'. Switch networks before verifying.',true);return;}
  el('verify-address').value=entry.deployment.address;showView('verify');verify();});
el('saved-select').addEventListener('change',savedUpdate);
const inputs=['owner','mode','prefix','funding','key-mode','replace-code','init-method','init-args','gas','init-deposit',
 'upgrade-approved-target','upgrade-approved-old','upgrade-approved-new','upgrade-state-schema','upgrade-migration-plan',
 'upgrade-rollback-plan','upgrade-test-coverage','upgrade-testnet-account','upgrade-baseline-tx','upgrade-testnet-tx',
 'upgrade-view-method','upgrade-view-args','upgrade-expected-view','upgrade-compatible','upgrade-rollback-ack','upgrade-risk-ack'];
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
 await refreshRecovery();
}
initialize();
