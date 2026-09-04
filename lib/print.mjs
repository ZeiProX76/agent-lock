// Rendering: inventories, diffs, inspection. Words, not scores.
import { CONFIG_KINDS } from './semantic.mjs';
import { bold, cyan, dim, kb, out, red, shortHome, showFile, when, yellow } from './ui.mjs';

const isHotKind = (kind) => kind === 'script' || CONFIG_KINDS.has(kind);
export const FOOTER = 'agent-lock knows what changed, not what is safe.';
// The inventory shows what is flagged. The full list is one key away (`[l]` on the menu), because
// a folder can hold 131 files and eight fonts scrolling past teach nothing.
const LIST_HOT_MAX = 200;
const LIST_DIM_MAX = 200;
const CHANGES_MAX = 12;
const VALUE_MAX = 90;
const shortValue = (v) => (v === null ? '' : v.length > VALUE_MAX ? `${v.slice(0, VALUE_MAX)}…` : v);

function describe(inv, f) {
  const cmds = inv.commands.filter((c) => c.file === f.rel);
  const bits = [];
  if (f.kind === 'script') bits.push('runs');
  if (cmds.length) bits.push(`${cmds.length} command${cmds.length > 1 ? 's' : ''}`);
  if (f.parsed && f.kind !== 'env') {
    const hooks = Object.values(f.parsed.hooks || {})
      .flat()
      .reduce((n, g) => n + (Array.isArray(g?.hooks) ? g.hooks.length : 1), 0);
    const mcp = Object.keys(f.parsed.mcpServers || f.parsed.mcp_servers || {}).length;
    if (hooks) bits.push(`${hooks} hook${hooks > 1 ? 's' : ''}`);
    if (mcp) bits.push(`${mcp} MCP server${mcp > 1 ? 's' : ''}`);
  }
  if (f.kind === 'env' && f.parsed) bits.push(`${Object.keys(f.parsed).length} keys, values never read`);
  if (f.symlink) bits.push(`→ ${f.symlink}`);
  return bits.join(', ');
}

// The full picture of one root before it gets trusted.
export function printInventory(inv, { trusted = [], entry = null, launching = null } = {}) {
  const label = inv.isHome ? 'your home config (read on every launch)' : shortHome(inv.root);
  out('', bold(label) + (entry ? dim(`   recorded ${when(entry.sealed_at)}`) : ''));
  if (trusted.length) out(yellow(`   already trusted by ${trusted.join(' and ')}, never by you`));
  if (!inv.files.length) {
    out(dim('   no agent config here'));
    return;
  }
  printFlags(inv.flags);
  out(
    dim(
      `   ${inv.files.length} file${inv.files.length === 1 ? '' : 's'} hashed, ${inv.hotCount} of them run or configure something.`
    )
  );
  if (launching) out(dim(`   nothing here has run yet: this happens before ${launching} starts.`));
  out(dim(`   ${FOOTER}`));
}

// The list itself, on request. Hot files first, each with what it would do.
export function printFiles(inv) {
  const hot = inv.files.filter((f) => isHotKind(f.kind));
  const cold = inv.files.filter((f) => !isHotKind(f.kind));
  out('', dim(`   ${hot.length} run or configure something:`));
  for (const f of hot.slice(0, LIST_HOT_MAX)) {
    const desc = describe(inv, f);
    out(`   ${cyan('●')} ${f.rel}  ${dim(kb(f.size))}${desc ? dim(`  ${desc}`) : ''}`);
  }
  if (cold.length) out('', dim(`   ${cold.length} hashed, none of them run: docs, skills, rules, assets`));
  for (const f of cold.slice(0, LIST_DIM_MAX)) out(dim(`   ○ ${f.rel}  ${kb(f.size)}`));
  const hidden = Math.max(0, hot.length - LIST_HOT_MAX) + Math.max(0, cold.length - LIST_DIM_MAX);
  if (hidden) out(dim(`   … ${hidden} more, all hashed`));
  out('');
}

export function printFlags(flags, prefix = '') {
  if (!flags.length) {
    out(dim(`   ${prefix}no flags`));
    return;
  }
  for (const f of flags) out(red(`   ⚠ ${prefix}${f}`));
}

function printChanges(changes, hot) {
  const shown = changes.filter((c) => c.hot === hot);
  const paint = hot ? red : dim;
  for (const c of shown.slice(0, CHANGES_MAX)) {
    if (c.from === null)
      out(
        paint(`       + ${c.key}${c.to === 'true' && c.key.includes('[]=') ? '' : ` = ${shortValue(c.to)}`}`)
      );
    else if (c.to === null)
      out(
        paint(
          `       - ${c.key}${c.from === 'true' && c.key.includes('[]=') ? '' : ` = ${shortValue(c.from)}`}`
        )
      );
    else out(paint(`       ~ ${c.key}: ${shortValue(c.from)} → ${shortValue(c.to)}`));
  }
  if (shown.length > CHANGES_MAX) out(paint(`       … ${shown.length - CHANGES_MAX} more`));
}

// Where a set of changed paths clusters, so a count can name the folder instead of listing it.
function clusters(rels, top = 2) {
  const counts = new Map();
  for (const rel of rels) {
    const dir = rel.split('/').slice(0, 3).join('/');
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([dir, n]) => `${dir} (${n})`)
    .join(', ');
}

const changedLine = (c) =>
  (c.hot ? red : dim)(`   ${c.hot ? '✗' : '~'} ${c.file.rel}${c.reason ? `  (${c.reason})` : ''}`);
const addedLine = (a) =>
  (a.hot ? red : dim)(
    `   ${a.hot ? '✗' : '+'} new file ${a.file.rel}  ${kb(a.file.size)}${a.hot ? '  (runs or configures something)' : ''}`
  );

// What moved since it was recorded. The same rule as the inventory: what runs is on screen in
// full, everything else is one line with a count, because forty lines of eval output and skill
// docs is how a reader learns to skip the screen that matters.
export function printCompare(inv, cmp, entry) {
  const label = inv.isHome ? 'your home config' : shortHome(inv.root);
  const count = cmp.changed.length + cmp.added.length + cmp.removed.length;
  const head = cmp.hot
    ? red(
        `${count} change${count === 1 ? '' : 's'} in ${label} since you trusted it (${when(entry?.sealed_at)})`
      )
    : dim(`${count} minor change${count === 1 ? '' : 's'} in ${label}`);
  out('', head);
  if (cmp.newFlags.length) printFlags(cmp.newFlags, 'new: ');
  const hotChanged = cmp.changed.filter((c) => c.hot);
  const hotAdded = cmp.added.filter((a) => a.hot);
  for (const c of hotChanged) {
    out(changedLine(c));
    if (c.changes) {
      printChanges(c.changes, true);
      printChanges(c.changes, false);
    }
  }
  for (const a of hotAdded) out(addedLine(a));
  for (const rel of cmp.removed.slice(0, CHANGES_MAX)) out(dim(`   - removed ${rel}`));
  if (cmp.removed.length > CHANGES_MAX) out(dim(`   - and ${cmp.removed.length - CHANGES_MAX} more removed`));
  const cold = [
    ...cmp.changed.filter((c) => !c.hot).map((c) => c.file.rel),
    ...cmp.added.filter((a) => !a.hot).map((a) => a.file.rel),
  ];
  if (cold.length) {
    const where = clusters(cold);
    out(dim(`   ${cold.length} more changed or added, none of them run${where ? `: ${where}` : ''}`));
  }
  if (!hotChanged.length && !hotAdded.length && !cmp.newFlags.length)
    out(dim('   nothing that runs or configures anything changed.'));
  out(dim(`   ${FOOTER}`));
}

// Every change, on request. The screen above stays short; this is the one that spells it out.
export function printChangeList(cmp) {
  out('');
  for (const c of [...cmp.changed].sort((a, b) => Number(b.hot) - Number(a.hot))) {
    out(changedLine(c));
    if (c.changes) {
      printChanges(c.changes, true);
      printChanges(c.changes, false);
    }
  }
  for (const a of [...cmp.added].sort((x, y) => Number(y.hot) - Number(x.hot))) out(addedLine(a));
  for (const rel of cmp.removed) out(dim(`   - removed ${rel}`));
  out('');
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
    if (f.secret) {
      out(
        bold(`--- ${f.rel}`),
        dim(`   keys: ${Object.keys(f.parsed || {}).join(', ') || '(none)'}  (values never shown)`)
      );
      continue;
    }
    showFile(f.rel, f.text);
  }
  if (!want.size) out(dim('   nothing to inspect'));
  out('');
}

export function okLine(inv, entry, note = '') {
  out(
    dim(
      `agent-lock ok · ${inv.files.length} file${inv.files.length === 1 ? '' : 's'} · trusted ${when(entry.sealed_at)}${note ? ` · ${note}` : ''}`
    )
  );
}
