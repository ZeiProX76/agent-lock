// A real install on a real Windows machine, then the shim through every shell that ships with it.
//
// Not part of `npm test`: it writes the user PATH, the global git hooks path and a registry
// policy key, so it only runs on a throwaway CI runner. Everything it changes, it changes back.
// usage: node test/windows-install.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeTool, withPath } from './fake-tool.mjs';

if (process.platform !== 'win32') {
  console.log('windows-install: not Windows, nothing to do');
  process.exit(0);
}

const CLI = fileURLToPath(new URL('../agent-lock.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lock-install-'));
// Set before the library is loaded: LOCK_HOME is read once, at import time, so a static import
// of anything under lib/ here would pin the real ~/.agent-lock instead of this throwaway one.
process.env.AGENT_LOCK_HOME = path.join(tmp, 'lockhome');
const { windowsPolicyEntries } = await import('../lib/tools.mjs');
const { inventoryHome } = await import('../lib/inventory.mjs');
const { seal } = await import('../lib/manifest.mjs');
const BIN = path.join(process.env.AGENT_LOCK_HOME, 'bin');
const PS = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);
const ps = (command) =>
  execFileSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
  }).trim();
// A PowerShell literal. Its escape character is a backtick, so a JSON string would deliver
// doubled backslashes; single quotes take the text as written.
const psStr = (v) => `'${String(v).replace(/'/g, "''")}'`;
const ENV_KEY = "[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')";
// The STORED text, not the expanded text. That is the whole point of writing through the
// registry: someone else's %USERPROFILE% entry has to come back as %USERPROFILE%.
const userPath = () => ps(`[string]${ENV_KEY}.GetValue('Path','','DoNotExpandEnvironmentNames')`);
const setUserPath = (v) =>
  ps(`${ENV_KEY}.SetValue('Path', ${psStr(v)}, [Microsoft.Win32.RegistryValueKind]::ExpandString)`);
const PROBE = '%USERPROFILE%\\agent-lock-probe';

const step = (name, fn) => {
  process.stdout.write(`- ${name}\n`);
  fn();
};
const node = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });

const pathBefore = userPath();
let failed = 0;
try {
  // An unexpanded entry belonging to someone else, planted before install so the PATH write has
  // something to damage. [Environment]::SetEnvironmentVariable would flatten this to a literal
  // C:\Users\... and uninstall could not put it back.
  setUserPath([pathBefore, PROBE].filter(Boolean).join(';'));

  step('install writes the .cmd shim and the POSIX one Git Bash looks for, and no .ps1', () => {
    const r = node(['install']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    // install catches a PATH failure and prints why, so this is where a broken PATH script
    // names itself instead of turning into a puzzling assertion two steps later
    assert.ok(!/could not set PATH/.test(r.stdout), r.stdout);
    for (const f of ['claude.cmd', 'claude', 'codex.cmd', 'gemini.cmd'])
      assert.ok(fs.existsSync(path.join(BIN, f)), `missing shim ${f}\n${r.stderr}`);
    // a .ps1 answers to the execution policy, and Restricted is the Windows client default
    for (const f of ['claude.ps1', 'agent-lock.ps1'])
      assert.ok(!fs.existsSync(path.join(BIN, f)), `${f} should not be written any more`);
  });

  step('the shim directory is first on the user PATH', () => {
    const after = userPath();
    assert.equal(after.split(';')[0], BIN, `${BIN} is not first: ${after}`);
  });

  step('an unexpanded entry belonging to someone else survives the PATH write', () => {
    const after = userPath();
    assert.ok(after.split(';').includes(PROBE), `${PROBE} was flattened or lost: ${after}`);
    assert.equal(
      ps(`${ENV_KEY}.GetValueKind('Path')`),
      'ExpandString',
      'Path was written back as a plain string, which would freeze every %VAR% in it'
    );
  });

  // The gate reads the home config on every launch and there is no terminal here to record it
  // on, so record it the way a person would have before their first launch.
  seal(inventoryHome());

  // A stand-in `claude` that PATH finds after the shim, started from a folder with no agent
  // config of its own, so what is under test is the shim and not the fixture.
  const cwd = fs.mkdtempSync(path.join(tmp, 'checkout-'));
  const realDir = path.join(tmp, 'real');
  fakeTool(realDir, 'claude', "process.stdout.write('REAL ' + process.argv.slice(2).join(' ') + '\\n');\n");
  const env = { ...process.env, PATH: withPath(BIN, realDir, process.env.PATH) };
  const shells = [
    ['cmd.exe', 'cmd', ['/d', '/s', '/c', 'claude --hi there']],
    ['Windows PowerShell 5.1', 'powershell', ['-NoProfile', '-Command', 'claude --hi there']],
    ['PowerShell 7', 'pwsh', ['-NoProfile', '-Command', 'claude --hi there']],
    ['Git Bash', 'bash', ['-lc', 'claude --hi there']],
  ];
  for (const [label, file, args] of shells)
    step(`the gate runs and the tool starts from ${label}`, () => {
      const r = spawnSync(file, args, { cwd, encoding: 'utf8', env, timeout: 60000 });
      if (r.error?.code === 'ENOENT') {
        process.stdout.write(`  (${file} not on this runner, skipped)\n`);
        return;
      }
      assert.ok(r.stdout.includes('REAL --hi there'), `${label}: ${r.stdout}\n${r.stderr}`);
      assert.ok(/agent-lock/.test(r.stderr), `${label}: the gate printed nothing:\n${r.stderr}`);
    });

  step('a policy value in HKCU is read back as a managed settings file', () => {
    const key = 'HKCU\\SOFTWARE\\Policies\\ClaudeCode';
    const json = '{"hooks":{"SessionStart":[{"matcher":"*","hooks":[{"command":"whoami"}]}]}}';
    execFileSync('reg', ['add', key, '/v', 'Settings', '/t', 'REG_SZ', '/d', json, '/f'], {
      stdio: 'ignore',
    });
    try {
      const found = windowsPolicyEntries().find((e) => e.key?.includes('HKCU'));
      assert.ok(found, 'the HKCU policy value was not read back');
      assert.equal(found.text, json, `read back changed: ${found.text}`);
    } finally {
      execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
    }
  });

  step('uninstall removes every shim and the PATH entry it added', () => {
    const r = node(['uninstall']);
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['claude.cmd', 'claude.ps1', 'claude'])
      assert.ok(!fs.existsSync(path.join(BIN, f)), `${f} survived uninstall`);
    const after = userPath();
    assert.ok(!after.split(';').includes(BIN), `PATH still carries ${BIN}`);
    assert.ok(after.split(';').includes(PROBE), `uninstall lost ${PROBE}: ${after}`);
  });
} catch (e) {
  failed = 1;
  process.stdout.write(`\nFAILED: ${e.message}\n`);
} finally {
  if (userPath() !== pathBefore) setUserPath(pathBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed);
