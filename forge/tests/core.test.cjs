'use strict';
const {test}=require('node:test');
const a=require('node:assert/strict');
const c=require('../src/core.cjs');
const b=Buffer.from([0,97,115,109,1,0,0,0,1,2,3,4]);
const base={mode:'new',owner:'example.testnet',prefix:'demo',funding:'6',keyMode:'controlled',initMethod:'new',initArgs:'{"owner":"example.testnet"}',gas:'30',initDeposit:'0'};
const price=10n**19n;
test('validate account names and prevent injection',()=>{
 a.equal(c.childAccount('example.testnet','demo'),'demo.example.testnet');
 for(const name of ['foo.near','foo;rm.testnet','foo..testnet','example.testnet/malicious'])a.throws(()=>c.accountId(name));
});
test('exact amounts and WASM integrity',()=>{
 a.equal(c.amount('0.000000000000000000000001'),1n);
 a.equal(c.fmt(c.amount('6.25')),'6.25');
 a.throws(()=>c.amount('1e5'));a.throws(()=>c.wasm(Buffer.from('not a wasm')));
 a.equal(c.sha(b).length,64);
});
test('recoverable new account adds the same signer public key before deployment',()=>{
 const p=c.plan(base,b,price);
 const names=[];const api={
  createAccount:()=>({name:'CreateAccount'}),transfer:()=>({name:'Transfer'}),
  addFullAccessKey:key=>({name:'AddKey',key}),deployContract:()=>({name:'DeployContract'}),
  functionCall:()=>({name:'FunctionCall'})
 };
 const x=c.actionsFor(api,b,p,{toString:()=> 'ed25519:public'});
 a.deepEqual(x.map(y=>y.name),['CreateAccount','Transfer','AddKey','DeployContract','FunctionCall']);
});
test('keyless plan forbids AddKey and leaves irreversible warning requirement to UI',()=>{
 const p=c.plan({...base,keyMode:'keyless'},b,price);
 const actions={createAccount:()=>1,transfer:()=>2,deployContract:()=>3,functionCall:()=>4};
 a.deepEqual(c.actionsFor(actions,b,p,null),[1,2,3,4]);
});
test('existing account upgrades require caller to target own account',()=>{
 const p=c.plan({...base,mode:'existing',keyMode:'controlled'},b,price);
 a.equal(p.target,'example.testnet');
 const api={deployContract:()=>({name:'DeployContract'}),functionCall:()=>({name:'FunctionCall'})};
 a.deepEqual(c.actionsFor(api,b,p).map(x=>x.name),['DeployContract','FunctionCall']);
});
test('initializer method and JSON must be valid',()=>{
 a.throws(()=>c.initConfig({...base,initMethod:'new;rm'}));
 a.throws(()=>c.initConfig({...base,initArgs:'["not object"]'}));
 a.throws(()=>c.initConfig({...base,gas:'500'}));
 a.throws(()=>c.initConfig({...base,initMethod:'',initArgs:'{"x":1}'}));
});
test('funding bound includes storage estimate',()=>{
 a.throws(()=>c.plan({...base,funding:'0.1'},b,price));
 a.throws(()=>c.plan({...base,funding:'999'},b,price));
});

test('mainnet account validation and new-contract plans are network-specific',()=>{
 a.equal(c.accountId('alice.near','mainnet'),'alice.near');
 a.equal(c.childAccount('alice.near','token','mainnet'),'token.alice.near');
 for(const name of ['alice.testnet','alice.near.extra','alice..near','ABC.near'])a.throws(()=>c.accountId(name,'mainnet'));
 a.throws(()=>c.accountId('alice.near','testnet'));
 a.throws(()=>c.networkConfig('unknown'));
 a.equal(c.networkConfig('mainnet').rpc,'https://rpc.mainnet.fastnear.com');
 const p=c.plan({...base,network:'mainnet',owner:'alice.near',initArgs:'{}'},b,price);
 a.equal(p.network,'mainnet');a.equal(p.target,'demo.alice.near');
 a.throws(()=>c.plan({...base,network:'mainnet'},b,price));
});
