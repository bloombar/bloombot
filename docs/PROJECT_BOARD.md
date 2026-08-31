# Project board

The board at <https://github.com/users/bloombar/projects/2> is **generated from `docs/SPEC.md`**. Issues are
never created by hand; if you want a card, write a requirement.

## The pipeline

```
docs/SPEC.md  ──┐
                ├─→  npm run board:derive  ─→  scripts/board/manifest.yaml  ─→  npm run board:sync  ─→  GitHub
docs/ROADMAP.md ┘
```

| step   | script                     | what it does                                         |
| ------ | -------------------------- | ---------------------------------------------------- |
| derive | `scripts/board/derive.mjs` | parses the SPEC and ROADMAP into `manifest.yaml`     |
| sync   | `scripts/board/sync.mjs`   | creates and updates one GitHub issue per requirement |
| config | `scripts/board/config.mjs` | phases, milestone titles, per-family labels          |

```bash
npm run board:derive      # regenerate the manifest — commit the result
npm run board:sync:dry    # show what sync would do
npm run board:sync        # apply it (needs `gh auth` with the `project` scope)
```

CI fails if `manifest.yaml` is stale, so **run `board:derive` in the same PR that edits the SPEC**.

## What each side owns

`derive.mjs` refreshes `title`, `full`, `section` and `family` from the SPEC on every run, and **preserves**
human-set `phase`, `status`, `review` and `note`. An id present in the manifest but missing from the SPEC is
kept and reported as `STALE` rather than dropped.

`sync.mjs` keys each issue to its requirement with a hidden marker comment (`<!-- sm-req: ID -->`), which is
what makes it idempotent. On every run the manifest owns the issue's title, body, milestone and labels. After
creation, the **board** owns the Status column and whether the issue is open or closed — sync will not fight
a card you moved by hand unless you pass `--reconcile`.

Flags: `--dry-run`, `--limit N`, `--reconcile`, `--prune`.

## Adding a phase or a family

Both mean editing `scripts/board/config.mjs`:

- **A phase** — add its number to `PHASES` and its title to `MILESTONE_TITLE`, matching the `##` heading in
  `docs/ROADMAP.md` exactly. Sync creates the milestone.
- **A family** — add a `FAMILY_LABEL` entry (`area:*` name, colour, description). Any uppercase family name
  parses; the label is what makes it legible on the board.

## Two failure modes that are silent

1. **An unclaimed requirement becomes phase 0 / Done.** `parseRoadmap` assigns a phase only from a
   `**In scope:**` line. An id claimed by no phase falls through to the shipped baseline and lands on the
   board already closed. Every new id needs a phase in the same PR.
2. **`phaseOfHeading` matches more than a number.** It reads `Phase <n>` first, then falls back to mapping
   `Track S1..S3` → 10–12 and `Future work` → 13. A ROADMAP heading using either of those phrases collides
   with a real numeric phase. Use `## Phase <n> — <title>` headings and nothing else.

## Requirement families

`CFG` configuration · `DSC` Discord client · `SRV` server scaffolding · `ROST` rosters and student channels ·
`BOT` chatbot behaviour · `AI` OpenAI integration · `DATA` persistence · `CLI` command-line administration ·
`ANLY` analytics · `OPS` operations and deployment · `BOARD` spec and board tooling.

The platform build adds `PLAT` · `ACT` · `AUTH` · `TEN` · `PROJ` · `SURF` · `WEB` · `API` · `JOB` · `FILE` ·
`COST` · `MCP` · `ADMIN` · `QA`.
