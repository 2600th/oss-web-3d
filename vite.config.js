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
    // `advancedChunks` is rolldown's own grouping mechanism. The Rollup-style
    // `manualChunks` callback was accepted without error but did not group the
    // way it reads: the emitted chunk named `three` held GLTFLoader and the
    // meshoptimizer decoder, while three.js core itself shipped inside the
    // chunk named `postprocessing`. Both are third-party and stable, so nothing
    // was broken — but the caching property this block exists to provide was
    // not the one it was delivering, and the names actively misled.
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ },
            { name: 'postprocessing', test: /[\\/]node_modules[\\/]postprocessing[\\/]/ },
          ],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
});
