'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../src/index.html'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'../src/style.css'),'utf8');
const js=fs.readFileSync(path.join(__dirname,'../src/renderer.js'),'utf8');
test('Forge branding, landing page and studio sections are present',()=>{
 for(const title of ['Nearium Forge','Smart Contract Deployment Studio','Compile','Deploy','Verify','My Contract Library'])
  assert.ok(html.toLowerCase().includes(title.toLowerCase()),title);
 for(const id of ['home','studio','view-deploy','view-library','view-verify','view-build','saved-select','deploy','preflight','verify-button','artifact-detail'])
  assert.ok(html.includes('id="'+id+'"'),id);
 assert.ok(css.includes('.home-hero'));
 assert.ok(css.includes('.forge-core'));
});
test('all literal renderer DOM element identifiers are defined',()=>{
 const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]));
 const uses=[...js.matchAll(/\bel\('([^']+)'\)/g)].map(x=>x[1]);
 const missing=uses.filter(x=>!ids.has(x));
 assert.deepEqual(missing,[],missing.join(','));
 assert.doesNotMatch(js,/\.innerHTML\s*=/);
 assert.doesNotMatch(js,/window\.confirm/);
});
test('CSP, local key input and dropdown library',()=>{
 assert.match(html,/default-src 'none'/);
 assert.match(html,/script-src 'self'/);
 assert.match(html,/type="password"/);
 assert.match(html,/<select id="saved-select"/);
 assert.match(js,/call\('save'/);
});

test('user-supplied Nearium Forge logo is used in header, landing hero, and app window',()=>{
 const logoPath=path.join(__dirname,'../src/assets/nearium-forge-logo.png');
 const raw=fs.readFileSync(logoPath);
 assert.deepEqual([...raw.subarray(0,8)],[137,80,78,71,13,10,26,10]);
 assert.equal(raw.readUInt32BE(16),600);
 assert.equal(raw.readUInt32BE(20),561);
 const digest=require('node:crypto').createHash('sha256').update(raw).digest('hex');
 assert.equal(digest,'df98085d831134ccef55cb738e633cb29e5cf87b0f356b1fc3f637d384153187');
 assert.match(html,/class="brand-logo" src="\.\/assets\/nearium-forge-logo\.png"/);
 assert.match(html,/class="hero-logo" src="\.\/assets\/nearium-forge-logo\.png"/);
 assert.doesNotMatch(html,/class="core-symbol"/);
 const main=fs.readFileSync(path.join(__dirname,'../src/main.cjs'),'utf8');
 assert.match(main,/icon:path\.join\(__dirname,'assets','nearium-forge-logo\.png'\)/);
});

test('Windows executable icon is derived from the supplied Nearium Forge logo',()=>{
 const ico=fs.readFileSync(path.join(__dirname,'../src/assets/nearium-forge-icon.ico'));
 assert.equal(ico.readUInt16LE(0),0);
 assert.equal(ico.readUInt16LE(2),1);
 assert.equal(ico.readUInt16LE(4),7);
 const digest=require('node:crypto').createHash('sha256').update(ico).digest('hex');
 assert.equal(digest,'512ddf3a1b820894fac870c511292b2fffc265e4c5830e35670d212295436bba');
 const pkg=JSON.parse(fs.readFileSync(path.join(__dirname,'../package.json'),'utf8'));
 assert.equal(pkg.build.win.icon,'src/assets/nearium-forge-icon.ico');
});
