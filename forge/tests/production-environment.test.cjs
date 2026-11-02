'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const compiler=require('../src/compiler-manager.cjs');
const reproducible=require('../src/reproducible-builder.cjs');

test('release subprocess inherits Windows essentials but never arbitrary secret variables',()=>{
 const canary='DO_NOT_EXPOSE_23456789';
 const env=compiler.productionEnvironment(path.join(os.tmpdir(),'forge-profile'),{
  Path:'C:\\Windows\\System32;C:\\Tools',
  SystemRoot:'C:\\Windows',TEMP:'C:\\Temp',TMP:'C:\\Temp',USERPROFILE:'C:\\Users\\test',
  APPDATA:'C:\\Users\\test\\AppData\\Roaming',LOCALAPPDATA:'C:\\Users\\test\\AppData\\Local',
  OPENAI_API_KEY:canary,GH_TOKEN:canary,GITHUB_TOKEN:canary,NPM_TOKEN:canary,
  NEAR_PRIVATE_KEY:canary,AWS_SECRET_ACCESS_KEY:canary,
  DOCKER_HOST:'tcp://remote-daemon.example:2375',
  HTTP_PROXY:'http://user:password@proxy.example:8080',NODE_OPTIONS:'--require malicious.js',
  GIT_CONFIG_GLOBAL:'C:\\secret-config',RUSTC_WRAPPER:'C:\\unexpected.exe'
 });
 assert.ok(env.PATH.includes('C:\\Windows\\System32'));
 assert.equal(env.SystemRoot,'C:\\Windows');
 assert.equal(env.USERPROFILE,'C:\\Users\\test');
 assert.equal(env.CARGO_TERM_COLOR,'never');
 assert.equal(env.GIT_TERMINAL_PROMPT,'0');
 for(const key of [
  'OPENAI_API_KEY','GH_TOKEN','GITHUB_TOKEN','NPM_TOKEN','NEAR_PRIVATE_KEY',
  'AWS_SECRET_ACCESS_KEY','DOCKER_HOST','HTTP_PROXY','NODE_OPTIONS','GIT_CONFIG_GLOBAL','RUSTC_WRAPPER'
 ])assert.equal(env[key],undefined,key);
 assert.ok(!JSON.stringify(env).includes(canary),'credential canary leaked into child environment');
 assert.ok(!JSON.stringify(env).includes('password@proxy'),'credentialed proxy leaked into child environment');
});

test('production environment does not accidentally inherit case-altered credential variables',()=>{
 const env=compiler.productionEnvironment(os.tmpdir(),{
  PATH:'C:\\Windows',openai_api_key:'SECRET_CANARY',GitHub_Token:'SECRET_CANARY',
  DOCKER_CONTEXT:'remote',https_proxy:'https://admin:token@proxy.example'
 });
 assert.equal(env.openai_api_key,undefined);
 assert.equal(env.GitHub_Token,undefined);
 assert.equal(env.DOCKER_CONTEXT,undefined);
 assert.equal(env.https_proxy,undefined);
 assert.ok(!JSON.stringify(env).includes('SECRET_CANARY'));
});

test('NEAR reproducible Cargo.toml blocks passed_env from default and variant metadata',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-env-manifest-'));
 try{
  const manifest=path.join(root,'Cargo.toml');
  const variants=[
   '[package.metadata.near.reproducible_build]\npassed_env = ["AWS_SECRET_ACCESS_KEY"]',
   '[package.metadata.near.reproducible_build.variant.production]\n"passed_env" = ["GH_TOKEN"]',
   "[package.metadata.near.reproducible_build]\n'passed_env' = ['NEAR_PRIVATE_KEY']",
   '[package.metadata.near.reproducible_build]\nconfig={ passed_env=["OPENAI_API_KEY"] }'
  ];
  for(const value of variants){
   await fs.writeFile(manifest,value+'\n');
   await assert.rejects(()=>reproducible.forbidHostEnvForwarding(manifest),/passed_env/);
  }
  await fs.writeFile(manifest,'[package.metadata.near.reproducible_build]\nimage="trusted-image"\nimage_digest="sha256:123"\n');
  await assert.doesNotReject(()=>reproducible.forbidHostEnvForwarding(manifest));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('production build runs both git preflight and official cargo-near with the sanitized environment',async(t)=>{
 if(process.platform!=='win32'){t.skip('Windows CLI integration fixture');return;}
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-credential-check-'));
 const stage=await fs.mkdtemp(path.join(os.tmpdir(),'forge-credential-stage-'));
 const original={run:compiler.run,status:compiler.status};
 const saved=process.env.OPENAI_API_KEY;
 const seen=[];
 try{
  const git=(...args)=>{
   const res=spawnSync('git',args,{cwd:root,encoding:'utf8'});
   if(res.status!==0)throw Error('git '+args.join(' ')+' failed: '+res.stderr);
  };
  git('init','-q');git('config','user.email','test@example.invalid');git('config','user.name','Forge test');
  await fs.mkdir(path.join(root,'src'));
  await fs.writeFile(path.join(root,'Cargo.toml'),'[package]\nname="secure-example"\nversion="0.1.0"\n');
  await fs.writeFile(path.join(root,'Cargo.lock'),'# locked\n');
  await fs.writeFile(path.join(root,'src','lib.rs'),'pub fn hello() {}\n');
  git('add','Cargo.toml','Cargo.lock','src/lib.rs');git('commit','-qm','fixture');
  process.env.OPENAI_API_KEY='SECRET_RELEASE_CANARY';
  compiler.status=async()=>({
   ready:true,managedCargoNear:true,cargoNear:{detail:'cargo-near '+compiler.CARGO_NEAR}
  });
  compiler.run=async(command,args,options)=>{
   seen.push({command,args,env:options.env});
   assert.equal(options.env.OPENAI_API_KEY,undefined);
   assert.equal(options.env.NEAR_PRIVATE_KEY,undefined);
   assert.equal(options.env.DOCKER_HOST,undefined);
   if(command==='git')return original.run(command,args,options);
   assert.ok(command.endsWith('cargo-near.exe'),command);
   const outDir=args[args.indexOf('--out-dir')+1];
   await fs.mkdir(outDir,{recursive:true});
   await fs.writeFile(path.join(outDir,'contract.wasm'),Buffer.from([0,97,115,109,1,0,0,0,0,0]));
   return 'Mocked official compiler success';
  };
  const helpers={
   stageProject:async()=>({stage,sourceSha256:'fixture'}),
   wasmCandidates:async dir=>[{file:path.join(dir,'contract.wasm'),name:'contract.wasm'}]
  };
  const build=await reproducible.build({kind:'rust',root},path.join(root,'profile'),helpers);
  assert.equal(build.mode,'reproducible');
  assert.ok(seen.some(x=>x.command==='git'),'Git preflight was not exercised');
  assert.ok(seen.some(x=>x.command.endsWith('cargo-near.exe')),'Official cargo-near was not exercised');
 }finally{
  compiler.run=original.run;compiler.status=original.status;
  if(saved===undefined)delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY=saved;
  await fs.rm(root,{force:true,recursive:true});
  await fs.rm(stage,{force:true,recursive:true});
 }
});
