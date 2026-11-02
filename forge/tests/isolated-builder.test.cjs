'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const isolated=require('../src/isolated-builder.cjs');
async function fixture(run){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nimble-iso-unit-'));
 const root=path.join(temp,'project');
 await fs.mkdir(path.join(root,'src'),{recursive:true});
 await fs.writeFile(path.join(root,'Cargo.toml'),'[package]\nname="example"\nversion="0.1.0"\n');
 await fs.writeFile(path.join(root,'Cargo.lock'),'# locked dependencies');
 await fs.writeFile(path.join(root,'src','lib.rs'),'pub fn hello(){}');
 await fs.writeFile(path.join(root,'.env'),'NEAR_PRIVATE_KEY=secret');
 await fs.writeFile(path.join(root,'src','wallet.json'),'{"secret_key":"secret"}');
 await fs.mkdir(path.join(root,'node_modules'));
 await fs.writeFile(path.join(root,'node_modules','package.json'),'{"name":"bad"}');
 try{await run({root,temp});}finally{await fs.rm(temp,{force:true,recursive:true});}
}
test('isolated build stages only allowed project sources, no private keys, env or npm credentials',async()=>{
 await fixture(async({root,temp})=>{
  const staged=await isolated.stageProject({root,kind:'rust'},temp);
  try{
   assert.ok(staged.sourceSha256.match(/^[0-9a-f]{64}$/));
   assert.ok(staged.files>=3);
   assert.equal(await fs.readFile(path.join(staged.workspace,'src','lib.rs'),'utf8'),'pub fn hello(){}');
   for(const file of ['.env','src/wallet.json','node_modules/package.json'])
    await assert.rejects(()=>fs.stat(path.join(staged.workspace,file)),/ENOENT/);
  }finally{await fs.rm(staged.stage,{force:true,recursive:true});}
 });
});
test('isolated Docker build args never mount original project, use limited privileges and offline network',()=>{
 const args=isolated.dockerArgs({workspace:path.resolve('/tmp/workspace'),name:'forge-12345678-1234-1234-1234-123456789012',
  image:isolated.RUST_IMAGE,command:['cargo','near','build']});
 const full=args.join(' ');
 for(const required of ['--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=192','--pull=never'])
  assert.ok(full.includes(required),required);
 for(const forbidden of ['--privileged','docker.sock','--pid=host','--network=host'])
  assert.ok(!full.includes(forbidden),forbidden);
 assert.match(isolated.RUST_IMAGE,/@sha256:[a-f0-9]{64}$/);
 assert.equal(args.at(-1),'build');
 const online=isolated.dockerArgs({workspace:path.resolve('/tmp/workspace'),name:'forge-12345678-1234-1234-1234-123456789012',
  image:isolated.NODE_IMAGE,network:true,command:['npm','ci']});
 assert.ok(online.includes('--network=bridge'));
 assert.ok(online.join(' ').includes('COREPACK_HOME=/work/.corepack'));
 assert.match(require('node:fs').readFileSync(path.join(__dirname,'../src/isolated-builder.cjs'),'utf8'),/corepack','pnpm','install/);
});
test('secret exclusion rules match hidden files, wallets and private keys',()=>{
 for(const name of ['.env','.npmrc','.ssh/id_rsa','src/private-key.pem','src/wallet.json','src/seed.txt','src/secrets.json','src/api-key.json','src/mnemonic.txt'])
  assert.equal(isolated.allowed(name),false,name);
 for(const name of ['src/lib.rs','Cargo.toml','Cargo.lock','package.json','package-lock.json','src/index.ts'])
  assert.equal(isolated.allowed(name),true,name);
});
test('WASM scan returns all valid artifacts without selecting a filename-based guess',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nimble-wasm-'));
 try{
  await fs.mkdir(path.join(root,'target'));
  const a=Buffer.alloc(20);a[0]=0;a[1]=97;a[2]=115;a[3]=109;
  await fs.writeFile(path.join(root,'target','one.wasm'),a);
  await fs.writeFile(path.join(root,'target','two.wasm'),a);
  const found=await isolated.wasmCandidates(root);
  assert.deepEqual(found.map(f=>f.name),['target/one.wasm','target/two.wasm']);
 }finally{await fs.rm(root,{force:true,recursive:true});}
});
test('main process and UI expose isolated compiler and source-upgrade guardrails',async()=>{
 const main=await fs.readFile(path.join(__dirname,'../src/main.cjs'),'utf8');
 const ui=await fs.readFile(path.join(__dirname,'../src/index.html'),'utf8');
 const renderer=await fs.readFile(path.join(__dirname,'../src/renderer.js'),'utf8');
 const preload=await fs.readFile(path.join(__dirname,'../src/preload.cjs'),'utf8');
 assert.match(main,/bind\('isolated-build'/);
 assert.match(main,/bind\('isolated-status'/);
 assert.match(main,/if\(report\.upgrade&&!data\.ackMigration\)/);
 assert.match(ui,/id="isolated-build"/);
 assert.match(ui,/id="upgrade-ack"/);
 assert.match(ui,/id="upgrade-start"/);
 assert.match(renderer,/artifactUpdate\(null\)/);
 assert.match(preload,/isolatedBuild:args=>invoke\('isolated-build',args\)/);
});
