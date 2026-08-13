import { Schema, Document } from 'mongoose';

export interface IFolder extends Document {
  user: string;
  name: string;
  /** Parent folder, or null at the root. */
  parentId?: string | null;
  /**
   * Denormalised materialised path of THIS folder, e.g. `/tattoo/references`.
   *
   * It lives on the folder and deliberately not on the file. A subtree read is
   * then a prefix match over a small collection, and renaming or moving a folder
   * rewrites folder rows only — never file rows, of which there are orders of
   * magnitude more. Storing the path on each file would buy the same cheap read
   * and pay for it with an N-file rewrite on every rename, and could not
   * represent an empty folder at all.
   */
  path: string;
  position?: number;
  tenantId?: string;
}

const folder: Schema<IFolder> = new Schema<IFolder>(
  {
    user: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    parentId: {
      type: String,
      default: null,
      index: true,
    },
    path: {
      type: String,
      required: true,
      index: true,
    },
    position: {
      type: Number,
      default: 0,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

/** Subtree reads are a prefix match on `path`, always scoped to one user. */
folder.index({ user: 1, path: 1, tenantId: 1 });

/** Listing the children of a folder, and the root listing where parentId is null. */
folder.index({ user: 1, parentId: 1, tenantId: 1 });

/** Two folders cannot share a name under the same parent, for the same user. */
folder.index({ user: 1, parentId: 1, name: 1, tenantId: 1 }, { unique: true });

export default folder;
