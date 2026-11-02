'use strict';
const {createHash,randomUUID}=require('node:crypto');
const YOCTO=10n**24n;
const WASM_MAX=3_500_000; // conservative transaction payload cap
const MAGIC=Buffer.from([0,97,115,109,1,0,0,0]);
const NAME=/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const NETWORKS=Object.freeze({
 testnet:Object.freeze({id:'testnet',label:'NEAR Testnet',suffix:'.testnet',rpc:'https://rpc.testnet.fastnear.com'}),
 mainnet:Object.freeze({id:'mainnet',label:'NEAR Mainnet',suffix:'.near',rpc:'https://rpc.mainnet.fastnear.com'})
});
function networkConfig(network){
 if(typeof network!=='string'||!Object.prototype.hasOwnProperty.call(NETWORKS,network))throw Error('Select NEAR Mainnet or Testnet explicitly.');
 return NETWORKS[network];
}
const PREFIX=/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
function accountId(s,network='testnet'){
 const chain=networkConfig(network);
 if(typeof s!=='string'||s.length>64||s.length<6||!NAME.test(s)||!s.endsWith(chain.suffix))
  throw Error('Enter a valid named '+chain.label+' account ending in '+chain.suffix+'. Other account namespaces and implicit accounts are not supported.');
 return s;
}
function prefix(s){
 if(typeof s!=='string'||s.length<2||s.length>24||!PREFIX.test(s))throw Error('Child-account prefix must be 2–24 lowercase characters, digits, - or _.');
 return s;
}
function childAccount(owner,p,network='testnet'){return accountId(prefix(p)+'.'+accountId(owner,network),network);}
function amount(s){
 if(typeof s!=='string'||!/^(0|[1-9]\d*)(?:\.\d{1,24})?$/.test(s))throw Error('Enter a nonnegative NEAR amount using up to 24 decimal places.');
 const [a,b='']=s.split('.');
 return BigInt(a)*YOCTO+BigInt((b+'0'.repeat(24)).slice(0,24));
}
function fmt(n){
 n=BigInt(n);const p=n<0n?'-':'';if(n<0n)n=-n;
 return p+(n/YOCTO).toString()+(n%YOCTO?'.'+(n%YOCTO).toString().padStart(24,'0').replace(/0+$/,''):'');
}
function wasm(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<8||bytes.length>WASM_MAX||!bytes.subarray(0,8).equals(MAGIC))throw Error('Select a valid NEAR-compatible WebAssembly (.wasm) file no larger than 3.5 MB.');
 return bytes;
}
function sha(bytes){return createHash('sha256').update(wasm(bytes)).digest('hex');}
function initConfig(data){
 const method=(data.initMethod||'').trim();
 if(method && !/^[a-zA-Z_][a-zA-Z0-9_]{0,80}$/.test(method))throw Error('Invalid initialization function name.');
 const text=data.initArgs?.trim()||'{}';
 if(text.length>16000)throw Error('Initialization JSON exceeds 16,000 characters.');
 let args;try{args=JSON.parse(text)}catch{throw Error('Initialization arguments must be valid JSON.');}
 if(args===null||typeof args!=='object'||Array.isArray(args))throw Error('Initialization arguments must be a JSON object.');
 if(!method && (text!=='{}'||amount(data.initDeposit||'0')!==0n))throw Error('A method name is required for initialization arguments or a deposit.');
 const gas=Number(data.gas||'30');
 if(!Number.isInteger(gas)||gas<10||gas>200)throw Error('Initialization gas must be 10–200 TGas.');
 const deposit=amount(data.initDeposit||'0');
 if(deposit>100n*YOCTO)throw Error('Initialization deposit exceeds the 100 NEAR safety limit.');
 return {method,args,gas:BigInt(gas)*10n**12n,gasTgas:gas,deposit};
}
function plan(data,bytes,price){
 wasm(bytes);
 const network=networkConfig(data.network||'testnet').id;
 const signer=accountId(data.owner,network);
 const mode=data.mode;
 if(!['new','existing'].includes(mode))throw Error('Choose new account or existing account.');
 const target=mode==='new'?childAccount(signer,data.prefix,network):signer;
 const init=initConfig(data);
 const keyMode=data.keyMode||'controlled';
 if(!['controlled','keyless'].includes(keyMode))throw Error('Invalid account key policy.');
 let funding=0n;
 if(mode==='new'){
  funding=amount(data.funding||'0');
  if(funding<YOCTO||funding>100n*YOCTO)throw Error('New account funding must be 1–100 NEAR.');
  const min=(BigInt(bytes.length)+4096n)*BigInt(price)+YOCTO/5n;
  if(funding<min)throw Error('New account storage estimate requires at least '+fmt(min)+' NEAR.');
 }
 if(mode==='existing'&&keyMode==='keyless')throw Error('Keyless mode is available only when creating a new child account.');
 return {network,mode,signer,target,keyMode,funding,init,replace:data.replace===true,wasmHash:sha(bytes),wasmBytes:bytes.length};
}
function actionsFor(api,bytes,p,publicKey){
 wasm(bytes);
 const acts=[];
 if(p.mode==='new'){
  acts.push(api.createAccount(),api.transfer(p.funding));
  if(p.keyMode==='controlled'){
   if(!publicKey)throw Error('Missing signing public key for recoverable new contract account.');
   acts.push(api.addFullAccessKey(publicKey));
  }
 }
 acts.push(api.deployContract(new Uint8Array(bytes)));
 if(p.init.method)acts.push(api.functionCall(p.init.method,p.init.args,p.init.gas,p.init.deposit));
 return acts;
}
function displayActions(p){
 return [
 ...(p.mode==='new'?['CreateAccount','Transfer '+fmt(p.funding)+' Ⓝ',...(p.keyMode==='controlled'?['AddFullAccessKey (same local signer)']:[])]:[]),
 'DeployContract ('+p.wasmBytes.toLocaleString('en-US')+' bytes)',
 ...(p.init.method?['FunctionCall '+p.init.method+' ('+p.init.gasTgas+' TGas, '+fmt(p.init.deposit)+' Ⓝ)']:[])
 ];
}
module.exports={YOCTO,WASM_MAX,NETWORKS,networkConfig,accountId,prefix,childAccount,amount,fmt,wasm,sha,initConfig,plan,actionsFor,displayActions};
