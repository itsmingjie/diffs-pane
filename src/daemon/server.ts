import { constants, createReadStream, existsSync, statSync } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  anchorTextForRange,
  hunkExcerptForRange,
  parsePatch,
  reconstructOldContents,
} from '../shared/patch.js';
import {
  isDiffFilter,
  type ApplyEditsRequest,
  type FileContentsPayload,
  type NewCommentRequest,
  type SaveFileRequest,
  type StatusExport,
  type UpdateCommentRequest,
} from '../shared/protocol.js';
import { checkMutationOrigin, checkTransport, readBody } from './security.js';
import { VcsError } from '../vcs/types.js';
import { type SessionManager, timingSafeEqualString, DEFAULT_OWNER } from './sessions.js';

const UI_DIR = fileURLToPath(new URL('../ui', import.meta.url));

/** Body cap for `PUT api/file` saves; matches the daemon patch size limit. */
const MAX_SAVE_BODY_BYTES = 24 * 1024 * 1024;
/** Full-file hydration duplicates both sides in memory and JSON. Bound it
 * independently from patch size so a one-line diff in a huge file stays safe. */
const MAX_EDIT_FILE_BYTES = Number(
  process.env['DIFFS_PANE_MAX_EDIT_FILE_BYTES'] ?? 10 * 1024 * 1024,
);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

export interface DaemonServer {
  server: Server;
  port: number;
  sessionUrl(token: string): string;
}

export interface ServerOptions {
  controlToken: string;
  manager: SessionManager;
  preferredPort?: number;
}

export async function startServer(options: ServerOptions): Promise<DaemonServer> {
  const { controlToken, manager } = options;
  let port = 0;

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'internal error' });
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const transportError = checkTransport(req, port);
    if (transportError) return sendJson(res, 403, { error: transportError });

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const method = req.method ?? 'GET';

    if (method !== 'GET' && method !== 'HEAD') {
      const originError = checkMutationOrigin(req, port);
      if (originError) return sendJson(res, 403, { error: originError });
    }

    if (url.pathname.startsWith('/control/')) return handleControl(req, res, url, method);

    const match = /^\/s\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
    if (match) {
      const session = manager.byToken(match[1]!);
      if (!session) return sendJson(res, 404, { error: 'unknown session' });
      const subPath = match[2] ?? '';
      if (subPath === '') {
        res.writeHead(302, { location: `/s/${match[1]!}/` });
        res.end();
        return;
      }
      return handleSession(req, res, url, method, session, subPath);
    }

    sendJson(res, 404, { error: 'not found' });
  }

  type SessionType = ReturnType<SessionManager['list']>[number];

  async function handleSession(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    session: SessionType,
    subPath: string,
  ): Promise<void> {
    if (subPath === '/api/session' && method === 'GET') {
      return sendJson(res, 200, session.info());
    }

    if (subPath === '/api/patch' && method === 'GET') {
      const filter = url.searchParams.get('filter') ?? session.defaultFilter;
      if (!isDiffFilter(filter)) return sendJson(res, 400, { error: `invalid filter: ${filter}` });
      return sendJson(res, 200, await session.getPatch(filter));
    }

    if (subPath === '/api/events' && method === 'GET') {
      const filter = url.searchParams.get('filter') ?? session.defaultFilter;
      if (!isDiffFilter(filter)) return sendJson(res, 400, { error: `invalid filter: ${filter}` });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`event: session\ndata: ${JSON.stringify(session.info())}\n\n`);
      res.write(
        `event: comments\ndata: ${JSON.stringify({ comments: session.listComments() })}\n\n`,
      );
      session.addClient(res, filter);
      return;
    }

    if (subPath === '/api/comments' && method === 'GET') {
      return sendJson(res, 200, { comments: session.listComments() });
    }

    if (subPath === '/api/comments' && method === 'POST') {
      const body = await parseJsonBody<NewCommentRequest>(req);
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
      const error = validateNewComment(body);
      if (error) return sendJson(res, 422, { error });

      const patch = await session.getPatch(body.filter);
      const file = parsePatch(patch.patch).find((f) => f.path === body.path);
      if (!file)
        return sendJson(res, 422, { error: `file not in ${body.filter} diff: ${body.path}` });
      const anchorText = anchorTextForRange(file, body.side, body.startLine, body.endLine);
      const hunkExcerpt = hunkExcerptForRange(file, body.side, body.startLine);
      if (anchorText === null || hunkExcerpt === null) {
        return sendJson(res, 422, { error: 'selected lines are not part of the current diff' });
      }
      const comment = session.reviewStore.create({
        ...body,
        anchorText,
        hunkExcerpt,
        patchHash: patch.patchHash,
      });
      session.broadcastComments();
      return sendJson(res, 201, comment);
    }

    if (subPath === '/api/file' && (method === 'GET' || method === 'PUT')) {
      if (method === 'PUT') {
        return session.applyEdits(() => handleFile(req, res, url, method, session));
      }
      return handleFile(req, res, url, method, session);
    }

    if (
      method === 'POST' &&
      (subPath === '/api/edits/commit' || subPath === '/api/edits/discard')
    ) {
      return session.applyEdits(() => handleEdits(req, res, session, subPath.endsWith('/commit')));
    }

    const commentMatch = /^\/api\/comments\/([A-Za-z0-9-]+)$/.exec(subPath);
    if (commentMatch) {
      const id = commentMatch[1]!;
      if (method === 'PATCH') {
        const body = await parseJsonBody<UpdateCommentRequest>(req);
        if (!body || typeof body.body !== 'string' || body.body.trim() === '') {
          return sendJson(res, 400, { error: 'body must be a non-empty string' });
        }
        const updated = session.reviewStore.update(id, body.body);
        if (!updated) return sendJson(res, 404, { error: 'unknown comment' });
        session.broadcastComments();
        return sendJson(res, 200, updated);
      }
      if (method === 'DELETE') {
        if (!session.reviewStore.delete(id))
          return sendJson(res, 404, { error: 'unknown comment' });
        session.broadcastComments();
        return sendJson(res, 200, { ok: true });
      }
    }

    if (method === 'GET' || method === 'HEAD') return serveStatic(res, subPath);
    sendJson(res, 405, { error: 'method not allowed' });
  }

  async function handleEdits(
    req: IncomingMessage,
    res: ServerResponse,
    session: SessionType,
    commit: boolean,
  ): Promise<void> {
    const body = await parseJsonBody<ApplyEditsRequest>(req, MAX_SAVE_BODY_BYTES);
    if (
      !body ||
      !isDiffFilter(body.filter) ||
      !Array.isArray(body.files) ||
      body.files.length === 0 ||
      body.files.some(
        (file) =>
          !file ||
          typeof file.path !== 'string' ||
          typeof file.contents !== 'string' ||
          typeof file.expectedContentsHash !== 'string' ||
          !/^[0-9a-f]{64}$/.test(file.expectedContentsHash),
      ) ||
      new Set(body.files.map((file) => file.path)).size !== body.files.length
    ) {
      return sendJson(res, 400, {
        error: 'filter and unique files with contents and expectedContentsHash are required',
      });
    }
    const opened: Array<{
      handle: FileHandle;
      path: string;
      original: string;
      contents: string;
    }> = [];
    const commitPaths = new Set<string>();
    try {
      const patch = await session.getPatch(body.filter);
      // Validate the entire batch before writing anything, including stale
      // versions, symlinks, and files that are no longer in the diff.
      for (const file of body.files) {
        const summary = patch.files.find((entry) => entry.path === file.path);
        if (!summary || summary.binary || summary.kind === 'deleted') {
          throw new FileAccessError(`file is not editable in this diff: ${file.path}`, 422);
        }
        const abs = resolveWorkTreePath(session.root, file.path);
        if (!abs) throw new FileAccessError(`invalid path: ${file.path}`, 400);
        if (Buffer.byteLength(file.contents) > MAX_EDIT_FILE_BYTES) {
          throw new FileAccessError(`file exceeds the edit limit: ${file.path}`, 413);
        }
        const fileHandle = await openRegularWorkTreeFile(session.root, abs, constants.O_RDWR);
        const entry = {
          handle: fileHandle,
          path: abs,
          original: '',
          contents: file.contents,
        };
        opened.push(entry);
        if ((await fileHandle.stat()).size > MAX_EDIT_FILE_BYTES) {
          throw new FileAccessError(`file exceeds the edit limit: ${file.path}`, 413);
        }
        entry.original = await fileHandle.readFile('utf8');
        if (hashContents(entry.original) !== file.expectedContentsHash) {
          throw new FileAccessError(
            `file changed on disk while you were editing: ${file.path}`,
            409,
          );
        }
        commitPaths.add(file.path);
        if (summary.prevPath) commitPaths.add(summary.prevPath);
      }
      if (commit) {
        try {
          for (const file of opened) await writeFileContents(file.handle, file.contents);
          await session.commitFiles([...commitPaths]);
        } catch (error) {
          if (error instanceof VcsError && error.committed) {
            return sendJson(res, 200, { ok: true, warning: error.message });
          }
          // A rejected commit (e.g. a failing hook) must not strand half-saved
          // drafts. Do not overwrite a concurrent external write on rollback.
          for (const file of opened) {
            const current = await openRegularWorkTreeFile(
              session.root,
              file.path,
              constants.O_RDWR,
            );
            try {
              if ((await current.readFile('utf8')) === file.contents) {
                await writeFileContents(current, file.original);
              }
            } finally {
              await current.close();
            }
          }
          throw error;
        }
      } else {
        await session.discardFiles([...commitPaths]);
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, fileAccessStatus(error), {
        error: error instanceof Error ? error.message : 'Unable to apply local edits',
      });
    } finally {
      await Promise.all(opened.map((file) => file.handle.close()));
    }
  }

  /** Read full file contents and save edited contents. */
  async function handleFile(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    session: SessionType,
  ): Promise<void> {
    if (method === 'GET') {
      const filter = url.searchParams.get('filter') ?? session.defaultFilter;
      if (!isDiffFilter(filter)) return sendJson(res, 400, { error: `invalid filter: ${filter}` });
      const path = url.searchParams.get('path');
      if (!path) return sendJson(res, 400, { error: 'path is required' });

      const patch = await session.getPatch(filter);
      const file = parsePatch(patch.patch).find((f) => f.path === path);
      if (!file) return sendJson(res, 404, { error: `file not in ${filter} diff: ${path}` });
      if (file.binary || file.kind === 'deleted') {
        return sendJson(res, 422, { error: 'file has no editable text contents' });
      }
      const abs = resolveWorkTreePath(session.root, path);
      if (!abs) return sendJson(res, 400, { error: `invalid path: ${path}` });

      let newContents: string;
      try {
        const fileHandle = await openRegularWorkTreeFile(session.root, abs, constants.O_RDONLY);
        try {
          const fileStat = await fileHandle.stat();
          if (fileStat.size > MAX_EDIT_FILE_BYTES) {
            return sendJson(res, 413, {
              error: `file exceeds the ${formatByteLimit(MAX_EDIT_FILE_BYTES)} edit limit`,
            });
          }
          newContents = await fileHandle.readFile('utf8');
        } finally {
          await fileHandle.close();
        }
      } catch (error) {
        return sendJson(res, fileAccessStatus(error), {
          error:
            error instanceof Error ? error.message : 'file changed on disk; retry after refresh',
        });
      }
      let oldContents: string | null = null;
      if (file.kind !== 'added') {
        oldContents = reconstructOldContents(file, newContents);
        if (oldContents === null) {
          return sendJson(res, 409, {
            error: 'work tree changed since the diff was computed; retry after refresh',
          });
        }
      }
      const payload: FileContentsPayload = {
        filter,
        path,
        patchHash: patch.patchHash,
        oldContents,
        newContents,
        newContentsHash: hashContents(newContents),
      };
      return sendJson(res, 200, payload);
    }

    // PUT: save edited contents back to the work tree.
    const body = await parseJsonBody<SaveFileRequest>(req, MAX_SAVE_BODY_BYTES);
    if (
      !body ||
      typeof body.path !== 'string' ||
      typeof body.contents !== 'string' ||
      typeof body.expectedContentsHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(body.expectedContentsHash)
    ) {
      return sendJson(res, 400, {
        error: 'path, contents, and expectedContentsHash are required',
      });
    }
    if (!isDiffFilter(body.filter)) return sendJson(res, 400, { error: 'invalid filter' });
    const summary = (await session.getPatch(body.filter)).files.find((f) => f.path === body.path);
    if (!summary) {
      return sendJson(res, 422, { error: `file not in ${body.filter} diff: ${body.path}` });
    }
    if (summary.binary || summary.kind === 'deleted') {
      return sendJson(res, 422, { error: 'file is not editable' });
    }
    const abs = resolveWorkTreePath(session.root, body.path);
    if (!abs) return sendJson(res, 400, { error: `invalid path: ${body.path}` });
    try {
      const fileHandle = await openRegularWorkTreeFile(session.root, abs, constants.O_RDWR);
      try {
        const currentContents = await fileHandle.readFile('utf8');
        if (hashContents(currentContents) !== body.expectedContentsHash) {
          return sendJson(res, 409, {
            error: 'file changed on disk while you were editing; reload before saving',
          });
        }
        await writeFileContents(fileHandle, body.contents);
      } finally {
        await fileHandle.close();
      }
    } catch (error) {
      return sendJson(res, fileAccessStatus(error), {
        error: error instanceof Error ? error.message : 'file changed on disk; retry after refresh',
      });
    }
    return sendJson(res, 200, { ok: true, contentsHash: hashContents(body.contents) });
  }

  async function handleControl(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
  ): Promise<void> {
    const token = req.headers['x-dp-control-token'];
    if (typeof token !== 'string' || !timingSafeEqualString(token, controlToken)) {
      return sendJson(res, 403, { error: 'invalid control token' });
    }

    if (url.pathname === '/control/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, pid: process.pid });
    }

    if (url.pathname === '/control/status' && method === 'GET') {
      const status: StatusExport = {
        version: 1,
        running: true,
        pid: process.pid,
        port,
        sessions: manager.list().map((s) => ({
          sessionId: s.sessionId,
          root: s.root,
          vcs: s.info().vcs,
          url: sessionUrl(s.token),
          owners: [...s.owners],
          clients: s.clientCount(),
          turn: s.info().turn,
        })),
      };
      return sendJson(res, 200, status);
    }

    if (url.pathname === '/control/sessions/ensure' && method === 'POST') {
      const body = await parseJsonBody<{
        root?: string;
        owner?: string;
        filter?: string;
        base?: string;
        watch?: boolean;
      }>(req);
      if (!body?.root) return sendJson(res, 400, { error: 'root is required' });
      const filter = body.filter;
      if (filter !== undefined && !isDiffFilter(filter)) {
        return sendJson(res, 400, { error: `invalid filter: ${filter}` });
      }
      if (body.watch !== undefined && typeof body.watch !== 'boolean') {
        return sendJson(res, 400, { error: 'watch must be a boolean' });
      }
      try {
        const { session, created } = await manager.ensure(body.root, {
          owner: body.owner ?? DEFAULT_OWNER,
          filter,
          base: body.base,
          watch: body.watch,
        });
        return sendJson(res, 200, {
          url: sessionUrl(session.token),
          sessionId: session.sessionId,
          created,
        });
      } catch (error) {
        return sendJson(res, 422, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (url.pathname === '/control/turn' && method === 'POST') {
      const body = await parseJsonBody<{
        root?: string;
        action?: string;
        session?: string;
        turn?: string;
        agent?: string;
        owner?: string;
      }>(req);
      if (!body?.root || !body.turn || (body.action !== 'start' && body.action !== 'end')) {
        return sendJson(res, 400, { error: 'root, turn, and action=start|end are required' });
      }
      const turnKey = `${body.session ?? 'session'}:${body.turn}`;
      let session = await manager.findByRoot(body.root);
      if (!session && body.action === 'start') {
        session = (await manager.ensure(body.root, { owner: body.owner ?? body.agent ?? 'turn' }))
          .session;
      }
      if (!session) return sendJson(res, 404, { error: 'no session for root' });
      if (body.action === 'start') await session.startTurn(turnKey, body.agent);
      else session.endTurn(turnKey);
      return sendJson(res, 200, { ok: true, sessionId: session.sessionId });
    }

    if (url.pathname === '/control/reviews' && method === 'GET') {
      const root = url.searchParams.get('root');
      if (!root) return sendJson(res, 400, { error: 'root is required' });
      const session = await manager.findByRoot(root);
      if (!session) return sendJson(res, 404, { error: 'no session for root' });
      return sendJson(res, 200, {
        version: 1,
        root: session.root,
        comments: session.listComments(),
      });
    }

    if (url.pathname === '/control/comments/resolve' && method === 'POST') {
      const body = await parseJsonBody<{ root?: string; ids?: string[]; all?: boolean }>(req);
      if (!body?.root || (!Array.isArray(body.ids) && body.all !== true)) {
        return sendJson(res, 400, { error: 'root plus ids[] or all=true are required' });
      }
      const session = await manager.findByRoot(body.root);
      if (!session) return sendJson(res, 404, { error: 'no session for root' });
      const ids =
        body.all === true ? session.listComments().map((comment) => comment.id) : body.ids!;
      const removed = session.reviewStore.deleteMany(ids);
      if (removed > 0) session.broadcastComments();
      return sendJson(res, 200, { ok: true, removed });
    }

    if (url.pathname === '/control/stop' && method === 'POST') {
      const body = await parseJsonBody<{ root?: string; owner?: string; all?: boolean }>(req);
      const owner = body?.owner ?? DEFAULT_OWNER;
      if (body?.all && body.root === undefined) {
        if (body.owner !== undefined) {
          const stopped = await manager.removeOwnerEverywhere(owner);
          return sendJson(res, 200, { ok: true, stoppedSessions: stopped });
        }
        await manager.stopAll();
        return sendJson(res, 200, { ok: true, stoppedSessions: 'all' });
      }
      if (!body?.root) return sendJson(res, 400, { error: 'root is required unless --all' });
      const result = await manager.removeOwner(body.root, owner);
      return sendJson(res, 200, { ok: true, ...result });
    }

    sendJson(res, 404, { error: 'unknown control endpoint' });
  }

  function serveStatic(res: ServerResponse, subPath: string): void {
    const rel = subPath === '/' ? 'index.html' : subPath.replace(/^\//, '');
    const filePath = normalize(join(UI_DIR, rel));
    if (!filePath.startsWith(UI_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      // SPA fallback: unknown paths under the session serve the app shell.
      const index = join(UI_DIR, 'index.html');
      if (!existsSync(index)) {
        return sendJson(res, 404, { error: 'UI assets not built; run `pnpm run build:ui`' });
      }
      res.writeHead(200, { 'content-type': MIME['.html']! });
      createReadStream(index).pipe(res);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': rel.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
    });
    createReadStream(filePath).pipe(res);
  }

  function sessionUrl(token: string): string {
    return `http://127.0.0.1:${port}/s/${token}/`;
  }

  try {
    await listen(server, options.preferredPort ?? 0);
  } catch (error) {
    if (options.preferredPort === undefined || !isAddressInUse(error)) throw error;
    await listen(server, 0);
  }
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('failed to bind');
  port = address.port;

  return { server, port, sessionUrl };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function isAddressInUse(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

/** Resolve a diff-relative path inside the session root, rejecting escapes. */
function resolveWorkTreePath(root: string, relPath: string): string | null {
  if (relPath === '' || relPath.includes('\0') || isAbsolute(relPath)) return null;
  const rootAbs = resolvePath(root);
  const abs = resolvePath(rootAbs, relPath);
  if (abs === rootAbs || !isInside(rootAbs, abs)) return null;
  return abs;
}

/** Open one existing regular file without following its final path component.
 * Resolve both the root and target first so intermediate symlinks cannot lead
 * outside the worktree. */
async function openRegularWorkTreeFile(
  root: string,
  path: string,
  flags: number,
): Promise<FileHandle> {
  const [rootReal, parentReal, pathStat] = await Promise.all([
    realpath(root),
    realpath(dirname(path)),
    lstat(path),
  ]);
  if ((parentReal !== rootReal && !isInside(rootReal, parentReal)) || !pathStat.isFile()) {
    throw new FileAccessError('only regular files inside the worktree are editable', 422);
  }
  const targetReal = await realpath(path);
  if (!isInside(rootReal, targetReal)) {
    throw new FileAccessError('file resolves outside the worktree', 422);
  }
  const handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      throw new FileAccessError('only regular files are editable', 422);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function isInside(root: string, path: string): boolean {
  return path !== root && path.startsWith(root.endsWith(sep) ? root : root + sep);
}

class FileAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function fileAccessStatus(error: unknown): number {
  if (error instanceof FileAccessError) return error.status;
  if (error instanceof Error && 'code' in error && error.code === 'ELOOP') return 422;
  return 409;
}

function hashContents(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function writeFileContents(handle: FileHandle, contents: string): Promise<void> {
  const bytes = Buffer.from(contents);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    offset += bytesWritten;
  }
  await handle.truncate(bytes.length);
}

function formatByteLimit(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function parseJsonBody<T>(req: IncomingMessage, maxBytes?: number): Promise<T | null> {
  try {
    const raw = await readBody(req, maxBytes);
    if (raw.length === 0) return {} as T;
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    return null;
  }
}

function validateNewComment(body: NewCommentRequest): string | null {
  if (!isDiffFilter(body.filter)) return 'invalid filter';
  if (typeof body.path !== 'string' || body.path === '') return 'path is required';
  if (body.side !== 'additions' && body.side !== 'deletions')
    return 'side must be additions or deletions';
  if (
    !Number.isInteger(body.startLine) ||
    !Number.isInteger(body.endLine) ||
    body.startLine < 1 ||
    body.endLine < body.startLine
  ) {
    return 'invalid line range';
  }
  if (typeof body.body !== 'string' || body.body.trim() === '') return 'comment body is required';
  return null;
}
