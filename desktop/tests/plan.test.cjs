const {test}=require('node:test');
const assert=require('node:assert/strict');
const {YOCTO,validateOwner,factoryId,nearAmount,formatNear,verifyManifest,preparePlan,factoryActions,sha256}=require('../src/plan.cjs');
const wasm=Buffer.from([0,97,115,109,1,0,0,0,1,2,3,4]);
const manifest={network:'testnet',version:'0.1.0',sourceCommit:'a'.repeat(40),factory:{file:'factory.wasm',bytes:wasm.length,sha256:sha256(wasm)}};
test('only named testnet owner and valid child prefix',()=>{
 assert.equal(factoryId('owner.testnet','launchpad'),'launchpad.owner.testnet');
 for(const name of ['owner.near','bad account.testnet','alice.testnet;rm','x'.repeat(60)+'.testnet'])assert.throws(()=>validateOwner(name));
 for(const slug of ['--launch','A','a','a;bad'])assert.throws(()=>factoryId('owner.testnet',slug));
});
test('NEAR exact arithmetic',()=>{
 assert.equal(nearAmount('6'),6n*YOCTO);
 assert.equal(formatNear(nearAmount('0.000000000000000000000001')),'0.000000000000000000000001');
 assert.throws(()=>nearAmount('1e3'));assert.throws(()=>nearAmount('-5'));
});
test('published factory WASM must pass SHA-256 and size',()=>{
 assert.equal(verifyManifest(manifest,wasm).hash,sha256(wasm));
 assert.throws(()=>verifyManifest({...manifest,network:'mainnet'},wasm));
 assert.throws(()=>verifyManifest(manifest,Buffer.from([...wasm,1])));
});
test('four ordered actions exactly, without AddKey',()=>{
 const a={createAccount:()=>({kind:'create'}),transfer:amount=>({kind:'transfer',amount}),deployContract:bytes=>({kind:'deploy',bytes}),functionCall:(name,args,gas,deposit)=>({kind:'call',name,args,gas,deposit})};
 const p=preparePlan({owner:'owner.testnet',prefix:'launchpad',funding:'6',wasmSize:wasm.length,storagePerByte:10n**19n});
 const acts=factoryActions(a,wasm,p);
 assert.deepEqual(acts.map(x=>x.kind),['create','transfer','deploy','call']);
 assert.equal(acts[1].amount,6n*YOCTO);assert.equal(acts[3].name,'new');assert.equal(acts[3].args.owner,'owner.testnet');assert.equal(acts[3].deposit,0n);
});
test('storage estimate, gas safety and max funding caps',()=>{
 const s={owner:'owner.testnet',prefix:'launchpad',funding:'6',wasmSize:164336,storagePerByte:10n**19n};
 assert.equal(preparePlan(s).target,'launchpad.owner.testnet');
 assert.throws(()=>preparePlan({...s,funding:'0.01'}));
 assert.throws(()=>preparePlan({...s,funding:'150'}));
 assert.throws(()=>preparePlan({...s,storagePerByte:10n**23n}));
});
