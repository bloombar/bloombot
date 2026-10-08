# Usage report pipeline

Turns Bloombot's message log into `USAGE_REPORT.md` — a Markdown document written to be read *and*
parsed, since the slide deck is generated from it. The plan behind it, including what goes on each
slide and why, is `docs/USAGE_REPORT_PLAN.md`.

```
analysis/
  bloombot_analysis/   the library: loading, merging, sessions, topics, privacy, charts, report
  notebooks/           00 → 05, run in order (03b is the staff section)
  mock/                a synthetic dataset (legacy, current and combined databases) that exercises every awkward case
  examples/mock_report/ a finished report built from that mock data, for review
  run_all.py           execute the notebooks end to end
```

## Running it on mock data

```bash
python analysis/run_all.py --mock --as-of 2026-09-25
```

Output lands in `tmp/analysis/out/`: the report, `figures/`, the tidy CSVs in `data/`, and
`metrics.json` (every number the report quotes, so nothing is recomputed at report time).

## Running it on the real data

By default the pipeline reads **one file**, `data/data.db`: the platform database, with the old Discord
bot's history already imported into it by `packages/legacy-import` (ANLY-8). Nothing is copied and nothing
is written to `data/` — the loaders open SQLite read-only (`immutable`, so no `-wal`/`-shm` files appear
beside it) and the repository's guard hook blocks writes to protected paths.

1. **Check the calendar in `bloombot_analysis/config.py`** — term start and end dates, the current
   term, and the term it is compared against. These drive the like-for-like truncation, which is
   what keeps an in-progress term from being compared against a finished one.

2. **Run it.**

   ```bash
   python analysis/run_all.py --as-of 2026-10-07         # combined data/data.db, keyword topics
   OPENAI_API_KEY=... python analysis/run_all.py --topic-method openai
   ```

   Imported messages are labelled from their original Discord category, so legacy-period results are the
   same as the old two-file run gave, and a course is one course across terms (`docs/DECISIONS.md` D-146).

   Executed notebooks are **not** written back over the committed ones (they are committed without
   outputs, and a real-data run must not put its outputs into tracked files); they are saved under
   `tmp/analysis/out/notebooks/`. A `--mock` run does write back, since its data is synthetic; `--mock` therefore refuses
   `--combined-db`/`--legacy-db`/`--current-db` and reads only the synthetic files it generates.

   **The older two-file input** still works: copy a pre-Fall-2026 database to `tmp/analysis/legacy.db` and a
   platform database to `tmp/analysis/current.db` (copy, do not symlink), then

   ```bash
   python analysis/run_all.py --input two-file --as-of 2026-09-25
   ```

   Either may be omitted. If the platform database already contains the imported history, the merge
   counts each message once and says how many duplicates it dropped. `--combined-db`, `--legacy-db`,
   `--current-db` and `--out-dir` (or the `BLOOMBOT_ANALYSIS_*` variables in `config.py`) point at other files.

3. **Staff and student roles, and topic sets (ANLY-9, ANLY-10).** Every message is tagged `staff` or
   `student`. A person is staff in a course when a web identity of theirs names an account with a
   non-revoked membership (owner, instructor or assistant) in the message's organization; the
   `staff_handles` list in `config.py` is a manual override on top, and `excluded_handles` is for test
   rigs only, which are dropped. A database without `accounts`/`memberships` falls back to the handles.
   Student sessions get one of 13 topics (`STUDENT_TOPICS`) and staff sessions one of 7 purposes
   (`STAFF_TOPICS`), each by the keyword rules or the model prompt for that set. Student measures count
   students only; notebook 03b reports staff on their own.

4. **Topic cache.**

   The old cache at `data/topic_classifications.json` is **not** reused. It was keyed by a
   conversation's position in an ordering that no longer exists, so a hit there would attach a label
   to the wrong session; the new cache lives at `tmp/analysis/topic_classifications.json` and is
   keyed by the session's own text, the label-set version (`v2-student` / `v2-staff`) and a hash of
   the model, prompt and label descriptions, so labels from the older nine-label set, or a changed prompt, are
   never reused. Only model labels are cached: keyword labels are cheap and are recomputed every run, so editing a
   rule needs no cache clearing. Re-classifying from scratch costs a few cents. `analytics.ipynb`
   (repository root) shares this cache and the same rule.

5. **Audit the topic labels.** Notebook 03 writes `tmp/analysis/out/data/topic_audit_sample.csv`.
   Fill in its `hand_label` column, save it as `topic_audit_completed.csv` in the same folder, and
   re-run notebooks 03, 03b and 05. The sample holds up to 30 sessions per role, with a `role` column,
   and the rate is reported for each label set. It then appears beside every topic chart; until it
   does, the report says in as many words that no audit has been recorded.

6. **Read the report, then refine it.** It is deliberately long — it is a source document, not the
   deck.

## Conventions the report depends on

Each slide is one `## S<nn> · <title>` heading carrying a `**Takeaway:**`, at most one figure with a
caption that states its n, the figure's own data table, `**Speaker notes:**`, and a
`**Confidence:**` field — `measured`, `indicative` or `speculative`. The confidence field is
validated when the slide is built, so a typo fails the run rather than reaching a deck.

## Privacy

- Notebook **outputs never reach GitHub**: a pre-commit hook strips them from the staged copy, a pre-push hook
  refuses any that slipped through, and CI checks (see `docs/CONTRIBUTING.md`). Enable the hooks with
  `npm install` (or `npm run prepare`). Your local copy keeps its outputs.

- `data/data.db` is only ever opened read-only (`immutable`); every output goes under `tmp/`, and the executed notebooks of a real-data run stay there too.
- Soft-deleted conversations and people are excluded in the loader, so no notebook can forget to.
- Test accounts are excluded from every aggregate. Staff (course owners, instructors, assistants) are kept
  but tagged, left out of every student measure, and reported only as aggregates in their own section:
  a staff group can be one person, so there is no per-person or per-course detail and no quotes for it.
- Cells covering fewer than five distinct students are suppressed in published tables and charts.
- Quotes are mechanically scrubbed and are marked as candidates: paraphrase them before they reach a
  slide.
- `examples/mock_report/` is built from synthetic data only. Never publish an example from a real
  run — `run_all.py --publish-example` refuses unless it just regenerated the mock data.

## Tests

`tests/test_analysis.py` (pytest, part of the repository's Python suite) covers the rules a reader
of the report is trusting: duplicate reconciliation across the two databases, the timezone
alignment that makes that possible, session splitting, the like-for-like truncation, adoption with
no roster, small-cell suppression, quote scrubbing and the report's own structure. For the combined
database (ANLY-8) they also check that an imported legacy message is labelled exactly as the legacy loader
labels it, that reading a WAL-mode file leaves nothing beside it, and that `analytics.ipynb` runs end to end
on synthetic data (keyword topics, never the network).

```bash
python -m pytest tests/test_analysis.py -q
```

The mock databases do not depend on the machine's timezone; run the suite under `TZ=UTC` and
`TZ=America/New_York` to check. CI runs it (with the rest of `tests/`) via `pipenv run pytest tests/`.
