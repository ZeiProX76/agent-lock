// Terminal output + prompts. Everything user-facing goes to stderr (or /dev/tty):
// stdout is reserved for the shim protocol (see agent-lock.mjs `gate`).
import fs from 'node:fs';

const color = process.stderr.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const cyan = wrap('36');
export const dim = wrap('2');
export const bold = wrap('1');

export function out(...lines) {
  process.stderr.write(lines.join('\n') + '\n');
}

let ttyFd = null;
export function hasTTY() {
  if (ttyFd === null) {
    try { ttyFd = fs.openSync('/dev/tty', 'r+'); } catch { ttyFd = -1; }
  }
  return ttyFd >= 0;
}

// Ask a one-letter question on the controlling terminal. No default answer:
// Enter alone re-asks. Returns null when there is no terminal (Ctrl-D too).
export function ask(question, letters) {
  if (!hasTTY()) return null;
  const buf = Buffer.alloc(256);
  for (;;) {
    fs.writeSync(ttyFd, `${question} `);
    let n;
    try { n = fs.readSync(ttyFd, buf, 0, buf.length, null); } catch (e) {
      if (e.code === 'EAGAIN') continue;
      throw e;
    }
    if (n <= 0) { fs.writeSync(ttyFd, '\n'); return null; }
    const ch = buf.toString('utf8', 0, n).trim().toLowerCase()[0];
    if (ch && letters.includes(ch)) return ch;
  }
}

// Zero-width, bidi override, word-joiner, soft hyphen, BOM-in-body, and Unicode tag characters.
export const INVISIBLE = /[\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]|[\u{E0000}-\u{E007F}]/gu;

// Make zero-width and bidi characters visible so `inspect` cannot be fooled by them.
export function visible(text) {
  return text.replace(INVISIBLE, (ch) => `⟨U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`);
}

// Print a file for inspection: capped, invisible characters exposed, binary skipped.
export function showFile(label, text, maxLines = 120) {
  out(bold(`--- ${label}`));
  if (text === null) { out(dim('   (binary, not shown)')); return; }
  const lines = visible(text).split('\n');
  for (const line of lines.slice(0, maxLines)) out(`   ${line.length > 240 ? `${line.slice(0, 240)} ${dim(`[+${line.length - 240} chars]`)}` : line}`);
  if (lines.length > maxLines) out(dim(`   [+${lines.length - maxLines} more lines]`));
}

export function kb(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

export function when(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (days <= 0) return `today ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  if (days === 1) return 'yesterday';
  return `${date} (${days}d ago)`;
}

export function shortHome(p) {
  const home = process.env.HOME || '';
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
