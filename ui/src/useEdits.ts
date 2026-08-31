import {
  parseDiffFromFile,
  type CodeViewItem,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  type LineAnnotation,
} from '@pierre/diffs';
import type { Editor } from '@pierre/diffs/edit';
import { useStableCallback, type CreateEditor } from '@pierre/diffs/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  DiffFilter,
  FileContentsPayload,
  PatchFileSummary,
  PatchPayload,
} from '../../src/shared/protocol';
import type { AnnotationMeta, DiffAnnotation } from './annotations';
import * as api from './api';
import type { ParsedFile } from './usePatchModel';

interface EditModule {
  Editor: typeof Editor;
}

let editModule: EditModule | undefined;
let editModulePromise: Promise<EditModule> | undefined;

async function loadEditModule(): Promise<void> {
  if (editModule) return;
  try {
    editModule = await (editModulePromise ??= import('@pierre/diffs/edit'));
  } catch (error) {
    editModulePromise = undefined;
    throw error;
  }
}

export const createEditor: CreateEditor<AnnotationMeta> = (options) => {
  if (!editModule) throw new Error('Editor module has not loaded');
  return new editModule.Editor(options);
};

interface EditBase {
  path: string;
  fileDiff: FileDiffMetadata;
  sectionHash: string;
  summary: PatchFileSummary;
  file: FileContents;
  liveDiff: FileDiffMetadata;
  annotations: DiffAnnotation[];
}

interface PendingEdit extends EditBase {
  status: 'loading';
}

interface ReadyEdit extends EditBase {
  status: 'ready';
  original: FileContentsPayload;
}

export type LocalEdit = PendingEdit | ReadyEdit;

interface PendingChange {
  item: CodeViewItem<AnnotationMeta>;
  file: FileContents;
  annotations?: LineAnnotation<AnnotationMeta>[] | DiffLineAnnotation<AnnotationMeta>[];
}

interface UseEditsOptions {
  activeFilter: DiffFilter;
  patch: PatchPayload | null;
  parsedFiles: ParsedFile[];
  annotationsByPath: ReadonlyMap<string, DiffAnnotation[]>;
  loadPatch(filter: DiffFilter): Promise<void>;
  prepareForRefresh(): void;
  onEditStart(path: string): void;
}

export function useEdits({
  activeFilter,
  patch,
  parsedFiles,
  annotationsByPath,
  loadPatch,
  prepareForRefresh,
  onEditStart,
}: UseEditsOptions) {
  const [edits, setEdits] = useState<ReadonlyMap<string, LocalEdit>>(new Map());
  const [pendingAction, setPendingAction] = useState<'commit' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingCount, setLoadingCount] = useState(0);
  const [editorReady, setEditorReady] = useState(editModule !== undefined);

  const editsRef = useRef(new Map<string, LocalEdit>());
  const actionPendingRef = useRef(false);
  const requestsRef = useRef(new WeakMap<FileDiffMetadata, Promise<FileContentsPayload>>());
  const payloadsRef = useRef(new WeakMap<FileDiffMetadata, FileContentsPayload>());

  const summariesByPath = useMemo(
    () => new Map((patch?.files ?? []).map((summary) => [summary.path, summary])),
    [patch?.files],
  );
  const parsedByPath = useMemo(
    () => new Map(parsedFiles.map((file) => [file.path, file])),
    [parsedFiles],
  );
  const hasEditableFiles = (patch?.files ?? []).some(
    (file) => !file.binary && file.kind !== 'deleted',
  );

  useEffect(() => {
    if (!hasEditableFiles || editorReady) return;
    // The effect owns the loading state for this import.
    // oxlint-disable-next-line react/set-state-in-effect
    setLoadingCount((count) => count + 1);
    void loadEditModule()
      .then(() => setEditorReady(true))
      .catch((loadError: unknown) => {
        setError(
          `Failed to load the editor: ${loadError instanceof Error ? loadError.message : String(loadError)}`,
        );
      })
      .finally(() => setLoadingCount((count) => Math.max(0, count - 1)));
  }, [editorReady, hasEditableFiles]);

  const reset = useStableCallback(() => {
    editsRef.current.clear();
    requestsRef.current = new WeakMap();
    payloadsRef.current = new WeakMap();
    setEdits(new Map());
    setError(null);
  });

  const fetchContents = useStableCallback(
    (fileDiff: FileDiffMetadata, path: string): Promise<FileContentsPayload> => {
      let request = requestsRef.current.get(fileDiff);
      if (request) return request;

      const expectedPatchHash = patch?.patchHash ?? '';
      setLoadingCount((count) => count + 1);
      request = api
        .fetchFileContents(activeFilter, path)
        .then((payload) => {
          if (payload.patchHash !== expectedPatchHash) {
            throw new Error('diff changed while the file was loading; try again');
          }
          payloadsRef.current.set(fileDiff, payload);
          return payload;
        })
        .finally(() => setLoadingCount((count) => Math.max(0, count - 1)));
      requestsRef.current.set(fileDiff, request);
      void request.catch(() => requestsRef.current.delete(fileDiff));
      return request;
    },
  );

  const loadDiffFiles = useStableCallback(async (fileDiff: FileDiffMetadata) => {
    try {
      const payload = await fetchContents(fileDiff, fileDiff.name);
      const cachePrefix = `${payload.patchHash.slice(0, 16)}:${fileDiff.name}`;
      const newFile: FileContents = {
        name: fileDiff.name,
        contents: payload.newContents,
        cacheKey: `${cachePrefix}:new`,
      };
      return payload.oldContents === null
        ? { oldFile: null, newFile }
        : {
            oldFile: {
              name: fileDiff.prevName ?? fileDiff.name,
              contents: payload.oldContents,
              cacheKey: `${cachePrefix}:old`,
            },
            newFile,
          };
    } catch (loadError) {
      setError(
        `Failed to load ${fileDiff.name} for editing: ${loadError instanceof Error ? loadError.message : String(loadError)}`,
      );
      throw loadError;
    }
  });

  const updateEdit = useStableCallback(function updateEdit(path: string, change: PendingChange) {
    if (change.item.type !== 'diff' || actionPendingRef.current) return;
    const { fileDiff } = change.item;
    const previous = editsRef.current.get(path);
    const parsed = parsedByPath.get(path);
    const summary = previous?.summary ?? summariesByPath.get(path);
    if (!summary || (!previous && !parsed)) return;
    const original = payloadsRef.current.get(fileDiff);

    const next = new Map(editsRef.current);
    if (original && change.file.contents === original.newContents) {
      next.delete(path);
    } else {
      const base = {
        path,
        fileDiff: previous?.fileDiff ?? fileDiff,
        sectionHash: previous?.sectionHash ?? parsed!.sectionHash,
        summary,
        file: { ...change.file },
        annotations: annotationsForEdit(change, previous, annotationsByPath.get(path)),
      };
      next.set(
        path,
        original
          ? {
              ...base,
              status: 'ready',
              original,
              liveDiff: parseDiffFromFile(
                original.oldContents === null
                  ? null
                  : { name: summary.prevPath ?? path, contents: original.oldContents },
                change.file,
              ),
            }
          : { ...base, status: 'loading', liveDiff: previous?.liveDiff ?? fileDiff },
      );
      if (!previous) onEditStart(path);
      if (!original) {
        // Hydrate the baseline in the background; the stored edit already
        // carries the latest contents, so replay from it once loaded.
        void fetchContents(fileDiff, path)
          .then(() => {
            const current = editsRef.current.get(path);
            if (current?.status === 'loading') {
              updateEdit(path, { item: change.item, file: current.file });
            }
          })
          .catch((loadError: unknown) => {
            setError(
              `Failed to prepare ${path} for saving: ${loadError instanceof Error ? loadError.message : String(loadError)}`,
            );
          });
      }
    }
    editsRef.current = next;
    setEdits(next);
  });

  const onItemEditChange = useStableCallback(
    (
      item: CodeViewItem<AnnotationMeta>,
      file: FileContents,
      annotations?: LineAnnotation<AnnotationMeta>[] | DiffLineAnnotation<AnnotationMeta>[],
    ) => updateEdit(item.id.slice(2), { item, file, annotations }),
  );

  const applyLocalEdits = useStableCallback(async (action: 'commit' | 'discard') => {
    if (actionPendingRef.current || editsRef.current.size === 0) return;
    if (
      action === 'discard' &&
      !window.confirm(
        'Restore dp-edited files to their committed version? This also discards existing uncommitted changes in those files.',
      )
    ) {
      return;
    }

    actionPendingRef.current = true;
    setPendingAction(action);
    setError(null);
    try {
      const files = (
        await Promise.all(
          [...editsRef.current.values()].map(async (edit) => {
            const original =
              edit.status === 'ready'
                ? edit.original
                : await fetchContents(edit.fileDiff, edit.path);
            if (edit.file.contents === original.newContents) return null;
            return {
              path: edit.path,
              contents: edit.file.contents,
              expectedContentsHash: original.newContentsHash,
            };
          }),
        )
      ).filter((file): file is NonNullable<typeof file> => file !== null);
      if (files.length === 0) {
        editsRef.current.clear();
        setEdits(new Map());
        return;
      }
      const result = await api.applyEdits(action, { filter: activeFilter, files });
      prepareForRefresh();
      editsRef.current.clear();
      setEdits(new Map());
      requestsRef.current = new WeakMap();
      payloadsRef.current = new WeakMap();
      await loadPatch(activeFilter);
      if (result.warning) setError(result.warning);
    } catch (applyError) {
      setError(
        `Failed to ${action}: ${applyError instanceof Error ? applyError.message : String(applyError)}`,
      );
    } finally {
      actionPendingRef.current = false;
      setPendingAction(null);
    }
  });

  const dirtyPaths = useMemo(() => new Set(edits.keys()), [edits]);
  useEffect(() => {
    if (dirtyPaths.size === 0) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [dirtyPaths.size]);

  return {
    edits,
    dirtyPaths,
    reset,
    pendingAction,
    error,
    loading: loadingCount > 0,
    editorReady,
    loadDiffFiles,
    onItemEditChange,
    applyLocalEdits,
  };
}

function annotationsForEdit(
  change: PendingChange,
  previous: LocalEdit | undefined,
  fallback: DiffAnnotation[] | undefined,
): DiffAnnotation[] {
  return (change.annotations ?? previous?.annotations ?? fallback ?? []).filter(
    (annotation) => annotation.metadata?.kind !== 'draft',
  ) as DiffAnnotation[];
}
