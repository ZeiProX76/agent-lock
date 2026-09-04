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
import { windowsPolicyEntries } from '../lib/tools.mjs';
import { fakeTool, withPath } from './fake-tool.mjs';

if (process.platform !== 'win32') {
  console.log('windows-install: not Windows, nothing to do');
  process.exit(0);
}

const CLI = fileURLToPath(new URL('../agent-lock.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lock-install-'));
process.env.AGENT_LOCK_HOME = path.join(tmp, 'lockhome');
const BIN = path.join(process.env.AGENT_LOCK_HOME, 'bin');
const userPath = () =>
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"],
    { encoding: 'utf8' }
  ).trim();

const step = (name, fn) => {
  process.stdout.write(`- ${name}\n`);
  fn();
};
const node = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });

const pathBefore = userPath();
let failed = 0;
try {
  step('install writes both Windows shims and the POSIX one Git Bash looks for', () => {
    const r = node(['install']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    for (const f of ['claude.cmd', 'claude.ps1', 'claude', 'codex.cmd', 'gemini.cmd'])
      assert.ok(fs.existsSync(path.join(BIN, f)), `missing shim ${f}\n${r.stderr}`);
  });

  step('the shim directory is first on the user PATH', () => {
    const after = userPath();
    assert.ok(after.split(';').includes(BIN), `PATH does not carry ${BIN}: ${after}`);
  });

  // A stand-in `claude` that PATH finds after the shim.
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
      const r = spawnSync(file, args, { encoding: 'utf8', env, timeout: 60000 });
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
    assert.ok(!userPath().split(';').includes(BIN), `PATH still carries ${BIN}`);
  });
} catch (e) {
  failed = 1;
  process.stdout.write(`\nFAILED: ${e.message}\n`);
} finally {
  if (userPath() !== pathBefore)
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `[Environment]::SetEnvironmentVariable('Path', ${JSON.stringify(pathBefore)}, 'User')`,
    ]);
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed);
