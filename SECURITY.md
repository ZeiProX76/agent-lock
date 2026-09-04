# Security

agent-lock is a small local tool that hashes files and refuses to launch an agent when they
changed. It runs as you, with your permissions, and keeps its state in `~/.agent-lock/`.

## Reporting

Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a
vulnerability"). Please do not open a public issue for something exploitable. Include the
version (`agent-lock --version` or the commit), the platform, and a minimal reproduction.

Reports get an answer within a week. Fixes ship as a new version with a CHANGELOG entry that
credits the reporter unless they prefer otherwise.

## What is in scope

- A change to a watched file that the gate does not report as hot.
- A way to make the shim launch the real tool without the gate running.
- The manifest or a snapshot leaking a secret value (`.env` values must never be stored).
- The `explain` command executing anything from the files it reads.

## What is out of scope, by design

- Code already running as your user can rewrite `~/.agent-lock/manifest.json`. agent-lock raises
  the bar, it is not a security boundary. See "Limits, stated" in the README.
- The first pin records what is on disk. It does not judge content.
- Launchers that bypass the shell (an IDE extension, a binary called by absolute path) bypass the
  shim; the plugin hook warns but cannot block.

## Verifying what you run

`SHA256SUMS` lists the hash of every file that executes. Compare with `shasum -a 256 -c SHA256SUMS`
after cloning, and again after any update.
