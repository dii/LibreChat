# Candlekeep fork documentation

This directory is the answer to one question: **what has this fork changed in LibreChat, why, and
which of it should go upstream?**

It exists because that question had no answer anywhere, which is how `deploy/candlekeep` drifted to
153 commits behind upstream without anyone noticing, in the subsystem it changes most.

## The documents

| Document | What it is | Audience |
| --- | --- | --- |
| [`fork-inventory.md`](fork-inventory.md) | Every commit this fork carries that upstream does not, grouped into features, each judged for upstreamability and carrying cost. | Us. Read before rebasing, before starting new work, and when deciding what to contribute. |
| [`image-handling-in-librechat.md`](image-handling-in-librechat.md) | How LibreChat actually handles images and files today, end to end, verified against the tree. Not a proposal. | Anyone touching files, uploads, attachments or image tools. Read this **before** designing anything in that area. |
| [`spec-mcp-image-reference.md`](spec-mcp-image-reference.md) | The feature we propose: let an MCP tool use the conversation's images by reference, without the bytes entering model context. Written for LibreChat maintainers. | Upstream. Intended to travel with a pull request. |

## Conventions

The spec follows the shape of upstream's own [`tool-intent-spec.md`](../../tool-intent-spec.md): a
status line, a dated table of verified dependencies, an "existing conventions to mirror" section, an
interaction matrix against the other tool capabilities, a test plan and a slicing plan. When the pull
request is raised, `spec-mcp-image-reference.md` moves to the repository root to match that
convention. It lives here until then so the fork carries no root-level noise.

**Line numbers in these documents are dated and are checked at a stated commit.** They drift, and
they have drifted badly twice. On 2026-08-07 a merge moved a citation by 54 lines in one place and by
107 in another, and a mechanical shift applied to both produced an instruction that pointed inside the
very code block it was meant to sit outside. Treat a line number as a search hint, not an address, and
re-derive before building.

## Where the rest of the record lives

This directory covers **LibreChat**. It is not the house record.

- Decisions and their rationale: `candlekeep-tomes/10-Architecture/decisions/`, in particular
  ADR-0016 (MCP output audience routing), ADR-0014 (ComfyUI two-plane access) and ADR-0006 (cloud LLM
  egress policy).
- The ComfyUI image broker that consumes this feature: `candlekeep/mcp_servers/comfyui-image/`.
- Status and what is in flight: `chanter/works/comfyui-image-uploads.md`.
