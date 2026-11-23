import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
// Anchored to this project's root: a '**/.claude/**' glob also matched the
// root itself when the project *is* an agent worktree (.claude/worktrees/x),
// which silently disabled file watching there (stale modules, no HMR).
const IGNORED_DIRS = ['.claude', 'legacy', 'legacy-tools'];
const ignored = (file) => {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const top = rel.split(/[\\/]/)[0];
  return IGNORED_DIRS.includes(top);
};

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Agent worktrees and the legacy tree live under the root; never watch them.
    watch: { ignored },
  },
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
