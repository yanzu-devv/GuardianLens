import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGuardianServer} from '../src/server/index.js';
import {createCallbackProxy} from '../src/server/callbackProxy.js';
import type {TwilioConfig} from '../src/server/twilio.js';
import {trialCallbackCapability} from '../src/server/twilio.js';
const config: TwilioConfig={accountSid:'AC'+'a'.repeat(32),authToken:'b'.repeat(32),from:'+15555550101',allowedTo:['+15555550102'],publicOrigin:'https://callbacks.example'};
const sid='CA'+'c'.repeat(32);
async function fixture(t:TestContext,trial=false) {
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'guardianlens-voice-'));
  let creates=0;
  const app=await createGuardianServer({port:0,dataDir,publicOrigin:config.publicOrigin,quiet:true,voice:{config:{...config,trial},provider:{create:async()=>{creates++;return sid;},stop:async()=>{}}}});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  async function command(body:unknown){return fetch(app.origin+'/api/command',{method:'POST',headers:{Authorization:'Bearer '+app.ownerToken,'Content-Type':'application/json'},body:JSON.stringify(body)});}
  await command({type:'configure',config:{room:'Demo',address:'',locationMode:'device',consent:true,checkInSeconds:5,callSeconds:10,contacts:[{id:'one',name:'Demo recipient',phone:config.allowedTo[0],optedIn:true}]}});
  await command({type:'trigger',source:'example'});
  const incidentId=app.engine.snapshot.incident!.id;
  await command({type:'respond',incidentId,action:'help',actor:'desktop'});
  for(let i=0;i<100&&!app.engine.snapshot.incident!.attempts[0]?.providerCallSid;i++) await new Promise(r=>setTimeout(r,5));
  const attemptId=app.engine.snapshot.incident!.attempts[0]!.id;
  const base='/twilio/'+attemptId;
  async function webhook(action:string,patch:Record<string,string>={},badSignature=false,origin=app.origin){
    const form=new URLSearchParams({AccountSid:config.accountSid,CallSid:sid,From:config.from,To:config.allowedTo[0]!,CallStatus:'in-progress',...patch});
    const payload=config.publicOrigin+base+'/'+action+[...form.keys()].sort().map(k=>k+form.get(k)).join('');
    const signature=createHmac('sha1',config.authToken).update(payload).digest('base64');
    return fetch(origin+base+'/'+action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':badSignature?'bad':signature},body:form});
  }
  return {app,command,webhook,incidentId,attemptId,creates:()=>creates};
}
test('verified voice and keypad callbacks connect then acknowledge without resolving',async t=>{
  const f=await fixture(t);
  assert.equal(f.creates(),1);
  assert.equal((await f.webhook('voice',{},true)).status,403);
  assert.equal(f.app.engine.snapshot.incident!.attempts[0]!.status,'attempted');
  const response=await f.webhook('voice');assert.equal(response.status,200);assert.match(await response.text(),/Gather input="dtmf"/);
  assert.equal(f.app.engine.snapshot.incident!.status,'calling');
  assert.equal(f.app.engine.snapshot.incident!.attempts[0]!.status,'connected');
  assert.equal((await f.command({type:'call_outcome',attemptId:f.attemptId,outcome:'acknowledged'})).status,403);
  assert.equal((await f.command({type:'provider_call',attemptId:f.attemptId,callSid:sid})).status,400);
  assert.equal((await f.webhook('digits',{Digits:'1'})).status,200);
  assert.equal(f.app.engine.snapshot.incident!.status,'acknowledged');
  await f.webhook('status',{CallStatus:'completed'});await f.webhook('digits',{Digits:'1'});
  assert.equal(f.app.engine.snapshot.incident!.status,'acknowledged');assert.equal(f.creates(),1);
  assert.equal(f.app.engine.snapshot.incident!.events.filter(e=>e.kind==='caregiver_acknowledged').length,1);
});
test('trial proxy capabilities authenticate only the bound attempt and action through the callback proxy',async t=>{
  const f=await fixture(t,true);const proxy=await createCallbackProxy(0,Number(new URL(f.app.origin).port));
  t.after(()=>new Promise<void>(resolve=>proxy.close(()=>resolve())));
  const origin='http://127.0.0.1:'+String((proxy.address() as import('node:net').AddressInfo).port);
  const cap=(action:'voice'|'digits',id=f.attemptId)=>trialCallbackCapability({...config,trial:true},id,action);
  async function unsigned(action:string,token:string,patch:Record<string,string>={}){
    return fetch(`${origin}/twilio/${f.attemptId}/${action}?cap=${token}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({AccountSid:config.accountSid,CallSid:sid,From:config.from,To:config.allowedTo[0]!,CallStatus:'in-progress',...patch})});
  }
  assert.equal((await unsigned('voice',cap('voice','another-attempt'))).status,403);
  assert.equal((await unsigned('digits',cap('voice'))).status,403);
  assert.equal((await unsigned('status',cap('voice'))).status,403);
  assert.equal((await unsigned('voice',cap('voice'),{To:'+15555550999'})).status,403);
  assert.equal((await unsigned('voice',cap('voice'),{AccountSid:'AC'+'e'.repeat(32)})).status,403);
  assert.equal((await unsigned('voice',cap('voice'),{CallSid:'CA'+'e'.repeat(32)})).status,403);
  const voice=await unsigned('voice',cap('voice'));assert.equal(voice.status,200);const xml=await voice.text();
  assert.match(xml,/GuardianLens demo/);assert.ok(xml.includes('?cap='+cap('digits')));
  assert.equal((await unsigned('digits',cap('digits'),{Digits:'1'})).status,200);
  assert.equal(f.app.engine.snapshot.incident!.status,'acknowledged');
  assert.equal(f.creates(),1);
});
test('trial capability cannot authenticate unsigned requests in standard mode',async t=>{
  const f=await fixture(t);const cap=trialCallbackCapability({...config,trial:true},f.attemptId,'voice');
  const response=await fetch(`${f.app.origin}/twilio/${f.attemptId}/voice?cap=${cap}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({AccountSid:config.accountSid,CallSid:sid,From:config.from,To:config.allowedTo[0]!})});
  assert.equal(response.status,403);
});
test('signed callbacks must also match the account, participant, and call SID',async t=>{
  const f=await fixture(t);
  for(const patch of [{AccountSid:'AC'+'d'.repeat(32)},{CallSid:'CA'+'e'.repeat(32)},{To:'+15555550999'},{From:'+15555550999'}] as Record<string,string>[]) assert.equal((await f.webhook('digits',{Digits:'1',...patch})).status,403);
  assert.equal(f.app.engine.snapshot.incident!.status,'calling');
});
for(const digits of ['', '9']) test(`keypad ${digits||'timeout'} never acknowledges`,async t=>{
  const f=await fixture(t);await f.webhook('voice');await f.webhook('digits',{Digits:digits});
  assert.equal(f.app.engine.snapshot.incident!.status,'escalation_simulated');
  assert.equal(f.app.engine.snapshot.incident!.attempts[0]!.status,digits?'wrong_digit':'no_answer');
});
test('cancelled incidents return hangup and reject late acknowledgment',async t=>{
  const f=await fixture(t);await f.command({type:'respond',incidentId:f.incidentId,action:'okay',actor:'desktop'});
  const response=await f.webhook('voice');assert.match(await response.text(),/<Hangup\/>/);
  await f.webhook('digits',{Digits:'1'});assert.equal(f.app.engine.snapshot.incident!.status,'cancelled');
});
test('callback proxy exposes neither dashboard nor private API and forwards signed callbacks',async t=>{
  const f=await fixture(t);const proxy=await createCallbackProxy(0,Number(new URL(f.app.origin).port));
  t.after(()=>new Promise<void>(resolve=>proxy.close(()=>resolve())));
  const origin='http://127.0.0.1:'+String((proxy.address() as import('node:net').AddressInfo).port);
  for(const route of ['/','/api/state','/api/command','/assets/index.js']) assert.equal((await fetch(origin+route)).status,404);
  assert.equal((await f.webhook('voice',{},true,origin)).status,403);
  assert.equal((await f.webhook('voice',{},false,origin)).status,200);
});
