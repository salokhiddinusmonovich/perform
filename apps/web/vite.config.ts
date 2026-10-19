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
    rollupOptions: {
      output: {
        // Libraries change rarely; separate chunks stay cached across app deploys.
        manualChunks: {
          react: ['react', 'react-dom', 'react-dom/client', 'react-router'],
          ui: ['radix-ui', 'sonner'],
          data: ['@tanstack/react-query', '@tanstack/react-table'],
          i18n: ['i18next', 'react-i18next'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4100' },
  },
});
