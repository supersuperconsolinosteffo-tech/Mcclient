import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: 'ui',
  base: './',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 16384,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
});
