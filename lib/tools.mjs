// Per-tool knowledge: the real binary, dangerous flags, safe-mode arguments, the home files
// each tool obeys, and the three trust maps (who already trusts which folder, blind).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseToml } from './toml.mjs';

export const IS_WINDOWS = process.platform === 'win32';
export const HOME = process.env.HOME || process.env.USERPROFILE || (IS_WINDOWS ? 'C:\\' : '/');
export const LOCK_HOME = process.env.AGENT_LOCK_HOME || path.join(HOME, '.agent-lock');
export const BIN_DIR = path.join(LOCK_HOME, 'bin');
const homePath = (...parts) => path.join(HOME, ...parts);

// Each tool lets you move its home directory. Watching the default while the tool reads another
// one is worse than watching nothing, because the ok line would be a lie.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || homePath('.claude');
const CODEX_DIR = process.env.CODEX_HOME || homePath('.codex');
const GEMINI_DIR = homePath('.gemini');

// Where an administrator's policy files live. Windows moved: `C:\\ProgramData\\ClaudeCode` is the
// legacy path Claude Code no longer reads, `C:\\Program Files\\ClaudeCode` is the current one.
const SYSTEM_DIRS = {
  claude: IS_WINDOWS
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode')]
    : process.platform === 'darwin'
      ? ['/Library/Application Support/ClaudeCode']
      : ['/etc/claude-code'],
  gemini: IS_WINDOWS
    ? [path.join(process.env.ProgramData || 'C:\\ProgramData', 'gemini-cli')]
    : process.platform === 'darwin'
      ? ['/Library/Application Support/GeminiCli']
      : ['/etc/gemini-cli'],
};

// A path as a TOML key. Windows paths are full of backslashes and `\U` is an invalid escape,
// so the value is escaped rather than pasted between quotes.
export const tomlKey = (p) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const TOOLS = {
  claude: {
    dangerous: ['--dangerously-skip-permissions'],
    safe: () => ['--setting-sources', 'user'],
    safeNote:
      'project and local settings excluded (--setting-sources user); your user settings, hooks and plugins still load',
  },
  codex: {
    dangerous: ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--dangerously-bypass-hook-trust'],
    safe: (cwd) => [
      '-c',
      `projects.${tomlKey(cwd)}.trust_level="untrusted"`,
      '-s',
      'read-only',
      '-a',
      'untrusted',
    ],
    safeNote:
      'best effort: folder marked untrusted for this launch, read-only sandbox, approval on every command. Codex has no documented per-launch "ignore .codex/" flag',
  },
  gemini: {
    dangerous: ['--yolo', '-y'],
    safe: null,
    safeNote:
      'Gemini has no per-launch untrusted flag: answer "do not trust" in its own prompt, or launch from another folder',
  },
};

export function isDangerous(tool, args) {
  return args.filter((a) => TOOLS[tool].dangerous.includes(a));
}

// Binaries this launch already handed off to. A terminal wrapper (cmux ships one, mise / asdf
// shims behave the same) execs "the next claude on PATH", which is our shim again; without this
// list the two would exec each other forever.
export const launchChain = () => (process.env.AGENT_LOCK_CHAIN || '').split(path.delimiter).filter(Boolean);

// What counts as "the claude on PATH". Windows has no execute bit: a name is runnable when it
// carries an extension from PATHEXT, and `claude` alone is not. .ps1 is skipped on purpose,
// PowerShell-only and never what cmd.exe would pick.
const PATHEXT = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
  .split(';')
  .map((e) => e.trim().toLowerCase())
  .filter((e) => e.startsWith('.') && e !== '.ps1');

export const candidateNames = (name, onWindows = IS_WINDOWS) =>
  onWindows ? (path.extname(name) ? [name] : PATHEXT.map((e) => name + e)) : [name];

// First executable on PATH with this name that is neither our shim nor already in the chain.
export function findRealBinary(name, chain = launchChain()) {
  const shimDir = safeReal(BIN_DIR);
  const visited = new Set(chain.map(safeReal));
  const dirs = (process.env.PATH || '').split(path.delimiter);
  // Windows resolves a bare name in the current directory first only for cmd.exe legacy reasons;
  // we deliberately do not, so a `claude.exe` dropped in a repo can never become "the real one".
  for (const dir of dirs) {
    if (!dir) continue;
    for (const leaf of candidateNames(name)) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), leaf);
      let real;
      try {
        real = fs.realpathSync(candidate);
        if (!IS_WINDOWS) fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        continue;
      }
      if (safeReal(dir) === shimDir || path.dirname(real) === shimDir) continue;
      if (visited.has(real) || visited.has(candidate)) continue;
      if (fs.statSync(real).isFile()) return candidate;
    }
  }
  return null;
}

function safeReal(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
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

// An administrator's policy directory: the file, every drop-in beside it, and the MCP file.
// Drop-ins are merged into the policy, so one unwatched file there is a whole unwatched policy.
function policyFiles(dir, kind, mcpKind) {
  const list = [
    { abs: path.join(dir, 'managed-settings.json'), kind },
    { abs: path.join(dir, 'managed-mcp.json'), kind: mcpKind },
  ];
  try {
    for (const name of fs.readdirSync(path.join(dir, 'managed-settings.d')).sort())
      if (name.endsWith('.json')) list.push({ abs: path.join(dir, 'managed-settings.d', name), kind });
  } catch {
    /* no drop-in directory */
  }
  return list;
}

// Windows keeps policy in the registry as well as on disk, and `HKCU\\SOFTWARE\\Policies\\ClaudeCode`
// is writable by the user, so anything running as you can put a policy there. Read as text, not
// as a file: the entry carries its own content and never touches a path.
// reg.exe prints the value as "    Settings    REG_SZ    {json}". Everything after the type is
// the value, and a JSON object can carry anything, so the match runs to the end of the output.
export function parseRegSettings(output) {
  return /^[ \t]*Settings[ \t]+REG_(?:SZ|EXPAND_SZ)[ \t]+([\s\S]*)$/m.exec(output)?.[1]?.trim() || null;
}

export function windowsPolicyEntries() {
  if (!IS_WINDOWS) return [];
  const out = [];
  for (const root of ['HKLM', 'HKCU']) {
    const key = `${root}\\SOFTWARE\\Policies\\ClaudeCode`;
    let text;
    try {
      const r = execFileSync('reg', ['query', key, '/v', 'Settings'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      text = parseRegSettings(r);
    } catch {
      continue; // the key is absent, which is the normal case
    }
    if (text) out.push({ key: `registry:${key}\\Settings`, kind: 'claude-settings', text });
  }
  return out;
}

// Everything outside a project that a tool reads on every launch: your own config, the
// administrator's policy, and on Windows the two registry keys that carry the same policy.
export function homeFiles() {
  const list = [
    { abs: path.join(CLAUDE_DIR, 'settings.json'), kind: 'claude-settings' },
    { abs: homePath('.claude.json'), kind: 'claude-global', projection: claudeGlobalProjection },
    { abs: path.join(CLAUDE_DIR, 'CLAUDE.md'), kind: 'doc' },
    {
      abs: path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'),
      kind: 'claude-plugins',
      projection: pluginPresenceProjection,
    },
    { abs: path.join(CODEX_DIR, 'config.toml'), kind: 'codex-config' },
    { abs: path.join(CODEX_DIR, 'hooks.json'), kind: 'codex-hooks' },
    { abs: path.join(CODEX_DIR, 'AGENTS.md'), kind: 'doc' },
    { abs: path.join(GEMINI_DIR, 'settings.json'), kind: 'gemini-settings' },
    { abs: path.join(GEMINI_DIR, 'trustedFolders.json'), kind: 'gemini-trust' },
    { abs: path.join(GEMINI_DIR, 'GEMINI.md'), kind: 'doc' },
    { abs: homePath('.cursor', 'mcp.json'), kind: 'cursor-mcp' },
    { abs: homePath('.cursor', 'hooks.json'), kind: 'cursor-hooks' },
  ];
  for (const dir of SYSTEM_DIRS.claude) list.push(...policyFiles(dir, 'claude-settings', 'claude-mcp'));
  const geminiSystem = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  if (geminiSystem) list.push({ abs: geminiSystem, kind: 'gemini-settings' });
  else
    for (const dir of SYSTEM_DIRS.gemini)
      list.push({ abs: path.join(dir, 'settings.json'), kind: 'gemini-settings' });
  const settings = readJson(path.join(CLAUDE_DIR, 'settings.json')) || {};
  const installed = readJson(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'))?.plugins || {};
  for (const [name, on] of Object.entries(settings.enabledPlugins || {})) {
    const install = on && installed[name]?.[0]?.installPath;
    if (install)
      list.push({
        abs: path.join(install, 'hooks', 'hooks.json'),
        kind: 'claude-settings',
        key: `plugin:${name}/hooks/hooks.json`,
      });
  }
  return list.filter((f) => fs.existsSync(f.abs)).concat(windowsPolicyEntries());
}

// Folders each tool already trusts, from its own trust map. Blind trust: a click, once.
export function trustMaps() {
  const maps = { claude: new Set(), codex: new Set(), gemini: new Set() };
  const cj = readJson(homePath('.claude.json'));
  for (const [p, v] of Object.entries(cj?.projects || {}))
    if (v.hasTrustDialogAccepted === true) maps.claude.add(p);
  try {
    const toml = parseToml(fs.readFileSync(path.join(CODEX_DIR, 'config.toml'), 'utf8'));
    for (const [p, v] of Object.entries(toml.projects || {}))
      if (v?.trust_level === 'trusted') maps.codex.add(p);
  } catch {
    /* no codex config */
  }
  const gj = readJson(path.join(GEMINI_DIR, 'trustedFolders.json'));
  for (const [p, v] of Object.entries(gj || {}))
    if (v === 'TRUST_FOLDER' || v === 'TRUST_PARENT') maps.gemini.add(p);
  return maps;
}

export function trustedBy(cwd) {
  const maps = trustMaps();
  return Object.keys(maps).filter((t) => maps[t].has(cwd));
}
