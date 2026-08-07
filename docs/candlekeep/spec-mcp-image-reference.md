# Feature Spec: Conversation Images for MCP Tools

**Status:** proposal, ready for implementation by someone with no prior context
**Repo:** `danny-avila/LibreChat`

**Verified dependency landscape (2026-08-07, at `cb50f78a1`):**

| Dependency | State | What it means for this spec |
| --- | --- | --- |
| File trust boundary, [#14577](https://github.com/danny-avila/LibreChat/pull/14577) — `filterFilesByAgentAccess`, `hasAccessToFilesViaAgent` (`api/server/services/Files/permissions.js`) | **merged** | this spec's authorisation, both at naming time and at fetch time. Do not hand-build an owner filter. |
| `getThreadData` (`packages/api/src/utils/message.ts`) | **merged** | the conversation walk. Collects from `files` and `attachments`, cycle-guarded, no depth cap. Returns bare id strings. |
| `dynamicToolContextMap` + `joinInstructionMap` (`packages/api/src/agents/run.ts`) | **merged** | how per-tool context text reaches the model. Keys are free-form. |
| Per-tool capability config precedent: `defer_loading`, `allowed_callers`, `tool_intents` | **merged** | the shape this spec's opt-in mirrors. |
| MCP user-variable header resolution, hardened by [#14595](https://github.com/danny-avila/LibreChat/pull/14595) | **merged** | how a per-user credential reaches an MCP server without the server asserting who it is. |
| MCP `audience` annotation handling | **not upstream** | carried in this fork (`packages/api/src/mcp/parsers.ts`). Not required by this spec, but the two compose: see §7.3. |

---

## 1. Intent of the feature

A user attaches a photo and asks an agent to edit it. If the editing tool is an MCP server, this is
currently impossible.

Three sentences of background. LibreChat's built-in image tools receive files through
`tool_resources.image_edit`, populated from the current request's file set. MCP tools receive text
arguments only, so an MCP server can be *told about* a file but has no way to obtain it. And the only
mechanism LibreChat has for carrying a file to a later turn is `addPreviousAttachments`, which
re-sends the **bytes** into model context and is gated on the user's `resendFiles` setting.

So the gap is specific: **there is no conversation-scoped reference to an image that does not drag the
pixels into the model's context.**

This matters beyond one server. It is a hard failure, not a degradation, for any model without a
vision head: the image reaches a model that cannot accept it and the request fails. It is pure token
waste for models that can. And it blocks a whole class of community MCP server, since any tool that
edits, analyses, compares or transforms an image needs the image and cannot get it.

**What this spec adds:** an opt-in capability by which LibreChat tells an MCP server which images the
conversation has, by reference, and lets that server fetch the bytes over an authenticated channel.

**What it deliberately does not add:** any new identifier scheme, any storage, any change to how
images are uploaded or saved, and any obligation on servers that do not opt in.

## 2. Existing conventions to mirror

- **Opt-in per server, off by default**, as `defer_loading` and `allowed_callers` are. A server that
  does not ask is unaffected, and no request pays for a capability nobody uses.
- **Authorise with `filterFilesByAgentAccess`**, the same predicate #14577 established, at both the
  naming step and the fetch step. Using different predicates at the two ends produces references that
  are offered and then refused.
- **Reference a file by its `file_id`.** The built-in image tool context already interpolates
  `file_id` into text the model sees (`packages/api/src/tools/toolkits/imageContext.ts`). This spec
  introduces no new identifier format, no encoding and no signing.
- **Service-token routes fail closed.** `api/server/routes/canvasAdmin.js` is the shape: bearer token,
  401 on mismatch, **501 when the token is unset**, mounted outside `requireJwtAuth`. Note that route
  only deletes by validated key and never returns bytes, so it is a precedent for the *guard*, not for
  the capability.
- **Real dependencies in tests**, per `CONTRIBUTING.md` and the repo's testing policy:
  `mongodb-memory-server` for Mongo, the real MCP SDK for MCP.

## 3. Naming

`conversation_images`, as a per-server capability, matching the existing snake_case capability keys.
Domain language for `CONTEXT.md`:

> **Conversation image reference**: a `file_id` naming an image already stored by LibreChat, given to
> an opted-in MCP server so it may fetch the bytes directly. The reference travels through model
> context; the bytes never do.

## 4. Wire shape

### 4.1 Configuration

```yaml
mcpServers:
  my-image-server:
    url: http://…
    conversation_images:
      enabled: true
      limit: 5        # optional, default 5
```

`enabled` defaults to **false**. `limit` bounds how many of a conversation's images are offered per
turn, most recent first.

### 4.2 What the server is told

For an opted-in server whose tools are loaded, LibreChat injects one entry into
`dynamicToolContextMap`, keyed by that server's tool names, naming each available image:

```
Images available in this conversation, most recent first (showing 5 of 12):
  file_id=6f21… name=porch.jpg 1536x1024
  file_id=a904… name=render_2.png 1024x1024
Pass a file_id to a tool that accepts an image reference. Fetch its bytes from the
LibreChat file endpoint. Do not invent a file_id.
```

The count disclosure matters: without it, a model asked about an older image cannot tell the
difference between "not available" and "does not exist".

### 4.3 What the server may call

```
GET /api/mcp/files/:file_id
```

Returns the raw bytes with the stored content type, or **404 with no body** for anything the caller
may not have: a file that does not exist and a file the caller may not access must be
indistinguishable, or the endpoint is an existence oracle.

### 4.4 Identity

The endpoint must know *which user* it is acting for, and must not simply believe the caller.

**Preferred:** LibreChat mints a short-lived, per-user, per-server token and delivers it to the MCP
server through the existing user-variable header mechanism, the same path that already carries
per-user credentials to MCP servers. The server presents that token; LibreChat derives the user from
it. Nothing is asserted by the caller.

**Fallback, if the token path proves impractical:** a static service token plus an
`X-LibreChat-User-Id` header. This is materially weaker, because any caller holding the token can act
as any user, and it should be documented as such rather than justified by analogy to routes that do
not stream bytes.

## 5. Security model

State it as a capability grant, because that is what it is.

- **Granted:** an opted-in MCP server may read the bytes of images that a specific user may access, as
  determined by `filterFilesByAgentAccess`.
- **Not granted:** files of other users; non-image files; files outside the conversations that named
  them, once §9.1 is resolved.
- **Fail closed:** unset token means 501, not "allow". Not-enabled server means the context is never
  injected and the endpoint refuses.
- **No new storage.** The MCP server holds bytes only as long as it chooses to cache them. LibreChat
  remains the only durable copy, so deleting a file removes the only copy that outlives a process.

**Deletion has one honest caveat.** Because the reference resolves against live LibreChat state, a
deleted file stops resolving. But a server that caches bytes will keep serving its cache until it
evicts. If a deployment needs deletion to take effect immediately in caching servers, that needs an
invalidation signal, which this spec does not define. Say so rather than implying deletion is
instantaneous.

## 6. Implementation

### 6.1 `packages/api/src/agents/initialize.ts`

Compute the conversation's image set, **outside the `resendFiles` conditional** (it opens around
`:708` and closes around `:815`; re-derive before building) and only when the agent carries tools from
a server with `conversation_images` enabled:

1. Union `requestFiles` with `getThreadData(messages, parentMessageId).fileIds`, guarded on
   `conversationId != null`. Put `requestFiles` first, so an image attached this turn is never the one
   the cap discards.
2. **Fetch the documents.** `getThreadData` returns bare strings; the next two steps need `user`,
   `type`, `width` and `height`. Use `getFiles({ file_id: { $in: ids } }, {}, {})`, as
   `resources.ts` does immediately before filtering.
3. Authorise with `filterFilesByAgentAccess`.
4. Keep images with dimensions; take the first `limit`.

Reuse the `getMessages` result the execute_code branch already computes rather than issuing a second
identical query.

Placing this outside the `resendFiles` conditional is deliberate: that setting governs re-sending
bytes to the model, and this feature sends none.

### 6.2 Tool loading

Thread the set through `createToolLoader` → `loadAgentTools` → `loadToolDefinitionsWrapper` as a field
distinct from `tool_resources.image_edit`. **Do not reuse `image_edit`**: `ToolService.js` feeds that
resource to `image_gen_oai` and `gemini_image_gen`, so reusing it would advertise the conversation's
images to cloud image tools, which for some deployments is an egress decision.

Build the context string purely, with no I/O and no failure state.

### 6.3 The file endpoint

A new route mounted outside `requireJwtAuth`, guarded as in §2, resolving the file with the same
`filterFilesByAgentAccess` predicate used at naming, then streaming via
`getStrategyFunctions(source).getDownloadStream(req, filepath)`.

## 7. Interaction with existing capabilities

**7.1 `resendFiles`.** None, by construction: the computation sits outside that conditional. A user
who turns off "Resend Files" to save tokens keeps this feature, which sends no tokens' worth of image.

**7.2 Built-in image tools.** None. `image_gen_oai` and `gemini_image_gen` continue to consume
`tool_resources.image_edit`, which this spec does not touch.

**7.3 The MCP `audience` annotation.** Complementary and independent. A server can return an image
annotated for the user, which is displayed but withheld from the model, and separately accept a
reference to an existing image. Together they give a complete round trip in which no pixels enter model
context in either direction. Neither requires the other.

**7.4 Agent sharing.** `filterFilesByAgentAccess` grants access through a shared agent as well as by
ownership. Because both ends of this feature use that same predicate, a file reachable that way is
named and is fetchable. Using ownership at one end and the filter at the other is the defect this
avoids.

**7.5 Generated images.** A tool-produced image is a normal owned file (`saveBase64Image`) attached to
its message, and `getThreadData` collects from `attachments` as well as `files`. So a render is
referenceable on subsequent turns by the same mechanism, with no extra work. Within the turn that
produced it, the producing server already holds the bytes.

**7.6 Branched conversations.** The set is thread-scoped, so an image from a different branch is not
offered. Correct, and worth documenting for users.

**7.7 Non-chat loaders.** `openai.js` and `responses.js` hardcode `requestFiles: []`, and one
hardcodes `parentMessageId = null`, so the field threads through as a no-op there. Add it for
consistency and say so in the commit message.

**7.8 Ephemeral agents.** `filterFilesByAgentAccess` short-circuits for ephemeral agent ids. Confirm
the owned-file path still behaves for them before shipping.

**7.9 Retention sweep and deletion.** No hook needed. Resolution is against live state, so a deleted
or swept file stops resolving, subject to the caching caveat in §5.

## 8. Rejected alternatives

Recorded because each was built out and killed, and re-proposing one should require new information.

| Alternative | Why rejected |
| --- | --- |
| Store a broker-side identifier on the file document | Needs a schema field. The file schema is strict, so an undeclared field is silently discarded, and the whole feature becomes a no-op that still passes its own tests. Also a fork-local schema delta in the fastest-moving subsystem. |
| Derive a signed (HMAC) handle from the file id | Exists only to stop a peer forging a reference. Once the fetch is authorised by LibreChat against the user, forgery achieves nothing, and the secret, its rotation and its failure modes all disappear. |
| Give the MCP server a durable copy of the bytes | Creates a second permanent copy of user images. Deletion then needs a cascade over derived images, which needs a provenance graph, a child index, tombstones and a purge route. Four review rounds, four blocking defects, all of them in machinery that existed only to serve the copy. |
| Reuse `tool_resources.image_edit` to carry the set | It is wired to the cloud image tools, so it would advertise the conversation's images to them. |
| Use `addPreviousAttachments` history rehydration | Sends bytes into model context, which is the thing being avoided, and is gated on an unrelated user setting. |
| Have LibreChat push bytes to the server on upload | Puts a network call on the upload path, makes the server a dependency of uploading, and stores everything whether or not it is ever used. |

## 9. Risks and open decisions

1. **Scope of the fetch grant.** As specified, an opted-in server can fetch any image the user may
   access, not only images named to it. Narrowing that, by binding the reference to the conversation
   that named it, is stricter and costs a lookup. **Recommend narrowing**; it is the difference
   between "this server can read what it was shown" and "this server can read the user's library".
2. **Token path.** Whether the per-user short-lived token of §4.4 can ride the existing MCP header
   mechanism cleanly, or whether the weaker fallback is needed for a first version.
3. **Non-image files.** The spec restricts to images because that is the demonstrated need. The
   mechanism generalises; deliberately not generalised now.
4. **Cache invalidation on delete.** Out of scope, disclosed in §5.

## 10. Test plan

| Area | Test |
| --- | --- |
| Cross-turn | Attach an image, run a turn that calls nothing, then reference it. Must go through the real thread walk, not a stubbed file source. |
| Same turn | Attach and use in one message, in a conversation that already holds more images than `limit`, so the cap cannot discard the new one. |
| `resendFiles` off | Both of the above with the setting off. Fails if the computation moves inside the conditional. |
| Opt-out | A server without the capability gets identical tool definitions and context to today, and the request performs **no extra Mongo query and no network call**. Assert both counts are zero, in `packages/api` against `initializeAgent`; `ToolService.spec.js` cannot observe this. |
| Authorisation parity | A file reachable only through a shared agent is both named and fetchable. A file of another user is neither. |
| Endpoint guards | Token unset → 501. Wrong token → 401. Another user's file → 404 with no body. Nonexistent file → the same 404 with no body. |
| Cap | A conversation with more images than `limit` offers exactly `limit`, most recent first, and the context text states the total. |
| Deletion | Delete a file, then resolve its reference: clean miss. |
| Generated images | An image produced by a tool is referenceable on the next turn by its own `file_id`. |
| Bare-id regression | Feeding `getThreadData`'s string ids to the access filter without fetching documents yields an empty set. Assert the implementation fetches. |

Run `test:api`, `test:packages:api` and `test:packages:data-schemas`; they are separate scripts and
one does not run the others.

## 11. Slicing

1. **The file endpoint alone**, with guards and tests, no context injection. Independently reviewable,
   and the security surface gets its own review rather than riding along with a feature.
2. **The conversation image set and context injection**, behind the opt-in flag, with the cap.
3. **Documentation**: `CONTEXT.md` domain language, configuration reference, and the user-facing note
   about branched conversations.

Slice 1 is useless without slice 2 and should say so in its description, but it is the half that
deserves separate scrutiny.
