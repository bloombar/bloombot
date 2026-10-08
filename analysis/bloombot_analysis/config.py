"""
Every knob the usage report turns, in one place.

Notebooks import `CONFIG` and never hard-code a date, a threshold or a path.
Swapping mock data for real data is a matter of pointing the input at the real
file (see `analysis/README.md`); nothing else in the pipeline needs to change.
Every path can also be overridden by an environment variable (`run_all.py` sets
them from its flags), so a run never needs a code edit to read different data.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

INPUT_MODES = ("combined", "two-file")


def _env(name: str, default: str) -> str:
    return os.environ.get(name) or default


def _env_path(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    return Path(value) if value else default


# ── Topic labels (ANLY-10) ────────────────────────────────────────────────
# Two label sets, because students and staff use the bot for different things.
# A session is classified under the set that matches its role. The version is
# part of every cache key, so a label made under an older set (the nine-label
# v1 set) is never reused.
STUDENT_TOPICS: list[str] = [
    "Project & assignment requirements",
    "Deadlines & schedule",
    "Grades & grading",
    "Course policies",
    "Course concepts",
    "Quiz & exam questions",
    "Code & debugging",
    "Git & GitHub workflow",
    "Tools, setup & deployment",
    "Team coordination",
    "Discord & platform help",
    "Greetings & bot questions",
    "Other",
]

STAFF_TOPICS: list[str] = [
    "Testing the bot",
    "Demonstrating to class",
    "Announcements",
    "Directing students",
    "Course content & policy lookup",
    "Course setup",
    "Other",
]

TOPIC_SET_VERSION = "v2"


def topics_for(role: str) -> list[str]:
    """The label set for a role: staff get the purpose set, everyone else the student set."""
    return STAFF_TOPICS if role == "staff" else STUDENT_TOPICS


def topic_set_key(role: str) -> str:
    """Versioned label-set name used in cache keys, e.g. 'v2-student'."""
    return f"{TOPIC_SET_VERSION}-{'staff' if role == 'staff' else 'student'}"


# Discord category prefix → readable course name, carried over from
# `analytics.ipynb`. A prefix with no entry here passes through unchanged. Matching
# ignores case (ANLY-8): the Summer 2025/2026 categories are upper-case
# (`PYTHON - …`), and must land on the same course as `Python - …`.
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
    # ANLY-8. `input_mode` picks where messages come from:
    #   'combined'  (default) one platform-schema database holding the whole
    #               history, the old Discord bot's included (imported by
    #               `packages/legacy-import`): `combined_db`.
    #   'two-file'  the older arrangement, kept as an explicit option: a
    #               pre-Fall-2026 peewee database (`legacy_db`) plus a platform
    #               database (`current_db`), deduplicated when they overlap.
    # Every file is opened read-only; the combined default is the real
    # `data/data.db`, which is never written to or copied into.
    input_mode: str = field(default_factory=lambda: _env("BLOOMBOT_ANALYSIS_INPUT", "combined"))
    combined_db: Path = field(
        default_factory=lambda: _env_path("BLOOMBOT_ANALYSIS_COMBINED_DB", REPO_ROOT / "data" / "data.db")
    )
    legacy_db: Path = field(
        default_factory=lambda: _env_path("BLOOMBOT_ANALYSIS_LEGACY_DB", REPO_ROOT / "tmp" / "analysis" / "legacy.db")
    )
    current_db: Path = field(
        default_factory=lambda: _env_path("BLOOMBOT_ANALYSIS_CURRENT_DB", REPO_ROOT / "tmp" / "analysis" / "current.db")
    )
    topic_cache: Path = field(
        default_factory=lambda: _env_path(
            "BLOOMBOT_ANALYSIS_TOPIC_CACHE", REPO_ROOT / "tmp" / "analysis" / "topic_classifications.json"
        )
    )

    # ── Outputs ───────────────────────────────────────────────────────────
    out_dir: Path = field(
        default_factory=lambda: _env_path("BLOOMBOT_ANALYSIS_OUT_DIR", REPO_ROOT / "tmp" / "analysis" / "out")
    )

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

    # ANLY-9. Staff are found from the platform's memberships (an active
    # membership in the message's organization, any role). `staff_handles` is
    # the manual override on top of that: a display name or handle containing
    # one of these is staff. `excluded_handles` is for test rigs only, which are
    # dropped from every aggregate, staff section included. Both are matched
    # case-insensitively as substrings.
    staff_handles: tuple[str, ...] = ("instructor",)
    excluded_handles: tuple[str, ...] = ("testbot", "bloombot-test")

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

    def __post_init__(self) -> None:
        if self.input_mode not in INPUT_MODES:
            raise ValueError(
                f"input_mode must be one of {INPUT_MODES}, got {self.input_mode!r}"
            )

    @property
    def platform_db(self) -> Path:
        """The platform-schema file: the one source in combined mode, the current one otherwise."""
        return self.combined_db if self.input_mode == "combined" else self.current_db

    def describe_inputs(self) -> str:
        """One line naming the input(s), repo-relative where possible, for notebook headers."""

        def show(path: Path) -> str:
            try:
                name = str(path.resolve().relative_to(REPO_ROOT))
            except ValueError:
                name = str(path)
            return f"{name} ({'exists' if path.exists() else 'missing'})"

        if self.input_mode == "combined":
            return f"combined: {show(self.combined_db)}"
        return f"two-file: legacy {show(self.legacy_db)}; current {show(self.current_db)}"

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
