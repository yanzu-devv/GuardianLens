import { createCallbackProxy } from '../src/server/callbackProxy.js';
import { loadLocalEnvironment } from '../src/server/environment.js';
loadLocalEnvironment();
const server = await createCallbackProxy(Number(process.env.WEBHOOK_PROXY_PORT || 8788), Number(process.env.PORT || 8787));
console.log('Callback-only proxy ready on 127.0.0.1:8788. Tunnel this port, not the dashboard.');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
