import { randomUUID } from 'node:crypto';

import {
  findUniqueAnchorInLines,
  parsePatch,
  sideLines,
  type ParsedFilePatch,
  type SideLine,
} from '../shared/patch.js';
import type { DiffFilter, NewCommentRequest, ReviewComment } from '../shared/protocol.js';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { reviewsPath } from './paths.js';

interface ReviewsFile {
  version: 1;
  root: string;
  comments: ReviewComment[];
}

export interface CreateCommentInput extends NewCommentRequest {
  anchorText: string;
  hunkExcerpt: string;
  patchHash: string;
}

/**
 * File-backed review comment store for one working tree. Every mutation is
 * persisted atomically so `dp reviews` can read the file without the daemon.
 */
export class ReviewStore {
  private comments: ReviewComment[] = [];

  private constructor(
    private readonly root: string,
    private readonly stateDirOverride?: string,
  ) {}

  static async load(root: string, stateDirOverride?: string): Promise<ReviewStore> {
    const store = new ReviewStore(root, stateDirOverride);
    const file = await readJson<ReviewsFile>(reviewsPath(root, stateDirOverride));
    if (file?.version === 1 && Array.isArray(file.comments)) {
      store.comments = file.comments;
    }
    return store;
  }

  list(): ReviewComment[] {
    return [...this.comments];
  }

  get(id: string): ReviewComment | undefined {
    return this.comments.find((c) => c.id === id);
  }

  create(input: CreateCommentInput): ReviewComment {
    const now = new Date().toISOString();
    const comment: ReviewComment = {
      id: randomUUID(),
      filter: input.filter,
      path: input.path,
      side: input.side,
      startLine: input.startLine,
      endLine: input.endLine,
      anchorText: input.anchorText,
      body: input.body,
      hunkExcerpt: input.hunkExcerpt,
      patchHash: input.patchHash,
      outdated: false,
      createdAt: now,
      updatedAt: now,
    };
    this.comments.push(comment);
    this.persist();
    return comment;
  }

  update(id: string, body: string): ReviewComment | undefined {
    const comment = this.comments.find((c) => c.id === id);
    if (!comment) return undefined;
    comment.body = body;
    comment.updatedAt = new Date().toISOString();
    this.persist();
    return comment;
  }

  delete(id: string): boolean {
    return this.deleteMany([id]) === 1;
  }

  deleteMany(ids: Iterable<string>): number {
    const targets = new Set(ids);
    const previousCount = this.comments.length;
    this.comments = this.comments.filter((comment) => !targets.has(comment.id));
    const removed = previousCount - this.comments.length;
    if (removed > 0) this.persist();
    return removed;
  }

  /**
   * Re-anchor comments of one source filter against a freshly computed patch.
   * A comment moves only when its saved anchor has exactly one unambiguous
   * match in the same file on the same side; otherwise it becomes outdated.
   * Comments keep their original saved hunk excerpt either way.
   */
  reanchor(
    filter: DiffFilter,
    patchOrFiles: string | ParsedFilePatch[],
    patchHash: string,
  ): boolean {
    const targets = this.comments.filter((c) => c.filter === filter);
    if (targets.length === 0) return false;

    const files = typeof patchOrFiles === 'string' ? parsePatch(patchOrFiles) : patchOrFiles;
    const byPath = new Map<string, ParsedFilePatch>(files.map((f) => [f.path, f]));
    const linesByPathAndSide = new Map<string, SideLine[]>();
    let changed = false;

    for (const comment of targets) {
      const file = byPath.get(comment.path);
      let newStart: number | null = null;
      if (file) {
        const cacheKey = `${comment.path}\u0000${comment.side}`;
        let lines = linesByPathAndSide.get(cacheKey);
        if (!lines) {
          lines = sideLines(file, comment.side);
          linesByPathAndSide.set(cacheKey, lines);
        }
        newStart = findUniqueAnchorInLines(lines, comment.anchorText);
      }
      const lineCount = comment.endLine - comment.startLine;
      if (newStart !== null) {
        const outdated = false;
        if (
          comment.outdated !== outdated ||
          comment.startLine !== newStart ||
          comment.patchHash !== patchHash
        ) {
          comment.outdated = outdated;
          comment.startLine = newStart;
          comment.endLine = newStart + lineCount;
          comment.patchHash = patchHash;
          changed = true;
        }
      } else if (!comment.outdated) {
        comment.outdated = true;
        changed = true;
      }
    }
    if (changed) this.persist();
    return changed;
  }

  private persist(): void {
    const file: ReviewsFile = { version: 1, root: this.root, comments: this.comments };
    writeJsonAtomic(reviewsPath(this.root, this.stateDirOverride), file);
  }
}

/** Read comments straight from disk (used by `dp reviews` without a daemon). */
export async function readReviews(
  root: string,
  stateDirOverride?: string,
): Promise<ReviewComment[]> {
  const file = await readJson<ReviewsFile>(reviewsPath(root, stateDirOverride));
  return file?.version === 1 && Array.isArray(file.comments) ? file.comments : [];
}
