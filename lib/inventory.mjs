// The watch set: walk what a checkout (or the home directory) hands to an agent, hash it,
// parse the configs, follow the commands to the files they run, and compare with the seal.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_KINDS, extractCommands, parseConfig, referencedPaths, semanticDiff } from './semantic.mjs';
import { collectFlags } from './flags.mjs';
import { HOME, LOCK_HOME, homeFiles } from './tools.mjs';

const DOTFOLDERS = ['.claude', '.codex', '.gemini', '.vscode', '.cursor'];
const TOP_FILES = { '.mcp.json': 'claude-mcp', 'CLAUDE.md': 'doc', 'AGENTS.md': 'doc', 'GEMINI.md': 'doc', '.env': 'env' };
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const SCRIPT_EXT = /\.(sh|bash|zsh|mjs|cjs|js|ts|py|rb|pl|php|toml)$/i;
export const LIMITS = { files: 4000, depth: 12, textBytes: 512 * 1024 };
const KIND_BY_PATH = [
  [/^\.claude\/settings(\.local)?\.json$/, 'claude-settings'], [/^\.claude\/hooks\//, 'script'],
  [/^\.codex\/config\.toml$/, 'codex-config'], [/^\.codex\/hooks\.json$/, 'codex-hooks'], [/^\.codex\/hooks\//, 'script'],
  [/^\.gemini\/settings\.json$/, 'gemini-settings'], [/^\.gemini\/(hooks|commands)\//, 'script'],
  [/^\.vscode\/tasks\.json$/, 'vscode-tasks'], [/^\.vscode\/settings\.json$/, 'vscode-settings'],
  [/^\.cursor\/mcp\.json$/, 'cursor-mcp'], [/^\.cursor\/hooks\.json$/, 'cursor-hooks'], [/^\.cursor\/hooks\//, 'script'],
  [/^\.cursor\/rules\//, 'doc'],
];

export function kindOf(rel) {
  if (TOP_FILES[rel]) return TOP_FILES[rel];
  for (const [re, kind] of KIND_BY_PATH) if (re.test(rel)) return kind;
  // Only hook folders and files a command points at are hot. Other code in a dotfolder
  // (skill scripts, helpers) is hashed and scanned for the same patterns but only runs on request.
  if (SCRIPT_EXT.test(rel)) return 'code';
  return /\.(md|mdc|txt)$/i.test(rel) ? 'doc' : 'other';
}

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function hashPath(abs) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(1 << 16);
  try {
    for (let n = fs.readSync(fd, buf); n > 0; n = fs.readSync(fd, buf)) hash.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

// One file entry: hash, size, symlink target, text (when small and not binary), parsed config.
function fileEntry(root, abs, rel, kind, projection) {
  const lst = fs.lstatSync(abs);
  const entry = { rel, abs, kind, symlink: null, size: lst.size, sha256: null, text: null, parsed: null, secret: kind === 'env', notes: [] };
  if (lst.isSymbolicLink()) {
    entry.symlink = fs.readlinkSync(abs);
    const target = path.resolve(path.dirname(abs), entry.symlink);
    if (!fs.existsSync(target)) { entry.notes.push(`${rel}: dangling symlink → ${entry.symlink}`); entry.sha256 = sha256(`symlink:${entry.symlink}`); return entry; }
    if (root !== HOME && !target.startsWith(`${root}/`)) entry.notes.push(`${rel}: symlink points outside the repo → ${target}`);
    if (fs.statSync(target).isDirectory()) { entry.sha256 = sha256(`symlink-dir:${entry.symlink}`); return entry; }
    abs = target;
    entry.size = fs.statSync(target).size;
  }
  if (projection) {
    entry.text = `${JSON.stringify(projection(fs.readFileSync(abs, 'utf8')), null, 1)}\n`;
    entry.sha256 = sha256(entry.text);
    entry.size = entry.text.length;
  } else {
    entry.sha256 = hashPath(abs);
    if (entry.size <= LIMITS.textBytes) {
      const buf = fs.readFileSync(abs);
      if (!buf.subarray(0, 8000).includes(0)) entry.text = buf.toString('utf8');
    }
  }
  if (entry.text !== null && CONFIG_KINDS.has(kind)) {
    try { entry.parsed = parseConfig(kind, entry.text); } catch (e) { entry.notes.push(`${rel}: could not be parsed (${e.message.split('\n')[0]})`); }
  }
  return entry;
}

function walk(root, dir, depth, acc) {
  if (depth > LIMITS.depth || acc.length >= LIMITS.files) return;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(d.name) || SKIP_FILES.has(d.name)) continue;
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) walk(root, abs, depth + 1, acc);
    else if (d.isFile() || d.isSymbolicLink()) acc.push(abs);
    if (acc.length >= LIMITS.files) return;
  }
}

function packagesWithDotfolders(root) {
  const nm = path.join(root, 'node_modules');
  const found = [];
  if (!fs.existsSync(nm)) return found;
  const dirs = [];
  for (const d of fs.readdirSync(nm, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith('@')) for (const s of fs.readdirSync(path.join(nm, d.name))) dirs.push(`${d.name}/${s}`);
    else dirs.push(d.name);
  }
  for (const name of dirs) for (const dot of DOTFOLDERS) if (fs.existsSync(path.join(nm, name, dot))) found.push({ name, dir: dot });
  return found;
}

// Follow every command to the repo files it runs; those files become hot entries.
function addReferenced(inv) {
  const seen = new Map(inv.files.map((f) => [f.abs, f]));
  for (const f of [...inv.files]) {
    if (!f.parsed || typeof f.parsed !== 'object') continue;
    for (const c of extractCommands(f.parsed)) {
      inv.commands.push({ file: f.rel, where: c.where, command: c.command, matcher: c.matcher });
      for (const ref of referencedPaths(c.command, inv.root)) {
        if (!ref.inside && !inv.isHome) continue;
        const known = seen.get(ref.abs);
        if (known) { if (!CONFIG_KINDS.has(known.kind)) known.kind = 'script'; continue; }
        let st;
        try { st = fs.statSync(ref.abs); } catch { continue; }
        if (!st.isFile()) continue;
        const rel = inv.isHome ? shortHomePath(ref.abs) : path.relative(inv.root, ref.abs);
        const entry = fileEntry(inv.root, ref.abs, rel, 'script');
        seen.set(ref.abs, entry);
        inv.files.push(entry);
      }
    }
  }
}

const shortHomePath = (abs) => (abs.startsWith(HOME) ? `~${abs.slice(HOME.length)}` : abs);

export function inventoryCheckout(root) {
  const inv = { root, isHome: false, files: [], commands: [], flags: [], packagesWithDotfolders: packagesWithDotfolders(root) };
  const paths = [];
  for (const name of Object.keys(TOP_FILES)) if (fs.existsSync(path.join(root, name))) paths.push(path.join(root, name));
  for (const dot of DOTFOLDERS) {
    const dir = path.join(root, dot);
    if (fs.existsSync(dir) && fs.lstatSync(dir).isDirectory()) walk(root, dir, 1, paths);
  }
  for (const abs of paths) {
    const rel = path.relative(root, abs);
    inv.files.push(fileEntry(root, abs, rel, kindOf(rel)));
  }
  addReferenced(inv);
  finish(inv);
  return inv;
}

export function inventoryHome() {
  const inv = { root: HOME, isHome: true, files: [], commands: [], flags: [], packagesWithDotfolders: [] };
  for (const f of homeFiles()) inv.files.push(fileEntry(HOME, f.abs, f.key || shortHomePath(f.abs), f.kind, f.projection));
  addReferenced(inv);
  finish(inv);
  return inv;
}

function finish(inv) {
  inv.files.sort((a, b) => a.rel.localeCompare(b.rel));
  inv.flags = [...new Set([...collectFlags(inv), ...inv.files.flatMap((f) => f.notes)])];
  inv.hotCount = inv.files.filter((f) => f.kind === 'script' || CONFIG_KINDS.has(f.kind)).length;
}

// ---- manifest + snapshots -------------------------------------------------------------

const MANIFEST = path.join(LOCK_HOME, 'manifest.json');
export const snapshotDir = (root) => path.join(LOCK_HOME, 'snapshots', sha256(root).slice(0, 16));

export function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return { version: 1, home: null, checkouts: {} }; }
}

export function saveManifest(m) {
  fs.mkdirSync(LOCK_HOME, { recursive: true, mode: 0o700 });
  const tmp = `${MANIFEST}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(m, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, MANIFEST);
}

export function appendLog(event, root, detail = '') {
  fs.mkdirSync(LOCK_HOME, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(LOCK_HOME, 'log'), `${new Date().toISOString()}\t${event}\t${root}\t${detail}\n`, { mode: 0o600 });
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
    const copy = f.secret ? (f.parsed && JSON.stringify(f.parsed)) : f.text;
    if (copy !== null && copy !== undefined) {
      const dest = path.join(dir, snapshotRel(f.rel));
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, copy, { mode: 0o600 });
    }
  }
  if (inv.isHome) m.home = entry; else m.checkouts[inv.root] = entry;
  saveManifest(m);
  return entry;
}

export function sealedEntry(inv) {
  const m = loadManifest();
  return inv.isHome ? m.home : m.checkouts[inv.root] || null;
}

const snapshotRel = (rel) => rel.replace(/^~\//, 'home/').replace(/^plugin:/, 'plugin/');

export function snapshotText(inv, rel) {
  try { return fs.readFileSync(path.join(snapshotDir(inv.root), snapshotRel(rel)), 'utf8'); } catch { return null; }
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
    if (!old) { result.added.push({ file: f, hot: isHotNewFile(f) }); continue; }
    if (old.sha256 === f.sha256 && old.symlink === f.symlink) continue;
    result.changed.push(classifyChange(inv, f));
  }
  result.newFlags = inv.flags.filter((x) => !(entry.flags || []).includes(x));
  result.hot = result.newFlags.length > 0 || result.added.some((a) => a.hot) || result.changed.some((c) => c.hot);
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
  if (before === null || !f.parsed) return { file: f, hot: true, changes: null, reason: before === null ? 'no snapshot to compare against' : 'cannot be parsed' };
  let old;
  try { old = f.secret ? JSON.parse(before) : parseConfig(f.kind, before); } catch { return { file: f, hot: true, changes: null, reason: 'previous version cannot be parsed' }; }
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
    if (m && sealed.some((p) => p === m[1] || fs.existsSync(m[1]) && safeReal(m[1]) === p)) c.hot = false;
  }
}

function safeReal(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}
