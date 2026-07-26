import type { DiffFilter, VcsKind } from '../shared/protocol.js';

export interface TurnBaseline {
  /** Git tree OID or jj commit ID captured at turn start. */
  ref: string;
  capturedAt: string;
}

export interface ComputeOptions {
  signal?: AbortSignal;
  /** Explicit base revision for the `branch` filter. */
  base?: string;
  /** Baseline captured at turn start; required for the `turn` filter. */
  turnBaseline?: TurnBaseline;
}

/** A recoverable VCS failure that should be surfaced in the UI. */
export class VcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VcsError';
  }
}

export interface VcsBackend {
  readonly kind: VcsKind;
  readonly root: string;
  /** Compute the unified diff (git format) for a filter. */
  computePatch(filter: DiffFilter, options: ComputeOptions): Promise<string>;
  /** Capture a turn baseline without mutating the index or worktree. */
  captureTurnBaseline(signal?: AbortSignal): Promise<TurnBaseline>;
  /** Repo metadata paths (relative to root) that should trigger refreshes. */
  metadataDirs(): string[];
}
