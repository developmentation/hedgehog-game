/**
 * A private, race-proof build + static server for the measurement harnesses.
 *
 * Neither `vite preview` nor `vite dev` survives this repo. Several agents work
 * in the tree at once: `dist/` is rebuilt out from under a run (one benchmark
 * spent two minutes serving 404s), and the dev server's HMR reloads the page
 * the moment anyone saves a file, which throws away the whole measurement
 * session mid-flight. So each harness builds its own snapshot into a scratch
 * directory and serves it from its own process — no shared port, no shared
 * output directory, nothing to race.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/** Build the app into a scratch directory of its own and return the path. */
export async function buildSnapshot(name, root = path.resolve('.')) {
  const outDir = path.join(os.tmpdir(), `hedgehog-${name}-dist`);
  await new Promise((resolve, reject) => {
    const p = spawn('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
      cwd: root,
      shell: true,
      stdio: 'ignore',
    });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('vite build failed'))));
  });
  return outDir;
}

/** Serve `dir` on `port` from this process. Returns the http.Server. */
export function serveStatic(dir, port) {
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const file = path.join(dir, rel);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
