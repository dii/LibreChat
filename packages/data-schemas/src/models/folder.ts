import { Model } from 'mongoose';
import folderSchema, { IFolder } from '~/schema/folder';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';

export function createFolderModel(mongoose: typeof import('mongoose')): Model<IFolder> {
  applyTenantIsolation(folderSchema);
  return mongoose.models.Folder || mongoose.model<IFolder>('Folder', folderSchema);
}
