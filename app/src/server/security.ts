import { timingSafeEqual } from 'node:crypto';
import type { Command, Config, IncidentReportInput, Snapshot } from '../shared/domain.js';
import { validLocationFix } from '../shared/location.js';

export type Role = 'owner' | 'phone';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const oneOf = (v: unknown, values: string[]) => typeof v === 'string' && values.includes(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));

export function tokenMatches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCommand(value: unknown, role: Role): Command {
  if (!object(value) || !string(value.type, 40)) throw new Error('Invalid command.');
  if (role === 'phone' && value.type !== 'respond') throw new Error('Paired phones can only respond to the current incident.');
  const v = value;
  switch (v.type) {
    case 'configure': {
      const c = v.config;
      if (!keys(v, ['type', 'config']) || !object(c) || !keys(c, ['room', 'address', 'consent', 'contacts', 'checkInSeconds', 'callSeconds', 'locationMode', 'detectionMode']) || (c.locationMode !== undefined && !oneOf(c.locationMode, ['device', 'manual'])) || (c.detectionMode !== undefined && !oneOf(c.detectionMode, ['seated', 'full_body'])) || typeof c.room !== 'string' || c.room.length > 120 || typeof c.address !== 'string' || c.address.length > 400 || !bool(c.consent) || !Array.isArray(c.contacts) || c.contacts.length > 8 || !Number.isInteger(c.checkInSeconds) || !Number.isInteger(c.callSeconds)) break;
      if (c.contacts.some(x => !object(x) || !keys(x, ['id', 'name', 'optedIn', 'phone', 'relationship']) || !string(x.id, 100) || !string(x.name, 100) || !bool(x.optedIn) || (x.phone !== undefined && (typeof x.phone !== 'string' || (x.phone !== '' && !/^\+[1-9]\d{7,14}$/.test(x.phone)))) || (x.relationship !== undefined && (typeof x.relationship !== 'string' || x.relationship.length > 100)))) break;
      return { type: 'configure', config: c as unknown as Config };
    }
    case 'monitoring': if (keys(v, ['type', 'enabled']) && bool(v.enabled)) return { type: 'monitoring', enabled: v.enabled }; break;
    case 'camera':
      if (keys(v, ['type', 'camera', 'poseReady', 'personInView', 'interruption', 'detectionMode', 'coverage', 'calibratedAt', 'coverageMessage']) && oneOf(v.camera, ['off', 'connected', 'disconnected']) && bool(v.poseReady) && bool(v.personInView) && (v.interruption === undefined || v.interruption === null || string(v.interruption, 500))
        && (v.detectionMode === undefined || oneOf(v.detectionMode, ['seated', 'full_body']))
        && (v.coverage === undefined || oneOf(v.coverage, ['ready', 'partial', 'absent', 'uncalibrated']))
        && (v.calibratedAt === undefined || v.calibratedAt === null || (typeof v.calibratedAt === 'number' && Number.isFinite(v.calibratedAt) && v.calibratedAt >= 0 && v.calibratedAt <= Date.now() + 10_000))
        && (v.coverageMessage === undefined || v.coverageMessage === null || string(v.coverageMessage, 500))) return v as unknown as Command;
      break;
    case 'heartbeat': if (keys(v, ['type'])) return { type: 'heartbeat' }; break;
    case 'trigger': if (keys(v, ['type', 'source', 'evidence']) && oneOf(v.source, ['example', 'camera']) && (v.evidence === undefined || oneOf(v.evidence, ['seated_slump', 'seated_sustained_slump', 'seated_still_slump', 'full_body_collapse']))) return v as unknown as Command; break;
    case 'respond':
      if (keys(v, ['type', 'incidentId', 'action', 'actor']) && string(v.incidentId, 100) && oneOf(v.action, ['okay', 'help']) && oneOf(v.actor, ['desktop', 'phone'])) return { type: 'respond', incidentId: v.incidentId, action: v.action as 'okay' | 'help', actor: role === 'phone' ? 'phone' : 'desktop' };
      break;
    case 'call_outcome':
      if (keys(v, ['type', 'attemptId', 'outcome']) && string(v.attemptId, 100) && oneOf(v.outcome, ['connected', 'acknowledged', 'no_answer', 'declined', 'wrong_digit', 'voicemail', 'network_error'])) return v as unknown as Command;
      break;
    case 'resolve': case 'reset': if (keys(v, ['type'])) return v as unknown as Command; break;
    case 'interrupt': if (keys(v, ['type', 'reason']) && string(v.reason, 500)) return { type: 'interrupt', reason: v.reason }; break;
    case 'location_tracking': if (keys(v, ['type', 'enabled']) && bool(v.enabled)) return { type: 'location_tracking', enabled: v.enabled }; break;
    case 'location_fix': if (keys(v, ['type', 'fix']) && validLocationFix(v.fix)) return { type: 'location_fix', fix: v.fix }; break;
    case 'location_error': if (keys(v, ['type', 'message']) && string(v.message, 500) && v.message.trim()) return { type: 'location_error', message: v.message }; break;
    case 'incident_report': {
      const report = v.report;
      if (keys(v, ['type', 'incidentId', 'report']) && string(v.incidentId, 100) && object(report)
        && keys(report, ['reportedBy', 'context', 'symptomsBefore', 'injury', 'recovery'])
        && oneOf(report.reportedBy, ['person', 'witness', 'caregiver'])
        && ['context', 'symptomsBefore', 'injury', 'recovery'].every(field => typeof report[field] === 'string' && report[field].length <= 1000)
        && ['context', 'symptomsBefore', 'injury', 'recovery'].some(field => typeof report[field] === 'string' && report[field].trim())) {
        return { type: 'incident_report', incidentId: v.incidentId, report: report as unknown as IncidentReportInput };
      }
      break;
    }
  }
  throw new Error('Invalid command fields.');
}

// The phone does not receive the room camera, contact list, history, or caregiver names.
export function projectSnapshot(snapshot: Snapshot, role: Role): Snapshot {
  if (role === 'owner') return snapshot;
  const incident = snapshot.incident ? (() => { const { report: _privateAccount, ...publicIncident } = snapshot.incident; return { ...publicIncident, contactPlan: [], attempts: [], events: [] }; })() : null;
  return {
    ...snapshot,
    config: { ...snapshot.config, contacts: [] },
    history: [],
    incident,
    location: { tracking: false, fix: null, error: null },
  };
}

/** Reject corrupt saved state before restoring timers or presenting monitoring health. */
export function validateSavedSnapshot(value: unknown): asserts value is Snapshot {
  const fail = (at: string): never => { throw new Error(`Saved state has an invalid structure at ${at}. Preserve state.json for inspection.`); };
  function record(v: unknown, at: string, fields: string[], optional: string[] = []): asserts v is Record<string, unknown> {
    if (!object(v) || !keys(v, [...fields, ...optional]) || fields.some(field => !(field in v))) fail(at);
  }
  function text(v: unknown, at: string, max: number, allowEmpty = false): asserts v is string {
    if (typeof v !== 'string' || (!allowEmpty && !v.trim()) || v.length > max) fail(at);
  }
  function boolean(v: unknown, at: string): asserts v is boolean { if (typeof v !== 'boolean') fail(at); }
  function number(v: unknown, at: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts v is number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(at);
  }
  function integer(v: unknown, at: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts v is number {
    number(v, at, min, max);
    if (!Number.isInteger(v)) fail(at);
  }
  function timestamp(v: unknown, at: string) { if (v !== null) number(v, at); }
  function array(v: unknown, at: string, max: number): asserts v is unknown[] {
    if (!Array.isArray(v) || v.length > max) fail(at);
  }
  function contacts(v: unknown, at: string) {
    array(v, at, 8);
    const ids = new Set<string>();
    v.forEach((contact, i) => {
      const field = `${at}[${i}]`;
      record(contact, field, ['id', 'name', 'optedIn'], ['phone', 'relationship']);
      if (contact.phone !== undefined && (typeof contact.phone !== 'string' || (contact.phone !== '' && !/^\+[1-9]\d{7,14}$/.test(contact.phone)))) fail(`${field}.phone`);
      if (contact.relationship !== undefined && (typeof contact.relationship !== 'string' || contact.relationship.length > 100)) fail(`${field}.relationship`);
      text(contact.id, `${field}.id`, 100);
      text(contact.name, `${field}.name`, 100);
      boolean(contact.optedIn, `${field}.optedIn`);
      if (ids.has(contact.id)) fail(`${field}.id`);
      ids.add(contact.id);
    });
  }
  function incident(v: unknown, at: string) {
    record(v, at, ['id', 'source', 'status', 'createdAt', 'deadline', 'contactIndex', 'attempts', 'events', 'observations', 'contactPlan'], ['location', 'report', 'detectionMode', 'checkInStage', 'callMode']);
    text(v.id, `${at}.id`, 100);
    if (v.callMode !== undefined && !oneOf(v.callMode, ['simulated', 'twilio'])) fail(`${at}.callMode`);
    if (!oneOf(v.source, ['example', 'camera'])) fail(`${at}.source`);
    if (v.detectionMode !== undefined && !oneOf(v.detectionMode, ['seated', 'full_body'])) fail(`${at}.detectionMode`);
    if (v.checkInStage !== undefined && !oneOf(v.checkInStage, ['okay', 'help'])) fail(`${at}.checkInStage`);
    if (!oneOf(v.status, ['check_in', 'calling', 'acknowledged', 'cancelled', 'resolved', 'escalation_simulated'])) fail(`${at}.status`);
    number(v.createdAt, `${at}.createdAt`);
    timestamp(v.deadline, `${at}.deadline`);
    integer(v.contactIndex, `${at}.contactIndex`, -1, 8);
    contacts(v.contactPlan, `${at}.contactPlan`);
    array(v.attempts, `${at}.attempts`, 8);
    const attemptIds = new Set<string>();
    v.attempts.forEach((attempt, i) => {
      const field = `${at}.attempts[${i}]`;
      record(attempt, field, ['id', 'contactId', 'name', 'status', 'at', 'deadline'], ['provider', 'providerCallSid']);
      text(attempt.id, `${field}.id`, 100);
      if (attempt.provider !== undefined && !oneOf(attempt.provider, ['simulated', 'twilio'])) fail(`${field}.provider`);
      if (attempt.providerCallSid !== undefined && (attempt.provider !== 'twilio' || typeof attempt.providerCallSid !== 'string' || !/^CA[0-9a-f]{32}$/i.test(attempt.providerCallSid))) fail(`${field}.providerCallSid`);
      text(attempt.contactId, `${field}.contactId`, 100);
      text(attempt.name, `${field}.name`, 100);
      if (attemptIds.has(attempt.id)) fail(`${field}.id`);
      attemptIds.add(attempt.id);
      if (!oneOf(attempt.status, ['attempted', 'connected', 'acknowledged', 'no_answer', 'declined', 'wrong_digit', 'voicemail', 'network_error', 'cancelled'])) fail(`${field}.status`);
      number(attempt.at, `${field}.at`);
      timestamp(attempt.deadline, `${field}.deadline`);
    });
    array(v.observations, `${at}.observations`, 8);
    v.observations.forEach((observation, i) => text(observation, `${at}.observations[${i}]`, 600));
    array(v.events, `${at}.events`, 100_000);
    const eventIds = new Set<string>();
    v.events.forEach((event, i) => {
      const field = `${at}.events[${i}]`;
      record(event, field, ['id', 'at', 'kind', 'message']);
      text(event.id, `${field}.id`, 100);
      if (eventIds.has(event.id)) fail(`${field}.id`);
      eventIds.add(event.id);
      number(event.at, `${field}.at`);
      text(event.kind, `${field}.kind`, 80);
      text(event.message, `${field}.message`, 1_200);
    });
    if (v.location !== undefined) {
      const atLocation = `${at}.location`;
      const location = v.location;
      record(location, atLocation, ['mode', 'label', 'address', 'fix', 'availability', 'note']);
      if (!oneOf(location.mode, ['device', 'manual'])) fail(`${atLocation}.mode`);
      text(location.label, `${atLocation}.label`, 120);
      text(location.address, `${atLocation}.address`, 400, true);
      if (location.fix !== null && !validLocationFix(location.fix)) fail(`${atLocation}.fix`);
      if (!oneOf(location.availability, ['current', 'stale', 'unavailable', 'manual'])) fail(`${atLocation}.availability`);
      if (location.note !== null) text(location.note, `${atLocation}.note`, 1_200);
      if (location.mode === 'manual' && (location.fix !== null || location.availability !== 'manual')) fail(atLocation);
      if (location.mode === 'device' && (location.address !== '' || location.availability === 'manual' || ((location.availability === 'current' || location.availability === 'stale') && location.fix === null))) fail(atLocation);
    }
    if (v.report !== undefined) {
      const atReport = `${at}.report`;
      const report = v.report;
      record(report, atReport, ['reportedBy', 'context', 'symptomsBefore', 'injury', 'recovery', 'recordedAt']);
      if (!oneOf(report.reportedBy, ['person', 'witness', 'caregiver'])) fail(`${atReport}.reportedBy`);
      const fields = ['context', 'symptomsBefore', 'injury', 'recovery'];
      for (const field of fields) text(report[field], `${atReport}.${field}`, 1000, true);
      if (!fields.some(field => typeof report[field] === 'string' && report[field].trim())) fail(atReport);
      number(report.recordedAt, `${atReport}.recordedAt`);
    }
  }

  record(value, 'snapshot', ['revision', 'config', 'monitoring', 'incident', 'history', 'phoneConnected'], ['location', 'callingMode']);
  integer(value.revision, 'snapshot.revision');
  if (value.callingMode !== undefined && !oneOf(value.callingMode, ['simulated', 'twilio'])) fail('snapshot.callingMode');
  const c = value.config;
  record(c, 'snapshot.config', ['room', 'address', 'consent', 'contacts', 'checkInSeconds', 'callSeconds'], ['locationMode', 'detectionMode']);
  text(c.room, 'snapshot.config.room', 120, true);
  text(c.address, 'snapshot.config.address', 400, true);
  boolean(c.consent, 'snapshot.config.consent');
  contacts(c.contacts, 'snapshot.config.contacts');
  integer(c.checkInSeconds, 'snapshot.config.checkInSeconds', 5, 120);
  integer(c.callSeconds, 'snapshot.config.callSeconds', 5, 120);
  if (c.locationMode !== undefined && !oneOf(c.locationMode, ['device', 'manual'])) fail('snapshot.config.locationMode');
  if (c.detectionMode !== undefined && !oneOf(c.detectionMode, ['seated', 'full_body'])) fail('snapshot.config.detectionMode');
  const m = value.monitoring;
  record(m, 'snapshot.monitoring', ['enabled', 'camera', 'personInView', 'poseReady', 'lastHeartbeat', 'interruption'], ['detectionMode', 'coverage', 'calibratedAt', 'coverageMessage']);
  boolean(m.enabled, 'snapshot.monitoring.enabled');
  if (!oneOf(m.camera, ['off', 'connected', 'disconnected'])) fail('snapshot.monitoring.camera');
  boolean(m.personInView, 'snapshot.monitoring.personInView');
  boolean(m.poseReady, 'snapshot.monitoring.poseReady');
  timestamp(m.lastHeartbeat, 'snapshot.monitoring.lastHeartbeat');
  if (m.interruption !== null) text(m.interruption, 'snapshot.monitoring.interruption', 600);
  if (m.detectionMode !== undefined && !oneOf(m.detectionMode, ['seated', 'full_body'])) fail('snapshot.monitoring.detectionMode');
  if (m.coverage !== undefined && !oneOf(m.coverage, ['ready', 'partial', 'absent', 'uncalibrated'])) fail('snapshot.monitoring.coverage');
  if (m.calibratedAt !== undefined) timestamp(m.calibratedAt, 'snapshot.monitoring.calibratedAt');
  if (m.coverageMessage !== undefined && m.coverageMessage !== null) text(m.coverageMessage, 'snapshot.monitoring.coverageMessage', 500);
  if (value.incident !== null) incident(value.incident, 'snapshot.incident');
  array(value.history, 'snapshot.history', 20);
  value.history.forEach((item, i) => incident(item, `snapshot.history[${i}]`));
  boolean(value.phoneConnected, 'snapshot.phoneConnected');
  if (value.location !== undefined) {
    const location = value.location;
    record(location, 'snapshot.location', ['tracking', 'fix', 'error']);
    boolean(location.tracking, 'snapshot.location.tracking');
    if (location.fix !== null && !validLocationFix(location.fix)) fail('snapshot.location.fix');
    if (location.error !== null) text(location.error, 'snapshot.location.error', 500);
    if (!location.tracking && location.fix !== null) fail('snapshot.location.fix');
  }
}
