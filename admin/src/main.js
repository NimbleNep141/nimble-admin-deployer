import './style.css';
// Wallet modules load asynchronously after the page handlers are attached.
// If wallet dependencies fail to initialize, the UI remains responsive.
import {
  RPC_URL, YOCTO, parseNear, formatNear, assertWasm, sha256, factoryIdFor,
  MAX_FACTORY_WASM, MAX_TEMPLATE_WASM, accountInfo, accessKeys, storagePrice, templateDeposit,
  view, createFactoryActions, installTemplateActions, launchActions, transactionHash, completedSuccessfully,
} from './core.js';

const WALLET_NAMES = Object.freeze({ 'meteor-wallet': 'Meteor Wallet', 'intear-wallet': 'Intear Wallet' });
const el = id => document.getElementById(id);
function walletFeedback(message, kind='info') {
  const target=el('wallet-feedback');
  target.textContent=message;
  target.dataset.kind=kind;
}
const state = { selector:null,actionCreators:null,wallet:null,walletProvider:null,owner:null, factory:null, factoryInfo:null,
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
function bounded(promise,ms,stage) {
  // Timeout only bounds the UI wait; a wallet authorization already opened may still be pending.
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_,reject)=>setTimeout(()=>reject(new Error(stage+' took too long. Check your wallet for a pending request, or refresh the page. Do not retry a signed transaction without checking the blockchain.')),ms))
  ]);
}
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
  // MyNearWallet stopped accepting new dApp connections during its 2026 sunset.
  // Do not put it back into the selector without checking current wallet support.
  walletFeedback('Loading wallet connection libraries…');
  const [selectorCore,meteor,intear] = await bounded(Promise.all([
    import('@near-wallet-selector/core'),
    import('@near-wallet-selector/meteor-wallet'),
    import('@near-wallet-selector/intear-wallet'),
  ]),20000,'Loading wallet libraries');
  state.actionCreators=selectorCore.actionCreators;
  walletFeedback('Initializing Meteor and Intear wallet providers…');
  state.selector=await bounded(selectorCore.setupWalletSelector({
    network:'testnet',
    modules:[meteor.setupMeteorWallet(),intear.setupIntearWallet()],
  }),20000,'Initializing wallet providers');
  const existing=state.selector.store.getState().selectedWalletId;
  if(existing && WALLET_NAMES[existing]) {
    try {
      el('wallet-provider').value=existing;
      state.wallet=await state.selector.wallet(existing);
      state.walletProvider=existing;
      await refreshAccount();
      if(state.owner) {
        walletFeedback('Connected to '+state.owner+' through '+WALLET_NAMES[existing]+'.','ok');
      }
    } catch(e) {
      state.wallet=null;state.walletProvider=null;state.owner=null;
      log('Wallet session could not be restored: '+errMessage(e),'error');
    }
  }
  state.selector.store.observable.subscribe(async () => {
    if(state.wallet) try {await refreshAccount()} catch(e) {
      log('Could not refresh wallet connection: '+errMessage(e),'error');
    }
  });
  if(!state.owner) walletFeedback('Wallet connection is ready. Select Meteor or Intear, then click Connect wallet.');
  log('Wallet connectors ready: Meteor and Intear. Chain locked to NEAR testnet.');
  render();
}
async function connectWallet() {
  if(!state.selector) throw new Error('Wallet connection not initialized. Reload the page and check the message below this button.');
  const provider=el('wallet-provider').value;
  if(!Object.hasOwn(WALLET_NAMES,provider)) throw new Error('Select a supported NEAR wallet.');
  walletFeedback('Connect button received. Opening '+WALLET_NAMES[provider]+'…');
  log('Connect button clicked: '+WALLET_NAMES[provider]+' on NEAR testnet.');
  // Only the wallet provider signs. Do not ask for access to arbitrary third-party methods.
  state.wallet=await bounded(state.selector.wallet(provider),15000,'Selecting '+WALLET_NAMES[provider]);
  state.walletProvider=provider;
  walletFeedback(WALLET_NAMES[provider]+' selected. Checking signed-in testnet account…');
  let accounts=await bounded(state.wallet.getAccounts(),15000,'Reading wallet accounts');
  if(!accounts.length) {
    walletFeedback('Requesting authorization from '+WALLET_NAMES[provider]+'. Check the wallet extension or opened window. For Meteor, install and unlock its browser extension.');
    log('Requesting '+WALLET_NAMES[provider]+' sign-in. Approve the request in your wallet.');
    // Wallet Selector requires a contract context. No invented method scope or unattended signing.
    // This is only a wallet identity connection; deployment is approved separately.
    await bounded(state.wallet.signIn({contractId:'social.testnet'}),60000,'Wallet sign-in');
  }
  await refreshAccount();
  if(!state.owner) {
    walletFeedback('Wallet approval is pending or no testnet account was returned. Check the wallet extension or window and try again if it did not open.','info');
    log('No signed-in account returned yet. Check wallet UI; browser-wallet callbacks may require a reload.');
    return;
  }
  if(!state.owner.endsWith('.testnet')) {
    walletFeedback('Connected account '+state.owner+' is not a named .testnet account. Select a named testnet account before deploying.','error');
    log('Please use a named .testnet account for factory subaccount creation.','error');
    return;
  }
  walletFeedback('Connected: '+state.owner+' via '+WALLET_NAMES[provider]+'.','ok');
  log('Wallet connected: '+state.owner,'ok');
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
  await broadcast(target,createFactoryActions(state.actionCreators,state.factoryBytes,state.owner,funding),`create account, fund ${formatNear(funding)} NEAR, deploy factory and initialize owner`);
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
  await broadcast(state.factory,installTemplateActions(state.actionCreators,state.tokenBytes,amount),'install irreversible token template');
  await readFactory();
}
async function launchToken() {
  requireOwner();await readFactory();
  if(!state.installed)throw new Error('Template must be installed');
  const slug=el('token-slug').value.trim(), name=el('token-name').value.trim(),symbol=el('token-symbol').value.trim(),icon=el('token-icon').value.trim()||null;
  const existing=await view(state.factory,'get_launch',{slug});
  if(existing)throw new Error('Slug already has a pending or completed launch. Do not retry.');
  const actions=launchActions(state.actionCreators,slug,name,symbol,icon);
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
  el(id).addEventListener('click',async()=>{
    if(id==='connect') walletFeedback('Connect button clicked. Starting wallet handshake…');
    try { setBusy(true); await method(); }
    catch(e) {
      log(errMessage(e),'error');
      if(id==='connect') walletFeedback('Connection failed: '+errMessage(e),'error');
      else alert(errMessage(e));
    } finally {setBusy(false)}
  });
}
bind('connect',connectWallet);
bind('disconnect',async()=>{if(state.wallet)await state.wallet.signOut();state.wallet=null;state.walletProvider=null;state.owner=null;render();walletFeedback('Disconnected. Select a wallet and reconnect.');log('Wallet disconnected')});
bind('load-artifacts',loadManifest);
bind('check-factory',readFactory);
bind('deploy-factory',deployFactory);
bind('check-template',readFactory);
bind('install-template',installTemplate);
bind('launch-token',launchToken);
bind('check-token',checkToken);
el('wallet-provider').addEventListener('change',()=>walletFeedback('Selected '+WALLET_NAMES[el('wallet-provider').value]+'. Click Connect wallet to authorize.'));
el('prefix').addEventListener('input',()=>render());
el('factory-wasm').addEventListener('change',async e=>{try{await localUpload('factory',e.target.files?.[0])}catch(err){log(errMessage(err),'error')}});
el('token-wasm').addEventListener('change',async e=>{try{await localUpload('token',e.target.files?.[0])}catch(err){log(errMessage(err),'error')}});
el('clear-log').addEventListener('click',()=>{el('logs').textContent='' });
window.__neariumBooted=true;
render();
walletFeedback('Admin UI loaded. Preparing wallet connections…');
initWallet().catch(e=>{walletFeedback('Wallet connection unavailable: '+errMessage(e),'error');log('Wallet connector unavailable: '+errMessage(e),'error')});
storagePrice().then(p=>{state.storagePrice=p;render();log('On-chain storage byte price loaded.')}).catch(e=>log('Could not retrieve live network storage pricing: '+errMessage(e),'error'));
