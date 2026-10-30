import './style.css';
import { setupWalletSelector, actionCreators } from '@near-wallet-selector/core';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import {
  RPC_URL, YOCTO, parseNear, formatNear, assertWasm, sha256, factoryIdFor,
  MAX_FACTORY_WASM, MAX_TEMPLATE_WASM, accountInfo, accessKeys, storagePrice, templateDeposit,
  view, createFactoryActions, installTemplateActions, launchActions, transactionHash, completedSuccessfully,
} from './core.js';

const el = id => document.getElementById(id);
const state = { selector:null,wallet:null,owner:null, factory:null, factoryInfo:null,
  factoryBytes:null, tokenBytes:null, manifest:null, artifactsTrusted:false, storagePrice:null,
  verifiedFactory:false, installed:false, checkedFactory:false, keys:[], busy:false };
const update = (id, text) => {el(id).textContent=String(text)};
function log(message,kind='info') {
  const line=document.createElement('div');
  line.className='log-'+kind;
  line.textContent=`[${new Date().toLocaleTimeString()}] ${message}`;
  el('logs').prepend(line);
}
function short(s) {return s.length>22?s.slice(0,14)+'…'+s.slice(-5):s}
function errMessage(e) {return typeof e?.message==='string'?e.message:String(e)}
function setBusy(b) {state.busy=b;render()}
function requireOwner() {if (!state.owner || !state.wallet) throw new Error('Connect your admin wallet first.');}
function requireArtifact(name) {
  if (!state.artifactsTrusted) throw new Error('Published build manifest and file hashes must be verified first. Uploading unsigned files does not authorize deployment.');
  if (name==='factory' && !state.factoryBytes) throw new Error('Missing factory WASM');
  if (name==='token' && !state.tokenBytes) throw new Error('Missing token WASM');
}
function render() {
  update('stat-wallet',state.owner?'Connected':'Disconnected');
  update('stat-owner',state.owner?short(state.owner):'No signer selected');
  update('wallet-account',state.owner??'Connect a wallet to begin');
  update('wallet-status',state.owner?'Connected':'Offline');
  el('disconnect').disabled=!state.owner||state.busy;
  el('connect').disabled=state.busy;
  let id=null;
  try {if(state.owner) id=factoryIdFor(state.owner,el('prefix').value.trim())}catch(e){update('factory-id',e.message)}
  if(id) update('factory-id',id);
  if(id!==state.factory) {state.factory=id;state.factoryInfo=null;state.verifiedFactory=false;state.installed=false;state.checkedFactory=false}
  update('stat-factory-id',state.factory??'Requires wallet');
  update('stat-factory',state.verifiedFactory?'Deployed':state.checkedFactory?'Not deployed':'Not checked');
  update('stat-template',state.installed?'Installed':state.checkedFactory?'Not installed':'Not checked');
  update('factory-status',state.verifiedFactory?'Verified':state.checkedFactory?'Available':'Not checked');
  update('template-status',state.installed?'Installed':state.verifiedFactory?'Ready':'Not checked');
  update('artifact-status',state.artifactsTrusted?'Hashes verified':'Not verified');
  el('check-factory').disabled=state.busy||!state.owner||!state.factory;
  el('deploy-factory').disabled=state.busy||!state.owner||!state.factory||!state.checkedFactory||state.verifiedFactory||!state.artifactsTrusted||!state.factoryBytes;
  el('check-template').disabled=state.busy||!state.verifiedFactory;
  el('install-template').disabled=state.busy||!state.owner||!state.verifiedFactory||state.installed||!state.artifactsTrusted||!state.tokenBytes||state.keys.length>0||state.factoryInfo?.owner!==state.owner||!state.storagePrice;
  el('launch-token').disabled=state.busy||!state.owner||!state.verifiedFactory||!state.installed;
  el('check-token').disabled=state.busy||!state.factory;
  if(state.storagePrice&&state.tokenBytes) update('template-deposit',`${formatNear(templateDeposit(state.tokenBytes.length,state.storagePrice),6)} testnet NEAR (estimated)`);
}
async function refreshAccount() {
  if (!state.wallet) return;
  const accounts=await state.wallet.getAccounts();
  state.owner=accounts[0]?.accountId??null;
  render();
}
async function initWallet() {
  state.selector=await setupWalletSelector({ network:'testnet',modules:[setupMyNearWallet()] });
  const existing=state.selector.store.getState().selectedWalletId;
  if(existing) {
    try {state.wallet=await state.selector.wallet(existing);await refreshAccount();}catch(e){log('Wallet session could not be restored: '+errMessage(e),'error')}
  }
  state.selector.store.observable.subscribe(async () => {
    if(state.wallet) try{await refreshAccount()}catch{}
  });
  log('Wallet connector loaded. Chain locked to NEAR testnet.');
}
async function connectWallet() {
  if(!state.selector) throw new Error('Wallet connector not ready; check your browser console.');
  state.wallet=await state.selector.wallet('my-near-wallet');
  const accounts=await state.wallet.getAccounts();
  if(!accounts.length){
    log('Opening MyNearWallet. Approve connection and return to this page.');
    await state.wallet.signIn({contractId:'social.testnet'});
  }
  await refreshAccount();
  if(state.owner) log('Wallet connected: '+state.owner,'ok');
}
async function loadManifest() {
  const base=new URL('./artifacts/',document.baseURI);
  const resp=await fetch(new URL('manifest.json',base),{cache:'no-store'});
  if(!resp.ok) throw new Error('No verified build bundle was published. Run GitHub Actions first.');
  const manifest=await resp.json();
  if(manifest.network!=='testnet' || manifest.version!=='0.1.0' || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit)) throw new Error('Invalid build manifest');
  const load=async (f,lim)=>{
    if(!f || !/^[a-f0-9]{64}$/.test(f.sha256) || !/^[\w-]+\.wasm$/.test(f.file)) throw new Error('Invalid manifest entry');
    const response=await fetch(new URL(f.file,base),{cache:'no-store'});
    if(!response.ok) throw new Error('Missing '+f.file);
    const bytes=assertWasm(new Uint8Array(await response.arrayBuffer()),lim);
    const actual=await sha256(bytes);
    if(actual!==f.sha256) throw new Error('SHA256 mismatch for '+f.file);
    return bytes;
  };
  state.artifactsTrusted=false;state.factoryBytes=null;state.tokenBytes=null;
  state.factoryBytes=await load(manifest.factory,MAX_FACTORY_WASM);
  state.tokenBytes=await load(manifest.token,MAX_TEMPLATE_WASM);
  state.manifest=manifest;state.artifactsTrusted=true;
  update('source-commit',manifest.sourceCommit);
  update('factory-hash',`SHA256 ${manifest.factory.sha256} (${state.factoryBytes.length} bytes)`);
  update('token-hash',`SHA256 ${manifest.token.sha256} (${state.tokenBytes.length} bytes)`);
  log('Two WASM files loaded. Both SHA-256 hashes match the published build manifest. Review source commit '+manifest.sourceCommit,'ok');
  render();
}
async function localUpload(kind,file) {
  if(!file)return;
  const limit=kind==='factory'?MAX_FACTORY_WASM:MAX_TEMPLATE_WASM;
  const bytes=assertWasm(new Uint8Array(await file.arrayBuffer()),limit);
  const hash=await sha256(bytes);
  if(kind==='factory')state.factoryBytes=bytes;else state.tokenBytes=bytes;
  state.artifactsTrusted=false;state.manifest=null;
  update(kind==='factory'?'factory-hash':'token-hash',`Untrusted local upload SHA256 ${hash} (${bytes.length} bytes)`);
  update('source-commit','Local upload: unverified. Use published build instead.');
  log(`Local ${kind} WASM loaded; SHA256 ${hash}. Cannot deploy without verified source manifest.`,'info');
  render();
}
async function readFactory() {
  requireOwner();
  state.factory=factoryIdFor(state.owner,el('prefix').value.trim());
  const found=await accountInfo(state.factory);
  state.checkedFactory=true;
  state.verifiedFactory=false;state.factoryInfo=null;state.installed=false;state.keys=[];
  if(!found.exists){log(`Account ${state.factory} does not exist. Ready to create with one owner-signed transaction.`);render();return}
  const [owner,installed,keys]=await Promise.all([
    view(state.factory,'get_owner'),view(state.factory,'is_template_installed'),accessKeys(state.factory),
  ]);
  state.keys=keys;
  state.factoryInfo={owner,installed};
  if(owner!==state.owner) throw new Error(`Factory owner ${owner} does not match connected wallet ${state.owner}`);
  state.verifiedFactory=true;state.installed=installed;
  if(keys.length) log(`Warning: factory has ${keys.length} access key(s); expected zero. Installation blocked until investigated.`,'error');
  log(`Factory verified: owner=${owner}; template=${installed?'installed':'not installed'}; keys=${keys.length}`,'ok');
  render();
}
async function broadcast(receiverId,actions,details) {
  requireOwner();
  log('Requesting owner wallet approval: '+details);
  // Browser wallets often navigate away; return value may be void.
  const result=await state.wallet.signAndSendTransaction({signerId:state.owner,receiverId,actions});
  const hash=transactionHash(result);
  if(hash)log('Transaction: '+hash,'info');
  log(!result?'Wallet redirected; no confirmed result yet. Refresh on-chain status before retrying.':completedSuccessfully(result)?'Wallet returned success; independently checking chain state next.':'Wallet result uncertain or failed. Investigate explorer before retrying.',result&&completedSuccessfully(result)?'ok':'info');
  return result;
}
async function deployFactory() {
  requireOwner();requireArtifact('factory');
  const target=factoryIdFor(state.owner,el('prefix').value.trim());
  const found=await accountInfo(target);
  if(found.exists) throw new Error('Factory account already exists; will not overwrite existing code.');
  const funding=parseNear(el('funding').value.trim());
  if(funding<YOCTO)throw new Error('At least 1 testnet NEAR funding required; choose enough for contract storage.');
  if(funding>100n*YOCTO)throw new Error('Funding capped at 100 testnet NEAR in this prototype.');
  const price=await storagePrice();
  const minFunding=(BigInt(state.factoryBytes.length)+2048n)*price + YOCTO/2n;
  if(funding<minFunding)throw new Error(`Insufficient factory funding for WASM storage. Minimum estimate ${formatNear(minFunding)} testnet NEAR.`);
  const ok=confirm(`CREATE & DEPLOY\n\nNetwork: NEAR TESTNET\nParent wallet: ${state.owner}\nNew keyless factory: ${target}\nFunding: ${formatNear(funding)} testnet NEAR\nSource commit: ${state.manifest.sourceCommit}\n\nThis is a blockchain transaction, not a simulation. Proceed?`);
  if(!ok)return;
  state.checkedFactory=false;render();
  await broadcast(target,createFactoryActions(actionCreators,state.factoryBytes,state.owner,funding),`create account, fund ${formatNear(funding)} NEAR, deploy factory and initialize owner`);
  await readFactory();
}
async function installTemplate() {
  requireOwner();requireArtifact('token');
  await readFactory();
  if(!state.verifiedFactory || state.installed || state.keys.length)throw new Error('Factory not eligible for template installation');
  const price=await storagePrice();
  const amount=templateDeposit(state.tokenBytes.length,price);
  const ok=confirm(`ONE-TIME TOKEN TEMPLATE INSTALLATION\n\nFactory: ${state.factory}\nHash: ${state.manifest.token.sha256}\nDeposit: ${formatNear(amount,6)} testnet NEAR\n\nThe v0.1 factory locks this template forever. Continue?`);
  if(!ok)return;
  await broadcast(state.factory,installTemplateActions(actionCreators,state.tokenBytes,amount),'install irreversible token template');
  await readFactory();
}
async function launchToken() {
  requireOwner();await readFactory();
  if(!state.installed)throw new Error('Template must be installed');
  const slug=el('token-slug').value.trim(), name=el('token-name').value.trim(),symbol=el('token-symbol').value.trim(),icon=el('token-icon').value.trim()||null;
  const existing=await view(state.factory,'get_launch',{slug});
  if(existing)throw new Error('Slug already has a pending or completed launch. Do not retry.');
  const actions=launchActions(actionCreators,slug,name,symbol,icon);
  if(!confirm(`LAUNCH TEST TOKEN\n\nToken: ${name} (${symbol})\nAddress: ${slug}.${state.factory}\nAttach: 5.02 testnet NEAR\n\nAsync deployment can fail or strand a child account. Continue?`))return;
  await broadcast(state.factory,actions,'launch test token '+slug);
  await checkToken();
}
async function checkToken() {
  if(!state.factory)throw new Error('Connect wallet and select factory');
  const slug=el('token-slug').value.trim();
  if(!/^[a-z0-9-]{3,32}$/.test(slug))throw new Error('Invalid slug');
  const record=await view(state.factory,'get_launch',{slug});
  update('token-result',record?`Token ${record.token_id}: status=${record.status} · creator=${record.creator}`:'No launch record found.');
  log(record?`Token ${record.token_id} is ${record.status}. Do not retry any failed or pending launch without checking receipts.`:`Token slug ${slug} has no launch record.`);
}
function bind(id,method) {
  el(id).addEventListener('click',async()=>{try{setBusy(true);await method()}catch(e){log(errMessage(e),'error');alert(errMessage(e))}finally{setBusy(false)}});
}
bind('connect',connectWallet);
bind('disconnect',async()=>{if(state.wallet)await state.wallet.signOut();state.wallet=null;state.owner=null;render();log('Wallet disconnected')});
bind('load-artifacts',loadManifest);
bind('check-factory',readFactory);
bind('deploy-factory',deployFactory);
bind('check-template',readFactory);
bind('install-template',installTemplate);
bind('launch-token',launchToken);
bind('check-token',checkToken);
el('prefix').addEventListener('input',()=>render());
el('factory-wasm').addEventListener('change',async e=>{try{await localUpload('factory',e.target.files?.[0])}catch(err){log(errMessage(err),'error')}});
el('token-wasm').addEventListener('change',async e=>{try{await localUpload('token',e.target.files?.[0])}catch(err){log(errMessage(err),'error')}});
el('clear-log').addEventListener('click',()=>{el('logs').textContent='' });
render();
initWallet().catch(e=>log('Wallet connector unavailable: '+errMessage(e),'error'));
storagePrice().then(p=>{state.storagePrice=p;render();log('On-chain storage byte price loaded.')}).catch(e=>log('Could not retrieve live network storage pricing: '+errMessage(e),'error'));
