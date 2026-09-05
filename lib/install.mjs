// install / uninstall: PATH shims, shell rc line, global git hooks, first home seal.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryHome } from './inventory.mjs';
import { appendLog, compare, seal, sealedEntry } from './manifest.mjs';
import { printInventory } from './print.mjs';
import { review } from './review.mjs';
import { BIN_DIR, HOME, IS_WINDOWS, LOCK_HOME, TOOLS } from './tools.mjs';
import { bold, dim, green, out, red, yellow } from './ui.mjs';
import { addWindowsPath, cmdShim, removeWindowsPath } from './windows.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MJS = path.join(REPO, 'agent-lock.mjs');
const MARK = '# agent-lock';
// PATH for scripts, aliases for the interactive shell: terminals such as Ghostty / cmux prepend
// their own bin after the rc files run, and an alias wins regardless of PATH order.
const RC_BLOCK = [
  `export PATH="$HOME/.agent-lock/bin:$PATH"  ${MARK}`,
  `alias claude="$HOME/.agent-lock/bin/claude" codex="$HOME/.agent-lock/bin/codex" gemini="$HOME/.agent-lock/bin/gemini"  ${MARK}`,
].join('\n');
const HOOKS_DIR = path.join(LOCK_HOME, 'git-hooks');
// Every standard client-side hook gets the dispatcher, so a global core.hooksPath never
// silences a repo's own pre-commit or pre-push.
const GIT_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
];

export function shim(tool) {
  return `#!/bin/sh
# agent-lock shim for ${tool}. Installed by \`agent-lock install\`, removed by \`agent-lock uninstall\`.
# Checks the agent config of this folder against what you recorded, then execs the real ${tool}.
AGENT_LOCK_MJS="${MJS}"
NODE_BIN="${process.execPath}"
[ -x "$NODE_BIN" ] || NODE_BIN=node
if [ ! -f "$AGENT_LOCK_MJS" ]; then
  echo "agent-lock: $AGENT_LOCK_MJS is missing. Re-run install, or AGENT_LOCK_SKIP=1 ${tool} for one launch." >&2
  exit 1
fi
# A terminal wrapper on PATH (cmux ships one; mise / asdf shims do the same) may exec "the next ${tool}",
# which is this shim again. exec keeps the PID, so the same PID (or our direct child) means the gate
# already ran for this launch: skip the checks and move on to the next binary, never loop.
# Our direct child is the real ${tool} spawning "${tool}" itself: it gets the binary its parent ran, no gate.
if [ "\${AGENT_LOCK_LAUNCH:-}" = "$$" ]; then reentry=exec
elif [ "\${AGENT_LOCK_LAUNCH:-}" = "$PPID" ]; then reentry=child
else AGENT_LOCK_LAUNCH=$$; AGENT_LOCK_CHAIN=""; AGENT_LOCK_DEPTH=0; reentry=0; fi
if [ "$reentry" != 0 ]; then
  AGENT_LOCK_DEPTH=$((\${AGENT_LOCK_DEPTH:-0} + 1))
  if [ "$AGENT_LOCK_DEPTH" -gt 8 ]; then echo "agent-lock: ${tool} launch loop after 8 hops: \${AGENT_LOCK_CHAIN:-}" >&2; exit 1; fi
fi
export AGENT_LOCK_LAUNCH AGENT_LOCK_CHAIN AGENT_LOCK_DEPTH
# NODE_OPTIONS is cleared for the check itself (a preloaded module has no business inside it); the real ${tool} keeps it.
decision="$(NODE_OPTIONS= AGENT_LOCK_REENTRY=$reentry "$NODE_BIN" "$AGENT_LOCK_MJS" gate ${tool} -- "$@")" || exit $?
real="$(printf '%s\\n' "$decision" | sed -n 1p)"
mode="$(printf '%s\\n' "$decision" | sed -n 2p)"
extra="$(printf '%s\\n' "$decision" | sed -n 3p)"
[ -n "$real" ] || { echo "agent-lock: no launch decision" >&2; exit 1; }
AGENT_LOCK_SESSION="\${mode:-ok}"; export AGENT_LOCK_SESSION
AGENT_LOCK_CHAIN="\${AGENT_LOCK_CHAIN:+$AGENT_LOCK_CHAIN:}$real"; export AGENT_LOCK_CHAIN
eval "set -- $extra \\"\\$@\\""
exec "$real" "$@"
`;
}

function addPathLine() {
  const touched = [];
  const rcs = [path.join(HOME, '.zshrc'), path.join(HOME, '.bashrc')].filter((f) => fs.existsSync(f));
  if (!rcs.length)
    rcs.push(path.join(HOME, (process.env.SHELL || '').endsWith('zsh') ? '.zshrc' : '.bashrc'));
  for (const rc of rcs) {
    const cur = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
    if (cur.includes(MARK)) continue;
    fs.appendFileSync(rc, `${cur.endsWith('\n') || !cur ? '' : '\n'}${RC_BLOCK}\n`);
    touched.push(rc);
  }
  return touched;
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Global hooks that warn at pull time and still run the repo's own .git/hooks.
function installGitHooks() {
  fs.mkdirSync(HOOKS_DIR, { recursive: true, mode: 0o700 });
  // The hook body is /bin/sh, which on Windows is the sh that ships with Git; it reads
  // C:/path, never C:\\path, so the two substituted paths are written with forward slashes.
  const shPath = (p) => (IS_WINDOWS ? p.replace(/\\/g, '/') : p);
  const body = fs
    .readFileSync(path.join(REPO, 'git-hooks', 'hook.sh'), 'utf8')
    .replace('__MJS__', shPath(MJS))
    .replace('__NODE__', shPath(process.execPath));
  for (const name of GIT_HOOKS) fs.writeFileSync(path.join(HOOKS_DIR, name), body, { mode: 0o755 });
  const current = git(['config', '--global', 'core.hooksPath']);
  if (!current) {
    git(['config', '--global', 'core.hooksPath', HOOKS_DIR]);
    return `git core.hooksPath → ${HOOKS_DIR} (repo .git/hooks still run)`;
  }
  if (current === HOOKS_DIR) return 'git hooks already installed';
  return yellow(
    `git core.hooksPath is already ${current}; add \`node ${MJS} verify --quiet\` to its post-merge yourself`
  );
}

async function sealHome() {
  const inv = inventoryHome();
  if (sealedEntry(inv)) return 'user-level config already recorded';
  printInventory(inv);
  const a = await review(inv, compare(null, inv), {
    question: 'Remember your user-level config as it is now?',
    accept: { key: 'y', label: `yes · records these ${inv.files.length} fingerprints` },
  });
  if (a !== 'y') return yellow('user-level config not recorded yet (the first launch will ask again)');
  seal(inv);
  appendLog('seal-home', inv.root, `${inv.files.length} files`);
  return `user-level config recorded (${inv.files.length} files)`;
}

// Every shim file for one tool. The extension-less POSIX script is written on Windows too:
// Git Bash and WSL share the same home directory and look for exactly that name.
function writeShims(tools) {
  fs.mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
  const posix = (name, body) => fs.writeFileSync(path.join(BIN_DIR, name), body, { mode: 0o755 });
  for (const t of tools) {
    posix(t, shim(t));
    if (IS_WINDOWS) {
      fs.writeFileSync(path.join(BIN_DIR, `${t}.cmd`), cmdShim(t));
    }
  }
  posix('agent-lock', `#!/bin/sh\nexec "${process.execPath}" "${MJS}" "$@"\n`);
  if (IS_WINDOWS) {
    fs.writeFileSync(
      path.join(BIN_DIR, 'agent-lock.cmd'),
      `@echo off\r\n"${process.execPath}" "${MJS}" %*\r\nexit /b %ERRORLEVEL%\r\n`
    );
  }
}

export async function install({ strict = false } = {}) {
  const tools = Object.keys(TOOLS);
  writeShims(tools);
  const p = IS_WINDOWS
    ? addWindowsPath()
    : { ok: true, message: `PATH + alias lines added to ${addPathLine().join(', ') || '(already present)'}` };
  const where = p.ok ? p.message : yellow(p.message);
  out(
    bold('agent-lock installed'),
    `   shims: ${tools.map((t) => path.join(BIN_DIR, t)).join(', ')}`,
    `   ${where}`,
    `   ${installGitHooks()}`
  );
  out(`   ${await sealHome()}`);
  out(
    '',
    'next:',
    `   ${green('open a new terminal')} (or: ${dim(IS_WINDOWS ? `set PATH=${BIN_DIR};%PATH%` : `export PATH="${BIN_DIR}:$PATH"`)})`,
    `   ${green('agent-lock scan')}   review every folder your tools already trust, then record it`,
    dim(
      '   claude plugin marketplace add ZeiProX76/agent-lock && claude plugin install agent-lock@agent-lock   (ConfigChange backstop)'
    )
  );
  if (strict) printStrict();
  appendLog('install', REPO);
}

function printStrict() {
  const dir = IS_WINDOWS
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode')
    : process.platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode'
      : '/etc/claude-code';
  const managed = path.join(dir, 'managed-settings.json');
  out(
    '',
    bold(
      `--strict (manual, needs ${IS_WINDOWS ? 'an elevated prompt' : 'sudo'}): only managed-settings hooks run, repo and user hooks are ignored`
    ),
    dim(
      IS_WINDOWS
        ? `   mkdir "${dir}" & echo {"allowManagedHooksOnly":true}> "${managed}"`
        : `   sudo mkdir -p "${dir}" && printf '%s\\n' '{ "allowManagedHooksOnly": true }' | sudo tee "${managed}"`
    ),
    yellow(
      '   this also disables your own ~/.claude/settings.json hooks and every plugin hook. Move the ones you want into the managed file.'
    )
  );
}

export function uninstall() {
  // .ps1 is no longer written; it stays in this list so an upgrade removes the one an older
  // install left behind.
  for (const t of [...Object.keys(TOOLS), 'agent-lock'])
    for (const ext of ['', '.cmd', '.ps1']) fs.rmSync(path.join(BIN_DIR, t + ext), { force: true });
  const pathEntry = IS_WINDOWS ? removeWindowsPath() : { ok: true, message: '' };
  for (const rc of [path.join(HOME, '.zshrc'), path.join(HOME, '.bashrc')]) {
    if (!fs.existsSync(rc)) continue;
    const cur = fs.readFileSync(rc, 'utf8');
    if (cur.includes(MARK))
      fs.writeFileSync(
        rc,
        cur
          .split('\n')
          .filter((l) => !l.includes(MARK))
          .join('\n')
      );
  }
  if (git(['config', '--global', 'core.hooksPath']) === HOOKS_DIR)
    git(['config', '--global', '--unset', 'core.hooksPath']);
  appendLog('uninstall', REPO);
  out(
    bold('agent-lock removed'),
    dim(
      `   shims, PATH line and git hooks are gone. ${LOCK_HOME}/manifest.json and log were kept; delete the folder to forget everything.`
    )
  );
  // Saying the PATH line is gone when the write failed is the one lie uninstall could tell.
  if (!pathEntry.ok) out(yellow(`   ${pathEntry.message}`));
  if (!fs.existsSync(MJS)) out(red('   note: agent-lock.mjs itself is missing'));
}
