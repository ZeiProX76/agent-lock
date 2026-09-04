// Running another program, the same way on every platform.
//
// Windows has one real complication: since CVE-2024-27980, Node refuses to spawn a `.cmd` or
// `.bat` without `shell: true`, because cmd.exe re-parses the command line and an argument can
// inject a command. Node's own `shell: true` just joins the arguments with spaces, which breaks
// on the first path containing a space, so we build the command line ourselves and hand it to
// cmd.exe verbatim. `claude` and `codex` ship as real .exe files on Windows and never take this
// path; the npm-installed `gemini` does.
import path from 'node:path';
import { IS_WINDOWS, system32 } from './tools.mjs';

// Two parsers read this and they disagree about what a quote is.
//
// The argument is first quoted the way a C runtime expects, because that is what the program at
// the end has to read. Then every character cmd.exe would act on is caret-escaped, INCLUDING the
// quotes. Escaping the quotes is the part that took a real Windows run to find: cmd strips a
// caret outside a quoted region and leaves it alone inside one, so escaping `(` while the
// argument was quoted delivered the caret to the program, and `C:\Program Files (x86)\x.json`
// arrived as `C:\Program Files ^(x86^)\x.json`. With the quotes escaped too, cmd never enters a
// quoted region, every caret is removed, and the batch file's `%*` holds exactly the C-runtime
// quoting the program wants.
const CMD_META = /([()%!^<>&|,;"])/g;

export function quoteForCmd(token) {
  const quoted = `"${String(token)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1');
}

// The two shapes that survive the first parse and break the second. Neither can be escaped, so
// both are refused rather than guessed at.
//
// In the arguments: `%*` puts them back on a command line and cmd reads them again; there a
// literal quote closes the quoted region that everything after it was relying on, and a `&` or a
// `|` sitting outside quotes is read as the next command. Neither half is a problem alone, so a
// quoted prompt stays allowed and a path with brackets stays allowed. Together they are the
// injection.
//
// In the program path: cmd expands `%VAR%` on its command line even inside quotes, and a caret
// inside a quoted region is delivered to the program rather than removed, so there is no spelling
// of a percent that both survives cmd and reaches the program unchanged.
const CHAINS = /[&|<>]/;
export function unsafeForCmd(real, args) {
  const bad = String(real).includes('%') ? [real] : [];
  const quoted = (a) => a.includes('"');
  if (args.some(quoted) && args.some((a) => CHAINS.test(a)))
    bad.push(...args.filter((a) => quoted(a) || CHAINS.test(a)));
  return bad;
}

// The file, arguments and options to hand to child_process for running `real` with `args`.
// `onWindows` is a parameter so the Windows branch can be exercised from any machine.
export function runnable(real, args, onWindows = IS_WINDOWS) {
  const ext = path.extname(real).toLowerCase();
  if (!onWindows || (ext !== '.cmd' && ext !== '.bat')) return { file: real, args, options: {} };
  // The program keeps real quotes: cmd splits the command it runs on spaces, and an escaped quote
  // there would break "C:\Program Files\...". Only the arguments are caret-escaped.
  const line = [`"${real}"`, ...args.map(quoteForCmd)].join(' ');
  return {
    // /d skips AutoRun commands from the registry, which is itself a place someone can hide a
    // command; /s with the outer quotes means cmd strips them and takes the rest as written.
    file: system32('cmd.exe'),
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}
