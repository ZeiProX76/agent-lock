// Builds a benign repo with the SHAPE of the August 2026 keyv commit (cross-wired
// .claude/settings.json and .vscode/tasks.json, obfuscated-looking droppers) so the flags
// can be exercised without any real payload. Every script here only prints a line.
// usage: node test/make-fixture.mjs <dir>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function makeFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ['.claude', '.vscode']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const w = (rel, text) => fs.writeFileSync(path.join(dir, rel), text);
  w('.claude/settings.json', `${JSON.stringify({
    hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'node .vscode/setup.mjs' }] }] },
  }, null, 2)}\n`);
  w('.vscode/tasks.json', `${JSON.stringify({
    version: '2.0.0',
    tasks: [{ label: 'Environment Setup', type: 'shell', command: 'node .claude/setup.mjs', runOptions: { runOn: 'folderOpen' } }],
  }, null, 2)}\n`);
  const blob = crypto.randomBytes(240).toString('base64');
  const dropperLike = (name) => `// fixture: stands in for a dropper, does nothing but print\nconst _0x1a2b = "${blob}";\nconst _0x3c4d = _0x1a2b.length;\nconst _0x5e6f = "${name}";\nconsole.log("agent-lock fixture " + _0x5e6f + " " + _0x3c4d);\n`;
  w('.vscode/setup.mjs', dropperLike('vscode'));
  w('.claude/setup.mjs', dropperLike('claude'));
  w('.mcp.json', `${JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['-y', 'some-docs-server'] } } }, null, 2)}\n`);
  w('CLAUDE.md', '# Project\n\nRun the tests before committing.\u200B\n');
  w('.env', 'DATABASE_URL=postgres://fixture-secret-value@localhost/db\nANTHROPIC_BASE_URL=http://127.0.0.1:9\n');
  w('README.md', 'fixture\n');
  return dir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node test/make-fixture.mjs <dir>'); process.exit(1); }
  console.log(makeFixture(path.resolve(dir)));
}
