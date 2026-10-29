import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentText, createExampleIncident } from '../src/web/IncidentHistory.js';

test('an exported example always identifies itself as a preview rather than a recorded event', () => {
  const example = createExampleIncident();
  const before = JSON.stringify(example);
  const text = buildIncidentText(example);
  assert.match(text, /EXAMPLE PREVIEW ONLY/);
  assert.match(text, /not a recorded incident/);
  assert.match(text, /Help arrival: not verified/);
  assert.match(text, /not a clinician assessment/);
  assert.equal(JSON.stringify(example), before);
});

test('legacy records export unknown location and never invent a current address', () => {
  const incident = createExampleIncident();
  incident.id = 'legacy-record';
  delete incident.location;
  const text = buildIncidentText(incident);
  assert.match(text, /Location was not captured for this record/);
  assert.doesNotMatch(text, /Illustrative location/);
  assert.match(text, /Loss of consciousness: not established/);
  assert.match(text, /Breathing: not assessed/);
});

test('human accounts preserve report provenance, unknown fields, and unresolved acknowledgment', () => {
  const incident = createExampleIncident();
  incident.id = 'reported-record';
  incident.status = 'acknowledged';
  incident.events = incident.events.filter(event => event.kind !== 'resolved');
  incident.report = { reportedBy: 'witness', context: 'Witness says the person was standing beside a chair.', symptomsBefore: '', injury: 'Person reported wrist pain.', recovery: '', recordedAt: incident.createdAt + 90_000 };
  const text = buildIncidentText(incident);
  assert.match(text, /Acknowledged · unresolved/);
  assert.match(text, /witness-reported/);
  assert.match(text, /not clinically verified/);
  assert.match(text, /Symptoms beforehand: Not recorded/);
  assert.match(text, /Person reported wrist pain/);
  assert.match(text, /No operator-resolution event recorded/);
  assert.equal(incident.status, 'acknowledged');
});

test('camera exports preserve frozen location uncertainty and do not equate an unanswered app with unconsciousness', () => {
  const incident = createExampleIncident();
  incident.id = 'camera-record';
  incident.source = 'camera';
  incident.events = [];
  incident.location = { mode: 'device', label: 'Test laptop', address: '', fix: { latitude: 10, longitude: 20, accuracy: 125, capturedAt: incident.createdAt - 150_000 }, availability: 'stale', note: 'This device location was stale at detection.' };
  const text = buildIncidentText(incident);
  assert.match(text, /CAMERA EVENT/);
  assert.match(text, /10\.000000, 20\.000000/);
  assert.match(text, /accuracy ±125 m/);
  assert.match(text, /stale/);
  assert.match(text, /not confirmed person location/);
  assert.match(text, /No unanswered-check-in event was recorded/);
  assert.match(text, /Detection time is not symptom onset/);
});

test('seated preview export preserves its mode and upper-body evidence without inventing floor contact', () => {
  const incident = createExampleIncident();
  const text = buildIncidentText(incident);
  assert.equal(incident.detectionMode, 'seated');
  assert.match(text, /Event: Possible seated slump/);
  assert.match(text, /Detection mode: Seated upper-body check-in/);
  assert.match(text, /EXAMPLE PREVIEW ONLY/);
  assert.match(text, /calibrated seated baseline/);
  assert.doesNotMatch(incident.observations.join(' '), /floor|lying down|unconscious/);
});

test('an unanswered first question is distinct from an unanswered final help question', () => {
  const incident = createExampleIncident();
  incident.id = 'two-question-check-in';
  incident.status = 'check_in';
  incident.checkInStage = 'help';
  incident.attempts = [];
  incident.events = [{ id: 'first-timeout', at: incident.createdAt + 10_000, kind: 'okay_check_in_unanswered', message: 'No response to the initial app question.' }];
  const text = buildIncidentText(incident);
  assert.match(text, /First question unanswered/);
  assert.match(text, /no final unanswered-check-in event is recorded/);
  assert.match(text, /Simulated contact attempts: 0/);
  assert.match(text, /does not establish unconsciousness/);
});

test('legacy export leaves detection mode unknown instead of borrowing the new seated default', () => {
  const incident = createExampleIncident();
  incident.id = 'legacy-mode-record';
  incident.source = 'camera';
  delete incident.detectionMode;
  const text = buildIncidentText(incident);
  assert.match(text, /Detection mode: Mode not recorded/);
  assert.doesNotMatch(text, /Detection mode: Seated upper-body check-in/);
  assert.equal(incident.detectionMode, undefined);
});

test('full-body export retains explicit full-body provenance and original observations', () => {
  const incident = createExampleIncident();
  incident.id = 'full-body-record';
  incident.source = 'camera';
  incident.detectionMode = 'full_body';
  incident.observations = ['Rapid downward movement observed.', 'Low posture with limited movement afterward.', 'Cause unknown. Breathing not assessed.'];
  incident.events = [];
  const text = buildIncidentText(incident);
  assert.match(text, /CAMERA EVENT/);
  assert.match(text, /Event: Possible collapse/);
  assert.match(text, /Detection mode: Full-body movement mode/);
  assert.match(text, /Low posture with limited movement afterward/);
  assert.doesNotMatch(text, /calibrated seated baseline/);
});

test('real call reports preserve Twilio provenance and provider ID rather than calling it a simulation', () => {
  const incident = createExampleIncident();
  incident.id = 'real-call-demo'; incident.callMode = 'twilio';
  const sid = 'CA' + 'a'.repeat(32);
  incident.attempts = [{id:'one', contactId:'example-contact-1',name:'Demo recipient',status:'acknowledged',at:incident.createdAt,deadline:null,provider:'twilio',providerCallSid:sid}];
  const text = buildIncidentText(incident);
  assert.match(text, /Twilio contact attempts: 1/);
  assert.match(text, /RECORDED DEMO RUN — example signals, Twilio contact calls/);
  assert.ok(text.includes(sid));
  assert.doesNotMatch(text, /Simulated contact attempts/);
});
