import { buildTree } from '../FolderTree';
import type { TFileFolder } from 'librechat-data-provider';

function folder(id: string, name: string, parentId: string | null, path: string): TFileFolder {
  return { _id: id, user: 'alice', name, parentId, path } as TFileFolder;
}

describe('buildTree', () => {
  it('nests children under their parents and sorts by name', () => {
    const tree = buildTree([
      folder('2', 'references', '1', '/tattoo/references'),
      folder('1', 'tattoo', null, '/tattoo'),
      folder('3', 'archive', null, '/archive'),
    ]);
    expect(tree.map((node) => node.name)).toEqual(['archive', 'tattoo']);
    expect(tree[1].children.map((node) => node.name)).toEqual(['references']);
  });

  it('attaches a folder whose parent is missing to the root rather than dropping it', () => {
    /* Same reasoning as a dangling folderId on a file: a partial delete must
       leave things visible, because a folder nobody can see cannot be deleted
       either. Dropping the node would hide the whole subtree under it. */
    const tree = buildTree([
      folder('2', 'orphan', 'missing-parent', '/gone/orphan'),
      folder('1', 'tattoo', null, '/tattoo'),
    ]);
    expect(tree.map((node) => node.name).sort()).toEqual(['orphan', 'tattoo']);
  });

  it('keeps a deep chain intact', () => {
    const tree = buildTree([
      folder('1', 'a', null, '/a'),
      folder('2', 'b', '1', '/a/b'),
      folder('3', 'c', '2', '/a/b/c'),
    ]);
    expect(tree[0].children[0].children[0].name).toBe('c');
  });

  it('returns an empty tree for no folders', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('does not lose a folder when two share a name under different parents', () => {
    const tree = buildTree([
      folder('1', 'a', null, '/a'),
      folder('2', 'b', null, '/b'),
      folder('3', 'shared', '1', '/a/shared'),
      folder('4', 'shared', '2', '/b/shared'),
    ]);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[1].children).toHaveLength(1);
  });
});
