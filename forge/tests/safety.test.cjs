'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/main.cjs'),'utf8');
test('fixed network endpoints are chain-checked and browser renderer stays sandboxed',()=>{
 const core=require('../src/core.cjs');
 assert.equal(core.networkConfig('testnet').rpc,'https://rpc.testnet.fastnear.com');
 assert.equal(core.networkConfig('mainnet').rpc,'https://rpc.mainnet.fastnear.com');
 assert.match(source,/s\?\.chain_id!==chain.id/);
 assert.match(source,/data\?\.network!==activeNetwork/);
 assert.match(source,/signer.network!==activeNetwork/);
 assert.match(source,/switchingNetwork=true/);
 assert.match(source,/onBeforeRequest/);
 assert.match(source,/nodeIntegration:false/);
 assert.match(source,/contextIsolation:true/);
});
test('native Cancel-default dialog and no transaction auto retries',()=>{
 assert.match(source,/buttons:\['Cancel',mainnet\?'DEPLOY ON MAINNET':'Deploy Contract'\]/);
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

test('real funds have independent mainnet approval and network-specific attempt guard',()=>{
 assert.match(source,/data\.ackMainnet/);
 assert.match(source,/data\.confirmNetwork!=='MAINNET'/);
 assert.match(source,/attemptedTargets\.add\(activeNetwork\+':'\+p.target\)/);
 const html=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/index.html'),'utf8');
 for(const id of ['network-select','mainnet-gate','mainnet-ack','mainnet-word','mainnet-warning'])assert.ok(html.includes('id="'+id+'"'));
});
