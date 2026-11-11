import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {ProcessSupervisor} from '../src/execution/processes.ts';

test('guardian proves a real Chromium tree drained after its Node launcher is killed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'veriq-t10-chrome-guardian-')),supervisor=new ProcessSupervisor(root,100);
 const server=createServer((_req,res)=>res.end('Real guardian browser target'));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert(address&&typeof address!=='string');
 try{
  const id="browser";
  const code=`import {chromium} from '@playwright/test';const b=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});const p=await b.newPage();await p.goto('http://127.0.0.1:${address.port}');console.log('ready');setInterval(()=>{},1000);`;
  const worker=await supervisor.start(id,{executable:process.execPath,args:['--input-type=module','-e',code],cwd:process.cwd(),env:{XDG_CONFIG_HOME:join(root,'config'),XDG_CACHE_HOME:join(root,'cache')}});
  await worker.firstLine();process.kill(worker.pid,'SIGKILL');await worker.exited;
  const receipt=await supervisor.terminateAttempt(id,'TEST_WORKER_CRASH');
  if(!receipt.processStopped){try{process.stderr.write('guardian: '+await readFile(join(root,id+'.drained.json.error'),'utf8'));}catch{}}
  assert.equal(receipt.processStopped,true,JSON.stringify(receipt));
 }finally{await supervisor.terminateAttempt('browser','TEST_FINALLY');server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
