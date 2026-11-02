'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const editor=require('../src/source-editor.cjs');

async function fixture(run){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'forge-editor-test-'));
 const root=path.join(temp,'project');await fs.mkdir(path.join(root,'src'),{recursive:true});
 await fs.writeFile(path.join(root,'package.json'),'{"name":"example","scripts":{"build":"node build.js"}}');
 await fs.writeFile(path.join(root,'src','contract.ts'),'export const a = 1;\n');
 await fs.mkdir(path.join(root,'node_modules'),{recursive:true});
 await fs.writeFile(path.join(root,'node_modules','blocked.ts'),'secret');
 try{await run({temp,root});}finally{await fs.rm(temp,{recursive:true,force:true});}
}
test('project discovery lists only trusted editable sources and ignores dependencies',async()=>{
 await fixture(async({root})=>{
  const p=await editor.openProject(root);
  assert.equal(p.kind,'javascript');
  assert.ok(p.files.includes('src/contract.ts'));
  assert.ok(p.files.includes('package.json'));
  assert.ok(!p.files.some(f=>f.includes('node_modules')));
  assert.throws(()=>editor.safeRelative('../private.rs'),/outside/);
  assert.throws(()=>editor.safeRelative('node_modules/unsafe.js'),/outside/);
  assert.throws(()=>editor.safeRelative('src/sub.exe'),/source code/);
 });
});
test('editing saves a backup and protects against external edits',async()=>{
 await fixture(async({root,temp})=>{
  const project=await editor.openProject(root);
  const original=await editor.readSource(project,'src/contract.ts');
  const result=await editor.saveSource(project,'src/contract.ts','export const a = 2;\n',original.hash,temp);
  assert.equal(result.unchanged,false);
  assert.ok(result.backup.includes('source-backups'));
  assert.match(await fs.readFile(result.backup,'utf8'),/a = 1/);
  assert.match(await fs.readFile(path.join(root,'src/contract.ts'),'utf8'),/a = 2/);
  await fs.writeFile(path.join(root,'src/contract.ts'),'external change');
  await assert.rejects(()=>editor.saveSource(project,'src/contract.ts','other change',result.hash,temp),/changed on disk/);
  assert.equal(await fs.readFile(path.join(root,'src/contract.ts'),'utf8'),'external change');
 });
});
test('symlinks are excluded and escape attempts are blocked',async()=>{
 await fixture(async({root,temp})=>{
  const privateFile=path.join(temp,'secret.ts');await fs.writeFile(privateFile,'token');
  try{await fs.symlink(privateFile,path.join(root,'src','linked.ts'));}catch{return;}
  const project=await editor.openProject(root);
  assert.ok(!project.files.includes('src/linked.ts'));
  await assert.rejects(()=>editor.readSource(project,'src/linked.ts'),/escapes|symlink/i);
 });
});
test('rust projects and binary file rejection',async()=>{
 await fixture(async({root})=>{
  await fs.writeFile(path.join(root,'Cargo.toml'),'[package]\nname="sample"\n');
  await fs.writeFile(path.join(root,'src','lib.rs'),'fn main(){}');
  await fs.writeFile(path.join(root,'src','binary.rs'),Buffer.from([0,1,2]));
  const project=await editor.openProject(root);
  assert.equal(project.kind,'rust');
  const text=await editor.readSource(project,'src/lib.rs');
  assert.equal(text.text,'fn main(){}');
  await assert.rejects(()=>editor.readSource(project,'src/binary.rs'),/Binary/);
 });
});
