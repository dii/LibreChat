# Spec: Folders for user files

**Status:** proposal, not built.
**Background:** [`artefact-model.md`](artefact-model.md). This is the organisation layer over the
store that note describes, and it is why [`spec-canvas-on-files.md`](spec-canvas-on-files.md)'s
convergence matters: an artefact that is a `File` document is filable, one in its own store is not.

**Verified dependency landscape (2026-08-08):**

| Dependency | State | What it means here |
| --- | --- | --- |
| `File` schema (`packages/data-schemas/src/schema/file.ts`) | merged, upstream | has **no** `folder`, `tags`, `parent` or `collection`. Nothing to build on. |
| `conversationTag` schema | merged, upstream | precedent: a user-owned organisational collection with an indexed `user`, plus `count` and `position`. A `Folder` collection is idiomatic here, not novel. |
| `GET /api/files` → `getFiles({user})` | merged, upstream | the listing this extends. Takes an arbitrary filter, so folder queries are free. |
| `SidePanel/Files/Panel.tsx` | merged, upstream | renders that list unfiltered. The UI this hangs off. |
| `processDeleteRequest` (`api/server/services/Files/process.js:208`) | merged, upstream | takes `{req, files}`, so a folder delete can hand it a list. Bytes are actually reclaimed. |

---

## 1. Needs

| | Need | Provenance |
| --- | --- | --- |
| **F1** | Organise your files into directories and subdirectories | **owner, 2026-08-08** |
| **F2** | Deleting a folder deletes what is in it, with a warning first | **owner, 2026-08-08** |
| **F3** | Nobody else in the household can see or reach your folders | consistent with U6/C6 |
| **F4** | Every artefact in the file store is filable, including canvas documents | derived from C8 |
| **F5** | Turning it on changes nothing else | author |

## 2. Shape

**Folders are records, not a path string on the file.** A new `Folder` collection, and one nullable
`folderId` on `File`.

```
Folder { _id, user, parentId (null at root), name, path, position?, timestamps }
File   { …existing…, folderId (nullable; null means unfiled) }
```

`path` is the **denormalised materialised path of the folder**, for example `/tattoo/references`.
It exists so a subtree is a prefix query rather than a recursive traversal.

The placement matters and is the whole reason for this shape. Because the path lives on the
**folder** and not on the file:

- a subtree read is a cheap prefix match on a small collection;
- **renaming or moving a folder rewrites folder rows only, never file rows.** There are orders of
  magnitude fewer folders than files, so the update that would be prohibitive on files is trivial
  here.

An earlier draft proposed a path string on each file. That gets cheap reads and pays for them with
an N-file rewrite on every rename, and cannot represent an empty folder at all. This shape gets
both properties instead of trading one for the other.

**Fork cost:** the new collection is purely **additive** and touches no upstream schema. The only
upstream change is one nullable field on `File`, the same one-field cost as the rejected string,
with strictly better behaviour.

## 3. Operations

**Create.** A folder may exist while empty. That is the main thing the rejected shape could not do
and the main reason people find path-only systems irritating.

**Rename and move.** Update `name` and/or `parentId` on the folder, then rewrite `path` on that
folder and its descendants, which is a prefix rewrite over folder rows. Files are not touched.

**File and unfile.** Set or clear `folderId` on the file. **The `folderId` arrives from the client
and must be validated against the requesting user before it is written.** See §5.

**List.** Files in one folder: `getFiles({ user, folderId })`. Unfiled: `folderId: null`. A whole
subtree: folders by `path` prefix, then files whose `folderId` is in that set.

**Delete.** §4.

## 4. Deleting a folder deletes its contents

Owner decision, 2026-08-08. This is the most destructive operation in the feature and there are no
versions and no trash, so it deserves more care than a confirm dialog.

**The warning must carry counts, not just a question.** "Delete 12 files in 3 folders?" is a
decision; "Are you sure?" is a reflex. State how many files and how many nested folders.

**Contents go through `processDeleteRequest`**, so bytes are actually reclaimed rather than records
merely unlinked. Anything else leaves orphaned bytes in storage, which is the failure this whole
artefact effort exists to avoid.

**Order matters: contents first, folder last.** If the folder row went first and a file deletion
then failed, the surviving files would point at a folder that no longer exists.

**A dangling `folderId` must never hide a file.** Even with the ordering above, a partial failure
is possible. The listing treats a `folderId` with no matching folder as **unfiled**, so a file
surfaces at the root rather than disappearing. A file that cannot be seen cannot be deleted either,
and a user who believes something is gone when it is not is the worse outcome of the two.

**Report partial failure honestly.** If some files could not be deleted, say which and leave the
folder in place. Removing the folder while its contents survive is exactly how things become
invisible.

## 5. Isolation

Every folder query is scoped by `user`. That is F3 and it is the easy half.

The half that needs stating: **`folderId` is client-supplied.** Filing a file means the client
naming a folder, and a naming a folder it does not own must be refused, not written.

This is the same class of defect as the one found in the image work on 2026-08-08, where
`requestFileIds` came from `req.body.files` and the query was not scoped to the principal, so
anyone who knew a file id could pull another user's metadata into their own context. The lesson
generalises: **an id that arrives from the caller is an assertion, not a fact.** Validate folder
ownership on every move, and scope every listing by user regardless.

**Account deletion** must remove the user's folders. Note that `deleteUserController` already runs
the per-file funnel and then a raw `deleteMany({user})` that bypasses it; folders should be removed
explicitly rather than assumed to follow.

## 6. What the model sees: nothing, in v1

Folders are a **user** surface. The model is not told the folder structure and cannot browse it.

Same reasoning as the thread-scoped image context and the narrowing of `canvas_doc_list`: the
owner's view is everything they own, the model's view stays narrow, and widening it is noise, token
cost and an invitation to reach into unrelated work.

**Left open deliberately:** user-initiated scoping, as in "work with the files in my tattoo
folder". That is the user pointing rather than the model browsing, which is a different thing and a
reasonable v2. It is noted so that if it is built, it is built as scoping and not as a listing.

## 7. Interaction

**Canvas.** Once canvas documents are `File` documents, they file like anything else and this
spec needs no canvas-specific case. That is C8, and it is the strongest argument for that
convergence.

**Image references.** None. A reference names a `file_id`; where the file sits is irrelevant to it,
and the thread-scoped image set ignores folders entirely.

**The unfiltered panel.** `artefact-model.md` §6 notes the files panel renders every file including
avatars, code-execution outputs and skill files. Folders make that worse, because a library you are
expected to organise should not be full of things you did not put there. Filtering by `context` is
a prerequisite for this feature being pleasant, not a separate nicety.

## 8. Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| A path string on each file | Cheap reads paid for with an N-file rewrite on every rename or move, and no empty folders. Both problems vanish when the path lives on the folder. |
| Pure adjacency, `parentId` only, no path | Every subtree read becomes a recursive traversal. `$graphLookup` makes it possible, not cheap, and the denormalised path costs one string. |
| Nested sets or a closure table | Cheaper reads still, at a write cost and a conceptual cost far beyond a household library. |
| Tags instead of folders | A reasonable model, and not what was asked for. Directories and subdirectories were. |

## 9. Risks and open decisions

1. **Depth and name rules.** A cap on nesting depth, and whether two files may share a name in one
   folder. Both need an answer before the UI is built; neither is interesting.
2. **Delete is irreversible.** No versions, no trash. §4 mitigates with counts and ordering, but the
   first time someone deletes the wrong folder there is no recovery. A trash state is the obvious
   v2 and is deliberately not in v1.
3. **`context` filtering is a prerequisite**, per §7, and is not scoped here.
4. **Upstreamability.** This is the most generic thing in the fork and the most plausible upstream
   contribution. Worth building as though it will be offered, which mostly means not inventing
   conventions where `conversationTag` already set one.

## 10. Test plan

| Area | Test |
| --- | --- |
| F1 | Create nested folders, file and unfile, list one folder and a whole subtree. |
| Rename | Renaming a folder with descendants rewrites descendant paths and **touches no file row**. |
| Empty | A folder created and left empty still exists after a reload. |
| F2 | Deleting a folder deletes its files through `processDeleteRequest`, reclaiming bytes, and the confirmation carries file and folder counts. |
| F2 partial | With one file deletion failing: the folder survives, the failure is reported, and nothing is silently lost. |
| Dangling | A file whose folder row is gone appears as unfiled, never hidden. |
| F3 | Every listing is user-scoped. Filing a file into another user's folder is refused and writes nothing. |
| F5 | A request that touches no folder performs no extra query. |
| Account | Deleting a user removes their folders. |

## 11. Slicing

1. **The `Folder` collection, its CRUD, and ownership validation.** No UI. The isolation surface
   gets reviewed on its own rather than riding along inside a feature.
2. **`folderId` on `File`, filing and unfiling, listing by folder and subtree.**
3. **The UI**: a tree in the files panel, move-to, and delete with counts. Plus the `context`
   filtering from §7, without which the library is a dumping ground.
