// Terminal output + prompts. Everything user-facing goes to stderr (or /dev/tty):
// stdout is reserved for the shim protocol (see agent-lock.mjs `gate`).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { HOME, IS_WINDOWS } from './tools.mjs';

const color = process.stderr.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const cyan = wrap('36');
export const dim = wrap('2');
export const bold = wrap('1');

// ---------------------------------------------------------------------------------------------
// Glyphs. Windows Terminal, VS Code's terminal and every POSIX terminal draw the marks below.
// The conhost window that still opens for PowerShell 5.1 uses a raster font that has none of
// them and prints a box per character. Rather than keep two vocabularies through the codebase,
// every string is written in Unicode and downgraded once, on the way out.
// AGENT_LOCK_ASCII=1 forces the plain set anywhere, which is how it is tested off Windows.
// ---------------------------------------------------------------------------------------------
const ASCII = {
  '✓': '+',
  '✗': 'x',
  '⚠': '!',
  '●': '*',
  '○': 'o',
  '❯': '>',
  '→': '->',
  '…': '...',
  '·': '-',
  '⟨': '<',
  '⟩': '>',
};
const ASCII_RE = new RegExp(`[${Object.keys(ASCII).join('')}]`, 'g');
export const UNICODE_OK =
  process.env.AGENT_LOCK_ASCII === '1'
    ? false
    : !IS_WINDOWS ||
      Boolean(
        process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.TERM || process.env.ConEmuANSI
      );
export const downgrade = (text) =>
  UNICODE_OK ? String(text) : String(text).replace(ASCII_RE, (c) => ASCII[c]);

export function out(...lines) {
  process.stderr.write(downgrade(`${lines.join('\n')}\n`));
}

// ---------------------------------------------------------------------------------------------
// The terminal we prompt on. Never stdout: stdout carries the shim protocol.
//
// POSIX opens /dev/tty, so a piped stdin still gets a prompt, and switches it to raw mode with
// stty, because Node's setRawMode throws EAGAIN on a separately opened tty fd.
//
// Windows has no /dev/tty, and opening CONIN$ as a tty.ReadStream only delivers a buffer when
// Enter is pressed (nodejs/node#56338). process.stdin is the one input Node reads correctly
// there, through ReadConsoleInput, so on Windows the prompt needs stdin to be the console.
// ---------------------------------------------------------------------------------------------

// Node can leave a tty fd non-blocking, and then a read with nothing typed yet returns EAGAIN.
// Retrying flat out would spin a core while the menu waits, so back off between attempts.
// Raw mode is what makes the arrow menu work. busybox stty has no -g to save the terminal with,
// and some terminals refuse it outright; both fall back to the one-letter menu on their own.
// AGENT_LOCK_NO_RAW=1 asks for that fallback deliberately, which is also how it is tested.
const NO_RAW = process.env.AGENT_LOCK_NO_RAW === '1';

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(SLEEP_BUF, 0, 0, ms);

function posixTerm(fd) {
  const stty = (args, capture = false) =>
    execFileSync('stty', args, { stdio: [fd, capture ? 'pipe' : 'ignore', 'ignore'], encoding: 'utf8' });
  const buf = Buffer.alloc(64);
  let saved = null;
  const restore = () => {
    if (saved === null) return;
    const was = saved;
    saved = null;
    try {
      stty([was]);
    } catch {
      /* terminal already gone */
    }
  };
  return {
    write: (text) => fs.writeSync(fd, downgrade(text)),
    width() {
      try {
        const cols = Number(stty(['size'], true).trim().split(/\s+/)[1]);
        if (cols > 0) return cols;
      } catch {
        /* no stty size */
      }
      return process.stderr.columns || 80;
    },
    raw(on) {
      if (!on) {
        restore();
        process.off('exit', restore);
        return true;
      }
      if (NO_RAW) return false;
      try {
        saved = stty(['-g'], true).trim();
        stty(['-icanon', '-echo', '-isig', 'min', '1', 'time', '0']);
      } catch {
        saved = null;
        return false;
      }
      process.once('exit', restore);
      return true;
    },
    read() {
      for (;;) {
        try {
          const n = fs.readSync(fd, buf, 0, buf.length, null);
          return Promise.resolve(buf.toString('utf8', 0, Math.max(n, 0)));
        } catch (e) {
          if (e.code === 'EAGAIN') sleep(15);
          else if (e.code !== 'EINTR') throw e;
        }
      }
    },
  };
}

function windowsTerm() {
  const stdin = process.stdin;
  return {
    write: (text) => process.stderr.write(downgrade(text)),
    width: () => process.stderr.columns || process.stdout.columns || 80,
    raw(on) {
      if (NO_RAW || typeof stdin.setRawMode !== 'function') return false;
      stdin.setRawMode(on);
      if (on) stdin.resume();
      else stdin.pause();
      return true;
    },
    read() {
      return new Promise((resolve) => {
        const done = (text) => {
          stdin.off('data', onData);
          stdin.off('end', onEnd);
          resolve(text);
        };
        const onData = (d) => done(d.toString('utf8'));
        const onEnd = () => done('');
        stdin.once('data', onData);
        stdin.once('end', onEnd);
      });
    },
  };
}

let term;
function openTerm() {
  if (term !== undefined) return term;
  term = null;
  if (IS_WINDOWS) {
    if (process.stdin.isTTY) term = windowsTerm();
  } else {
    try {
      term = posixTerm(fs.openSync('/dev/tty', 'r+'));
    } catch {
      /* no controlling terminal */
    }
  }
  return term;
}

export const hasTTY = () => openTerm() !== null;

// Ask a one-letter question on the terminal. No default answer: Enter alone re-asks.
// Returns null when there is no terminal (end of input too).
export async function ask(question, letters) {
  const t = openTerm();
  if (!t) return null;
  for (;;) {
    t.write(`${question} `);
    const s = await t.read();
    if (!s) {
      t.write('\n');
      return null;
    }
    const ch = s.trim().toLowerCase()[0];
    if (ch && letters.includes(ch)) return ch;
    // Without raw mode an arrow key arrives as an escape sequence and means nothing here. Say
    // what does, rather than reprint the same prompt and look like it ignored the key.
    t.write(dim(`   pick one of: ${letters.split('').join(', ')}\n`));
  }
}

// One key press, decoded. Arrow keys arrive as one escape sequence per read in raw mode.
export function readKey(s) {
  if (s === '' || s === '\x04') return 'eof';
  if (s === '\x1b[A' || s === '\x1bOA' || s === 'k') return 'up';
  if (s === '\x1b[B' || s === '\x1bOB' || s === 'j') return 'down';
  if (s === '\r' || s === '\n' || s === '\r\n') return 'enter';
  if (s === '\x1b' || s === '\x03') return 'escape';
  return s.trim().toLowerCase()[0] || '';
}

// The ellipsis is one column in Unicode and three in ASCII, so the budget is taken from the
// mark that will actually be printed, not from the one written here.
const ELL = UNICODE_OK ? '…' : '...';
const fit = (text, max) =>
  text.length <= max ? text : `${text.slice(0, Math.max(1, max - ELL.length))}${ELL}`;

// A menu on the terminal: arrows or j/k move, Enter picks, a letter picks directly, Esc or
// Ctrl-C quit. Returns the picked key, or null on end of input / no terminal. The menu collapses
// to one line once answered so the transcript keeps the choice.
export async function menu(question, items, { cursor = 0 } = {}) {
  const t = openTerm();
  if (!t || !items.length) return null;
  const quit = items.find((i) => i.key === 'q')?.key ?? null;
  if (!t.raw(true)) return menuFallback(t, question, items);
  let at = Math.min(Math.max(cursor, 0), items.length - 1);
  const width = t.width();
  const line = (it, i) => {
    const label = fit(it.label, width - 8);
    return `\x1b[2K  ${i === at ? cyan('❯') : ' '} ${dim(`[${it.key}]`)} ${i === at ? bold(label) : label}`;
  };
  const draw = (first) => t.write(`${first ? '' : `\x1b[${items.length}A`}${items.map(line).join('\n')}\n`);
  const finish = (key) => {
    const chosen = items.find((i) => i.key === key);
    const answer = chosen
      ? cyan(`❯ ${fit(chosen.label, Math.max(8, width - question.length - 4))}`)
      : dim('(no answer)');
    t.write(`\x1b[${items.length + 1}A\x1b[J${bold(fit(question, width))} ${answer}\n`);
    return key;
  };
  t.write(`${bold(question)}\n\x1b[?25l`);
  draw(true);
  try {
    for (;;) {
      const key = readKey(await t.read());
      if (key === 'eof') return finish(null);
      if (key === 'enter') return finish(items[at].key);
      if (key === 'escape') return finish(quit);
      if (key === 'up') at = (at + items.length - 1) % items.length;
      else if (key === 'down') at = (at + 1) % items.length;
      else if (items.some((i) => i.key === key)) return finish(key);
      draw(false);
    }
  } finally {
    t.raw(false);
    t.write('\x1b[?25h');
  }
}

// No stty (or a terminal that cannot do raw mode): same choices, one letter each.
function menuFallback(t, question, items) {
  t.write(`${bold(question)}\n${items.map((i) => `   [${i.key}] ${i.label}`).join('\n')}\n`);
  return ask('>', items.map((i) => i.key).join(''));
}

// Zero-width, bidi override, word-joiner, soft hyphen, BOM-in-body, and Unicode tag characters.
export const INVISIBLE =
  /[\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]|[\u{E0000}-\u{E007F}]/gu;

// Make zero-width and bidi characters visible so `inspect` cannot be fooled by them.
export function visible(text) {
  return text.replace(
    INVISIBLE,
    (ch) => `⟨U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`
  );
}

// Print a file for inspection: capped, invisible characters exposed, binary skipped.
export function showFile(label, text, maxLines = 120) {
  out(bold(`--- ${label}`));
  if (text === null) {
    out(dim('   (binary, not shown)'));
    return;
  }
  const lines = visible(text).split('\n');
  for (const line of lines.slice(0, maxLines))
    out(`   ${line.length > 240 ? `${line.slice(0, 240)} ${dim(`[+${line.length - 240} chars]`)}` : line}`);
  if (lines.length > maxLines) out(dim(`   [+${lines.length - maxLines} more lines]`));
}

const SPINNER = UNICODE_OK ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['-', '\\', '|', '/'];

// A running clock while a child process works. Returns the function that clears it; with no
// terminal it prints the label once, so a piped run still says what it is waiting for.
export function spinner(label) {
  if (!process.stderr.isTTY) {
    out(dim(`   ${label}…`));
    return () => {};
  }
  const t0 = Date.now();
  let i = 0;
  const draw = () =>
    process.stderr.write(
      downgrade(
        `\r\x1b[2K   ${cyan(SPINNER[i++ % SPINNER.length])} ${label}… ${Math.round((Date.now() - t0) / 1000)}s`
      )
    );
  draw();
  const timer = setInterval(draw, 80);
  return () => {
    clearInterval(timer);
    process.stderr.write('\r\x1b[2K');
  };
}

export function kb(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

export function when(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (days <= 0) return `today ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  if (days === 1) return 'yesterday';
  return `${date} (${days}d ago)`;
}

export function shortHome(p) {
  return HOME && p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}
