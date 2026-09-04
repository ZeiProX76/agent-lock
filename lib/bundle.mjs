// The question, not the asking: which files a model is shown and in what order. `explain` sends
// the same bundle with a different prompt, so it lives apart from the checker that runs the tool.
import { CONFIG_KINDS } from './semantic.mjs';

export const BODY_MAX = 150_000;
export const FILE_MAX = 20_000;

const isHot = (f) => f.kind === 'script' || CONFIG_KINDS.has(f.kind);

// Which files to hand over, most relevant first: what moved, what runs, what was flagged, other code, docs.
export function pickFiles(inv, cmp) {
  const flagged = (rel) => inv.flags.some((x) => x.startsWith(`${rel}:`));
  const moved = new Set([...(cmp?.changed || []), ...(cmp?.added || [])].map((c) => c.file.rel));
  const rank = (f) => {
    if (moved.has(f.rel)) return 0;
    if (isHot(f)) return 1;
    if (flagged(f.rel)) return 2;
    if (f.kind === 'code') return 3;
    return f.kind === 'doc' ? 4 : 9;
  };
  return inv.files
    .filter((f) => f.secret || (f.text !== null && rank(f) < 9))
    .sort((a, b) => rank(a) - rank(b) || a.rel.localeCompare(b.rel));
}

// The text a model gets: the flags, what moved since it was recorded, then the files. `.env` = key names.
export function bundle(inv, cmp) {
  const picked = pickFiles(inv, cmp);
  const parts = [
    `FLAGS RAISED BY THE STATIC CHECK:\n${inv.flags.map((x) => `- ${x}`).join('\n') || '- none'}`,
  ];
  if (cmp && !cmp.unsealed) {
    const moved = (cmp.changed || []).flatMap((c) =>
      (c.changes || [])
        .filter((k) => k.hot)
        .map((k) => `- ${c.file.rel}: ${k.key}: ${k.from ?? '(new)'} → ${k.to ?? '(removed)'}`)
    );
    parts.push(
      `CHANGES SINCE IT WAS RECORDED:\n${moved.join('\n') || '- content changed, see the files marked first'}`
    );
  }
  let body = '';
  const sent = [];
  const omitted = [];
  for (const f of picked) {
    const text = f.secret
      ? `(key names only, values withheld on purpose)\n${Object.keys(f.parsed || {}).join('\n')}`
      : f.text.length > FILE_MAX
        ? `${f.text.slice(0, FILE_MAX)}\n[truncated, ${f.text.length - FILE_MAX} more characters]`
        : f.text;
    if (body.length + text.length > BODY_MAX) {
      omitted.push(f.rel);
      continue;
    }
    body += `\n===== ${f.rel} (${f.kind}) =====\n${text}\n`;
    sent.push(f.rel);
  }
  const notShown = inv.files.length - picked.length;
  const size = omitted.length ? `, ${omitted.length} omitted for size: ${omitted.join(', ')}` : '';
  parts.push(
    `FILES (${sent.length} of ${inv.files.length}, ${notShown} binary or media not shown${size}):${body}`
  );
  return { text: parts.join('\n\n'), count: sent.length, omitted: omitted.length };
}
