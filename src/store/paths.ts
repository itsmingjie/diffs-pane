import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Platform user-state directory for diffs-pane. Session metadata, turn
 * baselines, and reviews live here — never inside a reviewed repository.
 */
export function stateDir(): string {
  const override = process.env['DIFFS_PANE_STATE_DIR'];
  if (override) return override;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'diffs-pane');
  }
  if (process.platform === 'win32') {
    const base = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'diffs-pane');
  }
  const base = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');
  return join(base, 'diffs-pane');
}

export function daemonInfoPath(dir = stateDir()): string {
  return join(dir, 'daemon.json');
}

export function sessionsPath(dir = stateDir()): string {
  return join(dir, 'sessions.json');
}

/** Stable filesystem-safe key for a canonical working-tree root. */
export function rootKey(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

export function reviewsPath(root: string, dir = stateDir()): string {
  return join(dir, 'reviews', `${rootKey(root)}.json`);
}

/** Private Git object store for read-only working-tree snapshots. */
export function gitObjectsPath(root: string, dir = stateDir()): string {
  return join(dir, 'git-objects', rootKey(root));
}
