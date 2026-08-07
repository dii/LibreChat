# How LibreChat handles images and files today

**A reference, not a proposal.** Read this before designing anything that touches uploads,
attachments, file lifetime or image tools.

Verified 2026-08-07 against `deploy/candlekeep` at merge commit `cb50f78a1`, which includes upstream
through 5 August. **Line numbers drift.** Treat them as search hints and re-derive before building;
on 2026-08-07 a merge moved one citation by 54 lines and another by 107.

This document exists because the same facts were rediscovered four times, and three of the four times
they were rediscovered wrongly.

---

## 1. There is no single upload funnel

The most expensive wrong assumption in this area, and it has been made twice.

`routes/files/images.js:41` dispatches on **two** conditions, not one:

```js
if (!isAssistantsEndpoint(metadata.endpoint) && metadata.tool_resource != null) {
  return await processAgentFileUpload({ req, res, metadata, sseStream });
}
await processImageFile({ req, res, metadata, sseStream });
```

- **Ordinary composer attachment** (no tool resource): `processImageFile`
  (`api/server/services/Files/process.js:454`) is called directly with the real `file_id`.
- **Agent file with a tool resource**: the request goes to `processAgentFileUpload`, which calls
  `processImageFile` with a **throwaway** `metadata: { file_id: v4() }` and then persists its own
  document under the real id.
- **Assistants endpoint**: the negated first condition means an assistants upload **never** reaches
  `processAgentFileUpload`, regardless of `tool_resource`. It always falls through to
  `processImageFile` with the real `file_id`, exactly like a composer attachment.

So a field written inside `processImageFile` reaches the real document on two of the three paths, and
an orphan document only on the agent tool-resource path. `processAgentFileUpload` copies specific
fields off the returned result to bridge that gap.

> An earlier revision of this document asserted that the assistants path behaved like the
> tool-resource path. It does not, and the negation is easy to read past. Corrected 2026-08-07 after
> a review caught it, in the section whose own opening line warns about this exact class of error.

**Two further traps in the same function:**

- Image dimensions come from `handleImageUpload`, not from `resizeAndConvert`. The latter lives in
  `uploadImageBuffer`, a different function used for avatars and generated images.
- `handleImageUpload` returns `bytes` as a byte **count**, not a Buffer (`Local/images.js`, via
  `Buffer.byteLength`). The resized buffer never leaves the strategy. Anything needing the actual
  bytes must read them back.

**Reading bytes back** is uniform: every storage strategy exposes `getDownloadStream`
(`strategies.js`: firebase, local, s3, cloudfront, azure). `getLocalFileStream` (`Local/crud.js`)
handles `/images/` paths and guards against path traversal outside the configured image output
directory.

## 2. Tool-generated images are a separate path

An image produced by a tool is written by `saveBase64Image` (`process.js:1255`), not by any upload
path. It calls `db.createFile` with a fresh `file_id`, `user`, `type`, `width`, `height`, `filepath`
and `bytes`, so **a generated image is a real, owned, persisted file exactly like an upload**.

The tool-end callbacks (`api/server/controllers/agents/callbacks.js`) build their image list from
`artifact.content` and `artifact.imageDisplay`, save each through `saveBase64Image`, and attach the
result to the message.

Consequence worth stating plainly, because it was missed for two design versions: **a render is not
ephemeral.** It is a normal file with its own id, and anything that can reference an uploaded image
can reference a render by the same means.

## 3. Deletion, and the path that bypasses it

`processDeleteRequest` (`api/server/services/Files/process.js:210`) is the funnel for ordinary
deletion. Callers: four sites in `routes/files/files.js`, `UserController.js` on account deletion, and
the retention sweep in `packages/api/src/files/sweep.ts`. The sweep builds a synthetic request object
carrying `user: {id, tenantId}`, so request-scoped code works there.

It tolerates partial failure by design: a file whose storage deletion fails goes to `failedFileIds`
rather than `resolvedFileIds`, and only resolved ids reach the metadata delete.

**The bypass.** `deleteUserController` calls `deleteUserFiles(req)` and then, on the next line,
`await db.deleteFiles(null, user.id)`. `deleteFiles` ignores its `file_ids` argument whenever `user`
is truthy and issues `File.deleteMany({user})`. So on account deletion, any document that failed the
first pass is removed by a raw bulk delete that no per-file hook observes.

The MongoDB TTL path (`expiresAt` on the file schema) does not apply to images, because both
`processImageFile` and `processAgentFileUpload` pass `disableTTL=true`.

## 4. How a file reaches a tool

Three mechanisms, and they are not interchangeable.

### 4.1 Per-request categorisation

`primeResources` (`packages/api/src/agents/resources.ts`) categorises each file into a tool resource:
`execute_code` for anything with a code environment reference, `file_search` for embedded files, and
`image_edit` for **an image in the current request's file set that has dimensions**.

That last gate, `requestFileSet.has(file.file_id)`, is why an attached photo is available to image
tools in the turn it arrives and in no other turn.

### 4.2 Persisted agent resources

`tool_resources.image_edit.file_ids` on the **agent document** is rehydrated on every turn with no
request-set gate, fetched and passed through the access filter.

But only agent *setup* uploads write there: `processAgentFileUpload` calls `addAgentResourceFile` only
when `!messageAttachment && tool_resource`, and a chat attachment sets `messageAttachment=true`. A
composer photo never lands in it.

### 4.3 History rehydration, which sends bytes

`addPreviousAttachments` (`api/app/clients/BaseClient.js:1522`) rehydrates file references from prior
messages against an authorised-file map. Two properties matter:

- It returns early on `if (!this.options.resendFiles)`.
- It carries file **bytes back into model context**. That is what the setting is for; its own UI text
  warns about token cost.

It is therefore not a reference mechanism, and cannot be used as one where the point is to keep pixels
out of context.

### 4.4 The gap

Putting 4.1 to 4.3 together: LibreChat can carry a file across turns **only** by re-sending its bytes,
or by persisting it on an agent. There is no conversation-scoped reference to a file that does not
drag the pixels with it. That gap is what
[`spec-mcp-image-reference.md`](spec-mcp-image-reference.md) proposes to close.

## 5. Walking a conversation's files

`getThreadData` (`packages/api/src/utils/message.ts`) walks the parent chain of a message and returns
`{ messageIds, fileIds }`. It collects ids from **both** `files` (user uploads) and `attachments`
(tool outputs), has no depth cap, and is cycle-guarded.

**Its `fileIds` are bare strings.** Anything that needs `user`, `type`, `width` or `height` must fetch
the documents, typically `getFiles({ file_id: { $in: ids } }, {}, {})`. Upstream's own use of the
access filter does exactly this fetch immediately before filtering. Skipping it silently yields an
empty result rather than an error, because property access on a string is `undefined`.

**Do not use `getConvoFiles` for this.** `BaseClient` overwrites `conversation.files` with the current
turn's primed attachments rather than merging, so for any agent carrying context, OCR or file-search
resources a photo's id survives exactly one turn. The messages collection is append-only and immune.

## 6. Authorisation

Upstream added a file trust boundary in **#14577 (2 August 2026)**. Use it rather than hand-building
an owner filter.

`api/server/services/Files/permissions.js` exports:

- `hasAccessToFilesViaAgent` — can this user reach these files through this agent?
- `filterFilesByAgentAccess` — returns the subset of `files` the user may access. It passes files the
  user owns, and additionally grants non-owned files whose id appears in a shared agent's
  `tool_resources` where the requester holds view permission.

That second clause matters: **access is broader than ownership.** Any code that names files using this
filter and then resolves them by literal ownership will offer references it cannot honour.

Neither `buildOwnerFileFilter` (`BaseClient.js`) nor `withOwnerScope`
(`packages/data-schemas/src/methods/file.ts`) is exported; only the `FileOwnerScope` type is.

## 7. The `resendFiles` gate

`packages/api/src/agents/initialize.ts` contains a large conditional:

```
if (conversationId != null && resendFiles) {   // opens ~:708
  ...                                          // the execute_code thread walk, ~:752
} else if (requestFiles.length) {              // ~:808
  ...
}                                              // closes ~:815
```

`resendFiles` is a user-facing switch, default true, rendered in the agent builder's Model panel and
persisted to `agent.model_parameters`.

**Anything placed inside that conditional inherits a setting that has nothing to do with it.** The
gate is about re-sending bytes to the model. A feature that never sends bytes should sit outside it.
`agent`, `requestFiles`, `conversationId`, `parentMessageId` and `db` are all parameters of
`initializeAgent`, so they are in scope before and after the conditional.

`conversationId` is `string | null` and is genuinely null on turn 1, while `db.getMessages`'s filter
type requires a string.

## 8. Getting text in front of a tool

`dynamicToolContextMap` carries per-tool context strings; `joinInstructionMap` takes `Object.values`,
so keys are free-form. `ToolService.js` builds the built-in image tool contexts from
`tool_resources.image_edit.files` and feeds them to `image_gen_oai` and `gemini_image_gen`.

**Consequence:** putting files into `tool_resources.image_edit` advertises them to the cloud image
tools. For a deployment with an egress policy, that is a decision, not a detail.

## 9. Test and build facts

- `api/` has **no TypeScript project**, so `tsc --noEmit` does not apply there. It does in
  `packages/api` and `packages/data-schemas`.
- The workspaces have separate test scripts: `test:api`, `test:packages:api`,
  `test:packages:data-schemas`. Running one does not run the others.
- `api/server/services/__tests__/ToolService.spec.js` never imports `initializeAgent`, so it cannot
  observe anything in `packages/api/src/agents/initialize.ts`.
- The file schema sets no `strict` option, so Mongoose's default `strict: true` applies and an
  undeclared field is **silently discarded** on write, with no error and nothing in the returned
  document. `packages/data-schemas/src/methods/role.ts` documents having been bitten by this.
  `packages/data-schemas` is compiled, so a schema change needs a rebuild carried into the image.
- Upstream's testing policy is real dependencies over mocks: `mongodb-memory-server` for Mongo, the
  real MCP SDK for MCP. A mocked `createFile` cannot exhibit strict-mode stripping, so it would pass
  while the feature does nothing.
