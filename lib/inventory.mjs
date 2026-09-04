// The watch set: walk what a checkout (or the home directory) hands to an agent, hash it,
// parse the configs, and follow the commands to the files they run. Sealing and comparing
// against the seal live in manifest.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { collectFlags } from './flags.mjs';
import { isInside, relFrom, slash } from './paths.mjs';
import { CONFIG_KINDS, extractCommands, parseConfig, referencedPaths } from './semantic.mjs';
import { HOME, homeFiles } from './tools.mjs';

export const DOTFOLDERS = ['.claude', '.codex', '.gemini', '.vscode', '.cursor', '.devcontainer'];
export const TOP_FILES = {
  '.mcp.json': 'claude-mcp',
  'CLAUDE.md': 'doc',
  'AGENTS.md': 'doc',
  'GEMINI.md': 'doc',
  '.env': 'env',
  '.devcontainer.json': 'devcontainer',
};
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const SCRIPT_EXT = /\.(sh|bash|zsh|mjs|cjs|js|ts|py|rb|pl|php|toml)$/i;
export const LIMITS = { files: 4000, depth: 12, textBytes: 512 * 1024 };
const KIND_BY_PATH = [
  [/^\.claude\/settings(\.local)?\.json$/, 'claude-settings'],
  [/^\.claude\/hooks\//, 'script'],
  [/^\.codex\/config\.toml$/, 'codex-config'],
  [/^\.codex\/hooks\.json$/, 'codex-hooks'],
  [/^\.codex\/hooks\//, 'script'],
  [/^\.gemini\/settings\.json$/, 'gemini-settings'],
  [/^\.gemini\/(hooks|commands)\//, 'script'],
  [/^\.vscode\/tasks\.json$/, 'vscode-tasks'],
  [/^\.vscode\/launch\.json$/, 'vscode-launch'],
  [/^\.devcontainer\/(.+\/)?devcontainer\.json$/, 'devcontainer'],
  [/^\.vscode\/settings\.json$/, 'vscode-settings'],
  [/^\.cursor\/mcp\.json$/, 'cursor-mcp'],
  [/^\.cursor\/hooks\.json$/, 'cursor-hooks'],
  [/^\.cursor\/hooks\//, 'script'],
  [/^\.cursor\/rules\//, 'doc'],
];

const TOP_FILES_LC = new Map(Object.entries(TOP_FILES).map(([k, v]) => [k.toLowerCase(), v]));

// The table matches on a lower-cased copy of the path. Windows and macOS both open
// `.claude/Settings.json` when a program asks for `.claude/settings.json`, so a capital letter
// must not decide whether a file is a config file. On Linux the same name is a different, inert
// file and this over-classifies it, which is the safe direction: the moment that repo is opened
// on a Mac the file is live, and `miscased` says so out loud either way.
export function kindOf(rel) {
  const lc = rel.toLowerCase();
  if (TOP_FILES_LC.has(lc)) return TOP_FILES_LC.get(lc);
  for (const [re, kind] of KIND_BY_PATH) if (re.test(lc)) return kind;
  // Only hook folders and files a command points at are hot. Other code in a dotfolder
  // (skill scripts, helpers) is hashed and scanned for the same patterns but only runs on request.
  if (SCRIPT_EXT.test(rel)) return 'code';
  return /\.(md|mdc|txt)$/i.test(rel) ? 'doc' : 'other';
}

// The canonical spelling of a config path, when this file is spelled some other way, else null.
// Only the part of the name the table actually constrains is compared: `.claude/hooks/MyHook.sh`
// is a normal name, `.Claude/hooks/x.sh` is not.
export function miscased(rel) {
  const lc = rel.toLowerCase();
  if (lc === rel) return null;
  for (const key of Object.keys(TOP_FILES)) if (key.toLowerCase() === lc) return key === rel ? null : key;
  for (const [re] of KIND_BY_PATH) {
    const m = re.exec(lc);
    if (m) return rel.slice(0, m[0].length) === m[0] ? null : m[0];
  }
  return null;
}

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function hashPath(abs) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(1 << 16);
  try {
    for (let n = fs.readSync(fd, buf); n > 0; n = fs.readSync(fd, buf)) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// A source that is not a file: the Windows policy registry values. Same shape, same hashing,
// same semantic diff; it simply carries its content instead of a path.
function textEntry(rel, kind, text) {
  const entry = {
    rel,
    abs: null,
    kind,
    symlink: null,
    size: text.length,
    sha256: sha256(text),
    text,
    parsed: null,
    secret: false,
    notes: [],
  };
  try {
    entry.parsed = parseConfig(kind, text);
  } catch (e) {
    entry.notes.push(`${rel}: could not be parsed (${e.message.split('\n')[0]})`);
  }
  return entry;
}

// One file entry: hash, size, symlink target, text (when small and not binary), parsed config.
function fileEntry(root, abs, rel, kind, projection) {
  const lst = fs.lstatSync(abs);
  const entry = {
    rel,
    abs,
    kind,
    symlink: null,
    size: lst.size,
    sha256: null,
    text: null,
    parsed: null,
    secret: kind === 'env',
    notes: [],
  };
  const canonical = miscased(rel);
  if (canonical)
    entry.notes.push(
      `${rel}: spelled differently from ${canonical}, which Windows and macOS open all the same`
    );
  if (lst.isSymbolicLink()) {
    entry.symlink = fs.readlinkSync(abs);
    const target = path.resolve(path.dirname(abs), entry.symlink);
    if (!fs.existsSync(target)) {
      entry.notes.push(`${rel}: dangling symlink → ${entry.symlink}`);
      entry.sha256 = sha256(`symlink:${entry.symlink}`);
      return entry;
    }
    if (root !== HOME && !isInside(root, target))
      entry.notes.push(`${rel}: symlink points outside the repo → ${target}`);
    if (fs.statSync(target).isDirectory()) {
      entry.sha256 = sha256(`symlink-dir:${entry.symlink}`);
      return entry;
    }
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
    try {
      entry.parsed = parseConfig(kind, entry.text);
    } catch (e) {
      entry.notes.push(`${rel}: could not be parsed (${e.message.split('\n')[0]})`);
    }
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
    if (d.name.startsWith('@'))
      for (const s of fs.readdirSync(path.join(nm, d.name))) dirs.push(`${d.name}/${s}`);
    else dirs.push(d.name);
  }
  for (const name of dirs)
    for (const dot of DOTFOLDERS) if (fs.existsSync(path.join(nm, name, dot))) found.push({ name, dir: dot });
  return found;
}

// Follow every command to the repo files it runs; those files become hot entries.
function addReferenced(inv) {
  const seen = new Map(inv.files.filter((f) => f.abs).map((f) => [f.abs, f]));
  for (const f of [...inv.files]) {
    if (!f.parsed || typeof f.parsed !== 'object') continue;
    for (const c of extractCommands(f.parsed)) {
      inv.commands.push({ file: f.rel, where: c.where, command: c.command, matcher: c.matcher });
      for (const ref of referencedPaths(c.command, inv.root)) {
        if (!ref.inside && !inv.isHome) continue;
        const known = seen.get(ref.abs);
        if (known) {
          if (!CONFIG_KINDS.has(known.kind)) known.kind = 'script';
          continue;
        }
        let st;
        try {
          st = fs.statSync(ref.abs);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        const rel = inv.isHome ? shortHomePath(ref.abs) : relFrom(inv.root, ref.abs);
        const entry = fileEntry(inv.root, ref.abs, rel, 'script');
        seen.set(ref.abs, entry);
        inv.files.push(entry);
      }
    }
  }
}

const shortHomePath = (abs) => slash(abs.startsWith(HOME) ? `~${abs.slice(HOME.length)}` : abs);

export function inventoryCheckout(root) {
  const inv = {
    root,
    isHome: false,
    files: [],
    commands: [],
    flags: [],
    packagesWithDotfolders: packagesWithDotfolders(root),
  };
  const paths = [];
  for (const name of Object.keys(TOP_FILES))
    if (fs.existsSync(path.join(root, name))) paths.push(path.join(root, name));
  for (const dot of DOTFOLDERS) {
    const dir = path.join(root, dot);
    if (fs.existsSync(dir) && fs.lstatSync(dir).isDirectory()) walk(root, dir, 1, paths);
  }
  for (const abs of paths) {
    const rel = relFrom(root, abs);
    inv.files.push(fileEntry(root, abs, rel, kindOf(rel)));
  }
  addReferenced(inv);
  finish(inv);
  return inv;
}

export function inventoryHome() {
  const inv = { root: HOME, isHome: true, files: [], commands: [], flags: [], packagesWithDotfolders: [] };
  for (const f of homeFiles())
    inv.files.push(
      f.text !== undefined
        ? textEntry(f.key, f.kind, f.text)
        : fileEntry(HOME, f.abs, f.key || shortHomePath(f.abs), f.kind, f.projection)
    );
  addReferenced(inv);
  finish(inv);
  return inv;
}

function finish(inv) {
  inv.files.sort((a, b) => a.rel.localeCompare(b.rel));
  inv.flags = [...new Set([...collectFlags(inv), ...inv.files.flatMap((f) => f.notes)])];
  inv.hotCount = inv.files.filter((f) => f.kind === 'script' || CONFIG_KINDS.has(f.kind)).length;
}
