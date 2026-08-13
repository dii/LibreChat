import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type {
  UseMutationResult,
  QueryObserverResult,
  UseQueryOptions,
} from '@tanstack/react-query';
import type t from 'librechat-data-provider';

/**
 * Every mutation here invalidates BOTH the folder list and the file list.
 * Filing a file changes which folder view it belongs to, and deleting a folder
 * removes files as well, so invalidating only the folders would leave a stale
 * panel showing files that are gone — the visible half of the "a file that
 * cannot be seen cannot be deleted" problem this feature is careful about.
 */
function useInvalidateLibrary() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries([QueryKeys.fileFolders]);
    queryClient.invalidateQueries([QueryKeys.files]);
  };
}

export const useGetFileFolders = (
  parentId?: string | null,
  config?: UseQueryOptions<t.TFileFolder[]>,
): QueryObserverResult<t.TFileFolder[]> => {
  return useQuery<t.TFileFolder[]>(
    [QueryKeys.fileFolders, parentId ?? 'all'],
    () => dataService.getFileFolders(parentId),
    { refetchOnWindowFocus: false, ...config },
  );
};

export const useCreateFileFolder = (): UseMutationResult<
  t.TFileFolder,
  unknown,
  { name: string; parentId?: string | null }
> => {
  const invalidate = useInvalidateLibrary();
  return useMutation((payload) => dataService.createFileFolder(payload), {
    onSuccess: invalidate,
  });
};

export const useUpdateFileFolder = (): UseMutationResult<
  t.TFileFolder,
  unknown,
  { folderId: string; name?: string; parentId?: string | null }
> => {
  const invalidate = useInvalidateLibrary();
  return useMutation(
    ({ folderId, ...payload }) => dataService.updateFileFolder(folderId, payload),
    { onSuccess: invalidate },
  );
};

export const useDeleteFileFolder = (): UseMutationResult<
  { folders: number; files: number },
  unknown,
  string
> => {
  const invalidate = useInvalidateLibrary();
  return useMutation((folderId) => dataService.deleteFileFolder(folderId), {
    onSuccess: invalidate,
  });
};

export const useSetFilesFolder = (): UseMutationResult<
  { moved: number },
  unknown,
  { fileIds: string[]; folderId: string | null }
> => {
  const invalidate = useInvalidateLibrary();
  return useMutation((payload) => dataService.setFilesFolder(payload), {
    onSuccess: invalidate,
  });
};

export const useGetFilesInFolder = (
  folderId?: string | null,
  subtree?: boolean,
  config?: UseQueryOptions<t.TFile[]>,
): QueryObserverResult<t.TFile[]> => {
  return useQuery<t.TFile[]>(
    [QueryKeys.files, folderId ?? 'all', subtree === true],
    () => dataService.getFilesInFolder(folderId, subtree),
    { refetchOnWindowFocus: false, ...config },
  );
};
