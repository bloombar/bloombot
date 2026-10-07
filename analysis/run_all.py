"""
Execute the analysis notebooks in order and report where the output landed.

    python analysis/run_all.py                    # read data/data.db (combined), outputs under tmp/
    python analysis/run_all.py --mock             # regenerate mock data first (two-file input)
    python analysis/run_all.py --as-of 2026-12-16 # pin the cutoff date
    python analysis/run_all.py --input two-file   # the older legacy.db + current.db arrangement

Input (ANLY-8): by default the single combined platform database `data/data.db`,
opened read-only. `--input two-file` keeps the older pair of files in
`tmp/analysis/`; `--combined-db`, `--legacy-db` and `--current-db` point at other files (not with `--mock`,
which only ever reads the synthetic files it generates).

Notebooks are committed without outputs (a git hook strips them), so a run's outputs
are only written back over them after a `--mock` run (synthetic data) or an explicit
`--write-back`. Any other run saves its executed copies under `<out>/notebooks/`
instead, so real-data outputs stay out of the working tree's tracked files. A failure stops the chain: notebook 03 has nothing to
classify if 00 did not build the dataset.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

ANALYSIS_DIR = Path(__file__).resolve().parent
REPO_ROOT = ANALYSIS_DIR.parent
NOTEBOOKS = [
    "00_build_dataset.ipynb",
    "01_volume_and_adoption.ipynb",
    "02_session_shape.ipynb",
    "03_topics.ipynb",
    "04_cost.ipynb",
    "05_report.ipynb",
]


def run_notebook(path: Path, timeout: int, save_to: Path | None = None) -> float:
    """
    Execute one notebook with the repository root as its working directory.

    The executed copy is written to `save_to`, or back over `path` when that is None.
    """
    import nbformat
    from nbclient import NotebookClient

    started = time.time()
    notebook = nbformat.read(path, as_version=4)
    client = NotebookClient(
        notebook,
        timeout=timeout,
        kernel_name="python3",
        resources={"metadata": {"path": str(REPO_ROOT)}},
    )
    client.execute()
    target = save_to or path
    target.parent.mkdir(parents=True, exist_ok=True)
    nbformat.write(notebook, target)
    return time.time() - started


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mock", action="store_true", help="regenerate the mock databases first")
    parser.add_argument("--as-of", help="pin the analysis cutoff date (YYYY-MM-DD)")
    parser.add_argument("--topic-method", choices=("keyword", "openai"), default=None)
    parser.add_argument(
        "--input",
        default=None,
        help="combined: one platform database (default); two-file: legacy.db + current.db",
    )
    parser.add_argument("--combined-db", help="the combined platform database (default data/data.db)")
    parser.add_argument("--legacy-db", help="two-file mode: the pre-Fall-2026 database")
    parser.add_argument("--current-db", help="two-file mode: the platform database")
    parser.add_argument("--out-dir", help="where the report, figures and data are written")
    parser.add_argument(
        "--write-back",
        action="store_true",
        help="save executed notebooks over the committed ones (implied by --mock; "
        "never use with real data)",
    )
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--only", nargs="*", help="run only these notebooks (by prefix, e.g. 03)")
    parser.add_argument(
        "--publish-example",
        action="store_true",
        help="copy the finished report and figures into analysis/examples/mock_report/ "
        "(only ever run this on mock data — real output stays under tmp/)",
    )
    args = parser.parse_args()

    if args.as_of:
        os.environ["BLOOMBOT_ANALYSIS_AS_OF"] = args.as_of
    if args.topic_method:
        os.environ["BLOOMBOT_TOPIC_METHOD"] = args.topic_method

    # A mock run uses only the synthetic files it generates: input paths given
    # on the command line (or in the environment) are refused or overridden, so
    # `--mock` can never be pointed at real data, and since --mock writes the
    # executed notebooks back into the repository that matters.
    mock_dir = REPO_ROOT / "tmp" / "analysis"
    if args.mock and (args.combined_db or args.legacy_db or args.current_db):
        parser.error("--mock uses its own synthetic databases; do not combine it with --combined-db/--legacy-db/--current-db")
    # A mock run keeps the two-file input (the committed example demonstrates
    # duplicate reconciliation) unless a mode was asked for explicitly.
    input_mode = args.input or ("two-file" if args.mock else "combined")
    os.environ["BLOOMBOT_ANALYSIS_INPUT"] = input_mode
    for flag, name in (
        (args.combined_db, "COMBINED_DB"),
        (args.legacy_db, "LEGACY_DB"),
        (args.current_db, "CURRENT_DB"),
        (args.out_dir, "OUT_DIR"),
    ):
        if flag:
            os.environ[f"BLOOMBOT_ANALYSIS_{name}"] = str(Path(flag).resolve())
    if args.mock:
        for name, file in (("COMBINED_DB", "combined.db"), ("LEGACY_DB", "legacy.db"), ("CURRENT_DB", "current.db")):
            os.environ[f"BLOOMBOT_ANALYSIS_{name}"] = str(mock_dir / file)

    if args.mock:
        print("· generating mock data")
        subprocess.run(
            [sys.executable, str(ANALYSIS_DIR / "mock" / "make_mock_data.py")], check=True
        )

    sys.path.insert(0, str(ANALYSIS_DIR))
    try:  # imported late: env vars must be set first
        from bloombot_analysis.config import CONFIG, INPUT_MODES
    except ValueError as error:  # an input mode the config refuses
        parser.error(str(error))
    if input_mode not in INPUT_MODES:
        parser.error(f"--input must be one of {', '.join(INPUT_MODES)}")

    write_back = args.write_back or args.mock
    inputs = [CONFIG.combined_db] if CONFIG.input_mode == "combined" else [CONFIG.legacy_db, CONFIG.current_db]
    if write_back and any((REPO_ROOT / "data") in p.resolve().parents for p in inputs):
        print("refusing to write notebook outputs back from a run reading data/", file=sys.stderr)
        return 1
    print(f"· input: {CONFIG.describe_inputs()}")
    selected = [
        n for n in NOTEBOOKS if not args.only or any(n.startswith(p) for p in args.only)
    ]
    for name in selected:
        path = ANALYSIS_DIR / "notebooks" / name
        print(f"· running {name}", flush=True)
        try:
            elapsed = run_notebook(
                path, args.timeout, None if write_back else CONFIG.out_dir / "notebooks" / name
            )
        except Exception as error:  # noqa: BLE001 — the message is the useful part
            print(f"\n✗ {name} failed:\n{error}", file=sys.stderr)
            return 1
        print(f"  done in {elapsed:.1f}s")

    if args.publish_example:
        # A committed copy of a mock run, so the report's shape can be reviewed
        # without anyone needing the data. Never point this at real output: the
        # quote candidates alone would put student text in the repository.
        if not args.mock:
            print(
                "refusing to publish an example from a run that did not regenerate mock data "
                "(pass --mock)",
                file=sys.stderr,
            )
            return 1
        import shutil

        destination = ANALYSIS_DIR / "examples" / "mock_report"
        shutil.rmtree(destination, ignore_errors=True)
        destination.mkdir(parents=True)
        # The report, its figures and the metrics behind them — not the tidy
        # CSVs, which are bulky and are the one place message text lives.
        shutil.copy2(CONFIG.report_path, destination / CONFIG.report_path.name)
        shutil.copy2(CONFIG.metrics_path, destination / CONFIG.metrics_path.name)
        shutil.copytree(CONFIG.out_dir / "figures", destination / "figures")
        print(f"· published example → {destination}")

    print("\nOutput:")
    print(f"  report  {CONFIG.report_path}")
    print(f"  figures {CONFIG.out_dir / 'figures'}")
    print(f"  data    {CONFIG.out_dir / 'data'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
