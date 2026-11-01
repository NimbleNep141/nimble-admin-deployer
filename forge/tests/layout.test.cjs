'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const css=readFileSync(join(__dirname,'../src/style.css'),'utf8');
const html=readFileSync(join(__dirname,'../src/index.html'),'utf8');
test('deployment layout columns stretch to a common bottom edge',()=>{
 assert.match(css,/\.two-col\{[^}]*align-items:stretch\}/);
 assert.match(css,/#view-deploy \.two-col>\.stack>\.panel:last-child\{flex:1 1 auto\}/);
 assert.match(html,/id="view-deploy"/);
 assert.match(html,/02<\/span><b>Local signer<\/b>/);
 assert.match(html,/03<\/span><b>Deployment settings<\/b>/);
});
test('preflight uses full row width and the responsive stack is retained',()=>{
 assert.match(css,/#view-deploy>\.action-panel\{width:100%;max-width:none\}/);
 assert.match(css,/@media\(max-width:1110px\)\{#view-deploy \.two-col>\.stack>\.panel:last-child\{flex:none\}\}/);
 assert.match(css.slice(css.indexOf('@media(max-width:1110px)')),/\.two-col\{grid-template-columns:1fr\}/);
 assert.match(html,/04<\/span><b>Preflight & transaction review<\/b>/);
});
