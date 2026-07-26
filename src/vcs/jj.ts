import type { DiffFilter } from '../shared/protocol.js';
import { ExecError, execFile } from './exec.js';
import { VcsError, type ComputeOptions, type TurnBaseline, type VcsBackend } from './types.js';

export class JjBackend implements VcsBackend {
  readonly kind = 'jj' as const;

  constructor(readonly root: string) {}

  metadataDirs(): string[] {
    return ['.jj'];
  }

  private async jj(args: string[], signal?: AbortSignal): Promise<string> {
    try {
      const result = await execFile('jj', ['--color', 'never', '--no-pager', ...args], {
        cwd: this.root,
        signal,
      });
      return result.stdout;
    } catch (error) {
      if (error instanceof ExecError && !error.aborted) {
        const stderr = error.result?.stderr ?? '';
        if (/stale/i.test(stderr) && /working copy/i.test(stderr)) {
          // Never run mutating recovery commands automatically.
          throw new VcsError(
            'The jj working copy is stale. Run `jj workspace update-stale` manually, then the diff will refresh.',
          );
        }
        if (/fork_point|trunk\(\)/.test(stderr) && /(unknown|not.*resolve|No such)/i.test(stderr)) {
          throw new VcsError(`jj could not resolve the branch base revision: ${stderr.trim()}`);
        }
      }
      throw error;
    }
  }

  /**
   * Force a normal working-copy snapshot and return the current @ commit ID.
   * Any snapshotting jj command does this; `jj log` is read-only otherwise.
   */
  async captureTurnBaseline(signal?: AbortSignal): Promise<TurnBaseline> {
    const out = await this.jj(['log', '--no-graph', '-r', '@', '-T', 'commit_id'], signal);
    const ref = out.trim();
    if (!/^[0-9a-f]{8,64}$/.test(ref)) {
      throw new VcsError(`Unexpected jj commit id output: ${ref}`);
    }
    return { ref, capturedAt: new Date().toISOString() };
  }

  async computePatch(filter: DiffFilter, options: ComputeOptions): Promise<string> {
    const { signal } = options;
    switch (filter) {
      case 'unstaged':
        // jj has no staging area: show the current working-copy change (@).
        return this.jj(['diff', '--git'], signal);
      case 'branch': {
        const from = options.base ?? 'fork_point(trunk() | @)';
        return this.jj(['diff', '--git', '--from', from, '--to', '@'], signal);
      }
      case 'turn': {
        if (!options.turnBaseline) return '';
        return this.jj(['diff', '--git', '--from', options.turnBaseline.ref, '--to', '@'], signal);
      }
    }
  }
}
