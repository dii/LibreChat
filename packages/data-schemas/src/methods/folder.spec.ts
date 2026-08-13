import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createFolderModel } from '~/models/folder';
import { createFolderMethods, FolderError } from './folder';

/**
 * Against a real mongod, not a mock. The unique index, the `$regex` prefix and
 * the ownership scope are all database behaviour, and a mocked model would
 * report success for every one of them while the feature was broken — which is
 * exactly how a strict-mode schema silently discarded a field in this fork's
 * history.
 */
let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createFolderMethods>;

const ALICE = 'alice-user-id';
const BOB = 'bob-user-id';

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createFolderModel(mongoose);
  await mongoose.models.Folder.syncIndexes();
  methods = createFolderMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.models.Folder.deleteMany({});
});

describe('creating folders', () => {
  it('creates a root folder with a leading-slash path', async () => {
    const folder = await methods.createFolder({ user: ALICE, name: 'tattoo' });
    expect(folder.path).toBe('/tattoo');
    expect(folder.parentId).toBeNull();
  });

  it('nests a child under its parent path', async () => {
    const parent = await methods.createFolder({ user: ALICE, name: 'tattoo' });
    const child = await methods.createFolder({
      user: ALICE,
      name: 'references',
      parentId: String(parent._id),
    });
    expect(child.path).toBe('/tattoo/references');
    expect(child.parentId).toBe(String(parent._id));
  });

  it('allows an empty folder to exist', async () => {
    const folder = await methods.createFolder({ user: ALICE, name: 'empty' });
    expect(await methods.listFolders(ALICE)).toHaveLength(1);
    expect(folder.path).toBe('/empty');
  });

  it('refuses two folders of the same name under one parent', async () => {
    await methods.createFolder({ user: ALICE, name: 'tattoo' });
    await expect(methods.createFolder({ user: ALICE, name: 'tattoo' })).rejects.toThrow(
      /already here/,
    );
  });

  it('allows the same name under different parents', async () => {
    const a = await methods.createFolder({ user: ALICE, name: 'a' });
    const b = await methods.createFolder({ user: ALICE, name: 'b' });
    await methods.createFolder({ user: ALICE, name: 'shared', parentId: String(a._id) });
    await expect(
      methods.createFolder({ user: ALICE, name: 'shared', parentId: String(b._id) }),
    ).resolves.toBeDefined();
  });

  it('allows two users the same folder name', async () => {
    await methods.createFolder({ user: ALICE, name: 'tattoo' });
    await expect(methods.createFolder({ user: BOB, name: 'tattoo' })).resolves.toBeDefined();
  });

  it.each(['', '   ', 'has/slash', 'x'.repeat(121)])('rejects the invalid name %p', async (name) => {
    await expect(methods.createFolder({ user: ALICE, name })).rejects.toThrow(/name/i);
  });
});

describe('isolation (F3)', () => {
  it("refuses to create inside another user's folder", async () => {
    const bobs = await methods.createFolder({ user: BOB, name: 'private' });
    await expect(
      methods.createFolder({ user: ALICE, name: 'sneaky', parentId: String(bobs._id) }),
    ).rejects.toThrow(/No such folder/);
  });

  it("reports another user's folder identically to one that does not exist", async () => {
    const bobs = await methods.createFolder({ user: BOB, name: 'private' });
    const missing = new mongoose.Types.ObjectId();

    const foreign = await methods.requireOwnedFolder(ALICE, String(bobs._id)).catch((e) => e);
    const absent = await methods.requireOwnedFolder(ALICE, String(missing)).catch((e) => e);

    /* If these differed, the error itself would confirm the folder exists and is
       someone else's, which is an enumeration oracle. */
    expect(foreign.message).toBe(absent.message);
    expect((foreign as FolderError).code).toBe((absent as FolderError).code);
  });

  it('never lists another user\'s folders', async () => {
    await methods.createFolder({ user: BOB, name: 'bobs' });
    await methods.createFolder({ user: ALICE, name: 'alices' });
    const listed = await methods.listFolders(ALICE);
    expect(listed.map((f) => f.name)).toEqual(['alices']);
  });

  it('treats a malformed id as not found rather than throwing a cast error', async () => {
    await expect(methods.requireOwnedFolder(ALICE, 'not-an-object-id')).rejects.toThrow(
      /No such folder/,
    );
  });

  it('treats a null folderId as the root, which every user owns', async () => {
    await expect(methods.requireOwnedFolder(ALICE, null)).resolves.toBeNull();
    await expect(methods.requireOwnedFolder(ALICE, undefined)).resolves.toBeNull();
  });
});

describe('renaming and moving', () => {
  async function tree() {
    const tattoo = await methods.createFolder({ user: ALICE, name: 'tattoo' });
    const refs = await methods.createFolder({
      user: ALICE,
      name: 'references',
      parentId: String(tattoo._id),
    });
    const deep = await methods.createFolder({
      user: ALICE,
      name: 'lions',
      parentId: String(refs._id),
    });
    return { tattoo, refs, deep };
  }

  it('rewrites descendant paths on a rename', async () => {
    const { tattoo, deep } = await tree();
    await methods.moveFolder({ user: ALICE, folderId: String(tattoo._id), name: 'ink' });
    const after = await methods.requireOwnedFolder(ALICE, String(deep._id));
    expect(after?.path).toBe('/ink/references/lions');
  });

  it('rewrites descendant paths on a move', async () => {
    const { refs, deep } = await tree();
    const archive = await methods.createFolder({ user: ALICE, name: 'archive' });
    await methods.moveFolder({
      user: ALICE,
      folderId: String(refs._id),
      parentId: String(archive._id),
    });
    const after = await methods.requireOwnedFolder(ALICE, String(deep._id));
    expect(after?.path).toBe('/archive/references/lions');
  });

  it('moves a folder to the root', async () => {
    const { refs } = await tree();
    const moved = await methods.moveFolder({
      user: ALICE,
      folderId: String(refs._id),
      parentId: null,
    });
    expect(moved.path).toBe('/references');
    expect(moved.parentId).toBeNull();
  });

  it('refuses to move a folder into itself', async () => {
    const { tattoo } = await tree();
    await expect(
      methods.moveFolder({
        user: ALICE,
        folderId: String(tattoo._id),
        parentId: String(tattoo._id),
      }),
    ).rejects.toThrow(/itself/);
  });

  it('refuses to move a folder into its own descendant', async () => {
    const { tattoo, deep } = await tree();
    /* This is the one that detaches a subtree from the root permanently: the
       rows survive, nothing lists them, and the bytes become unreachable. */
    await expect(
      methods.moveFolder({
        user: ALICE,
        folderId: String(tattoo._id),
        parentId: String(deep._id),
      }),
    ).rejects.toThrow(/subtree/);
  });

  it("refuses to move a folder into another user's folder", async () => {
    const { tattoo } = await tree();
    const bobs = await methods.createFolder({ user: BOB, name: 'bobs' });
    await expect(
      methods.moveFolder({
        user: ALICE,
        folderId: String(tattoo._id),
        parentId: String(bobs._id),
      }),
    ).rejects.toThrow(/No such folder/);
  });

  it('does not let a regex-shaped sibling name capture another subtree', async () => {
    /* Folder names are user input and reach a $regex. Unescaped, "a.*" matches
       "ab" and a rename would rewrite the wrong subtree. */
    const tricky = await methods.createFolder({ user: ALICE, name: 'a.*' });
    const sibling = await methods.createFolder({ user: ALICE, name: 'ab' });
    const inSibling = await methods.createFolder({
      user: ALICE,
      name: 'kept',
      parentId: String(sibling._id),
    });

    await methods.moveFolder({ user: ALICE, folderId: String(tricky._id), name: 'renamed' });

    const untouched = await methods.requireOwnedFolder(ALICE, String(inSibling._id));
    expect(untouched?.path).toBe('/ab/kept');
  });
});

describe('subtree and deletion', () => {
  it('lists a subtree including the folder itself', async () => {
    const parent = await methods.createFolder({ user: ALICE, name: 'p' });
    const child = await methods.createFolder({
      user: ALICE,
      name: 'c',
      parentId: String(parent._id),
    });
    const subtree = await methods.listSubtree(ALICE, String(parent._id));
    expect(subtree.map((f) => String(f._id)).sort()).toEqual(
      [String(parent._id), String(child._id)].sort(),
    );
  });

  it('does not include a sibling whose path merely shares a prefix', async () => {
    const parent = await methods.createFolder({ user: ALICE, name: 'photo' });
    await methods.createFolder({ user: ALICE, name: 'photos' });
    const subtree = await methods.listSubtree(ALICE, String(parent._id));
    expect(subtree).toHaveLength(1);
  });

  it('deletes the folder and its descendants, returning the ids removed', async () => {
    const parent = await methods.createFolder({ user: ALICE, name: 'p' });
    await methods.createFolder({ user: ALICE, name: 'c', parentId: String(parent._id) });
    const removed = await methods.deleteFolderRecords(ALICE, String(parent._id));
    expect(removed).toHaveLength(2);
    expect(await methods.listFolders(ALICE)).toHaveLength(0);
  });

  it("will not delete another user's folder", async () => {
    const bobs = await methods.createFolder({ user: BOB, name: 'bobs' });
    await expect(methods.deleteFolderRecords(ALICE, String(bobs._id))).rejects.toThrow(
      /No such folder/,
    );
    expect(await methods.listFolders(BOB)).toHaveLength(1);
  });

  it('removes only the named user on account deletion', async () => {
    await methods.createFolder({ user: ALICE, name: 'a' });
    await methods.createFolder({ user: BOB, name: 'b' });
    expect(await methods.deleteUserFolders(ALICE)).toBe(1);
    expect(await methods.listFolders(BOB)).toHaveLength(1);
  });
});
