/**
 * Sort canonical paths in file-tree display order: at each directory level,
 * subdirectories come before files, each alphabetically (case-insensitive).
 * The result feeds Trees' presorted prepared-input path.
 */
export function sortPathsForTree(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => {
    const aSegs = a.split('/');
    const bSegs = b.split('/');
    const len = Math.min(aSegs.length, bSegs.length);
    for (let i = 0; i < len; i++) {
      const aSeg = aSegs[i]!;
      const bSeg = bSegs[i]!;
      const aIsDir = i < aSegs.length - 1;
      const bIsDir = i < bSegs.length - 1;
      if (aSeg === bSeg && aIsDir && bIsDir) continue;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      const cmp = aSeg.localeCompare(bSeg, undefined, { sensitivity: 'base' });
      if (cmp !== 0) return cmp;
      if (aSeg !== bSeg) return aSeg < bSeg ? -1 : 1;
    }
    return aSegs.length - bSegs.length;
  });
}
