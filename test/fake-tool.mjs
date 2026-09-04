// A stand-in for `claude` / `codex` that PATH resolution finds on every platform.
//
// The body is Node, because node is the one interpreter agent-lock already requires. On Windows
// the file PATH finds has to carry a PATHEXT extension, so the launcher is a .cmd, which is also
// the only way lib/spawn.mjs's cmd.exe command line is ever parsed by a real cmd.exe: the shim
// forwards %* and cmd re-reads it, exactly as an npm-installed CLI does.
import fs from 'node:fs';
import path from 'node:path';

const WIN = process.platform === 'win32';

// The name PATH resolution looks for.
export const exe = (name) => (WIN ? `${name}.cmd` : name);

export function fakeTool(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, `${name}.body.mjs`);
  fs.writeFileSync(js, body);
  const launcher = path.join(dir, exe(name));
  if (WIN)
    fs.writeFileSync(
      launcher,
      ['@echo off', `"${process.execPath}" "${js}" %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n')
    );
  else fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  return launcher;
}

// PATH built from directories, in order, in the platform's own syntax.
export const withPath = (...dirs) => dirs.filter(Boolean).join(path.delimiter);
