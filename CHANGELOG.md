# Changelog

All notable changes to agent-lock. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **A caret reached the program instead of `cmd.exe`.** `cmd` strips a caret outside a quoted
  region and leaves it alone inside one, so caret-escaping a metacharacter while the argument was
  quoted delivered the caret to the program: `--settings "C:\Program Files (x86)\x\no-hooks.json"`
  arrived as `C:\Program Files ^(x86^)\x\no-hooks.json`. That flag is how the checker switches the
  model's hooks off, so on a machine with a bracket in the path it would silently not be found.
  The quotes are escaped now as well, which keeps `cmd` out of a quoted region for the whole
  argument, so every caret is removed and the batch file's `%*` holds exactly the C-runtime
  quoting the program expects. The program name keeps real quotes, because `cmd` splits the
  command it runs on spaces. Only a real Windows run could have found this.
- **A tool that spawns `claude` itself was refused on Windows.** There is no `exec` and no PID to
  tell a child from a wrapper handing the launch on, so a hook calling `claude` got "nothing real
  left to run". When nothing else is left on PATH, the binary the parent ran is the right answer
  for both; a wrapper that really loops still stops at `MAX_HOPS`.
- **A capitalised config name no longer hides a hook.** Windows and macOS open
  `.claude/Settings.json` when a tool asks for `.claude/settings.json`, and Claude Code reads it,
  but the kind table matched the path exactly, so the file came back as `other`: a `SessionStart`
  hook with matcher `*` calling a dropper produced **zero flags** on a first seal. The table now
  matches without regard to case, and an unusual spelling gets a line of its own. On Linux the
  same name is a different, inert file and is now treated as config anyway, which over-reports
  rather than under-reports and is right the moment the repo is opened on a Mac.
- **The output no longer needs a font most Windows consoles do not have.** The UI drew 21
  characters (`✓ ✗ ⚠ ❯ → …` and a Braille spinner) that Windows Terminal renders and the conhost
  window still opening for PowerShell 5.1 does not. Every string stays Unicode and is downgraded
  once on the way out, on Windows unless the terminal says it is a modern one; `AGENT_LOCK_ASCII=1`
  forces it anywhere.
- **A launch the log could not record said nothing about it.** The no-terminal message promises
  `AGENT_LOCK_SKIP=1` is logged. With an unwritable state directory it was not, silently. The
  launch still goes through, and now says once that it was not recorded.
- **An unusable answer at the one-letter prompt looked like the key was ignored.** It now prints
  the letters it accepts. Without raw mode an arrow key is an escape sequence and means nothing.

### Added

- `AGENT_LOCK_NO_RAW=1` asks for the one-letter menu instead of the arrow menu. That is also what
  a terminal without a usable `stty` gets on its own: busybox has no `stty -g` to save the terminal
  with, so Alpine falls back, and that fallback now has a test of its own.

### Testing

- The stand-in tool the suite launches is a Node script behind a `.cmd` on Windows and a `sh`
  launcher on POSIX, so **the tests that used to skip on Windows now run there**: the gate, the
  launch chain, the exit code and the checker's isolation. As a side effect the `.cmd` command
  line `lib/spawn.mjs` builds is now parsed by a real `cmd.exe` rather than compared to a string
  written by hand.
- A quoting oracle on Windows: every argument agent-lock builds itself (flags, a model name, a
  path with spaces, `C:\Program Files (x86)`, an empty argument, non-ASCII, 1200 characters) has to
  come back out of a real `cmd.exe` byte for byte, and so does what a user is likely to type
  (`^&|<>()`, a trailing backslash, `a;b,c`, `!bang!`, `*`, `?`, `say "hi" twice`, `fifty% done`).
  This is the test that found the caret leak below; before it, the quoting was compared against
  strings written by hand.
- A Windows-only shim test covering what the POSIX shim test covers on POSIX: the `.cmd` shim
  gates once, the tool's own re-launch takes the next binary, a `--dangerously-*` flag is refused.
- An install round trip on a throwaway Windows runner: install, then start the tool through
  `cmd.exe`, Windows PowerShell 5.1, PowerShell 7 and Git Bash, read a policy value back out of
  `HKCU\SOFTWARE\Policies\ClaudeCode`, uninstall, and confirm the user PATH is as it was.
- The shapes a real machine hands you: a checkout whose path has spaces and accents, a config
  checked out with CRLF, a PATH of directories that no longer exist, a state directory that cannot
  be written, a path past the Windows 260-character limit.
- CI widened to Node 18, 20, 22 and 24 on Linux, macOS and Windows, plus the previous Ubuntu and
  Windows Server images and an Alpine job for musl. Node 24 was untested and is what a Homebrew
  install runs. Seventeen jobs, all green: 30 tests, 27 on every platform, three skipping with the
  platform they are for. The Windows install job passes every step, all four shells included.

## [0.3.0] - 2026-09-04

### Changed

- The change screen follows the same rule the inventory already did: the flags and what runs are
  on screen in full, everything else is one line with a count and where it clusters. Forty lines
  of eval output and skill documentation is how a reader learns to skip the screen that matters.
  `[l]` spells out every change when you want them.

  ```
  41 changes in ~/reels since you trusted it (today 12:38 PM)
     ✗ .claude/settings.json
         ~ hooks.SessionStart[0].hooks[0].command: "npm run lint" → "node .vscode/setup.mjs"
     40 more changed or added, none of them run: .claude/skills/softgirl-style-workspace (31), .claude/skills/softgirl-style (7)
  ```

- When nothing on the list runs, the screen says so in a sentence instead of leaving the reader
  to work it out from forty dim lines.

### Added

- **Windows.** `agent-lock install` writes `.cmd` and `.ps1` shims beside the POSIX one and puts
  the shim directory first on the user PATH through `SetEnvironmentVariable` (not `setx`, which
  truncates a PATH at 1024 characters). Windows has no `exec`, so the shims call a new
  `agent-lock launch`, which makes the same decision the gate makes and then runs the tool
  itself, forwarding the console and the exit code. `uninstall` removes all of it again.
- Windows policy sources are watched: `C:\Program Files\ClaudeCode\managed-settings.json` (the
  current path, not the `ProgramData` one Claude Code no longer reads), plus
  `HKLM\SOFTWARE\Policies\ClaudeCode` and the user-writable `HKCU\SOFTWARE\Policies\ClaudeCode`,
  read with `reg query` and fingerprinted like a file.
- `managed-settings.d/*.json` drop-ins and `managed-mcp.json` are watched on every platform. They
  are merged into the policy, so one unwatched drop-in was a whole unwatched policy.
- `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GEMINI_CLI_SYSTEM_SETTINGS_PATH` are honoured. Watching
  the default directory while the tool reads another one is worse than watching nothing, because
  the ok line would be a lie.
- `.devcontainer/**` and `.vscode/launch.json` joined the watch set. Opening a folder in a dev
  container runs six lifecycle commands and `initializeCommand` runs on the host, outside the
  container; `preLaunchTask` chains a debug configuration into `tasks.json`. All of them are
  extracted as commands, so the existing download-and-run flags apply to them.
- A folder inside a git repository whose root has its own `.claude` is flagged. Claude Code reads
  `.claude/settings.local.json` from the repository root, so starting in a subdirectory applied a
  file agent-lock had never inventoried.

### Fixed

- Size only flags a file something would run. A 127 KB HTML report in a skill folder was raising
  "over 100 KB inside a dotfolder", which is the kind of flag that teaches a reader to skim.
  Scripts and code still raise it.
- **Every path is stored and matched with forward slashes.** The kind table, the flag rules and
  the manifest keys are all `/`-shaped, and `path.relative` returns backslashes on Windows: the
  whole watch set would have silently matched nothing there. A manifest also now means the same
  thing on both platforms.
- `.cmd` and `.bat` are run through `cmd.exe` with a command line agent-lock builds itself. Node
  refuses to spawn them without a shell since CVE-2024-27980, and its own `shell: true` joins
  arguments with spaces, which breaks on the first path containing one. `claude` and `codex` ship
  as real `.exe` files and never take this path; the npm-installed `gemini` does.
- No argument agent-lock builds carries JSON or prose any more. `--settings` gets a file in the
  checker's own temp folder instead of a brace-filled string, and Gemini's prompt moved to stdin.
  A `.cmd` re-parses its command line, and escaping is where that goes wrong.
- PATH resolution follows `PATHEXT` on Windows, so `claude` finds `claude.exe`; `.ps1` is skipped
  because it is never what cmd.exe would pick. The current directory is deliberately not searched.
- The Codex safe-mode override escapes the path it puts in a TOML key. `C:\Users\x` pasted raw
  is an invalid escape and the whole override would have been rejected.
- The batch shim uses `goto`, not a parenthesised `if` block: `C:\Program Files (x86)` in a node
  path would have closed the block early.
- The git hook body substitutes forward-slash paths on Windows, where `/bin/sh` is the one Git
  ships and cannot read `C:\path`.
- A non-empty launch chain now counts as a re-entry on every platform, not only behind the POSIX
  shim's `exec`. It is only ever set after a gate ran, and on Windows it is the only signal there
  is.

### Changed

- The prompts are async and read the console Node can actually read on each platform: `/dev/tty`
  with `stty` on POSIX, `process.stdin` in raw mode on Windows, where a separately opened
  `CONIN$` only delivers a keystroke on Enter (nodejs/node#56338).
- CI runs the suite on Windows as well as ubuntu and macOS, Node 18 to 22, and is green on all
  ten jobs. Seventeen of the twenty-two tests run on Windows; the four that stand in for a coding
  agent with a `/bin/sh` script and the one that drives a real pty say so and skip rather than
  pretending to pass.

### Fixed after the first Windows run

The first time CI ever ran on Windows, four tests failed. Three were the harness, one was a
claim that cannot hold there:

- `new URL(...).pathname` is `/D:/a/…` on Windows, and `path.resolve` turned that leading slash
  into a second drive letter, so the child process looked for `D:\D:\a\…\agent-lock.mjs` and
  three tests were reading node's exit code, not ours. `fileURLToPath` knows about drive letters.
- `path.relative` in the cross-reference flag: the `.claude` → `.vscode` shape this tool is named
  for was silently never raised on Windows. The one call site the separator sweep missed.
- The manifest test asserted mode `0600`. Windows has no POSIX mode bits and Node reports `0o666`
  for anything writable; there the file is protected by the ACL it inherits from the user profile.
  The README no longer claims `0600` everywhere.
- `node --test test/*.test.mjs` ran nothing on Windows under Node 18 and 20: PowerShell does not
  expand a glob for a native command and only Node 22 expands one itself. The script names both
  files.

## [0.2.0] - 2026-09-03

### Added

- Every prompt is a menu: arrows or `j`/`k` move, Enter picks, the letters still work, Esc or
  Ctrl-C quit and the terminal is restored. Once answered the menu collapses to one line so the
  transcript keeps the choice.
- `check` on every menu and as a command: the files go to the model of the tool you launched,
  `claude` to Claude (Opus by default, `AGENT_LOCK_CHECK_MODEL` overrides), `codex` to Codex,
  `gemini` to Gemini, behind a spinner. One word back, `clear` or `no` plus one sentence,
  printed and logged. The answer changes nothing by itself; the menu returns with the cursor on
  accept after a `clear` and on quit after a `no`. `--codex` / `--gemini` pick the tool for the
  standalone command, which otherwise uses the first one installed.
- The checker never opens the folder it is checking, so a hook cannot fire while a model reads
  about it. It runs from an empty temporary directory with the tool's own configuration off:
  Claude with `--restricted` plus a `disableAllHooks` settings override for the managed file,
  Codex with `--ignore-user-config --ignore-rules -s read-only`, Gemini from the same untrusted
  empty folder (its user settings still load, stated in the README limits). `NODE_OPTIONS` and
  the launch-chain variables are stripped, and the run is refused if the working directory would
  land inside the folder under review. A stand-in model in the test suite fires a canary if its
  working directory holds agent config; it stays cold.

### Changed

- `explain` sends the same bundle as `check` (flags, what moved since the pin, files ranked hot
  first) and no longer only the flagged files. It also runs from the same empty temporary folder
  with the same cleaned environment; it used to run in `~/.agent-lock/explain-cwd`, where a
  walk-up for `CLAUDE.md` reaches files outside the pin.
- Every prompt says what the key does, in words a first-time reader can act on. The question is
  the action (`Start claude in this folder?`), the accept line carries the consequence
  (`yes · remembers these 7 files, asks again only if one changes`), quit says `don't start
  claude`, and two lines under the flags say that nothing has run yet and that agent-lock knows
  what changed, not what is safe. "Pin" is gone from every prompt and from every command that
  prints to a person, `scan`, `status`, `verify`, `report` and `explain` included: what the tool
  does is record fingerprints. The manifest is still the manifest, the word was ours and not the
  reader's. The command is still `agent-lock seal`.
- The inventory shows the flags and the counts, not the file list. Eight fonts scrolling past
  taught nothing; a warning has to be the thing on screen. `[l]` on the menu prints the full
  list, hot files first with what each one would do, then the hashed-but-inert ones.
- `approve` on an unchanged pin prints the ok line instead of an empty diff.

### Fixed

- `trusted today` on a pin from last night: dates are compared as calendar days, not 24-hour
  windows.
- A hex, octal, binary or dated value in `~/.codex/config.toml` threw and took the whole file
  with it: the alternation tried the plain-integer branch first and `0x`, `0o`, `0b` and a year
  all start with a digit. A single unreadable value emptied the Codex trust map, so `scan` stopped
  listing folders only Codex trusts, and every change to that file degraded to "cannot be parsed":
  still a hot stop, but without the line that changed. Checked key for key against Python's
  `tomllib`, on the real config and on hex, octal, binary, underscored and dated values.
- Containment is one shared test (`isInside`) instead of three string prefixes. `/repo-backup`
  no longer reads as inside `/repo`, and the checker's isolation guard, the symlink-escape note
  and command-target resolution all answer it the same way.
- The checker cannot take a launch down with it: any throw is reported and answered `error`, and
  the temporary folder holding the bundle is removed on every path. A model that ignores SIGTERM
  is escalated, the timeout is cleared on every exit, captured output is capped, and an empty
  answer file falls back to stdout.
- The menu no longer smears on a narrow terminal: labels are cut to the width of the terminal it
  draws on, so no line wraps and the cursor-up redraw stays aligned. Covered by a 40-column pty
  test.
- A terminal that returns EAGAIN on read (Node can leave a tty fd non-blocking) was retried in a
  tight loop, burning a core while the menu waited. It backs off now, and EINTR is retried.
- `agent-lock install` on Windows says Windows is not supported instead of writing POSIX shell
  shims that nothing would ever find. macOS, Linux and WSL are the supported platforms.

## [0.1.1] - 2026-09-02

### Fixed

- Launch loop behind a PATH wrapper that execs "the next `claude`" (cmux ships one; mise and asdf
  shims behave the same). The shim now records the binaries it already handed the launch to and
  skips them on the second pass, so the gate runs once and the wrapper keeps its flags. A direct
  child of the real tool (a hook calling `claude -p`) gets the binary its parent ran.
- Fresh launch with no real binary on PATH printed the re-entry message instead of "not on PATH".

### Changed

- Tests run under `node:test`. Biome formats and lints the tree (`npm run check`). CI runs both on
  macOS and Linux, Node 18 to 22, and checks `SHA256SUMS` against the tree.
- `lib/manifest.mjs` split out of `lib/inventory.mjs`; exit codes named in `lib/exit-codes.mjs`.
  No behaviour change.

## [0.1.0] - 2026-09-02

### Added

- First release. PATH shims for `claude`, `codex` and `gemini` that pin the agent config of a
  folder (`.claude/`, `.codex/`, `.gemini/`, `.vscode/`, `.cursor/`, `.mcp.json`, `CLAUDE.md`,
  `AGENTS.md`, `.env` key names) plus the home-level config every launch reads, and refuse to
  start the tool when something that runs, connects or grants changed.
- Semantic diff per config kind, deterministic flags in plain sentences, `scan` over every folder
  the tools already trust, `explain` through a restricted `claude -p`, git hook dispatcher for
  pull-time warnings, Claude Code plugin with `ConfigChange` and `SessionStart` backstops.
