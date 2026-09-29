import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

// The dev server's copy of web.config rule 2: /global and everything under it is the global console.
// Without it the dev server falls back to index.html and /global shows the customer portal.
const globalConsole = (): Plugin => ({
  name: 'global-console',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/global(\/|\?|$)/.test(req.url) && !req.url.startsWith('/global.html')) req.url = '/global.html';
      next();
    });
  },
});

// Every build gets an id, compiled in as __BUILD_ID__ and written to /version.json, so an open page can tell
// that a newer version has been deployed since it was loaded (src/version.tsx).
const BUILD_ID = new Date().toISOString();
const versionFile = (): Plugin => ({
  name: 'version-file',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) });
  },
});

// In development the API runs on :4100; proxying keeps the browser same-origin so the
// httpOnly SameSite=Strict refresh cookie works exactly as it will behind IIS.
// API_TARGET (in client/.env.local or the environment) points the proxy elsewhere, e.g. on a machine
// where the installed service already owns :4100.
export default defineConfig(({ mode }) => ({
  plugins: [react(), globalConsole(), versionFile()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  // Two entry points: the customer portal (index.html) and the global management console
  // (global.html), which IIS serves at /global. They share styles but never share a session.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        global: fileURLToPath(new URL('global.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: loadEnv(mode, process.cwd(), '').API_TARGET || 'http://localhost:4100', changeOrigin: false } },
  },
}));
