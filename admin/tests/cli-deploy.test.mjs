import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCliPlan,preparationScript,deploymentScript,FACTORY_DOWNLOAD} from '../src/cli-deploy.js';
const cfg={owner:'alice.testnet',prefix:'launchpad',funding:'6',hash:'a'.repeat(64),wasmSize:164336,storageBytePrice:10n**19n};
test('CLI plan validates owner and produces keyless deploy command',()=>{
  const p=buildCliPlan(cfg);
  assert.equal(p.factory,'launchpad.alice.testnet');
  const s=deploymentScript(p);
  for(const fragment of ['receiver-id $FACTORY','add-action create-account','add-action transfer "6 NEAR"','add-action deploy use-file','with-init-call new','file-args "$INIT_FILE"','prepaid-gas "30 Tgas"','network-config testnet sign-with-keychain send'])assert.ok(s.includes(fragment),fragment);
  assert.ok(!/add-action add-key|seed.phrase|private.key/i.test(s));
});
test('local preparation checks exact trusted wasm hash and creates owner init json',()=>{
  const s=preparationScript(buildCliPlan(cfg));
  assert.ok(s.includes(FACTORY_DOWNLOAD));assert.ok(s.includes('Get-FileHash'));
  assert.ok(s.includes(cfg.hash));assert.ok(s.includes('@{ owner = $OWNER } | ConvertTo-Json'));
  assert.ok(!s.includes('Invoke-Expression'));
});
test('rejects hostile, invalid, mainnet or too long owner names',()=>{
  for(const owner of ['alice.near',"bob';rm.testnet",'bob.testnet;echo','invalid name.testnet','a'.repeat(61)+'.testnet'])
    assert.throws(()=>buildCliPlan({...cfg,owner}));
});
test('rejects untrusted hashes, unsafe funding, storage deficits and prefixes',()=>{
  for(const patch of [{hash:'abc'},{funding:'0.5'},{wasmSize:4000001},{storageBytePrice:10n**23n},{prefix:'Capital'}])
    assert.throws(()=>buildCliPlan({...cfg,...patch}));
});
