# Fork inventory

**What this fork carries that upstream does not, and what it costs.**

Verified 2026-08-07 at merge commit `cb50f78a1`, immediately after merging 153 upstream commits into
`deploy/candlekeep`.

## Divergence state

| | |
| --- | --- |
| Our branch | `deploy/candlekeep` |
| `origin` | **upstream** `danny-avila/LibreChat`. The fork (`dii/LibreChat`) is the `fork` remote, so pushes need an explicit remote. |
| Behind upstream before 2026-08-07 | 153 commits, tip 23 July against an upstream tip of 5 August |
| Of those, touching files our work depends on | 32 |
| Ahead of upstream | **9 feature commits** in three clusters, plus the commit that added these documents. 15 including merge commits, 11 on first-parent. |
| Backup before the merge | `backup/deploy-candlekeep-pre-merge-20260807` |

The ahead-count is given three ways because the three numbers disagree and a single figure invites the
wrong one. Nine is the number that matters: it is what the clusters below enumerate. An earlier
revision said thirteen, which matched no counting method and disagreed with this document's own
tables.

**The lesson worth keeping.** The drift was invisible because nothing tracked it. Two weeks of
upstream movement in `api/server/services/Files/`, `packages/api/src/agents/` and
`packages/data-schemas/src/schema/file.ts` silently invalidated a design that cited those files by
line number. Re-check divergence at the start of any work in this area, not at the end.

## Cluster 1 — MCP output audience routing

**Upstreamable: yes, and it should be. This is the one piece here that is generic, small, tested and
solves a problem any LibreChat user can hit.**

| Commit | Subject |
| --- | --- |
| `d2d23c695` | feat: honor MCP audience annotation to withhold tool output from the model |

Files: `packages/api/src/mcp/parsers.ts`, `packages/api/src/mcp/types/index.ts`,
`api/server/controllers/agents/callbacks.js`, plus parser tests.

**What it does.** The MCP specification lets a server annotate content with an intended `audience`.
LibreChat previously ignored it and fed every returned image back into the model. `formatToolContent`
now routes image content annotated `audience: ["user"]` into a display-only artifact key rather than
into the model-visible content, and both tool-end callbacks render from that key as well. Content
that is unannotated, or annotated for the assistant, behaves exactly as before.

**Why it exists.** A text-only local model returned a 500 when an MCP image tool handed it a PNG. The
model had no vision head; the image should never have reached it. Recorded as ADR-0016.

**Upstream value.** Backward compatible by construction (absent annotation means today's behaviour).
It fixes a hard failure for every text-only model against any annotated MCP server, not just ours. It
already carries tests against the real MCP SDK per upstream's testing policy.

**Status.** Shipped and deployed here since 2026-07-23. The upstream pull request has been an open
loose end since the same date. It survived the 153-commit merge untouched.

## Cluster 2 — Canvas documents

**Upstreamable: parts of it, with work. Not proposed for now.**

| Commit | Subject |
| --- | --- |
| `46cea4250` | feat: server-backed canvas docs (non-resident artifact targets for artifact-edit) |
| `af8d2c0cd` | feat: add-to-canvas attachment (drop-folder upload, bypasses context) |
| `4127a5ca3` | feat: multi-select for add-to-canvas uploads |
| `08664f359` | fix: unique canvas doc keys; re-upload appends a version instead of resetting |
| `9cc397d91` | feat: git-backed canvas doc storage (per-user repo, stable docKey index) |
| `4ceffa3ce` | feat(canvas): hard-delete a canvas doc via service-token canvas-admin route |

Files: `api/server/routes/files/canvas.js`, `api/server/routes/canvasAdmin.js`,
`packages/api/src/canvas/*`, `client/src/components/Chat/Input/Files/AttachFileMenu.tsx`,
`api/app/clients/prompts/artifacts.js`, plus tests. Adds `isomorphic-git` as a dependency, which is
the fork's only dependency addition.

**What it does.** Lets a user attach a document that becomes a server-held, git-versioned canvas the
model edits in place, rather than a file whose contents are pushed into context. Includes a
service-token admin route so the canvas MCP server, which holds no user session, can delete a
document.

**Carrying cost.** The largest cluster and the one most likely to conflict, because it touches the
attachment menu, the artifact prompt path and `BaseClient`. The dependency addition means the
lockfile diverges, which is what made the 2026-08-07 merge need a lockfile regeneration.

**Note for later.** `canvasAdmin.js` is the established pattern for a service-token route mounted
outside the JWT chain: bearer token, 401 on mismatch, **501 when the token is unset so it fails closed
rather than open**, mounted in `api/server/index.js`. The image spec reuses that shape. It is worth
knowing that this route only ever deletes a document by validated key; it never returns file bytes,
and the canvas server reads its sources through a read-only bind mount rather than over HTTP. Do not
cite it as precedent for a route that streams bytes.

## Cluster 3 — Artifact editing

**Upstreamable: plausibly, as a self-contained pair. Not proposed for now.**

| Commit | Subject |
| --- | --- |
| `3f0ef49cb` | feat: targeted artifact edits via `:::artifact-edit` directive |
| `5b401fe18` | fix: scope artifact version history by identifier |

Files: `packages/api/src/artifacts/*`, `api/app/clients/prompts/artifacts.js`,
`client/src/components/Artifacts/*`, plus tests.

**What it does.** Lets the model edit part of an existing artifact through a directive instead of
regenerating the whole thing, and scopes version history per artifact identifier so switching between
artifacts does not mix their histories.

**Carrying cost.** Moderate. Mostly additive, in an area upstream changes less often than files.

## A protocol migration is coming, and it is upstream's problem before it is ours

Recorded here because it changes when it is sensible to contribute anything, and because the drift it
will cause is the same kind this document exists to make visible.

MCP released revision **`2026-07-28`** on 28 July, the largest since the protocol launched. LibreChat
declares `@modelcontextprotocol/sdk ^1.29.0`, whose `LATEST_PROTOCOL_VERSION` is `2025-11-25`, so it is
one full revision behind.

What the new revision does:

- **Removes protocol-level sessions.** No `initialize`/`initialized` handshake, no `Mcp-Session-Id`.
  Every request carries its own protocol version and client capabilities in `_meta`, and a new
  `server/discover` RPC advertises capabilities.
- **Replaces server-initiated requests with Multi Round-Trip Requests.** A server returns an
  `InputRequiredResult` carrying `inputRequests`; the client retries with `inputResponses`.
- **Deprecates Roots, Sampling and Logging**, on a twelve-month window, along with the HTTP+SSE
  transport and OAuth Dynamic Client Registration.
- **States that servers needing cross-call state should use server-minted handles passed as ordinary
  tool arguments**, which is what our image broker already does.

Where this fork stands: its MCP layer uses none of the four deprecated features. It does read the
transport's `sessionId` (`packages/api/src/mcp/connection.ts:2113-2115`), which is exactly what the
stateless core removes. That is the migration surface, and it is upstream's to make first.

Two consequences for us. Maintainer attention will be on this migration for a while, which is an
argument against proposing new capabilities into it right now. And the new revision's `requestState`
rules, which require integrity protection, principal binding and a short expiry for state passed
through an untrusted hop, are the model the image spec's signed reference follows.

## What this fork does not carry, and should not

- The vision-allowlist prototype. An earlier attempt at the audience problem, gated on a list of
  models believed to accept images. Wrong axis: the question is what the *content* is annotated as,
  not what the model is. Confirmed absent from `deploy/candlekeep`; it survives only on a stale
  remote-tracking reference.
- Anything ComfyUI-specific. The broker lives in `candlekeep/mcp_servers/comfyui-image/` and talks to
  LibreChat over MCP. The proposed image-reference capability is deliberately generic so that it
  stays true.

## Standing rules for this fork

1. **Rebase or merge before designing, not after.** A design verified against a stale tree is a
   design verified against nothing. Check divergence first.
2. **Prefer upstream mechanisms to local ones.** Upstream shipped `filterFilesByAgentAccess` on
   2 August, which does the file authorisation this fork was about to hand-build. Look for the seam
   before building beside it.
3. **Fork-local schema fields are the most expensive thing to carry.** The fork adds none today. The
   image work nearly added the first, and the pull-based design removed the need.
4. **Every new fork delta needs an entry here**, with an upstreamability judgement made at the time,
   while the reasoning is fresh.
