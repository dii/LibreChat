# Candlekeep fork documentation

This directory answers two questions: **what has this fork changed in LibreChat and why**, and
**what are we building next and for whom**.

The first existed nowhere, which is how `deploy/candlekeep` drifted to 153 commits behind upstream
without anyone noticing, in the subsystem it changes most.

## The documents

| Document | What it is | Audience |
| --- | --- | --- |
| [`fork-inventory.md`](fork-inventory.md) | Every commit this fork carries that upstream does not, grouped into features, each judged for upstreamability and carrying cost. Plus the MCP protocol migration heading our way. | Us. Read before rebasing, before starting new work, and when deciding what to contribute. |
| [`image-handling-in-librechat.md`](image-handling-in-librechat.md) | How LibreChat actually handles images and files today, verified against the tree. Not a proposal. | Anyone touching files, uploads, attachments or image tools. Read this **before** designing anything in that area. |
| [`artefact-model.md`](artefact-model.md) | What an artefact is across this fork's mechanisms, who owns it, and how it is listed and deleted. Written to check whether we are accreting a separate model per artefact type. | Us. Read before adding any new kind of thing a conversation can produce or consume. |
| [`spec-canvas-on-files.md`](spec-canvas-on-files.md) | Rebuilding canvas with no store of its own: a file plus a stateless service. Opens by asking whether to build it at all, because the feature has no recorded use case. | Whoever picks it up, after that question is answered. |
| [`spec-mcp-image-reference.md`](spec-mcp-image-reference.md) | The feature we are building: let an MCP tool use the conversation's images by reference, without the bytes entering model context. Starts from user needs and the use case they came from. | Whoever implements it. Shaped so it could be generalised and offered upstream later; see its §11. |

## How to read the spec

Start at **§1, the user needs**, and read the provenance column. Two of the nine needs were assumed by
the author for two days before anyone checked them, and one of those, cross-turn availability, is the
single most expensive requirement in the design. Knowing which needs came from the owner and which
came from the author is how you tell a justified cost from an unexamined one.

**§1.1 is the use case.** It arrived late and immediately falsified a design decision that had already
been agreed, reviewed and written down. If you are about to change the bounds, the naming or the
ordinals, read it first.

## Conventions

The spec follows the shape of upstream's own [`tool-intent-spec.md`](../../tool-intent-spec.md): a
status line, a dated table of verified dependencies, conventions to mirror, an interaction section, a
rejected-alternatives table, a test plan and a slicing plan.

**Line numbers in these documents are dated and checked at a stated commit.** They drift, and they have
drifted badly twice. On 2026-08-07 a merge moved one citation by 54 lines and another by 107, and a
uniform shift applied to both produced an instruction that pointed inside the very block it was meant
to sit outside. Treat a line number as a search hint, not an address, and re-derive before building.

## Standing corrections

Both of these were caught by review after being written down as fact, and both are the kind of error
that survives because it reads plausibly.

- The **assistants upload path** does *not* behave like the agent tool-resource path. The dispatch is
  negated. See `image-handling-in-librechat.md` §1.
- The fork is **9 feature commits** ahead of upstream, not 13. Three different counting methods give
  three different numbers; the inventory now states all three.

## Where the rest of the record lives

This directory covers **LibreChat**. It is not the house record.

- Decisions and rationale: `candlekeep-tomes/10-Architecture/decisions/`, in particular ADR-0016 (MCP
  output audience routing), ADR-0014 (ComfyUI two-plane access) and ADR-0006 (cloud LLM egress policy).
- The image broker that consumes this feature: `candlekeep/mcp_servers/comfyui-image/`. The spec's §7.5
  states the boundary and what the consumer must do.
- Status, decisions and the full design history including seven superseded plan versions:
  `chanter/works/comfyui-image-uploads.md`.
