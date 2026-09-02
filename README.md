# agent-lock

The trust prompt asks whether you trust a folder. Once, blind.
agent-lock asks whether you trust **these exact files**, shows you what is in them, and asks again the moment any of them change.

```
$ claude

3 changes in ~/work/keyv since you trusted it (Aug 30)
   ✗ .claude/settings.json
       ~ hooks.SessionStart[0].hooks[0].command: "npm run lint" → "node .vscode/setup.mjs"
   ✗ new file .vscode/setup.mjs  84 KB  (runs or configures something)
   ⚠ new: .claude/settings.json: SessionStart hook with matcher "*" (fires on every start, resume, clear and compact)
   ⚠ new: .claude/settings.json: "node .vscode/setup.mjs" runs a file inside .vscode/ (.claude → .vscode cross-reference)
   ⚠ new: .vscode/setup.mjs: obfuscated identifiers (_0x…), 212 occurrences
   ⚠ new: .vscode/setup.mjs: encoded or unbroken blob of 61440 characters
Files changed since you trusted them. [a]pprove [i]nspect [s]afe mode [q]uit
```

That is the shape of the commit that hit the keyv repositories on 4 August 2026: a `.claude/settings.json` hook and a `.vscode/tasks.json` task, cross-wired, each launching a dropper hidden in the other tool's folder. `git pull`, open the folder, type `claude`, done. The trust dialog had been clicked months earlier.

Zero dependencies, one `node` file plus a `lib/`, MIT. macOS and Linux.

## What it covers

| Tool | In the repo | In your home |
|---|---|---|
| Claude Code | `.claude/**`, `.mcp.json`, `CLAUDE.md` | `~/.claude/settings.json`, `~/.claude.json` (trust map + MCP approvals), enabled plugin hooks, managed settings |
| Codex CLI | `.codex/**`, `AGENTS.md` | `~/.codex/config.toml` (trust map + hook trust), `~/.codex/hooks.json` |
| Gemini CLI | `.gemini/**`, `GEMINI.md`, `.env` (key names only) | `~/.gemini/settings.json`, `~/.gemini/trustedFolders.json` |
| VS Code / Cursor | `.vscode/**`, `.cursor/**` | `~/.cursor/mcp.json`, `~/.cursor/hooks.json` |

Plus every file a hook, task or MCP command points at. Symlinks: the target is hashed, a target outside the repo is a flag.

## Install

```sh
git clone https://github.com/ZeiProX76/agent-lock ~/agent-lock
node ~/agent-lock/agent-lock.mjs install
# open a new terminal
agent-lock scan
```

`install` writes three shims (`claude`, `codex`, `gemini`) into `~/.agent-lock/bin/`, adds a PATH line and three aliases to your `.zshrc` / `.bashrc`, installs a global git hook dispatcher (`post-merge` / `post-checkout` warn, every hook name still falls through to the repo's own `.git/hooks`), and pins your home config after showing it to you. `agent-lock uninstall` reverses all of it.

`scan` reads the three trust maps, inventories every folder any of the tools already trusts, and pins the clean ones in one answer. Flagged folders are shown one by one.

Optional backstop inside Claude Code (blocks a mid-session settings edit that adds something that runs, and warns when a session skipped the gate):

```sh
claude plugin marketplace add ZeiProX76/agent-lock
claude plugin install agent-lock@agent-lock
```

## Every launch

Typing `claude`, `codex` or `gemini` runs the check first, then execs the real binary.

1. **Never pinned** → inventory + flags → `Trust these N files exactly as they are? [y]es [i]nspect [s]afe mode [q]uit`
2. **Pinned, unchanged** → `agent-lock ok · 7 files · trusted Aug 30` → launches
3. **Something that runs changed** → red semantic diff → `[a]pprove [i]nspect [s]afe mode [q]uit`
4. **Your home config changed** → shown first (`+1 SessionStart hook in ~/.claude/settings.json`)
5. **Trusted by a tool, never by you** → said out loud on the first pin
6. **`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` / `--yolo` with no terminal attached** → refused and logged. That is how the Nx s1ngularity payload drove agents. `AGENT_LOCK_ALLOW_NONINTERACTIVE=1` if the automation is yours.

Minor changes (a doc, a skill, a scoped `Bash(npm test:*)` permission, a key reorder) print one dim line and get re-pinned. A nag on every launch trains a blind `y`; the gate only stops for things that execute, connect, or grant.

**Safe mode** launches without the project config: Claude Code with `--setting-sources user` (verified). Codex is best effort: `-c projects."<cwd>".trust_level="untrusted" -s read-only -a untrusted`; Codex has no documented per-launch "ignore `.codex/`" flag, and `codex exec` in 0.152.0 writes `trust_level = "trusted"` for the folder into `~/.codex/config.toml` on its own, which agent-lock then reports as a home change ("trusted by Codex, never by you"). Gemini has no per-launch flag, answer "do not trust" in its own prompt.

## What blocks, what is dim

Blocks (asks): hooks, MCP `command` / `args` / `url` / `env`, `env`, `apiKeyHelper` and the other helper commands, `statusLine.command`, `permissions.defaultMode`, `permissions.additionalDirectories`, `Bash(*)`-style allow rules, `enableAllProjectMcpServers`, `disableAllHooks`, `sandbox.*`, plugin enablement, `.vscode/tasks.json` (all of it), Cursor `mcp.json` / `hooks.json`, Codex `hooks`, `mcp_servers`, `trust_level`, `notify`, `model_providers`, Gemini `hooks`, `mcpServers`, `tools.*`, `security.*`, any file a command points at, any new flag.

Dim (shown, re-pinned): everything else. `CLAUDE.md`, skills, rules, scoped permission rules, MCP approvals you clicked, `model`, key order.

## Flags

Deterministic sentences, no score:

- hook or task runs a file inside another tool's dotfolder (`.claude` ↔ `.vscode` cross-reference) or outside the repo
- `SessionStart` hook with `matcher: "*"`
- `.vscode` task with `runOn: folderOpen`
- obfuscated identifiers (`_0x…`), encoded or unbroken blobs, `\x` escape runs
- file over 100 KB inside a dotfolder (images and media excluded)
- download-then-run: `curl | sh`, `Invoke-WebRequest`, fetch-then-spawn, decode-then-eval
- `env` setting `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `PATH`, `*_PROXY`, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`
- `permissions.allow` containing `Bash(*)` / bare `Bash`
- MCP server on `npx -y <package>` with no version pin
- `package.json` with a `preinstall` / `postinstall` inside a dotfolder
- zero-width or bidi characters in `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/*`, any config (Rules File Backdoor)
- repo settings with `disableAllHooks: true`, `defaultMode: bypassPermissions`, Codex `approval_policy = "never"` / `sandbox_mode = "danger-full-access"`
- `node_modules/<pkg>` shipping a `.claude/` / `.cursor/` / `.vscode/` folder

Run against the published contents of the August 2026 keyv commit, six fire: the `*` matcher, both cross-references, `folderOpen`, the `_0x` identifiers, and a 727 KB payload inside `.claude/`. A flag is a sentence to read, not a verdict.

## Commands

```
agent-lock scan                 first run: every folder your tools already trust, inventoried, pinned by you
agent-lock seal [path]          pin one checkout
agent-lock verify [path]        exit 0 unchanged, 1 changed, 2 never pinned  (what the git hook runs)
agent-lock diff [path]          what changed since the pin, hot lines first
agent-lock approve [path]       review, then re-pin
agent-lock report [path]        paths, hashes, commands, flags, plain text
agent-lock explain [path]       hand the flagged files to `claude -p --restricted --tools ""` from an empty folder
agent-lock home                 the user-level config every launch reads
agent-lock status               everything pinned on this machine
agent-lock install [--strict]   shims, rc lines, git hooks, pin home. --strict prints the managed-settings recipe
agent-lock uninstall
```

State: `~/.agent-lock/manifest.json` (0600), `snapshots/` (copies of pinned text files, `.env` keys only, never values), `log` (every seal, approval, refusal, skip). `AGENT_LOCK_SKIP=1` bypasses one launch and is logged.

## Verify what you installed

```sh
cd ~/agent-lock && shasum -a 256 -c SHA256SUMS
```

## Limits, stated

- **First clone is blind.** A pin records what is there; it does not vouch for it. The flags help you read, they do not decide.
- **Same privilege.** Code already running as you can rewrite `~/.agent-lock/manifest.json`. This raises the bar, it is not a security boundary.
- **Launchers that skip the shell skip the shim.** The IDE extension, a GUI bundle, `npx`, a binary called by absolute path. The plugin's `SessionStart` hook warns in that case; it cannot block.
- **`npm install` runs `preinstall` before anything here runs.**
- **What a hook resolves outside the repo cannot be pinned** beyond flagging the path.
- **VS Code, Cursor, Codex and Gemini are detected, not gated.** Their own fingerprinting covers hooks (Codex pins hook definitions, Gemini fingerprints project hooks); MCP servers and commands stay theirs. The git hook is the only thing that fires on their path.
- No Windows in v1. No daemon, no model in the core path, no confidence numbers, no network, no auto-update.

## Why not a SessionStart hook

The first version was a user-scope `SessionStart` hook. Two problems: `SessionStart` cannot block (exit 2 only prints), and it runs in parallel with the repo's own `SessionStart` hook, so the guard fired at the same moment the payload did. A repo's `.claude/settings.json` can also set `disableAllHooks: true` and switch user hooks off. The gate has to sit in front of the launch, not inside the session. Claude Code itself had a snapshot-and-review step for hooks until early 2026 and removed it in favour of hot reload plus a `ConfigChange` event; the plugin here uses that event as a backstop, the shim is the gate.

## Prior art

Codex CLI hook trust (`trusted_hash`), Gemini CLI hook fingerprinting and Trusted Folders, Cursor's MCP re-prompt after CVE-2025-54136, [rtk](https://github.com/rtk-ai/rtk) hashing its own hook, [agentshield](https://github.com/kdcokenny/agentshield), AIDE / Tripwire for the idea of a pinned manifest. None of them looked across everything one machine obeys; that is the only thing this adds.

## Test

```sh
node test/run.mjs
```

Builds a benign repo with the keyv shape (scripts that only print), checks the kinds, the flags, the semantic diff, the secret handling, the gate without a terminal.

MIT. Built for the AIR Security reel "I got backdoored this year through my agent's config files".
