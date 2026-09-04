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

// Quote one token for cmd.exe: the C runtime rules (double the backslashes that precede a quote,
// and the trailing run, then wrap), then caret-escape the characters cmd would interpret. The
// caret pass is for the SECOND parse: a .cmd shim forwards `%*`, and cmd re-reads it. This is
// what cross-spawn does and it is the behaviour every npm-installed CLI already lives with. The
// cost is that a literal `%` or `&` inside an argument can reach the program carrying a caret,
// which is why every argument agent-lock builds itself is a flag, a model name or a path, and
// anything with prose in it travels on stdin instead.
export function quoteForCmd(token) {
  const quoted = `"${String(token)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(/([()%!^<>&|,;])/g, '^$1');
}

// The file, arguments and options to hand to child_process for running `real` with `args`.
// `onWindows` is a parameter so the Windows branch can be exercised from any machine.
export function runnable(real, args, onWindows = IS_WINDOWS) {
  const ext = path.extname(real).toLowerCase();
  if (!onWindows || (ext !== '.cmd' && ext !== '.bat')) return { file: real, args, options: {} };
  const line = [real, ...args].map(quoteForCmd).join(' ');
  return {
    // /d skips AutoRun commands from the registry, which is itself a place someone can hide a
    // command; /s with the outer quotes means cmd strips them and takes the rest as written.
    file: process.env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}
