// Running another program, the same way on every platform.
//
// Windows has one real complication: since CVE-2024-27980, Node refuses to spawn a `.cmd` or
// `.bat` without `shell: true`, because cmd.exe re-parses the command line and an argument can
// inject a command. Node's own `shell: true` just joins the arguments with spaces, which breaks
// on the first path containing a space, so we build the command line ourselves and hand it to
// cmd.exe verbatim. `claude` and `codex` ship as real .exe files on Windows and never take this
// path; the npm-installed `gemini` does.
import path from 'node:path';
import { IS_WINDOWS } from './tools.mjs';

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

// The one shape that survives the first parse and breaks the second. `%*` puts the argument back
// on a command line, cmd reads it again, and there a literal quote closes the region the rest of
// the argument was relying on: everything after it is read as a command. agent-lock never builds
// an argument like this. One typed by hand is refused rather than guessed at.
export const unsafeForCmd = (args) => args.filter((a) => a.includes('"') && /[&|<>^()]/.test(a));

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
    file: process.env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}
