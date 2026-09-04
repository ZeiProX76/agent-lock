// The interactive layer: the menu inside a real pty, and the checker against a stand-in model.
// Own AGENT_LOCK_HOME and fixture, never touches ~/.agent-lock.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeTool, withPath } from './fake-tool.mjs';
import { makeFixture } from './make-fixture.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lock-ui-test-'));
process.env.AGENT_LOCK_HOME = path.join(tmp, 'lockhome');
const repo = fs.realpathSync(makeFixture(path.join(tmp, 'fixture')));
// URL.pathname is "/D:/a/…" on Windows and path.resolve makes that "D:\\D:\\a\\…".
const CLI = fileURLToPath(new URL('../agent-lock.mjs', import.meta.url));
const { parseVerdict } = await import('../lib/check.mjs');
const { readKey } = await import('../lib/ui.mjs');

const cli = (args, opts = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    input: '',
  });

test('menu keys and model verdicts decode', () => {
  assert.equal(readKey('\x1b[A'), 'up');
  assert.equal(readKey('\x1bOB'), 'down');
  assert.equal(readKey('\r'), 'enter');
  assert.equal(readKey('\x03'), 'escape');
  assert.equal(readKey(''), 'eof');
  assert.equal(readKey('Y'), 'y');
  assert.deepEqual(parseVerdict('**CLEAR**\n'), { verdict: 'clear', note: '' });
  assert.deepEqual(parseVerdict('NO: `.vscode/setup.mjs` downloads and runs code.'), {
    verdict: 'no',
    note: '.vscode/setup.mjs downloads and runs code.',
  });
  assert.equal(parseVerdict('No.\nThe hook runs a dropper.').note, 'The hook runs a dropper.');
  assert.equal(parseVerdict('I cannot help with that.').verdict, 'unclear');
});

// A stand-in model: records how it was called, answers per FAKE_VERDICT, and behaves like a tool
// that honours the folder it starts in. If its cwd holds agent config it "fires the hook" into
// FAKE_CANARY, so a checker that ever ran inside a checkout would leave a trace.
function fakeModel(dir) {
  const body = (name) => `import fs from 'node:fs';
const argv = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
fs.writeFileSync(
  process.env.FAKE_RECORD,
  'tool: ${name}\\n' +
    'argv: ' + argv.join(' ') + '\\n' +
    'cwd: ' + process.cwd() + '\\n' +
    'ls: [' + fs.readdirSync(process.cwd()).join(' ') + ']\\n' +
    'skip: ' + (process.env.AGENT_LOCK_SKIP || '') + ' launch=' + (process.env.AGENT_LOCK_LAUNCH || '') + '\\n' +
    'node_options: [' + (process.env.NODE_OPTIONS || '') + ']\\n' +
    stdin
);
if (fs.existsSync('.claude') || fs.existsSync('.mcp.json'))
  fs.appendFileSync(process.env.FAKE_CANARY, 'fired\\n');
if (process.env.FAKE_VERDICT === 'fail') {
  process.stderr.write('boom\\n');
  process.exit(3);
}
const answer =
  process.env.FAKE_VERDICT === 'no'
    ? 'NO\\n.vscode/setup.mjs is an obfuscated dropper started by the SessionStart hook.'
    : '**CLEAR**';
const o = argv.indexOf('-o');
if (o >= 0 && argv[o + 1]) fs.writeFileSync(argv[o + 1], answer + '\\n');
process.stdout.write(answer + '\\n');
`;
  for (const name of ['claude', 'codex']) fakeTool(dir, name, body(name));
  return dir;
}

test('check: the model reads from an empty folder, as the launched tool, never a secret value', () => {
  const record = path.join(tmp, 'check-record.txt');
  const canary = path.join(tmp, 'canary.txt');
  const env = {
    PATH: withPath(fakeModel(path.join(tmp, 'modelbin')), process.env.PATH),
    FAKE_RECORD: record,
    FAKE_CANARY: canary,
    NODE_OPTIONS: '--max-old-space-size=4096',
  };
  const logFile = path.join(process.env.AGENT_LOCK_HOME, 'log');
  const skips = () => (fs.readFileSync(logFile, 'utf8').match(/\tskip\t/g) || []).length;

  const clear = cli(['check'], { env: { ...env, FAKE_VERDICT: 'clear' } });
  assert.equal(clear.status, 0, clear.stderr);
  assert.ok(clear.stderr.includes('claude (opus): clear'), clear.stderr);
  const rec = fs.readFileSync(record, 'utf8');
  assert.ok(
    /--restricted --tools {2}--strict-mcp-config --no-session-persistence --settings \S*no-hooks\.json --model opus/.test(
      rec
    ),
    rec
  );
  // The invariant: never started in the checkout, and the checkout is never even an argument.
  const cwdLine = /^cwd: (.*)$/m.exec(rec)[1];
  assert.ok(!cwdLine.startsWith(repo), `the model must never run inside the checkout: ${cwdLine}`);
  // The only thing in the folder is the settings file agent-lock writes to switch hooks off.
  assert.ok(
    /^ls: \[(no-hooks\.json)?\]$/m.test(rec),
    `the folder it runs in holds nothing but our own settings file:\n${rec}`
  );
  assert.ok(!rec.split('\n')[1].includes(repo), 'the checkout path is never an argument');
  assert.ok(
    !/argv:.*[{}]/.test(rec),
    `no argument may carry JSON: a Windows .cmd re-parses its command line\n${rec}`
  );
  assert.ok(!fs.existsSync(canary), 'a tool that honours its cwd must find nothing to fire');
  assert.ok(rec.includes('node_options: []'), 'NODE_OPTIONS must be cleared for the checker');
  assert.ok(rec.includes('skip: check launch=\n'), 'launch-chain variables must not leak in');
  assert.ok(
    rec.includes('===== .claude/settings.json (claude-settings) =====') &&
      rec.includes('node .vscode/setup.mjs')
  );
  assert.ok(rec.includes('SessionStart hook with matcher "*"'), 'flags travel with the files');
  assert.ok(!rec.includes('fixture-secret-value') && rec.includes('DATABASE_URL'), '.env: key names only');

  // Launch codex, codex reads: its own flags, its own empty folder.
  const codex = cli(['check', '--codex'], { env: { ...env, FAKE_VERDICT: 'clear' } });
  assert.equal(codex.status, 0, codex.stderr);
  assert.ok(codex.stderr.includes('codex: clear') && !codex.stderr.includes('claude'), codex.stderr);
  const crec = fs.readFileSync(record, 'utf8');
  assert.ok(crec.startsWith('tool: codex'), crec);
  assert.ok(
    crec.includes(
      'exec --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules -s read-only -C '
    ),
    crec
  );
  assert.ok(!crec.split('\n')[1].includes(repo), 'codex is pointed at the empty folder');
  assert.ok(!fs.existsSync(canary), 'codex must not be started in the checkout either');

  const no = cli(['check'], { env: { ...env, FAKE_VERDICT: 'no' } });
  assert.equal(no.status, 1);
  assert.ok(no.stderr.includes('no. .vscode/setup.mjs is an obfuscated dropper'), no.stderr);
  assert.equal(cli(['check'], { env: { ...env, FAKE_VERDICT: 'fail' } }).status, 1);
  const log = fs.readFileSync(logFile, 'utf8');
  assert.ok(log.includes('\tcheck\t') && log.includes('claude (opus) no .vscode'), log);
  const before = skips();
  const pass = cli(['gate', 'claude', '--'], { env: { ...env, AGENT_LOCK_SKIP: 'check' } });
  assert.equal(pass.stdout.split('\n')[1], 'check');
  assert.equal(skips(), before, "the checker's own launch is not a logged skip");
});

// The pty driver lives in test/pty-driver.py: it forks a pty on POSIX and opens a ConPTY through
// pywinpty on Windows, types on a schedule, and prints everything the program drew plus its exit
// code. `pip install pywinpty` is what turns the Windows half on; without it that test skips.
const PY = process.platform === 'win32' ? 'python' : 'python3';
const DRIVER = fileURLToPath(new URL('./pty-driver.py', import.meta.url));
const hasModule = (m) => spawnSync(PY, ['-c', `import ${m}`], { stdio: 'ignore' }).status === 0;
const noPty =
  process.platform === 'win32'
    ? hasModule('winpty')
      ? false
      : 'needs pywinpty for a ConPTY'
    : hasModule('pty')
      ? false
      : 'needs python3 for a pty';
// colours out: assertions match on what a reader sees, not on escape sequences
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the thing being stripped
const readable = (r) => `${r.stdout}\n[stderr] ${r.stderr}`.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

test('menu: arrows and Enter pick, a letter picks directly, Ctrl-C quits and restores the terminal', {
  skip: process.platform === 'win32' ? 'this one drives sh and reads stty back; ConPTY has its own' : noPty,
}, () => {
  const dir = makeFixture(path.join(tmp, 'menu-fixture'));
  const run = (keys, cmd, cols = 0) => {
    const r = spawnSync(PY, [DRIVER, JSON.stringify(keys), '--', 'sh', '-c', cmd], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, TERM: 'xterm', PTY_COLS: String(cols) },
      timeout: 45000,
    });
    return readable(r);
  };
  const node = `"${process.execPath}" "${CLI}"`;
  // the cursor starts on the checker; one up is the accept line
  const up = run(
    [
      [1.5, '\x1b[A'],
      [0.3, '\r'],
    ],
    `${node} seal`
  );
  assert.ok(up.includes('❯ yes · records their fingerprints') && up.includes('recorded 7 files'), up);
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(*)"]}}');
  const quit = run(
    [
      [1.5, '\x1b[B'],
      [0.2, '\x1b[B'],
      [0.2, '\x1b[B'],
      [0.3, '\r'],
    ],
    `${node} approve; echo "code=$?"`
  );
  assert.ok(
    quit.includes('❯ quit without recording') && quit.includes('code=1') && !quit.includes('recorded '),
    quit
  );
  // [l] prints the list the inventory no longer dumps, then returns to the menu
  const listed = run(
    [
      [1.5, 'l'],
      [1.5, 'q'],
    ],
    `${node} approve`
  );
  // With changes on screen, [l] spells out the changes; the short screen above stays short.
  assert.ok(listed.includes('new file .claude/settings.local.json'), listed);
  assert.ok(!listed.includes('○ CLAUDE.md'), `unchanged files do not belong in a change list:\n${listed}`);
  const letters = run(
    [
      [1.5, 'i'],
      [1.5, 'a'],
    ],
    `${node} approve`
  );
  assert.ok(
    letters.includes('--- .claude/settings.local.json') && letters.includes('recorded 8 files'),
    letters
  );
  // A 40-column terminal: labels are cut to fit, so no line wraps and the redraw stays aligned.
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{"hooks":{"SessionStart":[]}}');
  const narrow = run(
    [
      [1.5, '\x1b[A'],
      [0.3, '\r'],
    ],
    `${node} approve`,
    40
  );
  assert.ok(narrow.includes('recorded '), narrow);
  assert.ok(narrow.includes('…'), `nothing was cut to fit 40 columns:\n${narrow}`);
  const menuLines = narrow.split('\n').filter((l) => /\[[yaciqls]\]/.test(l));
  assert.ok(menuLines.length > 0, narrow);
  for (const l of menuLines) assert.ok(l.replace(/\s+$/, '').length <= 40, `wraps at 40 cols: ${l}`);

  // A terminal that cannot do raw mode (busybox stty has no -g) drops to the one-letter menu.
  fs.writeFileSync(
    path.join(dir, '.claude', 'settings.local.json'),
    '{"permissions":{"allow":["Bash(ls)"]}}'
  );
  const plain = run([[1.5, 'a\r']], `AGENT_LOCK_NO_RAW=1 ${node} approve`);
  assert.ok(plain.includes('[a] yes ·'), `no fallback menu:\n${plain}`);
  assert.ok(plain.includes('recorded '), `the fallback menu did not accept a letter:\n${plain}`);

  fs.rmSync(path.join(dir, '.claude', 'settings.local.json'));
  const ctrlC = run([[1.5, '\x03']], `${node} approve; echo "code=$?"; stty -a`);
  assert.ok(ctrlC.includes('code=1'), ctrlC);
  assert.ok(
    /(^|\s)icanon/.test(ctrlC) && /(^|\s)echo\b/.test(ctrlC) && !/-icanon/.test(ctrlC),
    `tty not restored:\n${ctrlC}`
  );
});

test('windows: the menu inside a ConPTY, arrows, a letter, Ctrl-C and the fallback', {
  skip: process.platform === 'win32' ? noPty : 'ConPTY only exists on Windows',
}, () => {
  const dir = makeFixture(path.join(tmp, 'menu-conpty'));
  const settings = path.join(dir, '.claude', 'settings.local.json');
  // AGENT_LOCK_ASCII=0 keeps the drawn marks, so this reads the same as the POSIX test above.
  const run = (keys, args, env = {}) => {
    // Started from tmp, not from the fixture: Windows will not remove a directory that is any
    // live process's working directory, and the console host outlives the child by a moment.
    const r = spawnSync(PY, [DRIVER, JSON.stringify(keys), '--', process.execPath, CLI, ...args, dir], {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, AGENT_LOCK_ASCII: '0', PTY_COLS: '120', ...env },
      timeout: 60000,
    });
    return readable(r);
  };
  // the cursor starts on the checker; one up is the accept line
  const up = run(
    [
      [1.5, '\x1b[A'],
      [0.3, '\r'],
    ],
    ['seal']
  );
  assert.ok(up.includes('❯ yes · records their fingerprints'), `no arrow menu in a ConPTY:\n${up}`);
  assert.ok(up.includes('recorded 7 files'), up);

  fs.writeFileSync(settings, '{"permissions":{"allow":["Bash(*)"]}}');
  const letter = run([[1.5, 'a']], ['approve']);
  assert.ok(letter.includes('recorded 8 files'), `a letter must pick directly:\n${letter}`);

  fs.writeFileSync(settings, '{"permissions":{"allow":["Bash(ls)"]}}');
  const ctrlC = run([[1.5, '\x03']], ['approve']);
  assert.ok(ctrlC.includes('[exit 1]'), `Ctrl-C must quit without recording:\n${ctrlC}`);
  assert.ok(!ctrlC.includes('recorded '), ctrlC);

  const plain = run([[1.5, 'a\r']], ['approve'], { AGENT_LOCK_NO_RAW: '1' });
  assert.ok(plain.includes('[a] yes ·'), `no fallback menu:\n${plain}`);
  assert.ok(plain.includes('recorded '), plain);
});

after(() => {
  // Windows releases a handle a beat after the process holding it is gone, so a temp tree can
  // still be busy here. Retry, and if it is still busy say so rather than fail a passing suite.
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    process.stderr.write(`could not remove ${tmp}: ${e.code}\n`);
  }
});
