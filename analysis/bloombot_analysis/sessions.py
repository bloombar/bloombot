"""
Sessions, and everything measured per session.

A *session* is consecutive traffic between one student and the bot in one
course on one surface, split whenever more than `session_gap_minutes` of
silence passes. The stored `conversations` row is deliberately not used as the
unit: on web a conversation is long-lived and can hold a whole term of chat,
so it answers "has this student ever talked to the bot here", not "how did one
visit go".

Grouping is by person + course + surface rather than by channel, so a student
who asks in a shared channel and then follows up in their own private channel
within the gap is one session, not two — which is how it reads to the student.
"""

from __future__ import annotations

import warnings
from collections.abc import Collection, Mapping
from datetime import date, timedelta

import numpy as np
import pandas as pd

from .config import CONFIG, Config, Term

# `role` is in the key (ANLY-9) so a session always has exactly one role. In
# practice a person has one role in a course, so it never splits a real session.
SESSION_KEYS = ["person_key", "course", "surface", "role"]


def sessionize(messages: pd.DataFrame, gap_minutes: int | None = None) -> pd.DataFrame:
    """
    Tag every message with a session id.

    Adds `session_id` (a string, unique across the frame) and `session_index`
    (that session's position in the student's own history, 1-based) to a copy
    of `messages`.
    """
    gap_minutes = gap_minutes if gap_minutes is not None else CONFIG.session_gap_minutes
    if messages.empty:
        out = messages.copy()
        if "role" not in out:
            out["role"] = pd.Series(dtype="object")
        out["session_id"] = pd.Series(dtype="object")
        return out

    gap = pd.Timedelta(minutes=gap_minutes)
    frame = messages.copy()
    if "role" not in frame:  # frames built before roles existed are all students
        frame["role"] = "student"
    frame = frame.sort_values(SESSION_KEYS + ["ts"])
    delta = frame.groupby(SESSION_KEYS, dropna=False)["ts"].diff()
    # A row with no predecessor in its group starts a session; so does one that
    # follows more than `gap` of silence.
    starts = delta.isna() | (delta > gap)
    frame["session_id"] = starts.cumsum().astype(str).radd("s")
    return frame


def session_frame(messages: pd.DataFrame, gap_minutes: int | None = None) -> pd.DataFrame:
    """
    One row per session, with the measures the report reads off it.

    `prompts` counts only student messages: the bot's replies would otherwise
    double every length and make sessions look twice as deep as they are.
    """
    tagged = sessionize(messages, gap_minutes)
    if tagged.empty:
        return pd.DataFrame(
            columns=[
                "session_id", "person_key", "role", "course", "surface", "channel_type",
                "started_at", "ended_at", "messages", "prompts", "replies",
                "duration_minutes", "date", "week", "semester",
            ]
        )

    grouped = tagged.groupby("session_id", sort=False)
    sessions = grouped.agg(
        person_key=("person_key", "first"),
        role=("role", "first"),
        course=("course", "first"),
        surface=("surface", "first"),
        channel_type=("channel_type", "first"),
        started_at=("ts", "min"),
        ended_at=("ts", "max"),
        messages=("message_id", "count"),
        prompts=("direction", lambda d: int((d == "from").sum())),
    ).reset_index()

    sessions["replies"] = sessions["messages"] - sessions["prompts"]
    sessions["duration_minutes"] = (
        sessions["ended_at"] - sessions["started_at"]
    ).dt.total_seconds() / 60.0
    sessions["date"] = sessions["started_at"].dt.date
    sessions["week"] = sessions["started_at"].dt.to_period("W").dt.start_time
    sessions["semester"] = sessions["started_at"].map(
        lambda ts: f"{'Spring' if ts.month <= 5 else 'Summer' if ts.month <= 8 else 'Fall'} {ts.year}"
    )
    # A session with no student message is the bot talking to itself (an
    # announcement, a system notice); it is not a usage session.
    sessions = sessions[sessions["prompts"] > 0]
    return sessions.sort_values("started_at").reset_index(drop=True)


# ── Term windows ──────────────────────────────────────────────────────────


def in_term(
    frame: pd.DataFrame, term: Term, ts_column: str = "ts", buffer_days: int = 0
) -> pd.DataFrame:
    """Rows falling inside a term's calendar span, plus `buffer_days` either side."""
    if frame.empty:
        return frame
    ts = pd.to_datetime(frame[ts_column])
    pad = timedelta(days=buffer_days)
    return frame[(ts.dt.date >= term.start - pad) & (ts.dt.date <= term.end + pad)]


def like_for_like(
    frame: pd.DataFrame, term: Term, elapsed_days: int, ts_column: str = "ts", buffer_days: int = 0
) -> pd.DataFrame:
    """
    The first `elapsed_days` of a term, starting `buffer_days` before its official start.

    The same rule is used for both terms of a comparison: official start minus
    the buffer, to official start plus the elapsed days (ANLY-11).

    This is the correction the whole year-over-year comparison depends on.
    Fall 2026 is in progress — the term does not end until mid-December — so
    comparing it against a *complete* Fall 2025 would report the calendar, not
    a change in behaviour. Both sides are cut to the same number of days from
    their own term start before anything is compared.
    """
    if frame.empty:
        return frame
    ts = pd.to_datetime(frame[ts_column])
    day_of_term = (ts.dt.normalize() - pd.Timestamp(term.start)).dt.days
    return frame[(day_of_term >= -buffer_days) & (day_of_term <= elapsed_days)]


def term_completeness(config: Config | None = None) -> dict:
    """
    How far through the current term the data actually runs.

    Every headline number from the current term is a partial-term number, and
    this dictionary is what the report puts on the page so no reader has to
    infer it.
    """
    config = config or CONFIG
    current = config.term(config.current_term)
    comparison = config.term(config.comparison_term)
    as_of: date = config.as_of
    elapsed = current.elapsed_days(as_of)
    total = (current.end - current.start).days
    return {
        "as_of": as_of,
        "current_term": current.label,
        "current_start": current.start,
        "current_end": current.end,
        "elapsed_days": elapsed,
        "total_days": total,
        "fraction_elapsed": (elapsed / total) if total else 0.0,
        "comparison_term": comparison.label,
        "comparison_window_end": comparison.start + (as_of - current.start)
        if as_of >= current.start
        else comparison.start,
    }


# ── Headline measures ─────────────────────────────────────────────────────


def usage_summary(sessions: pd.DataFrame) -> dict:
    """The handful of numbers the report leads with."""
    if sessions.empty:
        return {
            "sessions": 0, "students": 0, "prompts": 0, "courses": 0,
            "median_prompts": float("nan"), "mean_prompts": float("nan"),
            "iqr_prompts": (float("nan"), float("nan")),
            "median_duration": float("nan"),
            "iqr_duration": (float("nan"), float("nan")),
        }
    return {
        "sessions": int(len(sessions)),
        "students": int(sessions["person_key"].nunique()),
        "prompts": int(sessions["prompts"].sum()),
        "courses": int(sessions["course"].nunique()),
        "median_prompts": float(sessions["prompts"].median()),
        "mean_prompts": float(sessions["prompts"].mean()),
        "iqr_prompts": (
            float(sessions["prompts"].quantile(0.25)),
            float(sessions["prompts"].quantile(0.75)),
        ),
        "median_duration": float(sessions["duration_minutes"].median()),
        "iqr_duration": (
            float(sessions["duration_minutes"].quantile(0.25)),
            float(sessions["duration_minutes"].quantile(0.75)),
        ),
    }


def gap_sensitivity(
    messages: pd.DataFrame, gaps: tuple[int, ...] | None = None
) -> pd.DataFrame:
    """
    Re-derive the headline session numbers at several gap thresholds.

    The 30-minute cut is a convention, not a measurement. Showing what the
    numbers do at 15 and 60 minutes is what turns it from an arbitrary choice
    into a stated and checkable one.
    """
    gaps = gaps or CONFIG.session_gap_sensitivity
    rows = []
    for gap in gaps:
        summary = usage_summary(session_frame(messages, gap))
        rows.append(
            {
                "gap_minutes": gap,
                "sessions": summary["sessions"],
                "median_prompts": summary["median_prompts"],
                "median_duration_minutes": summary["median_duration"],
            }
        )
    return pd.DataFrame(rows)


def adoption(
    sessions: pd.DataFrame,
    enrolments: pd.DataFrame,
    class_sizes: Mapping[str, int] | None = None,
) -> pd.DataFrame:
    """
    Per course: enrolled students, registered users, active users, and both shares (ANLY-11).

    The words mean different things and are never mixed:
      * `enrolled`   - the official class size, a hand-entered headcount from
                       `CONFIG.class_sizes` (NA when none is configured).
      * `registered` - users: students the platform knows through an enrolment row.
      * `active`     - users who sent at least one prompt in `sessions`.
    Both shares are of *enrolled* students. A course with no class size gets NA
    shares - never a share of registered users, which would read as near-100% adoption
    and say nothing about the class. Registered may exceed the class size (a late
    drop, a typo in the config); that is shown as it is, with a warning.
    """
    columns = ["course", "enrolled", "registered", "active", "registered_share", "active_share"]
    sizes = dict(class_sizes or {})
    if sessions.empty and enrolments.empty and not sizes:
        return pd.DataFrame(columns=columns)

    active = (
        sessions.groupby("course")["person_key"].nunique().rename("active")
        if not sessions.empty
        else pd.Series(dtype=int, name="active")
    )
    registered = (
        enrolments.groupby("course")["person_key"].nunique().rename("registered")
        if not enrolments.empty
        else pd.Series(dtype=int, name="registered")
    )
    enrolled = pd.Series(sizes, dtype="Int64", name="enrolled")
    out = pd.concat([enrolled, registered, active], axis=1)
    out.index.name = "course"
    out = out.reset_index()
    out["registered"] = out["registered"].fillna(0).astype(int)
    out["active"] = out["active"].fillna(0).astype(int)
    out["enrolled"] = out["enrolled"].astype("Int64")
    has_size = out["enrolled"].notna() & (out["enrolled"] > 0)
    denominator = out["enrolled"].astype(float)
    out["registered_share"] = np.where(has_size, out["registered"] / denominator, np.nan)
    out["active_share"] = np.where(has_size, out["active"] / denominator, np.nan)
    over = out[has_size & (out["registered"] > out["enrolled"].fillna(0))]
    for course in over["course"]:
        warnings.warn(f"{course}: more registered users than the configured class size", stacklevel=2)
    return out[columns].sort_values("course").reset_index(drop=True)


def _assign_terms(sessions: pd.DataFrame, config: Config) -> pd.DataFrame:
    """
    Tag each session with the one term it belongs to (`_term`), so term windows
    that overlap never count a session twice.

    A session falls in every buffered term window (official dates plus
    `term_buffer_days`) that contains its date. If that is several, it goes to
    the term whose class sizes list its course, then to one whose official dates
    contain the day, then to the latest-starting. Sessions outside every window
    get no term.
    This uses the `Term` windows, not `load.semester_of`, which calls all of
    May Spring.
    """
    if sessions.empty:
        return sessions.assign(_term=pd.Series(dtype=object))
    days = pd.to_datetime(sessions["started_at"]).dt.date
    windows = {k: config.window(k) for k in config.terms}
    owners = []
    for day, course in zip(days, sessions["course"]):
        inside = [k for k, (first, last) in windows.items() if first <= day <= last]

        def preference(k: str):
            term = config.term(k)
            return (course in config.class_sizes_for(k), term.start <= day <= term.end, term.start)

        owners.append(max(inside, key=preference) if inside else None)
    return sessions.assign(_term=owners)


def term_sessions(sessions: pd.DataFrame, config: Config, term_key: str) -> pd.DataFrame:
    """
    The sessions that belong to one term under the single-term assignment
    (`_assign_terms`), so a like-for-like window or a per-term table never
    counts a session that another term owns (ANLY-11).
    """
    if sessions.empty:
        return sessions
    tagged = _assign_terms(sessions, config)
    return tagged[tagged["_term"] == term_key].drop(columns="_term")


def term_adoption(
    student_sessions: pd.DataFrame,
    enrolments: pd.DataFrame,
    config: Config | None = None,
) -> pd.DataFrame:
    """
    Per term and course: enrolled, registered, active, and the active share (ANLY-11).

    Active share (active users / enrolled students) is computable for any term
    with a class size, because it needs only the sessions. Registration exists
    only from `config.registration_from_term`; earlier terms get `registered` NA,
    and `registration_existed` False so the report can say so instead of "0".
    The current term is flagged `partial` (data runs only to `as_of`), and an
    active or registered count of 1 to `min_cell_students - 1` is blanked (small-cell rule);
    the blanked row's share goes with it. A course with no class size has NA
    enrolled and NA share.
    """
    config = config or CONFIG
    rows = []
    frame = _assign_terms(student_sessions, config)
    for key, term in sorted(config.terms.items(), key=lambda kv: kv[1].start):
        sizes = config.class_sizes_for(key)
        in_this = frame[frame["_term"] == key] if not frame.empty else frame
        active = (
            in_this.groupby("course")["person_key"].nunique() if not in_this.empty else pd.Series(dtype=int)
        )
        scoped = registrations_in_window(enrolments, config, key)
        registered = (
            scoped.groupby("course")["person_key"].nunique()
            if config.registration_existed(key) and not scoped.empty
            else pd.Series(dtype=int)
        )
        existed = config.registration_existed(key)
        for course in sorted(set(sizes) | set(active.index)):
            enrolled = sizes.get(course)
            n_active = int(active.get(course, 0))
            blanked = 0 < n_active < config.min_cell_students
            rows.append(
                {
                    "term": key,
                    "term_label": term.label,
                    "course": course,
                    "enrolled": enrolled,
                    "registered": (
                        None
                        if not existed or 0 < int(registered.get(course, 0)) < config.min_cell_students
                        else int(registered.get(course, 0))
                    ),
                    "registration_existed": existed,
                    "active": None if blanked else n_active,
                    "active_share": (
                        n_active / enrolled if enrolled and not blanked else float("nan")
                    ),
                    "partial": term.start <= config.as_of < term.end,
                }
            )
    out = pd.DataFrame(rows)
    for column in ("enrolled", "registered", "active"):
        out[column] = out[column].astype("Int64")
    return out


def window_active_share(
    window: pd.DataFrame, class_sizes: Mapping[str, int], min_cell: int = 0
) -> dict:
    """
    Active students per course enrolment over one like-for-like window (ANLY-11).

    `active` sums the per-course distinct students, so a student in two sized
    courses counts once in each; `enrolled` sums the class sizes, the same
    unit. Only courses with a class size count, in numerator and denominator
    alike. If any course's count is between 1 and `min_cell - 1`, the figures
    are withheld (`suppressed` True, active and share None) so the total cannot
    be used to back out a blanked cell.
    """
    sized = window[window["course"].isin(class_sizes)] if not window.empty else window
    per_course = sized.groupby("course")["person_key"].nunique() if not sized.empty else pd.Series(dtype=int)
    enrolled = int(sum(class_sizes.values()))
    suppressed = bool(((per_course > 0) & (per_course < min_cell)).any())
    active = int(per_course.sum())
    return {
        "active": None if suppressed else active,
        "enrolled": enrolled,
        "share": None if suppressed else (active / enrolled if enrolled else float("nan")),
        "suppressed": suppressed,
    }


def suppress_small_counts(table: pd.DataFrame, min_cell: int) -> pd.DataFrame:
    """
    Blank registered and active counts of 1 to `min_cell - 1` and the shares
    that come from them (the small-cell rule, ANLY-11). Zero is not blanked.
    """
    out = table.copy()
    for column, share in (("registered", "registered_share"), ("active", "active_share")):
        hide = (out[column] > 0) & (out[column] < min_cell)
        out[column] = out[column].astype("Int64").mask(hide)
        out.loc[hide, share] = np.nan
    return out


def adoption_totals(table: pd.DataFrame, min_cell: int = 0) -> dict:
    """
    Totals across courses for the headline (ANLY-11).

    `enrolled_total` sums the configured class sizes. The two shares count only
    courses that have one, so a course with no class size cannot inflate the
    numerator against a denominator that leaves it out. `registered_total` and
    `active_total` still count every course's users. A student in two courses
    counts once in each.

    Small cells: with `min_cell` set, a total is withheld (None, shares NaN)
    whenever any course in it has a count of 1 to `min_cell - 1`, since the
    total would otherwise give that count away. `registered_withheld` and
    `active_withheld` say which were withheld.
    """
    empty = table.empty
    sized = table[table["enrolled"].notna()] if not empty else table

    def small(frame: pd.DataFrame, column: str) -> bool:
        return bool(not frame.empty and ((frame[column] > 0) & (frame[column] < min_cell)).any())

    def total(frame: pd.DataFrame, column: str, hidden: bool):
        return None if hidden else (int(frame[column].sum()) if not frame.empty else 0)

    enrolled = int(sized["enrolled"].sum()) if not sized.empty else 0
    out = {"enrolled_total": enrolled}
    for column in ("registered", "active"):
        hide_all, hide_sized = small(table, column), small(sized, column)
        sized_total = total(sized, column, hide_sized)
        out[f"{column}_total"] = total(table, column, hide_all)
        out[f"{column}_sized"] = sized_total
        out[f"{column}_share"] = (
            sized_total / enrolled if sized_total is not None and enrolled else float("nan")
        )
        out[f"{column}_withheld"] = hide_all
    out["courses_without_class_size"] = [
        str(c) for c in (table.loc[table["enrolled"].isna(), "course"] if not empty else [])
    ]
    return out


def return_rate(sessions: pd.DataFrame) -> dict:
    """
    Of the students who used the bot at all, how many came back another day.

    Deliberately a pair of counts rather than a retention curve: with cohorts
    this size a curve implies a precision the data does not have.
    """
    if sessions.empty:
        return {"students": 0, "returned": 0, "share": float("nan"), "median_active_days": float("nan")}
    days = sessions.groupby("person_key")["date"].nunique()
    returned = int((days > 1).sum())
    return {
        "students": int(len(days)),
        "returned": returned,
        "share": returned / len(days) if len(days) else float("nan"),
        "median_active_days": float(days.median()),
    }


def weekly_activity(sessions: pd.DataFrame, by: str = "course") -> pd.DataFrame:
    """Sessions per week, split by course (or any other column)."""
    if sessions.empty:
        return pd.DataFrame(columns=["week", by, "sessions"])
    return (
        sessions.groupby(["week", by])
        .size()
        .reset_index(name="sessions")
        .sort_values(["week", by])
    )


def weekly_matrix(sessions: pd.DataFrame, config: Config | None = None, by: str = "course") -> pd.DataFrame:
    """
    Sessions per week, on a complete weekly index, with the between-terms gaps left empty.

    A week inside a term with no sessions is a real zero and is plotted as one.
    A week in July, when no course was running, is not zero — it is *nothing*,
    and filling it with zero draws a line across the summer that reads as a
    collapse in usage followed by a recovery. Those weeks stay NA so the line
    breaks instead.
    """
    config = config or CONFIG
    if sessions.empty:
        return pd.DataFrame()
    counts = (
        sessions.groupby(["week", by]).size().reset_index(name="sessions")
        .pivot(index="week", columns=by, values="sessions")
    )
    full_index = pd.date_range(counts.index.min(), counts.index.max(), freq="W-MON")
    full_index = full_index.union(counts.index)
    wide = counts.reindex(full_index)

    in_any_term = pd.Series(False, index=wide.index)
    for key in config.terms:
        first, last = config.window(key)
        inside = (wide.index.date >= first) & (wide.index.date <= last)
        # A term with no traffic at all in this data (a summer term the bot was
        # not used in) stays empty, so the line still breaks there.
        if not wide[inside].notna().any().any():
            continue
        in_any_term |= inside
    # Zero only where a term was actually running.
    for column in wide.columns:
        wide[column] = wide[column].where(~(in_any_term & wide[column].isna()), 0.0)
    wide.index.name = "week"
    return wide


def surface_split(
    sessions: pd.DataFrame, blanked_courses: Collection[str] = ()
) -> pd.DataFrame:
    """
    Sessions, prompts and distinct students per surface.

    `students` is None for a surface whose sessions include a course in
    `blanked_courses` (ANLY-11), so it cannot be used to bound a blanked count.
    """
    if sessions.empty:
        return pd.DataFrame(columns=["surface", "sessions", "prompts", "students"])
    out = (
        sessions.groupby("surface")
        .agg(
            sessions=("session_id", "count"),
            prompts=("prompts", "sum"),
            students=("person_key", "nunique"),
        )
        .reset_index()
        .sort_values("sessions", ascending=False)
    )
    if blanked_courses:
        touched = sessions[sessions["course"].isin(blanked_courses)]["surface"].unique()
        out["students"] = out["students"].astype(object).where(~out["surface"].isin(touched), None)
    return out


def distinct_students(
    frame: pd.DataFrame, min_cell: int, blanked_courses: Collection[str] = ()
) -> int | None:
    """
    Distinct students in `frame`, or None if the figure could give away a
    blanked cell (ANLY-11 small-cell rule).

    A count over several courses is withheld when any course in the frame is in
    `blanked_courses` (blanked in the adoption slides) or has a distinct count
    of 1 to `min_cell - 1` within this frame; otherwise subtracting the other
    courses' published counts would reveal that course's exact number.
    """
    if frame.empty:
        return 0
    per_course = frame.groupby("course")["person_key"].nunique()
    if (per_course.index.isin(list(blanked_courses))).any():
        return None
    if ((per_course > 0) & (per_course < min_cell)).any():
        return None
    return int(frame["person_key"].nunique())


def blanked_courses(table: pd.DataFrame, min_cell: int) -> set[str]:
    """Courses whose registered or active count in an adoption table is 1 to `min_cell - 1`."""
    if table.empty:
        return set()
    hide = ((table["registered"] > 0) & (table["registered"] < min_cell)) | (
        (table["active"] > 0) & (table["active"] < min_cell)
    )
    return {str(c) for c in table.loc[hide.fillna(False), "course"]}


def registrations_in_window(enrolments: pd.DataFrame, config: Config, term_key: str) -> pd.DataFrame:
    """
    Enrolments created inside a term's buffered window, so a later term never
    inherits earlier registrations. Shared by the term table and the adoption slide.
    """
    if enrolments.empty or "created_at" not in enrolments:
        return enrolments
    first, last = config.window(term_key)
    made = pd.to_datetime(enrolments["created_at"]).dt.date
    return enrolments[(made >= first) & (made <= last)]


def like_for_like_term(
    frame: pd.DataFrame, config: Config, term_key: str, elapsed_days: int
) -> pd.DataFrame:
    """
    One term's like-for-like window, taken from the single-term assignment so a
    session another term owns is not counted. The notebooks use this, not
    `like_for_like` on the raw sessions.
    """
    return like_for_like(
        term_sessions(frame, config, term_key),
        config.term(term_key),
        elapsed_days,
        ts_column="started_at",
        buffer_days=config.term_buffer_days,
    )


def hour_of_day(sessions: pd.DataFrame) -> pd.DataFrame:
    """
    When sessions start, by hour.

    Cheap to compute and it answers the question every audience asks about an
    always-on assistant: are students using it outside office hours?
    """
    if sessions.empty:
        return pd.DataFrame({"hour": range(24), "sessions": [0] * 24})
    counts = sessions["started_at"].dt.hour.value_counts().reindex(range(24), fill_value=0)
    return pd.DataFrame({"hour": counts.index, "sessions": counts.values})
