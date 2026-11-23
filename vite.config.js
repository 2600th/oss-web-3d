import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        // three.js changes far less often than the game; keep it separately cacheable.
        advancedChunks: {
          groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }],
        },
      },
    },
    chunkSizeWarningLimit: 1600,
  },
});
