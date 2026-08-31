import {
  ChevronDownIcon,
  ColumnsIcon,
  MixerHorizontalIcon,
  RowsIcon,
  ViewVerticalIcon,
} from '@radix-ui/react-icons';
import { useEffect, useRef, useState } from 'react';

import type { DiffFilter, SessionInfo } from '../../../src/shared/protocol';
import { DIFF_THEMES, FONT_SIZES, LINE_HEIGHTS, type DiffTheme } from '../../../src/shared/themes';

export interface ViewSettings {
  diffStyle: 'split' | 'unified';
  overflow: 'scroll' | 'wrap';
  theme: DiffTheme;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

const FONT_SUGGESTIONS = [
  'Commit Mono',
  'Berkeley Mono',
  'Dank Mono',
  'JetBrains Mono',
  'Monaspace Neon',
  'SF Mono',
  'ui-monospace',
];

export interface ToolbarProps {
  session: SessionInfo;
  filter: DiffFilter;
  onFilterChange(filter: DiffFilter): void;
  view: ViewSettings;
  onViewChange(view: ViewSettings): void;
  unifiedOnly: boolean;
  sidebarOpen: boolean;
  onToggleSidebar(): void;
  connection: 'connected' | 'connecting' | 'reconnecting' | 'ended';
  unsavedFiles: number;
  pendingAction: 'commit' | 'discard' | null;
  onCommit(): void;
  onDiscard(): void;
}

export function Toolbar({
  session,
  filter,
  onFilterChange,
  view,
  onViewChange,
  unifiedOnly,
  sidebarOpen,
  onToggleSidebar,
  connection,
  unsavedFiles,
  pendingAction,
  onCommit,
  onDiscard,
}: ToolbarProps) {
  const repoName = session.root.replace(/\/+$/, '').split('/').pop() || session.root;

  return (
    <header className="toolbar">
      <button
        type="button"
        className="icon-button sidebar-toggle"
        aria-controls="diff-sidebar"
        aria-expanded={sidebarOpen}
        aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        onClick={onToggleSidebar}
      >
        <ViewVerticalIcon aria-hidden="true" />
      </button>
      <div className="toolbar-title" title={session.root}>
        <span className="repo-name">{repoName}</span>
      </div>
      <label className="source-select">
        <span className="sr-only">Diff source</span>
        <select
          value={filter}
          disabled={pendingAction !== null}
          onChange={(event) => onFilterChange(event.target.value as DiffFilter)}
        >
          <option value="turn" disabled={session.turn === null}>
            Last turn
          </option>
          <option value="unstaged">{session.unstagedLabel}</option>
          <option value="branch">Branch</option>
        </select>
        <ChevronDownIcon aria-hidden="true" />
      </label>
      <div className="toolbar-right">
        {connection !== 'connected' && (
          <span className={`connection ${connection}`}>
            {connection === 'ended'
              ? 'session ended'
              : connection === 'reconnecting'
                ? 'reconnecting…'
                : 'connecting…'}
          </span>
        )}
        <DisplayOptions view={view} onViewChange={onViewChange} unifiedOnly={unifiedOnly} />
        {unsavedFiles > 0 && (
          <div className="edit-actions">
            <button
              type="button"
              className="edit-action"
              disabled={pendingAction !== null}
              onClick={onDiscard}
            >
              {pendingAction === 'discard' ? 'Discarding…' : 'Discard'}
            </button>
            <button
              type="button"
              className="edit-action commit"
              title="Commit local edits (⌘S / Ctrl+S)"
              aria-keyshortcuts="Meta+S Control+S"
              disabled={pendingAction !== null}
              onClick={onCommit}
            >
              {pendingAction === 'commit' ? 'Committing…' : 'Commit'}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

function DisplayOptions({
  view,
  onViewChange,
  unifiedOnly,
}: {
  view: ViewSettings;
  onViewChange(view: ViewSettings): void;
  unifiedOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="display-options" ref={containerRef}>
      <button
        type="button"
        className="icon-button"
        aria-label="Display options"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Display options"
        onClick={() => setOpen((value) => !value)}
      >
        <MixerHorizontalIcon aria-hidden="true" />
      </button>
      {open && (
        <div className="display-options-menu" role="dialog" aria-label="Display options">
          <div className="display-layout" role="group" aria-label="Diff layout">
            <button
              type="button"
              className={view.diffStyle === 'split' ? 'active' : undefined}
              aria-pressed={view.diffStyle === 'split'}
              disabled={unifiedOnly}
              title={unifiedOnly ? 'Split view is unavailable in narrow panes' : undefined}
              onClick={() => onViewChange({ ...view, diffStyle: 'split' })}
            >
              <ColumnsIcon aria-hidden="true" />
              Split
            </button>
            <button
              type="button"
              className={view.diffStyle === 'unified' ? 'active' : undefined}
              aria-pressed={view.diffStyle === 'unified'}
              onClick={() => onViewChange({ ...view, diffStyle: 'unified' })}
            >
              <RowsIcon aria-hidden="true" />
              Unified
            </button>
          </div>
          <label className="display-theme-row">
            <span>Theme</span>
            <span className="display-theme-select">
              <select
                value={view.theme}
                onChange={(event) =>
                  onViewChange({ ...view, theme: event.target.value as DiffTheme })
                }
              >
                {DIFF_THEMES.map((theme) => (
                  <option key={theme.value} value={theme.value}>
                    {theme.label}
                  </option>
                ))}
              </select>
              <ChevronDownIcon aria-hidden="true" />
            </span>
          </label>
          <div className="display-font-settings">
            <label className="display-field display-font-family">
              <span>Font family</span>
              <input
                type="text"
                list="diff-font-suggestions"
                value={view.fontFamily}
                spellCheck={false}
                onChange={(event) => onViewChange({ ...view, fontFamily: event.target.value })}
              />
              <datalist id="diff-font-suggestions">
                {FONT_SUGGESTIONS.map((font) => (
                  <option key={font} value={font} />
                ))}
              </datalist>
            </label>
            <label className="display-field">
              <span>Font size</span>
              <select
                value={view.fontSize}
                onChange={(event) =>
                  onViewChange({ ...view, fontSize: Number(event.target.value) })
                }
              >
                {FONT_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}px
                  </option>
                ))}
              </select>
            </label>
            <label className="display-field">
              <span>Line height</span>
              <select
                value={view.lineHeight}
                onChange={(event) =>
                  onViewChange({ ...view, lineHeight: Number(event.target.value) })
                }
              >
                {LINE_HEIGHTS.map((height) => (
                  <option key={height} value={height}>
                    {height}px
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            className="display-option-row"
            role="switch"
            aria-checked={view.overflow === 'wrap'}
            onClick={() =>
              onViewChange({ ...view, overflow: view.overflow === 'wrap' ? 'scroll' : 'wrap' })
            }
          >
            <span>Wrap lines</span>
            <span className="switch" aria-hidden="true">
              <span />
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
