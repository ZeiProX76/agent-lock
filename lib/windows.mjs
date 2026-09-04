// The Windows-specific half of install: the shim files cmd.exe and PowerShell find, and the
// user PATH entry that puts them first. Kept apart so the platform-specific rules are in one
// place a reviewer can read end to end.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIN_DIR, LOCK_HOME } from './tools.mjs';
import { yellow } from './ui.mjs';

const NODE = process.execPath;
const MJS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-lock.mjs');

// Windows shims. There is no exec, so the shim hands the whole launch to `agent-lock launch`,
// which gates and then runs the tool itself. Both extensions are written because cmd.exe finds
// the .cmd through PATHEXT and PowerShell prefers the .ps1.
export function cmdShim(tool, mjs = MJS, node = NODE) {
  return [
    '@echo off',
    `rem agent-lock shim for ${tool}. Installed by \`agent-lock install\`, removed by \`agent-lock uninstall\`.`,
    // goto, not a parenthesised if-block: "C:\\Program Files (x86)" would close the block early.
    `if exist "${mjs}" goto run`,
    `echo agent-lock: ${mjs} is missing. Re-run install, or set AGENT_LOCK_SKIP=1 for one launch. 1>&2`,
    'exit /b 1',
    ':run',
    `"${node}" "${mjs}" launch ${tool} -- %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

export function ps1Shim(tool, mjs = MJS, node = NODE) {
  return [
    '#!/usr/bin/env pwsh',
    `# agent-lock shim for ${tool}.`,
    `& "${node}" "${mjs}" launch ${tool} -- @args`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}

// Put the shim directory first on the user PATH, through the API that also tells running
// programs the environment changed. setx is not used: it truncates the value at 1024 characters.
export function addWindowsPath() {
  const script = path.join(LOCK_HOME, 'add-path.ps1');
  fs.mkdirSync(LOCK_HOME, { recursive: true });
  fs.writeFileSync(
    script,
    [
      '$dir = $env:AGENT_LOCK_BIN',
      "$p = [Environment]::GetEnvironmentVariable('Path','User')",
      "if ($null -eq $p) { $p = '' }",
      "if (($p -split ';') -notcontains $dir) {",
      "  [Environment]::SetEnvironmentVariable('Path', ($dir + ';' + $p).TrimEnd(';'), 'User')",
      "  Write-Output 'added'",
      "} else { Write-Output 'present' }",
      '',
    ].join('\r\n')
  );
  try {
    const r = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { encoding: 'utf8', env: { ...process.env, AGENT_LOCK_BIN: BIN_DIR }, windowsHide: true }
    );
    return r.includes('added') ? `PATH updated for your user (${BIN_DIR} first)` : 'PATH already set';
  } catch (e) {
    return yellow(`could not set PATH automatically (${e.message.split('\n')[0]}); add ${BIN_DIR} yourself`);
  }
}

export function removeWindowsPath() {
  const script = path.join(LOCK_HOME, 'remove-path.ps1');
  try {
    fs.writeFileSync(
      script,
      [
        '$dir = $env:AGENT_LOCK_BIN',
        "$p = [Environment]::GetEnvironmentVariable('Path','User')",
        'if ($null -ne $p) {',
        "  $kept = ($p -split ';') | Where-Object { $_ -ne $dir -and $_ -ne '' }",
        "  [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')",
        '}',
        '',
      ].join('\r\n')
    );
    execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      {
        env: { ...process.env, AGENT_LOCK_BIN: BIN_DIR },
        windowsHide: true,
      }
    );
  } catch {
    /* the user can remove it by hand; uninstall still removes the shims */
  }
}
