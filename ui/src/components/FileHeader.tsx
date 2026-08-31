import { ChevronDownIcon } from '@radix-ui/react-icons';
import { createContext, useContext, type ReactNode } from 'react';

import type { PatchFileSummary } from '../../../src/shared/protocol';

const KIND_BADGE: Record<PatchFileSummary['kind'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

interface FileHeaderState {
  files: ReadonlyMap<string, PatchFileSummary>;
  dirtyPaths: ReadonlySet<string>;
}

const FileHeaderContext = createContext<FileHeaderState>({
  files: new Map(),
  dirtyPaths: new Set(),
});

export function FileHeadersProvider({
  value,
  children,
}: {
  value: FileHeaderState;
  children: ReactNode;
}) {
  return <FileHeaderContext.Provider value={value}>{children}</FileHeaderContext.Provider>;
}

export function FileHeader({
  path,
  collapsed,
  onToggleCollapsed,
}: {
  path: string;
  collapsed: boolean;
  onToggleCollapsed(path: string): void;
}) {
  const { files, dirtyPaths } = useContext(FileHeaderContext);
  const summary = files.get(path);
  return (
    <div className="file-header">
      <button
        type="button"
        className="collapse-button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand diff' : 'Collapse diff'}
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
      {dirtyPaths.has(path) && (
        <span
          className="dirty-dot"
          role="img"
          aria-label="Unsaved changes"
          title="Unsaved changes"
        />
      )}
      {summary &&
        (summary.binary ? (
          <span className="file-stats binary">binary</span>
        ) : (
          <span className="file-stats">
            <span className="add">+{summary.additions}</span>
            <span className="del">−{summary.deletions}</span>
          </span>
        ))}
    </div>
  );
}
