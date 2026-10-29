import http from 'node:http';

/** Only signed-call callback paths are forwarded; dashboard/API routes stay local. */
export async function createCallbackProxy(port = 8788, appPort = 8787) {
  const proxy = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/^\/twilio\/[\w-]{1,100}\/(voice|digits|status)(\?cap=[\w-]{43})?$/.test(req.url ?? '')) {
      res.writeHead(404); res.end('Not found.'); return;
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: appPort, path: req.url, method: 'POST', headers: {
      host: `127.0.0.1:${appPort}`, 'content-type': req.headers['content-type'] ?? '', 'x-twilio-signature': req.headers['x-twilio-signature'] ?? '',
    } }, response => { res.writeHead(response.statusCode ?? 502, { 'Content-Type': response.headers['content-type'] ?? 'text/plain', 'Cache-Control': 'no-store' }); response.pipe(res); });
    upstream.setTimeout(15_000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Callback service unavailable.'); });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(port, '127.0.0.1', resolve); });
  return proxy;
}
