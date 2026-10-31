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
