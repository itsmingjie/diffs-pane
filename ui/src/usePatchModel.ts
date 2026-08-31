import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';
import { useCallback, useMemo, useRef } from 'react';

import type { PatchPayload } from '../../src/shared/protocol';
import { splitPatchSections } from '../../src/shared/patch';

export interface ParsedFile {
  path: string;
  fileDiff: FileDiffMetadata;
  sectionHash: string;
}

export function usePatchModel(patch: PatchPayload | null) {
  const cacheRef = useRef(new Map<string, FileDiffMetadata>());
  const clearCache = useCallback(() => cacheRef.current.clear(), []);

  // Render-time parse cache: reuses FileDiffMetadata for unchanged sections
  // across patch refreshes. Reads and writes are keyed by content hash, so
  // they are idempotent within a render.
  /* oxlint-disable react/refs */
  const files = useMemo<ParsedFile[]>(() => {
    if (!patch || patch.patch === '') return [];

    const summaries = patch.files;
    const sections = splitPatchSections(patch.patch);
    if (sections.length !== summaries.length) return [];

    const previous = cacheRef.current;
    const next = new Map<string, FileDiffMetadata>();
    const parsed: ParsedFile[] = [];
    summaries.forEach((summary, index) => {
      const sectionHash = summary.sectionHash;
      const key = `${summary.path}|${sectionHash}`;
      const fileDiff =
        previous.get(key) ??
        parsePatchFiles(sections[index]!, sectionHash.slice(0, 16)).flatMap(
          (section) => section.files,
        )[0];
      if (!fileDiff) return;
      next.set(key, fileDiff);
      parsed.push({ path: summary.path, fileDiff, sectionHash });
    });
    cacheRef.current = next;
    return parsed;
  }, [patch]);
  /* oxlint-enable react/refs */

  return { files, clearCache };
}
