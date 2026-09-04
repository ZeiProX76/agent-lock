// The one interactive loop every prompt shares: a menu, inspect, the checker, then an answer.
import { agentCheck, checkerLabel, defaultChecker } from './check.mjs';
import { inspect, printChangeList, printFiles } from './print.mjs';
import { menu } from './ui.mjs';

// Returns accept.key, 's', 'q' or null. Inspect and check print, then come back to the menu.
// The cursor starts on the checker; a clear verdict moves it to accept, a refusal to quit.
export async function review(
  inv,
  cmp,
  { tool = defaultChecker(), real, question, accept, safe = false, changes = false, launching = null }
) {
  // Every line says what pressing it does. `launching` is the tool waiting to start, when one is.
  const items = [
    accept,
    {
      key: 'c',
      label: `have ${checkerLabel(tool)} read ${changes ? 'the changes' : 'them'} first · nothing starts, no tools, empty folder`,
    },
    {
      key: 'i',
      label: changes
        ? 'show the changed files in full'
        : 'show what runs · hooks, tasks and commands, in full',
    },
    {
      key: 'l',
      label: changes
        ? `show all ${(cmp?.changed.length || 0) + (cmp?.added.length || 0) + (cmp?.removed.length || 0)} changes`
        : `show all ${inv.files.length} files`,
    },
    ...(safe
      ? [{ key: 's', label: `start ${launching} without this folder's settings · its hooks stay off` }]
      : []),
    { key: 'q', label: launching ? `don't start ${launching}` : 'quit without recording anything' },
  ];
  let cursor = 1;
  for (;;) {
    const a = await menu(question, items, { cursor });
    if (a === 'i') {
      inspect(inv, cmp);
      continue;
    }
    if (a === 'l') {
      if (changes) printChangeList(cmp);
      else printFiles(inv);
      continue;
    }
    if (a !== 'c') return a;
    const verdict = await agentCheck(tool, inv, cmp, real);
    cursor = verdict === 'clear' ? 0 : verdict === 'no' ? items.length - 1 : 2;
  }
}
