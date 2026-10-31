'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/main.cjs'),'utf8');
test('only fixed testnet RPC is allowed and browser renderer cannot navigate off-app',()=>{
 assert.match(source,/rpc\.testnet\.near\.org/);
 assert.match(source,/chain_id!=='testnet'/);
 assert.match(source,/onBeforeRequest/);
 assert.match(source,/nodeIntegration:false/);
 assert.match(source,/contextIsolation:true/);
});
test('native Cancel-default dialog and no transaction auto retries',()=>{
 assert.match(source,/buttons:\['Cancel','Deploy Contract'\]/);
 assert.match(source,/defaultId:0,cancelId:0/);
 assert.match(source,/if\(selection\.response!==1\)return \{cancelled:true\}/);
 assert.match(source,/retries:0/);
});
test('existing account mode cannot deploy to a different owner',()=>{
 const c=require('../src/core.cjs');
 const wasm=Buffer.from([0,97,115,109,1,0,0,0,10]);
 const p=c.plan({mode:'existing',owner:'alice.testnet',keyMode:'controlled',initArgs:'{}',gas:'30'},wasm,10n**19n);
 assert.equal(p.signer,'alice.testnet');assert.equal(p.target,'alice.testnet');
});
