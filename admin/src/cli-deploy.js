import {factoryIdFor,formatNear,parseNear,YOCTO,MAX_FACTORY_WASM} from './core.js';

/** Prepare instructions only. This website NEVER receives CLI credentials. */
export const FACTORY_DOWNLOAD='nearium-factory-verified.wasm';
const OWNER=/^[a-z0-9][a-z0-9._-]*\.testnet$/;
const HASH=/^[a-f0-9]{64}$/;

export function buildCliPlan({owner,prefix,funding,hash,wasmSize,storageBytePrice}) {
  if(typeof owner!=='string' || !OWNER.test(owner.trim()) || owner.trim().length>60) {
    throw new Error('Enter a valid lowercase owner account ending in .testnet.');
  }
  owner=owner.trim();
  const factory=factoryIdFor(owner,prefix);
  if(!HASH.test(hash||''))throw new Error('Load a verified factory build first.');
  if(!Number.isSafeInteger(wasmSize)||wasmSize<8||wasmSize>MAX_FACTORY_WASM)throw new Error('Invalid factory WASM size.');
  const amount=parseNear(funding);
  if(amount<YOCTO||amount>100n*YOCTO)throw new Error('Initial funding must be 1 to 100 testnet NEAR.');
  if(storageBytePrice==null)throw new Error('Testnet storage price has not loaded yet.');
  const price=BigInt(storageBytePrice);
  if(price<=0n)throw new Error('Invalid on-chain storage price.');
  const required=(BigInt(wasmSize)+2048n)*price+YOCTO/2n;
  if(amount<required)throw new Error('Funding below the required estimate of '+formatNear(required,6)+' testnet NEAR.');
  return {owner,factory,fundingNear:formatNear(amount,24),hash,wasmSize};
}

export function preparationScript(plan){
  return [
    '# NEARIUM TESTNET: preparation only. This does not submit transactions.',
    '# Install official NEAR CLI: https://near.cli.rs/',
    '# Import a dedicated testnet full-access owner locally via: near account import-account',
    "# Never paste private keys or recovery phrases into the Nearium website.",
    "$ErrorActionPreference = 'Stop'",
    "$OWNER = '"+plan.owner+"'",
    "$FACTORY = '"+plan.factory+"'",
    "$WASM = Join-Path (Join-Path $HOME 'Downloads') '"+FACTORY_DOWNLOAD+"'",
    "$EXPECTED_HASH = '"+plan.hash+"'",
    '$EXPECTED_SIZE = '+plan.wasmSize,
    'if (-not (Get-Command near -ErrorAction SilentlyContinue)) { throw "Install NEAR CLI: https://near.cli.rs/" }',
    'if (-not (Test-Path -LiteralPath $WASM)) { throw "Place the downloaded WASM file in Downloads first." }',
    '$ACTUAL_HASH = (Get-FileHash -LiteralPath $WASM -Algorithm SHA256).Hash.ToLowerInvariant()',
    'if ($ACTUAL_HASH -ne $EXPECTED_HASH) { throw "STOP: Factory WASM SHA-256 does not match verified build." }',
    'if ((Get-Item -LiteralPath $WASM).Length -ne $EXPECTED_SIZE) { throw "STOP: Factory WASM file size mismatch." }',
    '$INIT_FILE = Join-Path $env:TEMP "nearium-factory-init.json"',
    '@{ owner = $OWNER } | ConvertTo-Json -Compress | Set-Content -LiteralPath $INIT_FILE -Encoding Ascii',
    'Write-Host "Factory bytes and owner verified. No transaction has been sent."',
    'Write-Host "Owner:" $OWNER',
    'Write-Host "Factory:" $FACTORY',
    'Write-Host "Init file:" $INIT_FILE',
  ].join('\n');
}

export function deploymentScript(plan){
  return [
    '# DANGER: this is an actual blockchain transaction, not a preview.',
    '# Run only after preparation, and only if this factory account does NOT exist.',
    '# Confirm 4 actions in the CLI summary: CreateAccount, Transfer, DeployContract, FunctionCall(new).',
    '# There must be NO AddKey action. Read and approve locally; do not blindly retry errors.',
    'near transaction construct-transaction $OWNER receiver-id $FACTORY add-action create-account add-action transfer "'+plan.fundingNear+' NEAR" add-action deploy use-file "$WASM" with-init-call new file-args "$INIT_FILE" prepaid-gas "30 Tgas" attached-deposit "0 NEAR" skip network-config testnet sign-with-keychain send',
  ].join('\n');
}

export function setupCliDeployment({getBuild,getPrice,getPrefix,getFunding,getOwner,accountInfo,log}) {
  const el=id=>document.getElementById(id);
  let checkedId=null,accountExists=null,generatedKey=null,busy=false;
  const feedback=(msg,type='info')=>{el('cli-feedback').textContent=msg;el('cli-feedback').dataset.kind=type;};
  const target=()=>{try{return factoryIdFor(el('cli-owner').value.trim(),getPrefix())}catch{return null}};
  const plan=()=>{
    const build=getBuild();
    if(!build)throw new Error('Click "Load published build" before preparing CLI deployment.');
    return buildCliPlan({
      owner:el('cli-owner').value.trim(),prefix:getPrefix(),funding:getFunding(),
      hash:build.hash,wasmSize:build.bytes.length,storageBytePrice:getPrice(),
    });
  };
  const key=p=>[p.owner,p.factory,p.fundingNear,p.hash].join('|');
  function refresh(){
    const factory=target();
    const build=getBuild();
    el('cli-factory').textContent=factory||'Enter a valid .testnet owner account';
    el('cli-check').disabled=busy||!factory||!build;
    el('cli-use-wallet').disabled=busy||!getOwner();
    el('cli-download').disabled=busy||!build;
    el('cli-status').textContent=checkedId===factory&&factory?(accountExists?'Already exists':'Available'):'Not checked';
    let eligible=false,p=null;
    try{p=plan();eligible=checkedId===p.factory&&accountExists===false;}catch{}
    el('cli-generate').disabled=busy||!eligible;
    if(!p||key(p)!==generatedKey)el('cli-output').hidden=true;
  }
  async function run(action){
    if(busy)return;
    busy=true;refresh();
    try{await action()}catch(e){feedback(e?.message||String(e),'error');log('CLI guide: '+(e?.message||String(e)),'error');}
    finally{busy=false;refresh();}
  }
  el('cli-owner').addEventListener('input',refresh);
  el('cli-use-wallet').addEventListener('click',()=>{
    if(getOwner())el('cli-owner').value=getOwner();
    refresh();
  });
  el('cli-check').addEventListener('click',()=>run(async()=>{
    const p=plan();
    checkedId=null;accountExists=null;generatedKey=null;
    feedback('Checking '+p.factory+' on NEAR testnet…');
    const result=await accountInfo(p.factory);
    checkedId=p.factory;accountExists=result.exists;
    if(result.exists){
      feedback(p.factory+' already exists. Do not deploy again. Inspect it using Check on-chain.','error');
    } else {
      feedback('Confirmed: '+p.factory+' does not exist. Download the verified WASM, then generate CLI instructions.','ok');
    }
  }));
  el('cli-download').addEventListener('click',()=>run(async()=>{
    const b=getBuild();if(!b)throw new Error('Load the verified build first.');
    const url=URL.createObjectURL(new Blob([b.bytes],{type:'application/wasm'}));
    const a=document.createElement('a');a.href=url;a.download=FACTORY_DOWNLOAD;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),15000);
    feedback('Verified factory file downloaded. Save it in your Windows Downloads folder.','ok');
  }));
  el('cli-generate').addEventListener('click',()=>run(async()=>{
    const p=plan();
    if(p.factory!==checkedId||accountExists!==false)throw new Error('First confirm the factory address does not exist using Check factory on testnet.');
    el('cli-preparation').value=preparationScript(p);
    el('cli-command').value=deploymentScript(p);
    generatedKey=key(p);
    el('cli-output').hidden=false;
    feedback('CLI instructions prepared for '+p.factory+'. No transaction has been signed or sent.','ok');
    log('CLI deployment instructions generated for '+p.factory+' (locally signed; no transaction sent).','ok');
  }));
  for(const [button,field] of [['cli-copy-preparation','cli-preparation'],['cli-copy-command','cli-command']]){
    el(button).addEventListener('click',()=>run(async()=>{
      if(el('cli-output').hidden)throw new Error('Generate instructions for the current configuration first.');
      if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable. Select the text and copy it manually.');
      await navigator.clipboard.writeText(el(field).value);
      feedback('Copied commands. Review everything before running in PowerShell.','ok');
    }));
  }
  refresh();
  return {refresh};
}
