# Vendor documentation mirror

> The four vendors' managed-agent documentation, fetched into `vendor-docs/` so that provider
> work reads a complete local copy instead of remembering an API or fetching pages ad hoc.
> The mirror is ignored by git (the pages are the vendors' copyright); `scripts/vendor-docs.mjs`
> is the reproducible part. Rebuild with `pnpm docs:vendor`.

## Layout

```text
vendor-docs/
├── README.md                 Generated: fetch date, page counts, how to refresh
├── anthropic/
│   ├── INDEX.md              Generated: every page with its title and source URL
│   ├── managed-agents/*.md   Guides (overview, sessions, environments, vaults, files, ...)
│   ├── api/beta/**/*.md      API reference (agents, sessions, events, environments, vaults, files, ...)
│   └── llms.txt              The vendor's index as fetched
├── openai/
│   ├── INDEX.md
│   ├── guides/**/*.md        Agents API guides
│   ├── reference/**/*.md     Beta agents endpoint reference and streaming events
│   └── llms.txt
├── google/
│   ├── INDEX.md
│   ├── docs/*.md             Managed agents, environments, Interactions API, streaming, hooks, ...
│   ├── api/*.md              REST reference: interactions, agents, environments
│   └── llms.txt
└── cursor/
    ├── INDEX.md
    ├── cloud-agent/**/*.md   Cloud Agents guides and the API reference
    ├── sdk/*.md, api.md      SDK and API overview
    ├── cloud-agents-openapi.yaml
    └── llms.txt
```

Every page starts with front matter:

```yaml
---
source: https://platform.claude.com/docs/en/managed-agents/sessions.md
fetched_at: 2026-09-14T16:20:00.000Z
sha256: 3f1c...
---
```

## How the mirror is built

`scripts/vendor-docs.mjs` reads each vendor's `llms.txt` index, keeps the entries whose URL
matches the vendor's include patterns (managed agents, agents API, cloud agents, and their
reference pages), adds a few URLs the index does not list (the Cursor OpenAPI spec, the
Gemini REST reference), fetches the Markdown twin of every page, and writes it under the
vendor folder with the path taken from the URL. Pages whose fetch fails are listed in the
vendor's `INDEX.md` under "Missing" rather than silently dropped. Nothing is transformed:
the file is the vendor's text plus the front matter.

## How to use it

- `pnpm docs:search "<terms>"` searches every heading section of the project docs and the
  mirror (MiniSearch: prefix and fuzzy matching, headings boosted) and prints `file:line`
  hits with a snippet; `--vendor <name>` narrows to one vendor, `-n <count>` widens.
- `pnpm docs:dev` serves a VitePress site over `docs/` and the mirror with a sidebar per
  vendor (built from each `INDEX.md`) and in-browser full-text search; `pnpm docs:build`
  emits it to `docs/.vitepress/dist/` (ignored).
- Start at `vendor-docs/<provider>/INDEX.md`; it is the table of contents.
- `grep -rn "<term>" vendor-docs/<provider>/` finds every mention across guides and reference.
- When a provider mapping changes, cite the page (`source`) in the provider file's header
  comment, next to the live observation it explains.
- When a live run contradicts a page, the live behaviour wins in the code and the README
  pitfalls record the contradiction with the date.
- Refresh before a release or after a vendor announces a change: `pnpm docs:vendor`, then
  `git diff` is useless (ignored), so compare the `sha256` lines or keep the previous mirror
  aside.

## Adding a vendor

Add an entry to `SOURCES` in `scripts/vendor-docs.mjs`: the index URL(s), the include
patterns, the prefix to strip from paths, and any extra URLs. Run the script, read the new
`INDEX.md`, and adjust the patterns until the set is the managed-agent surface and nothing
else.
