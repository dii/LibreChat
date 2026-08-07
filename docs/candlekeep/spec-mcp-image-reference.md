# Spec: Conversation Images for MCP Tools

**Status:** proposal, ready for implementation by someone with no prior context
**Built for:** this fork, with one known consumer. Shaped so it could be generalised and offered
upstream later, but not written as an upstream pull request. See §11.
**Supersedes:** the `~/scratch/comfyui-upload-plan-v{1..7}` series, whose conclusions survive in §10.

**Verified dependency landscape (2026-08-07, at `cb50f78a1`):**

| Dependency | State | What it means here |
| --- | --- | --- |
| File trust boundary, [#14577](https://github.com/danny-avila/LibreChat/pull/14577) — `filterFilesByAgentAccess`, `hasAccessToFilesViaAgent` (`api/server/services/Files/permissions.js`) | **merged** | used at the naming step. **Fails open** when `agentId` is absent or ephemeral; see §5. |
| `getThreadData` (`packages/api/src/utils/message.ts`) | **merged** | the conversation walk. Collects from `files` and `attachments`, cycle-guarded, no depth cap. Returns bare id strings. |
| `dynamicToolContextMap` + `joinInstructionMap` (`packages/api/src/agents/run.ts`) | **merged** | how per-tool context text reaches the model. Keys are free-form. |
| `saveBase64Image` (`api/server/services/Files/process.js:1255`) | **merged** | tool output becomes a real owned file with its own id. This is why renders are referenceable at all. |
| MCP audience annotation handling (`packages/api/src/mcp/parsers.ts`) | **fork-local**, shipped 2026-07-23 | complementary, not required. See §9.3. |
| MCP spec `2026-07-28` | **released**, LibreChat is on `2025-11-25` via SDK `1.29.0` | server-minted handles passed as tool arguments are now the canonical cross-call state pattern. `requestState` is the template for §4.4. See §10. |

---

## 1. User needs

Stated as what a person should be able to do. The provenance column matters: two of these were
assumed by the author for two days before anyone checked them.

| | Need | Provenance |
| --- | --- | --- |
| **U1** | Use a photo you already sent, without sending it again. | Scope of the work |
| **U2** | It works when the chat model cannot see pictures. | Observed failure, 2026-07-23 |
| **U3** | Ask for the change in a later message, not only the same one. | **Owner-confirmed** 2026-08-07 |
| **U4** | An edited result can be worked on again. | Owner, 2026-08-07 |
| **U5** | Deleting a photo means it is really gone. | Owner, 2026-08-06 |
| **U6** | Nobody else in the household can reach your images. | **Owner-confirmed**: household members have accounts |
| **U7** | An unavailable image is reported plainly, never silently replaced by a generated one. | Author, defended in §5 |
| **U8** | Turning this on changes nothing else. | Author |
| **U9** | You can point back at an earlier attempt and be understood. | **Owner-confirmed** 2026-08-07 |

### 1.1 The use case this is built for

Upload a photo of your upper body. Ask for a described tattoo rendered on the shoulder. Iterate many
times before settling on a design, sometimes re-rendering from the original photo and sometimes
refining the last result, and sometimes going back to an earlier attempt that was better than the
current one.

Three consequences that are not obvious without it, and that a "five most recent images" policy would
have got wrong:

1. **The source photo is the anchor and must never be evicted.** Any policy that windows by recency
   removes the one image every attempt depends on, and keeps five disposable attempts instead.
2. **Attempts must be identifiable by a human.** "Go back to the third one" requires that you and the
   model agree on which is which. This is the only requirement in the set about the *user*
   understanding the naming rather than the model resolving it.
3. **The subject is a person's body.** U5 and U6 are not abstract. A cached copy that outlives a
   deletion, or an isolation boundary that fails open, discloses something personal.

U7 is concrete here too. If a reference misses and the model follows the broker's current wording,
which literally says "generate the image again", the result is a tattoo rendered on a stock body. In
this flow that may not be obvious, and a design could be approved that was never seen on the person
asking for it.

## 2. What is missing today

LibreChat's built-in image tools receive files through `tool_resources.image_edit`, populated from the
current request's file set. MCP tools receive text arguments only, so an MCP server can be *told about*
a file but has no way to obtain it. And the only mechanism LibreChat has for carrying a file to a later
turn is `addPreviousAttachments`, which re-sends the **bytes** into model context and is gated on the
user's `resendFiles` setting.

So the gap is specific: **there is no conversation-scoped reference to an image that does not drag the
pixels into the model's context.** That blocks U1 and U3 together, and U2 makes the byte-carrying
workaround unusable rather than merely wasteful.

**What this adds:** LibreChat names the conversation's images to a tool server it already trusts, as
signed references, and serves the bytes for a valid reference over one authenticated endpoint.

**What it deliberately does not add:** any storage, any change to how images are uploaded or saved, any
new database field, and any behaviour for agents that do not carry the consumer's tools.

## 3. Existing conventions to mirror

- **Service-token routes fail closed.** `api/server/routes/canvasAdmin.js` is the shape: bearer token,
  401 on mismatch, **501 when the token is unset**, mounted outside `requireJwtAuth`. That route only
  deletes by validated key and never returns bytes, so it is precedent for the *guard*, not the
  capability.
- **Real dependencies in tests**, per the repo's testing policy: `mongodb-memory-server` for Mongo, the
  real MCP SDK for MCP.
- **Reference an image by something derived from its `file_id`.** The built-in image tool context
  already interpolates `file_id` into text the model sees
  (`packages/api/src/tools/toolkits/imageContext.ts`).
- **Integrity-protected state passed through an untrusted hop**, from MCP `2026-07-28`'s `requestState`
  rules: protect with HMAC or AEAD, bind the authenticated principal, carry a short expiry, and bind
  the originating request.

## 4. Wire shape

### 4.1 Who gets this

No new configuration key. The capability activates when the agent carries the consumer's tools, which
the implementation already needs to check for §7's gate. One known consumer today, identified by its
MCP tool names.

Two secrets, both environment variables, both fail closed when unset:

- `MCP_FILE_TOKEN` — bearer token for the byte endpoint.
- `MCP_FILE_SIGNING_KEY` — key for minting and verifying references.

This is deliberately narrower than a per-server capability flag. §11 covers what generalising would
take.

### 4.2 The reference

```
lcimg_<base64url(payload)>.<base64url(mac)>
```

`payload` is compact binary: file id, owner principal, expiry, and a conversation binding. `mac` is a
truncated HMAC over the payload under `MCP_FILE_SIGNING_KEY`. Roughly 64 characters, comparable to a
UUID.

**References are minted fresh every turn and are short-lived** (30 minutes is ample, because the
context that carries them is rebuilt on every request and consumed within the same turn). Expiry is
what stops a reference replayed out of old conversation history from working indefinitely.

### 4.3 What the server is told

Injected into `dynamicToolContextMap`, keyed by the consumer's tool names:

```
Images in this conversation. Use a reference exactly as written below. Do not reuse a
reference from earlier in the conversation; they expire. Do not invent one.

SOURCE PHOTOS (always available):
  ref=lcimg_… name=torso.jpg 1536x1024

ATTEMPTS (showing 20 of 34, most recent first):
  #34 ref=lcimg_… 1024x1024  "dragon across the shoulder blade, fine line"
  #33 ref=lcimg_… 1024x1024  "dragon across the shoulder blade, heavier shading"
  …
Attempts 1-14 are no longer available. If the user asks for one, say so and offer to
work from a source photo or a listed attempt.
```

Four properties, each one carrying a need:

- **Source photos are pinned**, listed separately, never windowed. (U1, and §1.1 consequence 1.)
- **Attempts carry a stable ordinal for the whole conversation**, not a position within the window, so
  "the third one" does not change meaning as the window slides. (U9.)
- **Each attempt carries the description that produced it**, so a model with no vision can map "the one
  with the snake" against its own tool-call history. (U9, U2.)
- **The total and the unavailable range are stated**, so an out-of-window request produces a plain
  answer rather than a confident wrong pick. (U7, U9.)

### 4.4 What the server may call

```
GET /api/mcp/files/:reference
Authorization: Bearer <MCP_FILE_TOKEN>
```

Returns the bytes with the stored content type, or **404 with no body** for anything not served: an
invalid MAC, an expired reference, a file that no longer exists, and a file the principal may not
access are all the same response. Distinguishing them is an existence oracle.

**Identity comes from the reference, not from the caller.** The endpoint verifies the MAC, rejects on
expiry, and derives the principal from the verified payload. There is no `X-LibreChat-User-Id` header
and nothing the caller asserts about who it is acting for.

## 5. Security model

- **Granted:** a caller holding `MCP_FILE_TOKEN` may read the bytes of a specific image, for a specific
  principal, for thirty minutes, and only where LibreChat itself minted the reference.
- **Not granted:** any file for which it does not hold a valid unexpired reference. This holds under
  the fallback-free design because there is no path by which a caller names a user; it can only present
  something LibreChat signed.
- **Fail closed:** either secret unset means 501. An agent without the consumer's tools means nothing is
  minted and nothing is injected.
- **No new storage.** LibreChat remains the only durable copy.

**`filterFilesByAgentAccess` fails open and must not be the only gate.** It returns its input unfiltered
when `agentId` is falsy or `isEphemeralAgentId(agentId)` is true, and ordinary conversations use
ephemeral agent ids. It is used at the naming step and must be passed a real `agentId` where one exists,
but the security property comes from the signed reference: a reference is minted only for a file that
reached the naming step for that principal, and the endpoint serves only what it can verify. This is
defence in depth in the correct order, with the reliable mechanism underneath.

**Deletion.** A deleted file stops resolving, because resolution is against live LibreChat state. Two
honest caveats:

1. A consumer that caches bytes keeps serving its cache until it evicts. For U5 to hold in the presence
   of caching, the consumer must not cache beyond the reference lifetime. **The consumer's cache
   entries must expire no later than the reference that produced them.** Stated here because it is a
   requirement on the consumer, not on LibreChat.
2. Deletion is per-image. Deleting a source photo does not remove renders made from it; those are
   separate files the user owns and can delete. A design session leaves one image per attempt.

**Tenant isolation.** Mounting outside `requireJwtAuth` also skips `tenantContextMiddleware`. The
principal in the payload must carry `tenantId` where the deployment uses one, and the lookup must apply
it, because the middleware will not.

**Rate limiting.** The endpoint needs a bound. Its inbound counterpart has dedicated limiters
(`api/server/middleware/limiters/uploadLimiters.js`); this one is callable in a loop by a process that
is not the user.

## 6. Naming and ordinals

**Build the set from the messages, not from `getThreadData`'s `fileIds`.** This is a correction: an
earlier revision of this section said the upload/render distinction was available from the walk. It is
not. `getThreadData` collects `files` and `attachments` into a single `fileIdSet` and returns
`fileIds: string[]`, flat and deduplicated, so it carries no grouping, no ordering that survives
deduplication, and no per-image metadata.

Use `getThreadData(messages, parentMessageId).messageIds` for what it does provide, which is
authoritative parent-chain membership, then walk those messages in conversation order. Everything else
comes from the walk you control:

- **Upload or render.** Two independent signals agree, and either is sufficient: the image arrived in
  the message's `files` (upload) or `attachments` (render); and the file document carries
  `context: FileContext.message_attachment` for an upload against
  `context: FileContext.image_generation` for a render, set at `callbacks.js:864` and `:1186`. Prefer
  the document field, since it survives regardless of how the message was assembled.
- **Ordinals** are the position of a render among renders, counted forward from the start of the
  conversation. Derived, never stored, so there is no new field anywhere. Stable because the messages
  collection is append-only and the walk is deterministic.
- **The description that produced a render** is not on the file document. The link is `toolCallId`,
  which the tool-end callback puts on the message's `attachments` entry *after* `saveBase64Image` has
  already persisted the document. So the description is recovered by matching that `toolCallId`
  against the tool calls in the same thread's message content. Achievable because we hold the
  messages, but it is a correlation step, not a field read, and it should be budgeted as one.

## 7. Implementation

### 7.1 `packages/api/src/agents/initialize.ts`

Compute the conversation's image set **outside the `resendFiles` conditional**, which opens at `:708`
and closes at `:815` in the current tree, and only when the agent carries the consumer's tools.

1. Determine thread membership with `getThreadData(messages, parentMessageId)`, guarded on
   `conversationId != null`, which is genuinely null on turn 1 while `db.getMessages`'s filter type
   requires a string. Union its `fileIds` with `requestFiles` so an image attached this turn is
   included before the conversation is persisted.
2. **Fetch the documents.** `getThreadData` returns bare strings; the next steps need `user`, `type`,
   `width`, `height` and `context`. Use `getFiles({ file_id: { $in: ids } }, {}, {})`, as
   `resources.ts` does immediately before filtering. Skipping this fetch is the defect that would make
   the whole feature silently produce nothing, because property access on a string is `undefined`.
3. Authorise with `filterFilesByAgentAccess`, passing a real `agentId` where one exists. Read §5 on why
   this is not sufficient on its own.
4. Walk the thread's messages in order, per §6, to split uploads from renders, assign ordinals, and
   recover each render's description. Keep images with dimensions, apply the bounds in §7.2, and mint a
   reference for each.

The gate is `agent.tools` containing a tool name that includes `Constants.mcp_delimiter` and belongs
to the consumer's server, following the pattern already at `initialize.ts:652`.

**This issues its own `db.getMessages` call.** An earlier draft said to reuse the one the execute_code
branch makes. That is not possible: that call sits at `:741`, nested inside the `resendFiles`
conditional, inside `if (toolResourceSet.has(EToolResources.execute_code))`, inside a
`parentMessageId` check, and its result is block-scoped. Code placed outside the conditional, as this
feature requires, has nothing to reuse, and the branch does not run at all for an agent with no
execute_code tool. When both features are active the conversation is queried twice. That is the
honest cost of not refactoring `initializeAgent`, and it is bounded by the `agent.tools` gate.

### 7.2 Bounds

- **Source photos: pinned**, all of them, up to a generous safety bound of 10 per conversation.
- **Attempts: the most recent 20.**

Twenty entries of roughly eighty characters is about 1.6 KB of tool context, which is not a real cost
under a design where naming a file costs only text. The reason a bound exists is to keep the model from
choosing badly among too many near-identical options, not to save tokens.

### 7.3 Tool loading

Thread the set through `createToolLoader` → `loadAgentTools` → `loadToolDefinitionsWrapper` as a field
distinct from `tool_resources.image_edit`. **Do not reuse `image_edit`**: `ToolService.js:1188` feeds
that resource to `image_gen_oai` and `gemini_image_gen`, so reusing it would offer the conversation's
images, including photographs of a person, to cloud image tools. That is an ADR-0006 egress decision,
not a detail.

Add the field at all three production loaders for consistency, noting in the commit message that the
two non-chat loaders are no-ops because they hardcode `requestFiles: []`.

### 7.4 The byte endpoint

Mounted outside `requireJwtAuth` beside the canvas-admin mount in `api/server/index.js`, guarded as in
§3, verifying as in §4.4, streaming via `getStrategyFunctions(source).getDownloadStream(req, filepath)`.

### 7.5 Consumer-side changes

Out of scope for this document, recorded so the boundary is clear. The comfyui-image broker
(`candlekeep/mcp_servers/comfyui-image/`) needs: accept a `lcimg_…` reference wherever it accepts a
handle today; fetch on a cache miss; keep `get()` total, returning nothing on any network, HTTP or
decode error, because its call sites do not guard it; bound the fetch with a timeout; expire cache
entries no later than the reference that produced them, per §5; and stop defaulting an absent user
header to `"anon"`.

## 8. Text corrections that ship with this

1. `server.py` `instructions` and the `source` docstrings say a handle comes from an earlier
   generate/edit/style result. Add uploaded images.
2. **Reword the handle-miss strings.** They currently say "generate the image again", which instructs
   the model to fabricate a replacement and narrate it as the user's photo. Replace with: "No image
   found for that reference. Ask the user to attach the image again. Do not generate a replacement and
   do not use a different reference." This is the text half of U7.
3. `candlekeep-tomes/30-Services/comfyui-image-mcp.md` has been wrong since 2026-07-23: it lists one
   tool and says the user header is for logging only, when a later change made it the store key.

## 9. Interaction with existing behaviour

**9.1 `resendFiles`.** None, by construction: the computation sits outside that conditional. A user who
turns it off to save tokens keeps this feature, which sends no image bytes to the model.

**9.2 Built-in image tools.** None. They continue to consume `tool_resources.image_edit`, untouched.

**9.3 The MCP `audience` annotation.** Complementary and independent. A server can return an image
annotated for the user, displayed but withheld from the model, and separately accept a reference to an
existing image. Together they give a round trip in which no pixels enter model context in either
direction. Neither requires the other.

**9.4 Generated images.** A tool-produced image is a normal owned file attached to its message, and
`getThreadData` collects from `attachments` as well as `files`. Renders are referenceable on later
turns with no extra machinery, which is what makes U4 and U9 cheap.

**9.5 Branched conversations.** The set is thread-scoped, so an image from a different branch is not
offered. Correct, and worth documenting for users.

**9.6 Non-chat loaders.** `openai.js` and `responses.js` hardcode `requestFiles: []`, and one hardcodes
`parentMessageId = null`, so the field threads through as a no-op there.

**9.7 Ephemeral agents.** `filterFilesByAgentAccess` short-circuits for them. See §5.

**9.8 Deletion and the retention sweep.** No hook needed. Resolution is against live state.

## 10. Rejected alternatives

Each was built out and killed. Re-proposing one should require new information.

| Alternative | Why rejected |
| --- | --- |
| Store a broker-side identifier on the file document | Needs a schema field. The file schema is strict, so an undeclared field is silently discarded and the feature becomes a no-op that still passes its own tests. Also the fork's first schema delta, in the fastest-moving subsystem. |
| Give the MCP server a durable copy of the bytes | A second permanent copy of a photograph of a person. Deletion then needs a cascade over derived images, needing a provenance graph, a child index, tombstones and a purge route. Four review rounds, four blocking defects, all in machinery serving only the copy. |
| Resolve identity from a caller-asserted `X-LibreChat-User-Id` header | Any holder of the shared token can act as any user, which breaks U6 outright. |
| Deliver a per-user token via `customUserVars` | That mechanism carries values a user typed into a settings form, substituted into admin-authored placeholders. There is no path for the backend to mint a value per request. |
| Use MCP Multi Round-Trip Requests to fetch bytes | `inputRequests` values **must** be one of `ElicitRequest`, `CreateMessageRequest` or `ListRootsRequest`. None transfers a file, and two of the three are deprecated in the same release. Its `requestState` rules are still the model for §4.2. |
| Reuse `tool_resources.image_edit` to carry the set | It is wired to the cloud image tools, so it would offer these images to them. |
| Use `addPreviousAttachments` history rehydration | Sends bytes into model context, which is the thing being avoided, and is gated on an unrelated user setting. |
| Push bytes to the server on upload | Puts a network call on the upload path, makes the server a dependency of uploading, and stores everything whether used or not. |
| Window images purely by recency | Evicts the source photo, which every attempt depends on, while keeping disposable attempts. Found by stating the use case, not by review. |

## 11. What generalising would take

Recorded because the shape is close and the cost is knowable, not because it is planned.

Three changes: a per-server opt-in key on `mcpServers.<name>`, which **must** be added to
`MCPOptionsSchema` in `packages/data-provider/src/mcp.ts` or Zod will silently strip it; a decision on
whether user-registered servers may enable it, since `omitServerManagedFields` is allow-by-omission and
would include a new base field by default; and an end-user surface, because a user should be able to
see that a server can read their images.

## 12. Risks and open decisions

1. **Reference lifetime versus going back.** Thirty minutes is chosen because context is re-minted every
   turn. If a conversation is resumed after a long gap, references in history are dead, and recovery
   depends on the model preferring the current context over replayed history. §4.3's instruction text
   is the mitigation and its effectiveness is unproven.
2. **Scope of the grant.** A reference names one file for one principal, which is much tighter than the
   earlier user-wide design, but a consumer accumulating references over time holds a growing set of
   live capabilities until they expire.
3. **Ordinals across branching.** Derived ordinals are stable within a thread; a branched conversation
   produces a different walk and therefore different numbering. Acceptable, undocumented for users.

## 13. Test plan

| Area | Test |
| --- | --- |
| U3 cross-turn | Attach an image, run a turn calling nothing, then reference it. Through the real thread walk, not a stubbed file source. |
| U1 same turn | Attach and use in one message, in a conversation already holding more images than the bounds. |
| `resendFiles` off | Both of the above with the setting off. Fails if the computation moves inside the conditional. |
| U8 opt-out | An agent without the consumer's tools produces identical tool definitions and context, and performs **no extra Mongo query and no network call**. Assert both counts are zero, in `packages/api` against `initializeAgent`; `ToolService.spec.js` cannot observe it. |
| U6 isolation | A reference minted for user A is refused when the file belongs to user B. A reference with a tampered payload or MAC is refused. An expired reference is refused. All three return an identical 404 with no body. |
| U5 deletion | Delete a file, then present a still-unexpired reference for it: clean miss. |
| §1.1 anchor | A conversation with 30 attempts still offers every source photo, and offers attempts 11 to 30. |
| U9 ordinals | Attempt numbering is stable as the window slides: attempt 3 is attempt 3 when 34 attempts exist. The unavailable range is stated. |
| U9 descriptions | Each attempt's entry carries the description that produced it. |
| U7 miss text | An unresolvable reference yields the reworked text and renders nothing. |
| U4 renders | An image produced by a tool is referenceable on the next turn. |
| Bare-id regression | Feeding `getThreadData`'s string ids to the access filter without fetching documents yields an empty set. Assert the implementation fetches. |
| Guards | Either secret unset → 501. Wrong bearer → 401. |

Run `test:api` and `test:packages:api`; they are separate scripts and one does not run the other. This
work touches no schema, so `test:packages:data-schemas` is not required.

## 14. Slicing

1. **The byte endpoint and the reference format**, with guards, signing, expiry and tests. No context
   injection. The security surface gets reviewed on its own rather than riding along inside a feature.
2. **The conversation image set, bounds, ordinals and context injection**, behind the tools gate.
3. **Consumer-side changes** in the broker, per §7.5, plus the text corrections in §8.

Slice 1 does nothing useful alone and should say so in its description. It is the half that deserves
separate scrutiny.
