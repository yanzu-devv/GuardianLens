/** Native Node 24 .env support; values never enter the frontend or saved state. */
export function loadLocalEnvironment() {
  try { process.loadEnvFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The local .env file could not be loaded.'); }
}
