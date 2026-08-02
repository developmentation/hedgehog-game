#!/usr/bin/env node
/**
 * Dashboard updater for Spindash Speller.
 *
 * Every builder/critic agent calls this instead of editing progress/status.json
 * by hand. Reads, mutates and writes the file atomically (temp file + rename)
 * behind a lock file, so concurrent agents can't clobber each other.
 *
 * Usage:
 *   node progress/update.mjs module <id> [--status building] [--iteration 2]
 *                                        [--score 72] [--verdict "..."]
 *                                        [--gap "..."] [--owner art-2] [--create]
 *   node progress/update.mjs iteration --module art-world --actor critic
 *                                      --summary "..." [--score 72] [--ts <iso>]
 *   node progress/update.mjs perf --file captures/run-01/report.json
 *   node progress/update.mjs perf --json '{"fps":{"p50":60,"p95":60}}'
 *   node progress/update.mjs shot --label "world v2"
 *                                 --path captures/run-01/03-play.png
 *                                 [--module art-world] [--ts <iso>]
 *   node progress/update.mjs show            # print current status.json
 *
 * Notes for callers:
 *   - --status must be one of: pending, building, critiquing, done, blocked.
 *   - Paths are stored relative to the project root (the dashboard resolves
 *     them as ../<path>), so pass them exactly as tools/capture.mjs prints them.
 *   - iterations[] is capped at the 200 most recent entries.
 *   - Pass an empty string (or "null") to clear --verdict / --gap / --score.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATUS = path.join(HERE, 'status.json');
const LOCK = path.join(HERE, '.status.lock');

const STATUSES = ['pending', 'building', 'critiquing', 'done', 'blocked'];
const ACTORS = ['builder', 'critic'];
const MAX_ITERATIONS = 200;
const LOCK_STALE_MS = 5000;
const MAX_ATTEMPTS = 60;

/* ------------------------------------------------------------------ utils */

function die(msg, extra) {
  process.stderr.write(`update.mjs: ${msg}\n`);
  if (extra) process.stderr.write(`${extra}\n`);
  process.exit(1);
}

const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));

const nowIso = () => new Date().toISOString();

/** Parse `--key value`, `--key=value` and bare `--flag`. */
function parseArgs(argv) {
  const flags = Object.create(null);
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const next = argv[i + 1];
      const nextIsFlag = next !== undefined && next.startsWith('--') && Number.isNaN(Number(next));
      if (next === undefined || nextIsFlag) value = true;
      else {
        value = next;
        i++;
      }
    }
    if (!key) die(`bad argument "${arg}"`);
    flags[key] = value;
  }
  return { flags, positional };
}

function requireStr(flags, name, cmd) {
  const v = flags[name];
  if (v === undefined) die(`${cmd}: missing required --${name}`);
  if (v === true) die(`${cmd}: --${name} needs a value`);
  return String(v);
}

/** "" / "null" / "none" clear the field; anything else is the trimmed string. */
function nullableStr(v) {
  if (v === undefined) return undefined;
  if (v === true) return null;
  const s = String(v).trim();
  if (s === '' || s === 'null' || s === 'none') return null;
  return s;
}

function nullableNum(v, name, { min = -Infinity, max = Infinity, int = false } = {}) {
  if (v === undefined) return undefined;
  if (v === true) return null;
  const s = String(v).trim();
  if (s === '' || s === 'null' || s === 'none') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) die(`--${name} must be a number (got "${s}")`);
  if (int && !Number.isInteger(n)) die(`--${name} must be a whole number (got "${s}")`);
  if (n < min || n > max) die(`--${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

function isoOr(v, fallback) {
  if (v === undefined || v === true) return fallback;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) die(`--ts is not a valid date (got "${v}")`);
  return d.toISOString();
}

/** Store paths relative to the project root, POSIX-separated. */
function normalisePath(p) {
  const raw = String(p).trim();
  if (/^(https?:|data:|\/)/i.test(raw)) return raw;
  const abs = path.resolve(process.cwd(), raw);
  const rel = path.relative(ROOT, abs);
  const chosen = rel && !rel.startsWith('..') ? rel : raw;
  return chosen.split(path.sep).join('/');
}

/** Resolve a user-supplied file against cwd, then the project root. */
function resolveExisting(p) {
  const a = path.resolve(process.cwd(), p);
  if (existsSync(a)) return a;
  const b = path.resolve(ROOT, p);
  if (existsSync(b)) return b;
  return null;
}

/* ------------------------------------------------------- read/modify/write */

const EMPTY = {
  project: 'Spindash Speller',
  updatedAt: null,
  goal: '',
  modules: [],
  iterations: [],
  perf: null,
  shots: [],
};

function writeAtomic(data) {
  const tmp = `${STATUS}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, STATUS); // atomic replace on both POSIX and Windows
}

function acquireLock() {
  try {
    closeSync(openSync(LOCK, 'wx'));
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) unlinkSync(LOCK);
    } catch {
      /* someone else cleaned it up */
    }
    return false;
  }
}

const releaseLock = () => {
  try {
    unlinkSync(LOCK);
  } catch {
    /* already gone */
  }
};

/**
 * Run `mutate(data)` against status.json under a lock, verify nothing changed
 * underneath us, then write atomically. Retries on lock contention or conflict.
 */
function withStatus(mutate) {
  if (!existsSync(HERE)) mkdirSync(HERE, { recursive: true });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!acquireLock()) {
      sleepSync(20 + Math.floor(Math.random() * 60));
      continue;
    }
    try {
      let raw = '';
      let data;
      if (existsSync(STATUS)) {
        raw = readFileSync(STATUS, 'utf8');
        try {
          data = JSON.parse(raw);
        } catch (err) {
          die(`status.json is not valid JSON (${err.message}). Fix or delete it and retry.`);
        }
      } else {
        data = structuredClone(EMPTY);
      }

      for (const [key, value] of Object.entries(EMPTY)) {
        if (data[key] === undefined) data[key] = structuredClone(value);
      }
      if (!Array.isArray(data.modules)) data.modules = [];
      if (!Array.isArray(data.iterations)) data.iterations = [];
      if (!Array.isArray(data.shots)) data.shots = [];

      const note = mutate(data);

      data.iterations.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
      if (data.iterations.length > MAX_ITERATIONS) {
        data.iterations = data.iterations.slice(-MAX_ITERATIONS);
      }
      data.updatedAt = nowIso();

      // Conflict check: did another writer land between our read and write?
      const current = existsSync(STATUS) ? readFileSync(STATUS, 'utf8') : '';
      if (current !== raw) {
        releaseLock();
        sleepSync(20 + Math.floor(Math.random() * 60));
        continue;
      }

      writeAtomic(data);
      return note ?? 'ok';
    } finally {
      releaseLock();
    }
  }
  die('could not update status.json — lock stayed busy after 60 attempts.');
}

/* ------------------------------------------------------------- subcommands */

function findModule(data, id) {
  return data.modules.find((m) => m.id === id) ?? null;
}

function cmdModule(flags, positional) {
  const id = positional[0] ?? nullableStr(flags.id);
  if (!id) die('module: missing module id\n  usage: update.mjs module <id> --status building');

  const status = flags.status === undefined ? undefined : String(flags.status);
  if (status !== undefined && !STATUSES.includes(status)) {
    die(
      `invalid --status "${status}"`,
      `  allowed: ${STATUSES.join(', ')}`,
    );
  }
  const iteration = nullableNum(flags.iteration, 'iteration', { min: 0, int: true });
  const score = nullableNum(flags.score, 'score', { min: 0, max: 100 });
  const verdict = nullableStr(flags.verdict);
  const gap = nullableStr(flags.gap);
  const owner = nullableStr(flags.owner);
  const title = nullableStr(flags.title);
  const create = flags.create === true || flags.create === 'true';

  return withStatus((data) => {
    let mod = findModule(data, id);
    if (!mod) {
      if (!create) {
        die(
          `unknown module "${id}"`,
          `  known: ${data.modules.map((m) => m.id).join(', ') || '(none)'}\n` +
            '  pass --create to add it',
        );
      }
      mod = {
        id,
        title: title ?? id,
        owner: owner ?? 'unassigned',
        status: 'pending',
        iteration: 0,
        score: null,
        verdict: null,
        gap: null,
        updatedAt: nowIso(),
      };
      data.modules.push(mod);
    }
    if (title !== undefined && title !== null) mod.title = title;
    if (owner !== undefined && owner !== null) mod.owner = owner;
    if (status !== undefined) mod.status = status;
    if (iteration !== undefined) mod.iteration = iteration ?? 0;
    if (score !== undefined) mod.score = score;
    if (verdict !== undefined) mod.verdict = verdict;
    if (gap !== undefined) mod.gap = gap;
    mod.updatedAt = nowIso();
    return `module ${id}: status=${mod.status} iteration=${mod.iteration} score=${
      mod.score ?? '-'
    }`;
  });
}

function cmdIteration(flags) {
  const moduleId = requireStr(flags, 'module', 'iteration');
  const actor = requireStr(flags, 'actor', 'iteration');
  if (!ACTORS.includes(actor)) {
    die(`invalid --actor "${actor}"`, `  allowed: ${ACTORS.join(', ')}`);
  }
  const summary = requireStr(flags, 'summary', 'iteration').trim();
  if (!summary) die('iteration: --summary must not be empty');
  const score = nullableNum(flags.score, 'score', { min: 0, max: 100 });
  const ts = isoOr(flags.ts, nowIso());

  return withStatus((data) => {
    if (!findModule(data, moduleId)) {
      process.stderr.write(
        `update.mjs: warning - "${moduleId}" is not a known module id; logging it anyway\n`,
      );
    }
    const entry = { ts, module: moduleId, actor, summary };
    if (score !== undefined && score !== null) entry.score = score;
    data.iterations.push(entry);
    return `iteration logged: ${actor} / ${moduleId}`;
  });
}

/** Accept a capture report.json, a bare perf object, or inline --json. */
function cmdPerf(flags) {
  let report;
  let source = null;

  if (flags.json !== undefined && flags.json !== true) {
    try {
      report = JSON.parse(String(flags.json));
    } catch (err) {
      die(`perf: --json is not valid JSON (${err.message})`);
    }
  } else {
    const file = requireStr(flags, 'file', 'perf');
    const abs = resolveExisting(file);
    if (!abs) die(`perf: no such file "${file}" (looked in cwd and ${ROOT})`);
    try {
      report = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (err) {
      die(`perf: could not parse "${file}" (${err.message})`);
    }
    source = normalisePath(abs);
  }

  const p = report && typeof report === 'object' && report.perf ? report.perf : report;
  if (!p || typeof p !== 'object') die('perf: report contains no perf data');

  return withStatus((data) => {
    data.perf = {
      capturedAt: report.capturedAt ?? nowIso(),
      source,
      device: report.device ?? null,
      headed: report.headed ?? null,
      gpuTrustworthy: report.gpuTrustworthy ?? null,
      fps: p.fps ?? null,
      updateMs: p.updateMs ?? null,
      renderMs: p.renderMs ?? null,
      drawCalls: p.drawCalls ?? null,
      sprites: p.sprites ?? null,
      heapMb: p.heapMb ?? null,
      atlasSize: p.atlasSize ?? null,
      atlasOccupancy: p.atlasOccupancy ?? null,
      longFrames: p.longFrames ?? null,
      consoleErrors: Array.isArray(report.consoleErrors) ? report.consoleErrors.length : null,
    };
    return `perf updated${source ? ` from ${source}` : ''}`;
  });
}

function cmdShot(flags) {
  const rel = normalisePath(requireStr(flags, 'path', 'shot'));
  const label = flags.label === undefined || flags.label === true
    ? path.basename(rel)
    : String(flags.label);
  const moduleId = nullableStr(flags.module) ?? null;
  const ts = isoOr(flags.ts, nowIso());

  if (!resolveExisting(rel)) {
    process.stderr.write(`update.mjs: warning - "${rel}" does not exist on disk yet\n`);
  }

  return withStatus((data) => {
    const shot = { label, path: rel, module: moduleId, ts };
    const at = data.shots.findIndex((s) => s.path === rel);
    if (at === -1) data.shots.push(shot);
    else data.shots[at] = shot;
    data.shots.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
    return `shot ${at === -1 ? 'added' : 'replaced'}: ${rel}`;
  });
}

function cmdShow() {
  if (!existsSync(STATUS)) die('no status.json yet');
  process.stdout.write(readFileSync(STATUS, 'utf8'));
  return null;
}

/* ------------------------------------------------------------------- main */

const [cmd, ...rest] = process.argv.slice(2);
const { flags, positional } = parseArgs(rest);

const USAGE = `usage:
  update.mjs module <id> [--status ${STATUSES.join('|')}] [--iteration N]
                         [--score 0-100] [--verdict "..."] [--gap "..."]
                         [--owner NAME] [--title "..."] [--create]
  update.mjs iteration --module <id> --actor builder|critic --summary "..." [--score N] [--ts ISO]
  update.mjs perf --file <report.json> | --json '<json>'
  update.mjs shot --path <file> [--label "..."] [--module <id>] [--ts ISO]
  update.mjs show`;

let result;
switch (cmd) {
  case 'module':
    result = cmdModule(flags, positional);
    break;
  case 'iteration':
    result = cmdIteration(flags);
    break;
  case 'perf':
    result = cmdPerf(flags);
    break;
  case 'shot':
    result = cmdShot(flags);
    break;
  case 'show':
    result = cmdShow();
    break;
  case undefined:
  case '--help':
  case '-h':
  case 'help':
    process.stdout.write(`${USAGE}\n`);
    process.exit(cmd ? 0 : 1);
    break;
  default:
    die(`unknown subcommand "${cmd}"`, USAGE);
}

if (result) process.stdout.write(`${result}\n`);
