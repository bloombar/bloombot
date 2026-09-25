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

from datetime import date

import numpy as np
import pandas as pd

from .config import CONFIG, Config, Term

SESSION_KEYS = ["person_key", "course", "surface"]


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
        out["session_id"] = pd.Series(dtype="object")
        return out

    gap = pd.Timedelta(minutes=gap_minutes)
    frame = messages.sort_values(SESSION_KEYS + ["ts"]).copy()
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
                "session_id", "person_key", "course", "surface", "channel_type",
                "started_at", "ended_at", "messages", "prompts", "replies",
                "duration_minutes", "date", "week", "semester",
            ]
        )

    grouped = tagged.groupby("session_id", sort=False)
    sessions = grouped.agg(
        person_key=("person_key", "first"),
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


def in_term(frame: pd.DataFrame, term: Term, ts_column: str = "ts") -> pd.DataFrame:
    """Rows falling inside a term's calendar span."""
    if frame.empty:
        return frame
    ts = pd.to_datetime(frame[ts_column])
    return frame[(ts.dt.date >= term.start) & (ts.dt.date <= term.end)]


def like_for_like(
    frame: pd.DataFrame, term: Term, elapsed_days: int, ts_column: str = "ts"
) -> pd.DataFrame:
    """
    The first `elapsed_days` of a term.

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
    return frame[(day_of_term >= 0) & (day_of_term <= elapsed_days)]


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


def adoption(sessions: pd.DataFrame, enrolments: pd.DataFrame) -> pd.DataFrame:
    """
    Per course: enrolled, used at least once, and the share.

    Adoption is the honest headline when volume is small — it has a denominator
    that means something, where a raw message count does not. Courses with no
    enrolment data (everything before Fall 2026) come back with `enrolled` as
    NA rather than zero, so they are visibly unmeasurable instead of silently
    reported as 0%.
    """
    if sessions.empty and enrolments.empty:
        return pd.DataFrame(columns=["course", "enrolled", "active", "share"])

    active = (
        sessions.groupby("course")["person_key"].nunique().rename("active")
        if not sessions.empty
        else pd.Series(dtype=int, name="active")
    )
    enrolled = (
        enrolments.groupby("course")["person_key"].nunique().rename("enrolled")
        if not enrolments.empty
        else pd.Series(dtype=int, name="enrolled")
    )
    out = pd.concat([enrolled, active], axis=1).reset_index().rename(columns={"index": "course"})
    out["active"] = out["active"].fillna(0).astype(int)
    out["enrolled"] = out["enrolled"].astype("Int64")
    out["share"] = np.where(
        out["enrolled"].notna() & (out["enrolled"] > 0),
        out["active"] / out["enrolled"].astype(float),
        np.nan,
    )
    return out.sort_values("course").reset_index(drop=True)


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
    for term in config.terms.values():
        in_any_term |= (wide.index.date >= term.start) & (wide.index.date <= term.end)
    # Zero only where a term was actually running.
    for column in wide.columns:
        wide[column] = wide[column].where(~(in_any_term & wide[column].isna()), 0.0)
    wide.index.name = "week"
    return wide


def surface_split(sessions: pd.DataFrame) -> pd.DataFrame:
    """Sessions, prompts and distinct students per surface."""
    if sessions.empty:
        return pd.DataFrame(columns=["surface", "sessions", "prompts", "students"])
    return (
        sessions.groupby("surface")
        .agg(
            sessions=("session_id", "count"),
            prompts=("prompts", "sum"),
            students=("person_key", "nunique"),
        )
        .reset_index()
        .sort_values("sessions", ascending=False)
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
