// Dev-server middleware for frame-exact video capture (src/game/dev/capture.js).
//
// POST /__capture/frame?clip=<name>&i=<frame>&ext=jpg|png  (body: the encoded frame)
//   -> <dir>/<clip>/<00000>.<ext>
//
// Only installed by `vite` in serve mode (apply: 'serve'); nothing ships in a
// build. The capture directory must be outside the watched tree (vite.config.js
// ignores it), or every frame written would trigger a reload.
import fs from 'node:fs';
import path from 'node:path';

const safe = (s, fallback) => (String(s ?? '').replace(/[^\w.-]/g, '') || fallback);

export function capturePlugin({ dir }) {
  return {
    name: 'dev-capture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__capture/frame', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const u = new URL(req.url, 'http://local');
        const clip = safe(u.searchParams.get('clip'), 'clip');
        const i = Math.max(0, parseInt(u.searchParams.get('i') ?? '0', 10) || 0);
        const ext = u.searchParams.get('ext') === 'png' ? 'png' : 'jpg';
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          try {
            const d = path.join(dir, clip);
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(path.join(d, `${String(i).padStart(5, '0')}.${ext}`), Buffer.concat(chunks));
            res.end('ok');
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e?.message ?? e));
          }
        });
      });
    },
  };
}
