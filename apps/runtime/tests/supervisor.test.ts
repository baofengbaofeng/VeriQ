import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessSupervisor } from '../src/execution/processes.ts';
// This test would fail if stop only killed the Node leader, or if child env inherited credentials.
test('owned Linux process group stops its real descendants and excludes parent secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'veriq-t10-process-'));
    process.env.VERIQ_DEVICE_TOKEN = 'parent-only-test-secret';
    const processes = new ProcessSupervisor(directory);
    try {
        const child = await processes.start('attempt-one', {
            executable: process.execPath,
            args: ['-e', `process.title='veriq_runner'; const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({pid:process.pid,child:child.pid,secret:process.env.VERIQ_DEVICE_TOKEN??null}));setInterval(()=>{},1000);`],
            cwd: directory,
        });
        const observed = JSON.parse(await child.firstLine());
        assert.equal(observed.secret, null);
        assert.equal((await readFile(`/proc/${observed.pid}/comm`, 'utf8')).trim(), 'veriq_runner');
        const receipt = await processes.terminateAttempt('attempt-one', 'USER_CANCELLED');
        assert.equal(receipt.processStopped, true);
        assert.equal(await processes.isRunning(observed.child), false);
        assert.deepEqual(processes.active(), []);
    }
    finally {
        delete process.env.VERIQ_DEVICE_TOKEN;
        await processes.terminateAttempt('attempt-one', 'TEST_FINALLY');
        await rm(directory, { recursive: true, force: true });
    }
});
test('an unrecognized journal never claims process stop or releases quarantine', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'veriq-t10-unknown-'));
    try {
        const processes = new ProcessSupervisor(directory);
        const receipt = await processes.terminateAttempt('unknown', 'RECOVERY');
        assert.equal(receipt.processStopped, false);
        assert.equal(receipt.reason, 'UNKNOWN_PROCESS');
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test('monotonic lease deadline kills a TERM-resistant owned process despite a skewed wall clock', async () => {
    const { Heartbeat } = await import('../src/agent/heartbeat.ts');
    const directory = await mkdtemp(join(tmpdir(), 'veriq-t10-deadline-'));
    const processes = new ProcessSupervisor(directory, 100);
    const originalNow = Date.now;
    try {
        const child = await processes.start('deadline', { executable: process.execPath, args: ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"], cwd: directory });
        await child.firstLine();
        Date.now = () => originalNow() + 864000000;
        let stopped!: (reason: string) => void;
        const finished = new Promise<string>(resolve => { stopped = resolve; });
        const sent = performance.now();
        const heartbeat = new Heartbeat({} as ConstructorParameters<typeof Heartbeat>[0], { attemptId: 'deadline', serverTime: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:00:02Z', leaseDurationMs: 2000 } as ConstructorParameters<typeof Heartbeat>[1], sent, performance.now(), reason => { void processes.terminateAttempt('deadline', reason).then(receipt => { assert(receipt.processStopped); stopped(reason); }); });
        heartbeat.start();
        assert.equal(await finished, 'LEASE_LOST');
        heartbeat.close();
        assert(performance.now() - sent < 2000);
        assert.equal(await processes.isRunning(child.pid), false);
    }
    finally {
        Date.now = originalNow;
        await processes.terminateAttempt('deadline', 'TEST_FINALLY');
        await rm(directory, { recursive: true, force: true });
    }
});

test('a restarted supervisor reconciles an owned live group, while changed start time stays unknown', async () => {
 const {writeFile}=await import('node:fs/promises');
 const directory=await mkdtemp(join(tmpdir(),'veriq-t10-recovery-'));
 const first=new ProcessSupervisor(directory);
 try{
  const child=await first.start('recovery',{executable:process.execPath,args:['-e',"console.log('ready');setInterval(()=>{},1000)"],cwd:directory});await child.firstLine();
  const path=join(directory,'recovery.process.json'),original=await readFile(path,'utf8');
  const journal=JSON.parse(original);await writeFile(path,JSON.stringify({...journal,startTime:'wrong'}),{mode:0o600});
  const recovered=new ProcessSupervisor(directory);
  const unknown=await recovered.terminateAttempt('recovery','RECOVERY');assert.equal(unknown.processStopped,false);assert.equal(await recovered.isRunning(child.pid),true);
  await writeFile(path,original,{mode:0o600});const stopped=await recovered.terminateAttempt('recovery','RECOVERY');assert.equal(stopped.processStopped,true);assert.equal(await recovered.isRunning(child.pid),false);
 }finally{await first.terminateAttempt('recovery','TEST_FINALLY');await rm(directory,{recursive:true,force:true});}
});

test('stop also confirms detached descendant process groups, as used by browser launchers',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'veriq-t10-detached-'));const supervisor=new ProcessSupervisor(directory,100);let detached:number|undefined;
 try{
  const child=await supervisor.start('detached',{executable:process.execPath,args:['-e',`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);`],cwd:directory});detached=Number(await child.firstLine());
  const stopped=await supervisor.terminateAttempt('detached','CANCELLED');assert.equal(stopped.processStopped,true);assert.equal(await supervisor.isRunning(detached),false);
 }finally{if(detached&&await supervisor.isRunning(detached))process.kill(-detached,'SIGKILL');await supervisor.terminateAttempt('detached','TEST_FINALLY');await rm(directory,{recursive:true,force:true});}
});

test('a changed execution UID in the private journal cannot authorize signalling a live process',async()=>{
 const {writeFile}=await import('node:fs/promises');
 const directory=await mkdtemp(join(tmpdir(),'veriq-t10-uid-')), supervisor=new ProcessSupervisor(directory);
 let original:string|undefined;
 const path=join(directory,'uid.process.json');
 try{
  const child=await supervisor.start('uid',{executable:process.execPath,args:['-e',"console.log('ready');setInterval(()=>{},1000)"],cwd:directory});await child.firstLine();
  original=await readFile(path,'utf8');
  await writeFile(path,JSON.stringify({...JSON.parse(original),uid:process.getuid!()+1}),{mode:0o600});
  const receipt=await supervisor.terminateAttempt('uid','RECOVERY');
  assert.equal(receipt.processStopped,false);
  assert.equal(await supervisor.isRunning(child.pid),true);
 }finally{if(original)await writeFile(path,original,{mode:0o600});await supervisor.terminateAttempt('uid','TEST_FINALLY');await rm(directory,{recursive:true,force:true});}
});
