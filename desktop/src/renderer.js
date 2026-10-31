'use strict';
const el=id=>document.getElementById(id);
let ready=false,preview=null,working=false;
function out(id,message,kind=''){el(id).textContent=message;el(id).className='readout '+kind;}
function status(id,message,kind=''){el(id).textContent=message;el(id).className=kind;}
function reset(){preview=null;ready=false;updateDeployButton();out('review','Configuration changed. Check the account again before deployment.');}
function request(){return {owner:el('owner').value.trim(),prefix:el('prefix').value.trim(),funding:el('funding').value.trim()};}
function target(){
  const {owner,prefix}=request();
  const candidate=prefix+'.'+owner;
  if(!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(prefix)||!owner.endsWith('.testnet'))return 'Enter a named .testnet owner account';
  return candidate;
}
function busy(value){
  working=value;
  for(const id of ['load','import','file','clear','check'])el(id).disabled=value;
  updateDeployButton();
}
function updateDeployButton(){
  const matched=Boolean(preview&&el('confirmation').value.trim()===preview.target);
  const acknowledged=el('ack').checked;
  const enabled=!working&&ready&&matched&&acknowledged;
  el('deploy').disabled=!enabled;
  el('deploy-hint').textContent=working?'Operation in progress. Do not submit again.':
    !ready?'Not ready: verify build, connect testnet key, then click Check On-chain Status & Funding.':
    !matched?'Enter the exact factory account address shown in Step 3.':
    !acknowledged?'Tick the deployment warning checkbox to enable Deploy Factory.':
    'Ready to deploy. Clicking Deploy Factory will open the native Windows approval dialog.';
}
async function invoke(method,data){
  const reply=await window.nearium[method](data);
  if(!reply?.ok)throw Error(reply?.error||'Unexpected error');
  return reply.data;
}
el('owner').addEventListener('input',()=>{el('target').textContent=target();reset();});
for(const field of ['prefix','funding'])el(field).addEventListener('input',()=>{el('target').textContent=target();reset();});
for(const field of ['ack','confirmation'])el(field).addEventListener('input',updateDeployButton);
el('load').addEventListener('click',async()=>{
  busy(true);try{
    const b=await invoke('loadBuild');
    status('stat-build','Verified','good');
    out('build-info','Verified factory WASM ('+b.bytes.toLocaleString()+' bytes)\nSHA-256: '+b.hash+'\nGitHub source commit: '+b.sourceCommit,'good');
    reset();
  }catch(e){out('build-info',e.message,'bad');status('stat-build','Failed','bad')}finally{busy(false)}
});
el('import').addEventListener('click',async()=>{
  const secret=el('secret').value;
  el('secret').value='';
  busy(true);
  try{
    const k=await invoke('importKey',{owner:el('owner').value.trim(),secret});
    status('stat-key','Local key ready','good');
    out('key-info','Full-access testnet key confirmed on-chain.\nAccount: '+k.owner+'\nPublic key: '+k.publicKey+'\nBalance: '+k.balance+' testnet NEAR\nNo key saved to disk.','good');
    reset();
  }catch(e){out('key-info',e.message,'bad');status('stat-key','Not connected','bad')}finally{busy(false)}
});
el('file').addEventListener('click',async()=>{
  busy(true);try{
    const k=await invoke('importFile',el('owner').value.trim());
    if(k.cancelled)return;
    status('stat-key','Local key ready','good');
    out('key-info','Testnet full-access key imported from local file.\nAccount: '+k.owner+'\nPublic key: '+k.publicKey+'\nNo key saved to disk.','good');
    reset();
  }catch(e){out('key-info',e.message,'bad')}finally{busy(false)}
});
el('clear').addEventListener('click',async()=>{
  busy(true);try{await invoke('clearKey');status('stat-key','Disconnected');out('key-info','Local signer disconnected. Close the application to clear the process session.');reset()}catch(e){out('key-info',e.message,'bad')}finally{busy(false)}
});
el('check').addEventListener('click',async()=>{
  busy(true);reset();try{
    const p=await invoke('preview',request());preview=p;
    el('target').textContent=p.target;
    if(p.exists){
      status('stat-factory','Already exists','bad');
      out('review','STOP: '+p.target+' already exists.\nExisting access keys: '+p.existing.keys+'\nReported owner: '+(p.existing.owner||'unknown')+'\nDo not overwrite this account.','bad');
    }else{
      status('stat-factory','Available',p.canDeploy?'good':'');
      out('review','Target: '+p.target+'\nFunding: '+p.funding+' testnet NEAR\nMinimum storage estimate: '+p.minFunding+' NEAR\nOwner balance (total): '+(p.ownerBalance??'not available')+' testnet NEAR\n'+(p.canDeploy?'READY. Confirm exact factory address and warnings below.':'NOT READY: '+p.reason),p.canDeploy?'good':'bad');
    }
    ready=p.canDeploy;updateDeployButton();
  }catch(e){out('review',e.message,'bad');status('stat-factory','Check failed','bad')}finally{busy(false)}
});
el('deploy').addEventListener('click',async()=>{
  if(!ready||!preview){out('result','Not ready. Verify factory build, import local signer, then check account and funding.','bad');return;}
  if(!el('ack').checked){out('result','Acknowledge the deployment warning first.','bad');return;}
  if(preview.target!==el('confirmation').value.trim()){out('result','The typed factory account does not match the checked target.','bad');return;}
  busy(true);ready=false;
  out('result','Checking again and opening native Windows confirmation. No transaction submitted yet.');
  try{
    const result=await invoke('deploy',{...request(),confirmation:el('confirmation').value.trim(),acknowledge:el('ack').checked});
    if(result.cancelled){out('result','Deployment cancelled. No transaction was submitted.');return;}
    const verified=result.verified&&!result.failed;
    out('result','Factory: '+result.account+'\\nTransaction: '+(result.txHash||'unavailable')+
      '\\nStatus: '+(verified?'DEPLOYED AND VERIFIED':'NOT FULLY VERIFIED')+
      '\\nKeys: '+(result.factory?.keys??'unknown')+
      '\\nOwner: '+(result.factory?.owner??'unknown')+
      (result.warning?'\\nIMPORTANT: '+result.warning:''),verified?'good':'bad');
    status('stat-factory',verified?'Deployed':'Investigate',verified?'good':'bad');
  }catch(e){
    out('result','Deployment failed or status uncertain: '+e.message+'\\nCheck the NEAR testnet explorer BEFORE trying again.','bad');
  }finally{
    el('ack').checked=false;el('confirmation').value='';ready=false;busy(false);
  }
});
el('target').textContent=target();
updateDeployButton();
