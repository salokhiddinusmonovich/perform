import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    // The single vendor chunk below is ~580 kB (~180 kB gzipped) by design.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // All libraries go into ONE vendor chunk, cached across app deploys.
        // Don't split libraries into several chunks: React and the libraries built on it
        // ended up importing each other across chunks, and the production app crashed
        // at startup ("Cannot set properties of undefined (setting 'Activity')").
        manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : undefined),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4100' },
  },
  // `vite preview` serves the production build; same API proxy as dev.
  preview: {
    port: 4173,
    proxy: { '/api': 'http://127.0.0.1:4100' },
  },
});
