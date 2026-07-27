/**
 * Minimal, dependency-free unified-diff (git format) parser.
 *
 * The daemon uses this for file summaries, review anchoring, and hunk
 * excerpts. The browser UI renders diffs with @pierre/diffs instead; this
 * parser only needs to be faithful about paths, hunks, and line numbers.
 */

import type { DiffSide, FileChangeKind, PatchFileSummary } from './protocol.js';

export interface ParsedPatchLine {
  origin: ' ' | '+' | '-';
  /** Line content without the origin character. */
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface ParsedHunk {
  /** The full `@@ -a,b +c,d @@ ...` header line. */
  header: string;
  lines: ParsedPatchLine[];
  /** Raw hunk text including the header line. */
  raw: string;
}

export interface ParsedFilePatch {
  path: string;
  prevPath?: string;
  kind: FileChangeKind;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: ParsedHunk[];
  /** Raw text of this file's whole patch section. */
  raw: string;
}

/** Unquote a C-style quoted git path ("with \"escapes\""). */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = inner[++i];
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case '\\':
        out += '\\';
        break;
      case '"':
        out += '"';
        break;
      default: {
        // Octal escape (\NNN)
        if (next !== undefined && next >= '0' && next <= '7') {
          let oct = next;
          while (
            oct.length < 3 &&
            inner[i + 1] !== undefined &&
            inner[i + 1]! >= '0' &&
            inner[i + 1]! <= '7'
          ) {
            oct += inner[++i];
          }
          out += String.fromCharCode(parseInt(oct, 8));
        } else if (next !== undefined) {
          out += next;
        }
        break;
      }
    }
  }
  return out;
}

function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/**
 * Split a `diff --git a/... b/...` remainder into old/new paths. Handles
 * quoted paths; for unquoted paths with spaces, prefers a split where both
 * halves match (identical path), falling back to the last ` b/` separator.
 */
function splitDiffGitPaths(rest: string): { oldPath: string; newPath: string } | null {
  if (rest.startsWith('"')) {
    // Quoted old path: find its closing quote.
    let end = -1;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '\\') {
        i++;
        continue;
      }
      if (rest[i] === '"') {
        end = i;
        break;
      }
    }
    if (end < 0) return null;
    const oldRaw = rest.slice(0, end + 1);
    const newRaw = rest.slice(end + 2);
    return {
      oldPath: stripPrefix(unquoteGitPath(oldRaw)),
      newPath: stripPrefix(unquoteGitPath(newRaw)),
    };
  }
  if (rest.includes(' "')) {
    const idx = rest.indexOf(' "');
    return {
      oldPath: stripPrefix(rest.slice(0, idx)),
      newPath: stripPrefix(unquoteGitPath(rest.slice(idx + 1))),
    };
  }
  // Unquoted: try each ` b/` occurrence, preferring identical halves.
  const candidates: Array<{ oldPath: string; newPath: string }> = [];
  let from = 0;
  for (;;) {
    const idx = rest.indexOf(' b/', from);
    if (idx < 0) break;
    candidates.push({ oldPath: stripPrefix(rest.slice(0, idx)), newPath: rest.slice(idx + 3) });
    from = idx + 1;
  }
  if (candidates.length === 0) {
    const idx = rest.lastIndexOf(' ');
    if (idx < 0) return null;
    return { oldPath: stripPrefix(rest.slice(0, idx)), newPath: stripPrefix(rest.slice(idx + 1)) };
  }
  return candidates.find((c) => c.oldPath === c.newPath) ?? candidates[candidates.length - 1]!;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch: string): ParsedFilePatch[] {
  const lines = patch.split('\n');
  const files: ParsedFilePatch[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.startsWith('diff --git ')) {
      i++;
      continue;
    }
    const start = i;
    const header = lines[i]!;
    i++;

    let oldPath: string | undefined;
    let newPath: string | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let newFile = false;
    let deletedFile = false;
    let binary = false;

    // Extended headers until first hunk or next file.
    while (i < lines.length && !lines[i]!.startsWith('diff --git ') && !HUNK_RE.test(lines[i]!)) {
      const line = lines[i]!;
      if (line.startsWith('rename from '))
        renameFrom = unquoteGitPath(line.slice('rename from '.length));
      else if (line.startsWith('rename to '))
        renameTo = unquoteGitPath(line.slice('rename to '.length));
      else if (line.startsWith('new file mode')) newFile = true;
      else if (line.startsWith('deleted file mode')) deletedFile = true;
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch'))
        binary = true;
      else if (line.startsWith('--- ')) oldPath = parseFileLine(line.slice(4));
      else if (line.startsWith('+++ ')) newPath = parseFileLine(line.slice(4));
      i++;
    }

    // Hunks.
    const hunks: ParsedHunk[] = [];
    let additions = 0;
    let deletions = 0;
    while (i < lines.length && HUNK_RE.test(lines[i]!)) {
      const hunkStart = i;
      const m = HUNK_RE.exec(lines[i]!)!;
      let oldLine = parseInt(m[1]!, 10);
      let newLine = parseInt(m[3]!, 10);
      let oldRemaining = m[2] !== undefined ? parseInt(m[2]!, 10) : 1;
      let newRemaining = m[4] !== undefined ? parseInt(m[4]!, 10) : 1;
      const hunkHeader = lines[i]!;
      const hunkLines: ParsedPatchLine[] = [];
      i++;
      while (i < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
        const line = lines[i]!;
        if (line.startsWith('diff --git ') || HUNK_RE.test(line)) break;
        if (line.startsWith('\\')) {
          i++;
          continue; // "\ No newline at end of file"
        }
        const origin = line[0];
        if (origin === '+') {
          hunkLines.push({ origin: '+', text: line.slice(1), newLine: newLine++ });
          additions++;
          newRemaining--;
        } else if (origin === '-') {
          hunkLines.push({ origin: '-', text: line.slice(1), oldLine: oldLine++ });
          deletions++;
          oldRemaining--;
        } else if (origin === ' ' || line === '') {
          hunkLines.push({
            origin: ' ',
            text: line.slice(1),
            oldLine: oldLine++,
            newLine: newLine++,
          });
          oldRemaining--;
          newRemaining--;
        } else {
          break; // Unknown content; stop this hunk defensively.
        }
        i++;
      }
      // Skip a trailing "\ No newline" marker that follows the last line.
      while (i < lines.length && lines[i]!.startsWith('\\')) i++;
      hunks.push({
        header: hunkHeader,
        lines: hunkLines,
        raw: lines.slice(hunkStart, i).join('\n'),
      });
    }

    // Resolve paths, preferring explicit rename headers.
    const fromDiffGit = splitDiffGitPaths(header.slice('diff --git '.length));
    const resolvedNew = renameTo ?? newPath ?? fromDiffGit?.newPath;
    const resolvedOld = renameFrom ?? oldPath ?? fromDiffGit?.oldPath;
    const path = (resolvedNew ?? resolvedOld ?? '') || (resolvedOld ?? '');
    const rename =
      renameFrom !== undefined ||
      (resolvedOld !== undefined &&
        resolvedNew !== undefined &&
        resolvedOld !== resolvedNew &&
        resolvedOld !== '/dev/null' &&
        resolvedNew !== '/dev/null');

    let kind: FileChangeKind = 'modified';
    if (newFile || resolvedOld === '/dev/null') kind = 'added';
    else if (deletedFile || resolvedNew === '/dev/null') kind = 'deleted';
    else if (rename) kind = 'renamed';

    files.push({
      path:
        kind === 'deleted' ? (resolvedOld === '/dev/null' ? path : (resolvedOld ?? path)) : path,
      prevPath: kind === 'renamed' ? resolvedOld : undefined,
      kind,
      binary,
      additions,
      deletions,
      hunks,
      raw: lines.slice(start, i).join('\n'),
    });
  }
  return files;
}

function parseFileLine(raw: string): string | undefined {
  const trimmed = raw.replace(/\t.*$/, '');
  if (trimmed === '/dev/null') return '/dev/null';
  return stripPrefix(unquoteGitPath(trimmed));
}

export function summarizeFiles(files: ParsedFilePatch[]): PatchFileSummary[] {
  return files.map((f) => ({
    path: f.path,
    prevPath: f.prevPath,
    kind: f.kind,
    additions: f.additions,
    deletions: f.deletions,
    binary: f.binary,
  }));
}

export interface SideLine {
  line: number;
  text: string;
  hunkIndex: number;
}

/** All lines visible on one side of a file diff, with their line numbers. */
export function sideLines(file: ParsedFilePatch, side: DiffSide): SideLine[] {
  const out: SideLine[] = [];
  file.hunks.forEach((hunk, hunkIndex) => {
    for (const line of hunk.lines) {
      if (side === 'additions' && line.newLine !== undefined) {
        out.push({ line: line.newLine, text: line.text, hunkIndex });
      } else if (side === 'deletions' && line.oldLine !== undefined) {
        out.push({ line: line.oldLine, text: line.text, hunkIndex });
      }
    }
  });
  return out;
}

/** Exact source text of a line range on one side, or null when absent. */
export function anchorTextForRange(
  file: ParsedFilePatch,
  side: DiffSide,
  startLine: number,
  endLine: number,
): string | null {
  const all = sideLines(file, side);
  const texts: string[] = [];
  for (let n = startLine; n <= endLine; n++) {
    const found = all.find((l) => l.line === n);
    if (!found) return null;
    texts.push(found.text);
  }
  return texts.join('\n');
}

/** The raw hunk (with @@ header) that contains the given line range. */
export function hunkExcerptForRange(
  file: ParsedFilePatch,
  side: DiffSide,
  startLine: number,
): string | null {
  const all = sideLines(file, side);
  const found = all.find((l) => l.line === startLine);
  if (!found) return null;
  return file.hunks[found.hunkIndex]?.raw ?? null;
}

/**
 * Find the unique new position of an anchor block on one side of a file.
 * Returns the new start line when there is exactly one match; null otherwise.
 */
export function findUniqueAnchor(
  file: ParsedFilePatch,
  side: DiffSide,
  anchorText: string,
): number | null {
  return findUniqueAnchorInLines(sideLines(file, side), anchorText);
}

/** Find a unique anchor in precomputed side lines. */
export function findUniqueAnchorInLines(
  all: readonly SideLine[],
  anchorText: string,
): number | null {
  const targets = anchorText.split('\n');
  let match: number | null = null;
  outer: for (let i = 0; i + targets.length <= all.length; i++) {
    for (let j = 0; j < targets.length; j++) {
      const candidate = all[i + j]!;
      if (candidate.text !== targets[j]) continue outer;
      // Require contiguous line numbers so the block is one real region.
      if (j > 0 && candidate.line !== all[i + j - 1]!.line + 1) continue outer;
    }
    if (match !== null) return null;
    match = all[i]!.line;
  }
  return match;
}
