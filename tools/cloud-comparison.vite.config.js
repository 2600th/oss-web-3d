import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const comparisonEntry = fileURLToPath(
  new URL('../src/world/cloud/comparison.html', import.meta.url),
);

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  build: {
    manifest: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    outDir: fileURLToPath(new URL('../.agent/cloud-comparison-dist', import.meta.url)),
    emptyOutDir: true,
    rolldownOptions: {
      input: { comparison: comparisonEntry },
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@takram/')) return 'takram';
          if (id.includes('/node_modules/three/')) return 'three';
          if (id.includes('/node_modules/postprocessing/')) return 'postprocessing';
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  root: repositoryRoot,
});
