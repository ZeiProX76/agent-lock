// The launch gate. Runs from the PATH shim before `claude`, `codex` or `gemini` starts.
// Protocol: everything human goes to stderr / the terminal; stdout carries exactly three lines
// on success (real binary, session mode, shell-quoted extra args) and nothing on refusal.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from './exit-codes.mjs';
import { inventoryCheckout, inventoryHome } from './inventory.mjs';
import { appendLog, compare, seal, sealedEntry } from './manifest.mjs';
import { okLine, printCompare, printInventory } from './print.mjs';
import { review } from './review.mjs';
import { runnable } from './spawn.mjs';
import { findRealBinary, IS_WINDOWS, isDangerous, launchChain, TOOLS, trustedBy } from './tools.mjs';
import { dim, hasTTY, out, red, yellow } from './ui.mjs';

const quote = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
const MAX_HOPS = 8;
const isExecutable = (p) => {
  try {
    // Windows has no execute bit; being a file that PATH resolution found is the whole test.
    if (!IS_WINDOWS) fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const NO_TTY_HELP =
  'no terminal to ask on. Run `agent-lock seal` from a terminal first, or set AGENT_LOCK_SKIP=1 for this one launch (logged).';

function emit(real, mode, extra) {
  process.stdout.write(`${real}\n${mode}\n${extra.map(quote).join(' ')}\n`);
  return EXIT.OK;
}

// Offer safe mode when the tool has one; returns extra args or null when unavailable.
function safeMode(tool, cwd) {
  const t = TOOLS[tool];
  if (!t.safe) {
    out(yellow(`   ${t.safeNote}`));
    return null;
  }
  out(dim(`   safe mode: ${t.safeNote}`));
  appendLog('safe-mode', cwd, tool);
  return t.safe(cwd);
}

// Home config: hot change → must be approved; minor change → re-pinned quietly.
async function checkHome(tool, real) {
  const inv = inventoryHome();
  const entry = sealedEntry(inv);
  const cmp = compare(entry, inv);
  if (cmp.unsealed) {
    printInventory(inv);
    if (!hasTTY()) {
      out(red(`agent-lock: your home config was never recorded; ${NO_TTY_HELP}`));
      return EXIT.UNSEALED;
    }
    const a = await review(inv, cmp, {
      tool,
      real,
      launching: tool,
      question: 'Remember your user-level config as it is now?',
      accept: {
        key: 'y',
        label: `yes · remembers these ${inv.files.length} files, asks again only if one changes`,
      },
    });
    if (a !== 'y') return EXIT.CHANGED;
    seal(inv);
    appendLog('seal-home', inv.root, `${inv.files.length} files`);
    return EXIT.OK;
  }
  if (!cmp.hot) {
    if (cmp.changed.length || cmp.added.length || cmp.removed.length) {
      seal(inv);
      appendLog('repin-minor-home', inv.root);
    }
    return EXIT.OK;
  }
  printCompare(inv, cmp, entry);
  if (!hasTTY()) {
    out(red(`agent-lock: your home config changed since you recorded it; ${NO_TTY_HELP}`));
    return EXIT.CHANGED;
  }
  const a = await review(inv, cmp, {
    tool,
    real,
    launching: tool,
    question: `Your user-level config changed. Start ${tool} anyway?`,
    accept: { key: 'a', label: 'yes · accepts the changes and remembers the new files' },
    changes: true,
  });
  if (a !== 'a') return EXIT.CHANGED;
  seal(inv);
  appendLog('approve-home', inv.root, cmp.changed.map((c) => c.file.rel).join(','));
  return EXIT.OK;
}

// The checkout: never sealed, unchanged, hot change, or minor change.
async function checkCheckout(tool, real, cwd) {
  const inv = inventoryCheckout(cwd);
  const entry = sealedEntry(inv);
  const cmp = compare(entry, inv);
  if (cmp.unsealed) return firstSeal(tool, real, cwd, inv, cmp);
  if (!cmp.hot) {
    const moved = cmp.changed.length + cmp.added.length + cmp.removed.length;
    if (moved) {
      seal(inv);
      appendLog('repin-minor', cwd, `${moved} minor`);
    }
    okLine(inv, entry, moved ? `${moved} minor change${moved > 1 ? 's' : ''} recorded` : '');
    return { code: EXIT.OK, extra: [], mode: 'ok' };
  }
  printCompare(inv, cmp, entry);
  if (!hasTTY()) {
    out(red(`agent-lock: ${cwd} changed since you trusted it; ${NO_TTY_HELP}`));
    return { code: EXIT.CHANGED };
  }
  for (;;) {
    const a = await review(inv, cmp, {
      tool,
      real,
      launching: tool,
      question: `Start ${tool} anyway?`,
      accept: { key: 'a', label: `yes · accepts the changes and starts ${tool}` },
      safe: true,
      changes: true,
    });
    if (a === 's') {
      const extra = safeMode(tool, cwd);
      if (extra) return { code: EXIT.OK, extra, mode: 'safe' };
      continue;
    }
    if (a !== 'a') {
      appendLog('quit', cwd, tool);
      return { code: EXIT.CHANGED };
    }
    seal(inv);
    appendLog('approve', cwd, `${cmp.changed.length} changed, ${cmp.added.length} added`);
    return { code: EXIT.OK, extra: [], mode: 'ok' };
  }
}

async function firstSeal(tool, real, cwd, inv, cmp) {
  const trusted = trustedBy(cwd);
  printInventory(inv, { trusted, launching: tool });
  if (!inv.files.length) {
    seal(inv);
    appendLog('seal-empty', cwd, tool);
    return { code: EXIT.OK, extra: [], mode: 'ok' };
  }
  if (!hasTTY()) {
    out(red(`agent-lock: ${cwd} was never recorded; ${NO_TTY_HELP}`));
    return { code: EXIT.UNSEALED };
  }
  for (;;) {
    const a = await review(inv, cmp, {
      tool,
      real,
      launching: tool,
      question: `Start ${tool} in this folder?`,
      accept: {
        key: 'y',
        label: `yes · remembers these ${inv.files.length} files, asks again only if one changes`,
      },
      safe: true,
    });
    if (a === 's') {
      const extra = safeMode(tool, cwd);
      if (extra) return { code: EXIT.OK, extra, mode: 'safe' };
      continue;
    }
    if (a !== 'y') {
      appendLog('declined', cwd, tool);
      return { code: EXIT.CHANGED };
    }
    seal(inv);
    appendLog(
      'seal',
      cwd,
      `${tool} ${inv.files.length} files${inv.flags.length ? ` ${inv.flags.length} flags` : ''}`
    );
    return { code: EXIT.OK, extra: [], mode: 'ok' };
  }
}

// The whole decision, with no output protocol attached: what to run, in which mode, with which
// extra arguments. `gate` prints it for a POSIX shim to exec; `launch` runs it itself, which is
// what Windows needs because Windows has no exec.
export async function decide(tool, args) {
  if (!TOOLS[tool]) {
    out(red(`agent-lock: unknown tool ${tool}`));
    return { code: EXIT.CHANGED };
  }
  // exec: a wrapper handed the launch back to us, skip everything already visited.
  // child: the real tool spawned `${tool}`; give it what its parent ran.
  // A non-empty chain says the same thing on its own: it is only ever set after a gate ran for
  // this launch, and on Windows, where there is no exec and no shell shim, it is the only signal.
  const reentry = process.env.AGENT_LOCK_REENTRY;
  const chain = launchChain();
  const hop = reentry === 'exec' || reentry === 'child' || chain.length > 0;
  if (chain.length > MAX_HOPS) {
    out(red(`agent-lock: ${tool} launch loop after ${MAX_HOPS} hops: ${chain.join(' → ')}`));
    return { code: EXIT.CHANGED };
  }
  const last = chain.at(-1);
  const real = reentry === 'child' && last && isExecutable(last) ? last : findRealBinary(tool, chain);
  if (!real) {
    if (hop)
      out(
        red(
          `agent-lock: every ${tool} on PATH hands the launch back to agent-lock (${chain.join(' → ')}); nothing real left to run.`
        )
      );
    else
      out(
        red(
          `agent-lock: ${tool} is not on PATH (only the shim is). Install it, or run \`agent-lock uninstall\`.`
        )
      );
    return { code: EXIT.NO_BINARY };
  }
  if (hop) return { code: EXIT.OK, real, mode: process.env.AGENT_LOCK_SESSION || 'ok', extra: [] };
  // The checker's own launch (agent-lock asking the model from an empty folder): pass, no log.
  if (process.env.AGENT_LOCK_SKIP === 'check') return { code: EXIT.OK, real, mode: 'check', extra: [] };
  const cwd = fs.realpathSync(process.cwd());
  if (process.env.AGENT_LOCK_SKIP === '1') {
    appendLog('skip', cwd, tool);
    return { code: EXIT.OK, real, mode: 'skipped', extra: [] };
  }
  const danger = isDangerous(tool, args);
  if (danger.length && !hasTTY() && process.env.AGENT_LOCK_ALLOW_NONINTERACTIVE !== '1') {
    appendLog('refused-flag', cwd, `${tool} ${danger.join(' ')}`);
    out(
      red(`agent-lock: refusing \`${tool} ${danger.join(' ')}\` with no terminal attached.`),
      dim(
        '   That is how the Nx s1ngularity payload ran agents. Set AGENT_LOCK_ALLOW_NONINTERACTIVE=1 if this automation is yours.'
      )
    );
    return { code: EXIT.CHANGED };
  }
  const home = await checkHome(tool, real);
  if (home !== EXIT.OK) return { code: home };
  const r = await checkCheckout(tool, real, cwd);
  if (r.code !== EXIT.OK) return { code: r.code };
  return { code: EXIT.OK, real, mode: r.mode, extra: r.extra };
}

// POSIX: the shim reads three lines from stdout and execs the real binary itself.
export async function gate(tool, args) {
  const d = await decide(tool, args);
  return d.code === EXIT.OK ? emit(d.real, d.mode, d.extra) : d.code;
}

// Windows: there is no exec, so agent-lock stays in the middle and runs the tool itself,
// forwarding the console and the exit code. Ctrl-C reaches the whole console group; the tool
// owns it, so we hold our own handlers open and let the child decide when to stop.
export async function launch(tool, args) {
  const d = await decide(tool, args);
  if (d.code !== EXIT.OK) return d.code;
  const run = runnable(d.real, [...d.extra, ...args]);
  const env = {
    ...process.env,
    AGENT_LOCK_SESSION: d.mode,
    AGENT_LOCK_CHAIN: [...launchChain(), d.real].join(path.delimiter),
  };
  const hold = () => {};
  process.on('SIGINT', hold);
  process.on('SIGTERM', hold);
  try {
    const child = spawnSync(run.file, run.args, { stdio: 'inherit', env, ...run.options });
    if (child.error) {
      out(red(`agent-lock: could not start ${d.real}: ${child.error.message}`));
      return EXIT.NO_BINARY;
    }
    return child.status ?? EXIT.ERROR;
  } finally {
    process.off('SIGINT', hold);
    process.off('SIGTERM', hold);
  }
}
