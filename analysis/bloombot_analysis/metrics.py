"""
The measurement hand-off between notebooks.

Each analysis notebook writes what it found into one JSON file; the report
notebook reads that file and writes the document. Nothing is recomputed at
report time, so the number in the prose and the number in the chart cannot
drift apart, and a failed notebook is visible as a missing key rather than as a
quietly stale figure.

Keys are namespaced by notebook (`dataset.*`, `volume.*`, `shape.*`,
`topics.*`, `cost.*`).
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .config import CONFIG, Config


def _plain(value: Any) -> Any:
    """Make a value JSON-safe without losing what it means."""
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return None if np.isnan(value) else float(value)
    if isinstance(value, float):
        return None if pd.isna(value) else value
    if isinstance(value, (pd.Timestamp, _dt.datetime, _dt.date)):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if value is pd.NaT:
        return None
    return value


def load(config: Config | None = None) -> dict:
    config = config or CONFIG
    path = config.metrics_path
    if path.exists():
        return json.loads(path.read_text())
    return {}


def update(section: str, values: dict, config: Config | None = None) -> dict:
    """Merge one notebook's findings into the shared metrics file."""
    config = config or CONFIG
    everything = load(config)
    everything.setdefault(section, {})
    everything[section].update(_plain(values))
    everything["_written_at"] = _dt.datetime.now().isoformat(timespec="seconds")
    # Insertion order is kept, not sorted: a record's column order is part of
    # how the report renders its tables, and sorting keys silently reorders
    # every table in the document.
    config.metrics_path.write_text(json.dumps(everything, indent=2))
    return everything


def reset(config: Config | None = None) -> None:
    """Start a clean run — stale keys from a previous dataset are a hazard."""
    config = config or CONFIG
    if config.metrics_path.exists():
        config.metrics_path.unlink()


def require(everything: dict, section: str, *keys: str) -> None:
    """Fail loudly at report time if an upstream notebook did not run."""
    missing = [k for k in keys if k not in everything.get(section, {})]
    if missing:
        raise KeyError(
            f"metrics section {section!r} is missing {missing}. "
            "Run the notebooks in order (00 → 04) before building the report."
        )
