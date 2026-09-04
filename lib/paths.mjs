// One containment test, used everywhere a decision depends on "is this path inside that root":
// the checker's isolation invariant, symlinks that escape a repo, and the files a command points at.
// String prefixes get this wrong (`/repo-backup` starts with `/repo`) and hardcode the POSIX
// separator; path.relative answers it on every platform.
import path from 'node:path';

export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Every path we store or match against is written with forward slashes, on every platform.
// The kind table, the flag rules and the manifest keys are all "/"-shaped; on Windows
// path.relative hands back backslashes, and a manifest written on one platform has to keep
// meaning the same thing on the other.
export const slash = (p) => p.split(/[\\/]/).join('/');
export const relFrom = (root, abs) => slash(path.relative(root, abs));
