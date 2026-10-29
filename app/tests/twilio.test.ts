import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Engine } from '../src/server/engine.js';
import { CallCoordinator, TwilioVoice, TwilioRequestError, readTwilioConfig, validTwilioSignature, gatherTwiml, spokenIncidentLocation, type VoiceProvider, type TwilioConfig } from '../src/server/twilio.js';
import { validateSavedSnapshot } from '../src/server/security.js';
const sid = 'CA' + 'a'.repeat(32);
const config: TwilioConfig = { accountSid: 'AC' + 'b'.repeat(32), authToken: 'c'.repeat(32), from: '+15555550101', allowedTo: ['+15555550102'], publicOrigin: 'https://callbacks.example' };
test('spoken call location uses the incident address and escapes it before keypad input',()=>{
  const location={mode:'manual' as const,label:'Desk',address:'123 Main Street, Boston, MA <Gate> & unit 2',fix:null,availability:'manual' as const,note:null};
  const twiml=gatherTwiml('https://callbacks.example/digits',20,location);
  assert.match(twiml,/123 Main Street, Boston, MA &lt;Gate&gt; &amp; unit 2/);
  assert.ok(twiml.indexOf('123 Main Street')<twiml.indexOf('<Gather'));
  assert.match(twiml,/Confirm this is where they are now/);
});
test('spoken shared coordinates include directions, accuracy, and stale warnings at call time',()=>{
  const location={mode:'device' as const,label:'Laptop',address:'',fix:{latitude:12.34567,longitude:-76.54321,accuracy:35.1,capturedAt:1000},availability:'current' as const,note:null};
  const fresh=spokenIncidentLocation(location,2000);
  assert.match(fresh,/12 point 3 4 5 6 7 degrees north/);assert.match(fresh,/76 point 5 4 3 2 1 degrees west/);
  assert.match(fresh,/accuracy: 36 meters/);assert.doesNotMatch(fresh,/out of date/);
  assert.match(spokenIncidentLocation(location,122000),/older than two minutes/);
  assert.match(spokenIncidentLocation({...location,availability:'stale'},2000),/out of date/);
});
test('missing location or address is stated plainly without inventing a place',()=>{
  assert.match(spokenIncidentLocation(),/location is unavailable/);
  assert.match(spokenIncidentLocation({mode:'manual',label:'Desk',address:'',fix:null,availability:'manual',note:null}),/No address was entered/);
  assert.match(spokenIncidentLocation({mode:'device',label:'Desk',address:'',fix:null,availability:'unavailable',note:null}),/unavailable when the incident started/);
});
function harness(provider: VoiceProvider, saved: () => Promise<boolean> = async () => true) {
  const engine = new Engine({ callMode: 'twilio' });
  engine.command({type:'configure',config:{room:'Demo',address:'',locationMode:'device',consent:true,checkInSeconds:5,callSeconds:10,contacts:[{id:'a',name:'Demo contact',phone:config.allowedTo[0]!,optedIn:true}]}});
  engine.command({type:'trigger',source:'example'});
  const id=engine.snapshot.incident!.id;
  engine.command({type:'respond',incidentId:id,action:'help',actor:'desktop'});
  const calls=new CallCoordinator(provider,()=>engine.snapshot,c=>engine.command(c),saved);
  return {engine,calls,id,attempt:()=>engine.snapshot.incident!.attempts[0]!};
}

test('Twilio configuration fails closed without every required live setting', () => {
  assert.equal(readTwilioConfig({}), undefined);
  for(const patch of [{CALL_MODE:'typo'},{CALL_MODE:'twilio'}]) assert.throws(()=>readTwilioConfig(patch));
  const env={CALL_MODE:'twilio',TWILIO_ACCOUNT_SID:config.accountSid,TWILIO_AUTH_TOKEN:config.authToken,TWILIO_FROM_NUMBER:config.from,TWILIO_ALLOWED_TO:config.allowedTo.join(',')};
  assert.deepEqual(readTwilioConfig(env,config.publicOrigin),config);
  for(const origin of ['http://example.com','https://example.com/path','https://example.com:8443']) assert.throws(()=>readTwilioConfig(env,origin));
});
test('form signatures match the published Twilio test vector and reject tampering',()=>{
  const fields=new URLSearchParams({CallSid:'CA1234567890ABCDE',Caller:'+14158675310',Digits:'1234',From:'+14158675310',To:'+18005551212'});
  const url='https://example.com/myapp.php?foo=1&bar=2';
  assert.equal(validTwilioSignature('12345',url,fields,'L/OH5YylLD5NRKLltdqwSvS0BnU='),true);
  assert.equal(validTwilioSignature('12345',url+'/changed',fields,'L/OH5YylLD5NRKLltdqwSvS0BnU='),false);
  fields.append('Digits','1');
  assert.equal(validTwilioSignature('12345',url,fields,'L/OH5YylLD5NRKLltdqwSvS0BnU='),false);
});
test('Twilio REST calls use the fixed endpoint, allowlist, DTMF URLs, and no recording',async()=>{
  const requests: RequestInit[]=[];
  const voice=new TwilioVoice(config,async(url,init)=>{assert.match(String(url),/^https:\/\/api.twilio.com\/2010-04-01\/Accounts\/AC/);requests.push(init!);return new Response(JSON.stringify({sid}));});
  await assert.rejects(voice.create('+15555550999','test',10));
  assert.equal(requests.length,0);
  assert.equal(await voice.create(config.allowedTo[0]!,'test',10),sid);
  const form=requests[0]!.body as URLSearchParams;
  assert.equal(form.get('To'),config.allowedTo[0]);assert.equal(form.get('Record'),'false');assert.equal(form.get('TimeLimit'),'100');
  assert.equal(form.get('Url'),config.publicOrigin+'/twilio/test/voice');assert.deepEqual(form.getAll('StatusCallbackEvent'),['initiated','ringing','answered','completed']);
  assert.equal(requests[0]!.redirect,'error');
  assert.match(gatherTwiml(config.publicOrigin+'/digits?a=1&b=2',10),/input="dtmf" numDigits="1"/);
  assert.match(gatherTwiml(config.publicOrigin+'/digits?a=1&b=2',10),/&amp;b=2/);
});
test('repeated reconciliation places exactly one call and persists its provider ID',async()=>{
  let creates=0;const {engine,calls,attempt}=harness({create:async()=>{creates++;return sid;},stop:async()=>{}});
  await Promise.all([calls.sync(),calls.sync(),calls.sync()]);await calls.sync();
  assert.equal(creates,1);assert.equal(attempt().providerCallSid,sid);assert.doesNotThrow(()=>validateSavedSnapshot(engine.snapshot));
});
test('provider rejection exposes only its numeric code, without sensitive response details',async()=>{
  const voice=new TwilioVoice(config,async()=>new Response(JSON.stringify({code:21210,message:'Private phone and account details'}),{status:400}));
  const {engine,calls}=harness(voice);
  await calls.sync();
  const events=JSON.stringify(engine.snapshot.incident!.events);
  assert.match(events,/error 21210/);
  assert.doesNotMatch(events,/Private phone/);
  assert.equal(engine.snapshot.incident!.attempts[0]!.providerCallSid,undefined);
});
test('new trial requests omit unsupported options and retain the callback URL',async()=>{
  const voice=new TwilioVoice({...config,trial:true},async(_url,init)=>{
    const form=init!.body as URLSearchParams;
    assert.deepEqual([...form.keys()].sort(),['From','StatusCallback','To','Url']);
    assert.equal(form.get('StatusCallback'),config.publicOrigin+'/twilio/demo/status');
    return new Response(JSON.stringify({sid}));
  });
  assert.equal(await voice.create(config.allowedTo[0]!,'demo',10),sid);
});
test('generic trial validation error zero is retained',async()=>{
  const voice=new TwilioVoice(config,async()=>new Response(JSON.stringify({code:0,message:'Request validation failed'}),{status:400}));
  const {engine,calls}=harness(voice);await calls.sync();
  assert.ok(engine.snapshot.incident!.events.some(e=>e.message.includes('error 0')));
});
test('cancellation during call creation cancels the returned SID without another call',async()=>{
  let finish!:(sid:string)=>void;const stopped:string[]=[];
  const {engine,calls,id,attempt}=harness({create:()=>new Promise(r=>{finish=r;}),stop:async s=>{stopped.push(s);}});
  const pending=calls.sync();await new Promise(r=>setImmediate(r));
  engine.command({type:'respond',incidentId:id,action:'okay',actor:'desktop'});finish(sid);await pending;await calls.sync();
  assert.equal(attempt().providerCallSid,sid);assert.deepEqual(stopped,[sid]);assert.equal(engine.snapshot.incident!.status,'cancelled');
});
test('an uncertain create failure stops the plan and is never retried',async()=>{
  let creates=0;const {engine,calls}=harness({create:async()=>{creates++;throw new TwilioRequestError(false);},stop:async()=>{}});
  await calls.sync();await calls.sync();assert.equal(creates,1);assert.equal(engine.snapshot.incident!.status,'escalation_simulated');assert.ok(engine.snapshot.incident!.events.some(e=>e.kind==='provider_delivery_unknown'));
});
test('failed persistence blocks an outbound call',async()=>{
  let creates=0;const {calls}=harness({create:async()=>{creates++;return sid;},stop:async()=>{}},async()=>false);
  await calls.sync();assert.equal(creates,0);
});
test('restarting cancels recorded provider calls and never replays them',async()=>{
  const first=harness({create:async()=>sid,stop:async()=>{}});await first.calls.sync();
  const engine=new Engine({snapshot:first.engine.snapshot,callMode:'twilio'});let creates=0,stops=0;
  const calls=new CallCoordinator({create:async()=>{creates++;return sid;},stop:async()=>{stops++;}},()=>engine.snapshot,c=>engine.command(c),async()=>true);
  await calls.sync();assert.equal(creates,0);assert.equal(stops,1);assert.equal(engine.snapshot.incident!.status,'escalation_simulated');
});
test('a failed cancellation is visible and blocks the next contact',async()=>{
  const first=harness({create:async()=>sid,stop:async()=>{throw new Error('failure');}});await first.calls.sync();
  first.engine.command({type:'call_outcome',attemptId:first.attempt().id,outcome:'no_answer'});await first.calls.sync();
  assert.ok(first.engine.snapshot.incident!.events.some(e=>e.kind==='provider_cancel_failed'));
});

test('an uncertain call request remains visible even when the incident was cancelled meanwhile',async()=>{
  let fail!:(error:Error)=>void;
  const f=harness({create:()=>new Promise((_,reject)=>{fail=reject;}),stop:async()=>{}});
  const pending=f.calls.sync();await new Promise(r=>setImmediate(r));
  f.engine.command({type:'respond',incidentId:f.id,action:'okay',actor:'desktop'});fail(new TwilioRequestError(false));await pending;
  assert.equal(f.engine.snapshot.incident!.status,'cancelled');
  assert.ok(f.engine.snapshot.incident!.events.some(e=>e.kind==='provider_delivery_unknown'));
});

test('a cancelled call archived during creation is stopped using the returned SID',async()=>{
  let finish!:(sid:string)=>void;const stopped:string[]=[];
  const f=harness({create:()=>new Promise(r=>{finish=r;}),stop:async s=>{stopped.push(s);}});
  const pending=f.calls.sync();await new Promise(r=>setImmediate(r));
  f.engine.command({type:'respond',incidentId:f.id,action:'okay',actor:'desktop'});
  f.engine.command({type:'reset'});finish(sid);await pending;
  assert.deepEqual(stopped,[sid]);assert.equal(f.engine.snapshot.history[0]!.attempts[0]!.providerCallSid,sid);
});
