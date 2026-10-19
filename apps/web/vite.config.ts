import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Keep the browser's Host header (Vite's short form rewrites it), like nginx does in
// production: the API rejects data-changing requests whose Origin doesn't match Host.
const apiProxy = { target: 'http://127.0.0.1:4100', changeOrigin: false };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    rollupOptions: {
      output: {
        // React itself (which depends on nothing else) gets its own long-cached chunk;
        // every other library is placed by Rollup next to the pages that use it, so the
        // login page doesn't download table or form code.
        // Never put other libraries into named manual chunks: React and the libraries
        // built on it ended up importing each other across chunks, and the production
        // app crashed at startup ("Cannot set properties of undefined (setting
        // 'Activity')", 2026-10-19). scripts/smoke.mjs catches that.
        manualChunks: (id) =>
          /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id) ? 'react' : undefined,
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': apiProxy },
  },
  // `vite preview` serves the production build; same API proxy as dev.
  preview: {
    port: 4173,
    proxy: { '/api': apiProxy },
  },
});
