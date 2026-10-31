'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const renderer=fs.readFileSync(path.join(__dirname,'../src/renderer.js'),'utf8');
const main=fs.readFileSync(path.join(__dirname,'../src/main.cjs'),'utf8');

function prepare(deployReply) {
  const ids=['owner','prefix','funding','secret','ack','confirmation','load','import','file','clear',
    'check','deploy','build-info','key-info','review','result','target','stat-build','stat-key','stat-factory'];
  const elements=new Map(ids.map(id=>[id,{
    id,value:'',checked:false,disabled:false,textContent:'',className:'',events:{},
    addEventListener(name,fn){this.events[name]=fn;}
  }]));
  elements.get('owner').value='owner.testnet';
  elements.get('prefix').value='launchpad';
  elements.get('funding').value='6';
  const sent=[];
  const window={
    confirm(){throw Error('Never call browser window.confirm for deployment!');},
    nearium:{
      preview:async()=>({ok:true,data:{
        canDeploy:true,exists:false,target:'launchpad.owner.testnet',owner:'owner.testnet',
        funding:'6',minFunding:'2',ownerBalance:'25'
      }}),
      deploy:async req=>{sent.push(req);return deployReply;}
    }
  };
  vm.runInNewContext(renderer,{document:{getElementById(id){return elements.get(id);}},window});
  return {
    el:id=>elements.get(id),
    click:id=>elements.get(id).events.click(),
    input:id=>elements.get(id).events.input(),
    sent,
  };
}
async function readyForDeployment(ui){
  await ui.click('check');
  ui.el('ack').checked=true;
  ui.el('confirmation').value='launchpad.owner.testnet';
  ui.input('confirmation');
  assert.equal(ui.el('deploy').disabled,false);
}
test('Deploy Factory sends request to main native confirmation and handles cancellation',async()=>{
  const ui=prepare({ok:true,data:{cancelled:true}});
  await readyForDeployment(ui);
  await ui.click('deploy');
  assert.equal(ui.sent.length,1);
  assert.equal(ui.sent[0].acknowledge,true);
  assert.match(ui.el('result').textContent,/cancelled.*No transaction was submitted/i);
  assert.equal(ui.el('deploy').disabled,true);
});
test('Deploy Factory visibly reports successful on-chain verification',async()=>{
  const ui=prepare({ok:true,data:{account:'launchpad.owner.testnet',txHash:'testhash',
    verified:true,failed:false,factory:{keys:0,owner:'owner.testnet'}}});
  await readyForDeployment(ui);
  await ui.click('deploy');
  assert.match(ui.el('result').textContent,/DEPLOYED AND VERIFIED/);
  assert.match(ui.el('result').textContent,/Keys: 0/);
  assert.equal(ui.sent.length,1);
});
test('RPC or signing failure displays an error and does not retry',async()=>{
  const ui=prepare({ok:false,error:'RPC result uncertain'});
  await readyForDeployment(ui);
  await ui.click('deploy');
  assert.match(ui.el('result').textContent,/RPC result uncertain/);
  assert.match(ui.el('result').textContent,/BEFORE trying again/i);
  assert.equal(ui.sent.length,1);
});
test('main process uses native confirmation with Cancel as default before signing',()=>{
  assert.match(main,/dialog\.showMessageBox\(parent/);
  assert.match(main,/buttons:\['Cancel','Deploy Factory'\]/);
  assert.match(main,/defaultId:0/);
  assert.match(main,/cancelId:0/);
  assert.match(main,/answer\.response!==1\)return \{cancelled:true/);
  assert.ok(main.indexOf('answer.response!==1')<main.indexOf('const txActions=factoryActions'));
  assert.doesNotMatch(renderer,/if\(!window\.confirm/);
});
