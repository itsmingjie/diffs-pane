import watcher, { type AsyncSubscription } from '@parcel/watcher';

/** Dependency/build directories that never affect the reviewed diff. */
const IGNORED_DIRS = [
  'node_modules',
  '.venv',
  'venv',
  '.tox',
  '__pycache__',
  'target/debug',
  'target/release',
  '.gradle',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
];

export interface WorkTreeWatcher {
  close(): Promise<void>;
}

/**
 * Watch a working tree (including Git/jj metadata) with a native watcher.
 * Bursts are debounced; `onChange` fires at most once per quiet period.
 */
export async function watchWorkTree(
  root: string,
  onChange: () => void,
  debounceMs = 120,
): Promise<WorkTreeWatcher> {
  let timer: NodeJS.Timeout | null = null;

  const subscription: AsyncSubscription = await watcher.subscribe(
    root,
    (err, events) => {
      if (err || events.length === 0) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, debounceMs);
    },
    { ignore: IGNORED_DIRS.map((dir) => `**/${dir}/**`) },
  );

  return {
    async close() {
      if (timer) clearTimeout(timer);
      await subscription.unsubscribe();
    },
  };
}
