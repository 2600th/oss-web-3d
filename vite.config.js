import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    // Keep stable third-party engines independently cacheable. The application
    // changes far more often than Three/Postprocessing, and the measured
    // monolithic production entry was 1.089 MB minified.
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/three/')) return 'three';
          if (id.includes('/node_modules/postprocessing/')) return 'postprocessing';
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
});
