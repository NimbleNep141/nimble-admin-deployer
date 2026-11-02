'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {gzipSync}=require('node:zlib');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const manager=require('../src/compiler-manager.cjs');
test('toolchain provider URLs and fixed cargo-near checksum are pinned',()=>{
 assert.match(manager.RUSTUP_BASE,/^https:\/\/static\.rust-lang\.org\/rustup\/archive\/1\.29\.0\//);
 assert.match(manager.NEAR_ARCHIVE,/^https:\/\/github\.com\/near\/cargo-near\/releases\/download\/cargo-near-v0\.22\.0\//);
 assert.equal(manager.NEAR_SHA256,'c50ad7e3e220923db006c43668f25bdbe0c4612ca6d6b48d08e3c0b7532bf122');
 for(const u of ['http://static.rust-lang.org/a','https://evil.example/a','https://github.com.evil.example/a'])
  assert.throws(()=>manager.checkFinalUrl(u,'github'),/Unexpected|insecure/i);
 assert.doesNotThrow(()=>manager.checkFinalUrl('https://release-assets.githubusercontent.com/a','github'));
 assert.throws(()=>manager.checkFinalUrl('https://github.com/near/cargo-near','rust'),/Unexpected/i);
});
test('contract compilation PATH uses local toolchain folders with no shell',()=>{
 const env=manager.environment('/example/local-profile');
 const key=Object.keys(env).find(x=>x.toLowerCase()==='path');
 assert.ok(env[key].includes('compiler'));
 assert.ok(env[key].includes('.cargo'));
 assert.equal(manager.TOOLCHAIN,'1.97.1');
 assert.equal(manager.TARGET,'wasm32-unknown-unknown');
});
function makeArchive({duplicate=false,exe=true}={}){
 const image=Buffer.alloc(60000);
 if(exe)image.write('MZ');
 const padded=Math.ceil(image.length/512)*512;
 const count=duplicate?2:1;
 const tar=Buffer.alloc(count*(512+padded)+1024);
 for(let i=0;i<count;i++){
  const offset=i*(512+padded);
  const header=tar.subarray(offset,offset+512);
  header.write('cargo-near.exe\0',0,'ascii');
  header.write((image.length.toString(8).padStart(11,'0')+'\0'),124,'ascii');
  header.write('0',156,'ascii');
  image.copy(tar,offset+512);
 }
 return gzipSync(tar);
}
test('verified archive parser extracts only the expected Windows executable',()=>{
 const binary=manager.cargoNearFromArchive(makeArchive());
 assert.equal(binary.length,60000);
 assert.equal(binary.toString('ascii',0,2),'MZ');
});
test('archive parser rejects missing executable and duplicate executables',()=>{
 assert.throws(()=>manager.cargoNearFromArchive(makeArchive({exe:false})),/Windows cargo-near executable/);
 assert.throws(()=>manager.cargoNearFromArchive(makeArchive({duplicate:true})),/Unexpected cargo-near archive layout/);
});
test('compiler installation is explicitly guarded on unsupported hosts',async()=>{
 if(process.platform==='win32'&&process.arch==='x64')return;
 await assert.rejects(()=>manager.status('/nope'),/Windows 10\/11 x64/);
 await assert.rejects(()=>manager.setup('/nope'),/Windows 10\/11 x64/);
});
test('native compiler is NOT exposed through Forge main or preload',()=>{
 const main=readFileSync(path.join(__dirname,'../src/main.cjs'),'utf8');
 const preload=readFileSync(path.join(__dirname,'../src/preload.cjs'),'utf8');
 const ui=readFileSync(path.join(__dirname,'../src/index.html'),'utf8');
 for(const name of ['compile-rust','compiler-setup','node-setup','js-install','js-build']){
  assert.doesNotMatch(main,new RegExp("bind\\('"+name+"'"));
  assert.doesNotMatch(preload,new RegExp("invoke\\('"+name+"'"));
 }
 assert.doesNotMatch(main,/spawn\('cargo'/);
 assert.doesNotMatch(main,/compilerManager\.setup\(/);
 assert.match(ui,/Docker Build Environment/);
 assert.match(ui,/id="compiler-check"/);
 assert.match(ui,/id="compiler-log"/);
 assert.match(preload,/isolatedBuild:args=>invoke\('isolated-build',args\)/);
 assert.doesNotMatch(preload,/spawn|require\('node:fs'\)/);
});
