---
name: agent-lock
description: Check what agent config this folder would run (hooks, MCP servers, tasks, env) against what the user pinned with agent-lock. Use when the user asks whether a repo is safe to open with an agent, what changed since they trusted it, or why agent-lock refused to launch.
---

# agent-lock

agent-lock pins the exact config files a coding agent obeys and asks again when they change.
State lives in `~/.agent-lock/` (manifest, snapshots, log). The CLI is `agent-lock` (or
`node "${CLAUDE_PLUGIN_ROOT}/agent-lock.mjs"` when the shims are not installed).

## What to run

| Question | Command |
|---|---|
| Is this folder pinned, what changed | `agent-lock diff` |
| Everything pinned on this machine | `agent-lock status` |
| Full inventory with hashes and flags, shareable | `agent-lock report` |
| Every folder Claude / Codex / Gemini already trust | `agent-lock scan` (interactive, the user answers) |
| The user-level config (hooks, plugins, trust maps) | `agent-lock diff home` |

Read the output and explain it in plain words: which file, which key, what would run and when.
A flag is a sentence to read, not a verdict; say what it means for this repo.

## Never

- Never run `agent-lock approve`, `seal`, `scan` answers, or `install` on the user's behalf.
  Approval is the whole point; it is theirs.
- Never edit `~/.agent-lock/manifest.json` or the snapshots.
- Never execute, `cat | sh`, or "test" a hook or script that agent-lock flagged. Read it, quote it.
- Never say a folder is safe. Say what is in it and whether it matches what the user pinned.
