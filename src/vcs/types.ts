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
  /** Identity used to share one immutable work-tree snapshot across related computations. */
  snapshotKey?: object;
}

/** A recoverable VCS failure that should be surfaced in the UI. */
export class VcsError extends Error {
  constructor(
    message: string,
    readonly committed = false,
  ) {
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
  /** Commit only these work-tree paths, leaving unrelated changes alone. */
  commitFiles(paths: string[]): Promise<void>;
  /** Restore only these paths to HEAD (Git) or the working-copy parent (jj). */
  discardFiles(paths: string[]): Promise<void>;
}
