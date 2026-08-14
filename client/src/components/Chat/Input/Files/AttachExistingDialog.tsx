import { useMemo, useState } from 'react';
import type { TFile, TFileFolder } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import { useGetFileFolders, useGetFilesInFolder } from '~/data-provider';
import FolderTree, { ALL_FILES, UNFILED } from '~/components/SidePanel/Files/FolderTree';
import { useLocalize } from '~/hooks';

/**
 * Attach a file the user already has, without uploading it again.
 *
 * This REFERENCES, it does not copy. Upstream's SharePoint picker downloads and
 * creates a new `File` document, which is right for an external source and
 * wrong here: no copy, no new document, no bytes moved. The selection yields
 * `file_id`s and nothing else happens, because putting a `file_id` into the
 * request is already how a just-uploaded file is attached — uploading only ever
 * existed to CREATE the file, never to attach it.
 *
 * `attached: true` matters and is not cosmetic: `FileRow` uses it to decide
 * that removing a file from the composer must not delete the underlying file.
 * Without it, dismissing a referenced photo from one message would destroy the
 * original.
 *
 * `conversationId` is deliberately left alone. It is optional on the schema, so
 * it records where a file was first uploaded — provenance, not ownership. If
 * attaching rewrote it, a file would appear to move between conversations and
 * the most recent chat would erase where it came from.
 */
export function toAttachedFile(file: TFile): ExtendedFile {
  return {
    file_id: file.file_id,
    filename: file.filename,
    filepath: file.filepath,
    type: file.type,
    width: file.width,
    height: file.height,
    size: file.bytes ?? 0,
    progress: 1,
    attached: true,
    source: file.source,
    metadata: file.metadata,
  };
}

interface AttachExistingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  setFiles: FileSetter;
  toolResource?: string;
}

export default function AttachExistingDialog({
  isOpen,
  onClose,
  setFiles,
  toolResource,
}: AttachExistingDialogProps) {
  const localize = useLocalize();
  const [folderId, setFolderId] = useState<string | null>(ALL_FILES);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: folders = [] as TFileFolder[] } = useGetFileFolders(undefined, {
    enabled: isOpen,
  });
  const { data: files = [] as TFile[] } = useGetFilesInFolder(
    folderId === ALL_FILES ? undefined : folderId,
    false,
    { enabled: isOpen },
  );

  const selectable = useMemo(() => files.filter((file: TFile) => file.file_id != null), [files]);

  if (!isOpen) {
    return null;
  }

  const confirm = () => {
    const chosen = selectable.filter((file: TFile) => selected.has(file.file_id));
    if (chosen.length) {
      setFiles((current) => {
        const next = new Map(current);
        for (const file of chosen) {
          next.set(file.file_id, {
            ...toAttachedFile(file),
            ...(toolResource != null ? { tool_resource: toolResource } : {}),
          });
        }
        return next;
      });
    }
    setSelected(new Set());
    onClose();
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={localize('com_files_attach_existing')}>
      <div className="flex gap-4">
        <div className="w-48 shrink-0">
          <FolderTree folders={folders} selectedId={folderId} onSelect={setFolderId} />
        </div>
        <ul className="flex-1 overflow-y-auto" aria-label={localize('com_files_attach_existing')}>
          {selectable.length === 0 ? (
            <li className="text-text-secondary text-sm">{localize('com_files_none_here')}</li>
          ) : (
            selectable.map((file: TFile) => (
              <li key={file.file_id}>
                <label className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(file.file_id)}
                    onChange={(event) => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) {
                          next.add(file.file_id);
                        } else {
                          next.delete(file.file_id);
                        }
                        return next;
                      });
                    }}
                  />
                  <span className="truncate">{file.filename}</span>
                </label>
              </li>
            ))
          )}
        </ul>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose}>
          {localize('com_ui_cancel')}
        </button>
        <button type="button" onClick={confirm} disabled={selected.size === 0}>
          {localize('com_files_attach_selected', { 0: `${selected.size}` })}
        </button>
      </div>
    </div>
  );
}

export { UNFILED };
