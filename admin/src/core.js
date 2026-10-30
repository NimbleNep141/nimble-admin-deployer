/** Nearium owner-controlled, TESTNET-ONLY launcher core; no keys or secret storage. */
export const RPC_URL = 'https://rpc.testnet.near.org';
export const YOCTO = 10n ** 24n;
export const TGas = 10n ** 12n;
export const MAX_FACTORY_WASM = 4_000_000;
export const MAX_TEMPLATE_WASM = 1_000_000; // v0.1 hard limit
export const LAUNCH_DEPOSIT = 5_020_000_000_000_000_000_000_000n;
const NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export function parseNear(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(?:\.\d{1,24})?$/.test(value)) throw new Error('Enter a valid positive NEAR amount (up to 24 decimals).');
  const [whole, fractional=''] = value.split('.');
  return BigInt(whole) * YOCTO + BigInt(fractional.padEnd(24, '0') || '0');
}
export function formatNear(amount, maxFraction=5) {
  const v = BigInt(amount);
  const sign = v < 0n ? '-' : '';
  const x = v < 0n ? -v : v;
  const fraction=(x%YOCTO).toString().padStart(24,'0').slice(0,maxFraction).replace(/0+$/,'');
  return sign + (x/YOCTO).toString()+(fraction?'.'+fraction:'');
}
export function factoryIdFor(owner, slug) {
  if (typeof owner !== 'string' || !owner.endsWith('.testnet') || owner.length > 60) throw new Error('Connect a named NEAR testnet account.');
  if (typeof slug !== 'string' || slug.length < 3 || slug.length > 24 || !NAME.test(slug)) throw new Error('Factory prefix: 3–24 lowercase characters, digits, hyphens or underscores.');
  const name = `${slug}.${owner}`;
  if (name.length > 64) throw new Error('NEAR account name exceeds 64 characters.');
  return name;
}
export function assertWasm(bytes, limit) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > limit) throw new Error('Invalid or oversized WASM file.');
  if (bytes[0]!==0 || bytes[1]!==97 || bytes[2]!==115 || bytes[3]!==109 || bytes[4]!==1 || bytes[5]!==0 || bytes[6]!==0 || bytes[7]!==0) throw new Error('File is not a valid WebAssembly v1 binary.');
  return bytes;
}
export async function sha256(bytes) {
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash), b=>b.toString(16).padStart(2,'0')).join('');
}
export function toBase64(bytes) {
  let result = '';
  for (let i=0; i<bytes.length; i+=0x8000) result += String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return btoa(result);
}
export async function rpc(method, params) {
  const res = await fetch(RPC_URL, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'nearium-admin',method,params}),signal:AbortSignal.timeout(20000)});
  if (!res.ok) throw new Error(`NEAR RPC returned HTTP ${res.status}`);
  const json=await res.json();
  if (json.error) {
    const e=new Error(json.error?.cause?.name || json.error?.message || 'NEAR RPC error');
    e.rpcError=json.error;
    throw e;
  }
  return json.result;
}
export async function view(contractId, method, args={}) {
  const body=toBase64(new TextEncoder().encode(JSON.stringify(args)));
  const result=await rpc('query',{request_type:'call_function',finality:'final',account_id:contractId,method_name:method,args_base64:body});
  const output=new TextDecoder().decode(new Uint8Array(result.result));
  return JSON.parse(output);
}
export async function accountInfo(id) {
  try {
    return {exists:true,data:await rpc('query',{request_type:'view_account',finality:'final',account_id:id})};
  } catch (e) {
    // Never assume transient errors mean an account doesn't exist.
    const cause=e.rpcError?.cause?.name;
    if (cause==='UNKNOWN_ACCOUNT') return {exists:false,data:null};
    throw e;
  }
}
export async function accessKeys(id) {
  const result=await rpc('query',{request_type:'view_access_key_list',finality:'final',account_id:id});
  return result.keys;
}
export async function storagePrice() {
  const cfg=await rpc('EXPERIMENTAL_protocol_config',{finality:'final'});
  if (cfg.chain_id!=='testnet') throw new Error('RPC chain mismatch');
  const price=cfg.runtime_config?.storage_amount_per_byte;
  if (!price || !/^\d+$/.test(String(price))) throw new Error('Could not read on-chain storage price');
  return BigInt(price);
}
export function templateDeposit(size, perByte) {
  if (!Number.isSafeInteger(size) || size < 8 || size > MAX_TEMPLATE_WASM) throw new Error('Invalid template size');
  // On-chain contract requires estimated minimum (size+64)* storage cost.
  // Additional 30% margin + 0.1 testnet NEAR accounts for additional state/gas.
  return ((BigInt(size)+64n)*BigInt(perByte)*13n/10n) + YOCTO/10n;
}
export function createFactoryActions(actions, wasm, owner, funding) {
  assertWasm(wasm, MAX_FACTORY_WASM);
  return [
    actions.createAccount(),
    actions.transfer(BigInt(funding)),
    actions.deployContract(wasm),
    actions.functionCall('new',{owner},30n*TGas,0n),
  ];
}
export function installTemplateActions(actions, wasm, deposit) {
  assertWasm(wasm,MAX_TEMPLATE_WASM);
  return [actions.functionCall('install_template',{code:toBase64(wasm)},230n*TGas,BigInt(deposit))];
}
export function launchActions(actions,slug,name,symbol,icon=null) {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/.test(slug) || slug.length>32) throw new Error('Token slug must be 3–32 lowercase characters/digits/hyphens');
  if (name.length < 3 || new TextEncoder().encode(name).length>64) throw new Error('Token name must be 3–64 UTF-8 bytes');
  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) throw new Error('Symbol must be 2–12 capital letters/digits');
  if (icon!==null && new TextEncoder().encode(icon).length>1024) throw new Error('Icon is too long');
  return [actions.functionCall('launch',{slug,name,symbol,icon},160n*TGas,LAUNCH_DEPOSIT)];
}
export function transactionHash(result) {
  return result?.transaction?.hash || result?.transaction_outcome?.id || null;
}
export function completedSuccessfully(result) {
  if (!result) return false; // Wallet redirection does not mean success.
  if (result.status?.Failure || result.final_execution_status==='FAILURE') return false;
  return !!(result.status?.SuccessValue !== undefined || result.status?.SuccessReceiptId || result.final_execution_status==='FINAL');
}
