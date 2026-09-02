// Deterministic flags. Each one is a sentence, printed as-is. No scores, no weights.
// A flag does not mean malicious; it means "a human should read this line before trusting it".
import path from 'node:path';
import { INVISIBLE, kb } from './ui.mjs';
import { referencedPaths } from './semantic.mjs';

const BIG_FILE = 100 * 1024;
const MEDIA = /\.(png|jpe?g|gif|webp|svg|mp4|mov|mp3|wav|pdf|zip|gz|woff2?|ttf|otf|ico|sqlite|db)$/i;
const DANGEROUS_ENV = /^(NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES|ANTHROPIC_BASE_URL|OPENAI_BASE_URL|GOOGLE_GEMINI_BASE_URL|PATH|[A-Z_]*_PROXY)$/;
const ENV_WHY = {
  NODE_OPTIONS: 'preloads code into every node process', LD_PRELOAD: 'injects a library into every process',
  DYLD_INSERT_LIBRARIES: 'injects a library into every process', PATH: 'can shadow git, node, npm',
  ANTHROPIC_BASE_URL: 'reroutes every model call, and your token, elsewhere', OPENAI_BASE_URL: 'reroutes model calls',
  GOOGLE_GEMINI_BASE_URL: 'reroutes model calls',
};
const DOWNLOAD_RUN = [
  [/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'curl | sh'],
  [/Invoke-WebRequest|\biwr\b|Invoke-Expression|\biex\b|powershell[^\n]*-enc/i, 'PowerShell download / encoded command'],
  [/\bfetch\s*\([^\n]*\)[\s\S]{0,600}\b(spawn|execFile|execSync|exec\(|eval\(|new Function|chmod)\b/, 'fetch then execute'],
  [/\b(atob|Buffer\.from\([^\n]*base64|fromCharCode)\b[\s\S]{0,400}\b(eval|new Function|spawn|exec|child_process)\b/, 'decode then execute'],
];
const dotfolderOf = (rel) => (rel.startsWith('.') && rel.includes('/') ? rel.split('/')[0] : null);

function textFlags(file) {
  const flags = [];
  const { rel, text, size, kind } = file;
  if (dotfolderOf(rel) && size > BIG_FILE && !MEDIA.test(rel)) flags.push(`${rel}: ${kb(size)} inside a dotfolder (over 100 KB)`);
  if (text === null || kind === 'other') return flags;
  const invisible = text.match(INVISIBLE);
  if (invisible) flags.push(`${rel}: ${invisible.length} invisible or bidi character${invisible.length > 1 ? 's' : ''} (Rules File Backdoor pattern)`);
  if (kind === 'doc') return flags;
  const obf = text.match(/_0x[0-9a-f]{4,}/g);
  if (obf && obf.length >= 3) flags.push(`${rel}: obfuscated identifiers (_0x…), ${obf.length} occurrences`);
  const blob = text.match(/[A-Za-z0-9+/]{200,}={0,2}|(?:\\x[0-9a-f]{2}){24,}|[0-9a-f]{240,}|\S{300,}/i);
  if (blob) flags.push(`${rel}: encoded or unbroken blob of ${blob[0].length} characters`);
  if (kind === 'script' || kind === 'code') for (const [re, label] of DOWNLOAD_RUN) if (re.test(text)) { flags.push(`${rel}: downloads and runs code (${label})`); break; }
  if (path.basename(rel) === 'package.json' && dotfolderOf(rel)) {
    try {
      const scripts = JSON.parse(text).scripts || {};
      for (const k of ['preinstall', 'install', 'postinstall']) if (scripts[k]) flags.push(`${rel}: package.json with a ${k} script (${scripts[k]})`);
    } catch { /* not json */ }
  }
  return flags;
}

function configFlags(file, isHome) {
  const flags = [];
  const { rel, kind, parsed } = file;
  if (!parsed || typeof parsed !== 'object') return flags;
  if (kind === 'claude-settings') {
    for (const h of parsed.hooks?.SessionStart || []) if (h.matcher === '*') flags.push(`${rel}: SessionStart hook with matcher "*" (fires on every start, resume, clear and compact; the August 2026 keyv worm shape)`);
    if (!isHome && parsed.disableAllHooks === true) flags.push(`${rel}: disableAllHooks: true in a repo settings file (switches off your user hooks)`);
    if (!isHome && parsed.permissions?.defaultMode === 'bypassPermissions') flags.push(`${rel}: permissions.defaultMode: bypassPermissions in a repo settings file`);
    for (const a of parsed.permissions?.allow || []) if (/^Bash(\(\*?\)|\(\*:\*\)|\(:\*\))?$/.test(a)) flags.push(`${rel}: permissions.allow contains ${a} (every shell command pre-approved)`);
    for (const [k] of Object.entries(parsed.env || {})) if (DANGEROUS_ENV.test(k)) flags.push(`${rel}: env sets ${k} (${ENV_WHY[k] || 'reroutes traffic'})`);
  }
  if (kind === 'env') for (const k of Object.keys(parsed)) if (DANGEROUS_ENV.test(k) && k !== 'PATH') flags.push(`${rel}: sets ${k} (${ENV_WHY[k] || 'reroutes traffic'})`);
  if (kind === 'vscode-tasks') {
    for (const t of parsed.tasks || []) if (t.runOptions?.runOn === 'folderOpen') flags.push(`${rel}: task "${t.label || t.command}" has runOn: folderOpen (runs when the folder opens in VS Code or Cursor)`);
  }
  if (kind === 'codex-config' && !isHome) {
    if (parsed.approval_policy === 'never') flags.push(`${rel}: approval_policy = "never" in a repo config`);
    if (parsed.sandbox_mode === 'danger-full-access') flags.push(`${rel}: sandbox_mode = "danger-full-access" in a repo config`);
  }
  const servers = parsed.mcpServers || parsed.mcp_servers || {};
  for (const [name, s] of Object.entries(servers)) {
    const cmd = [s?.command, ...(Array.isArray(s?.args) ? s.args : [])].filter(Boolean).join(' ');
    const m = /\bnpx\s+(?:-y|--yes)\s+(@?[^@\s]+)(@\S+)?/.exec(cmd);
    if (m && !m[2]) flags.push(`${rel}: MCP server "${name}" runs npx -y ${m[1]} with no version pin`);
  }
  return flags;
}

function commandFlags(inv) {
  const flags = [];
  for (const c of inv.commands) {
    const own = dotfolderOf(c.file);
    for (const ref of referencedPaths(c.command, inv.root)) {
      if (inv.isHome) continue;
      if (!ref.inside) { flags.push(`${c.file}: "${c.command}" points outside the repo: ${ref.abs}`); continue; }
      const target = dotfolderOf(path.relative(inv.root, ref.abs));
      if (own && target && own !== target) flags.push(`${c.file}: "${c.command}" runs a file inside ${target}/ (${own} → ${target} cross-reference, the August 2026 keyv worm shape)`);
    }
    for (const [re, label] of DOWNLOAD_RUN.slice(0, 2)) if (re.test(c.command)) flags.push(`${c.file}: "${c.command}" downloads and runs code (${label})`);
  }
  return flags;
}

// All flags for an inventory, deduplicated, in a stable order.
export function collectFlags(inv) {
  const flags = [];
  for (const f of inv.files) flags.push(...textFlags(f), ...configFlags(f, inv.isHome));
  flags.push(...commandFlags(inv));
  for (const pkg of inv.packagesWithDotfolders || []) flags.push(`node_modules/${pkg.name} ships a ${pkg.dir}/ folder`);
  return [...new Set(flags)].sort((a, b) => a.split(':')[0].localeCompare(b.split(':')[0]));
}
