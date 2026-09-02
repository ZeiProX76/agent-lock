// Per-tool knowledge: the real binary, dangerous flags, safe-mode arguments, the home files
// each tool obeys, and the three trust maps (who already trusts which folder, blind).
import fs from 'node:fs';
import path from 'node:path';
import { parseToml } from './toml.mjs';

export const HOME = process.env.HOME || process.env.USERPROFILE || '/';
export const LOCK_HOME = process.env.AGENT_LOCK_HOME || path.join(HOME, '.agent-lock');
export const BIN_DIR = path.join(LOCK_HOME, 'bin');
const h = (...p) => path.join(HOME, ...p);

export const TOOLS = {
  claude: {
    dangerous: ['--dangerously-skip-permissions'],
    safe: () => ['--setting-sources', 'user'],
    safeNote: 'project and local settings excluded (--setting-sources user); your user settings, hooks and plugins still load',
  },
  codex: {
    dangerous: ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--dangerously-bypass-hook-trust'],
    safe: (cwd) => ['-c', `projects."${cwd}".trust_level="untrusted"`, '-s', 'read-only', '-a', 'untrusted'],
    safeNote: 'best effort: folder marked untrusted for this launch, read-only sandbox, approval on every command. Codex has no documented per-launch "ignore .codex/" flag',
  },
  gemini: {
    dangerous: ['--yolo', '-y'],
    safe: null,
    safeNote: 'Gemini has no per-launch untrusted flag: answer "do not trust" in its own prompt, or launch from another folder',
  },
};

export function isDangerous(tool, args) {
  return args.filter((a) => TOOLS[tool].dangerous.includes(a));
}

// First executable on PATH with this name that is not our own shim.
export function findRealBinary(name) {
  const shimDir = safeReal(BIN_DIR);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    let real;
    try {
      real = fs.realpathSync(candidate);
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch { continue; }
    if (safeReal(dir) === shimDir || path.dirname(real) === shimDir) continue;
    if (fs.statSync(real).isFile()) return candidate;
  }
  return null;
}

function safeReal(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// `~/.claude.json` is rewritten constantly (stats, history). Only the parts that grant
// trust or run code are pinned.
export function claudeGlobalProjection(text) {
  const j = JSON.parse(text);
  const projects = {};
  for (const [p, v] of Object.entries(j.projects || {})) {
    projects[p] = {
      trusted: v.hasTrustDialogAccepted === true,
      mcpServers: v.mcpServers || {},
      enabledMcpjsonServers: v.enabledMcpjsonServers || [],
      enableAllProjectMcpServers: v.enableAllProjectMcpServers === true,
    };
  }
  return { mcpServers: j.mcpServers || {}, projects };
}

function pluginPresenceProjection(text) {
  const names = {};
  for (const name of Object.keys(JSON.parse(text).plugins || {})) names[name] = true;
  return names;
}

// Everything in the home directory that a tool reads on every launch.
export function homeFiles() {
  const list = [
    { abs: h('.claude', 'settings.json'), kind: 'claude-settings' },
    { abs: h('.claude.json'), kind: 'claude-global', projection: claudeGlobalProjection },
    { abs: '/Library/Application Support/ClaudeCode/managed-settings.json', kind: 'claude-settings' },
    { abs: '/etc/claude-code/managed-settings.json', kind: 'claude-settings' },
    { abs: h('.claude', 'CLAUDE.md'), kind: 'doc' },
    { abs: h('.claude', 'plugins', 'installed_plugins.json'), kind: 'claude-plugins', projection: pluginPresenceProjection },
    { abs: h('.codex', 'config.toml'), kind: 'codex-config' },
    { abs: h('.codex', 'hooks.json'), kind: 'codex-hooks' },
    { abs: h('.codex', 'AGENTS.md'), kind: 'doc' },
    { abs: h('.gemini', 'settings.json'), kind: 'gemini-settings' },
    { abs: h('.gemini', 'trustedFolders.json'), kind: 'gemini-trust' },
    { abs: h('.gemini', 'GEMINI.md'), kind: 'doc' },
    { abs: '/etc/gemini-cli/settings.json', kind: 'gemini-settings' },
    { abs: h('.cursor', 'mcp.json'), kind: 'cursor-mcp' },
    { abs: h('.cursor', 'hooks.json'), kind: 'cursor-hooks' },
  ];
  const settings = readJson(h('.claude', 'settings.json')) || {};
  const installed = readJson(h('.claude', 'plugins', 'installed_plugins.json'))?.plugins || {};
  for (const [name, on] of Object.entries(settings.enabledPlugins || {})) {
    const install = on && installed[name]?.[0]?.installPath;
    if (install) list.push({ abs: path.join(install, 'hooks', 'hooks.json'), kind: 'claude-settings', key: `plugin:${name}/hooks/hooks.json` });
  }
  return list.filter((f) => fs.existsSync(f.abs));
}

// Folders each tool already trusts, from its own trust map. Blind trust: a click, once.
export function trustMaps() {
  const maps = { claude: new Set(), codex: new Set(), gemini: new Set() };
  const cj = readJson(h('.claude.json'));
  for (const [p, v] of Object.entries(cj?.projects || {})) if (v.hasTrustDialogAccepted === true) maps.claude.add(p);
  try {
    const toml = parseToml(fs.readFileSync(h('.codex', 'config.toml'), 'utf8'));
    for (const [p, v] of Object.entries(toml.projects || {})) if (v?.trust_level === 'trusted') maps.codex.add(p);
  } catch { /* no codex config */ }
  const gj = readJson(h('.gemini', 'trustedFolders.json'));
  for (const [p, v] of Object.entries(gj || {})) if (v === 'TRUST_FOLDER' || v === 'TRUST_PARENT') maps.gemini.add(p);
  return maps;
}

export function trustedBy(cwd) {
  const maps = trustMaps();
  return Object.keys(maps).filter((t) => maps[t].has(cwd));
}
