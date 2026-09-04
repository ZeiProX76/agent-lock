#!/usr/bin/env node
// agent-lock: the trust prompt asks whether you trust a folder, once, blind. This pins the exact
// agent config files (Claude Code, Codex, Gemini, plus the VS Code / Cursor files next to them),
// shows you what is in them, and asks again the moment any of them change.
// Zero dependencies. Node 18+. MIT.
import {
  check,
  explain,
  hook,
  report,
  rootOf,
  scan,
  sealInteractive,
  status,
  verify,
} from './lib/commands.mjs';
import { EXIT } from './lib/exit-codes.mjs';
import { gate, launch } from './lib/gate.mjs';
import { install, uninstall } from './lib/install.mjs';
import { inventoryCheckout, inventoryHome } from './lib/inventory.mjs';
import { sealedEntry } from './lib/manifest.mjs';
import { LOCK_HOME } from './lib/tools.mjs';
import { out, red } from './lib/ui.mjs';

const HELP = `agent-lock, pin the files your coding agents obey

  agent-lock scan                 first run: every folder Claude / Codex / Gemini already trust, inventoried, then pinned by you
  agent-lock seal [path]          pin the agent config of one checkout (default: current folder)
  agent-lock verify [path]        exit 0 unchanged, 1 changed, 2 never pinned
  agent-lock diff [path]          what changed since the pin, hot lines first
  agent-lock approve [path]       review the diff, then re-pin
  agent-lock report [path]        paths, hashes and flags as plain text, shareable
  agent-lock check [path]         one word from the model, no tools, from an empty folder: clear, or no + one sentence
                                  (--codex / --gemini ask that tool instead; AGENT_LOCK_CHECK_MODEL picks the model)
  agent-lock explain [path]       the long version of check: what would run, when, in plain words
  agent-lock home                 the home-level config every launch reads
  agent-lock status               everything pinned on this machine
  agent-lock install [--strict]   PATH shims for claude / codex / gemini, git hooks, pin home
  agent-lock uninstall

  env: AGENT_LOCK_SKIP=1 bypasses one launch (logged); AGENT_LOCK_ALLOW_NONINTERACTIVE=1 allows
  --dangerously-* flags with no terminal attached. State: ${LOCK_HOME}
`;

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flags = new Set(argv.slice(1).filter((a) => a.startsWith('--')));
const target = argv.slice(1).find((a) => !a.startsWith('--'));
const targetRoot = () => (target === 'home' ? 'home' : rootOf(target));

const COMMANDS = {
  help: () => {
    process.stdout.write(HELP);
    return EXIT.OK;
  },
  scan,
  status,
  install: async () => {
    await install({ strict: flags.has('--strict') });
    return EXIT.OK;
  },
  uninstall: () => {
    uninstall();
    return EXIT.OK;
  },
  seal: () => {
    const inv = inventoryCheckout(rootOf(target));
    return sealInteractive(inv, sealedEntry(inv));
  },
  home: () => {
    const inv = inventoryHome();
    return sealInteractive(inv, sealedEntry(inv));
  },
  verify: () =>
    verify(targetRoot(), {
      quiet: flags.has('--quiet'),
      hook: [...flags].some((f) => f.startsWith('--hook')),
    }),
  diff: () => verify(targetRoot()),
  approve: () => {
    const inv = target === 'home' ? inventoryHome() : inventoryCheckout(rootOf(target));
    return sealInteractive(inv, sealedEntry(inv));
  },
  report: () => report(targetRoot()),
  check: () =>
    check(targetRoot(), flags.has('--codex') ? 'codex' : flags.has('--gemini') ? 'gemini' : 'claude'),
  explain: () => explain(rootOf(target)),
  gate: () => gate(argv[1], argv.slice(argv.indexOf('--') + 1)),
  launch: () => launch(argv[1], argv.slice(argv.indexOf('--') + 1)),
  hook: () => hook(argv[1]),
};

async function main() {
  const command = COMMANDS[cmd];
  if (!command) {
    out(red(`unknown command: ${cmd}`), HELP);
    return 1;
  }
  try {
    return await command();
  } catch (e) {
    out(red(`agent-lock: ${e.message}`));
    return cmd === 'gate' || cmd === 'launch' ? EXIT.CHANGED : EXIT.ERROR;
  }
}

process.exit(await main());
