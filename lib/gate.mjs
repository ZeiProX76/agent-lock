// The launch gate. Runs from the PATH shim before `claude`, `codex` or `gemini` starts.
// Protocol: everything human goes to stderr / the terminal; stdout carries exactly three lines
// on success (real binary, session mode, shell-quoted extra args) and nothing on refusal.
import fs from 'node:fs';
import { appendLog, compare, inventoryCheckout, inventoryHome, seal, sealedEntry } from './inventory.mjs';
import { inspect, okLine, printCompare, printInventory } from './print.mjs';
import { TOOLS, findRealBinary, isDangerous, trustedBy } from './tools.mjs';
import { ask, dim, hasTTY, out, red, yellow } from './ui.mjs';

const quote = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
const NO_TTY_HELP = 'no terminal to ask on. Run `agent-lock seal` from a terminal first, or set AGENT_LOCK_SKIP=1 for this one launch (logged).';

function emit(real, mode, extra) {
  process.stdout.write(`${real}\n${mode}\n${extra.map(quote).join(' ')}\n`);
  return 0;
}

// Offer safe mode when the tool has one; returns extra args or null when unavailable.
function safeMode(tool, cwd) {
  const t = TOOLS[tool];
  if (!t.safe) { out(yellow(`   ${t.safeNote}`)); return null; }
  out(dim(`   safe mode: ${t.safeNote}`));
  appendLog('safe-mode', cwd, tool);
  return t.safe(cwd);
}

// Home config: hot change → must be approved; minor change → re-pinned quietly.
function checkHome(tool, cwd) {
  const inv = inventoryHome();
  const entry = sealedEntry(inv);
  const cmp = compare(entry, inv);
  if (cmp.unsealed) {
    printInventory(inv);
    if (!hasTTY()) { out(red(`agent-lock: your home config was never pinned; ${NO_TTY_HELP}`)); return 2; }
    const a = ask('Pin your home config exactly as it is? [y]es [i]nspect [q]uit', 'yiq');
    if (a === 'i') { inspect(inv, cmp); return checkHome(tool, cwd); }
    if (a !== 'y') return 1;
    seal(inv);
    appendLog('seal-home', inv.root, `${inv.files.length} files`);
    return 0;
  }
  if (!cmp.hot) {
    if (cmp.changed.length || cmp.added.length || cmp.removed.length) { seal(inv); appendLog('repin-minor-home', inv.root); }
    return 0;
  }
  printCompare(inv, cmp, entry);
  if (!hasTTY()) { out(red(`agent-lock: your home config changed since you pinned it; ${NO_TTY_HELP}`)); return 1; }
  for (;;) {
    const a = ask('Your user-level config changed. [a]pprove [i]nspect [q]uit', 'aiq');
    if (a === 'i') { inspect(inv, cmp); continue; }
    if (a !== 'a') return 1;
    seal(inv);
    appendLog('approve-home', inv.root, cmp.changed.map((c) => c.file.rel).join(','));
    return 0;
  }
}

// The checkout: never sealed, unchanged, hot change, or minor change.
function checkCheckout(tool, cwd) {
  const inv = inventoryCheckout(cwd);
  const entry = sealedEntry(inv);
  const cmp = compare(entry, inv);
  if (cmp.unsealed) return firstSeal(tool, cwd, inv, cmp);
  if (!cmp.hot) {
    const moved = cmp.changed.length + cmp.added.length + cmp.removed.length;
    if (moved) { seal(inv); appendLog('repin-minor', cwd, `${moved} minor`); }
    okLine(inv, entry, moved ? `${moved} minor change${moved > 1 ? 's' : ''} re-pinned` : '');
    return { code: 0, extra: [], mode: 'ok' };
  }
  printCompare(inv, cmp, entry);
  if (!hasTTY()) { out(red(`agent-lock: ${cwd} changed since you trusted it; ${NO_TTY_HELP}`)); return { code: 1 }; }
  for (;;) {
    const a = ask('Files changed since you trusted them. [a]pprove [i]nspect [s]afe mode [q]uit', 'aisq');
    if (a === 'i') { inspect(inv, cmp); continue; }
    if (a === 's') { const extra = safeMode(tool, cwd); if (extra) return { code: 0, extra, mode: 'safe' }; continue; }
    if (a !== 'a') { appendLog('quit', cwd, tool); return { code: 1 }; }
    seal(inv);
    appendLog('approve', cwd, `${cmp.changed.length} changed, ${cmp.added.length} added`);
    return { code: 0, extra: [], mode: 'ok' };
  }
}

function firstSeal(tool, cwd, inv, cmp) {
  const trusted = trustedBy(cwd);
  printInventory(inv, { trusted });
  if (!inv.files.length) {
    seal(inv);
    appendLog('seal-empty', cwd, tool);
    return { code: 0, extra: [], mode: 'ok' };
  }
  if (!hasTTY()) { out(red(`agent-lock: ${cwd} was never pinned; ${NO_TTY_HELP}`)); return { code: 2 }; }
  for (;;) {
    const a = ask(`Trust these ${inv.files.length} files exactly as they are? [y]es [i]nspect [s]afe mode [q]uit`, 'yisq');
    if (a === 'i') { inspect(inv, cmp); continue; }
    if (a === 's') { const extra = safeMode(tool, cwd); if (extra) return { code: 0, extra, mode: 'safe' }; continue; }
    if (a !== 'y') { appendLog('declined', cwd, tool); return { code: 1 }; }
    seal(inv);
    appendLog('seal', cwd, `${tool} ${inv.files.length} files${inv.flags.length ? ` ${inv.flags.length} flags` : ''}`);
    return { code: 0, extra: [], mode: 'ok' };
  }
}

export function gate(tool, args) {
  if (!TOOLS[tool]) { out(red(`agent-lock: unknown tool ${tool}`)); return 1; }
  const real = findRealBinary(tool);
  if (!real) { out(red(`agent-lock: ${tool} is not on PATH (only the shim is). Install it, or run \`agent-lock uninstall\`.`)); return 127; }
  const cwd = fs.realpathSync(process.cwd());
  if (process.env.AGENT_LOCK_SKIP === '1') { appendLog('skip', cwd, tool); return emit(real, 'skipped', []); }
  const danger = isDangerous(tool, args);
  if (danger.length && !hasTTY() && process.env.AGENT_LOCK_ALLOW_NONINTERACTIVE !== '1') {
    appendLog('refused-flag', cwd, `${tool} ${danger.join(' ')}`);
    out(red(`agent-lock: refusing \`${tool} ${danger.join(' ')}\` with no terminal attached.`),
      dim('   That is how the Nx s1ngularity payload ran agents. Set AGENT_LOCK_ALLOW_NONINTERACTIVE=1 if this automation is yours.'));
    return 1;
  }
  const home = checkHome(tool, cwd);
  if (home !== 0) return home;
  const r = checkCheckout(tool, cwd);
  if (r.code !== 0) return r.code;
  return emit(real, r.mode, r.extra);
}
