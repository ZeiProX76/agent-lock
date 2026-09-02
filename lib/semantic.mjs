// Config semantics: which keys make something run without being asked (hot), flattening,
// semantic diff between two parsed configs, and command extraction from any tool's config.
import path from 'node:path';
import { parseToml } from './toml.mjs';

const ANY = [/./];
// Keys that change what executes, where it connects, or what it may do without a prompt.
const HOT = {
  'claude-settings': [
    /^hooks\b/, /^mcpServers\.[^.]+\.(command|args|url|env|headers)/, /^env\./,
    /^(apiKeyHelper|awsAuthRefresh|awsCredentialExport|headersHelper|otelHeadersHelper)$/,
    /^statusLine\.command$/, /^permissions\.defaultMode$/, /^defaultMode$/,
    /^(enableAllProjectMcpServers|disableAllHooks|allowManagedHooksOnly|skipDangerousModePermissionPrompt)\b/,
    /^permissions\.allow\[\]=Bash(\(\*?\)|\(\*:\*\)|\(:\*\))?$/, /^permissions\.additionalDirectories\b/,
    /^sandbox\./, /^(extraKnownMarketplaces|enabledPlugins)\b/,
  ],
  'claude-mcp': ANY,
  'claude-global': ANY,
  'claude-plugins': ANY,
  'codex-config': [
    /^hooks\b/, /^mcp_servers\b/, /^projects\..*\.trust_level$/, /^plugins\b/,
    /^(sandbox_mode|approval_policy|notify|shell_environment_policy|model_provider|model_providers)\b/,
  ],
  'codex-hooks': ANY,
  'gemini-settings': [/^hooks\b/, /^mcpServers\b/, /^(tools\.core|coreTools|excludeTools|tools\.allowed|tools\.exclude|security|sandbox)\b/],
  'gemini-trust': ANY,
  'vscode-tasks': ANY,
  'vscode-settings': [/(command|exec|path|env|shell|args|automationProfile|task|allowAutomaticTasks)/i],
  'cursor-mcp': ANY,
  'cursor-hooks': ANY,
  env: [/^(NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES|ANTHROPIC_BASE_URL|OPENAI_BASE_URL|GOOGLE_GEMINI_BASE_URL|PATH|.*_PROXY)$/],
};
export const CONFIG_KINDS = new Set(Object.keys(HOT));
export const isHotKey = (kind, key) => (HOT[kind] || []).some((re) => re.test(key));

// Parse by kind. Returns null when the file is not a config we read structurally.
export function parseConfig(kind, text) {
  if (kind === 'codex-config') return parseToml(text);
  if (kind === 'env') return envKeys(text);
  if (CONFIG_KINDS.has(kind)) return JSON.parse(stripJsonComments(text));
  return null;
}

// `.env` is hashed and its key NAMES are kept. Values are never stored anywhere.
function envKeys(text) {
  const keys = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) keys[m[1]] = true;
  }
  return keys;
}

// VS Code and Cursor JSON files allow comments and trailing commas.
function stripJsonComments(text) {
  return text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '')
    .replace(/,(\s*[}\]])/g, '$1');
}

// Flatten to `path -> JSON leaf`. Arrays of primitives become set members (`a.b[]=value`)
// so a reorder is not a change; arrays of objects keep their index.
export function flatten(value, prefix = '', acc = new Map()) {
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) {
      for (const v of value) acc.set(`${prefix}[]=${typeof v === 'string' ? v : JSON.stringify(v)}`, 'true');
    } else value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, acc));
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) acc.set(prefix || '(root)', '{}');
    for (const k of keys) flatten(value[k], prefix ? `${prefix}.${k}` : k, acc);
  } else acc.set(prefix || '(root)', JSON.stringify(value));
  return acc;
}

// Semantic diff: every changed key, each tagged hot or not.
export function semanticDiff(kind, before, after) {
  const a = flatten(before);
  const b = flatten(after);
  const changes = [];
  for (const [k, v] of b) if (!a.has(k)) changes.push({ key: k, from: null, to: v });
  for (const [k, v] of a) {
    if (!b.has(k)) changes.push({ key: k, from: v, to: null });
    else if (b.get(k) !== v) changes.push({ key: k, from: v, to: b.get(k) });
  }
  for (const c of changes) c.hot = isHotKey(kind, c.key);
  return changes.sort((x, y) => Number(y.hot) - Number(x.hot) || x.key.localeCompare(y.key));
}

const COMMAND_KEYS = new Set(['command', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'headersHelper', 'otelHeadersHelper', 'notify']);

// Every string that a tool would hand to a shell, with where it came from.
export function extractCommands(parsed, where = '', acc = []) {
  if (Array.isArray(parsed)) parsed.forEach((v, i) => extractCommands(v, `${where}[${i}]`, acc));
  else if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed)) {
      const here = where ? `${where}.${k}` : k;
      if (COMMAND_KEYS.has(k) && typeof v === 'string') {
        const args = Array.isArray(parsed.args) ? parsed.args.filter((x) => typeof x === 'string') : [];
        acc.push({ where: here, command: [v, ...args].join(' '), matcher: parsed.matcher, node: parsed });
      } else if (k === 'notify' && Array.isArray(v)) acc.push({ where: here, command: v.join(' '), node: parsed });
      else if (k !== 'args') extractCommands(v, here, acc);
    }
  }
  return acc;
}

const SCRIPT_EXT = /\.(sh|bash|zsh|mjs|cjs|js|ts|py|rb|pl|php)$/i;

// File paths a command string points at, resolved against the repo root.
export function referencedPaths(command, root) {
  const home = process.env.HOME || '/nonexistent';
  // Quotes around an expansion ("$CLAUDE_PROJECT_DIR"/x.sh) are dropped with it so the path stays one token.
  const text = command
    .replace(/"?\$\{?CLAUDE_PROJECT_DIR\}?"?/g, root)
    .replace(/"?\$\{?HOME\}?"?/g, home)
    .replace(/"?\$\{?CLAUDE_PLUGIN_ROOT\}?"?/g, '/__plugin_root__');
  const tokens = text.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const found = [];
  for (let tok of tokens) {
    tok = tok.replace(/^["']|["']$/g, '');
    if (tok.startsWith('-') || tok.startsWith('/__plugin_root__') || /\s/.test(tok)) continue;
    if (!(tok.includes('/') || SCRIPT_EXT.test(tok))) continue;
    if (/^[a-z]+:\/\//i.test(tok)) continue;
    const abs = tok.startsWith('~/') ? path.join(home, tok.slice(2)) : path.resolve(root, tok);
    found.push({ token: tok, abs, inside: abs === root || abs.startsWith(`${root}/`) });
  }
  return found;
}
