// The Windows-specific half of install: the shim file cmd.exe and PowerShell find, and the
// user PATH entry that puts it first. Kept apart so the platform-specific rules are in one
// place a reviewer can read end to end.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIN_DIR, LOCK_HOME, system32 } from './tools.mjs';

const NODE = process.execPath;
const MJS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-lock.mjs');
const POWERSHELL = system32('WindowsPowerShell', 'v1.0', 'powershell.exe');

// One shim per tool, and only a .cmd. There is no exec, so it hands the whole launch to
// `agent-lock launch`, which gates and then runs the tool itself.
//
// No .ps1 beside it, on purpose. A .ps1 on PATH is a script, so it answers to the execution
// policy, and the default on Windows client is Restricted: the shim would fail on a machine
// nobody had configured, and CI runs under a policy that could never show it. PowerShell finds
// the .cmd through PATHEXT and runs it, propagating the exit code the same way.
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

// Add or remove the shim directory on the user PATH. One script for both, so the two halves can
// never disagree about how the value is read or written.
//
// The registry, not [Environment]::GetEnvironmentVariable: that call EXPANDS the stored text, and
// writing the result back turns a REG_EXPAND_SZ `%USERPROFILE%\bin` into a hardcoded path. That
// damage is to entries we do not own and uninstall could not undo. setx is out for its own
// reason: it truncates the value at 1024 characters.
const PATH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$dir = $env:AGENT_LOCK_BIN',
  "if (-not $dir) { throw 'AGENT_LOCK_BIN is not set' }",
  "$add = $env:AGENT_LOCK_ACTION -eq 'add'",
  "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  "$raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
  "$parts = @($raw -split ';' | Where-Object { $_ -ne '' })",
  '$rest = @($parts | Where-Object { $_ -ne $dir })',
  '$new = $(if ($add) { @($dir) + $rest } else { $rest })',
  // Compare normalised to normalised, so a stray empty entry is not a reason to rewrite.
  "$changed = ($new -join ';') -cne ($parts -join ';')",
  // ExpandString either way: with no % in the value it behaves exactly like a plain string, so
  // one code path covers both and nothing is ever flattened.
  "if ($changed) { $key.SetValue('Path', ($new -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString) }",
  '$key.Close()',
  'if ($changed) {',
  '  try {',
  // The broadcast [Environment]::SetEnvironmentVariable would have sent for us. Without it
  // Explorer keeps handing the old environment to every program it starts, including a new
  // terminal, so the install would look like it did nothing.
  "    Add-Type -Namespace AgentLock -Name Native -MemberDefinition @'",
  '[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]',
  'public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);',
  "'@",
  '    $res = [System.UIntPtr]::Zero',
  // HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, 5s.
  "    [void][AgentLock.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$res)",
  '  } catch { }',
  '}',
  "Write-Output $(if ($changed) { 'wrote' } else { 'same' })",
  '',
].join('\r\n');

function runPathScript(action) {
  const script = path.join(LOCK_HOME, 'path.ps1');
  fs.mkdirSync(LOCK_HOME, { recursive: true });
  fs.writeFileSync(script, PATH_SCRIPT);
  return execFileSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    {
      encoding: 'utf8',
      env: { ...process.env, AGENT_LOCK_BIN: BIN_DIR, AGENT_LOCK_ACTION: action },
      windowsHide: true,
    }
  );
}

export function addWindowsPath() {
  try {
    const r = runPathScript('add');
    return {
      ok: true,
      message: r.includes('wrote') ? `PATH updated for your user (${BIN_DIR} first)` : 'PATH already set',
    };
  } catch (e) {
    const why = String(e.stderr || e.message)
      .split('\n')[0]
      .trim();
    return { ok: false, message: `could not set PATH automatically (${why}); add ${BIN_DIR} yourself` };
  }
}

export function removeWindowsPath() {
  try {
    runPathScript('remove');
    return { ok: true, message: `PATH entry removed (${BIN_DIR})` };
  } catch (e) {
    const why = String(e.stderr || e.message)
      .split('\n')[0]
      .trim();
    return { ok: false, message: `could not remove the PATH entry (${why}); remove ${BIN_DIR} yourself` };
  }
}
