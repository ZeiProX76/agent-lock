// Exit codes shared by the CLI, the launch gate, the git hook and the plugin hook.
// The shim treats any non-zero code as "do not start the tool", so CHANGED also covers a
// declined launch. Claude Code reads exit 2 from a hook as block (ConfigChange) or warn (SessionStart).
export const EXIT = Object.freeze({
  OK: 0,
  CHANGED: 1,
  UNSEALED: 2,
  ERROR: 3,
  NO_BINARY: 127,
});
export const HOOK_BLOCK = 2;
