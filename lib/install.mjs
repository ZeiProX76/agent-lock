// install / uninstall: PATH shims, shell rc line, global git hooks, first home seal.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLog, inventoryHome, seal, sealedEntry } from './inventory.mjs';
import { inspect, printInventory } from './print.mjs';
import { BIN_DIR, HOME, LOCK_HOME, TOOLS } from './tools.mjs';
import { ask, bold, dim, green, out, red, yellow } from './ui.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MJS = path.join(REPO, 'agent-lock.mjs');
const MARK = '# agent-lock';
// PATH for scripts, aliases for the interactive shell: terminals such as Ghostty / cmux prepend
// their own bin after the rc files run, and an alias wins regardless of PATH order.
const RC_BLOCK = [`export PATH="$HOME/.agent-lock/bin:$PATH"  ${MARK}`,
  `alias claude="$HOME/.agent-lock/bin/claude" codex="$HOME/.agent-lock/bin/codex" gemini="$HOME/.agent-lock/bin/gemini"  ${MARK}`].join('\n');
const HOOKS_DIR = path.join(LOCK_HOME, 'git-hooks');
// Every standard client-side hook gets the dispatcher, so a global core.hooksPath never
// silences a repo's own pre-commit or pre-push.
const GIT_HOOKS = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate'];

export function shim(tool) {
  return `#!/bin/sh
# agent-lock shim for ${tool}. Installed by \`agent-lock install\`, removed by \`agent-lock uninstall\`.
# Checks the agent config of this folder against what you pinned, then execs the real ${tool}.
AGENT_LOCK_MJS="${MJS}"
NODE_BIN="${process.execPath}"
[ -x "$NODE_BIN" ] || NODE_BIN=node
if [ ! -f "$AGENT_LOCK_MJS" ]; then
  echo "agent-lock: $AGENT_LOCK_MJS is missing. Re-run install, or AGENT_LOCK_SKIP=1 ${tool} for one launch." >&2
  exit 1
fi
# NODE_OPTIONS is cleared for the check itself (a preloaded module has no business inside it); the real ${tool} keeps it.
decision="$(NODE_OPTIONS= "$NODE_BIN" "$AGENT_LOCK_MJS" gate ${tool} -- "$@")" || exit $?
real="$(printf '%s\\n' "$decision" | sed -n 1p)"
mode="$(printf '%s\\n' "$decision" | sed -n 2p)"
extra="$(printf '%s\\n' "$decision" | sed -n 3p)"
[ -n "$real" ] || { echo "agent-lock: no launch decision" >&2; exit 1; }
AGENT_LOCK_SESSION="\${mode:-ok}"; export AGENT_LOCK_SESSION
eval "set -- $extra \\"\\$@\\""
exec "$real" "$@"
`;
}

function addPathLine() {
  const touched = [];
  const rcs = [path.join(HOME, '.zshrc'), path.join(HOME, '.bashrc')].filter((f) => fs.existsSync(f));
  if (!rcs.length) rcs.push(path.join(HOME, (process.env.SHELL || '').endsWith('zsh') ? '.zshrc' : '.bashrc'));
  for (const rc of rcs) {
    const cur = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
    if (cur.includes(MARK)) continue;
    fs.appendFileSync(rc, `${cur.endsWith('\n') || !cur ? '' : '\n'}${RC_BLOCK}\n`);
    touched.push(rc);
  }
  return touched;
}

function git(args) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

// Global hooks that warn at pull time and still run the repo's own .git/hooks.
function installGitHooks() {
  fs.mkdirSync(HOOKS_DIR, { recursive: true, mode: 0o700 });
  const body = fs.readFileSync(path.join(REPO, 'git-hooks', 'hook.sh'), 'utf8').replace('__MJS__', MJS).replace('__NODE__', process.execPath);
  for (const name of GIT_HOOKS) fs.writeFileSync(path.join(HOOKS_DIR, name), body, { mode: 0o755 });
  const current = git(['config', '--global', 'core.hooksPath']);
  if (!current) { git(['config', '--global', 'core.hooksPath', HOOKS_DIR]); return `git core.hooksPath → ${HOOKS_DIR} (repo .git/hooks still run)`; }
  if (current === HOOKS_DIR) return 'git hooks already installed';
  return yellow(`git core.hooksPath is already ${current}; add \`node ${MJS} verify --quiet\` to its post-merge yourself`);
}

function sealHome() {
  const inv = inventoryHome();
  if (sealedEntry(inv)) return 'home config already pinned';
  printInventory(inv);
  for (;;) {
    const a = ask('Pin your home config exactly as it is? [y]es [i]nspect [q]uit', 'yiq');
    if (a === 'i') { inspect(inv, null); continue; }
    if (a !== 'y') return yellow('home config not pinned yet (the first launch will ask again)');
    seal(inv);
    appendLog('seal-home', inv.root, `${inv.files.length} files`);
    return `home config pinned (${inv.files.length} files)`;
  }
}

export function install({ strict = false } = {}) {
  fs.mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
  const tools = Object.keys(TOOLS);
  for (const t of tools) fs.writeFileSync(path.join(BIN_DIR, t), shim(t), { mode: 0o755 });
  fs.writeFileSync(path.join(BIN_DIR, 'agent-lock'), `#!/bin/sh\nexec "${process.execPath}" "${MJS}" "$@"\n`, { mode: 0o755 });
  const rcs = addPathLine();
  out(bold('agent-lock installed'),
    `   shims: ${tools.map((t) => path.join(BIN_DIR, t)).join(', ')}`,
    `   PATH + alias lines ${rcs.length ? `added to ${rcs.join(', ')}` : 'already present'}`,
    `   ${installGitHooks()}`);
  out(`   ${sealHome()}`);
  out('', 'next:', `   ${green('open a new terminal')} (or: ${dim(`export PATH="${BIN_DIR}:$PATH"`)})`,
    `   ${green('agent-lock scan')}   review every folder your tools already trust, then pin them`,
    dim('   claude plugin marketplace add <owner>/agent-lock && claude plugin install agent-lock   (ConfigChange backstop)'));
  if (strict) printStrict();
  appendLog('install', REPO);
}

function printStrict() {
  const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
  out('', bold('--strict (manual, needs sudo): only managed-settings hooks run, repo and user hooks are ignored'),
    dim(`   sudo mkdir -p "${path.dirname(managed)}" && printf '%s\\n' '{ "allowManagedHooksOnly": true }' | sudo tee "${managed}"`),
    yellow('   this also disables your own ~/.claude/settings.json hooks and every plugin hook. Move the ones you want into the managed file.'));
}

export function uninstall() {
  for (const t of [...Object.keys(TOOLS), 'agent-lock']) fs.rmSync(path.join(BIN_DIR, t), { force: true });
  for (const rc of [path.join(HOME, '.zshrc'), path.join(HOME, '.bashrc')]) {
    if (!fs.existsSync(rc)) continue;
    const cur = fs.readFileSync(rc, 'utf8');
    if (cur.includes(MARK)) fs.writeFileSync(rc, cur.split('\n').filter((l) => !l.includes(MARK)).join('\n'));
  }
  if (git(['config', '--global', 'core.hooksPath']) === HOOKS_DIR) git(['config', '--global', '--unset', 'core.hooksPath']);
  appendLog('uninstall', REPO);
  out(bold('agent-lock removed'), dim(`   shims, PATH line and git hooks are gone. ${LOCK_HOME}/manifest.json and log were kept; delete the folder to forget everything.`));
  if (!fs.existsSync(MJS)) out(red('   note: agent-lock.mjs itself is missing'));
}
