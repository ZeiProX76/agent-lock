# agent-lock

The trust prompt asks whether you trust a folder. Once, blind.
agent-lock asks whether you trust **these exact files**, shows you what is in them, and asks again the moment any of them change.

## The issue

1. Every AI coding tool asks the same question the first time you open a folder: do you trust this folder? You click yes. Once.
2. After that, it reads a handful of small files in that folder on every launch, and some of those files are not settings, they are commands.
3. A hook in `.claude/settings.json` runs a shell command every time a session starts. A task in `.vscode/tasks.json` can run when the folder opens. Nobody asks again.
4. On 4 August 2026 that is exactly what hit the keyv repositories. A commit added those two files, cross-wired, each launching a hidden script in the other tool's folder.
5. Anyone who pulled and typed `claude` ran it. The trust dialog had been clicked months earlier. Same shape in May with TanStack, same shape in June with the wave that wrote itself into home folders.
6. I went and looked at my own Mac. Nineteen folders trusted. `Bash(*)` pre-approved in three of them. MCP servers pulling whatever the registry serves that day. I had never read any of it.
7. Codex checks its hooks. Gemini checks its hooks. Claude Code used to review them and removed it earlier this year. Nothing looks at all of it together, and nothing looks at the folder in your home that every launch reads.
8. Anthropic's position on record is that this is outside their threat model. Six advisories on this surface say otherwise.
9. So the dangerous moment is not the first look. It is every `git pull` after you already said yes.
10. I did not want a scanner that tells me afterwards. I wanted the question asked again, at the moment I type the command.

## What it does

1. One small program, no dependencies, nothing fetched from the internet, you can read all of it.
2. The first time you run it, it lists every folder your tools already trust and shows you what is inside: which files, which commands, when they would run.
3. You read it, you say yes. It takes a fingerprint of every one of those files and keeps the list outside the folder, where the folder cannot touch it.
4. From then on, typing `claude`, `codex` or `gemini` checks the fingerprints first. Same files, it launches, one grey line, done.
5. If a file that runs something changed, it stops and shows you the exact line that moved. Approve, read it, ask the tool's own model for a one-word read first, launch without the folder's settings, or quit.
6. It knows the difference between a note and a command. Edit a doc, nothing happens. Edit a hook, any hook, it stops.
7. It watches your home folder the same way, because that is where the June wave hid.
8. It points at the shapes the real attacks used, in plain sentences: a hook reaching into `.vscode`, a task that runs on folder open, scrambled code, a 700 KB file where a config should be.
9. It refuses to start an agent in "skip all permissions" mode when no human is at the keyboard. That is how the Nx attack drove its agents.
10. It does not decide for you and it does not claim a folder is safe. It remembers what you agreed to, and asks again when that changes.

It cannot tell who made a change, only that the content is no longer what you approved. It tells you at three moments: right after a `git pull` or `git checkout` (the git hook prints it under the pull output), when you type the command (the gate, nothing launches until you answer), and mid-session inside Claude Code (the plugin holds the change until you approve it). `~/.agent-lock/log` keeps every approval with a timestamp.

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
Files changed since you trusted them.
    [a] approve and re-pin
  ❯ [c] check the changes with claude (opus) first · no tools, empty folder
    [i] inspect the changes
    [s] safe mode · launch without this folder's settings
    [q] quit
```

Arrows or a letter, Enter picks. `check` asks the tool you just launched: `claude` asks Claude, `codex` asks Codex, `gemini` asks Gemini. One line comes back, `✓ codex: clear` or `✗ claude (opus): no.` plus one sentence naming the file, and then the menu is back. The decision is still yours.

That is the shape of the commit that hit the keyv repositories on 4 August 2026: a `.claude/settings.json` hook and a `.vscode/tasks.json` task, cross-wired, each launching a dropper hidden in the other tool's folder. `git pull`, open the folder, type `claude`, done. The trust dialog had been clicked months earlier.

Zero dependencies, one `node` file plus a `lib/`, MIT. macOS, Linux and Windows.

## What it covers

| Tool | In the repo | In your home |
|---|---|---|
| Claude Code | `.claude/**`, `.mcp.json`, `CLAUDE.md` | `~/.claude/settings.json`, `~/.claude.json` (trust map + MCP approvals), enabled plugin hooks, managed settings |
| Codex CLI | `.codex/**`, `AGENTS.md` | `~/.codex/config.toml` (trust map + hook trust), `~/.codex/hooks.json` |
| Gemini CLI | `.gemini/**`, `GEMINI.md`, `.env` (key names only) | `~/.gemini/settings.json`, `~/.gemini/trustedFolders.json` |
| VS Code / Cursor | `.vscode/**` (`tasks.json`, `launch.json`, `settings.json`), `.cursor/**` | `~/.cursor/mcp.json`, `~/.cursor/hooks.json` |
| Dev containers | `.devcontainer/**`, `.devcontainer.json` | |

Plus every file a hook, task or MCP command points at. Symlinks: the target is hashed, a target outside the repo is a flag.

An administrator's policy counts as home config: `managed-settings.json`, every drop-in beside it in `managed-settings.d/`, and `managed-mcp.json`, in `/Library/Application Support/ClaudeCode` on macOS, `/etc/claude-code` on Linux and WSL, and `C:\Program Files\ClaudeCode` on Windows. On Windows the same policy can arrive through the registry, so `HKLM\SOFTWARE\Policies\ClaudeCode` and the user-writable `HKCU\SOFTWARE\Policies\ClaudeCode` are read and fingerprinted too. Gemini's system file is read from `%ProgramData%\gemini-cli` (or `GEMINI_CLI_SYSTEM_SETTINGS_PATH`). `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured: agent-lock watches the directory the tool actually reads, not the default one.

A dev container is in the table because opening the folder runs commands, and `initializeCommand` runs on the host, outside the container.

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

1. **Never recorded** → the flags, the counts, and the menu below. The file list sits behind `[l]` on purpose: a folder can hold 131 files, and a warning has to be the thing on screen.

```
   7 files hashed, 6 of them run or configure something.
   nothing here has run yet: this happens before claude starts.
   agent-lock knows what changed, not what is safe.
Start claude in this folder?
    [y] yes · remembers these 7 files, asks again only if one changes
  ❯ [c] have claude (opus) read them first · nothing starts, no tools, empty folder
    [i] show what runs · hooks, tasks and commands, in full
    [l] show all 7 files
    [s] start claude without this folder's settings · its hooks stay off
    [q] don't start claude
```
2. **Pinned, unchanged** → `agent-lock ok · 7 files · trusted Aug 30` → launches
3. **Something that runs changed** → red semantic diff → the same menu: approve / check the changes / inspect / safe mode / quit
4. **Your home config changed** → shown first (`+1 SessionStart hook in ~/.claude/settings.json`)
5. **Trusted by a tool, never by you** → said out loud on the first pin
6. **`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` / `--yolo` with no terminal attached** → refused and logged. That is how the Nx s1ngularity payload drove agents. `AGENT_LOCK_ALLOW_NONINTERACTIVE=1` if the automation is yours.

Minor changes (a doc, a skill, a scoped `Bash(npm test:*)` permission, a key reorder) print one dim line and get re-pinned. A nag on every launch trains a blind `y`; the gate only stops for things that execute, connect, or grant.

**Check** never opens the folder. That is the whole design: asking a model about a hook by starting an agent inside the folder would fire the hook first and answer second. So the files travel as text on stdin and the model runs from an empty temporary directory, with its own configuration switched off:

| | how it is started |
|---|---|
| Claude | `-p --restricted --tools "" --strict-mcp-config --no-session-persistence --settings '{"disableAllHooks":true}' --model opus`. `--restricted` ignores user, project and local settings and drops every code-running tool; the `--settings` override covers the managed file, the one `--restricted` still obeys. |
| Codex | `exec --ephemeral --ignore-user-config --ignore-rules -s read-only -C <empty dir>`. `--ignore-user-config` leaves `~/.codex/config.toml` unread, so a compromised home config cannot run while Codex reads about it. |
| Gemini | `-p` with the default approval mode, from the same empty folder. Gemini has no documented "ignore my settings" flag: the folder is untrusted, which stops project hooks, but `~/.gemini/settings.json` still loads. Untested here, no Gemini on this machine. |

`NODE_OPTIONS` is cleared for the checker, the launch-chain variables are stripped, and the run is refused outright if the working directory would ever land inside the folder being checked. What goes in: the flags, what moved since the pin, and the files, hot first, `.env` as key names only, 150 KB cap, and it says what did not fit. What comes out: one word, `CLEAR` or `NO` plus one sentence, printed and logged. It is an opinion from a model reading text, not the gate. A wrong `clear` changes nothing, the pin still asks. `AGENT_LOCK_CHECK_MODEL` overrides the model. The checker's own launch passes the shim marked `check` and is not logged as a skip.

The test suite proves the isolation without a network: the stand-in model fires a canary if its working directory holds agent config, and the canary must stay cold. Against the real CLIs, a folder whose `SessionStart` hook appends to a file fired on a normal `claude -p` and stayed cold through `agent-lock check` and `agent-lock check --codex`, both of which named the hook.

**Safe mode** launches without the project config: Claude Code with `--setting-sources user` (verified). Codex is best effort: `-c projects."<cwd>".trust_level="untrusted" -s read-only -a untrusted`; Codex has no documented per-launch "ignore `.codex/`" flag, and `codex exec` in 0.152.0 writes `trust_level = "trusted"` for the folder into `~/.codex/config.toml` on its own, which agent-lock then reports as a home change ("trusted by Codex, never by you"). Gemini has no per-launch flag, answer "do not trust" in its own prompt.

## What blocks, what is dim

Blocks (asks): hooks, MCP `command` / `args` / `url` / `env`, `env`, `apiKeyHelper` and the other helper commands, `statusLine.command`, `permissions.defaultMode`, `permissions.additionalDirectories`, `Bash(*)`-style allow rules, `enableAllProjectMcpServers`, `disableAllHooks`, `sandbox.*`, plugin enablement, `.vscode/tasks.json` (all of it), `.vscode/launch.json` (`preLaunchTask`, `program`, `runtimeExecutable`, `args`, `env`), dev container `initializeCommand` / `postCreateCommand` and the rest of the lifecycle, Cursor `mcp.json` / `hooks.json`, Codex `hooks`, `mcp_servers`, `trust_level`, `notify`, `model_providers`, Gemini `hooks`, `mcpServers`, `tools.*`, `security.*`, any file a command points at, any new flag.

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
agent-lock check [path]         one word from the model, read from an empty folder (--codex / --gemini to ask that tool)
agent-lock explain [path]       the long version of check: what would run, when, in plain words
agent-lock home                 the user-level config every launch reads
agent-lock status               everything pinned on this machine
agent-lock install [--strict]   shims, rc lines, git hooks, pin home. --strict prints the managed-settings recipe
agent-lock uninstall
```

State: `~/.agent-lock/manifest.json` (mode 0600 on macOS and Linux; on Windows there are no mode bits and the file is protected by the ACL it inherits from your user profile), `snapshots/` (copies of pinned text files, `.env` keys only, never values), `log` (every seal, approval, refusal, skip). `AGENT_LOCK_SKIP=1` bypasses one launch and is logged. If the log cannot be written the launch still goes through, and says once that it was not recorded. `AGENT_LOCK_ASCII=1` replaces the drawn marks with plain ASCII, for a console whose font has no `✓`; `AGENT_LOCK_NO_RAW=1` asks for the one-letter menu instead of the arrow menu, which is what a terminal without a usable `stty` (busybox) gets anyway.

## Verify what you installed

```sh
cd ~/agent-lock && shasum -a 256 -c SHA256SUMS
```

## Limits, stated

- **First clone is blind.** A pin records what is there; it does not vouch for it. The flags help you read, they do not decide.
- **Same privilege.** Code already running as you can rewrite `~/.agent-lock/manifest.json`. This raises the bar, it is not a security boundary.
- **Terminal wrappers are walked, not fought.** cmux ships its own `claude` on PATH that execs "the next claude", which is the shim again; mise and asdf shims do the same. The shim notices the second pass (same PID after `exec`) and moves on to the next binary, so the gate runs once and the wrapper keeps its flags. A wrapper that spawns instead of exec'ing is not handled.
- **Launchers that skip the shell skip the shim.** The IDE extension, a GUI bundle, `npx`, a binary called by absolute path. The plugin's `SessionStart` hook warns in that case; it cannot block.
- **`npm install` runs `preinstall` before anything here runs.**
- **What a hook resolves outside the repo cannot be pinned** beyond flagging the path.
- **A capital letter is not a hiding place, and not a promise either.** Windows and macOS open `.claude/Settings.json` when a tool asks for `.claude/settings.json`, so the kind table matches without regard to case and the file is flagged as the config file it is. On Linux that same name is a different, inert file and agent-lock still treats it as config, which over-reports rather than under-reports; either way the unusual spelling is called out on its own line.
- **VS Code, Cursor, Codex and Gemini are detected, not gated.** Their own fingerprinting covers hooks (Codex pins hook definitions, Gemini fingerprints project hooks); MCP servers and commands stay theirs. The git hook is the only thing that fires on their path.
- **The checker is a reading aid.** Its answer never approves or pins anything; you still press the key. A model can be talked out of a `NO` by a file written for it, which is why the files go in as text with no tools and the flags go in first.
- **The checker cannot isolate Gemini's own settings.** Claude and Codex are started with their user configuration switched off; Gemini has no flag for it. If the thing you are asking about is `~/.gemini/settings.json`, ask Claude or Codex instead.
- **Windows runs the gate in the middle, not in front.** Windows has no `exec`, so the `.cmd` shim hands the launch to `agent-lock launch`, which decides and then runs the tool itself, forwarding the console and the exit code. One extra process in the tree, and Ctrl-C reaches the tool the same way. There is no `.ps1` beside it: a script on PATH answers to the execution policy, `Restricted` is the Windows client default, and PowerShell runs the `.cmd` through `PATHEXT` anyway.
- **On Windows the prompt needs a console on stdin.** There is no `/dev/tty`, and a separately opened `CONIN$` only delivers a keystroke on Enter ([nodejs/node#56338](https://github.com/nodejs/node/issues/56338)), so agent-lock reads `process.stdin`. Piping something into `claude` on Windows means no prompt; the gate refuses instead of guessing, and `AGENT_LOCK_SKIP=1` is the escape hatch.
- **Every test runs on the platform whose mechanism it describes.** Of 32 tests, Windows runs 30 and Linux and macOS run 28; the ones that skip are the other platform's, and they say so. Windows skips the POSIX `/bin/sh` shim chain and the POSIX menu test that reads `stty` back, and has a `.cmd` shim test and a ConPTY menu test in their place. POSIX skips the four Windows-only ones. Nothing skips for want of a tool.
- **One argument shape is refused rather than passed through a `.cmd` shim.** `claude` and `codex` ship as `.exe` on Windows and never take that path; an npm-installed CLI like `gemini` does, and its shim hands the arguments back to `cmd.exe` to read a second time. A literal `"` unbalances the quoting there, and a `&`, `|`, `<` or `>` that lands outside quotes as a result is read as another command, so that combination is refused with a sentence. A quoted prompt on its own is fine, a path with brackets is fine, and both are asserted against a real `cmd.exe` in CI along with everything agent-lock builds itself.
- No daemon, no model in the decision path, no confidence numbers, no network of its own, no auto-update.

## Why not a SessionStart hook

The first version was a user-scope `SessionStart` hook. Two problems: `SessionStart` cannot block (exit 2 only prints), and it runs in parallel with the repo's own `SessionStart` hook, so the guard fired at the same moment the payload did. A repo's `.claude/settings.json` can also set `disableAllHooks: true` and switch user hooks off. The gate has to sit in front of the launch, not inside the session. Claude Code itself had a snapshot-and-review step for hooks until early 2026 and removed it in favour of hot reload plus a `ConfigChange` event; the plugin here uses that event as a backstop, the shim is the gate.

## Prior art

Codex CLI hook trust (`trusted_hash`), Gemini CLI hook fingerprinting and Trusted Folders, Cursor's MCP re-prompt after CVE-2025-54136, [rtk](https://github.com/rtk-ai/rtk) hashing its own hook, [agentshield](https://github.com/kdcokenny/agentshield), AIDE / Tripwire for the idea of a pinned manifest. None of them looked across everything one machine obeys; that is the only thing this adds.

## Test

```sh
npm test          # node:test, no dependencies
npm run check     # Biome: format + lint (dev dependency only)
```

Builds a benign repo with the keyv shape (scripts that only print), checks the kinds, the flags, the semantic diff, the secret handling, the gate without a terminal, the launch chain through a cmux-shaped wrapper, the checker against a stand-in model (restricted flags, empty cwd, no secret value on stdin), the menu inside a real pty (arrows, letters, the one-letter fallback, Ctrl-C restoring the terminal; needs `python3`), and the shapes a real machine hands you: a checkout whose path has spaces and accents, a config checked out with CRLF, a PATH of directories that no longer exist, a state directory that cannot be written, a path past the Windows 260-character limit.

CI runs the suite on Linux, macOS and Windows across Node 18, 20, 22 and 24, on the previous Ubuntu and Windows Server images, and on Alpine for musl. The menu is driven inside a real terminal on both: a forked pty on POSIX, a ConPTY through `pywinpty` on Windows, from one `test/pty-driver.py`. The POSIX shim is run on Windows too, through Git Bash, which shares the same home directory and looks for exactly that file. A separate Windows job installs for real and then starts the tool through `cmd.exe`, Windows PowerShell 5.1, PowerShell 7 and Git Bash, reads a policy value back out of `HKCU\SOFTWARE\Policies\ClaudeCode`, uninstalls, and confirms the user PATH is as it was. `SHA256SUMS` is verified against the tree. Reporting a vulnerability: `SECURITY.md`.

MIT. Built for the AIR Security reel "I got backdoored this year through my agent's config files".
