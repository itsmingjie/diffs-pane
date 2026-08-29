import { resolve } from 'node:path';

import { controlRequest } from '../control/client.js';
import {
  isDiffFilter,
  type ExportedComment,
  type ReviewComment,
  type ReviewsExport,
  type StatusExport,
} from '../shared/protocol.js';
import { DIFF_THEMES, FONT_SIZES, isDiffTheme, LINE_HEIGHTS } from '../shared/themes.js';
import { readReviews, ReviewStore } from '../store/reviews.js';
import { detectBackend } from '../vcs/detect.js';
import { parseArgs, stringFlag, type ParsedArgs } from './args.js';
import { ensureDaemon, healthyDaemon } from './daemon.js';

const VALUE_FLAGS = new Set([
  'filter',
  'root',
  'base',
  'owner',
  'theme',
  'font-family',
  'font-size',
  'line-height',
  'session',
  'turn',
  'agent',
]);

const USAGE = `Usage:
  dp <command> [options]

Commands:
  watch [branch|unstaged|turn]  Start or reuse a diff session (defaults to branch).
  themes                        List available viewer themes.
  reviews [--json]              Export review comments for the working tree.
  resolve <id>... | --all       Delete addressed review comments.
  turn start|end                Start or finish an agent-turn diff baseline.
  status [--json]               Show daemon and session status.
  stop [--all]                  Release session leases and stop unused sessions.

Watch options:
  --no-watch                    Disable live filesystem updates.
  --root <path>                 Use another working tree (defaults to cwd).
  --base <rev>                  Override the branch comparison base.
  --owner <name>                Hold a named session lease.
  --theme <name>                Open with a viewer theme (run dp themes to list).
  --font-family <name>          Open with a code font family.
  --font-size <px>              Open with a code font size.
  --line-height <px>            Open with a code line height.

Bare dp is equivalent to dp watch branch. Run dp <command> --help for this help.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), VALUE_FLAGS);
  if (args.flags.has('help')) {
    process.stdout.write(USAGE);
    return;
  }
  const command = args.positional[0] ?? 'watch';

  switch (command) {
    case 'watch':
      return watch(args);
    case 'reviews':
      return reviews(args);
    case 'resolve':
      return resolveComments(args);
    case 'themes':
      return listThemes();
    case 'turn':
      return turn(args);
    case 'status':
      return status(args);
    case 'stop':
      return stop(args);
    default:
      process.stderr.write(USAGE);
      process.exitCode = 2;
  }
}

function rootArg(args: ParsedArgs): string {
  return resolve(stringFlag(args, 'root') ?? process.cwd());
}

async function watch(args: ParsedArgs): Promise<void> {
  if (args.positional.length > 2) throw new Error(`too many arguments for dp watch\n${USAGE}`);
  const positionalFilter = args.positional[0] === 'watch' ? args.positional[1] : undefined;
  const flagFilter = stringFlag(args, 'filter');
  if (positionalFilter !== undefined && flagFilter !== undefined) {
    throw new Error('choose a positional filter or --filter, not both');
  }
  const filter = positionalFilter ?? flagFilter ?? 'branch';
  if (!isDiffFilter(filter)) {
    throw new Error(`invalid --filter: ${filter} (expected turn|unstaged|branch)`);
  }
  if (args.flags.get('theme') === true) throw new Error('--theme requires a value');
  const theme = stringFlag(args, 'theme');
  if (theme !== undefined && !isDiffTheme(theme)) {
    throw new Error(`invalid --theme: ${theme} (run dp themes to list available themes)`);
  }
  const fontFamily = requiredStringFlag(args, 'font-family');
  const fontSize = choiceFlag(args, 'font-size', FONT_SIZES);
  const lineHeight = choiceFlag(args, 'line-height', LINE_HEIGHTS);
  const info = await ensureDaemon();
  const result = await controlRequest<{ url: string }>(info, 'POST', '/control/sessions/ensure', {
    root: rootArg(args),
    owner: stringFlag(args, 'owner'),
    filter,
    base: stringFlag(args, 'base'),
    watch: !args.flags.has('no-watch'),
  });
  // Contract: print only the live URL to stdout.
  const url = new URL(result.url);
  if (theme !== undefined) url.searchParams.set('theme', theme);
  if (fontFamily !== undefined) url.searchParams.set('font-family', fontFamily);
  if (fontSize !== undefined) url.searchParams.set('font-size', String(fontSize));
  if (lineHeight !== undefined) url.searchParams.set('line-height', String(lineHeight));
  process.stdout.write(`${url.toString()}\n`);
}

function requiredStringFlag(args: ParsedArgs, name: string): string | undefined {
  const raw = args.flags.get(name);
  if (raw === true || raw === '') throw new Error(`--${name} requires a value`);
  return raw;
}

function choiceFlag<const T extends readonly number[]>(
  args: ParsedArgs,
  name: string,
  choices: T,
): T[number] | undefined {
  const raw = requiredStringFlag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!choices.includes(value as T[number])) {
    throw new Error(`invalid --${name}: ${raw} (expected ${choices.join('|')})`);
  }
  return value as T[number];
}

function listThemes(): void {
  for (const theme of DIFF_THEMES) {
    process.stdout.write(`${theme.value}\t${theme.label}\n`);
  }
}

async function reviews(args: ParsedArgs): Promise<void> {
  const root = rootArg(args);
  // Canonicalize like the daemon does so both read the same store.
  let canonical = root;
  try {
    canonical = (await detectBackend(root)).root;
  } catch {
    // Not a working tree: fall back to the resolved path.
  }
  const comments = await readReviews(canonical);

  if (args.flags.has('json')) {
    const sessionUrl = await liveSessionUrl(canonical);
    const out: ReviewsExport = {
      version: 1,
      root: canonical,
      ...(sessionUrl !== undefined ? { sessionUrl } : {}),
      comments: comments.map((c) => exportComment(c, sessionUrl)),
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatTaggedReviews(comments));
}

/** URL of the live session for a root, when the daemon currently serves it. */
async function liveSessionUrl(root: string): Promise<string | undefined> {
  const info = await healthyDaemon();
  if (!info) return undefined;
  try {
    const daemonStatus = await controlRequest<StatusExport>(info, 'GET', '/control/status');
    return daemonStatus.sessions.find((s) => s.root === root)?.url;
  } catch {
    return undefined;
  }
}

function exportComment(comment: ReviewComment, sessionUrl: string | undefined): ExportedComment {
  if (sessionUrl === undefined || comment.outdated) return comment;
  return { ...comment, url: commentUrl(sessionUrl, comment) };
}

/** Deep link matching the UI's line-hash format (#target=f:<path>&start=A12). */
function commentUrl(sessionUrl: string, comment: ReviewComment): string {
  const sigil = comment.side === 'deletions' ? 'D' : 'A';
  const target = encodeURIComponent(`f:${comment.path}`).replaceAll('%2F', '/');
  const params = [`target=${target}`, `start=${sigil}${comment.startLine}`];
  if (comment.endLine !== comment.startLine) params.push(`end=${sigil}${comment.endLine}`);
  return `${sessionUrl}#${params.join('&')}`;
}

function formatTaggedReviews(comments: ReviewComment[]): string {
  if (comments.length === 0) return 'No review comments.\n';
  const blocks = comments.map((c) => {
    const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
    const outdated = c.outdated ? ', outdated' : '';
    return [
      `<File>${c.path}:${range} (${c.side}, ${c.filter}${outdated})</File>`,
      `<Comment>\n${c.body}\n</Comment>`,
      `<Diff>\n${c.hunkExcerpt}\n</Diff>`,
    ].join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}

/** Delete addressed review comments so the next `dp reviews` run is clean. */
async function resolveComments(args: ParsedArgs): Promise<void> {
  const ids = args.positional.slice(1);
  const all = args.flags.has('all');
  if (ids.length === 0 && !all) {
    throw new Error(`dp resolve requires comment ids or --all\n${USAGE}`);
  }
  const root = rootArg(args);
  let canonical = root;
  try {
    canonical = (await detectBackend(root)).root;
  } catch {
    // Not a working tree: fall back to the resolved path.
  }

  // Prefer the daemon so open viewers update live; fall back to the store.
  const info = await healthyDaemon();
  if (info) {
    try {
      const result = await controlRequest<{ removed: number }>(
        info,
        'POST',
        '/control/comments/resolve',
        {
          root: canonical,
          ids: all ? undefined : ids,
          all,
        },
      );
      process.stdout.write(
        `resolved ${result.removed} comment${result.removed === 1 ? '' : 's'}\n`,
      );
      return;
    } catch {
      // No live session for this root; fall through to the on-disk store.
    }
  }
  const store = await ReviewStore.load(canonical);
  const targets = all ? store.list().map((comment) => comment.id) : ids;
  const removed = store.deleteMany(targets);
  process.stdout.write(`resolved ${removed} comment${removed === 1 ? '' : 's'}\n`);
}

async function turn(args: ParsedArgs): Promise<void> {
  const action = args.positional[1];
  if (action !== 'start' && action !== 'end') {
    throw new Error(`dp turn requires start|end\n${USAGE}`);
  }
  const sessionId = stringFlag(args, 'session');
  const turnId = stringFlag(args, 'turn');
  if (!sessionId || !turnId) throw new Error('--session and --turn are required');

  // Turn end without a daemon is a no-op: there is nothing to update.
  const info = action === 'start' ? await ensureDaemon() : await healthyDaemon();
  if (!info) return;
  await controlRequest(info, 'POST', '/control/turn', {
    root: rootArg(args),
    action,
    session: sessionId,
    turn: turnId,
    agent: stringFlag(args, 'agent'),
    owner: stringFlag(args, 'owner'),
  });
}

async function status(args: ParsedArgs): Promise<void> {
  const info = await healthyDaemon();
  if (!info) {
    if (args.flags.has('json')) {
      const out: StatusExport = { version: 1, running: false, sessions: [] };
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    } else {
      process.stdout.write('daemon: not running\n');
    }
    return;
  }
  const result = await controlRequest<StatusExport>(info, 'GET', '/control/status');
  if (args.flags.has('json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`daemon: running (pid ${result.pid}, port ${result.port})\n`);
  for (const s of result.sessions) {
    process.stdout.write(
      `  ${s.root}\n    url: ${s.url}\n    vcs: ${s.vcs}  owners: ${s.owners.join(', ') || '-'}  clients: ${s.clients}\n`,
    );
    if (s.turn) {
      process.stdout.write(`    turn: ${s.turn.turnId}${s.turn.active ? ' (active)' : ''}\n`);
    }
  }
}

async function stop(args: ParsedArgs): Promise<void> {
  const info = await healthyDaemon();
  if (!info) {
    process.stdout.write('daemon: not running\n');
    return;
  }
  const body: Record<string, unknown> = {
    owner: stringFlag(args, 'owner'),
    all: args.flags.has('all'),
  };
  if (!args.flags.has('all') || args.flags.has('root')) body['root'] = rootArg(args);
  await controlRequest(info, 'POST', '/control/stop', body);
}

main().catch((error: unknown) => {
  process.stderr.write(`dp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
