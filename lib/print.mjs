// Rendering: inventories, diffs, inspection. Words, not scores.
import { CONFIG_KINDS } from './semantic.mjs';
import { bold, cyan, dim, kb, out, red, shortHome, showFile, when, yellow } from './ui.mjs';

const isHotKind = (kind) => kind === 'script' || CONFIG_KINDS.has(kind);
const FOOTER = 'pinned, not vouched for';

function describe(inv, f) {
  const cmds = inv.commands.filter((c) => c.file === f.rel);
  const bits = [];
  if (f.kind === 'script') bits.push('runs');
  if (cmds.length) bits.push(`${cmds.length} command${cmds.length > 1 ? 's' : ''}`);
  if (f.parsed && f.kind !== 'env') {
    const hooks = Object.values(f.parsed.hooks || {}).flat().reduce((n, g) => n + (Array.isArray(g?.hooks) ? g.hooks.length : 1), 0);
    const mcp = Object.keys(f.parsed.mcpServers || f.parsed.mcp_servers || {}).length;
    if (hooks) bits.push(`${hooks} hook${hooks > 1 ? 's' : ''}`);
    if (mcp) bits.push(`${mcp} MCP server${mcp > 1 ? 's' : ''}`);
  }
  if (f.kind === 'env' && f.parsed) bits.push(`${Object.keys(f.parsed).length} keys, values never read`);
  if (f.symlink) bits.push(`→ ${f.symlink}`);
  return bits.join(', ');
}

// The full picture of one root before it gets trusted.
export function printInventory(inv, { trusted = [], entry = null } = {}) {
  const label = inv.isHome ? 'your home config (read on every launch)' : shortHome(inv.root);
  out('', bold(label) + (entry ? dim(`   sealed ${when(entry.sealed_at)}`) : ''));
  if (trusted.length) out(yellow(`   already trusted by ${trusted.join(' and ')}, never by you`));
  if (!inv.files.length) { out(dim('   no agent config here')); return; }
  // Every hot file is listed; the dim ones (docs, skills, rules) are capped so the flags stay on screen.
  const hot = inv.files.filter((f) => isHotKind(f.kind));
  const cold = inv.files.filter((f) => !isHotKind(f.kind));
  for (const f of [...hot.slice(0, 80), ...cold.slice(0, 8)]) {
    const desc = describe(inv, f);
    out(`   ${isHotKind(f.kind) ? cyan('●') : dim('○')} ${isHotKind(f.kind) ? f.rel : dim(f.rel)}  ${dim(kb(f.size))}${desc ? dim(`  ${desc}`) : ''}`);
  }
  const hidden = Math.max(0, hot.length - 80) + Math.max(0, cold.length - 8);
  if (hidden) out(dim(`   … ${hidden} more files (docs, skills, rules), all hashed`));
  printFlags(inv.flags);
  out(dim(`   ${inv.files.length} files, ${inv.hotCount} of them run or configure something. ${FOOTER}`));
}

export function printFlags(flags, prefix = '') {
  if (!flags.length) { out(dim(`   ${prefix}no flags`)); return; }
  for (const f of flags) out(red(`   ⚠ ${prefix}${f}`));
}

function printChanges(changes, hot) {
  const shown = changes.filter((c) => c.hot === hot);
  const paint = hot ? red : dim;
  for (const c of shown.slice(0, 12)) {
    const short = (v) => (v === null ? '' : v.length > 90 ? `${v.slice(0, 90)}…` : v);
    if (c.from === null) out(paint(`       + ${c.key}${c.to === 'true' && c.key.includes('[]=') ? '' : ` = ${short(c.to)}`}`));
    else if (c.to === null) out(paint(`       - ${c.key}${c.from === 'true' && c.key.includes('[]=') ? '' : ` = ${short(c.from)}`}`));
    else out(paint(`       ~ ${c.key}: ${short(c.from)} → ${short(c.to)}`));
  }
  if (shown.length > 12) out(paint(`       … ${shown.length - 12} more`));
}

// What moved since the seal. Hot lines red, the rest dim.
export function printCompare(inv, cmp, entry) {
  const label = inv.isHome ? 'your home config' : shortHome(inv.root);
  const count = cmp.changed.length + cmp.added.length + cmp.removed.length;
  const head = cmp.hot ? red(`${count} change${count === 1 ? '' : 's'} in ${label} since you trusted it (${when(entry?.sealed_at)})`)
    : dim(`${count} minor change${count === 1 ? '' : 's'} in ${label}`);
  out('', head);
  const order = (a, b) => Number(b.hot) - Number(a.hot);
  for (const c of [...cmp.changed].sort(order)) {
    const paint = c.hot ? red : dim;
    out(paint(`   ${c.hot ? '✗' : '~'} ${c.file.rel}${c.reason ? `  (${c.reason})` : ''}`));
    if (c.changes) { printChanges(c.changes, true); printChanges(c.changes, false); }
  }
  for (const a of [...cmp.added].sort(order)) out((a.hot ? red : dim)(`   ${a.hot ? '✗' : '+'} new file ${a.file.rel}  ${kb(a.file.size)}${a.hot ? '  (runs or configures something)' : ''}`));
  for (const rel of cmp.removed) out(dim(`   - removed ${rel}`));
  if (cmp.newFlags.length) printFlags(cmp.newFlags, 'new: ');
}

// Show the files a human should read: hot changes, new hot files, anything flagged.
export function inspect(inv, cmp) {
  const want = new Set();
  if (cmp?.unsealed || !cmp) for (const f of inv.files) if (isHotKind(f.kind)) want.add(f.rel);
  for (const c of cmp?.changed || []) if (c.hot) want.add(c.file.rel);
  for (const a of cmp?.added || []) if (a.hot) want.add(a.file.rel);
  for (const flag of inv.flags) for (const f of inv.files) if (flag.startsWith(`${f.rel}:`)) want.add(f.rel);
  for (const f of inv.files) {
    if (!want.has(f.rel)) continue;
    if (f.secret) { out(bold(`--- ${f.rel}`), dim(`   keys: ${Object.keys(f.parsed || {}).join(', ') || '(none)'}  (values never shown)`)); continue; }
    showFile(f.rel, f.text);
  }
  if (!want.size) out(dim('   nothing to inspect'));
  out('');
}

export function okLine(inv, entry, note = '') {
  out(dim(`agent-lock ok · ${inv.files.length} file${inv.files.length === 1 ? '' : 's'} · trusted ${when(entry.sealed_at)}${note ? ` · ${note}` : ''}`));
}
