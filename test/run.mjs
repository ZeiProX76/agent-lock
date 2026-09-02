// End-to-end checks against a benign fixture. Runs with its own AGENT_LOCK_HOME, never touches
// ~/.agent-lock. usage: node test/run.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFixture } from './make-fixture.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lock-test-'));
process.env.AGENT_LOCK_HOME = path.join(tmp, 'lockhome');
const repo = fs.realpathSync(makeFixture(path.join(tmp, 'fixture')));
const CLI = path.resolve(new URL('../agent-lock.mjs', import.meta.url).pathname);
const { compare, inventoryCheckout, seal, sealedEntry, snapshotDir } = await import('../lib/inventory.mjs');
const { parseToml } = await import('../lib/toml.mjs');
const { semanticDiff } = await import('../lib/semantic.mjs');
const { claudeGlobalProjection } = await import('../lib/tools.mjs');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const cli = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'], input: opts.input || '' });
const edit = (rel, fn) => fs.writeFileSync(path.join(repo, rel), fn(fs.readFileSync(path.join(repo, rel), 'utf8')));

test('kinds: referenced droppers are hot scripts, .env is secret', () => {
  const inv = inventoryCheckout(repo);
  const kind = (rel) => inv.files.find((f) => f.rel === rel)?.kind;
  assert.equal(kind('.vscode/setup.mjs'), 'script');
  assert.equal(kind('.claude/setup.mjs'), 'script');
  assert.equal(kind('.claude/settings.json'), 'claude-settings');
  assert.equal(kind('.vscode/tasks.json'), 'vscode-tasks');
  assert.equal(inv.files.find((f) => f.rel === '.env').secret, true);
});

test('flags: the keyv shape trips the expected sentences', () => {
  const { flags } = inventoryCheckout(repo);
  for (const needle of ['SessionStart hook with matcher "*"', '.claude → .vscode cross-reference', '.vscode → .claude cross-reference',
    'runOn: folderOpen', 'obfuscated identifiers', 'unbroken blob', 'npx some-docs-server with no version pin',
    'CLAUDE.md: 1 invisible', '.env: sets ANTHROPIC_BASE_URL']) {
    assert.ok(flags.some((f) => f.includes(needle)), `missing flag: ${needle}\n${flags.join('\n')}`);
  }
});

test('seal then verify: exit 0, snapshot holds no .env value', () => {
  seal(inventoryCheckout(repo));
  assert.equal(cli(['verify']).status, 0);
  const files = fs.readdirSync(snapshotDir(repo), { recursive: true }).map(String);
  const all = files.filter((f) => fs.statSync(path.join(snapshotDir(repo), f)).isFile()).map((f) => fs.readFileSync(path.join(snapshotDir(repo), f), 'utf8')).join('\n');
  assert.ok(!all.includes('fixture-secret-value'), 'env value leaked into snapshot');
  assert.ok(all.includes('DATABASE_URL'), 'env key names should be kept');
  assert.equal(fs.statSync(path.join(process.env.AGENT_LOCK_HOME, 'manifest.json')).mode & 0o777, 0o600);
});

test('doc edit is minor: verify exit 0, compare not hot', () => {
  edit('CLAUDE.md', (t) => `${t}\nMore notes.\n`);
  const inv = inventoryCheckout(repo);
  const cmp = compare(sealedEntry(inv), inv);
  assert.equal(cmp.hot, false);
  assert.equal(cmp.changed.length, 1);
  assert.equal(cli(['verify']).status, 0);
  seal(inv);
});

test('hook command change is hot with the exact key', () => {
  edit('.claude/settings.json', (t) => t.replace('node .vscode/setup.mjs', 'node .vscode/setup.mjs --quiet'));
  const inv = inventoryCheckout(repo);
  const cmp = compare(sealedEntry(inv), inv);
  assert.equal(cmp.hot, true);
  const c = cmp.changed.find((x) => x.file.rel === '.claude/settings.json');
  assert.ok(c.changes.some((k) => k.hot && k.key === 'hooks.SessionStart[0].hooks[0].command'), JSON.stringify(c.changes));
  assert.equal(cli(['verify']).status, 1);
  seal(inv);
});

test('permissions.allow: a scoped Bash rule is minor, Bash(*) is hot', () => {
  const file = '.claude/settings.local.json';
  fs.writeFileSync(path.join(repo, file), JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } }));
  let inv = inventoryCheckout(repo);
  assert.equal(compare(sealedEntry(inv), inv).hot, false, 'new local settings with a scoped rule should be minor');
  seal(inv);
  fs.writeFileSync(path.join(repo, file), JSON.stringify({ permissions: { allow: ['Bash(npm test:*)', 'Bash(*)'] } }));
  inv = inventoryCheckout(repo);
  const cmp = compare(sealedEntry(inv), inv);
  assert.equal(cmp.hot, true);
  assert.ok(cmp.newFlags.some((f) => f.includes('Bash(*)')));
  fs.rmSync(path.join(repo, file));
  seal(inventoryCheckout(repo));
});

test('script edit is hot, mcp url change is hot, mcp reorder is not', () => {
  edit('.vscode/setup.mjs', (t) => `${t}// tail\n`);
  let inv = inventoryCheckout(repo);
  assert.ok(compare(sealedEntry(inv), inv).changed.find((c) => c.file.rel === '.vscode/setup.mjs').hot);
  seal(inv);
  edit('.mcp.json', () => JSON.stringify({ mcpServers: { docs: { args: ['-y', 'some-docs-server'], command: 'npx' } } }));
  inv = inventoryCheckout(repo);
  assert.equal(compare(sealedEntry(inv), inv).hot, false, 'key order is not a change');
  edit('.mcp.json', () => JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['-y', 'some-docs-server@1.2.3'] } } }));
  inv = inventoryCheckout(repo);
  assert.equal(compare(sealedEntry(inv), inv).hot, true);
  seal(inv);
});

test('toml: codex trust_level flip is hot', () => {
  const a = parseToml('[projects."/x/y"]\ntrust_level = "untrusted"\n');
  const b = parseToml('[projects."/x/y"]\ntrust_level = "trusted"\n[projects."/x/z"]\ntrust_level = "trusted"\n');
  const d = semanticDiff('codex-config', a, b);
  assert.ok(d.every((c) => c.hot) && d.length === 2, JSON.stringify(d));
});

test('claude.json projection ignores noise, keeps trust', () => {
  const p = claudeGlobalProjection(JSON.stringify({ numStartups: 99, projects: { '/r': { hasTrustDialogAccepted: true, history: [1, 2], mcpServers: {} } } }));
  assert.deepEqual(Object.keys(p.projects['/r']).sort(), ['enableAllProjectMcpServers', 'enabledMcpjsonServers', 'mcpServers', 'trusted']);
  assert.equal(p.projects['/r'].trusted, true);
});

test('gate without a terminal: skip works, unsealed refuses, dangerous flag refuses', () => {
  const fakeBin = path.join(tmp, 'fakebin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\necho fake claude\n', { mode: 0o755 });
  const env = { PATH: `${fakeBin}:${process.env.PATH}` };
  const skip = cli(['gate', 'claude', '--'], { env: { ...env, AGENT_LOCK_SKIP: '1' } });
  assert.equal(skip.status, 0);
  assert.equal(skip.stdout.split('\n')[0], path.join(fakeBin, 'claude'));
  assert.equal(skip.stdout.split('\n')[1], 'skipped');
  const fresh = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'fresh-')));
  fs.mkdirSync(path.join(fresh, '.claude'));
  fs.writeFileSync(path.join(fresh, '.claude', 'settings.json'), '{"hooks":{}}');
  const unsealed = spawnSync(process.execPath, [CLI, 'gate', 'claude', '--'], { cwd: fresh, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.ok(unsealed.status === 2 || unsealed.status === 1, `expected refusal, got ${unsealed.status}`);
  assert.equal(unsealed.stdout, '');
  const danger = cli(['gate', 'claude', '--', '--dangerously-skip-permissions'], { env });
  assert.equal(danger.status, 1);
  assert.ok(danger.stderr.includes('refusing'));
  const allowed = cli(['gate', 'claude', '--', '--dangerously-skip-permissions'], { env: { ...env, AGENT_LOCK_ALLOW_NONINTERACTIVE: '1', AGENT_LOCK_SKIP: '1' } });
  assert.equal(allowed.status, 0);
});

test('report prints hashes and flags to stdout', () => {
  const r = cli(['report']);
  assert.equal(r.status, 0);
  assert.ok(/^[0-9a-f]{64}\s+\d+\s+claude-settings\s+\.claude\/settings\.json$/m.test(r.stdout));
  assert.ok(r.stdout.includes('pinned, not vouched for.'));
});

console.log(`\n${passed} tests passed  (${tmp})`);
fs.rmSync(tmp, { recursive: true, force: true });
