import { it, expect } from 'vitest';
import { fixture, step, a } from './helpers.js';
import { createStepContext } from '../src/context.js';
import { executeStep } from '../src/execute-step.js';
it('emits a real interrupted step as CANCELLED, without inventing a business failure', async () => {
 const f=await fixture(), controller=new AbortController();
 let release!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});
 f.hooks.set('/save',async()=>{controller.abort();await held;});
 const events: import('../src/context.js').LiveStepEvent[]=[];
 const context=createStepContext({...f.options,signal:controller.signal,onEvent:async event=>{events.push(event);}});
 try {
  const result=await executeStep(step({id:'interrupted',action:'apiRequest',method:'GET',path:'/save',timeoutMs:100}),context);
  expect(result.cancelled).toBe(true);
  expect(result.status).toBe('CANCELLED');
  expect(events.at(-1)).toMatchObject({type:'STEP_FINISHED',result:{status:'CANCELLED',errorCode:'CANCELLED'}});
 }finally{release();context.dispose();await f.close();}
});

it.each([false,true])('cancels an in-flight assertion while preserving already observed failure=%s', async priorFailure => {
 const f=await fixture(), controller=new AbortController();
 const events: import('../src/context.js').LiveStepEvent[]=[];
 const context=createStepContext({...f.options,signal:controller.signal,onEvent:async event=>{
  events.push(event);
  if(priorFailure && event.type==='ASSERTION_RESULT' && event.result.status==='FAILED')controller.abort();
 }});
 const plan=step({id:'assertion',action:'reload'},[
  a({id:'first',type:'ui',target:'text',operator:'textEquals',expected:'never',severity:'ERROR',timeoutMs:priorFailure?100:5000}),
  a({id:'second',type:'ui',target:'text',operator:'textEquals',expected:'never',severity:'ERROR',timeoutMs:5000}),
 ]);
 const timer=priorFailure?undefined:setTimeout(()=>controller.abort(),150);
 try {
  const result=await executeStep(plan,context);
  expect(result.status).toBe(priorFailure?'FAILED':'CANCELLED');
  expect(events.filter(e=>e.type==='ASSERTION_RESULT')).toHaveLength(priorFailure?1:0);
  if(priorFailure)expect(result.assertions[0]?.status).toBe('FAILED');
 }finally{clearTimeout(timer);context.dispose();await f.close();}
});
