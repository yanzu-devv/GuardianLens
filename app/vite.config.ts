import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: { outDir: 'dist', emptyOutDir: true },
  server: { host: '127.0.0.1', allowedHosts: ['localhost', '127.0.0.1'] },
});
