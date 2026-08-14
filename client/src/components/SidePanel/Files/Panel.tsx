import { useMemo, useState } from 'react';
import { FileContext } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import {
  useGetFileFolders,
  useGetFilesInFolder,
  useCreateFileFolder,
  useDeleteFileFolder,
  useSetFilesFolder,
} from '~/data-provider';
import { dataService } from 'librechat-data-provider';
import FolderTree, { ALL_FILES, UNFILED } from './FolderTree';
import DeleteFolderDialog from './DeleteFolderDialog';
import { columns } from './PanelColumns';
import DataTable from './PanelTable';
import { useLocalize } from '~/hooks';

/**
 * Contexts a person put there themselves. The panel otherwise renders every
 * `File` document, including avatars, code-execution outputs and skill files,
 * which folders make worse rather than better: a library you are asked to
 * organise should not be full of things you did not put in it. The spec calls
 * this a prerequisite for the feature being pleasant, not a separate nicety.
 */
const LIBRARY_CONTEXTS = new Set<string>([
  FileContext.message_attachment,
  FileContext.image_generation,
  FileContext.assistants,
  FileContext.agents,
  FileContext.canvas_source,
]);

export default function FilesPanel() {
  const localize = useLocalize();
  const [selectedFolder, setSelectedFolder] = useState<string | null>(ALL_FILES);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [counts, setCounts] = useState<{ folders: number; files: number } | undefined>();
  const [showEverything, setShowEverything] = useState(false);

  const { data: folders = [] } = useGetFileFolders();
  const { data: files = [] } = useGetFilesInFolder(
    selectedFolder === ALL_FILES ? undefined : selectedFolder,
  );
  const createFolder = useCreateFileFolder();
  const deleteFolder = useDeleteFileFolder();
  const setFilesFolder = useSetFilesFolder();

  const visible = useMemo(() => {
    if (showEverything) {
      return files;
    }
    return files.filter(
      (file: TFile) => file.context == null || LIBRARY_CONTEXTS.has(file.context),
    );
  }, [files, showEverything]);

  const hiddenCount = files.length - visible.length;

  return (
    <div className="h-auto w-full px-3 pb-3 pt-2">
      <FolderTree
        folders={folders}
        selectedId={selectedFolder}
        onSelect={setSelectedFolder}
        onDropFiles={(folderId, fileIds) => setFilesFolder.mutate({ fileIds, folderId })}
      />

      <div className="mb-2 flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => {
            const name = window.prompt(localize('com_files_new_folder'));
            if (name != null && name.trim() !== '') {
              createFolder.mutate({
                name,
                parentId:
                  selectedFolder === ALL_FILES || selectedFolder === UNFILED
                    ? null
                    : selectedFolder,
              });
            }
          }}
        >
          {localize('com_files_new_folder')}
        </button>
        {selectedFolder != null && selectedFolder !== UNFILED ? (
          <>
            <button
              type="button"
              onClick={() => setFilesFolder.mutate({ fileIds: [], folderId: null })}
              hidden
            />
            <button
              type="button"
              className="text-red-500"
              onClick={async () => {
                const folder = folders.find((entry) => String(entry._id) === selectedFolder);
                setCounts(undefined);
                setPendingDelete({ id: selectedFolder, name: folder?.name ?? '' });
                /* Fetch the counts before showing a number, never guess them:
                   the dialog's whole job is to state what will be lost. */
                setCounts(await dataService.getFileFolderContents(selectedFolder));
              }}
            >
              {localize('com_files_delete_folder')}
            </button>
          </>
        ) : null}
        {hiddenCount > 0 ? (
          <button type="button" onClick={() => setShowEverything((value) => !value)}>
            {showEverything
              ? localize('com_files_hide_system')
              : localize('com_files_show_system', { 0: `${hiddenCount}` })}
          </button>
        ) : null}
      </div>

      <DataTable columns={columns} data={visible} />

      {pendingDelete != null ? (
        <DeleteFolderDialog
          folderName={pendingDelete.name}
          counts={counts}
          isLoading={counts == null}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            deleteFolder.mutate(pendingDelete.id, {
              onSuccess: () => setSelectedFolder(ALL_FILES),
            });
            setPendingDelete(null);
          }}
        />
      ) : null}
    </div>
  );
}
