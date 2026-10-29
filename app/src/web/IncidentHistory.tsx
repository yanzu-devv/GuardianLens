import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { Command, Incident, IncidentReportInput, IncidentStatus, Snapshot } from '../shared/domain';

type Props = { snapshot: Snapshot; send: (command: Command) => Promise<void>; connected: boolean; onBack: () => void; previewOnOpen?: boolean };
type Filter = 'all' | 'open' | 'closed' | 'camera' | 'demo';
const NICE_URL = 'https://www.nice.org.uk/guidance/cg109/chapter/Recommendations';
const RED_CROSS_URL = 'https://www.redcross.org/take-a-class/resources/learn-first-aid/unresponsive-and-breathing-person';
const NHS_URL = 'https://www.nhs.uk/conditions/falls/';
const labels: Record<IncidentStatus, string> = {
  check_in: 'Check-in active', calling: 'Contact plan active', acknowledged: 'Acknowledged · unresolved',
  cancelled: 'Cancelled by person', resolved: 'Marked resolved', escalation_simulated: 'Escalation simulated',
};
const outcomes: Record<string, string> = {
  attempted: 'Attempted', connected: 'Connected · acknowledgment pending', acknowledged: 'Explicit acknowledgment',
  no_answer: 'No answer', declined: 'Declined', wrong_digit: 'Wrong digit · not acknowledged',
  voicemail: 'Voicemail · not acknowledged', network_error: 'Network failure', cancelled: 'Cancelled',
};
const closed = (incident: Incident) => incident.status === 'cancelled' || incident.status === 'resolved';
const fullDate = (time: number) => new Date(time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
const shortDate = (time: number) => new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const clockTime = (time: number) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const sourceLabel = (incident: Incident, preview = false) => preview ? 'Example record · preview only' : incident.source === 'camera' ? 'Camera observation' : 'Demo run · example signals';
const recordName = (incident: Incident) => incident.id === 'example-preview' ? 'EXAMPLE' : incident.id.slice(0, 8).toUpperCase();
const detectionModeLabel = (incident: Incident) => incident.detectionMode === 'seated' ? 'Seated upper-body check-in' : incident.detectionMode === 'full_body' ? 'Full-body movement mode' : 'Mode not recorded';
const incidentTitle = (incident: Incident) => incident.detectionMode === 'seated' ? 'Possible seated slump' : 'Possible collapse';

function HistoryIcon({ name, size = 20 }: { name: 'shield' | 'file' | 'download' | 'arrow' | 'check' | 'clock' | 'pin' | 'alert' | 'eye' | 'person' | 'external' | 'phone' | 'close'; size?: number }) {
  const paths: Record<string, ReactNode> = {
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8.5 11.5 2.5 2.5 4.5-5" /></>,
    file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6M8 13h8m-8 4h5" /></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    check: <path d="m5 12 4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2" /></>,
    alert: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3v.1" /></>,
    eye: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
    person: <><circle cx="12" cy="7" r="4" /><path d="M5 21v-3a7 7 0 0 1 14 0v3" /></>,
    external: <><path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></>,
    phone: <><path d="m8 3 3 5-3 3a12 12 0 0 0 5 5l3-3 5 3c-1 5-5 6-9 3S5 12 3 8s0-5 5-5Z" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

/** Illustration is deliberately outside the recorded history and never sent to the server. */
export function createExampleIncident(): Incident {
  const at = new Date(2026, 9, 28, 14, 14, 8).getTime();
  return {
    id: 'example-preview', source: 'example', detectionMode: 'seated', status: 'resolved', createdAt: at, deadline: null, contactIndex: 1,
    location: { mode: 'manual', label: 'Example desk', address: 'Illustrative location · no real address', fix: null, availability: 'manual', note: 'Preview data only. This is not a captured device location.' },
    observations: ['Example head-and-shoulder drop relative to a calibrated seated baseline.', 'Example slumped upper-body posture sustained afterward.', 'Example little head movement for 10 seconds before the check-in.'],
    contactPlan: [{ id: 'example-contact-1', name: 'Example contact A', optedIn: true }, { id: 'example-contact-2', name: 'Example contact B', optedIn: true }],
    attempts: [
      { id: 'example-call-1', contactId: 'example-contact-1', name: 'Example contact A', status: 'voicemail', at: at + 15_000, deadline: null },
      { id: 'example-call-2', contactId: 'example-contact-2', name: 'Example contact B', status: 'acknowledged', at: at + 22_000, deadline: null },
    ],
    events: [
      { id: 'example-e1', at, kind: 'possible_collapse', message: 'Illustrative possible seated slump created from example upper-body signals, not a camera recording.' },
      { id: 'example-e2', at, kind: 'check_in', message: 'Example check-in opened with a 15-second Demo timer.' },
      { id: 'example-e3', at: at + 15_000, kind: 'check_in_unanswered', message: 'Example check-in timer expired with no app response. This does not establish unconsciousness.' },
      { id: 'example-e4', at: at + 15_000, kind: 'call_attempted', message: 'Simulated call attempted to Example contact A. No real call was placed.' },
      { id: 'example-e5', at: at + 22_000, kind: 'voicemail', message: 'Example contact A reached simulated voicemail. No acknowledgment received.' },
      { id: 'example-e6', at: at + 22_000, kind: 'call_attempted', message: 'Simulated call attempted to Example contact B.' },
      { id: 'example-e7', at: at + 25_000, kind: 'call_connected', message: 'Simulated call connected. Acknowledgment was still required.' },
      { id: 'example-e8', at: at + 30_000, kind: 'caregiver_acknowledged', message: 'Example contact B pressed 1 in the simulator. Arrival was not confirmed.' },
      { id: 'example-e9', at: at + 75_000, kind: 'resolved', message: 'Example operator marked the incident resolved. This is a response-workflow action, not a medical assessment.' },
    ],
  };
}

function locationLines(incident: Incident): string[] {
  const location = incident.location;
  if (!location) return ['Location was not captured for this record.'];
  const lines = [location.label || 'Unlabeled location', location.address || 'No street address recorded.', `Location provenance: ${location.mode === 'device' ? 'device location' : 'manually configured'}; ${location.availability}.`];
  if (location.fix) {
    lines.push(`Coordinates: ${location.fix.latitude.toFixed(6)}, ${location.fix.longitude.toFixed(6)}; reported accuracy ±${Math.round(location.fix.accuracy)} m.`);
    lines.push(`Location fix captured: ${new Date(location.fix.capturedAt).toISOString()}. This is the device location, not confirmed person location.`);
  }
  if (location.note) lines.push(location.note);
  return lines;
}

/** Export uses only the selected record; never substitutes the currently configured location. */
export function buildIncidentText(incident: Incident, { examplePreview = false }: { examplePreview?: boolean } = {}): string {
  examplePreview ||= incident.id === 'example-preview';
  const report = incident.report;
  const unanswered = incident.events.find(event => event.kind === 'check_in_unanswered');
  const firstUnanswered = incident.events.find(event => event.kind === 'okay_check_in_unanswered');
  const connectedCount = incident.events.filter(event => event.kind === 'call_connected').length;
  const acknowledgment = incident.events.find(event => event.kind === 'caregiver_acknowledged');
  const resolution = incident.events.find(event => event.kind === 'resolved');
  const parts = [
    'GUARDIANLENS — INCIDENT EVIDENCE REPORT',
    examplePreview ? 'EXAMPLE PREVIEW ONLY — not a recorded incident; no calls or monitoring were started.' : incident.source === 'example' ? `RECORDED DEMO RUN — example signals, ${incident.callMode === 'twilio' ? 'Twilio contact calls' : 'simulated calls'}.` : `CAMERA EVENT — experimental pose perception and movement rules; ${incident.callMode === 'twilio' ? 'Twilio contact calls' : 'calls simulated'}.`,
    `Record: ${incident.id}`, `Event: ${incidentTitle(incident)}`, `Detection mode: ${detectionModeLabel(incident)}`, `Detection time: ${new Date(incident.createdAt).toISOString()}`,
    'Detection time is not symptom onset, last-known-well time, or confirmed loss of consciousness.',
    `Response status: ${labels[incident.status]}`, '', 'LOCATION AT INCIDENT CREATION', ...locationLines(incident),
    '', 'STRUCTURED OBSERVATIONS', ...(incident.observations.length ? incident.observations.map(item => `- ${item}`) : ['No structured observations recorded.']),
    '', 'RESPONSE ACTIONS',
    unanswered ? `Check-in unanswered: ${new Date(unanswered.at).toISOString()} (app response only).` : firstUnanswered ? `First question unanswered: ${new Date(firstUnanswered.at).toISOString()}. The help question followed; no final unanswered-check-in event is recorded. This does not establish unconsciousness.` : 'No unanswered-check-in event was recorded. Do not infer the person was unresponsive.',
    `${incident.callMode === 'twilio' ? 'Twilio' : 'Simulated'} contact attempts: ${incident.attempts.length}; call connections logged: ${connectedCount}.`,
    ...incident.attempts.map(attempt => `- ${new Date(attempt.at).toISOString()} | ${attempt.name} | ${outcomes[attempt.status] || attempt.status} | ${attempt.provider === 'twilio' ? `Twilio${attempt.providerCallSid ? ' · ' + attempt.providerCallSid : ' · creation not confirmed'}` : 'simulated'}`),
    acknowledgment ? `Explicit acknowledgment logged: ${new Date(acknowledgment.at).toISOString()}.` : 'No explicit caregiver acknowledgment recorded.',
    'Help arrival: not verified. No emergency-service call was placed by this prototype.',
    resolution ? `Marked resolved by operator: ${new Date(resolution.at).toISOString()}. This does not confirm medical recovery.` : 'No operator-resolution event recorded.',
    '', 'PERSON / WITNESS / CAREGIVER ACCOUNT',
    report ? `Provenance: ${report.reportedBy}-reported, recorded ${new Date(report.recordedAt).toISOString()}; not clinically verified.` : 'No human account recorded.',
    `Circumstances and sequence: ${report?.context.trim() || 'Not recorded.'}`,
    `Symptoms beforehand: ${report?.symptomsBefore.trim() || 'Not recorded.'}`,
    `Injuries or pain noticed: ${report?.injury.trim() || 'Unknown; no account recorded.'}`,
    `Afterward and recovery: ${report?.recovery.trim() || 'Not recorded.'}`,
    '', 'NOT ASSESSED BY THE APP',
    'Cause: unknown. Loss of consciousness: not established. Breathing: not assessed.',
    'Head impact and injuries: not assessed by camera; refer to any unverified human account above.',
    'Symptom onset, duration of any loss of consciousness, and clinical recovery: not established.',
    '', 'EVENT TIMELINE', ...incident.events.map(event => `${new Date(event.at).toISOString()} | ${event.kind} | ${event.message}`),
    '', 'HANDOVER CONTEXT',
    'Describe what happened before, during and after the event, including warning symptoms, injuries and recovery. Share this record with a healthcare professional if appropriate.',
    'If a person is unresponsive or breathing abnormally, request emergency help immediately; do not wait for the app. Use your own phone for real emergencies.',
    'Documentation structure informed by NICE guidance; not a clinician assessment or a medical record.',
    `NICE CG109: ${NICE_URL}`, `American Red Cross: ${RED_CROSS_URL}`, `NHS falls guidance: ${NHS_URL}`,
  ];
  return parts.join('\n');
}

function StatusBadge({ incident }: { incident: Incident }) {
  return <span className={`ih-status ${closed(incident) ? 'ih-status-ended' : incident.status === 'acknowledged' ? 'ih-status-ack' : 'ih-status-open'}`}><span />{labels[incident.status]}</span>;
}

function EmptyHistory({ onPreview, onBack }: { onPreview: () => void; onBack: () => void }) {
  return <section className="ih-empty"><div className="ih-empty-art" aria-hidden="true"><span /><HistoryIcon name="file" size={42} /><span /></div><p className="ih-kicker">YOUR INCIDENT RECORD</p><h2>Nothing recorded yet.</h2><p>When an incident happens, the observations, response actions, and human account come together here.</p><div className="ih-empty-actions"><button className="button primary" onClick={onPreview}>View example record <HistoryIcon name="arrow" size={17} /></button><button className="button secondary" onClick={onBack}>Back to overview</button></div><div className="ih-empty-note"><HistoryIcon name="eye" size={16} /><span>The example is a preview. It won’t start monitoring, create an incident, or place calls.</span></div></section>;
}

function HumanAccount({ incident, preview, send, connected }: { incident: Incident; preview: boolean; send: Props['send']; connected: boolean }) {
  const report = incident.report;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<IncidentReportInput>({ reportedBy: 'person', context: '', symptomsBefore: '', injury: '', recovery: '' });
  useEffect(() => {
    setEditing(false); setMessage(null);
    setDraft(report ? { reportedBy: report.reportedBy, context: report.context, symptomsBefore: report.symptomsBefore, injury: report.injury, recovery: report.recovery } : { reportedBy: 'person', context: '', symptomsBefore: '', injury: '', recovery: '' });
  }, [incident.id, report?.recordedAt]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setMessage(null);
    try { await send({ type: 'incident_report', incidentId: incident.id, report: draft }); setEditing(false); setMessage('Reported account saved. Statements remain unverified.'); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'The account could not be saved. Try again when connected.'); }
    finally { setSaving(false); }
  };
  const fields = [
    { key: 'context', title: 'Circumstances & sequence', label: 'During the event', placeholder: 'What was happening? What did you see before, during and after? Leave unknown details blank.' },
    { key: 'symptomsBefore', title: 'Symptoms beforehand', label: 'Before the event', placeholder: 'Any warning symptoms the person reported. Do not guess.' },
    { key: 'injury', title: 'Injuries or pain noticed', label: 'Injury account', placeholder: 'What the person or witness noticed, including the site. This is not a medical assessment.' },
    { key: 'recovery', title: 'Afterward & recovery', label: 'After the event', placeholder: 'What the person remembers and how they felt afterward. Include times only if known.' },
  ] as const;
  return <section className="ih-section ih-human-account"><div className="ih-section-heading"><div><span className="ih-section-number">02</span><h3>Person or witness account</h3></div>{!preview && !editing && <button className="text-button" disabled={!connected} onClick={() => setEditing(true)}>{report ? 'Edit account' : 'Add an account'}<HistoryIcon name="arrow" size={15} /></button>}</div><p className="ih-section-description">A human account adds context the camera cannot provide.</p>
    {report && <div className="ih-account-provenance"><HistoryIcon name="person" size={16} /><strong>{report.reportedBy === 'person' ? 'Person' : report.reportedBy === 'witness' ? 'Witness' : 'Caregiver'} reported</strong><span>Saved {fullDate(report.recordedAt)} · not clinically verified</span></div>}
    {!editing && <div className="ih-account-grid">{fields.map(field => <div key={field.key}><span>{field.label}</span><strong>{field.title}</strong><p className={report?.[field.key]?.trim() ? 'ih-reported-text' : 'ih-unrecorded'}>{report?.[field.key]?.trim() || (field.key === 'injury' ? 'Unknown · no account recorded' : 'Not recorded')}</p></div>)}</div>}
    {preview && <p className="ih-inline-note">Example preview · account editing is disabled. No human account is included in this illustration.</p>}
    {editing && <form className="ih-account-form" onSubmit={save}><label className="ih-reporter-label">Who is providing this account?<select value={draft.reportedBy} onChange={event => setDraft(current => ({ ...current, reportedBy: event.target.value as IncidentReportInput['reportedBy'] }))}><option value="person">The person involved</option><option value="witness">A witness</option><option value="caregiver">A caregiver</option></select></label><div className="ih-report-fields">{fields.map(field => <label key={field.key}>{field.title}<textarea maxLength={1000} rows={3} value={draft[field.key]} placeholder={field.placeholder} onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.value }))} /><span>{draft[field.key].length}/1000</span></label>)}</div><p className="ih-inline-note">Record only what the person or witness reports. Leave unknown information blank. Saved statements are not verified by GuardianLens.</p><div className="ih-account-actions"><button className="button primary" disabled={saving || !connected || ![draft.context, draft.symptomsBefore, draft.injury, draft.recovery].some(value => value.trim())} type="submit">{saving ? 'Saving…' : 'Save reported account'}<HistoryIcon name="check" size={17} /></button><button className="button secondary" disabled={saving} type="button" onClick={() => setEditing(false)}>Cancel</button></div></form>}
    {message && <p className="ih-save-message" role="status">{message}</p>}
  </section>;
}

function IncidentDetail({ incident, preview, send, connected }: { incident: Incident; preview: boolean; send: Props['send']; connected: boolean }) {
  const [downloadRequested, setDownloadRequested] = useState(false);
  useEffect(() => { setDownloadRequested(false); }, [incident.id]);
  const checkIn = incident.events.find(event => event.kind === 'check_in');
  const noResponse = incident.events.find(event => event.kind === 'check_in_unanswered') ?? incident.events.find(event => event.kind === 'okay_check_in_unanswered');
  const helpRequested = incident.events.find(event => event.kind === 'help_requested');
  const cancelled = incident.events.find(event => event.kind === 'cancelled');
  const acknowledged = incident.events.find(event => event.kind === 'caregiver_acknowledged');
  const resolved = incident.events.find(event => event.kind === 'resolved');
  const connections = incident.events.filter(event => event.kind === 'call_connected').length;
  const location = incident.location;
  const download = () => {
    const blob = new Blob([buildIncidentText(incident, { examplePreview: preview })], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `guardianlens-${preview ? 'example-preview' : incident.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}.txt`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); setDownloadRequested(true);
  };
  return <article className="ih-detail" aria-label={preview ? 'Example incident preview' : 'Selected incident record'}><header className="ih-detail-header"><div><div className="ih-record-id"><HistoryIcon name="file" size={15} /><span>RECORD {recordName(incident)}</span></div><h2>{incidentTitle(incident)}</h2><p>Observed event and response handover</p></div><button className="button secondary ih-download" onClick={download}><HistoryIcon name="download" size={17} />Download text report</button></header>
    <div className="ih-detail-badges"><StatusBadge incident={incident} /><span className={`ih-source ${preview || incident.source === 'example' ? 'ih-source-example' : ''}`}>{sourceLabel(incident, preview)}</span><span className="ih-source">{detectionModeLabel(incident)}</span><span className="ih-source">{incident.callMode === 'twilio' ? 'Twilio contact calls' : 'All contact calls simulated'}</span></div>{downloadRequested && <p className="ih-save-message" role="status">Text report download requested. It contains only this record and its source labels.</p>}
    <div className="ih-facts"><div><span>DETECTION TIME</span><strong>{clockTime(incident.createdAt)}</strong><small>{shortDate(incident.createdAt)}</small></div><div><span>INCIDENT LOCATION</span><strong>{location?.label || 'Not captured'}</strong><small>{location ? location.mode === 'device' ? location.fix ? 'Device fix snapshot' : 'No device fix saved' : 'Manually configured' : 'No historical location'}</small></div><div><span>CONTACT ATTEMPTS</span><strong>{String(incident.attempts.length).padStart(2, '0')}<em>{incident.callMode === 'twilio' ? 'Twilio' : 'simulated'}</em></strong><small>{connections} connection{connections === 1 ? '' : 's'} logged</small></div></div>
    <div className="ih-time-caveat"><HistoryIcon name="clock" size={16} /><p>Detection time is when the app flagged the event. It is <strong>not symptom onset or last-known-well time.</strong></p></div>
    <section className="ih-section"><div className="ih-section-heading"><div><span className="ih-section-number">01</span><h3>Observed evidence</h3></div><span className="ih-provenance-label">{incident.source === 'example' || preview ? 'EXAMPLE SIGNALS' : 'POSE + MOVEMENT RULES'}</span></div><ul className="ih-observations">{incident.observations.length ? incident.observations.map((observation, index) => <li key={index}><span><HistoryIcon name="eye" size={16} /></span><p>{observation}</p></li>) : <li><p>No structured observations were recorded.</p></li>}</ul><div className="ih-unknown-panel"><div><HistoryIcon name="alert" size={16} /><strong>What the app cannot establish</strong></div><dl><div><dt>Cause</dt><dd>Unknown</dd></div><div><dt>Loss of consciousness</dt><dd>Not established</dd></div><div><dt>Breathing</dt><dd>Not assessed</dd></div><div><dt>Head impact / injury</dt><dd>Not assessed by camera</dd></div></dl><p>App silence is not proof of unconsciousness. A response-workflow status does not establish medical recovery.</p></div></section>
    <HumanAccount incident={incident} preview={preview} send={send} connected={connected} />
    <section className="ih-section"><div className="ih-section-heading"><div><span className="ih-section-number">03</span><h3>Response & acknowledgment</h3></div><span className="ih-provenance-label">{incident.callMode === 'twilio' ? 'TWILIO CALLS' : 'SIMULATED CALLS'}</span></div><div className="ih-response-summary"><div><span className="ih-response-symbol"><HistoryIcon name="clock" size={17} /></span><div><strong>Check-in</strong><p>{noResponse ? noResponse.kind === 'okay_check_in_unanswered' ? `No response to “Are you okay?” by ${clockTime(noResponse.at)}. The help question followed.` : `No app response before the Demo timer expired at ${clockTime(noResponse.at)}.` : helpRequested ? `“Get help now” selected at ${clockTime(helpRequested.at)}.` : cancelled ? `“I’m okay” selected at ${clockTime(cancelled.at)}.` : checkIn ? `Opened at ${clockTime(checkIn.at)}. No unanswered-check-in event is recorded.` : 'No check-in event recorded.'}</p></div></div><div><span className={`ih-response-symbol ${acknowledged ? 'ih-symbol-ack' : ''}`}><HistoryIcon name="check" size={17} /></span><div><strong>Explicit caregiver acknowledgment</strong><p>{acknowledged ? `Recorded at ${clockTime(acknowledged.at)}. Acceptance is distinct from help arrival.` : 'No explicit acknowledgment recorded. A connection or voicemail does not count.'}</p></div></div><div><span className="ih-response-symbol"><HistoryIcon name="person" size={17} /></span><div><strong>Arrival & resolution</strong><p>Help arrival is not verified. {resolved ? `Operator marked resolved at ${clockTime(resolved.at)}; this does not confirm medical recovery.` : cancelled ? 'Incident was cancelled by the person.' : 'Incident has not been marked resolved.'}</p></div></div></div>{incident.attempts.length > 0 && <div className="ih-attempts"><div className="ih-table-header"><span>CONTACT / ATTEMPT</span><span>RECORDED OUTCOME</span></div>{incident.attempts.map((attempt, index) => <div className="ih-attempt-row" key={attempt.id}><span className="ih-attempt-order">{index + 1}</span><div><strong>{attempt.name}</strong><small>{clockTime(attempt.at)} · {attempt.provider === 'twilio' ? 'Twilio' : 'simulated'}</small></div><span className={`ih-attempt-status ${attempt.status === 'acknowledged' ? 'ih-attempt-ack' : ''}`}>{attempt.status === 'acknowledged' && <HistoryIcon name="check" size={14} />}{outcomes[attempt.status] || attempt.status}</span></div>)}</div>}<div className="ih-response-limit">No emergency-service call was placed. “Acknowledged” does not mean help arrived.</div></section>
    <section className="ih-section"><div className="ih-section-heading"><div><span className="ih-section-number">04</span><h3>Location saved with this incident</h3></div><HistoryIcon name="pin" size={19} /></div>{location ? <div className="ih-location"><strong>{location.label || 'Unlabeled location'}</strong><p>{location.address || 'No street address recorded.'}</p><span className={`ih-location-state ${location.availability === 'current' || location.availability === 'manual' ? '' : 'ih-location-warning'}`}>{location.availability === 'manual' ? 'Manual address' : location.availability === 'current' ? 'Device fix current at detection' : location.availability === 'stale' ? 'Device fix was stale at detection' : 'Device fix unavailable at detection'}</span>{location.fix && <dl><div><dt>Saved coordinates</dt><dd>{location.fix.latitude.toFixed(6)}, {location.fix.longitude.toFixed(6)}</dd></div><div><dt>Reported accuracy</dt><dd>±{Math.round(location.fix.accuracy)} m</dd></div><div><dt>Fix captured</dt><dd>{fullDate(location.fix.capturedAt)}</dd></div></dl>}{location.note && <p className="ih-inline-note">{location.note}</p>}<p className="ih-inline-note">This is the location snapshot saved when the incident began. A device fix does not confirm the person’s location.</p></div> : <div className="ih-missing-location"><HistoryIcon name="pin" size={23} /><p>Location was not captured for this record.</p><span>The current location is never substituted into an older incident.</span></div>}</section>
    <section className="ih-section ih-event-section"><div className="ih-section-heading"><div><span className="ih-section-number">05</span><h3>Event timeline</h3></div><span className="ih-provenance-label">{incident.events.length} LOGGED ACTIONS</span></div><ol className="ih-event-list">{incident.events.map(event => <li key={event.id}><span className={`ih-event-node ${event.kind === 'caregiver_acknowledged' || event.kind === 'resolved' ? 'ih-event-node-complete' : ''}`} /><time dateTime={new Date(event.at).toISOString()}>{clockTime(event.at)}</time><div><strong>{event.kind === 'possible_collapse' ? incidentTitle(incident) : event.kind.replaceAll('_', ' ')}</strong><p>{event.message}</p></div></li>)}</ol></section>
    <section className="ih-followup"><span className="ih-followup-icon"><HistoryIcon name="person" size={21} /></span><div><h3>Bring context to a healthcare conversation.</h3><p>This record can help you explain what the app observed and what people reported. It cannot explain the cause.</p><ul><li>What was happening before, during and after the event?</li><li>Were warning symptoms, injury, confusion or weakness reported?</li><li>What does the person remember, and what remains unknown?</li></ul></div></section>
    <aside className="ih-urgent-note"><HistoryIcon name="alert" size={19} /><div><strong>If the person needs urgent help</strong><p>If they are unresponsive, breathing abnormally, seriously injured, or unable to get up after a fall, request emergency help immediately using your own phone. Do not wait for this app or its contact plan.</p><div><a href={RED_CROSS_URL} target="_blank" rel="noreferrer">American Red Cross <HistoryIcon name="external" size={12} /></a><a href={NHS_URL} target="_blank" rel="noreferrer">NHS falls guidance <HistoryIcon name="external" size={12} /></a></div></div></aside>
    <footer className="ih-disclaimer"><HistoryIcon name="file" size={15} /><p>Documentation structure informed by <a href={NICE_URL} target="_blank" rel="noreferrer">NICE guidance</a>; not a clinician assessment or a medical record.</p></footer>
  </article>;
}

export function IncidentHistory({ snapshot, send, connected, onBack, previewOnOpen = false }: Props) {
  const records = useMemo(() => [...new Map([...snapshot.history, ...(snapshot.incident ? [snapshot.incident] : [])].map(incident => [incident.id, incident])).values()].sort((a, b) => b.createdAt - a.createdAt), [snapshot.history, snapshot.incident]);
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(records[0]?.id || null);
  const [preview, setPreview] = useState(previewOnOpen);
  const example = useMemo(createExampleIncident, []);
  const filtered = records.filter(incident => filter === 'all' || (filter === 'open' && !closed(incident)) || (filter === 'closed' && closed(incident)) || (filter === 'camera' && incident.source === 'camera') || (filter === 'demo' && incident.source === 'example'));
  useEffect(() => { if (!filtered.some(incident => incident.id === selectedId)) setSelectedId(filtered[0]?.id || null); }, [filter, records, selectedId]);
  const selected = preview ? example : records.find(incident => incident.id === selectedId);
  const openCount = records.filter(incident => !closed(incident)).length;
  return <section className="incident-history"><header className="ih-toolbar"><div><span className="ih-kicker">INCIDENT RECORDS</span><h2>A clear handover, in one place.</h2><p>Separate observations, reported context, and response outcomes.</p></div><button className="button secondary" onClick={() => setPreview(true)}><HistoryIcon name="file" size={17} />View example record</button></header>
    <div className="ih-summary-strip"><div><span>RECORDED INCIDENTS</span><strong>{String(records.length).padStart(2, '0')}</strong><small>Includes labeled demo runs</small></div><div><span>STILL OPEN</span><strong>{String(openCount).padStart(2, '0')}</strong><small>Acknowledged stays open until resolved</small></div><div><span>CAMERA EVENTS</span><strong>{String(records.filter(incident => incident.source === 'camera').length).padStart(2, '0')}</strong><small>Experimental, not clinically validated</small></div></div>
    {preview && <div className="ih-preview-banner" role="status"><span className="ih-preview-icon"><HistoryIcon name="eye" size={20} /></span><div><strong>Example record · preview only</strong><p>Illustrative data, separate from your history. No monitoring, incident, or phone call was started.</p></div><button className="text-button" onClick={() => setPreview(false)}>Close preview <HistoryIcon name="close" size={16} /></button></div>}
    {!records.length && !preview ? <EmptyHistory onPreview={() => setPreview(true)} onBack={onBack} /> : <div className="ih-workspace"><aside className="ih-record-index"><div className="ih-index-heading"><h3>Your records</h3><span>{records.length}</span></div><label className="ih-filter">Filter records<select value={filter} onChange={event => { setFilter(event.target.value as Filter); setPreview(false); }}><option value="all">All recorded incidents</option><option value="open">Open incidents</option><option value="closed">Resolved or cancelled</option><option value="camera">Camera events</option><option value="demo">Recorded demo runs</option></select></label><p className="ih-sort-label">NEWEST FIRST</p><div className="ih-record-list">{filtered.map(incident => <button key={incident.id} className={`ih-record-button ${!preview && selectedId === incident.id ? 'ih-record-selected' : ''}`} aria-pressed={!preview && selectedId === incident.id} onClick={() => { setSelectedId(incident.id); setPreview(false); }}><div className="ih-record-button-top"><span>{shortDate(incident.createdAt)}</span><HistoryIcon name="arrow" size={16} /></div><strong>{incidentTitle(incident)}</strong><time dateTime={new Date(incident.createdAt).toISOString()}>{clockTime(incident.createdAt)}</time><StatusBadge incident={incident} /><span className="ih-record-source">{incident.source === 'camera' ? 'Camera event' : 'Recorded demo run'}</span></button>)}{!filtered.length && <div className="ih-no-records"><HistoryIcon name="file" size={26} /><strong>{records.length ? 'No records match this filter.' : 'No incidents recorded.'}</strong><p>{records.length ? 'Choose another filter to see your records.' : 'The example preview is separate from your history.'}</p></div>}</div><div className="ih-index-footer"><HistoryIcon name="shield" size={16} /><span>Raw video is not saved.<br />This log records events and reported text.</span></div></aside>{selected ? <IncidentDetail key={selected.id} incident={selected} preview={preview} send={send} connected={connected} /> : <div className="ih-no-selection"><HistoryIcon name="file" size={40} /><h3>Select a record to view the handover.</h3><p>Or open the clearly labeled example preview.</p><button className="button secondary" onClick={() => setPreview(true)}>View example record <HistoryIcon name="arrow" size={17} /></button></div>}</div>}
  </section>;
}
