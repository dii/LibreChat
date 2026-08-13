import { useLocalize } from '~/hooks';

interface DeleteFolderDialogProps {
  folderName: string;
  counts?: { folders: number; files: number };
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The warning carries counts, not just a question.
 *
 * "Delete 12 files in 3 folders?" is a decision; "Are you sure?" is a reflex.
 * There are no versions and no trash behind this, so the dialog is the only
 * place the user can find out what they are about to lose. Confirmation stays
 * disabled until the counts have loaded, because a confirm button that appears
 * before the number does is a confirm button that gets pressed before it.
 */
export default function DeleteFolderDialog({
  folderName,
  counts,
  isLoading,
  onConfirm,
  onCancel,
}: DeleteFolderDialogProps) {
  const localize = useLocalize();
  const total = (counts?.files ?? 0) + (counts?.folders ?? 0);

  return (
    <div role="alertdialog" aria-modal="true" aria-label={localize('com_files_delete_folder')}>
      <p>
        {isLoading === true || counts == null
          ? localize('com_files_delete_folder_counting')
          : localize('com_files_delete_folder_warning', {
              0: folderName,
              1: `${counts.files}`,
              2: `${counts.folders}`,
            })}
      </p>
      {total === 0 && counts != null ? <p>{localize('com_files_delete_folder_empty')}</p> : null}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel}>
          {localize('com_ui_cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isLoading === true || counts == null}
          className="text-red-500"
        >
          {localize('com_ui_delete')}
        </button>
      </div>
    </div>
  );
}
