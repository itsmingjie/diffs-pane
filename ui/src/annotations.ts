import type { DiffLineAnnotation } from '@pierre/diffs';

import type { DiffSide, ReviewComment } from '../../src/shared/protocol';

export interface DraftComment {
  path: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
}

export type AnnotationMeta =
  | { kind: 'thread'; comments: ReviewComment[] }
  | { kind: 'draft'; draft: DraftComment };

export type DiffAnnotation = DiffLineAnnotation<AnnotationMeta>;

/**
 * Group live (non-outdated) comments of the active filter into per-file line
 * annotations, merging comments that share a path/side/end line.
 */
export function buildAnnotations(
  comments: ReviewComment[],
  draft: DraftComment | null,
): Map<string, DiffAnnotation[]> {
  const byPath = new Map<string, DiffAnnotation[]>();
  const threads = new Map<string, ReviewComment[]>();

  for (const comment of comments) {
    if (comment.outdated) continue;
    const key = `${comment.path}\u0000${comment.side}\u0000${comment.endLine}`;
    let thread = threads.get(key);
    if (!thread) {
      thread = [];
      threads.set(key, thread);
    }
    thread.push(comment);
  }

  for (const [key, thread] of threads) {
    const [path, side, line] = key.split('\u0000') as [string, DiffSide, string];
    push(byPath, path, {
      side,
      lineNumber: Number(line),
      metadata: { kind: 'thread', comments: thread },
    });
  }

  if (draft) {
    push(byPath, draft.path, {
      side: draft.side,
      lineNumber: draft.endLine,
      metadata: { kind: 'draft', draft },
    });
  }
  return byPath;
}

function push(map: Map<string, DiffAnnotation[]>, path: string, annotation: DiffAnnotation): void {
  const list = map.get(path);
  if (list) list.push(annotation);
  else map.set(path, [annotation]);
}

/** Stable key describing a file's annotations, used for item versioning. */
export function annotationsKey(annotations: DiffAnnotation[] | undefined): string {
  if (!annotations || annotations.length === 0) return '';
  return annotations
    .map((a) => {
      const meta = a.metadata;
      const detail =
        meta.kind === 'thread'
          ? meta.comments.map((c) => `${c.id}@${c.updatedAt}:${c.startLine}`).join(',')
          : `draft:${meta.draft.startLine}-${meta.draft.endLine}`;
      return `${a.side}:${a.lineNumber}[${detail}]`;
    })
    .sort()
    .join('|');
}
