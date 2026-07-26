import type { CodeViewLineSelection, SelectedLineRange, SelectionSide } from '@pierre/diffs';

/**
 * Line permalinks in the URL hash, e.g. `#target=f:src/app.ts&start=A12&end=A15`.
 * `A`/`D` prefixes encode the additions/deletions side. The same format is
 * used by diffshub, so links stay familiar to humans and trivially
 * constructable by agents (`<session-url>#target=f:<path>&start=A<line>`).
 */

const POINT_PATTERN = /^([AD])(\d+)$/;

function parsePoint(value: string | null): { lineNumber: number; side: SelectionSide } | null {
  const match = value === null ? null : POINT_PATTERN.exec(value);
  if (!match) return null;
  const lineNumber = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return null;
  return { lineNumber, side: match[1] === 'D' ? 'deletions' : 'additions' };
}

function formatPoint(lineNumber: number, side: SelectionSide | undefined): string {
  return `${side === 'deletions' ? 'D' : 'A'}${lineNumber}`;
}

export function parseLineHash(hash: string): CodeViewLineSelection | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  if (text === '') return null;
  const params = new URLSearchParams(text);
  const id = params.get('target');
  const start = parsePoint(params.get('start'));
  if (!id || !start) return null;
  const end = params.get('end') === null ? start : parsePoint(params.get('end'));
  if (!end) return null;
  const range: SelectedLineRange = {
    start: start.lineNumber,
    side: start.side,
    end: end.lineNumber,
    ...(start.side !== end.side ? { endSide: end.side } : {}),
  };
  return { id, range };
}

export function formatLineHash(selection: CodeViewLineSelection): string {
  const { id, range } = selection;
  const params = [
    `target=${encodeURIComponent(id).replaceAll('%2F', '/')}`,
    `start=${formatPoint(range.start, range.side)}`,
  ];
  const endSide = range.endSide ?? range.side;
  if (range.end !== range.start || endSide !== range.side) {
    params.push(`end=${formatPoint(range.end, endSide)}`);
  }
  return `#${params.join('&')}`;
}

/** Replace or clear the hash without adding history entries. */
export function syncLineHash(selection: CodeViewLineSelection | null): void {
  const url = new URL(window.location.href);
  url.hash = selection === null ? '' : formatLineHash(selection);
  window.history.replaceState(null, '', url);
}
