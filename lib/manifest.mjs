// The seal: manifest + snapshots under ~/.agent-lock, the log, and the comparison of a live
// inventory against what was pinned. The manifest never holds a secret value.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './inventory.mjs';
import { CONFIG_KINDS, parseConfig, semanticDiff } from './semantic.mjs';
import { LOCK_HOME } from './tools.mjs';

const MANIFEST = path.join(LOCK_HOME, 'manifest.json');
export const snapshotDir = (root) => path.join(LOCK_HOME, 'snapshots', sha256(root).slice(0, 16));

export function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch {
    return { version: 1, home: null, checkouts: {} };
  }
}

export function saveManifest(m) {
  fs.mkdirSync(LOCK_HOME, { recursive: true, mode: 0o700 });
  const tmp = `${MANIFEST}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(m, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, MANIFEST);
}

// Best effort by design: a read-only disk or a full one is not a reason to refuse a launch,
// and this is also called from the error paths that exist so nothing else can throw.
export function appendLog(event, root, detail = '') {
  try {
    fs.mkdirSync(LOCK_HOME, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(LOCK_HOME, 'log'),
      `${new Date().toISOString()}\t${event}\t${root}\t${detail}\n`,
      { mode: 0o600 }
    );
  } catch {
    /* the log is a convenience, never a gate */
  }
}

// Seal = record hashes + flags, and keep a copy of every readable non-secret text file so the
// next diff can be semantic instead of "hash changed".
export function seal(inv) {
  const m = loadManifest();
  const entry = { sealed_at: new Date().toISOString(), flags: inv.flags, files: {} };
  const dir = snapshotDir(inv.root);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of inv.files) {
    entry.files[f.rel] = { sha256: f.sha256, size: f.size, kind: f.kind, symlink: f.symlink };
    // Secret files (.env) keep only their key names in the snapshot, never a value.
    const copy = f.secret ? f.parsed && JSON.stringify(f.parsed) : f.text;
    if (copy !== null && copy !== undefined) {
      const dest = path.join(dir, snapshotRel(f.rel));
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, copy, { mode: 0o600 });
    }
  }
  if (inv.isHome) m.home = entry;
  else m.checkouts[inv.root] = entry;
  saveManifest(m);
  return entry;
}

export function sealedEntry(inv) {
  const m = loadManifest();
  return inv.isHome ? m.home : m.checkouts[inv.root] || null;
}

const snapshotRel = (rel) => rel.replace(/^~\//, 'home/').replace(/^plugin:/, 'plugin/');

export function snapshotText(inv, rel) {
  try {
    return fs.readFileSync(path.join(snapshotDir(inv.root), snapshotRel(rel)), 'utf8');
  } catch {
    return null;
  }
}

// Compare the live inventory with its seal. `hot` = something that runs, connects, or
// grants changed, or a new flag appeared. Everything else is reported dim.
export function compare(entry, inv) {
  const result = { added: [], removed: [], changed: [], newFlags: [], hot: false };
  if (!entry) return { ...result, unsealed: true, hot: true };
  const live = new Map(inv.files.map((f) => [f.rel, f]));
  for (const rel of Object.keys(entry.files)) if (!live.has(rel)) result.removed.push(rel);
  for (const f of inv.files) {
    const old = entry.files[f.rel];
    if (!old) {
      result.added.push({ file: f, hot: isHotNewFile(f) });
      continue;
    }
    if (old.sha256 === f.sha256 && old.symlink === f.symlink) continue;
    result.changed.push(classifyChange(inv, f));
  }
  result.newFlags = inv.flags.filter((x) => !(entry.flags || []).includes(x));
  result.hot =
    result.newFlags.length > 0 || result.added.some((a) => a.hot) || result.changed.some((c) => c.hot);
  return result;
}

function isHotNewFile(f) {
  if (f.kind === 'script') return true;
  if (!CONFIG_KINDS.has(f.kind)) return false;
  if (!f.parsed) return true;
  return semanticDiff(f.kind, {}, f.parsed).some((c) => c.hot);
}

function classifyChange(inv, f) {
  if (f.kind === 'script') return { file: f, hot: true, changes: null, reason: 'script changed' };
  if (!CONFIG_KINDS.has(f.kind)) return { file: f, hot: false, changes: null, reason: 'content changed' };
  const before = snapshotText(inv, f.rel);
  if (before === null || !f.parsed)
    return {
      file: f,
      hot: true,
      changes: null,
      reason: before === null ? 'no snapshot to compare against' : 'cannot be parsed',
    };
  let old;
  try {
    old = f.secret ? JSON.parse(before) : parseConfig(f.kind, before);
  } catch {
    return { file: f, hot: true, changes: null, reason: 'previous version cannot be parsed' };
  }
  const changes = semanticDiff(f.kind, old, f.parsed);
  if (inv.isHome) dimSealedTrust(changes);
  return { file: f, hot: changes.some((c) => c.hot), changes, reason: null };
}

// A tool trusting a folder you already pinned through agent-lock is not drift; a folder it
// trusts that you never pinned is ("trusted by Claude, never by you").
function dimSealedTrust(changes) {
  const sealed = Object.keys(loadManifest().checkouts);
  for (const c of changes) {
    const m = /^projects\.(.+)\.(trusted|trust_level)$/.exec(c.key) || /^(\/.+?)(?:\[\]=.*)?$/.exec(c.key);
    if (m && sealed.some((p) => p === m[1] || (fs.existsSync(m[1]) && safeReal(m[1]) === p))) c.hot = false;
  }
}

function safeReal(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
