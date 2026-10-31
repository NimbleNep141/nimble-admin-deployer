'use strict';
const el=id=>document.getElementById(id);
let ready=false,preview=null,working=false;
function out(id,message,kind=''){el(id).textContent=message;el(id).className='readout '+kind;}
function status(id,message,kind=''){el(id).textContent=message;el(id).className=kind;}
function reset(){preview=null;ready=false;el('deploy').disabled=true;out('review','Configuration changed. Check the account again before deployment.');}
function request(){return {owner:el('owner').value.trim(),prefix:el('prefix').value.trim(),funding:el('funding').value.trim()};}
function target(){
  const {owner,prefix}=request();
  const candidate=prefix+'.'+owner;
  if(!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(prefix)||!owner.endsWith('.testnet'))return 'Enter a named .testnet owner account';
  return candidate;
}
function busy(value){working=value;for(const id of ['load','import','file','clear','check','deploy'])el(id).disabled=value||id==='deploy'&&!ready;}
async function invoke(method,data){
  const reply=await window.nearium[method](data);
  if(!reply?.ok)throw Error(reply?.error||'Unexpected error');
  return reply.data;
}
el('owner').addEventListener('input',()=>{el('target').textContent=target();reset();});
for(const field of ['prefix','funding'])el(field).addEventListener('input',()=>{el('target').textContent=target();reset();});
for(const field of ['ack','confirmation'])el(field).addEventListener('input',()=>{
  el('deploy').disabled=working||!ready||!el('ack').checked||el('confirmation').value.trim()!==preview?.target;
});
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
    ready=p.canDeploy;el('deploy').disabled=!ready||!el('ack').checked||el('confirmation').value.trim()!==p.target;
  }catch(e){out('review',e.message,'bad');status('stat-factory','Check failed','bad')}finally{busy(false)}
});
el('deploy').addEventListener('click',async()=>{
  if(!ready||!preview||preview.target!==el('confirmation').value.trim())return;
  if(!window.confirm('Submit ONE NEAR TESTNET deployment transaction to '+preview.target+' with '+preview.funding+' testnet NEAR? This cannot be undone, and a failure might leave a keyless funded account.'))return;
  busy(true);ready=false;
  out('result','Signing and submitting locally. If this stalls, check NEAR testnet explorer before retrying.');
  try{
    const result=await invoke('deploy',{...request(),confirmation:el('confirmation').value.trim(),acknowledge:el('ack').checked});
    const msg='Factory: '+result.account+'\nTransaction: '+(result.txHash||'hash unavailable')+'\nStatus: '+(result.verified&&!result.failed?'DEPLOYED AND VERIFIED':'NOT FULLY VERIFIED')+'\nKeys: '+(result.factory?.keys??'unknown')+'\nOwner: '+(result.factory?.owner??'unknown')+(result.warning?'\nIMPORTANT: '+result.warning:'');
    out('result',msg,result.verified&&!result.failed?'good':'bad');
    status('stat-factory',result.verified&&!result.failed?'Deployed':'Investigate',result.verified&&!result.failed?'good':'bad');
  }catch(e){out('result','Uncertain or failed deployment: '+e.message+'\nInspect the blockchain BEFORE trying again.','bad')}
  finally{el('ack').checked=false;el('confirmation').value='';busy(false)}
});
el('target').textContent=target();
