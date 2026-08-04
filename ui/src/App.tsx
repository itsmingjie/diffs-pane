import { ChevronDownIcon, Pencil1Icon } from '@radix-ui/react-icons';
import {
  parsePatchFiles,
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  type LineAnnotation,
  type SelectedLineRange,
} from '@pierre/diffs';
import type { Editor, EditorOptions } from '@pierre/diffs/edit';
import {
  CodeView,
  EditProvider,
  useStableCallback,
  useWorkerPool,
  type CodeViewHandle,
  type CreateEditor,
} from '@pierre/diffs/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { flushSync } from 'react-dom';

import type {
  DiffFilter,
  FileContentsPayload,
  PatchFileSummary,
  PatchPayload,
  ReviewComment,
  SessionInfo,
} from '../../src/shared/protocol';
import * as api from './api';
import {
  annotationsKey,
  buildAnnotations,
  type AnnotationMeta,
  type DiffAnnotation,
  type DraftComment,
} from './annotations';
import { CommentCard } from './components/CommentCard';
import { Sidebar } from './components/Sidebar';
import { Toolbar, type ViewSettings } from './components/Toolbar';
import { parseLineHash, syncLineHash } from './lineHash';
import { codeViewTheme, fontSettingsFromSearch, syncTheme, themeFromSearch } from './themes';

type Connection = 'connected' | 'connecting' | 'reconnecting' | 'ended';

const NARROW_VIEW_QUERY = '(max-width: 767px)';
const CODE_VIEW_LAYOUT = { paddingTop: 4, gap: 1, paddingBottom: 16 };
const CODE_VIEW_UNSAFE_CSS = `
  [data-diffs-header][data-sticky] {
    top: 4px;
  }

  [data-diffs-header][data-sticky]::before {
    content: '';
    position: absolute;
    inset: -4px 0 100%;
    background: var(--diffs-bg);
    pointer-events: none;
  }
`;

interface EditModule {
  Editor: typeof Editor;
}

let editModule: EditModule | undefined;
let editModulePromise: Promise<EditModule> | undefined;

/** Load the optional editor only when someone starts editing. */
async function loadEditModule(): Promise<EditModule> {
  if (editModule) return editModule;
  try {
    editModule = await (editModulePromise ??= import('@pierre/diffs/edit'));
    return editModule;
  } catch (error) {
    editModulePromise = undefined;
    throw error;
  }
}

/** One stable provider factory; edit sessions start only after the module loads. */
const createEditor: CreateEditor<AnnotationMeta> = (options) => {
  if (!editModule) throw new Error('Editor module has not loaded');
  return new editModule.Editor(options);
};

const EDITOR_OPTIONS: Omit<EditorOptions<AnnotationMeta>, 'onChange'> = {
  onAttach(editor) {
    editor.focus({ lineNumber: 'first-visible', preventScroll: true });
  },
};

const IS_MAC = /Mac|iP/.test(navigator.platform);
const SAVE_SHORTCUT_LABEL = IS_MAC ? '⌘S' : 'Ctrl+S';

/** Safety window for a post-save patch refresh. User scroll gestures release
 * the pin immediately. */
const SCROLL_ANCHOR_WINDOW_MS = 5000;

const KIND_BADGE: Record<PatchFileSummary['kind'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

interface ParsedFile {
  path: string;
  fileDiff: FileDiffMetadata;
}

/** One live per-file edit session. Its item stays frozen across patch
 * refreshes so the editor's document and history survive until save/discard. */
interface EditSession {
  /** Diff model captured at edit start; hydration mutates it in place. */
  fileDiff: FileDiffMetadata;
  /** Annotation collection the editor remaps as lines move. */
  annotations: DiffAnnotation[];
  /** Bumped whenever the session's item must re-render. */
  rev: number;
}

export function App() {
  const workerPool = useWorkerPool();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<DiffFilter | null>(null);
  const [patch, setPatch] = useState<PatchPayload | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [draft, setDraft] = useState<DraftComment | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [view, setView] = useState<ViewSettings>(() => ({
    diffStyle: 'split',
    overflow: 'scroll',
    theme: themeFromSearch(window.location.search),
    ...fontSettingsFromSearch(window.location.search),
  }));
  const [narrowView, setNarrowView] = useState(() => window.matchMedia(NARROW_VIEW_QUERY).matches);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia(NARROW_VIEW_QUERY).matches,
  );
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const [editSessions, setEditSessions] = useState<ReadonlyMap<string, EditSession>>(new Map());
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingCount, setSavingCount] = useState(0);
  const [editorLoadingCount, setEditorLoadingCount] = useState(0);

  const viewerRef = useRef<CodeViewHandle<AnnotationMeta> | null>(null);
  /** Latest edited contents per path, fed by onItemEditChange. */
  const editedFilesRef = useRef(new Map<string, FileContents>());
  /** Guards against repeated Save clicks and key-repeat issuing duplicate writes. */
  const savingPathsRef = useRef(new Set<string>());
  const loadingEditorPathsRef = useRef(new Set<string>());
  const fileContentsByDiffRef = useRef(
    new WeakMap<FileDiffMetadata, Promise<FileContentsPayload>>(),
  );
  const expectedContentsHashesRef = useRef(new Map<string, string>());
  const editRevisionsRef = useRef(new Map<string, number>());
  /** Viewport pin captured when an edit session ends, held across the exit
   * re-render and the follow-up patch refresh. */
  const scrollAnchorRef = useRef<{
    /** Item at the top of the viewport when the session ended. */
    id?: string;
    /** scrollTop relative to that item's top; NaN when no item was measured. */
    offset: number;
    scrollTop: number;
    patchHash: string;
    waitForPatch: boolean;
    until: number;
  } | null>(null);
  const patchHashRef = useRef<string | null>(null);
  const pendingHashTargetRef = useRef<CodeViewLineSelection | null>(
    parseLineHash(window.location.hash),
  );
  const activeFilter = filter ?? session?.defaultFilter ?? 'branch';
  const activeFilterRef = useRef(activeFilter);
  activeFilterRef.current = activeFilter;
  const effectiveDiffStyle = narrowView ? 'unified' : view.diffStyle;

  useEffect(() => syncTheme(view.theme), [view.theme]);

  useEffect(() => {
    void workerPool?.setRenderOptions({ theme: codeViewTheme(view.theme) });
  }, [view.theme, workerPool]);

  useEffect(() => {
    const query = window.matchMedia(NARROW_VIEW_QUERY);
    const update = (matches: boolean) => {
      setNarrowView(matches);
      if (matches) setSidebarOpen(false);
    };
    const handleChange = (event: MediaQueryListEvent) => update(event.matches);
    update(query.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (!narrowView || !sidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [narrowView, sidebarOpen]);

  // ── Initial load ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await api.fetchSession();
        if (cancelled) return;
        setSession(info);
        setFilter((current) => current ?? info.defaultFilter);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadPatch = useCallback(async (target: DiffFilter) => {
    try {
      const payload = await api.fetchPatch(target);
      patchHashRef.current = payload.patchHash;
      setPatch(payload);
    } catch (error) {
      setPatch({
        filter: target,
        patchHash: 'load-error',
        patch: '',
        files: [],
        error: error instanceof Error ? error.message : String(error),
        generatedAt: new Date().toISOString(),
      });
    }
  }, []);

  // ── Live events (per viewed filter) ──────────────────────────────────
  const sessionReady = session !== null;
  useEffect(() => {
    if (!sessionReady || filter === null) return;
    let opened = false;
    setConnection('connecting');
    patchHashRef.current = null;
    void loadPatch(filter);

    const close = api.openEvents(filter, {
      onOpen: () => {
        setConnection('connected');
        if (opened) {
          // Reconnected: catch up on anything missed while offline.
          void loadPatch(filter);
        }
        opened = true;
      },
      onDisconnect: () => setConnection('reconnecting'),
      onEnd: () => setConnection('ended'),
      onSession: setSession,
      onComments: setComments,
      onPatch: (event) => {
        if (event.filter === filter && event.patchHash !== patchHashRef.current) {
          void loadPatch(filter);
        }
      },
    });
    return close;
  }, [sessionReady, filter, loadPatch]);

  // Drafts, selections, and edit sessions don't carry across diff sources.
  useEffect(() => {
    setDraft(null);
    setSelectedLines(null);
    setEditSessions(new Map());
    setDirtyPaths(new Set());
    setSaveError(null);
    setSavingCount(0);
    setEditorLoadingCount(0);
    editedFilesRef.current.clear();
    savingPathsRef.current.clear();
    loadingEditorPathsRef.current.clear();
    expectedContentsHashesRef.current.clear();
    editRevisionsRef.current.clear();
  }, [activeFilter]);

  // ── Parse the patch with @pierre/diffs ───────────────────────────────
  const parsedFiles = useMemo<ParsedFile[]>(() => {
    if (!patch || patch.patch === '') return [];
    const parsed = parsePatchFiles(patch.patch, patch.patchHash.slice(0, 16));
    const fileDiffs = parsed.flatMap((p) => p.files);
    // Server summaries and parsed files come from the same patch in the same
    // order; pair them so path identifiers match the sidebar exactly.
    return fileDiffs.map((fileDiff, index) => ({
      path: patch.files[index]?.path ?? fileDiff.name,
      fileDiff,
    }));
  }, [patch]);

  const filesByPath = useMemo(
    () => new Map((patch?.files ?? []).map((f) => [f.path, f])),
    [patch?.files],
  );
  const parsedFilesByPath = useMemo(
    () => new Map(parsedFiles.map((file) => [file.path, file])),
    [parsedFiles],
  );
  const totalLines = useMemo(
    () => parsedFiles.reduce((sum, file) => sum + file.fileDiff.unifiedLineCount, 0),
    [parsedFiles],
  );

  const filterComments = useMemo(
    () => comments.filter((c) => c.filter === activeFilter),
    [comments, activeFilter],
  );

  // ── CodeView items with minimal version churn ────────────────────────
  const annotationsByPath = useMemo(
    () => buildAnnotations(filterComments, draft),
    [filterComments, draft],
  );

  const versionsRef = useRef(new Map<string, { version: number; key: string }>());
  const items = useMemo<CodeViewItem<AnnotationMeta>[]>(() => {
    const hash = patch?.patchHash ?? '';
    return parsedFiles.map(({ path, fileDiff }) => {
      const id = `f:${path}`;
      const editSession = editSessions.get(path);
      const annotations = editSession
        ? editSession.annotations
        : (annotationsByPath.get(path) ?? []);
      const collapsed = editSession === undefined && collapsedPaths.has(path);
      const key = editSession
        ? `edit|${editSession.rev}|${dirtyPaths.has(path) ? 1 : 0}`
        : `${hash}|${collapsed ? 1 : 0}|${annotationsKey(annotations)}`;
      const entry = versionsRef.current.get(id);
      let version = entry?.version ?? 1;
      if (!entry || entry.key !== key) {
        version = (entry?.version ?? 0) + 1;
        versionsRef.current.set(id, { version, key });
      }
      return {
        id,
        type: 'diff',
        fileDiff: editSession?.fileDiff ?? fileDiff,
        annotations,
        collapsed,
        version,
        edit: editSession !== undefined,
      };
    });
  }, [parsedFiles, annotationsByPath, collapsedPaths, patch?.patchHash, editSessions, dirtyPaths]);

  // Restore a line permalink once its target file is in the rendered patch.
  useEffect(() => {
    const target = pendingHashTargetRef.current;
    if (!target || items.length === 0) return;
    if (!items.some((item) => item.id === target.id)) return;
    pendingHashTargetRef.current = null;
    setSelectedLines(target);
    viewerRef.current?.scrollTo({
      type: 'range',
      id: target.id,
      range: target.range,
      align: 'center',
    });
  }, [items]);

  // ── Selection & permalinks ───────────────────────────────────────────
  const handleSelectedLinesChange = useStableCallback((selection: CodeViewLineSelection | null) => {
    setSelectedLines(selection);
    syncLineHash(selection);
  });

  // ── Collapse ─────────────────────────────────────────────────────────
  const toggleFileCollapsed = useStableCallback((path: string) => {
    const viewer = viewerRef.current;
    const instance = viewer?.getInstance();
    const itemTop = instance?.getTopForItem(`f:${path}`);
    const scrollTop = instance?.getScrollTop();
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
    // Keep a file collapsed above the viewport anchored in view.
    if (itemTop !== undefined && scrollTop !== undefined && itemTop < scrollTop) {
      requestAnimationFrame(() => {
        viewerRef.current?.scrollTo({ type: 'item', id: `f:${path}`, align: 'start' });
      });
    }
  });

  // ── Edit mode ────────────────────────────────────────────────────────
  /** Pin the viewport to its current top item and intra-item offset. */
  const captureScrollAnchor = useStableCallback((waitForPatch: boolean) => {
    const instance = viewerRef.current?.getInstance();
    if (!instance) return;
    const scrollTop = instance.getScrollTop();
    let id: string | undefined;
    let itemTop: number | undefined;
    for (const item of items) {
      const top = instance.getTopForItem(item.id);
      if (top === undefined || top > scrollTop || (itemTop !== undefined && top <= itemTop)) {
        continue;
      }
      id = item.id;
      itemTop = top;
    }
    scrollAnchorRef.current = {
      id,
      offset: itemTop === undefined ? Number.NaN : scrollTop - itemTop,
      scrollTop,
      patchHash: patch?.patchHash ?? '',
      waitForPatch,
      until: Date.now() + SCROLL_ANCHOR_WINDOW_MS,
    };
  });

  const restoreScrollAnchor = useStableCallback(() => {
    const anchor = scrollAnchorRef.current;
    const instance = viewerRef.current?.getInstance();
    if (!anchor || !instance) return;
    const itemTop =
      anchor.id === undefined || Number.isNaN(anchor.offset)
        ? undefined
        : instance.getTopForItem(anchor.id);
    const position = itemTop === undefined ? anchor.scrollTop : itemTop + anchor.offset;
    if (Math.abs(instance.getScrollTop() - position) < 1) return;
    instance.scrollTo({ type: 'position', position, behavior: 'instant' });
  });

  // Re-pin the viewport whenever the items rebuild while an anchor is live:
  // once when the session exits, and again when the saved patch arrives.
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    if (!anchor) return;
    if (Date.now() > anchor.until) {
      scrollAnchorRef.current = null;
      return;
    }
    restoreScrollAnchor();
    const patchArrived =
      anchor.waitForPatch && patch !== null && patch.patchHash !== anchor.patchHash;
    // The virtualizer can re-measure after paint; correct once more.
    const frame = requestAnimationFrame(() => {
      restoreScrollAnchor();
      if (!anchor.waitForPatch || patchArrived) scrollAnchorRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [items, patch, restoreScrollAnchor]);

  // A real user scroll gesture releases the pin immediately.
  useEffect(() => {
    const release = () => {
      scrollAnchorRef.current = null;
    };
    window.addEventListener('wheel', release, { passive: true });
    window.addEventListener('touchmove', release, { passive: true });
    return () => {
      window.removeEventListener('wheel', release);
      window.removeEventListener('touchmove', release);
    };
  }, []);

  const fetchEditFileContents = useStableCallback(
    (fileDiff: FileDiffMetadata, path: string, targetFilter: DiffFilter, patchHash: string) => {
      let request = fileContentsByDiffRef.current.get(fileDiff);
      if (!request) {
        request = api.fetchFileContents(targetFilter, path).then((payload) => {
          if (payload.patchHash !== patchHash) {
            throw new Error('diff changed while the file was loading; try again');
          }
          return payload;
        });
        fileContentsByDiffRef.current.set(fileDiff, request);
        void request.catch(() => fileContentsByDiffRef.current.delete(fileDiff));
      }
      return request;
    },
  );

  const startEditing = useStableCallback(async (path: string) => {
    if (editSessions.has(path) || loadingEditorPathsRef.current.has(path)) return;
    const parsed = parsedFilesByPath.get(path);
    const summary = filesByPath.get(path);
    if (!parsed || !summary || summary.binary || summary.kind === 'deleted') return;

    const requestedFilter = activeFilter;
    const requestedPatchHash = patch?.patchHash;
    if (!requestedPatchHash) return;
    const needsLoad = editModule === undefined;
    loadingEditorPathsRef.current.add(path);
    if (needsLoad) setEditorLoadingCount((count) => count + 1);
    try {
      const [, fileContents] = await Promise.all([
        loadEditModule(),
        fetchEditFileContents(parsed.fileDiff, path, requestedFilter, requestedPatchHash),
      ]);
      // Do not start a stale session if navigation or a refresh won the race.
      if (
        requestedFilter !== activeFilterRef.current ||
        requestedPatchHash !== patchHashRef.current
      ) {
        return;
      }
      // Comment drafts don't carry into an edit session.
      setDraft((current) => (current?.path === path ? null : current));
      const annotations = (annotationsByPath.get(path) ?? []).filter(
        (annotation) => annotation.metadata.kind !== 'draft',
      );
      const contentsHash = fileContents.newContentsHash;
      if (!contentsHash) throw new Error('file has no editable contents');
      expectedContentsHashesRef.current.set(path, contentsHash);
      editRevisionsRef.current.set(path, 0);
      setEditSessions((prev) =>
        new Map(prev).set(path, { fileDiff: parsed.fileDiff, annotations, rev: 0 }),
      );
      setSaveError(null);
    } catch (error) {
      setSaveError(
        `Failed to start editing ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      loadingEditorPathsRef.current.delete(path);
      if (needsLoad) setEditorLoadingCount((count) => Math.max(0, count - 1));
    }
  });

  /** End a session without saving (also used after a successful save). */
  const stopEditing = useStableCallback((path: string, waitForPatch = false) => {
    captureScrollAnchor(waitForPatch);
    editedFilesRef.current.delete(path);
    expectedContentsHashesRef.current.delete(path);
    editRevisionsRef.current.delete(path);
    setEditSessions((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
    setDirtyPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  });

  const saveEditingFile = useStableCallback(async (path: string, clearError = true) => {
    if (savingPathsRef.current.has(path)) return;
    if (clearError) setSaveError(null);
    savingPathsRef.current.add(path);
    setSavingCount((count) => count + 1);
    try {
      const file = editedFilesRef.current.get(path);
      const expectedContentsHash = expectedContentsHashesRef.current.get(path);
      const savedRevision = editRevisionsRef.current.get(path) ?? 0;
      const saved = dirtyPaths.has(path) && file !== undefined;
      if (saved) {
        if (!expectedContentsHash)
          throw new Error('file version is unavailable; reopen the editor');
        const result = await api.saveFile({
          filter: activeFilter,
          path,
          contents: file.contents,
          expectedContentsHash,
        });
        expectedContentsHashesRef.current.set(path, result.contentsHash);
      }
      const latestFile = editedFilesRef.current.get(path);
      const unchangedDuringSave =
        editRevisionsRef.current.get(path) === savedRevision &&
        latestFile?.contents === file?.contents;
      if (unchangedDuringSave) stopEditing(path, saved);
      else setDirtyPaths((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
    } catch (error) {
      const message = `Failed to save ${path}: ${error instanceof Error ? error.message : String(error)}`;
      setSaveError((current) => (current ? `${current}\n${message}` : message));
    } finally {
      savingPathsRef.current.delete(path);
      setSavingCount((count) => Math.max(0, count - 1));
    }
  });

  const saveAllEdits = useStableCallback(async () => {
    setSaveError(null);
    await Promise.all([...editSessions.keys()].map((path) => saveEditingFile(path, false)));
  });

  const discardEditing = useStableCallback((path: string) => {
    if (dirtyPaths.has(path) && !window.confirm(`Discard unsaved changes to ${path}?`)) {
      return;
    }
    stopEditing(path);
  });

  const changeFilter = useStableCallback((next: DiffFilter) => {
    if (
      next !== activeFilter &&
      dirtyPaths.size > 0 &&
      !window.confirm('Discard unsaved file changes and switch diff source?')
    ) {
      return;
    }
    setFilter(next);
  });

  const handleItemEditChange = useStableCallback(
    (
      item: CodeViewItem<AnnotationMeta>,
      file: FileContents,
      lineAnnotations?: LineAnnotation<AnnotationMeta>[] | DiffLineAnnotation<AnnotationMeta>[],
    ) => {
      const path = item.id.slice(2);
      const editSession = editSessions.get(path);
      if (!editSession) return;
      editRevisionsRef.current.set(path, (editRevisionsRef.current.get(path) ?? 0) + 1);
      editedFilesRef.current.set(path, file);
      setDirtyPaths((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
      // Publish remapped annotations synchronously so their placement moves
      // with the edited content before paint. Bail on identical identity.
      if (lineAnnotations && lineAnnotations !== editSession.annotations) {
        flushSync(() => {
          setEditSessions((prev) => {
            const current = prev.get(path);
            if (!current || current.annotations === lineAnnotations) return prev;
            const next = new Map(prev);
            next.set(path, {
              ...current,
              annotations: lineAnnotations as DiffAnnotation[],
              rev: current.rev + 1,
            });
            return next;
          });
        });
      }
    },
  );

  // Drop edit sessions whose file left the diff (e.g. reverted externally).
  useEffect(() => {
    if (editSessions.size === 0) return;
    const paths = new Set(parsedFiles.map((file) => file.path));
    for (const path of editSessions.keys()) {
      if (!paths.has(path)) stopEditing(path);
    }
  }, [parsedFiles, editSessions, stopEditing]);

  // Warn before browser navigation can discard live editor documents.
  const hasDirtyEdits = dirtyPaths.size > 0;
  useEffect(() => {
    if (!hasDirtyEdits) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [hasDirtyEdits]);

  // Save every editing file on Cmd/Ctrl+S.
  const hasEditSessions = editSessions.size > 0;
  useEffect(() => {
    if (!hasEditSessions) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !event.repeat &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 's'
      ) {
        event.preventDefault();
        void saveAllEdits();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasEditSessions, saveAllEdits]);

  // ── Comment actions ──────────────────────────────────────────────────
  const handleGutterClick = useStableCallback((range: SelectedLineRange, itemId: string) => {
    setDraft({
      path: itemId.slice(2),
      side: range.endSide ?? range.side ?? 'additions',
      startLine: Math.min(range.start, range.end),
      endLine: Math.max(range.start, range.end),
    });
  });

  const createComment = useStableCallback(async (target: DraftComment, body: string) => {
    await api.createComment({
      filter: activeFilter,
      path: target.path,
      side: target.side,
      startLine: target.startLine,
      endLine: target.endLine,
      body,
    });
    setDraft(null);
  });

  const updateComment = useStableCallback(async (id: string, body: string) => {
    await api.updateComment(id, body);
  });

  const removeComment = useStableCallback(async (id: string) => {
    await api.deleteComment(id);
  });

  const openFile = useStableCallback((path: string) => {
    if (narrowView) setSidebarOpen(false);
    // Expand a collapsed file before navigating to it.
    setCollapsedPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    requestAnimationFrame(() => {
      viewerRef.current?.scrollTo({ type: 'item', id: `f:${path}`, align: 'start' });
    });
  });

  const openComment = useStableCallback((comment: ReviewComment) => {
    if (narrowView) setSidebarOpen(false);
    if (comment.outdated) {
      openFile(comment.path);
      return;
    }
    const id = `f:${comment.path}`;
    const range: SelectedLineRange = {
      start: comment.startLine,
      side: comment.side,
      end: comment.endLine,
      endSide: comment.side,
    };
    handleSelectedLinesChange({ id, range });
    // Expand the file first when collapsed, then navigate on the next frame.
    setCollapsedPaths((prev) => {
      if (!prev.has(comment.path)) return prev;
      const next = new Set(prev);
      next.delete(comment.path);
      return next;
    });
    requestAnimationFrame(() => {
      viewerRef.current?.scrollTo({
        type: 'line',
        id,
        lineNumber: comment.endLine,
        side: comment.side,
        align: 'center',
        behavior: 'smooth-auto',
      });
    });
  });

  // ── CodeView options (memoized: CodeView diffs options by identity) ──
  const options = useMemo<CodeViewOptions<AnnotationMeta>>(
    () => ({
      theme: codeViewTheme(view.theme),
      diffStyle: effectiveDiffStyle,
      overflow: view.overflow,
      stickyHeaders: true,
      enableLineSelection: true,
      enableGutterUtility: true,
      lineHoverHighlight: 'number',
      hunkSeparators: 'line-info-basic',
      itemMetrics: { lineHeight: view.lineHeight },
      layout: CODE_VIEW_LAYOUT,
      unsafeCSS: CODE_VIEW_UNSAFE_CSS,
      onGutterUtilityClick(range, context) {
        if (context.item.type === 'diff' && context.item.edit !== true) {
          handleGutterClick(range, context.item.id);
        }
      },
      // Edit mode needs full file contents; hydrate partial diffs on demand.
      async loadDiffFiles(fileDiff) {
        try {
          const payload = await fetchEditFileContents(
            fileDiff,
            fileDiff.name,
            activeFilter,
            patch?.patchHash ?? '',
          );
          const cachePrefix = `${payload.patchHash.slice(0, 16)}:${fileDiff.name}`;
          const newFile: FileContents = {
            name: fileDiff.name,
            contents: payload.newContents ?? '',
            cacheKey: `${cachePrefix}:new`,
          };
          if (payload.oldContents === null) return { oldFile: null, newFile };
          return {
            oldFile: {
              name: fileDiff.prevName ?? fileDiff.name,
              contents: payload.oldContents,
              cacheKey: `${cachePrefix}:old`,
            },
            newFile,
          };
        } catch (error) {
          setSaveError(
            `Failed to load ${fileDiff.name} for editing: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      },
    }),
    [
      effectiveDiffStyle,
      view.overflow,
      view.theme,
      view.lineHeight,
      handleGutterClick,
      activeFilter,
      patch?.patchHash,
      fetchEditFileContents,
    ],
  );

  const renderCustomHeader = useStableCallback((item: CodeViewItem<AnnotationMeta>) => {
    const path = item.id.slice(2);
    const summary = filesByPath.get(path);
    return (
      <FileHeader
        path={path}
        summary={summary}
        collapsed={item.collapsed === true}
        onToggleCollapsed={toggleFileCollapsed}
        editable={summary !== undefined && !summary.binary && summary.kind !== 'deleted'}
        editing={editSessions.has(path)}
        dirty={dirtyPaths.has(path)}
        onStartEdit={(target) => void startEditing(target)}
        onSaveEdit={(target) => void saveEditingFile(target)}
        onDiscardEdit={discardEditing}
      />
    );
  });

  const renderAnnotation = useStableCallback((annotation: { metadata: AnnotationMeta }) => (
    <CommentCard
      meta={annotation.metadata}
      onCreate={createComment}
      onUpdate={updateComment}
      onDelete={removeComment}
      onCancelDraft={() => setDraft(null)}
    />
  ));

  // ── Render ───────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="fullscreen-message error">
        <h1>diffs-pane</h1>
        <p>{loadError}</p>
      </div>
    );
  }
  if (!session || !patch) {
    return <div className="fullscreen-message">Loading…</div>;
  }

  return (
    <div className="app">
      <Toolbar
        session={session}
        filter={activeFilter}
        onFilterChange={changeFilter}
        view={{ ...view, diffStyle: effectiveDiffStyle }}
        onViewChange={setView}
        unifiedOnly={narrowView}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        connection={connection}
      />
      <div className={`content ${narrowView ? 'narrow' : ''}`}>
        {narrowView && sidebarOpen && (
          <button
            type="button"
            className="sidebar-backdrop"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        {sidebarOpen && (
          <Sidebar
            files={patch.files}
            comments={filterComments}
            totalLines={totalLines}
            onOpenFile={openFile}
            onOpenComment={openComment}
          />
        )}
        <main
          className="diff-pane"
          style={
            {
              '--viewer-font-family': view.fontFamily,
              '--viewer-font-size': `${view.fontSize}px`,
              '--viewer-line-height': `${view.lineHeight}px`,
            } as CSSProperties
          }
        >
          {(editorLoadingCount > 0 || savingCount > 0) && (
            <div className="save-status" role="status" aria-live="polite">
              {editorLoadingCount > 0
                ? 'Loading editor…'
                : `Saving ${savingCount === 1 ? 'file' : `${savingCount} files`}…`}
            </div>
          )}
          {saveError !== null && (
            <div className="banner error" role="alert">
              {saveError}
            </div>
          )}
          {patch.error ? (
            <div className="banner error">{patch.error}</div>
          ) : items.length === 0 ? (
            <div className="fullscreen-message subtle">
              No changes in the{' '}
              {activeFilter === 'unstaged' ? session.unstagedLabel.toLowerCase() : activeFilter}{' '}
              diff.
            </div>
          ) : (
            <EditProvider createEditor={createEditor}>
              <CodeView<AnnotationMeta>
                ref={viewerRef}
                items={items}
                className="code-view"
                options={options}
                editorOptions={EDITOR_OPTIONS}
                selectedLines={selectedLines}
                onSelectedLinesChange={handleSelectedLinesChange}
                onItemEditChange={handleItemEditChange}
                renderCustomHeader={renderCustomHeader}
                renderAnnotation={renderAnnotation}
              />
            </EditProvider>
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * Custom sticky file header: collapse chevron, status badge, path, ± stats.
 * (The built-in header caches its HTML across item updates, so live patch
 * refreshes would show stale stats.)
 */
function FileHeader({
  path,
  summary,
  collapsed,
  onToggleCollapsed,
  editable,
  editing,
  dirty,
  onStartEdit,
  onSaveEdit,
  onDiscardEdit,
}: {
  path: string;
  summary: PatchFileSummary | undefined;
  collapsed: boolean;
  onToggleCollapsed(path: string): void;
  editable: boolean;
  editing: boolean;
  dirty: boolean;
  onStartEdit(path: string): void;
  onSaveEdit(path: string): void;
  onDiscardEdit(path: string): void;
}) {
  return (
    <div className="file-header">
      <button
        type="button"
        className="collapse-button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand diff' : 'Collapse diff'}
        disabled={editing}
        title={editing ? 'Finish editing to collapse' : undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggleCollapsed(path);
        }}
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={collapsed ? 'chevron collapsed' : 'chevron'}
        />
      </button>
      {summary && (
        <span className={`file-status ${summary.kind}`} title={summary.kind}>
          {KIND_BADGE[summary.kind]}
        </span>
      )}
      <span className="file-path">
        {summary?.prevPath !== undefined ? `${summary.prevPath} → ${path}` : path}
      </span>
      {summary &&
        (summary.binary ? (
          <span className="file-stats binary">binary</span>
        ) : (
          <span className="file-stats">
            <span className="add">+{summary.additions}</span>
            <span className="del">−{summary.deletions}</span>
          </span>
        ))}
      {editing ? (
        <span className="file-edit-actions">
          {dirty ? (
            <>
              <span className="dirty-dot" title="Unsaved changes" />
              <button
                type="button"
                className="edit-action save"
                title={`Save changes (${SAVE_SHORTCUT_LABEL})`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSaveEdit(path);
                }}
              >
                Save
              </button>
              <button
                type="button"
                className="edit-action"
                title="Discard changes"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onDiscardEdit(path);
                }}
              >
                Discard
              </button>
            </>
          ) : (
            <button
              type="button"
              className="edit-action"
              title="Finish editing"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDiscardEdit(path);
              }}
            >
              Done
            </button>
          )}
        </span>
      ) : (
        editable && (
          <button
            type="button"
            className="edit-file-button"
            aria-label="Edit file"
            title="Edit file"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onStartEdit(path);
            }}
          >
            <Pencil1Icon aria-hidden="true" />
          </button>
        )
      )}
    </div>
  );
}
