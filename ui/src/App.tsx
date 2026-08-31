import {
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type DiffLineEventBaseProps,
  type SelectedLineRange,
} from '@pierre/diffs';
import type { Editor } from '@pierre/diffs/edit';
import {
  CodeView,
  EditProvider,
  useStableCallback,
  useWorkerPool,
  type CodeViewHandle,
} from '@pierre/diffs/react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type {
  DiffFilter,
  PatchPayload,
  ReviewComment,
  SessionInfo,
} from '../../src/shared/protocol';
import * as api from './api';
import {
  annotationsKey,
  buildAnnotations,
  type AnnotationMeta,
  type DraftComment,
} from './annotations';
import { CommentCard } from './components/CommentCard';
import { FileHeader, FileHeadersProvider } from './components/FileHeader';
import { Sidebar } from './components/Sidebar';
import { Toolbar, type ViewSettings } from './components/Toolbar';
import { parseLineHash, syncLineHash } from './lineHash';
import { codeViewTheme, fontSettingsFromSearch, syncTheme, themeFromSearch } from './themes';
import { createEditor, useEdits } from './useEdits';
import { usePatchModel } from './usePatchModel';
import { useScrollAnchor } from './useScrollAnchor';

type Connection = 'connected' | 'connecting' | 'reconnecting' | 'ended';

const NARROW_VIEW_QUERY = '(max-width: 767px)';
const CODE_VIEW_LAYOUT = { paddingTop: 0, gap: 1, paddingBottom: 16 };
// How long to wait for a lazily activated editor to attach and hydrate
// before dropping the pending caret placement.
const EDIT_FOCUS_TIMEOUT_MS = 10_000;
const CODE_VIEW_UNSAFE_CSS = `
  [data-diffs-header][data-sticky] {
    top: 0;
  }
  [data-interactive-lines] [data-line] {
    cursor: text;
  }
`;

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

  const viewerRef = useRef<CodeViewHandle<AnnotationMeta> | null>(null);
  const patchHashRef = useRef<string | null>(null);
  const prepareForRefreshRef = useRef<() => void>(() => {});
  const pendingHashTargetRef = useRef<CodeViewLineSelection | null>(
    parseLineHash(window.location.hash),
  );
  const activeFilter = filter ?? session?.defaultFilter ?? 'branch';
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

  useEffect(() => {
    let cancelled = false;
    void api
      .fetchSession()
      .then((info) => {
        if (cancelled) return;
        setSession(info);
        setFilter((current) => current ?? info.defaultFilter);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
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
      const message = error instanceof Error ? error.message : String(error);
      patchHashRef.current = 'load-error';
      setPatch({
        filter: target,
        patchHash: 'load-error',
        patch: '',
        files: [],
        error: message,
        generatedAt: new Date().toISOString(),
      });
    }
  }, []);

  const sessionReady = session !== null;
  useEffect(() => {
    if (!sessionReady || filter === null) return;
    let opened = false;
    // This effect owns the SSE subscription and its status.
    // oxlint-disable-next-line react/set-state-in-effect
    setConnection('connecting');
    patchHashRef.current = null;
    void loadPatch(filter);

    return api.openEvents(filter, {
      onOpen: () => {
        setConnection('connected');
        if (opened) void loadPatch(filter);
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
  }, [sessionReady, filter, loadPatch]);

  const { files: parsedFiles, clearCache: clearParsedFileCache } = usePatchModel(patch);
  const filterComments = useMemo(
    () => comments.filter((comment) => comment.filter === activeFilter),
    [comments, activeFilter],
  );
  const annotationsByPath = useMemo(
    () => buildAnnotations(filterComments, draft),
    [filterComments, draft],
  );
  const handleEditStart = useStableCallback((path: string) => {
    setDraft((current) => (current?.path === path ? null : current));
    setSelectedLines((current) => {
      if (current?.id !== `f:${path}`) return current;
      viewerRef.current?.clearSelectedLines();
      syncLineHash(null);
      return null;
    });
  });
  const edits = useEdits({
    activeFilter,
    patch,
    parsedFiles,
    annotationsByPath,
    loadPatch,
    prepareForRefresh: () => prepareForRefreshRef.current(),
    onEditStart: handleEditStart,
  });
  const applyLocalEdits = edits.applyLocalEdits;

  const patchFilesByPath = useMemo(
    () => new Map((patch?.files ?? []).map((file) => [file.path, file])),
    [patch?.files],
  );
  const parsedFilesByPath = useMemo(
    () => new Map(parsedFiles.map((file) => [file.path, file])),
    [parsedFiles],
  );
  const displayedPaths = useMemo(() => {
    const paths = (patch?.files ?? []).map((file) => file.path);
    const known = new Set(paths);
    for (const path of edits.edits.keys()) {
      if (!known.has(path)) paths.push(path);
    }
    return paths;
  }, [patch?.files, edits.edits]);
  const displayedFiles = useMemo(
    () =>
      displayedPaths.flatMap((path) => {
        const edit = edits.edits.get(path);
        const summary = patchFilesByPath.get(path) ?? edit?.summary;
        if (!summary) return [];
        if (!edit) return [summary];
        return [
          {
            ...summary,
            additions: edit.liveDiff.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
            deletions: edit.liveDiff.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
          },
        ];
      }),
    [displayedPaths, edits.edits, patchFilesByPath],
  );
  const displayedParsedFiles = useMemo(
    () =>
      displayedPaths.flatMap((path) => {
        const edit = edits.edits.get(path);
        const parsed = parsedFilesByPath.get(path);
        if (edit) {
          return [{ path, fileDiff: edit.fileDiff, sectionHash: edit.sectionHash }];
        }
        return parsed ? [parsed] : [];
      }),
    [displayedPaths, edits.edits, parsedFilesByPath],
  );
  const filesByPath = useMemo(
    () => new Map(displayedFiles.map((file) => [file.path, file])),
    [displayedFiles],
  );

  // Files enter edit mode lazily (on first click into their code), so
  // scrolling never attaches editors or hydrates full file contents. The
  // clicked file's editor attaches asynchronously; poll until its document
  // is ready, then place the caret near the clicked line.
  const editFocusFrameRef = useRef<number | null>(null);
  const cancelEditFocus = useCallback(() => {
    if (editFocusFrameRef.current !== null) {
      cancelAnimationFrame(editFocusFrameRef.current);
      editFocusFrameRef.current = null;
    }
  }, []);
  useEffect(() => cancelEditFocus, [cancelEditFocus]);
  const focusEditorWhenReady = useStableCallback((itemId: string, lineNumber: number) => {
    cancelEditFocus();
    const deadline = Date.now() + EDIT_FOCUS_TIMEOUT_MS;
    const tick = () => {
      editFocusFrameRef.current = null;
      const editor = viewerRef.current?.getEditor(itemId) as Editor<AnnotationMeta> | undefined;
      if (editor?.getFile() !== undefined) {
        editor.focus({ lineNumber, preventScroll: true });
        return;
      }
      if (Date.now() < deadline) editFocusFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
  });
  const handleLineClick = useStableCallback((line: DiffLineEventBaseProps, itemId: string) => {
    // Number-column clicks drive line selection for comments, not editing.
    if (line.numberColumn) return;
    const path = itemId.slice(2);
    if (edits.pendingAction !== null || edits.editingPaths.has(path)) return;
    const summary = filesByPath.get(path);
    if (!summary || summary.binary || summary.kind === 'deleted') return;
    // Don't hijack an in-progress text selection (copying from the diff).
    const selection = window.getSelection();
    if (selection !== null && !selection.isCollapsed) return;
    edits.startEditing(path);
    focusEditorWhenReady(itemId, line.lineNumber);
  });
  const fileHeaderState = useMemo(
    () => ({ files: filesByPath, dirtyPaths: edits.dirtyPaths }),
    [filesByPath, edits.dirtyPaths],
  );
  const totalLines = useMemo(
    () =>
      displayedParsedFiles.reduce(
        (sum, file) =>
          sum + (edits.edits.get(file.path)?.liveDiff ?? file.fileDiff).unifiedLineCount,
        0,
      ),
    [displayedParsedFiles, edits.edits],
  );

  const versionsRef = useRef(new Map<string, { version: number; key: string }>());
  // CodeView re-reads an item only when its version changes.
  /* oxlint-disable react/refs, react/memo-dependencies */
  const items = useMemo<CodeViewItem<AnnotationMeta>[]>(
    () =>
      displayedParsedFiles.map(({ path, fileDiff, sectionHash }) => {
        const edit = edits.edits.get(path);
        const annotations = edit?.annotations ?? annotationsByPath.get(path) ?? [];
        const collapsed = collapsedPaths.has(path);
        const summary = filesByPath.get(path);
        const editable =
          edits.editorReady &&
          (edits.editingPaths.has(path) || edit !== undefined) &&
          summary !== undefined &&
          !summary.binary &&
          summary.kind !== 'deleted';
        // The version must change whenever any rendered input (including the
        // edit flag) changes, so CodeView re-reads the item.
        const key = `${sectionHash}|${collapsed ? 1 : 0}|${editable ? 1 : 0}|${annotationsKey(annotations)}`;
        const previous = versionsRef.current.get(path);
        const version = previous?.key === key ? previous.version : (previous?.version ?? 0) + 1;
        versionsRef.current.set(path, { version, key });
        return {
          id: `f:${path}`,
          type: 'diff',
          fileDiff,
          annotations,
          collapsed,
          version,
          edit: editable,
        };
      }),
    [
      displayedParsedFiles,
      edits.edits,
      edits.editingPaths,
      edits.editorReady,
      annotationsByPath,
      collapsedPaths,
      filesByPath,
    ],
  );
  /* oxlint-enable react/refs, react/memo-dependencies */

  const captureScrollAnchor = useScrollAnchor(viewerRef, items, patch?.patchHash ?? '');
  useEffect(() => {
    prepareForRefreshRef.current = () => {
      captureScrollAnchor(true);
      clearParsedFileCache();
    };
  });

  useEffect(() => {
    const target = pendingHashTargetRef.current;
    if (!target || !items.some((item) => item.id === target.id)) return;
    pendingHashTargetRef.current = null;
    setSelectedLines(target);
    viewerRef.current?.scrollTo({
      type: 'range',
      id: target.id,
      range: target.range,
      align: 'center',
    });
  }, [items]);

  const handleSelectedLinesChange = useStableCallback((selection: CodeViewLineSelection | null) => {
    if (selection && edits.dirtyPaths.has(selection.id.slice(2))) {
      viewerRef.current?.clearSelectedLines();
      return;
    }
    setSelectedLines(selection);
    syncLineHash(selection);
  });

  const toggleFileCollapsed = useStableCallback((path: string) => {
    const instance = viewerRef.current?.getInstance();
    const itemTop = instance?.getTopForItem(`f:${path}`);
    const scrollTop = instance?.getScrollTop();
    setCollapsedPaths((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });
    if (itemTop !== undefined && scrollTop !== undefined && itemTop < scrollTop) {
      requestAnimationFrame(() => {
        viewerRef.current?.scrollTo({
          type: 'item',
          id: `f:${path}`,
          align: 'start',
          offset: CODE_VIEW_LAYOUT.paddingTop,
        });
      });
    }
  });

  const changeFilter = useStableCallback((next: DiffFilter) => {
    if (edits.pendingAction) return;
    if (next !== activeFilter) {
      if (
        edits.dirtyPaths.size > 0 &&
        !window.confirm('Discard unsaved file changes and switch diff source?')
      ) {
        return;
      }
      setDraft(null);
      setSelectedLines(null);
      edits.reset();
    }
    setFilter(next);
  });

  useEffect(() => {
    const handleSave = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 's' ||
        // Comment forms are the only textareas; the diff editor is contenteditable.
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      event.preventDefault();
      if (!event.repeat) void applyLocalEdits('commit');
    };
    window.addEventListener('keydown', handleSave);
    return () => window.removeEventListener('keydown', handleSave);
  }, [applyLocalEdits]);

  const handleGutterClick = useStableCallback((range: SelectedLineRange, itemId: string) => {
    if (edits.dirtyPaths.has(itemId.slice(2))) return;
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
    setCollapsedPaths((previous) => {
      if (!previous.has(path)) return previous;
      const next = new Set(previous);
      next.delete(path);
      return next;
    });
    requestAnimationFrame(() => {
      viewerRef.current?.scrollTo({
        type: 'item',
        id: `f:${path}`,
        align: 'start',
        offset: CODE_VIEW_LAYOUT.paddingTop,
      });
    });
  });

  const openComment = useStableCallback((comment: ReviewComment) => {
    if (narrowView) setSidebarOpen(false);
    if (comment.outdated) {
      openFile(comment.path);
      return;
    }
    const id = `f:${comment.path}`;
    handleSelectedLinesChange({
      id,
      range: {
        start: comment.startLine,
        side: comment.side,
        end: comment.endLine,
        endSide: comment.side,
      },
    });
    setCollapsedPaths((previous) => {
      if (!previous.has(comment.path)) return previous;
      const next = new Set(previous);
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
      itemMetrics: { lineHeight: view.lineHeight, diffHeaderHeight: 40 },
      layout: CODE_VIEW_LAYOUT,
      unsafeCSS: CODE_VIEW_UNSAFE_CSS,
      onGutterUtilityClick(range, context) {
        if (context.item.type === 'diff') handleGutterClick(range, context.item.id);
      },
      onLineClick(line, context) {
        if (context.item.type === 'diff') handleLineClick(line, context.item.id);
      },
      loadDiffFiles: edits.loadDiffFiles,
    }),
    [
      effectiveDiffStyle,
      view.overflow,
      view.theme,
      view.lineHeight,
      handleGutterClick,
      handleLineClick,
      edits.loadDiffFiles,
    ],
  );

  const renderCustomHeader = useStableCallback((item: CodeViewItem<AnnotationMeta>) => (
    <FileHeader
      path={item.id.slice(2)}
      collapsed={item.collapsed === true}
      onToggleCollapsed={toggleFileCollapsed}
    />
  ));
  const renderAnnotation = useStableCallback((annotation: { metadata: AnnotationMeta }) => (
    <CommentCard
      meta={annotation.metadata}
      onCreate={createComment}
      onUpdate={updateComment}
      onDelete={removeComment}
      onCancelDraft={() => setDraft(null)}
    />
  ));

  if (loadError) {
    return (
      <div className="fullscreen-message error">
        <h1>diffs-pane</h1>
        <p>{loadError}</p>
      </div>
    );
  }
  if (!session || !patch) return <div className="fullscreen-message">Loading…</div>;

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
        unsavedFiles={edits.dirtyPaths.size}
        pendingAction={edits.pendingAction}
        onCommit={() => void applyLocalEdits('commit')}
        onDiscard={() => void applyLocalEdits('discard')}
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
            files={displayedFiles}
            dirtyPaths={edits.dirtyPaths}
            comments={filterComments}
            totalLines={totalLines}
            onOpenFile={openFile}
            onOpenComment={openComment}
          />
        )}
        <main
          className="diff-pane"
          inert={edits.pendingAction !== null}
          style={
            {
              '--viewer-font-family': view.fontFamily,
              '--viewer-font-size': `${view.fontSize}px`,
              '--viewer-line-height': `${view.lineHeight}px`,
            } as CSSProperties
          }
        >
          {edits.loading && (
            <div className="save-status" role="status">
              Loading editor…
            </div>
          )}
          {edits.error !== null && (
            <div className="banner error" role="alert">
              {edits.error}
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
            <FileHeadersProvider value={fileHeaderState}>
              <EditProvider createEditor={createEditor}>
                <CodeView<AnnotationMeta>
                  ref={viewerRef}
                  items={items}
                  className="code-view"
                  options={options}
                  selectedLines={selectedLines}
                  onSelectedLinesChange={handleSelectedLinesChange}
                  onItemEditChange={edits.onItemEditChange}
                  renderCustomHeader={renderCustomHeader}
                  renderAnnotation={renderAnnotation}
                />
              </EditProvider>
            </FileHeadersProvider>
          )}
        </main>
      </div>
    </div>
  );
}
