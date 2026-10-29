export type CameraStatus = 'off' | 'connected' | 'disconnected';
export type DetectionMode = 'seated' | 'full_body';
export type DetectionCoverage = 'ready' | 'partial' | 'absent' | 'uncalibrated';
export type DetectionEvidence = 'seated_slump' | 'seated_sustained_slump' | 'seated_still_slump' | 'full_body_collapse';
export type IncidentStatus = 'check_in' | 'calling' | 'acknowledged' | 'cancelled' | 'resolved' | 'escalation_simulated';
export type CheckInStage = 'okay' | 'help';
export const INITIAL_CHECK_IN_SECONDS = 10;
export type CallOutcome = 'connected' | 'acknowledged' | 'no_answer' | 'declined' | 'wrong_digit' | 'voicemail' | 'network_error';
export type CallStatus = 'attempted' | CallOutcome | 'cancelled';

export interface Contact {
  phone?: string;
  relationship?: string;
  id: string;
  name: string;
  optedIn: boolean;
}

export interface Config {
  room: string;
  address: string;
  consent: boolean;
  contacts: Contact[];
  checkInSeconds: number;
  callSeconds: number;
  locationMode?: 'device' | 'manual';
  detectionMode?: DetectionMode;
}

export interface LocationFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  capturedAt: number;
}

export interface DeviceLocationState {
  tracking: boolean;
  fix: LocationFix | null;
  error: string | null;
}

export interface IncidentLocation {
  mode: 'device' | 'manual';
  label: string;
  address: string;
  fix: LocationFix | null;
  availability: 'current' | 'stale' | 'unavailable' | 'manual';
  note: string | null;
}

export interface IncidentReport {
  reportedBy: 'person' | 'witness' | 'caregiver';
  context: string;
  symptomsBefore: string;
  injury: string;
  recovery: string;
  recordedAt: number;
}

export type IncidentReportInput = Omit<IncidentReport, 'recordedAt'>;

export interface Event {
  id: string;
  at: number;
  kind: string;
  message: string;
}

export interface CallAttempt {
  provider?: 'simulated' | 'twilio';
  providerCallSid?: string;
  id: string;
  contactId: string;
  name: string;
  status: CallStatus;
  at: number;
  deadline: number | null;
}

export interface Incident {
  callMode?: 'simulated' | 'twilio';
  id: string;
  source: 'example' | 'camera';
  status: IncidentStatus;
  createdAt: number;
  deadline: number | null;
  contactIndex: number;
  attempts: CallAttempt[];
  events: Event[];
  observations: string[];
  contactPlan: Contact[];
  location?: IncidentLocation;
  report?: IncidentReport;
  detectionMode?: DetectionMode;
  checkInStage?: CheckInStage;
}

export interface Snapshot {
  callingMode?: 'simulated' | 'twilio';
  revision: number;
  config: Config;
  monitoring: {
    enabled: boolean;
    camera: CameraStatus;
    personInView: boolean;
    poseReady: boolean;
    lastHeartbeat: number | null;
    interruption: string | null;
    detectionMode?: DetectionMode;
    coverage?: DetectionCoverage;
    calibratedAt?: number | null;
    coverageMessage?: string | null;
  };
  incident: Incident | null;
  history: Incident[];
  phoneConnected: boolean;
  location?: DeviceLocationState;
}

export type Command =
  | { type: 'provider_call'; attemptId: string; callSid: string }
  | { type: 'provider_failure'; attemptId: string; uncertain: boolean; providerCode?: number }
  | { type: 'provider_cancel_failure'; attemptId: string }
  | { type: 'configure'; config: Config }
  | { type: 'monitoring'; enabled: boolean }
  | { type: 'camera'; camera: CameraStatus; poseReady: boolean; personInView: boolean; interruption?: string | null; detectionMode?: DetectionMode; coverage?: DetectionCoverage; calibratedAt?: number | null; coverageMessage?: string | null }
  | { type: 'heartbeat' }
  | { type: 'trigger'; source: 'example' | 'camera'; evidence?: DetectionEvidence }
  | { type: 'respond'; incidentId: string; action: 'okay' | 'help'; actor: 'desktop' | 'phone' }
  | { type: 'call_outcome'; attemptId: string; outcome: CallOutcome }
  | { type: 'resolve' }
  | { type: 'reset' }
  | { type: 'interrupt'; reason: string }
  | { type: 'phone_presence'; connected: boolean }
  | { type: 'location_tracking'; enabled: boolean }
  | { type: 'location_fix'; fix: LocationFix }
  | { type: 'location_error'; message: string }
  | { type: 'incident_report'; incidentId: string; report: IncidentReportInput };

export const activeStatuses: IncidentStatus[] = ['check_in', 'calling', 'acknowledged', 'escalation_simulated'];
export const isActiveIncident = (incident: Incident | null): incident is Incident => Boolean(incident && activeStatuses.includes(incident.status));
export const configuredDetectionMode = (config: Config): DetectionMode => config.detectionMode ?? 'seated';

export function createInitialSnapshot(): Snapshot {
  return {
    revision: 0,
    config: {
      room: 'My laptop', address: '', consent: false, locationMode: 'device', detectionMode: 'seated',
      contacts: [{ id: 'contact-1', name: 'First contact', optedIn: false }, { id: 'contact-2', name: 'Second contact', optedIn: false }],
      checkInSeconds: 15, callSeconds: 20,
    },
    monitoring: { enabled: false, camera: 'off', personInView: false, poseReady: false, lastHeartbeat: null, interruption: null, detectionMode: 'seated', coverage: 'uncalibrated', calibratedAt: null, coverageMessage: 'Calibrate a seated reference before enabling seated detection.' },
    incident: null,
    history: [],
    phoneConnected: false,
    location: { tracking: false, fix: null, error: null },
  };
}
