import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import { parsePatch, reconstructOldContents } from '../shared/patch.js';
import type {
  ApplyEditsRequest,
  DiffFilter,
  FileContentsPayload,
  PatchPayload,
} from '../shared/protocol.js';
import { VcsError } from '../vcs/types.js';

const MAX_EDIT_FILE_BYTES = Number(
  process.env['DIFFS_PANE_MAX_EDIT_FILE_BYTES'] ?? 10 * 1024 * 1024,
);

interface EditTarget {
  root: string;
  getPatch(filter: DiffFilter): Promise<PatchPayload>;
  commitFiles(paths: string[]): Promise<void>;
  discardFiles(paths: string[]): Promise<void>;
}

interface OpenedEdit {
  handle: FileHandle;
  path: string;
  original: string;
  contents: string;
}

export interface ApplyEditsResult {
  ok: true;
  warning?: string;
}

export class EditError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function editErrorStatus(error: unknown): number {
  if (error instanceof EditError) return error.status;
  if (error instanceof Error && 'code' in error && error.code === 'ELOOP') return 422;
  return 409;
}

export async function readEditableFile(
  target: EditTarget,
  filter: DiffFilter,
  path: string,
): Promise<FileContentsPayload> {
  const patch = await target.getPatch(filter);
  const file = parsePatch(patch.patch).find((entry) => entry.path === path);
  if (!file) throw new EditError(`file not in ${filter} diff: ${path}`, 404);
  if (file.binary || file.kind === 'deleted') {
    throw new EditError('file has no editable text contents', 422);
  }

  const absolutePath = resolveWorkTreePath(target.root, path);
  if (!absolutePath) throw new EditError(`invalid path: ${path}`, 400);

  const handle = await openRegularWorkTreeFile(target.root, absolutePath, constants.O_RDONLY);
  let newContents: string;
  try {
    if ((await handle.stat()).size > MAX_EDIT_FILE_BYTES) {
      throw new EditError(
        `file exceeds the ${Math.round(MAX_EDIT_FILE_BYTES / 1024 / 1024)}MB edit limit`,
        413,
      );
    }
    newContents = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }

  const oldContents = file.kind === 'added' ? null : reconstructOldContents(file, newContents);
  if (file.kind !== 'added' && oldContents === null) {
    throw new EditError('work tree changed since the diff was computed; retry after refresh', 409);
  }

  return {
    filter,
    path,
    patchHash: patch.patchHash,
    oldContents,
    newContents,
    newContentsHash: hashContents(newContents),
  };
}

export async function applyEdits(
  target: EditTarget,
  request: ApplyEditsRequest,
  action: 'commit' | 'discard',
): Promise<ApplyEditsResult> {
  const opened: OpenedEdit[] = [];
  const vcsPaths = new Set<string>();
  try {
    const patch = await target.getPatch(request.filter);
    const summaries = new Map(patch.files.map((file) => [file.path, file]));

    // Open and validate the whole batch before changing the work tree.
    for (const edit of request.files) {
      const summary = summaries.get(edit.path);
      if (!summary || summary.binary || summary.kind === 'deleted') {
        throw new EditError(`file is not editable in this diff: ${edit.path}`, 422);
      }
      if (Buffer.byteLength(edit.contents) > MAX_EDIT_FILE_BYTES) {
        throw new EditError(`file exceeds the edit limit: ${edit.path}`, 413);
      }

      const absolutePath = resolveWorkTreePath(target.root, edit.path);
      if (!absolutePath) throw new EditError(`invalid path: ${edit.path}`, 400);
      const handle = await openRegularWorkTreeFile(target.root, absolutePath, constants.O_RDWR);
      try {
        if ((await handle.stat()).size > MAX_EDIT_FILE_BYTES) {
          throw new EditError(`file exceeds the edit limit: ${edit.path}`, 413);
        }
        const original = await handle.readFile('utf8');
        if (hashContents(original) !== edit.expectedContentsHash) {
          throw new EditError(`file changed on disk while you were editing: ${edit.path}`, 409);
        }
        opened.push({ handle, path: absolutePath, original, contents: edit.contents });
      } catch (error) {
        await handle.close();
        throw error;
      }

      vcsPaths.add(edit.path);
      if (summary.prevPath) vcsPaths.add(summary.prevPath);
    }

    if (action === 'discard') {
      await target.discardFiles([...vcsPaths]);
      return { ok: true };
    }

    try {
      for (const edit of opened) await writeFileContents(edit.handle, edit.contents);
      await target.commitFiles([...vcsPaths]);
      return { ok: true };
    } catch (error) {
      if (error instanceof VcsError && error.committed) {
        return { ok: true, warning: error.message };
      }
      await rollbackWrites(target.root, opened);
      throw error;
    }
  } finally {
    await Promise.all(opened.map(({ handle }) => handle.close()));
  }
}

async function rollbackWrites(root: string, edits: OpenedEdit[]): Promise<void> {
  await Promise.all(
    edits.map(async (edit) => {
      const handle = await openRegularWorkTreeFile(root, edit.path, constants.O_RDWR);
      try {
        // Do not overwrite an external write that raced with the failed commit.
        if ((await handle.readFile('utf8')) === edit.contents) {
          await writeFileContents(handle, edit.original);
        }
      } finally {
        await handle.close();
      }
    }),
  );
}

function resolveWorkTreePath(root: string, relativePath: string): string | null {
  if (relativePath === '' || relativePath.includes('\0') || isAbsolute(relativePath)) return null;
  const rootAbsolute = resolve(root);
  const absolutePath = resolve(rootAbsolute, relativePath);
  return isInside(rootAbsolute, absolutePath) ? absolutePath : null;
}

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
    throw new EditError('only regular files inside the worktree are editable', 422);
  }
  if (!isInside(rootReal, await realpath(path))) {
    throw new EditError('file resolves outside the worktree', 422);
  }

  const handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) {
      throw new EditError('only regular files are editable', 422);
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
