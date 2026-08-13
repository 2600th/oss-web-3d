import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    // Vite 8 bundles with Rolldown, whose manualChunks must be a function
    // rather than the object form Rollup accepted. Its default chunking already
    // splits the two large vendor libraries sensibly, so there is nothing worth
    // overriding here.
    chunkSizeWarningLimit: 900,
  },
});
