#!/bin/sh
# agent-lock git hook dispatcher, installed for every standard hook name via a global
# core.hooksPath. On post-merge / post-checkout / post-rewrite it warns when the agent config of
# this checkout changed since you pinned it (the pull that carried the August 2026 keyv commit
# would print here). Every hook name then falls through to the repo's own .git/hooks/<name>,
# so nothing you had before is lost.
name="$(basename "$0")"
AGENT_LOCK_MJS="__MJS__"
NODE_BIN="__NODE__"
[ -x "$NODE_BIN" ] || NODE_BIN=node
case "$name" in
  post-merge|post-checkout|post-rewrite)
    if [ -f "$AGENT_LOCK_MJS" ] && [ "$AGENT_LOCK_SKIP" != "1" ]; then
      NODE_OPTIONS= "$NODE_BIN" "$AGENT_LOCK_MJS" verify --quiet "--hook=$name" || true
    fi ;;
esac
repo_hook="$(git rev-parse --git-dir 2>/dev/null)/hooks/$name"
if [ -x "$repo_hook" ] && [ "$repo_hook" != "$0" ]; then
  exec "$repo_hook" "$@"
fi
exit 0
