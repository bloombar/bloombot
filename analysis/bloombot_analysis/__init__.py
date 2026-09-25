"""
Shared analysis library for the Bloombot usage report.

The notebooks under `analysis/notebooks/` are thin: they call into this package,
show what came back, and save figures. Everything with a rule in it — how a
session is defined, how the pre-Fall-2026 database is reconciled with the
current one, which cells are suppressed for privacy — lives here, where it can
be unit-tested (`tests/test_analysis.py`) instead of being retyped per notebook.
"""

from . import charts, config, load, metrics, privacy, report, sessions, topics  # noqa: F401

__all__ = [
    "charts",
    "config",
    "load",
    "metrics",
    "privacy",
    "report",
    "sessions",
    "topics",
]
