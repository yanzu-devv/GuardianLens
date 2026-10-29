import { randomUUID } from 'node:crypto';
import { createInitialSnapshot, configuredDetectionMode, isActiveIncident, INITIAL_CHECK_IN_SECONDS, type Snapshot, type Command, type Config, type Incident, type CallOutcome, type LocationFix } from '../shared/domain.js';
import { DEVICE_MOVEMENT_THRESHOLD_METERS, fixMovementMeters, locationForIncident, validLocationFix } from '../shared/location.js';

const HEARTBEAT_TIMEOUT_MS = 5_000;
const isPending = (status: string) => status === 'attempted' || status === 'connected';
const validText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export class Engine {
  public snapshot: Snapshot;
  private readonly now: () => number;
  private readonly callMode: 'simulated' | 'twilio';
  private monitoringLocationAnchor: LocationFix | null = null;
  private calibrationInvalidatedAt = 0;

  constructor(options: { now?: () => number; snapshot?: Snapshot; callMode?: 'simulated' | 'twilio' } = {}) {
    this.now = options.now ?? Date.now;
    this.callMode = options.callMode ?? 'simulated';
    this.calibrationInvalidatedAt = this.now();
    this.snapshot = structuredClone(options.snapshot ?? createInitialSnapshot());
    this.snapshot.callingMode = this.callMode;
    this.snapshot.location = { tracking: false, fix: null, error: null };
    this.snapshot.monitoring.detectionMode = configuredDetectionMode(this.snapshot.config);
    this.snapshot.monitoring.coverage = 'uncalibrated';
    this.snapshot.monitoring.calibratedAt = null;
    this.snapshot.monitoring.coverageMessage = configuredDetectionMode(this.snapshot.config) === 'seated' ? 'Check the camera view and set a new seated reference after starting the camera.' : 'Check the full-body camera view after starting the camera.';
    if (options.snapshot) {
      this.snapshot.monitoring = {
        ...this.snapshot.monitoring, enabled: false, camera: 'off', poseReady: false,
        personInView: false, lastHeartbeat: null,
        interruption: 'Server restarted. Camera monitoring is interrupted; enable it again after checking the camera.',
      };
      this.snapshot.phoneConnected = false;
      const incident = this.snapshot.incident;
      if (incident && (incident.status === 'check_in' || incident.status === 'calling')) {
        for (const attempt of incident.attempts) {
          if (isPending(attempt.status)) { attempt.status = 'network_error'; attempt.deadline = null; }
        }
        incident.status = 'escalation_simulated';
        incident.deadline = null;
        this.event(incident, 'restart_interruption', 'Server restarted during the incident. Timed actions stopped and no contact calls will be replayed. Any real call cancellation must be confirmed. No emergency call was placed.');
      }
      this.snapshot.revision++;
    }
  }

  command(command: Command): Snapshot {
    const before = JSON.stringify(this.snapshot);
    const now = this.now();
    switch (command.type) {
      case 'configure': {
        const withdrawingConsent = this.snapshot.config.consent && !command.config.consent;
        const consentWithdrawal = !command.config.consent && JSON.stringify({ ...command.config, consent: true }) === JSON.stringify({ ...this.snapshot.config, consent: true });
        if (isActiveIncident(this.snapshot.incident) && !consentWithdrawal) throw new Error('Resolve or cancel the active incident before editing the response plan. Consent can still be withdrawn at any time.');
        this.validateConfig(command.config);
        const detectionModeChanged = configuredDetectionMode(this.snapshot.config) !== configuredDetectionMode(command.config);
        if (this.snapshot.config.locationMode !== command.config.locationMode) this.monitoringLocationAnchor = null;
        this.snapshot.config = structuredClone(command.config);
        if (detectionModeChanged) {
          this.calibrationInvalidatedAt = now;
          this.snapshot.monitoring.enabled = false;
          this.monitoringLocationAnchor = null;
          this.snapshot.monitoring.detectionMode = configuredDetectionMode(command.config);
          this.snapshot.monitoring.coverage = 'uncalibrated';
          this.snapshot.monitoring.calibratedAt = null;
          this.snapshot.monitoring.coverageMessage = 'Detection mode changed. Recheck the camera view before enabling monitoring.';
          this.snapshot.monitoring.interruption = 'Detection mode changed. Check the camera view and calibrate seated mode before enabling monitoring again.';
        }
        if (command.config.locationMode !== 'device') {
          this.snapshot.location = { tracking: false, fix: null, error: null };
          this.monitoringLocationAnchor = null;
        }
        if (!command.config.consent) {
          this.snapshot.monitoring.enabled = false;
          this.monitoringLocationAnchor = null;
          this.snapshot.monitoring.interruption = 'Monitoring consent is off.';
          if (withdrawingConsent && isActiveIncident(this.snapshot.incident)) this.event(this.snapshot.incident, 'monitoring_consent_withdrawn', 'Monitoring consent withdrawn and camera stop requested. Existing incident response remains active.');
        } else if (this.snapshot.monitoring.enabled && (!command.config.room.trim() || (command.config.locationMode !== 'device' && !command.config.address.trim()) || !command.config.contacts.some(contact => contact.optedIn))) {
          this.snapshot.monitoring.enabled = false;
          this.monitoringLocationAnchor = null;
          this.snapshot.monitoring.interruption = 'Response plan is incomplete. Complete setup before enabling monitoring.';
        }
        break;
      }
      case 'monitoring': {
        if (command.enabled) this.requireSetup();
        if (!command.enabled) this.monitoringLocationAnchor = null;
        else if (!this.snapshot.monitoring.enabled) this.monitoringLocationAnchor = this.snapshot.location?.tracking && this.snapshot.location.fix ? { ...this.snapshot.location.fix } : null;
        this.snapshot.monitoring.enabled = command.enabled;
        this.snapshot.monitoring.interruption = command.enabled ? this.healthInterruption() : 'Monitoring paused by the user.';
        break;
      }
      case 'camera': {
        if ((command.interruption !== undefined && command.interruption !== null && !validText(command.interruption, 500))
          || (command.coverageMessage !== undefined && command.coverageMessage !== null && !validText(command.coverageMessage, 500))) throw new Error('Invalid camera status text.');
        const m = this.snapshot.monitoring;
        const wasEnabled = m.enabled;
        if (command.calibratedAt !== undefined && command.calibratedAt !== null && (typeof command.calibratedAt !== 'number' || !Number.isFinite(command.calibratedAt) || command.calibratedAt < 0 || command.calibratedAt > now + 10_000)) throw new Error('Invalid seated calibration timestamp.');
        m.camera = command.camera;
        m.poseReady = command.camera === 'connected' && command.poseReady;
        m.personInView = m.poseReady && command.personInView;
        m.detectionMode = command.detectionMode ?? configuredDetectionMode(this.snapshot.config);
        if (!m.poseReady || (m.detectionMode === 'seated' && command.calibratedAt === null)) this.calibrationInvalidatedAt = now;
        if (!m.poseReady) {
          m.enabled = false;
          this.monitoringLocationAnchor = null;
        }
        m.calibratedAt = m.poseReady && m.detectionMode === 'seated' && typeof command.calibratedAt === 'number' && command.calibratedAt >= this.calibrationInvalidatedAt ? command.calibratedAt : null;
        m.coverage = !m.poseReady || !m.personInView ? 'absent'
          : command.coverage ?? (m.detectionMode === 'full_body' ? 'ready' : 'uncalibrated');
        if (m.detectionMode === 'seated' && m.coverage === 'ready' && m.calibratedAt === null) m.coverage = 'uncalibrated';
        m.coverageMessage = command.coverageMessage ?? null;
        if (m.poseReady) m.lastHeartbeat = now;
        if (!m.poseReady) {
          m.interruption = command.interruption || (m.camera === 'connected'
            ? 'Pose processing is not ready. Monitoring is paused; check the camera before enabling monitoring again.'
            : 'Camera is off or disconnected. Monitoring is paused; reconnect the camera before enabling monitoring again.');
          if (wasEnabled && isActiveIncident(this.snapshot.incident)) this.event(this.snapshot.incident, 'monitoring_interrupted', `Monitoring interrupted: ${m.interruption} Existing incident response remains active.`);
        } else m.interruption = command.interruption || (m.enabled ? this.healthInterruption() : m.interruption);
        break;
      }
      case 'heartbeat': {
        if (this.snapshot.monitoring.camera === 'connected' && this.snapshot.monitoring.poseReady) {
          this.snapshot.monitoring.lastHeartbeat = now;
          if (this.snapshot.monitoring.enabled) this.snapshot.monitoring.interruption = this.healthInterruption();
        }
        break;
      }
      case 'trigger': {
        if (isActiveIncident(this.snapshot.incident)) break;
        this.requireSetup();
        const detectionMode = configuredDetectionMode(this.snapshot.config);
        if (command.source === 'camera') {
          const m = this.snapshot.monitoring;
          if (!m.enabled || m.camera !== 'connected' || !m.poseReady || !m.personInView || m.lastHeartbeat === null || now - m.lastHeartbeat > HEARTBEAT_TIMEOUT_MS || m.interruption) {
            throw new Error('Camera monitoring is interrupted. A live-camera incident cannot be created.');
          }
          if (m.detectionMode !== detectionMode || m.coverage !== 'ready' || (detectionMode === 'seated' && (m.calibratedAt === null || m.calibratedAt === undefined || !Number.isFinite(m.calibratedAt)))) throw new Error('Camera coverage is not ready for the configured detection mode. Calibrate the seated reference or check the full-body view.');
          if (detectionMode === 'seated' ? command.evidence !== 'seated_still_slump' : command.evidence !== 'full_body_collapse') throw new Error('Camera evidence does not match the configured detection mode. Reload the dashboard to use the current detection rules.');
        }
        if (this.snapshot.incident) this.archive(this.snapshot.incident);
        const incident: Incident = {
          id: randomUUID(), source: command.source, status: 'check_in', createdAt: now, callMode: this.callMode,
          checkInStage: 'okay', deadline: now + INITIAL_CHECK_IN_SECONDS * 1_000,
          contactIndex: -1, attempts: [], events: [],
          observations: detectionMode === 'seated'
            ? command.source === 'example'
              ? ['Example incident data: lowered, tilted, or slumped head posture relative to the shoulder midpoint and a calibrated seated reference.', 'Example incident data: little head movement for 10 seconds before the check-in.', 'Cause unknown. Breathing not assessed.']
              : ['Lowered, tilted, or slumped head posture observed relative to the shoulder midpoint and a calibrated seated reference.', 'Little head movement observed in that posture for 10 seconds before the check-in.', 'Cause unknown. Breathing not assessed.']
            : command.source === 'example'
              ? ['Example incident data: rapid downward movement.', 'Example incident data: low posture and limited movement afterward.', 'Cause unknown. Breathing not assessed.']
              : ['Rapid downward movement observed.', 'Low posture with limited movement afterward.', 'Cause unknown. Breathing not assessed.'],
          contactPlan: structuredClone(this.snapshot.config.contacts.filter(c => c.optedIn)),
          location: locationForIncident(this.snapshot, now),
          detectionMode,
        };
        this.snapshot.incident = incident;
        const observedEvent = detectionMode === 'seated' ? 'Possible seated slump' : 'Possible collapse';
        this.event(incident, 'possible_collapse', command.source === 'example'
          ? `Example incident started. ${observedEvent}; this is example data, not a camera detection.`
          : `${observedEvent} detected from camera movement rules. Detection time is not symptom onset.`);
        this.event(incident, 'check_in', `Check-in opened: Are you okay? Initial app response window: ${INITIAL_CHECK_IN_SECONDS} seconds.`);
        break;
      }
      case 'respond': {
        const incident = this.snapshot.incident;
        if (!incident || command.incidentId !== incident.id || (incident.status !== 'check_in' && incident.status !== 'calling')) break;
        if (command.action === 'okay') {
          const pending = incident.attempts.find(a => isPending(a.status));
          if (pending) { pending.status = 'cancelled'; pending.deadline = null; }
          incident.status = 'cancelled';
          incident.deadline = null;
          this.event(incident, 'cancelled', `Person selected “I’m okay” on ${command.actor}. Incident cancelled.${incident.attempts.length ? incident.callMode === 'twilio' ? ' Cancellation requested for the contact call; its record is retained.' : ' A simulated contact call had already been attempted; its record is retained.' : ''}`);
        } else if (incident.status === 'check_in') {
          this.event(incident, 'help_requested', `“Get help now” selected on ${command.actor}. Starting the configured ${incident.callMode === 'twilio' ? 'Twilio' : 'simulated'} contact plan.`);
          this.nextContact(incident);
        }
        break;
      }
      case 'provider_call': {
        if (!/^CA[0-9a-f]{32}$/i.test(command.callSid)) throw new Error('Invalid provider call ID.');
        const incident = [this.snapshot.incident, ...this.snapshot.history].find(i => i?.attempts.some(a => a.id === command.attemptId));
        const attempt = incident?.attempts.find(a => a.id === command.attemptId);
        if (attempt?.provider === 'twilio' && !attempt.providerCallSid) {
          attempt.providerCallSid = command.callSid;
          this.event(incident!, 'provider_call_created', 'Twilio accepted the contact call. Delivery and acknowledgment are not yet confirmed.');
        }
        break;
      }
      case 'provider_failure': {
        const incident = this.snapshot.incident;
        const attempt = incident?.attempts.at(-1);
        if (incident && attempt?.id === command.attemptId && command.providerCode !== undefined && Number.isSafeInteger(command.providerCode) && command.providerCode >= 0) this.event(incident, 'provider_error', `Twilio rejected the call request (error ${command.providerCode}). Check the Twilio account setup before trying again.`);
        if (incident?.status !== 'calling' || attempt?.id !== command.attemptId || !isPending(attempt.status)) {
          const prior = [incident, ...this.snapshot.history].find(i => i?.attempts.some(a => a.id === command.attemptId && a.provider === 'twilio'));
          if (command.uncertain && prior && !prior.events.some(e => e.kind === 'provider_delivery_unknown')) this.event(prior, 'provider_delivery_unknown', 'The call request ended without confirmation after the incident changed. A phone may still ring; check Twilio call logs. The request will not be retried.');
          break;
        }
        if (!command.uncertain) {
          this.command({ type: 'call_outcome', attemptId: attempt.id, outcome: 'network_error' });
        } else {
          attempt.status = 'network_error'; attempt.deadline = null;
          incident.status = 'escalation_simulated'; incident.deadline = null;
          this.event(incident, 'provider_delivery_unknown', 'Twilio call creation could not be confirmed. A call may still ring. Automatic calls stopped to avoid duplicates; check Twilio call logs. No emergency call was placed.');
        }
        break;
      }
      case 'provider_cancel_failure': {
        const incident = [this.snapshot.incident, ...this.snapshot.history].find(i => i?.attempts.some(a => a.id === command.attemptId));
        if (incident && !incident.events.some(e => e.kind === 'provider_cancel_failed' && e.message.includes(command.attemptId))) this.event(incident, 'provider_cancel_failed', `Call cancellation is not confirmed for attempt ${command.attemptId}. Check Twilio call logs; the phone may still ring. Further automatic calls are blocked until cancellation succeeds.`);
        break;
      }
      case 'call_outcome': {
        const incident = this.snapshot.incident;
        if (!incident || incident.status !== 'calling') break;
        const attempt = incident.attempts[incident.attempts.length - 1];
        if (!attempt || attempt.id !== command.attemptId || !isPending(attempt.status)) break;
        if (command.outcome === 'connected') {
          if (attempt.status === 'connected') break;
          attempt.status = 'connected';
          if (attempt.provider === 'twilio') { attempt.deadline = now + (this.snapshot.config.callSeconds + 90) * 1000; incident.deadline = attempt.deadline; }
          this.event(incident, 'call_connected', `${attempt.provider === 'twilio' ? 'Twilio' : 'Simulated'} call connected to ${attempt.name}. Answering is not acknowledgment; press 1 is still required.`);
        } else if (command.outcome === 'acknowledged') {
          attempt.status = 'acknowledged';
          attempt.deadline = null;
          incident.status = 'acknowledged';
          incident.deadline = null;
          this.event(incident, 'caregiver_acknowledged', `${attempt.name} explicitly acknowledged ${attempt.provider === 'twilio' ? 'on the phone' : 'in the call simulator'} (press 1). This does not confirm that help arrived. Incident remains unresolved.`);
        } else {
          attempt.status = command.outcome;
          attempt.deadline = null;
          this.event(incident, command.outcome, `${attempt.name}: ${attempt.provider === 'twilio' ? command.outcome.replaceAll('_', ' ') : this.outcomeText(command.outcome)}. No acknowledgment received.`);
          this.nextContact(incident);
        }
        break;
      }
      case 'resolve': {
        const incident = this.snapshot.incident;
        if (!incident || (incident.status !== 'acknowledged' && incident.status !== 'escalation_simulated')) {
          throw new Error('Resolve an acknowledged incident or the completed simulated escalation. Use “I’m okay” to cancel an active check-in.');
        }
        incident.status = 'resolved';
        incident.deadline = null;
        this.event(incident, 'resolved', 'Incident explicitly marked resolved by the operator.');
        break;
      }
      case 'reset': {
        if (isActiveIncident(this.snapshot.incident)) throw new Error('Cancel or resolve the active incident before clearing the incident screen.');
        if (this.snapshot.incident) this.archive(this.snapshot.incident);
        this.snapshot.incident = null;
        break;
      }
      case 'interrupt': {
        if (!validText(command.reason, 500)) throw new Error('Invalid interruption reason.');
        const m = this.snapshot.monitoring;
        m.enabled = false;
        this.monitoringLocationAnchor = null;
        m.camera = 'disconnected';
        m.poseReady = false;
        m.personInView = false;
        m.calibratedAt = null;
        this.calibrationInvalidatedAt = now;
        m.coverage = 'uncalibrated';
        m.coverageMessage = 'Monitoring interrupted. Recheck the camera view and seated reference.';
        m.interruption = command.reason;
        if (isActiveIncident(this.snapshot.incident)) {
          this.event(this.snapshot.incident, 'monitoring_interrupted', `Monitoring interrupted: ${command.reason} Existing incident response remains active.`);
        }
        break;
      }
      case 'phone_presence': {
        this.snapshot.phoneConnected = command.connected;
        break;
      }
      case 'location_tracking': {
        if (command.enabled && this.snapshot.config.locationMode !== 'device') throw new Error('Choose device location mode before enabling location tracking.');
        if (!command.enabled) {
          this.snapshot.location = { tracking: false, fix: null, error: null };
          this.monitoringLocationAnchor = null;
        }
        else this.snapshot.location = { tracking: true, fix: this.snapshot.location?.fix ?? null, error: null };
        break;
      }
      case 'location_fix': {
        if (!this.snapshot.location?.tracking) throw new Error('Enable device location before sending a location fix.');
        if (!validLocationFix(command.fix, now)) throw new Error('Invalid device location fix.');
        const previous = this.snapshot.location.fix;
        if (previous && command.fix.capturedAt <= previous.capturedAt) break;
        this.snapshot.location.fix = { ...command.fix };
        this.snapshot.location.error = null;
        if (this.snapshot.monitoring.enabled) {
          if (!this.monitoringLocationAnchor) this.monitoringLocationAnchor = { ...command.fix };
          else if (fixMovementMeters(this.monitoringLocationAnchor, command.fix) > this.monitoringLocationAnchor.accuracy + command.fix.accuracy + DEVICE_MOVEMENT_THRESHOLD_METERS) {
            this.snapshot.monitoring.enabled = false;
            this.monitoringLocationAnchor = null;
            this.snapshot.monitoring.interruption = 'Device moved. Reposition the fixed camera and enable monitoring again.';
            this.snapshot.monitoring.calibratedAt = null;
            this.calibrationInvalidatedAt = now;
            this.snapshot.monitoring.coverage = 'uncalibrated';
            this.snapshot.monitoring.coverageMessage = 'Device moved. Set a new seated reference after repositioning the camera.';
            if (isActiveIncident(this.snapshot.incident)) this.event(this.snapshot.incident, 'device_moved', 'Device location changed beyond its reported accuracy range. Camera monitoring paused for repositioning; existing incident response remains active. This does not establish patient movement.');
          }
        }
        break;
      }
      case 'location_error': {
        if (!this.snapshot.location?.tracking) break;
        if (typeof command.message !== 'string' || !command.message.trim() || command.message.length > 500) throw new Error('Invalid device location error.');
        this.snapshot.location.error = command.message.trim();
        break;
      }
      case 'incident_report': {
        const incident = this.snapshot.incident?.id === command.incidentId ? this.snapshot.incident : this.snapshot.history.find(item => item.id === command.incidentId);
        if (!incident) throw new Error('That incident is not available in this session’s history.');
        const report = command.report;
        if (!report || !['person', 'witness', 'caregiver'].includes(report.reportedBy)) throw new Error('Select who reported this account.');
        const fields = ['context', 'symptomsBefore', 'injury', 'recovery'] as const;
        if (fields.some(field => typeof report[field] !== 'string' || report[field].length > 1000) || !fields.some(field => report[field].trim())) throw new Error('Add at least one reported detail, up to 1,000 characters per field.');
        const updating = Boolean(incident.report);
        incident.report = { reportedBy: report.reportedBy, context: report.context.trim(), symptomsBefore: report.symptomsBefore.trim(), injury: report.injury.trim(), recovery: report.recovery.trim(), recordedAt: now };
        this.event(incident, 'account_recorded', `A ${report.reportedBy}-reported account was ${updating ? 'updated' : 'added'}. Statements are reported, not verified by camera.`);
        break;
      }
    }
    if (JSON.stringify(this.snapshot) !== before) this.snapshot.revision++;
    return this.snapshot;
  }

  tick(): Snapshot {
    const before = JSON.stringify(this.snapshot);
    const now = this.now();
    const m = this.snapshot.monitoring;
    if (m.enabled && m.poseReady && m.lastHeartbeat !== null && now - m.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      m.enabled = false;
      this.monitoringLocationAnchor = null;
      m.camera = 'disconnected';
      m.poseReady = false;
      m.personInView = false;
      m.calibratedAt = null;
      this.calibrationInvalidatedAt = now;
      m.coverage = 'uncalibrated';
      m.coverageMessage = 'Camera processing heartbeat lost. Set a new seated reference before resuming.';
      m.interruption = 'Camera processing heartbeat lost. Monitoring is interrupted.';
      if (isActiveIncident(this.snapshot.incident)) this.event(this.snapshot.incident, 'monitoring_interrupted', m.interruption);
    }
    const incident = this.snapshot.incident;
    if (incident && incident.deadline !== null && now >= incident.deadline) {
      if (incident.status === 'check_in') {
        if (incident.checkInStage === 'okay') {
          this.event(incident, 'okay_check_in_unanswered', 'No response to “Are you okay?” within the initial app response window. This does not establish unconsciousness.');
          incident.checkInStage = 'help';
          // Start the second response window when that question is presented,
          // even when a delayed tick discovers the first deadline much later.
          incident.deadline = now + this.snapshot.config.checkInSeconds * 1_000;
          this.event(incident, 'help_check_in', `Do you need help? App response window: ${this.snapshot.config.checkInSeconds} seconds. Contact calls use ${incident.callMode === 'twilio' ? 'Twilio' : 'simulation'}.`);
        } else {
          this.event(incident, 'check_in_unanswered', incident.checkInStage === 'help'
            ? 'No response to “Do you need help?” before the app response window expired. This does not establish unconsciousness.'
            : 'No response to the app’s check-in before the Demo timer expired. This does not establish unconsciousness.');
          this.nextContact(incident);
        }
      } else if (incident.status === 'calling') {
        const attempt = incident.attempts[incident.attempts.length - 1];
        if (attempt && isPending(attempt.status)) {
          attempt.status = 'no_answer';
          attempt.deadline = null;
          this.event(incident, 'call_timeout', `${attempt.name}: ${attempt.provider === 'twilio' ? 'contact call' : 'simulated call Demo'} timer expired without acknowledgment.`);
          this.nextContact(incident);
        }
      }
    }
    if (JSON.stringify(this.snapshot) !== before) this.snapshot.revision++;
    return this.snapshot;
  }

  private nextContact(incident: Incident) {
    incident.contactIndex++;
    const contact = incident.contactPlan[incident.contactIndex];
    if (!contact) {
      incident.status = 'escalation_simulated';
      incident.deadline = null;
      this.event(incident, 'emergency_escalation_simulated', 'No contact acknowledged. Emergency-service escalation is SIMULATED. Emergency dialing is disabled; no emergency call was placed and help is not confirmed.');
      return;
    }
    const at = this.now();
    const deadline = at + (this.snapshot.config.callSeconds + (this.callMode === 'twilio' ? 135 : 0)) * 1_000;
    incident.status = 'calling';
    incident.deadline = deadline;
    incident.attempts.push({ id: randomUUID(), contactId: contact.id, name: contact.name, status: 'attempted', at, deadline, provider: this.callMode });
    this.event(incident, 'call_attempted', this.callMode === 'twilio' ? `Contact call requested for ${contact.name}. Awaiting Twilio confirmation; press 1 on the phone to acknowledge.` : `Simulated contact call attempted: ${contact.name}. No real telephone call was placed. Demo timer: ${this.snapshot.config.callSeconds} seconds.`);
  }

  private event(incident: Incident, kind: string, message: string) {
    incident.events.push({ id: randomUUID(), at: this.now(), kind, message });
  }

  private archive(incident: Incident) {
    this.snapshot.history = [...this.snapshot.history, structuredClone(incident)].slice(-20);
  }

  private requireSetup() {
    const c = this.snapshot.config;
    if (!c.consent || !c.room.trim() || (c.locationMode !== 'device' && !c.address.trim()) || !c.contacts.some(contact => contact.optedIn)) {
      throw new Error('Complete setup: monitoring consent, device label, a manual address when using manual location, and at least one opted-in contact are required.');
    }
  }

  private validateConfig(config: Config) {
    if (typeof config.room !== 'string' || config.room.length > 120 || typeof config.address !== 'string' || config.address.length > 400 || typeof config.consent !== 'boolean') throw new Error('Invalid room, address, or consent.');
    if (config.locationMode !== undefined && config.locationMode !== 'device' && config.locationMode !== 'manual') throw new Error('Invalid location mode.');
    if (config.detectionMode !== undefined && config.detectionMode !== 'seated' && config.detectionMode !== 'full_body') throw new Error('Invalid detection mode.');
    if (!Number.isInteger(config.checkInSeconds) || config.checkInSeconds < 5 || config.checkInSeconds > 120 || !Number.isInteger(config.callSeconds) || config.callSeconds < 5 || config.callSeconds > 120) throw new Error('Demo timers must be whole seconds between 5 and 120.');
    if (!Array.isArray(config.contacts) || config.contacts.length > 8 || config.contacts.some(c => !validText(c.id, 100) || !validText(c.name, 100) || typeof c.optedIn !== 'boolean' || (c.phone !== undefined && (typeof c.phone !== 'string' || (c.phone !== '' && !/^\+[1-9]\d{7,14}$/.test(c.phone)))) || (c.relationship !== undefined && (typeof c.relationship !== 'string' || c.relationship.length > 100))) || new Set(config.contacts.map(c => c.id)).size !== config.contacts.length) throw new Error('Contacts must have distinct IDs, names, and explicit opt-in values.');
  }

  private healthInterruption(): string | null {
    const m = this.snapshot.monitoring;
    if (m.camera !== 'connected') return `Camera ${m.camera === 'off' ? 'is off' : 'disconnected'}. Monitoring is interrupted.`;
    if (!m.poseReady) return 'Pose model is not ready. Monitoring is interrupted.';
    if (m.detectionMode !== configuredDetectionMode(this.snapshot.config)) return 'Camera detection mode does not match the response plan. Check the camera view.';
    if (m.coverage !== 'ready') return m.coverage === 'partial' ? 'Camera coverage is partial. Reposition the camera; detection is unavailable.' : 'Camera coverage is not ready. Calibrate the seated reference or check the full-body view.';
    if (m.detectionMode === 'seated' && (m.calibratedAt === null || m.calibratedAt === undefined)) return 'A seated reference is required before seated monitoring.';
    if (m.lastHeartbeat === null || this.now() - m.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) return 'Camera processing heartbeat is missing. Monitoring is interrupted.';
    return null;
  }

  private outcomeText(outcome: CallOutcome): string {
    return {
      connected: 'simulated call connected.', acknowledged: 'simulated explicit acknowledgment.',
      no_answer: 'simulated no answer.', declined: 'simulated call declined.',
      wrong_digit: 'wrong digit entered in the simulator; only press 1 acknowledges.',
      voicemail: 'simulated voicemail.', network_error: 'simulated calling network failure.',
    }[outcome];
  }
}
