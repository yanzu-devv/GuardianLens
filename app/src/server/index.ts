import http from 'node:http';
import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Engine } from './engine.js';
import { parseCommand, projectSnapshot, tokenMatches, validateSavedSnapshot, type Role } from './security.js';
import { CallCoordinator, TwilioVoice, readTwilioConfig, validTwilioSignature, validTrialCapability, callbackUrl, gatherTwiml, hangupTwiml, type TwilioConfig, type VoiceProvider } from './twilio.js';
import { loadLocalEnvironment } from './environment.js';
import type { Command, Snapshot } from '../shared/domain.js';

type Client = { role: Role; expiresAt: number; alive: boolean };
export interface ServerOptions { port?: number; dataDir?: string; publicOrigin?: string; dev?: boolean; quiet?: boolean; voice?: { config: TwilioConfig; provider?: VoiceProvider } }

export async function createGuardianServer(options: ServerOptions = {}) {
  const port = options.port ?? Number(process.env.PORT || 8787);
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
  if (publicOrigin) {
    const u = new URL(publicOrigin);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('PUBLIC_ORIGIN must be one HTTPS origin, without a path or credentials.');
  }
  const voiceConfig = options.voice?.config ?? readTwilioConfig(process.env, publicOrigin);
  const ownerToken = randomBytes(32).toString('base64url');
  let phoneToken: { token: string; expiresAt: number } | null = null;
  let snapshot: Snapshot | undefined;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  try {
    const saved: unknown = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
    validateSavedSnapshot(saved);
    snapshot = saved;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved state cannot be read. Preserve data/state.json for inspection before restarting.'); }
  const engine = new Engine({ snapshot, callMode: voiceConfig ? 'twilio' : 'simulated' });
  const clients = new Map<WebSocket, Client>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, handleProtocols: protocols => protocols.has('guardianlens') ? 'guardianlens' : false });
  let persistChain: Promise<void> = Promise.resolve();
  let persistenceFailure: string | null = null;
  let localOrigin = `http://127.0.0.1:${port}`;
  let voice: CallCoordinator | undefined;
  let shuttingDown = false;
  let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;

  const allowedOrigin = (origin: string | undefined) => origin === localOrigin || origin === localOrigin.replace('127.0.0.1', 'localhost') || Boolean(publicOrigin && origin === new URL(publicOrigin).origin);
  const allowedHost = (host: string | undefined) => host === new URL(localOrigin).host || host === new URL(localOrigin.replace('127.0.0.1', 'localhost')).host || Boolean(publicOrigin && host === new URL(publicOrigin).host);
  function authenticate(token: string): { role: Role; expiresAt: number } | null {
    if (tokenMatches(token, ownerToken)) return { role: 'owner', expiresAt: Infinity };
    if (phoneToken && phoneToken.expiresAt > Date.now() && tokenMatches(token, phoneToken.token)) return { role: 'phone', expiresAt: phoneToken.expiresAt };
    return null;
  }
  function sendSnapshot(socket: WebSocket, role: Role) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'snapshot', snapshot: projectSnapshot(engine.snapshot, role), persistenceFailure }));
  }
  function broadcast() { for (const [socket, client] of clients) sendSnapshot(socket, client.role); }
  function persist() {
    const data = JSON.stringify(engine.snapshot);
    persistChain = persistChain.then(async () => {
      await writeFile(path.join(dataDir, 'state.json.tmp'), data, { mode: 0o600 });
      await rename(path.join(dataDir, 'state.json.tmp'), path.join(dataDir, 'state.json'));
    }).catch(() => {
      persistenceFailure = 'Incident log could not be saved to disk. Keep this session open and check available disk space.';
      console.error(persistenceFailure);
      broadcast();
    });
  }
  function changed(previous: number) {
    if (engine.snapshot.revision !== previous) { persist(); broadcast(); if (voice) void voice.sync().catch(() => console.error('Call coordination interrupted. Check Twilio call logs.')); }
  }
  function providerCommand(command: Command) {
    const previous = engine.snapshot.revision;
    engine.command(command); changed(previous);
  }
  if (voiceConfig) voice = new CallCoordinator(options.voice?.provider ?? new TwilioVoice(voiceConfig), () => engine.snapshot, providerCommand, async () => { await persistChain; return persistenceFailure === null; });
  function currentCall(attemptId: string) {
    const incident = engine.snapshot.incident;
    const attempt = incident?.attempts.at(-1);
    return !shuttingDown && incident?.status === 'calling' && attempt?.id === attemptId && attempt.provider === 'twilio' && ['attempted', 'connected'].includes(attempt.status) ? attempt : null;
  }
  async function twilioWebhook(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const match = /^\/twilio\/([\w-]{1,100})\/(voice|digits|status)$/.exec(url.pathname);
    if (!voiceConfig || !match || req.method !== 'POST') return json(res, 404, { error: 'Endpoint not found.' });
    if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') return json(res, 415, { error: 'Expected form data.' });
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > 16_384) return json(res, 413, { error: 'Request too large.' }); chunks.push(Buffer.from(chunk)); }
    const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const signature = req.headers['x-twilio-signature'];
    const signatureValid = typeof signature === 'string' && validTwilioSignature(voiceConfig.authToken, voiceConfig.publicOrigin + req.url, fields, signature);
    const accountValid = fields.get('AccountSid') === voiceConfig.accountSid;
    const rejected = (reason: string, message: string) => {
      // Log only fixed diagnostic labels, never request bodies, signatures,
      // account IDs, phone numbers, or callback credentials.
      if (!options.quiet) console.warn(`Twilio ${match[2]} callback rejected: ${reason}.`);
      return json(res, 403, { error: message });
    };
    const trialCapabilityValid = !signature && url.searchParams.getAll('cap').length === 1 && validTrialCapability(voiceConfig, match[1]!, match[2]!, url.searchParams.get('cap') ?? '');
    if ((!signatureValid && !trialCapabilityValid) || !accountValid) return rejected(!signatureValid && !trialCapabilityValid ? (signature ? 'signature mismatch' : 'missing signature') : 'account mismatch', 'Invalid Twilio signature.');
    const attemptId = match[1]!, action = match[2]!;
    const sid = fields.get('CallSid') ?? '';
    const attempt = [engine.snapshot.incident, ...engine.snapshot.history].flatMap(i => i?.attempts ?? []).find(a => a.id === attemptId && a.provider === 'twilio');
    if (!attempt || !/^CA[0-9a-f]{32}$/i.test(sid) || (attempt.providerCallSid && attempt.providerCallSid !== sid)) return rejected('attempt mismatch', 'Call does not match this attempt.');
    const incident = [engine.snapshot.incident, ...engine.snapshot.history].find(i => i?.attempts.some(a => a.id === attemptId));
    const contact = incident?.contactPlan.find(c => c.id === attempt.contactId);
    if (fields.get('To') !== contact?.phone || fields.get('From') !== voiceConfig.from || !voiceConfig.allowedTo.includes(fields.get('To') ?? '')) return rejected('participant mismatch', 'Unexpected call participant.');
    providerCommand({ type: 'provider_call', attemptId, callSid: sid });
    const previous = engine.snapshot.revision; engine.tick(); changed(previous);
    const active = currentCall(attemptId);
    let response = hangupTwiml();
    if (active) {
      if (action === 'voice') {
        providerCommand({ type: 'call_outcome', attemptId, outcome: 'connected' });
        response = gatherTwiml(callbackUrl(voiceConfig, attemptId, 'digits'), engine.snapshot.config.callSeconds, incident?.location);
      } else if (action === 'digits') {
        const digits = fields.get('Digits') ?? '';
        providerCommand({ type: 'call_outcome', attemptId, outcome: digits === '1' ? 'acknowledged' : digits === '' ? 'no_answer' : 'wrong_digit' });
        response = hangupTwiml(digits === '1' ? 'Acknowledgment received. Please check on the person. Help arrival has not been confirmed.' : 'No acknowledgment recorded. Goodbye.');
      } else {
        const status = fields.get('CallStatus');
        const outcome = status === 'in-progress' ? 'connected' : status === 'busy' ? 'declined' : status === 'failed' ? 'network_error' : ['completed', 'no-answer', 'canceled'].includes(status ?? '') ? 'no_answer' : null;
        if (outcome) providerCommand({ type: 'call_outcome', attemptId, outcome });
      }
    }
    await persistChain;
    if (persistenceFailure) response = hangupTwiml('This request could not be saved. Please check on the person directly.');
    if (action === 'status') { res.writeHead(204); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' }); res.end(response);
  }
  function presence() {
    const previous = engine.snapshot.revision;
    engine.command({ type: 'phone_presence', connected: [...clients.values()].some(c => c.role === 'phone' && c.expiresAt > Date.now()) });
    changed(previous);
  }
  function headers(res: http.ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(self)');
    const csp = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'${options.dev ? ' ws://127.0.0.1:* ws://localhost:*' : ''}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
    res.setHeader('Content-Security-Policy', csp);
  }
  function json(res: http.ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
  async function body(req: http.IncomingMessage) {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Send JSON.');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 32_768) throw new Error('Request too large.'); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  const server = http.createServer(async (req, res) => {
    headers(res);
    if (!allowedHost(req.headers.host)) return json(res, 403, { error: 'Unrecognized host.' });
    if (req.headers.origin && !allowedOrigin(req.headers.origin)) return json(res, 403, { error: 'Unrecognized origin.' });
    try {
      const url = new URL(req.url ?? '/', localOrigin);
      if (url.pathname.startsWith('/twilio/')) return await twilioWebhook(req, res, url);
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ready: true, calls: voiceConfig ? 'twilio' : 'simulated' });
      if (url.pathname.startsWith('/api/')) {
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        const auth = authenticate(token);
        if (!auth) return json(res, 401, { error: 'Open the private dashboard link printed by the server, or pair this phone again.' });
        if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, { snapshot: projectSnapshot(engine.snapshot, auth.role), role: auth.role, persistenceFailure });
        if (url.pathname === '/api/command' && req.method === 'POST') {
          const command = parseCommand(await body(req), auth.role);
          if (voiceConfig && command.type === 'call_outcome') return json(res, 403, { error: 'Real call outcomes can only come from verified Twilio callbacks.' });
          const previous = engine.snapshot.revision;
          engine.command(command);
          changed(previous);
          return json(res, 200, { snapshot: projectSnapshot(engine.snapshot, auth.role), persistenceFailure });
        }
        if (url.pathname === '/api/pair' && req.method === 'POST') {
          if (auth.role !== 'owner') return json(res, 403, { error: 'Only the Mac can pair a phone.' });
          phoneToken = { token: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 30 * 60_000 };
          for (const [socket, client] of clients) if (client.role === 'phone') socket.close(4001, 'Pairing link replaced.');
          const origin = publicOrigin ? new URL(publicOrigin).origin : localOrigin;
          return json(res, 200, { url: `${origin}/?view=phone#token=${phoneToken.token}`, expiresAt: phoneToken.expiresAt });
        }
        if (url.pathname === '/api/pair' && req.method === 'DELETE') {
          if (auth.role !== 'owner') return json(res, 403, { error: 'Only the Mac can unpair a phone.' });
          phoneToken = null;
          for (const [socket, client] of clients) if (client.role === 'phone') socket.close(4001, 'Phone unpaired.');
          return json(res, 200, { unpaired: true });
        }
        return json(res, 404, { error: 'Endpoint not found.' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
      if (vite) return vite.middlewares(req, res, () => json(res, 404, { error: 'Page not found.' }));
      const dist = path.resolve('dist');
      const pathname = decodeURIComponent(url.pathname);
      const candidate = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!candidate.startsWith(`${dist}${path.sep}`)) return json(res, 403, { error: 'Invalid path.' });
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.task': 'application/octet-stream' };
      let data: Buffer;
      try { data = await readFile(candidate); } catch { return json(res, 404, { error: 'File not found. Run npm run build first.' }); }
      res.writeHead(200, { 'Content-Type': types[path.extname(candidate)] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : 'Request failed.' });
      else res.end();
    }
  });
  server.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try { pathname = new URL(req.url ?? '/', localOrigin).pathname; }
    catch { socket.destroy(); return; }
    if (pathname !== '/ws') { if (!options.dev) socket.destroy(); return; }
    if (!allowedHost(req.headers.host) || !allowedOrigin(req.headers.origin)) { socket.destroy(); return; }
    const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(s => s.trim());
    const auth = authenticate(protocols.find(s => s.startsWith('auth.'))?.slice(5) ?? '');
    if (!auth || !protocols.includes('guardianlens')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      clients.set(ws, { ...auth, alive: true });
      ws.on('pong', () => { const client = clients.get(ws); if (client) client.alive = true; });
      ws.on('error', () => ws.terminate());
      ws.on('close', () => { clients.delete(ws); presence(); });
      // Client messages are unnecessary: mutations use authenticated, validated HTTP.
      sendSnapshot(ws, auth.role);
      presence();
    });
  });
  if (options.dev) {
    if (publicOrigin) throw new Error('Use a built production preview for HTTPS tunneling; do not expose the Vite development server.');
    const { createServer } = await import('vite');
    vite = await createServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  localOrigin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const ownerUrl = `${localOrigin}/#token=${ownerToken}`;
  persist();
  if (voice) void voice.sync().catch(() => console.error('Call recovery interrupted. Check Twilio call logs.'));
  const timer = setInterval(() => { const previous = engine.snapshot.revision; engine.tick(); changed(previous); }, 250);
  const ping = setInterval(() => {
    for (const [socket, client] of clients) {
      if (!client.alive || Date.now() > client.expiresAt) { socket.terminate(); continue; }
      client.alive = false; socket.ping();
    }
  }, 5_000);
  if (!options.quiet) console.log(`\nGuardianLens prototype · ${voiceConfig ? 'Twilio demo contact calls enabled; emergency dialing disabled' : 'all calls simulated'}\nPrivate Mac dashboard: ${ownerUrl}\nKeep this link private. Phone pairing is created inside the dashboard.\n`);
  async function close() {
    shuttingDown = true;
    clearInterval(timer); clearInterval(ping);
    await voice?.close();
    engine.command({ type: 'interrupt', reason: 'GuardianLens server stopped. Monitoring is interrupted.' });
    persist();
    for (const socket of clients.keys()) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await vite?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await persistChain;
  }
  return { server, engine, ownerToken, ownerUrl, origin: localOrigin, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadLocalEnvironment();
  createGuardianServer({ dev: process.argv.includes('--dev') }).then(instance => {
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      instance.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    });
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
