import { useMemo, useState } from 'react';
import type { TFileFolder } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

export const UNFILED = '' as const;
export const ALL_FILES = null;

export interface FolderNode extends TFileFolder {
  children: FolderNode[];
}

/**
 * Build the tree from the flat list.
 *
 * A folder whose parent is missing is attached to the ROOT rather than dropped.
 * The same reasoning as a dangling `folderId` on a file: a partial delete must
 * surface things where they can be seen and acted on, because a folder nobody
 * can see cannot be deleted either.
 */
export function buildTree(folders: TFileFolder[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  for (const folder of folders) {
    byId.set(String(folder._id), { ...folder, children: [] });
  }
  const roots: FolderNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId != null ? byId.get(String(node.parentId)) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sort = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((node) => sort(node.children));
  };
  sort(roots);
  return roots;
}

interface FolderRowProps {
  node: FolderNode;
  depth: number;
  selectedId: string | null;
  onSelect: (folderId: string) => void;
  onDropFiles?: (folderId: string, fileIds: string[]) => void;
}

function FolderRow({ node, depth, selectedId, onSelect, onDropFiles }: FolderRowProps) {
  const [expanded, setExpanded] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const id = String(node._id);
  const hasChildren = node.children.length > 0;

  return (
    <>
      <div
        role="treeitem"
        aria-selected={selectedId === id}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-label={node.name}
        tabIndex={0}
        onClick={() => onSelect(id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(id);
          }
        }}
        onDragOver={(event) => {
          if (onDropFiles) {
            event.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          setDragOver(false);
          if (!onDropFiles) {
            return;
          }
          event.preventDefault();
          const raw = event.dataTransfer.getData('application/x-librechat-file-ids');
          if (!raw) {
            return;
          }
          try {
            const fileIds = JSON.parse(raw) as string[];
            if (Array.isArray(fileIds) && fileIds.length) {
              onDropFiles(id, fileIds);
            }
          } catch {
            /* A drop payload we cannot parse moves nothing, silently. Guessing
               which files were meant is worse than doing nothing. */
          }
        }}
        className={`flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-sm ${
          selectedId === id ? 'bg-surface-tertiary' : 'hover:bg-surface-hover'
        } ${dragOver ? 'ring-2 ring-blue-500' : ''}`}
        style={{ paddingInlineStart: `${depth * 12 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
            className="text-text-secondary"
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-3" />
        )}
        <span className="truncate">{node.name}</span>
      </div>
      {expanded &&
        node.children.map((child) => (
          <FolderRow
            key={String(child._id)}
            node={child}
            depth={depth + 1}
            selectedId={selectedId}
            onSelect={onSelect}
            onDropFiles={onDropFiles}
          />
        ))}
    </>
  );
}

interface FolderTreeProps {
  folders: TFileFolder[];
  selectedId: string | null;
  onSelect: (folderId: string | null) => void;
  onDropFiles?: (folderId: string, fileIds: string[]) => void;
}

export default function FolderTree({
  folders,
  selectedId,
  onSelect,
  onDropFiles,
}: FolderTreeProps) {
  const localize = useLocalize();
  const tree = useMemo(() => buildTree(folders), [folders]);

  return (
    <div role="tree" aria-label={localize('com_files_folders')} className="mb-2">
      <div
        role="treeitem"
        aria-selected={selectedId === ALL_FILES}
        tabIndex={0}
        onClick={() => onSelect(ALL_FILES)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(ALL_FILES);
          }
        }}
        className={`cursor-pointer rounded px-2 py-1 text-sm ${
          selectedId === ALL_FILES ? 'bg-surface-tertiary' : 'hover:bg-surface-hover'
        }`}
      >
        {localize('com_files_all')}
      </div>
      <div
        role="treeitem"
        aria-selected={selectedId === UNFILED}
        tabIndex={0}
        onClick={() => onSelect(UNFILED)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(UNFILED);
          }
        }}
        className={`cursor-pointer rounded px-2 py-1 text-sm ${
          selectedId === UNFILED ? 'bg-surface-tertiary' : 'hover:bg-surface-hover'
        }`}
      >
        {localize('com_files_unfiled')}
      </div>
      {tree.map((node) => (
        <FolderRow
          key={String(node._id)}
          node={node}
          depth={0}
          selectedId={selectedId}
          onSelect={onSelect}
          onDropFiles={onDropFiles}
        />
      ))}
    </div>
  );
}
