import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CallAttempt, Command, Snapshot, IncidentLocation } from '../shared/domain.js';
import { LOCATION_STALE_MS } from '../shared/location.js';

export interface TwilioConfig { accountSid: string; authToken: string; from: string; allowedTo: string[]; publicOrigin: string; trial?: boolean }
export const phoneNumber = (value: string) => /^\+[1-9]\d{7,14}$/.test(value);
export function readTwilioConfig(env: NodeJS.ProcessEnv, publicOrigin?: string): TwilioConfig | undefined {
  if (!env.CALL_MODE || env.CALL_MODE === 'simulated') return;
  if (env.CALL_MODE !== 'twilio') throw new Error('CALL_MODE must be simulated or twilio.');
  const { TWILIO_ACCOUNT_SID: accountSid = '', TWILIO_AUTH_TOKEN: authToken = '', TWILIO_FROM_NUMBER: from = '', TWILIO_ALLOWED_TO = '' } = env;
  const allowedTo = TWILIO_ALLOWED_TO.split(',').map(s => s.trim()).filter(Boolean);
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || !/^[0-9a-f]{32}$/i.test(authToken) || !phoneNumber(from) || !allowedTo.length || !allowedTo.every(phoneNumber)) throw new Error('Complete the local Twilio account, token, caller number, and allowed demo recipients before enabling calls.');
  const url = new URL(env.TWILIO_CALLBACK_ORIGIN || publicOrigin || 'http://invalid');
  if (url.protocol !== 'https:' || url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Twilio needs TWILIO_CALLBACK_ORIGIN set to the HTTPS tunnel origin, without a path or custom port.');
  return { accountSid, authToken, from, allowedTo, publicOrigin: url.origin, ...(env.TWILIO_TRIAL_MODE === 'true' ? { trial: true } : {}) };
}

// Twilio's documented form POST signature algorithm. Duplicate form keys are
// rejected before validation, rather than ambiguously interpreted by handlers.
export function validTwilioSignature(token: string, url: string, fields: URLSearchParams, actual: string): boolean {
  const keys = [...fields.keys()];
  if (new Set(keys).size !== keys.length) return false;
  const payload = url + keys.sort().map(key => key + fields.get(key)).join('');
  const expected = createHmac('sha1', token).update(payload).digest('base64');
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
// The new trial TwiML proxy omits X-Twilio-Signature. A capability is
// restricted to one attempt and action; the server also checks participants,
// provider SID, and the active persisted attempt before changing state.
export function trialCallbackCapability(config: TwilioConfig, attemptId: string, action: 'voice' | 'digits'): string {
  return createHmac('sha256', config.authToken).update(`guardianlens:trial-callback:${attemptId}:${action}`).digest('base64url');
}
export function callbackUrl(config: TwilioConfig, attemptId: string, action: 'voice' | 'digits' | 'status'): string {
  const url = `${config.publicOrigin}/twilio/${encodeURIComponent(attemptId)}/${action}`;
  return config.trial && action !== 'status' ? `${url}?cap=${trialCallbackCapability(config, attemptId, action)}` : url;
}
export function validTrialCapability(config: TwilioConfig, attemptId: string, action: string, actual: string): boolean {
  if (!config.trial || (action !== 'voice' && action !== 'digits') || !/^[\w-]{43}$/.test(actual)) return false;
  const expected = trialCallbackCapability(config, attemptId, action);
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&apos;');
export const hangupTwiml = (message = '') => `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Say>${xml(message)}</Say>` : ''}<Hangup/></Response>`;
export function spokenIncidentLocation(location?: IncidentLocation, now = Date.now()): string {
  if (!location) return 'Their location is unavailable. Please confirm where they are.';
  const label = location.label.trim() ? `Device label: ${location.label.trim()}. ` : '';
  if (location.mode === 'manual') return label + (location.address.trim() ? `User-entered location: ${location.address.trim()}. Confirm this is where they are now.` : 'No address was entered. Please confirm where they are.');
  if (!location.fix || location.availability === 'unavailable') return label + 'Device location was unavailable when the incident started. Please confirm where they are.';
  const fix = location.fix;
  const coordinate = (value: number, positive: string, negative: string) => {
    const [degrees, decimals] = Math.abs(value).toFixed(5).split('.');
    return `${degrees} point ${decimals!.split('').join(' ')} degrees ${value < 0 ? negative : positive}`;
  };
  const stale = location.availability === 'stale' || now - fix.capturedAt > LOCATION_STALE_MS;
  return label + `${stale ? 'Warning: this device location is older than two minutes and may be out of date. ' : ''}Shared device location: latitude ${coordinate(fix.latitude, 'north', 'south')}, longitude ${coordinate(fix.longitude, 'east', 'west')}. Estimated accuracy: ${Math.ceil(fix.accuracy)} meters. Confirm the person's location.`;
}
export function gatherTwiml(action: string, seconds: number, location?: IncidentLocation, now = Date.now()): string {
  const context = `GuardianLens demo check-in. Someone requested help or did not respond to their check-in. ${spokenIncidentLocation(location, now)} This is not an emergency dispatch.`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(context)}</Say><Gather input="dtmf" numDigits="1" timeout="${seconds}" actionOnEmptyResult="true" method="POST" action="${xml(action)}"><Say>Press 1 if you will check on them.</Say></Gather><Hangup/></Response>`;
}
export class TwilioRequestError extends Error {
  constructor(public readonly definitive: boolean, public readonly providerCode?: number) { super('Twilio request failed.'); }
}
export interface VoiceProvider {
  create(to: string, attemptId: string, seconds: number): Promise<string>;
  stop(callSid: string): Promise<void>;
}
export class TwilioVoice implements VoiceProvider {
  constructor(private config: TwilioConfig, private request: typeof fetch = fetch) {}
  private async api(suffix: string, fields?: URLSearchParams): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(`https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls${suffix}`, {
        method: fields ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64')}`, ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: fields,
      });
    } catch { throw new TwilioRequestError(false); }
    if (!response.ok) {
      // Retain only the numeric diagnostic; provider messages can contain phone
      // numbers or request details and must not enter the incident log.
      let code: number | undefined;
      try { const data = await response.json() as { code?: unknown }; if (typeof data.code === 'number' && Number.isSafeInteger(data.code) && data.code >= 0) code = data.code; } catch { /* An unreadable error is still a failed request. */ }
      throw new TwilioRequestError(response.status >= 400 && response.status < 500 && response.status !== 408, code);
    }
    try { return await response.json() as Record<string, unknown>; } catch { throw new TwilioRequestError(false); }
  }
  async create(to: string, attemptId: string, seconds: number): Promise<string> {
    if (!this.config.allowedTo.includes(to)) throw new TwilioRequestError(true);
    const base = `${this.config.publicOrigin}/twilio/${encodeURIComponent(attemptId)}`;
    const fields = new URLSearchParams({ To: to, From: this.config.from, Url: callbackUrl(this.config, attemptId, 'voice'), StatusCallback: `${base}/status` });
    if (!this.config.trial) {
      for (const [key, value] of Object.entries({ Method: 'POST', StatusCallbackMethod: 'POST', Timeout: '20', TimeLimit: String(Math.min(240, seconds + 90)), Record: 'false' })) fields.set(key, value);
      for (const status of ['initiated', 'ringing', 'answered', 'completed']) fields.append('StatusCallbackEvent', status);
    }
    const result = await this.api('.json', fields);
    if (typeof result.sid !== 'string' || !/^CA[0-9a-f]{32}$/i.test(result.sid)) throw new TwilioRequestError(false);
    return result.sid;
  }
  async stop(sid: string): Promise<void> {
    if (!/^CA[0-9a-f]{32}$/i.test(sid)) throw new Error('Invalid call ID.');
    const current = await this.api(`/${sid}.json`);
    if (['completed', 'canceled', 'failed', 'busy', 'no-answer'].includes(String(current.status))) return;
    await this.api(`/${sid}.json`, new URLSearchParams({ Status: ['queued', 'ringing', 'initiated'].includes(String(current.status)) ? 'canceled' : 'completed' }));
  }
}

/** Owns external effects; neither browser commands nor restored timers place calls. */
export class CallCoordinator {
  private launched = new Set<string>();
  private stopped = new Set<string>();
  private pending: Promise<void> | null = null;
  private requested = false;
  private closing = false;
  constructor(private provider: VoiceProvider, private snapshot: () => Snapshot, private command: (c: Command) => void, private saved: () => Promise<boolean>) {}
  private active(id: string): boolean {
    const i = this.snapshot().incident;
    const a = i?.attempts.at(-1);
    return !this.closing && i?.status === 'calling' && a?.id === id && ['attempted', 'connected'].includes(a.status);
  }
  sync(): Promise<void> {
    this.requested = true;
    if (!this.pending) this.pending = (async () => {
      do { this.requested = false; await this.reconcile(); } while (this.requested);
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async stop(attempt: CallAttempt): Promise<boolean> {
    if (!attempt.providerCallSid || this.stopped.has(attempt.providerCallSid)) return true;
    try { await this.provider.stop(attempt.providerCallSid); this.stopped.add(attempt.providerCallSid); return true; }
    catch { this.command({ type: 'provider_cancel_failure', attemptId: attempt.id }); return false; }
  }
  private async reconcile() {
    const s = this.snapshot();
    // Stop obsolete calls before starting the next contact. Saved calls from a
    // prior process are canceled, never replayed. SID attachment persists races.
    for (const i of [s.incident, ...s.history]) for (const a of i?.attempts ?? []) {
      if (a.provider === 'twilio' && !this.active(a.id) && !(await this.stop(a))) return;
    }
    const i = this.snapshot().incident, a = i?.attempts.at(-1);
    if (!a || !this.active(a.id) || a.provider !== 'twilio' || a.providerCallSid || this.launched.has(a.id)) return;
    this.launched.add(a.id);
    if (!(await this.saved()) || !this.active(a.id)) {
      if (this.active(a.id)) this.command({ type: 'provider_failure', attemptId: a.id, uncertain: false });
      return;
    }
    const contact = i!.contactPlan.find(c => c.id === a.contactId);
    if (!contact?.optedIn || !contact.phone || !phoneNumber(contact.phone)) {
      this.command({ type: 'provider_failure', attemptId: a.id, uncertain: false }); return;
    }
    try {
      const sid = await this.provider.create(contact.phone, a.id, this.snapshot().config.callSeconds);
      this.command({ type: 'provider_call', attemptId: a.id, callSid: sid });
      if (!(await this.saved())) {
        this.command({ type: 'provider_failure', attemptId: a.id, uncertain: true });
        await this.stop({ ...a, providerCallSid: sid }); return;
      }
      // A person can cancel while the outbound HTTP request is in flight.
      if (!this.active(a.id)) await this.stop({ ...a, providerCallSid: sid });
    } catch (error) {
      this.command({ type: 'provider_failure', attemptId: a.id, uncertain: !(error instanceof TwilioRequestError && error.definitive), ...(error instanceof TwilioRequestError && error.providerCode !== undefined ? { providerCode: error.providerCode } : {}) });
    }
  }
  async close() { this.closing = true; await this.sync(); }
}
