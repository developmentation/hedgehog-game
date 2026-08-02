/**
 * Builds `screenshots/index.html` — a browsable gallery of every capture run,
 * newest first, so the visual evolution of the build is reviewable in one
 * page. Re-run after any `npm run shot`.
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const SHOTS = path.join(ROOT, 'screenshots');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function main() {
  let dirs = [];
  try {
    dirs = (await readdir(SHOTS, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name !== 'latest')
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    console.error('no screenshots/ directory yet');
    process.exit(1);
  }

  const runs = [];
  for (const name of dirs) {
    const dir = path.join(SHOTS, name);
    let manifest = null;
    try {
      manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      /* fall back to a directory listing */
    }
    let files = manifest?.shots?.map((s) => ({ file: path.basename(s.file), name: s.name, note: s.note }));
    if (!files) {
      const entries = await readdir(dir).catch(() => []);
      files = entries.filter((f) => f.endsWith('.png')).sort().map((f) => ({ file: f, name: f, note: '' }));
    }
    const st = await stat(dir);
    runs.push({ name, manifest, files, mtime: manifest?.capturedAt ?? st.mtime.toISOString() });
  }

  const body = runs
    .map((run) => {
      const p = run.manifest?.perf;
      const errs = run.manifest?.errors ?? [];
      const meta = [
        run.manifest?.note ? esc(run.manifest.note) : null,
        run.manifest?.device ? `device: ${esc(run.manifest.device)}` : null,
        p?.fps != null ? `${Math.round(p.fps)} fps` : null,
        p?.drawCalls != null ? `${p.drawCalls} draw calls` : null,
        p?.sprites != null ? `${p.sprites} sprites` : null,
      ]
        .filter(Boolean)
        .join(' · ');

      const tiles = run.files
        .map(
          (f) => `
        <figure class="tile">
          <a href="${esc(run.name)}/${esc(f.file)}" target="_blank" rel="noreferrer">
            <img loading="lazy" src="${esc(run.name)}/${esc(f.file)}" alt="${esc(f.name)}">
          </a>
          <figcaption><b>${esc(f.name)}</b>${f.note ? `<span>${esc(f.note)}</span>` : ''}</figcaption>
        </figure>`,
        )
        .join('');

      return `
    <section class="run">
      <header>
        <h2>${esc(run.name)}</h2>
        <time>${esc(new Date(run.mtime).toLocaleString())}</time>
        ${meta ? `<p class="meta">${meta}</p>` : ''}
        ${errs.length ? `<p class="errs">${errs.length} console error${errs.length > 1 ? 's' : ''}: ${esc(errs[0]).slice(0, 160)}</p>` : ''}
      </header>
      <div class="grid">${tiles}</div>
    </section>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spindash Speller — capture history</title>
<style>
  :root{color-scheme:dark light;--bg:#0b0e17;--card:#141926;--line:#232a3d;--fg:#e6ebf7;--dim:#8e9ab5;--accent:#ffc857;--bad:#ff6b7a}
  @media (prefers-color-scheme:light){:root{--bg:#f5f6fa;--card:#fff;--line:#e2e6f0;--fg:#141824;--dim:#5d6885}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:32px clamp(16px,4vw,56px) 80px}
  h1{font-size:clamp(22px,3vw,30px);margin:0 0 4px;letter-spacing:-.02em}
  .sub{color:var(--dim);margin:0 0 36px}
  .run{margin:0 0 44px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px clamp(14px,2vw,24px) 24px}
  .run header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 14px;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--line)}
  h2{font-size:17px;margin:0;letter-spacing:-.01em}
  time{color:var(--dim);font-size:13px;font-variant-numeric:tabular-nums}
  .meta{width:100%;margin:2px 0 0;color:var(--dim);font-size:13px;font-variant-numeric:tabular-nums}
  .errs{width:100%;margin:6px 0 0;color:var(--bad);font-size:13px}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
  .tile{margin:0}
  .tile img{width:100%;display:block;border-radius:9px;border:1px solid var(--line);background:#000;aspect-ratio:16/9;object-fit:contain}
  figcaption{margin-top:7px;font-size:12.5px;color:var(--dim);display:flex;flex-direction:column;gap:1px}
  figcaption b{color:var(--fg);font-weight:600}
  a{color:var(--accent)}
</style></head><body>
<h1>Spindash Speller</h1>
<p class="sub">Capture history — newest run first. ${runs.length} run${runs.length === 1 ? '' : 's'}.</p>
${body || '<p class="sub">No captures yet.</p>'}
</body></html>`;

  await writeFile(path.join(SHOTS, 'index.html'), html);
  console.log(`gallery -> screenshots/index.html (${runs.length} runs)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
