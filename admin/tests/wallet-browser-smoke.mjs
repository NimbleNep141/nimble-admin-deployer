// Browser-level regression test: Vite's successful bundling does not prove
// NEAR wallet-selector modules can execute in the actual browser runtime.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4173','--strictPort'],{
  cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe'],
});
let serverLogs='';
for(const stream of [server.stdout,server.stderr]) stream.on('data',chunk=>{serverLogs+=chunk.toString();});
async function serverReady() {
  for(let i=0;i<100;i++) {
    if(server.exitCode!==null) throw new Error('Vite preview terminated: '+serverLogs);
    try { const r=await fetch('http://127.0.0.1:4173/');if(r.ok)return; } catch {}
    await sleep(150);
  }
  throw new Error('Vite preview did not start: '+serverLogs);
}
let browser;
try {
  await serverReady();
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();
  const pageErrors=[];
  const consoleErrors=[];
  page.on('pageerror',e=>pageErrors.push(e.stack||e.message));
  page.on('console',msg=>{if(msg.type()==='error')consoleErrors.push(msg.text());});
  await page.goto('http://127.0.0.1:4173/',{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(
    () => {
      const text=document.getElementById('wallet-feedback')?.textContent||'';
      return text.includes('Wallet connection is ready') || text.startsWith('Connected to ');
    },undefined,{timeout:35000}
  ).catch(async e=>{
    const feedback=await page.locator('#wallet-feedback').textContent().catch(()=>'(not rendered)');
    const log=await page.locator('#logs').textContent().catch(()=>'(logs not rendered)');
    throw new Error('Wallet selector failed to initialize in Chromium. UI: '+feedback+' Logs: '+log+
      '\nBrowser exceptions: '+JSON.stringify(pageErrors)+'\nConsole errors: '+JSON.stringify(consoleErrors)+'\n'+e.message);
  });
  const status=await page.locator('#wallet-feedback').textContent();
  console.log('PASS: Browser initialized wallet providers. '+status);
  if(pageErrors.length)throw new Error('Uncaught browser errors: '+JSON.stringify(pageErrors));
} finally {
  if(browser) await browser.close();
  server.kill('SIGTERM');
  server.stdout.destroy();
  server.stderr.destroy();
}
