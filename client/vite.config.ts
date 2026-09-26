import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on :4100; proxying keeps the browser same-origin so the
// httpOnly SameSite=Strict refresh cookie works exactly as it will behind IIS.
export default defineConfig({
  plugins: [react()],
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
    proxy: { '/api': { target: 'http://localhost:4100', changeOrigin: false } },
  },
});
