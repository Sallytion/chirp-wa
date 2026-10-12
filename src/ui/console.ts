const outputMethods = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'dir',
  'dirxml',
  'trace',
  'table',
  'assert',
  'count',
  'countReset',
  'timeLog',
  'timeEnd',
  'group',
  'groupCollapsed',
  'groupEnd',
] as const;

// libsignal logs complete session records (including key Buffers) directly to
// console during encryption. Ink cannot prevent those writes with its logger.
// The full-screen UI owns terminal output; errors surface through client notices
// and Baileys' file logger. Do not format or persist these console arguments.
export function silenceBackgroundConsole(target: Console = console): () => void {
  const originals = outputMethods.map((method) => [method, target[method]] as const);
  const silent = () => {};
  for (const method of outputMethods) target[method] = silent;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [method, original] of originals) Reflect.set(target, method, original);
  };
}
