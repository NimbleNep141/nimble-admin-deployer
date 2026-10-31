'use strict';
const {app,BrowserWindow,ipcMain,dialog,session,shell}=require('electron');
const {readFile,stat}=require('node:fs/promises');
const path=require('node:path');
const {
  YOCTO,validateOwner,factoryId,nearAmount,formatNear,sha256,
  verifyManifest,preparePlan,factoryActions
}=require('./plan.cjs');

const RPC='https://rpc.testnet.near.org';
const BASE='https://punisher530.github.io/nearium-admin-deployer/artifacts/';
let build=null;
let signer=null; // retained only in current process memory; never persisted or logged
let busy=false;
const txGuard=()=>{if(busy)throw Error('A deployment is already running. Verify its outcome before attempting anything else.');};
const limit=async(url,max)=>{
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{'accept':'application/octet-stream, application/json'}});
  if(!response.ok||!response.body)throw Error('Cannot download published Nearium artifact (HTTP '+response.status+').');
  const len=Number(response.headers.get('content-length')||0);
  if(len>max)throw Error('Artifact exceeds allowed download size.');
  const pieces=[];let total=0;
  for await(const chunk of response.body){
    total+=chunk.byteLength;
    if(total>max){await response.body.cancel().catch(()=>{});throw Error('Artifact exceeds allowed download size.');}
    pieces.push(Buffer.from(chunk));
  }
  return Buffer.concat(pieces);
};
async function rpc(method,params){
  const controller=AbortSignal.timeout(30000);
  const res=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'nearium-desktop',method,params}),signal:controller,redirect:'error'});
  if(!res.ok)throw Error('NEAR testnet RPC unavailable (HTTP '+res.status+').');
  const output=await res.json();
  if(output.error){
    const e=Error(output.error?.message||'NEAR RPC error');
    e.rpcName=output.error?.cause?.name||output.error?.name;
    throw e;
  }
  return output.result;
}
async function verifyNetwork(){
  const status=await rpc('status',[]);
  if(status?.chain_id!=='testnet')throw Error('RPC chain mismatch. The application refuses to connect to mainnet.');
  return true;
}
async function accountState(id){
  try{return await rpc('query',{request_type:'view_account',finality:'final',account_id:id});}
  catch(e){
    if(e.rpcName==='UNKNOWN_ACCOUNT')return null;
    throw e; // transient errors must never be treated as account absence
  }
}
async function ownerFromFactory(id){
  const args=Buffer.from('{}').toString('base64');
  const out=await rpc('query',{request_type:'call_function',finality:'final',account_id:id,method_name:'get_owner',args_base64:args});
  return JSON.parse(Buffer.from(out.result).toString('utf8'));
}
async function factoryStatus(id){
  const info=await accountState(id);
  if(!info)return {exists:false};
  const list=await rpc('query',{request_type:'view_access_key_list',finality:'final',account_id:id});
  let owner=null,ownerError=null;
  try{owner=await ownerFromFactory(id)}catch{ownerError='Factory get_owner method is unavailable or failed.'}
  return {exists:true,keys:list?.keys?.length??null,codeHash:info.code_hash,owner,ownerError};
}
async function storagePrice(){
  const config=await rpc('EXPERIMENTAL_protocol_config',{finality:'final'});
  if(config.chain_id!=='testnet')throw Error('Protocol returned a non-testnet chain.');
  const v=config.runtime_config?.storage_amount_per_byte;
  if(!v||!/^\d+$/.test(String(v)))throw Error('Unable to load NEAR protocol storage price.');
  return BigInt(v);
}
async function loadBuild(){
  await verifyNetwork();
  const manifest=JSON.parse((await limit(BASE+'manifest.json',16384)).toString('utf8'));
  const wasm=await limit(BASE+'factory.wasm',4_000_000);
  const metadata=verifyManifest(manifest,wasm);
  build={wasm,metadata};
  return metadata;
}
async function getApi(){
  return import('near-api-js');
}
async function importSecret(owner,secret){
  validateOwner(owner);
  if(typeof secret!=='string'||secret.length>512||!/^ed25519:[1-9A-HJ-NP-Za-km-z]{70,110}$/.test(secret.trim()))throw Error('Enter an exported NEAR ed25519 private key. Never use a seed phrase.');
  const {Account,JsonRpcProvider,KeyPairSigner}=await getApi();
  const keySigner=KeyPairSigner.fromSecretKey(secret.trim());
  const publicKey=(await keySigner.getPublicKey()).toString();
  await verifyNetwork();
  const ak=await rpc('query',{request_type:'view_access_key',finality:'final',account_id:owner,public_key:publicKey});
  if(ak.permission!=='FullAccess')throw Error('This owner key does not have FullAccess on testnet. A function-call key cannot create a factory account.');
  const account=new Account(owner,new JsonRpcProvider({url:RPC}),keySigner);
  signer={owner,account,publicKey};
  const info=await accountState(owner);
  return {owner,publicKey,balance:formatNear(BigInt(info?.amount||'0')),saved:false};
}
async function preview(data){
  await verifyNetwork();
  if(!build)throw Error('Load and verify the factory WASM first.');
  const owner=validateOwner(data?.owner);
  const plan=preparePlan({owner,prefix:data?.prefix,funding:data?.funding,wasmSize:build.wasm.length,storagePerByte:await storagePrice()});
  const [target,account]=await Promise.all([factoryStatus(plan.target),accountState(owner)]);
  const hasSigner=signer?.owner===owner;
  let canDeploy=false,reason='';
  if(target.exists)reason='Factory already exists; do not deploy over it.';
  else if(!account)reason='Owner testnet account does not exist.';
  else if(!hasSigner)reason='Import this owner’s full-access testnet key locally.';
  else {
    const need=plan.amount+YOCTO/4n;
    const available=BigInt(account.amount)-BigInt(account.storage_usage)*await storagePrice();
    if(available<need)reason='Owner needs '+formatNear(need)+' testnet NEAR available including estimated gas margin.';
    else canDeploy=true;
  }
  return {owner,target:plan.target,funding:plan.funding,minFunding:plan.minFunding,exists:target.exists,existing:target.exists?target:null,
    hasSigner,canDeploy,reason,build:build.metadata,ownerBalance:account?formatNear(BigInt(account.amount)):null};
}
async function deploy(data){
  txGuard();busy=true;
  let attempted=false;
  try{
    if(!data||data.acknowledge!==true)throw Error('Read and accept the deployment warnings before signing.');
    const state=await preview(data);
    if(data.confirmation!==state.target)throw Error('Type the exact target factory address to confirm.');
    if(!state.canDeploy)throw Error(state.reason||'Factory is not ready to deploy.');
    if(signer?.owner!==state.owner)throw Error('Local signer does not match factory owner.');
    await verifyNetwork();
    // Re-check immediately before signing: never overwrite an existing account.
    if(await accountState(state.target))throw Error('Factory account appeared on-chain. Deployment cancelled.');
    const ak=await rpc('query',{request_type:'view_access_key',finality:'final',account_id:state.owner,public_key:signer.publicKey});
    if(ak.permission!=='FullAccess')throw Error('The owner key is no longer a full-access key.');
    const {actions}=await getApi();
    const plan=preparePlan({owner:state.owner,prefix:data.prefix,funding:data.funding,wasmSize:build.wasm.length,storagePerByte:await storagePrice()});
    const txActions=factoryActions(actions,build.wasm,plan);
    // Exact 4-action sequence. No AddKey. This uses a dedicated local owner signer.
    attempted=true;
    // Disable near-api-js automatic nonce retries; never repeat creation after uncertain outcomes.
    const result=await signer.account.signAndSendTransaction({receiverId:state.target,actions:txActions,retries:0,waitUntil:'FINAL',throwOnFailure:false});
    const hash=result?.transaction?.hash||result?.transaction_outcome?.id||null;
    const after=await factoryStatus(state.target);
    const verified=after.exists&&after.keys===0&&after.owner===state.owner;
    const failed=Boolean(result?.status?.Failure);
    return {attempted:true,txHash:hash,verified,failed,account:state.target,
      factory:after,warning:!verified||failed?'Transaction was submitted but deployment is not fully verified. Inspect receipts and do not retry automatically.':null};
  }catch(e){
    // Once broadcasting may have happened, an RPC timeout is NOT a safe retry signal.
    if(attempted)throw Error('Submission or verification was uncertain: '+safeMessage(e)+'. Check the on-chain account and transaction receipts before trying again.');
    throw e;
  }finally{busy=false;}
}
function safeMessage(e){
  let msg=typeof e?.message==='string'?e.message:'Unexpected error';
  if(signer&&msg.includes(signer.owner)){} // public account ID is safe
  return msg.slice(0,400).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{70,110}/g,'[REDACTED]');
}
function handle(name,fn){
  ipcMain.handle('nearium:'+name,async(_event,data)=>{
    try{return {ok:true,data:await fn(data)}}catch(e){return {ok:false,error:safeMessage(e)}}
  });
}
handle('load-build',loadBuild);
handle('import-key',async data=>importSecret(data?.owner,data?.secret));
handle('import-file',async owner=>{
  validateOwner(owner);
  const sel=await dialog.showOpenDialog({title:'Select a local exported NEAR testnet key file',properties:['openFile'],filters:[{name:'NEAR key files',extensions:['json','txt']}]});
  if(sel.canceled||!sel.filePaths[0])return {cancelled:true};
  const file=sel.filePaths[0];
  if((await stat(file)).size>4096)throw Error('Key file is too large. Select a simple NEAR credential export.');
  const contents=(await readFile(file,'utf8')).trim();
  let secret=contents;
  if(contents.startsWith('{')){
    const credential=JSON.parse(contents);
    if(credential.account_id&&credential.account_id!==owner)throw Error('The key file belongs to a different account.');
    secret=credential.private_key||credential.secret_key;
  }
  return importSecret(owner,secret);
});
handle('clear-key',async()=>{signer=null;return {cleared:true}});
handle('preview',preview);
handle('deploy',deploy);
app.whenReady().then(()=>{
  // Prevent renderer network, web navigation and permissions. Only the main process
  // can use fixed GitHub Pages and official NEAR testnet RPC endpoints.
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,cb)=>cb({cancel:true}));
  const win=new BrowserWindow({width:1080,height:900,minWidth:780,minHeight:680,show:false,
    backgroundColor:'#0b1219',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.removeMenu();
  win.loadFile(path.join(__dirname,'index.html'));
  win.once('ready-to-show',()=>win.show());
});
app.on('window-all-closed',()=>{signer=null;app.quit()});
