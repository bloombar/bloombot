"""
Execute the analysis notebooks in order and report where the output landed.

    python analysis/run_all.py                    # run everything, in place
    python analysis/run_all.py --mock             # regenerate mock data first
    python analysis/run_all.py --as-of 2026-12-16 # pin the cutoff date

Notebooks are executed with their outputs written back, so the saved `.ipynb`
files are a record of the run that produced the report. A failure stops the
chain: notebook 03 has nothing to classify if 00 did not build the dataset.
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


def run_notebook(path: Path, timeout: int) -> float:
    """Execute one notebook in place, with the repository root as its working directory."""
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
    nbformat.write(notebook, path)
    return time.time() - started


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mock", action="store_true", help="regenerate the mock databases first")
    parser.add_argument("--as-of", help="pin the analysis cutoff date (YYYY-MM-DD)")
    parser.add_argument("--topic-method", choices=("keyword", "openai"), default=None)
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

    if args.mock:
        print("· generating mock data")
        subprocess.run(
            [sys.executable, str(ANALYSIS_DIR / "mock" / "make_mock_data.py")], check=True
        )

    selected = [
        n for n in NOTEBOOKS if not args.only or any(n.startswith(p) for p in args.only)
    ]
    for name in selected:
        path = ANALYSIS_DIR / "notebooks" / name
        print(f"· running {name}", flush=True)
        try:
            elapsed = run_notebook(path, args.timeout)
        except Exception as error:  # noqa: BLE001 — the message is the useful part
            print(f"\n✗ {name} failed:\n{error}", file=sys.stderr)
            return 1
        print(f"  done in {elapsed:.1f}s")

    sys.path.insert(0, str(ANALYSIS_DIR))
    from bloombot_analysis.config import CONFIG  # imported late: env vars must be set first

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
