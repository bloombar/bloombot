"""
Every knob the usage report turns, in one place.

Notebooks import `CONFIG` and never hard-code a date, a threshold or a path.
Swapping mock data for real data is a matter of pointing `legacy_db` and
`current_db` at the real files (see `analysis/README.md`); nothing else in the
pipeline needs to change.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


# ── Topic labels ──────────────────────────────────────────────────────────
# The same nine labels `analytics.ipynb` has always used, so the cached
# classifications in `data/topic_classifications.json` stay valid.
TOPICS: list[str] = [
    "Course material & content",
    "Assignments & homework",
    "Syllabus, schedule & deadlines",
    "Technical setup & tools",
    "Grades & assessment",
    "Professor & office hours",
    "Team projects & collaboration",
    "Resources & references",
    "Other",
]

# Discord category prefix → readable course name, carried over from
# `analytics.ipynb`. A prefix with no entry here passes through unchanged.
COURSE_MAP: dict[str, str] = {
    "Software Engineering": "Software Engineering",
    "Agile Dev": "Agile Software Development & DevOps",
    "Python": "Introduction to Programming",
    "Web Design": "Web Design",
}

SURFACE_LABELS: dict[str, str] = {
    "discord": "Discord",
    "web": "Web",
    "mcp": "Chat assistant",
}

# Surfaces that only exist from Fall 2026 onward. Any year-over-year chart
# that includes one of these is partly measuring our own launch, and the
# report says so wherever it happens.
NEW_IN_FALL_2026: tuple[str, ...] = ("web", "mcp")


@dataclass(frozen=True)
class Term:
    """One academic term, and the window of it the data actually covers."""

    key: str
    label: str
    start: date
    end: date

    def elapsed_days(self, as_of: date) -> int:
        """Days of the term that have happened as of `as_of`, capped at its length."""
        if as_of < self.start:
            return 0
        return min((as_of - self.start).days, (self.end - self.start).days)

    def is_complete(self, as_of: date) -> bool:
        return as_of >= self.end


@dataclass
class Config:
    # ── Inputs ────────────────────────────────────────────────────────────
    # `legacy_db`: the pre-Fall-2026 peewee/SQLite database (`users`,
    # `messages` with `category`/`channel` and `from`/`to` directions).
    # `current_db`: the current platform database (`packages/db/src/schema.ts`).
    # Either may be absent; the pipeline runs on whichever it is given.
    legacy_db: Path = REPO_ROOT / "tmp" / "analysis" / "legacy.db"
    current_db: Path = REPO_ROOT / "tmp" / "analysis" / "current.db"
    topic_cache: Path = REPO_ROOT / "tmp" / "analysis" / "topic_classifications.json"

    # ── Outputs ───────────────────────────────────────────────────────────
    out_dir: Path = REPO_ROOT / "tmp" / "analysis" / "out"

    # ── Analysis parameters ───────────────────────────────────────────────
    # Minutes of silence that end a session. 30 is what `analytics.ipynb`
    # has always used and what web analytics conventionally uses; the
    # sensitivity check re-runs the headline numbers at each of these.
    session_gap_minutes: int = 30
    session_gap_sensitivity: tuple[int, ...] = (15, 30, 60)

    # The two databases keep time differently: the legacy bot wrote naive
    # local-time strings, the platform writes epoch milliseconds (UTC). Every
    # timestamp is converted to this zone and made naive, so the two generations
    # line up, duplicates actually match, and "sessions by hour of day" means
    # the hour the student was awake rather than an hour in UTC.
    display_timezone: str = "America/New_York"

    # Cells of a breakdown covering fewer than this many distinct students
    # are suppressed in published output (§5 of the plan).
    min_cell_students: int = 5

    # Accounts excluded from every aggregate: the instructor, test rigs.
    # Matched case-insensitively against the display name or handle.
    excluded_handles: tuple[str, ...] = ("instructor", "testbot", "bloombot-test")

    # ── Calendar ──────────────────────────────────────────────────────────
    # `as_of` is the cutoff every "so far this term" number is measured to,
    # and the point the prior-year window is truncated at for a like-for-like
    # comparison. It defaults to today and can be pinned for a reproducible
    # report run (BLOOMBOT_ANALYSIS_AS_OF=YYYY-MM-DD).
    as_of: date = field(
        default_factory=lambda: (
            datetime.strptime(os.environ["BLOOMBOT_ANALYSIS_AS_OF"], "%Y-%m-%d").date()
            if os.environ.get("BLOOMBOT_ANALYSIS_AS_OF")
            else date.today()
        )
    )

    terms: dict[str, Term] = field(
        default_factory=lambda: {
            "fall_2026": Term("fall_2026", "Fall 2026", date(2026, 9, 2), date(2026, 12, 15)),
            "fall_2025": Term("fall_2025", "Fall 2025", date(2025, 9, 3), date(2025, 12, 16)),
            "spring_2026": Term("spring_2026", "Spring 2026", date(2026, 1, 20), date(2026, 5, 12)),
        }
    )

    # The two terms the headline comparison is between.
    current_term: str = "fall_2026"
    comparison_term: str = "fall_2025"

    def term(self, key: str) -> Term:
        return self.terms[key]

    # Figures live in a `figures/` folder beside the report, which is what the
    # report's own image links assume; data files sit in `data/` next to them.
    def figure_path(self, name: str) -> Path:
        directory = self.out_dir / "figures"
        directory.mkdir(parents=True, exist_ok=True)
        return directory / f"{name}.png"

    def data_path(self, name: str) -> Path:
        directory = self.out_dir / "data"
        directory.mkdir(parents=True, exist_ok=True)
        return directory / name

    @property
    def metrics_path(self) -> Path:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        return self.out_dir / "metrics.json"

    @property
    def report_path(self) -> Path:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        return self.out_dir / "USAGE_REPORT.md"


CONFIG = Config()


# ── Palette ───────────────────────────────────────────────────────────────
# The validated light-mode categorical palette (slots in fixed order — a
# series is never assigned a cycled hue). Charts here are PNGs embedded in a
# Markdown report, so only the light steps are used, and every chart ships a
# data table beneath it, which is what the palette's contrast note requires.
PALETTE: list[str] = [
    "#2a78d6",  # 1 blue
    "#eb6834",  # 2 orange
    "#1baf7a",  # 3 aqua
    "#eda100",  # 4 yellow
    "#e87ba4",  # 5 magenta
    "#008300",  # 6 green
    "#4a3aa7",  # 7 violet
    "#e34948",  # 8 red
]

# Surfaces keep a fixed slot each, so a chart that drops an empty surface
# never repaints the survivors.
SURFACE_COLORS: dict[str, str] = {
    "discord": PALETTE[0],
    "web": PALETTE[1],
    "mcp": PALETTE[2],
}

SEQUENTIAL_HUE: list[str] = [
    "#cde2fb",
    "#9ec5f4",
    "#6da7ec",
    "#3987e5",
    "#2a78d6",
    "#256abf",
    "#1c5cab",
    "#184f95",
    "#104281",
]

INK_PRIMARY = "#0b0b0b"
INK_SECONDARY = "#52514e"
INK_MUTED = "#8a8880"
SURFACE = "#fcfcfb"
GRID = "#e6e5e1"
