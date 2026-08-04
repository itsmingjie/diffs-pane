/**
 * Types shared between the daemon, the CLI, and the browser UI.
 * This module must stay dependency-free and runtime-agnostic.
 */

export type DiffFilter = 'turn' | 'unstaged' | 'branch';
export type VcsKind = 'git' | 'jj';
export type DiffSide = 'additions' | 'deletions';

export const DIFF_FILTERS: readonly DiffFilter[] = ['turn', 'unstaged', 'branch'];

export function isDiffFilter(value: string): value is DiffFilter {
  return (DIFF_FILTERS as readonly string[]).includes(value);
}

/** Session metadata exposed to the browser UI. */
export interface SessionInfo {
  sessionId: string;
  root: string;
  vcs: VcsKind;
  defaultFilter: DiffFilter;
  /** UI label for the `unstaged` filter ("Unstaged" for Git, "Working copy" for jj). */
  unstagedLabel: string;
  /** Present when a turn baseline has been captured for this session. */
  turn: { turnId: string; agent?: string; active: boolean } | null;
}

export type FileChangeKind = 'added' | 'deleted' | 'modified' | 'renamed';

export interface PatchFileSummary {
  /** Canonical (new) path of the file. */
  path: string;
  /** Previous path when the file was renamed. */
  prevPath?: string;
  kind: FileChangeKind;
  additions: number;
  deletions: number;
  binary: boolean;
  /**
   * Hash of this file's raw patch section. Stable while the file's diff is
   * unchanged, so clients can reuse parsed/rendered state across refreshes.
   * Optional for rolling upgrades of older daemons.
   */
  sectionHash?: string;
}

export interface PatchPayload {
  filter: DiffFilter;
  /** sha256 hex of `patch`. Stable identifier for a given diff state. */
  patchHash: string;
  /** Full unified diff in git format. Empty when `error` is set. */
  patch: string;
  files: PatchFileSummary[];
  /** Recoverable error surfaced in the UI (e.g. stale jj workspace). */
  error: string | null;
  generatedAt: string;
}

export interface ReviewComment {
  id: string;
  /** Source filter the comment was created in. Comments never move filters. */
  filter: DiffFilter;
  path: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
  /** Exact source line contents (joined with \n) the comment anchors to. */
  anchorText: string;
  body: string;
  /** Original unified-diff hunk excerpt, including its @@ header. */
  hunkExcerpt: string;
  /** Patch hash of the diff the comment was created against. */
  patchHash: string;
  /** True when the anchor no longer has one unambiguous match. */
  outdated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewCommentRequest {
  filter: DiffFilter;
  path: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
  body: string;
}

export interface UpdateCommentRequest {
  body: string;
}

/** Full file contents for one file in a diff, used by edit mode hydration. */
export interface FileContentsPayload {
  filter: DiffFilter;
  path: string;
  /** Patch hash the contents were validated against. */
  patchHash: string;
  /** Base-side contents; null for added files. */
  oldContents: string | null;
  /** Current work-tree contents; null for deleted files. */
  newContents: string | null;
  /** sha256 of newContents, used as the save concurrency precondition. */
  newContentsHash: string | null;
}

/** Body of `PUT api/file`: write edited contents back to the work tree. */
export interface SaveFileRequest {
  filter: DiffFilter;
  path: string;
  contents: string;
  /** sha256 returned with the contents this edit session started from. */
  expectedContentsHash: string;
}

export interface SaveFileResponse {
  ok: true;
  /** sha256 of the contents written, for another save in the same session. */
  contentsHash: string;
}

/** SSE `patch` event payload (`comments` events carry `{ comments: ReviewComment[] }`). */
export interface PatchChangedEvent {
  filter: DiffFilter;
  patchHash: string;
}

/** Versioned schema returned by `dp reviews --json`. */
export interface ReviewsExport {
  version: 1;
  root: string;
  /** Live session URL, present only while the daemon serves this root. */
  sessionUrl?: string;
  comments: ExportedComment[];
}

export interface ExportedComment extends ReviewComment {
  /** Deep link to the commented lines, present only when the session is live. */
  url?: string;
}

/** `dp status --json` schema. */
export interface StatusExport {
  version: 1;
  running: boolean;
  pid?: number;
  port?: number;
  sessions: Array<{
    sessionId: string;
    root: string;
    vcs: VcsKind;
    url: string;
    owners: string[];
    clients: number;
    turn: { turnId: string; agent?: string; active: boolean } | null;
  }>;
}
