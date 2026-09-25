# Usage report pipeline

Turns Bloombot's message log into `USAGE_REPORT.md` — a Markdown document written to be read *and*
parsed, since the slide deck is generated from it. The plan behind it, including what goes on each
slide and why, is `docs/USAGE_REPORT_PLAN.md`.

```
analysis/
  bloombot_analysis/   the library: loading, merging, sessions, topics, privacy, charts, report
  notebooks/           00 → 05, run in order
  mock/                a synthetic two-database dataset that exercises every awkward case
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

1. **Copy the databases into `tmp/analysis/`.** Nothing here ever opens `data/data.db` directly —
   the loaders open SQLite read-only and the repository's own guard hook blocks writes to protected
   paths. Copy, do not symlink:

   ```bash
   mkdir -p tmp/analysis
   cp <pre-Fall-2026 database> tmp/analysis/legacy.db
   cp <current platform database> tmp/analysis/current.db
   ```

   Either may be omitted; the pipeline runs on whichever it is given. If the current platform
   database already contains the imported Discord history, the merge counts each message once and
   says how many duplicates it dropped.

2. **Check the calendar in `bloombot_analysis/config.py`** — term start and end dates, the current
   term, and the term it is compared against. These drive the like-for-like truncation, which is
   what keeps an in-progress term from being compared against a finished one.

3. **Run it.**

   ```bash
   python analysis/run_all.py --as-of 2026-09-25                     # keyword topic classifier
   OPENAI_API_KEY=... python analysis/run_all.py --topic-method openai
   ```

   The old cache at `data/topic_classifications.json` is **not** reused. It was keyed by a
   conversation's position in an ordering that no longer exists, so a hit there would attach a label
   to the wrong session; the new cache lives at `tmp/analysis/topic_classifications.json` and is
   keyed by the session's own text. Re-classifying from scratch costs a few cents.

4. **Audit the topic labels.** Notebook 03 writes `tmp/analysis/out/data/topic_audit_sample.csv`.
   Fill in its `hand_label` column, save it as `topic_audit_completed.csv` in the same folder, and
   re-run notebooks 03 and 05. The agreement rate then appears beside every topic chart; until it
   does, the report says in as many words that no audit has been recorded.

5. **Read the report, then refine it.** It is deliberately long — it is a source document, not the
   deck.

## Conventions the report depends on

Each slide is one `## S<nn> · <title>` heading carrying a `**Takeaway:**`, at most one figure with a
caption that states its n, the figure's own data table, `**Speaker notes:**`, and a
`**Confidence:**` field — `measured`, `indicative` or `speculative`. The confidence field is
validated when the slide is built, so a typo fails the run rather than reaching a deck.

## Privacy

- Analysis runs against copies under `tmp/`, never `data/data.db`.
- Soft-deleted conversations and people are excluded in the loader, so no notebook can forget to.
- Instructor and test accounts are excluded from every aggregate.
- Cells covering fewer than five distinct students are suppressed in published tables and charts.
- Quotes are mechanically scrubbed and are marked as candidates: paraphrase them before they reach a
  slide.
- `examples/mock_report/` is built from synthetic data only. Never publish an example from a real
  run — `run_all.py --publish-example` refuses unless it just regenerated the mock data.

## Tests

`tests/test_analysis.py` (pytest, part of the repository's Python suite) covers the rules a reader
of the report is trusting: duplicate reconciliation across the two databases, the timezone
alignment that makes that possible, session splitting, the like-for-like truncation, adoption with
no roster, small-cell suppression, quote scrubbing and the report's own structure.

```bash
python -m pytest tests/test_analysis.py -q
```
