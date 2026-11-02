'use strict';
const assert=require('node:assert/strict');
const {NETWORKS}=require('../src/core.cjs');
async function query(chain,method,params){
 const response=await fetch(chain.rpc,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(25000),
  body:JSON.stringify({jsonrpc:'2.0',id:'forge-ci-read-only',method,params})});
 if(!response.ok)throw Error(chain.id+' RPC '+method+' HTTP '+response.status);
 const body=await response.json();
 if(body.error)throw Error(chain.id+' RPC '+method+': '+JSON.stringify(body.error).slice(0,350));
 return body.result;
}
(async()=>{
 for(const chain of Object.values(NETWORKS)){
  const status=await query(chain,'status',[]);
  assert.equal(status.chain_id,chain.id,'RPC chain mismatch for '+chain.id);
  const height=Number(status.sync_info?.latest_block_height||0);
  assert.ok(height>1000,chain.id+' must have a real block height');
  const p=await query(chain,'EXPERIMENTAL_protocol_config',{finality:'final'});
  assert.equal(p.chain_id,chain.id,'Protocol config chain mismatch for '+chain.id);
  assert.match(String(p.runtime_config?.storage_amount_per_byte||''),/^\d+$/);
  process.stdout.write('Verified '+chain.id+' read-only RPC status and storage price; block '+height+'\n');
 }
})().catch(e=>{console.error(e);process.exitCode=1});
