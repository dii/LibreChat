# Spec: Canvas without a second store

**Status:** proposal. **Read §1 before §2** — there is a question about whether to build this at
all, and it is not rhetorical.
**Supersedes:** the git-backed canvas store (`packages/api/src/canvas/docs.ts` and the per-user
repositories under `CANVAS_SOURCES_DIR`).
**Background:** [`artefact-model.md`](artefact-model.md), which is why this exists.

**Verified dependency landscape (2026-08-08):**

| Dependency | State | What it means here |
| --- | --- | --- |
| `GET /api/mcp/files/:reference` + `fileRef.ts` | built on `feat/mcp-image-refs`, not deployed | the read half already exists. This spec adds scopes to it. |
| `packages/api/src/canvas/diff.ts` (139 lines) | merged | diffing, independent of git. Keep. |
| `packages/api/src/canvas/docs.ts` (677 lines) + spec (529) | merged | the git store. **Deleted by this.** |
| `packages/api/src/canvas/lock.ts` (28 lines) | merged | per-user write lock for the working tree. Deleted with it. |
| `isomorphic-git` | dependency | used by `docs.ts` **only**. The fork's sole dependency addition; goes with it. |
| `mcp_servers/canvas/source.py` (634 lines) | merged | sectioning, chunking, diff/apply, the ephemeral index and an existing `_LibreChatClient`. Nearly all reusable. |
| The owner's usage | **"I hardly used it so far"** | see §1 |

---

## 1. The question to answer first

The owner has said they have hardly used canvas and would not mind losing every existing
document. That is licence for a brutal refactor, and it is also a warning.

**Rebuilding a feature nobody uses, more cheaply, is still building something nobody uses.** The
image work had a concrete use case that arrived late and immediately falsified a design decision
that had already been agreed and reviewed. Canvas has no such use case written down anywhere.

So before §2 is built, one of these should be true:

- there is a document you actually want to work on this way, and you can describe the session; or
- the answer is that canvas should be **deleted**, not rebuilt, and the ~2,400 lines plus a
  dependency simply go.

Deleting is a legitimate outcome of this spec and is cheaper than every alternative in it. The
design below is written so that if the answer is "keep it", the build is small; it is not written
to argue for keeping it.

## 2. Needs

| | Need | Provenance |
| --- | --- | --- |
| **C1** | Work on a document too large to sit in the model's context, without it sitting there | inferred from what canvas does; **not validated** |
| **C2** | The model can find its way around it: outline, search, fetch a section | inferred; **not validated** |
| **C3** | The model can change part of it without rewriting the whole | inferred; **not validated** |
| **C4** | Bring in reference material and use it to drive edits | inferred; **not validated** |
| **C5** | **See and delete your own documents yourself** | **owner, 2026-08-08** |
| **C6** | Nobody else in the household can reach yours | **owner, 2026-08-08** |
| **C7** | Turning it on changes nothing else | author |

C5 is the reason this spec exists. Today the **model** can list a user's canvas documents through
`canvas_doc_list` and the **user** cannot, and deletion is reachable only by asking the model to
call a tool. Every other artefact in the system inverts that.

C1 to C4 are what the current implementation does. Nobody has confirmed they are wanted.

## 3. The design, in one paragraph

A canvas document becomes an ordinary `File` document. Content lives wherever the storage strategy
puts everything else. The canvas MCP server keeps **no state at all**: it fetches content by signed
reference, computes outline, sections and search on demand, patches in memory, and writes the
result back. Listing, ownership, isolation and delete are then not features of canvas — they are
the file system everything else already uses.

## 4. What changes on each side

### 4.1 LibreChat

**Uploads become ordinary uploads.** `POST /api/files/canvas-source` currently writes bytes to a
per-user directory and never calls `createFile`, which is why an uploaded document is invisible to
its owner. It becomes a normal upload with `context: 'canvas_source'`, or is removed entirely in
favour of the existing upload path with a context flag.

**References gain a scope.** The reference minted today grants *read* of one file for one
principal until expiry. Two more grants are needed:

- `write` — replace the content of the named file
- `create` — make one new file in a named conversation, for callers that have no file id yet

The payload gains a scope field, verified before anything else happens. The prefix stops being
`lcimg_` and becomes artefact-general; `lcref_` is the obvious choice.

**A write route beside the read one.** `PUT /api/mcp/files/:reference`, same guard shape as the
read route: bearer token, fail closed on either secret, scope checked, principal taken from the
verified payload and never from the caller. A `POST` for `create`.

**Deleted:** `packages/api/src/canvas/docs.ts` and its spec, `lock.ts`, the `isomorphic-git`
dependency, `api/server/routes/canvasAdmin.js`, and the `canvas-sources` bind mount. `diff.ts`
stays.

### 4.2 The canvas MCP server

Nearly all of `source.py` is reusable: `split_sections`, `chunk_text`, `_apply`, `_diff`, the
ephemeral index and `_LLMClient` are pure logic over text and do not care where the text came
from. `_LibreChatClient` already exists.

**One function changes.** `_read_source_path`, which reads from the bind-mounted directory,
becomes a fetch by reference. Everything downstream is unaffected.

**Writes go back the same way**, through the new route, instead of into a git working tree.

**The tool surface stays**, minus `canvas_doc_delete`, which is no longer the server's business:
the user deletes in the files panel. `canvas_doc_list` should also go, or become a listing of
*this conversation's* documents rather than all of a user's, for the same reason the image context
is thread-scoped. See §7.

## 5. Security

The read route's model carries over unchanged: identity comes from the verified reference, never
from the caller, and every refusal is an identical bare 404.

**A write-scoped reference is more dangerous than a read-scoped one**, and the difference should be
treated as such:

- Scope is checked **before** the file is looked up, and a read reference presented to the write
  route is refused exactly as a forged one would be.
- A write reference should be shorter-lived than a read one. A leaked read reference discloses one
  file; a leaked write reference destroys it.
- `create` is bound to a conversation rather than a file, so it cannot be used to write over
  anything that already exists.
- The write route replaces content under an existing `file_id` owned by the reference's principal.
  It never creates, never changes ownership, and never touches a file the principal does not own.

**Versions are not a safety net here**, because §6 removes them. That raises the cost of a bad
write, which is an argument for the shorter lifetime above and for the model being unable to write
without a reference LibreChat minted this turn.

## 6. Versions: none, deliberately

Git gave document-level history. This removes it, and the conversation becomes the record: the
edits, the directives and the tool calls are all in the message history, and this fork's own
artefact note holds that anything reconstructible from messages is not an artefact.

If that proves insufficient, versions come back **at the storage layer** under one `file_id`, with
no schema change and no second record. That is the escape hatch and it does not need designing now.

What this does mean: a bad model edit is not recoverable except by re-uploading. Worth knowing
before the first real session.

## 7. What the user sees versus what the model sees

The same distinction the image work settled, and for the same reasons.

**The user's view is everything they own**, across every conversation: the files panel, filtered
by context so canvas documents are identifiable.

**The model's view should be narrow.** `canvas_doc_list` today enumerates every document a user
owns, which is how the model ended up with a surface the user lacks. It should either go, or
return only what belongs to the current conversation. Offering every document on every turn is
noise, token cost, and an invitation to open something from an unrelated conversation.

## 8. Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| Keep git, add a `File` document as the record of existence | Two records to keep consistent, and the orphan problem returns: deleting the record leaves the tree. It was the incremental option when migration mattered; it does not now. |
| A `groupId` field on the `File` schema for versions | A fork-local schema addition, which is the largest carrying cost this fork has and the exact thing that produced a blocking defect in the image work. |
| A separate canvas listing endpoint and view | A second place to look, and it leaves ownership unqueryable alongside everything else. Solves the symptom, not the cause. |
| Give the ephemeral vector index a lifecycle | It is auto-gone by design and is not an artefact. Formalising it would invent the machinery this whole exercise exists to remove. |
| Leave canvas alone | Then the owner keeps a class of artefact they cannot see or delete, which is C5, and the fork keeps a dependency and ~1,200 lines of storage code for it. |

## 9. Risks and open decisions

1. **Whether to build this at all.** §1. The honest default is deletion until a use case exists.
2. **Every structural operation becomes a fetch**, where today it is a local file read. The
   short-lived cache built for images covers repetition, but the canvas server now depends on
   LibreChat being reachable in a way it currently does not.
3. **Write scope on a reference is new attack surface.** It is a small generalisation of a
   mechanism that has been reviewed once, and it should be reviewed again on its own.
4. **No versions.** §6.
5. **`canvas_doc_list`'s fate.** §7 argues it should narrow or go; that is a behaviour change for
   whatever workflow currently uses it, which may be none.

## 10. Test plan

| Area | Test |
| --- | --- |
| C5 | A canvas document appears in the files panel and deleting it there removes both the record and the bytes. |
| C6 | A reference minted for user A is refused for user B's file, on read, write and create alike, with an identical response. |
| Scope | A read reference presented to the write route is refused. A write reference presented to the read route is refused. A create reference cannot name an existing file. |
| C1/C2 | Outline, search and get-section return the same results over fetched content as they do over a local read today, on the same fixture. |
| C3 | A patch applied through the write route produces the same bytes as the current in-tree patch, on the same fixture. |
| C7 | A request with no canvas tools performs no extra query and no extra fetch. |
| Failure | LibreChat unreachable: every canvas tool fails visibly and none corrupts a document. A write that fails leaves the previous content intact. |

## 11. Slicing

1. **Scopes on the reference, plus the write and create routes**, with tests. Independently
   reviewable, and the security surface gets its own pass rather than riding along.
2. **Canvas sources become ordinary uploads.** They appear in the panel and become deletable. This
   alone closes the sharper half of C5 and is worth doing even if slice 3 never happens.
3. **The server switches to fetch and write**, and the git store, `lock.ts`, `canvasAdmin.js` and
   `isomorphic-git` are deleted.

Slice 2 is the one with standalone value. If §1 resolves to "delete canvas", slices 1 and 3 are
dropped and slice 2 is replaced by removing the upload path entirely.
