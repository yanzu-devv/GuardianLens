import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createGuardianServer } from '../src/server/index.js';

import { loadLocalEnvironment } from '../src/server/environment.js';
loadLocalEnvironment();

const server = await createGuardianServer();
const executable = createRequire(import.meta.url)('electron') as string;
const env: NodeJS.ProcessEnv = { ...process.env, GUARDIAN_ORIGIN: server.origin, GUARDIAN_OWNER_TOKEN: server.ownerToken };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, ['.'], { cwd: process.cwd(), env, stdio: 'inherit' });
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  child.kill('SIGTERM');
  await server.close();
  process.exit(code);
}
child.once('error', error => { console.error(error); void close(1); });
child.once('exit', code => { void close(code ?? 0); });
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
