# Artefacts: what they are, who owns them, and how they are seen

**Status:** design note, 2026-08-08. Written to answer one question before more artefact
machinery gets built: *is this fork accreting a separate model per artefact type?*

**The short answer:** it has two artefact **stores**, not three, and only one of them is visible
to the person who owns the things in it. The image work is not a third store; understanding why
is most of what this note is for.

---

## 1. What an artefact is

Anything a conversation produces or consumes that outlives the message it appeared in: an
uploaded photo, a generated image, a code-execution output, an OCR'd document, a canvas
document. Not: the messages themselves, or anything reconstructible from them.

Five questions decide whether artefacts are one thing or several. This note answers them for
each mechanism and then compares.

1. **Where do the bytes live?**
2. **How is ownership expressed, and is it queryable?**
3. **How is it referred to?**
4. **How does the owner see it?**
5. **How is it deleted, and does deleting it remove it?**

## 2. The two stores, and the thing that is not a store

### 2.1 File documents — the general store

Bytes live in a storage strategy (local, s3, azure, firebase, cloudfront); metadata lives in the
`File` collection. Ownership is a `user` field, so it is **queryable**, which turns out to be the
property everything else depends on. Referred to by `file_id`. Kinds are distinguished by a
`context` field: `message_attachment`, `image_generation`, `execute_code`, `assistants_output`,
`skill_file`, `avatar`, `agents`, `assistants`.

Seen at `GET /api/files`, which is `getFiles({ user: req.user.id })`, rendered by
`client/src/components/SidePanel/Files/Panel.tsx` with a delete control beside each row.

Deleted through `processDeleteRequest` (`api/server/services/Files/process.js:208`), which is the
funnel for the ordinary paths. One exception matters: `deleteUserController` calls it and then
issues a raw `db.deleteFiles(null, user.id)`, an unconditional `deleteMany({user})` that no
per-file hook observes, so anything whose storage deletion failed is dropped from Mongo without
its bytes being reclaimed.

### 2.2 Canvas documents — the second store

Bytes live in a git repository on disk at `<CANVAS_SOURCES_DIR>/<userId>/docs`, with a per-user
`.canvas/index.json`. **No `File` document is ever created.** Ownership is expressed as a
directory path, which isolates correctly but is **not queryable** alongside anything else.
Referred to by `docKey`, a validated stable handle recorded in that index.

Seen: **nowhere by the user.** The only client-side references to canvas are in the attach menu,
which puts documents *in*. There is no list and no delete control. The only listing is
`canvas_doc_list`, an MCP tool, so the model can enumerate a user's canvas documents and the user
cannot.

Deleted by `canvas_doc_delete`, also an MCP tool, calling `POST /api/canvas-admin/delete` behind
a service token. So the user's only route to deleting their own document is to ask the model to
do it and trust that it picked the right one.

### 2.3 Image references — not a store

`lcimg_<payload>.<mac>` binds one `file_id` to one principal with a short expiry. It creates no
storage, no new document and no second copy. It is an **access scheme over §2.1**, and the
broker holds only a bounded, short-lived cache of bytes it fetched.

This is why the image work needed no library of its own. Uploads and renders are both ordinary
`File` documents (`saveBase64Image` creates one for every tool output), so they already appear in
the panel from §2.1 and are already deletable there. The decision not to let the broker keep a
durable copy is what makes that true: deleting in the panel removes the artefact rather than
leaving an orphan somewhere else.

## 3. Compared

| | File documents | Canvas documents | Image references |
| --- | --- | --- | --- |
| Bytes | storage strategy | per-user git repo | none of its own |
| Ownership | `user` field, **queryable** | directory path, not queryable | signed into the reference |
| Referred to by | `file_id` | `docKey` | `lcimg_<payload>.<mac>` |
| Owner can list | **yes**, files panel | **no** | n/a, lists as its file |
| Owner can delete | **yes**, in that panel | **no**, only via the model | n/a |
| Model can list | no | **yes**, `canvas_doc_list` | thread-scoped subset |

The divergences that do not matter: different byte storage, and different identifier formats. A
git repository is a reasonable home for versioned text, and `docKey` is a reasonable name for it.

**The divergence that does matter is the row about listing and deleting**, and it inverts for
canvas: the model can enumerate what the user cannot, and deletion is reachable only by asking
the model. Every other artefact in this system is the other way round.

## 4. The gap, stated plainly

Canvas is the only artefact type whose owner cannot see or remove their own things. That is not a
storage problem, and moving canvas into the `File` collection is not obviously right: git-backed
versioned documents are genuinely different from immutable blobs, and that difference is the
feature.

It is a **listing and identity** problem. What canvas lacks is a queryable, user-scoped record
that a UI can read, which is exactly what the `user` field gives everything else.

Two shapes worth weighing, and this note deliberately does not choose:

- **A `File` document per canvas document**, holding metadata and pointing at the git-backed
  content. Canvas keeps its store; it joins the existing view for free, including delete. Cost: a
  second record to keep consistent with the index, and a `context` value that means "the bytes
  are not where they usually are".
- **A canvas listing endpoint plus its own view**, mirroring the files panel. Nothing to keep
  consistent. Cost: a second thing to build and maintain, and the user has two places to look.

The first is less work and gives one place to look. The second is more honest about the two
stores being different. I would start with the first and only split if the seam actually chafes.

## 5. One distinction that must stay sharp

**What the owner sees and what the model is offered are different surfaces, and they should stay
different.**

The owner's view is everything they own, across every conversation. That is the files panel and
it is right that it is unfiltered by conversation.

The model's view is deliberately narrow. The image work offers a thread-scoped set, capped, with
sources pinned and attempts windowed. Widening that to everything the user owns would be wrong on
three counts: it is noise, it costs tokens on every turn, and it invites the model to reach for
something from an unrelated conversation.

Canvas currently has the model's surface without the owner's. The fix is to add the owner's, not
to narrow the model's.

## 6. Two smaller things this comparison exposed

**The files panel is a raw dump, not a library.** It renders `useGetFiles()` with no filtering, so
avatars, code-execution outputs and skill files sit alongside the photos and documents a person
would think of as theirs. `context` already carries the distinction. If this becomes the place
people manage their things, it needs to use it.

**Account deletion bypasses the per-file path.** `deleteUserController` runs the funnel and then a
raw `deleteMany({user})`. Anything whose storage deletion failed is removed from Mongo anyway,
leaving bytes behind. That is upstream behaviour, not ours, but it is the one hole in "deleting it
removes it".

## 7. Open, for the owner

1. Which shape for canvas listing, §4. My recommendation is a `File` document per canvas
   document, but the trade is real.
2. Should the files panel filter by `context`, and if so what belongs in a person's library?
   Avatars and skill files probably do not.
3. Is anything else heading for its own store? This note is cheap to re-run against a fourth
   mechanism and expensive to reconstruct later.
