"""
Read both generations of the message log and reconcile them into one frame.

Bloombot's history spans two data models. Up to Fall 2026 it was a Python
Discord bot writing a peewee/SQLite database: `users` plus `messages` carrying
a Discord `category`, a `channel` and a `from`/`to` direction. From Fall 2026 it
is the TypeScript platform (`packages/db/src/schema.ts`): `people`, `courses`,
`conversations` and a `messages` table with `from_person`/`to_person`
directions, a `surface` (`discord` / `web` / `mcp`) and epoch-millisecond
timestamps.

`load_messages()` returns one tidy frame in the *unified* shape below, whichever
databases it was given:

    message_id  str   source-prefixed, unique across both databases
    ts          datetime64
    person_key  str   stable pseudonym, same person across both databases
    course      str   readable course name
    surface     str   'discord' | 'web' | 'mcp'
    category    str   Discord category, '' off Discord
    channel     str   Discord channel, '' off Discord
    channel_type str  'Global' | 'Students' | 'Teams' | 'Direct' | 'Other'
    direction   str   'from' (student → bot) | 'to' (bot → student)
    content     str
    source      str   'legacy' | 'current'

Two reconciliation hazards this module exists to handle:

1. **Double-counting.** `packages/legacy-import` may already have imported some
   or all of the Discord history into the current database. The same message
   would then appear in both files. `merge_messages()` deduplicates on a content
   fingerprint and keeps the current-database copy.
2. **Identity.** The same student is `users.discord_id` in the old database and
   a `people` row in the new one. They are joined through
   `person_identities` (`surface = 'discord'`, `external_id` = the Discord id);
   anyone who cannot be joined keeps their own key rather than being guessed at.
"""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pandas as pd

from .config import CONFIG, COURSE_MAP, Config

UNIFIED_COLUMNS = [
    "message_id",
    "ts",
    "person_key",
    "course",
    "surface",
    "category",
    "channel",
    "channel_type",
    "direction",
    "content",
    "source",
]


def _empty_unified() -> pd.DataFrame:
    frame = pd.DataFrame({c: pd.Series(dtype="object") for c in UNIFIED_COLUMNS})
    frame["ts"] = pd.Series(dtype="datetime64[ns]")
    return frame


def _connect(path: Path) -> sqlite3.Connection:
    """Open a database strictly read-only, so no analysis run can ever write to it."""
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def to_local(epoch_ms, config: Config | None = None) -> pd.Series:
    """
    Epoch milliseconds → naive local wall-clock time.

    The platform stores UTC milliseconds; the legacy bot stored naive local
    datetime strings. Without this conversion the same message written to both
    databases sits hours apart, the merge finds no duplicates at all, and every
    hour-of-day chart is wrong by the UTC offset.
    """
    config = config or CONFIG
    return (
        pd.to_datetime(epoch_ms, unit="ms", utc=True)
        .dt.tz_convert(config.display_timezone)
        .dt.tz_localize(None)
    )


def _has_table(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


# ── Derived dimensions ────────────────────────────────────────────────────


def course_from_category(category: str) -> str:
    """Discord categories are '<Course> - <SECTION>'; the prefix names the course."""
    prefix = (category or "").split(" - ")[0].strip()
    return COURSE_MAP.get(prefix, prefix or "Unknown")


def channel_type_from_category(category: str) -> str:
    """
    Classify a Discord category as a shared space or a private one.

    The suffix convention is the one `analytics.ipynb` established: a category
    ending GLOBAL is the whole-course space, STUDENT is a student's own private
    channel, TEAM is a project team's.
    """
    suffix = (category or "").split(" - ")[-1].upper() if " - " in (category or "") else ""
    if "GLOBAL" in suffix:
        return "Global"
    if "STUDENT" in suffix:
        return "Students"
    if "TEAM" in suffix:
        return "Teams"
    return "Other"


def semester_of(ts: pd.Timestamp) -> str:
    month, year = ts.month, ts.year
    if month <= 5:
        return f"Spring {year}"
    if month <= 8:
        return f"Summer {year}"
    return f"Fall {year}"


def fingerprint(person_key: str, ts, direction: str, content: str) -> str:
    """
    A content fingerprint stable across the two data models.

    Timestamps are truncated to the second because the import path rewrote
    millisecond precision, and content is hashed rather than compared directly
    so the key stays short and no message text ends up in an index.
    """
    stamp = pd.Timestamp(ts).floor("s").isoformat()
    digest = hashlib.sha1((content or "").strip().encode("utf-8")).hexdigest()[:16]
    return f"{person_key}|{stamp}|{direction}|{digest}"


# ── Legacy (pre-Fall-2026) database ───────────────────────────────────────


def load_legacy(path: Path | None = None) -> pd.DataFrame:
    """Read the peewee-era database into the unified shape. Missing file → empty frame."""
    path = Path(path or CONFIG.legacy_db)
    if not path.exists():
        return _empty_unified()

    conn = _connect(path)
    try:
        if not _has_table(conn, "messages"):
            return _empty_unified()
        raw = pd.read_sql_query(
            """
            SELECT m.id           AS legacy_id,
                   m.created_at   AS created_at,
                   m.content      AS content,
                   m.category     AS category,
                   m.channel      AS channel,
                   m.direction    AS direction,
                   u.discord_id   AS discord_id,
                   u.discord_username AS discord_username
            FROM messages m
            JOIN users u ON m.user_id = u.id
            """,
            conn,
        )
    finally:
        conn.close()

    if raw.empty:
        return _empty_unified()

    out = pd.DataFrame()
    out["message_id"] = "legacy:" + raw["legacy_id"].astype(str)
    out["ts"] = pd.to_datetime(raw["created_at"], format="mixed")
    # A legacy user with no Discord id (rare, but present) falls back to the
    # username so they are still one person rather than many.
    out["person_key"] = (
        "discord:" + raw["discord_id"].astype("Int64").astype(str)
    ).where(raw["discord_id"].notna(), "legacy-user:" + raw["discord_username"].astype(str))
    out["course"] = raw["category"].map(course_from_category)
    out["surface"] = "discord"
    out["category"] = raw["category"].fillna("")
    out["channel"] = raw["channel"].fillna("")
    out["channel_type"] = raw["category"].map(channel_type_from_category)
    out["direction"] = raw["direction"].map({"from": "from", "to": "to"}).fillna("from")
    out["content"] = raw["content"].fillna("")
    out["source"] = "legacy"
    out["handle"] = raw["discord_username"].fillna("")
    return out


# ── Current (Fall 2026 platform) database ─────────────────────────────────


def load_current(path: Path | None = None) -> pd.DataFrame:
    """
    Read the platform database into the unified shape.

    Soft-deleted conversations and people are excluded here rather than in the
    notebooks: a student who asked for their history to be removed stays out of
    every aggregate, and there is no code path that forgets to filter.
    """
    path = Path(path or CONFIG.current_db)
    if not path.exists():
        return _empty_unified()

    conn = _connect(path)
    try:
        if not _has_table(conn, "messages"):
            return _empty_unified()
        raw = pd.read_sql_query(
            """
            SELECT m.id            AS message_id,
                   m.created_at    AS created_at_ms,
                   m.content       AS content,
                   m.direction     AS direction,
                   m.surface       AS surface,
                   m.category_ref  AS category_ref,
                   m.channel_ref   AS channel_ref,
                   m.person_id     AS person_id,
                   c.title         AS course,
                   p.display_name  AS display_name,
                   pi.external_id  AS discord_id
            FROM messages m
            JOIN conversations cv ON cv.id = m.conversation_id
            JOIN courses c        ON c.id = m.course_id
            JOIN people p         ON p.id = m.person_id
            LEFT JOIN person_identities pi
                   ON pi.person_id = m.person_id AND pi.surface = 'discord'
            WHERE cv.deleted_at IS NULL
              AND p.deleted_at IS NULL
            """,
            conn,
        )
    finally:
        conn.close()

    if raw.empty:
        return _empty_unified()

    out = pd.DataFrame()
    out["message_id"] = "current:" + raw["message_id"].astype(str)
    out["ts"] = to_local(raw["created_at_ms"])
    # Joining on the Discord identity is what makes a student who used the bot
    # last year and again this fall one person rather than two.
    out["person_key"] = ("discord:" + raw["discord_id"].astype(str)).where(
        raw["discord_id"].notna(), "person:" + raw["person_id"].astype(str)
    )
    out["course"] = raw["course"].fillna("Unknown")
    out["surface"] = raw["surface"].fillna("discord")
    out["category"] = raw["category_ref"].fillna("")
    out["channel"] = raw["channel_ref"].fillna("")
    # Off Discord there are no categories or channels: web and MCP are a direct
    # one-to-one conversation, which is its own channel type rather than 'Other'.
    out["channel_type"] = [
        channel_type_from_category(cat) if surf == "discord" else "Direct"
        for cat, surf in zip(raw["category_ref"].fillna(""), out["surface"])
    ]
    out["direction"] = raw["direction"].map({"from_person": "from", "to_person": "to"})
    out["content"] = raw["content"].fillna("")
    out["source"] = "current"
    out["handle"] = raw["display_name"].fillna("")
    return out


# ── Merge ─────────────────────────────────────────────────────────────────


def merge_messages(
    legacy: pd.DataFrame, current: pd.DataFrame, config: Config | None = None
) -> tuple[pd.DataFrame, dict]:
    """
    Concatenate both generations, drop imported duplicates, drop excluded accounts.

    Returns the merged frame and a provenance dictionary the report prints
    verbatim — how many rows came from each database and how many were dropped
    as duplicates is exactly the kind of thing a reader should not have to take
    on trust.
    """
    config = config or CONFIG
    frames = [f for f in (legacy, current) if not f.empty]
    if not frames:
        return _empty_unified(), {
            "legacy_rows": 0,
            "current_rows": 0,
            "duplicates_dropped": 0,
            "excluded_account_rows": 0,
            "rows": 0,
        }

    merged = pd.concat(frames, ignore_index=True)
    merged["ts"] = pd.to_datetime(merged["ts"])

    legacy_rows = int((merged["source"] == "legacy").sum())
    current_rows = int((merged["source"] == "current").sum())

    # Prefer the current database's copy of any message present in both: it is
    # the one the platform will keep writing to, and its ids are the ones an
    # instructor sees in a transcript.
    merged["_fp"] = [
        fingerprint(pk, ts, d, c)
        for pk, ts, d, c in zip(
            merged["person_key"], merged["ts"], merged["direction"], merged["content"]
        )
    ]
    merged["_pref"] = (merged["source"] == "current").astype(int)
    merged = merged.sort_values(["_pref", "ts"], ascending=[False, True])
    before = len(merged)
    merged = merged.drop_duplicates(subset="_fp", keep="first")
    duplicates = before - len(merged)

    # Instructor and test accounts never count as student usage.
    handle = merged.get("handle", pd.Series([""] * len(merged), index=merged.index))
    excluded = handle.fillna("").str.lower().apply(
        lambda h: any(x in h for x in config.excluded_handles)
    )
    excluded_rows = int(excluded.sum())
    merged = merged[~excluded]

    merged = merged.drop(columns=["_fp", "_pref"]).sort_values("ts").reset_index(drop=True)
    merged["semester"] = merged["ts"].map(semester_of)
    merged["date"] = merged["ts"].dt.date
    merged["week"] = merged["ts"].dt.to_period("W").dt.start_time

    provenance = {
        "legacy_rows": legacy_rows,
        "current_rows": current_rows,
        "duplicates_dropped": int(duplicates),
        "excluded_account_rows": excluded_rows,
        "rows": len(merged),
        "first_message": merged["ts"].min() if len(merged) else None,
        "last_message": merged["ts"].max() if len(merged) else None,
    }
    return merged, provenance


def load_messages(config: Config | None = None) -> tuple[pd.DataFrame, dict]:
    """Load both databases and merge them. The one entry point the notebooks use."""
    config = config or CONFIG
    return merge_messages(
        load_legacy(config.legacy_db), load_current(config.current_db), config
    )


# ── Supporting tables (current database only) ─────────────────────────────


def load_enrolments(path: Path | None = None) -> pd.DataFrame:
    """
    Active enrolments per course — the denominator for adoption.

    Only the current database has enrolments; the legacy bot had no roster at
    all, so adoption rates can only be computed for courses that exist here.
    """
    path = Path(path or CONFIG.current_db)
    if not path.exists():
        return pd.DataFrame(columns=["course", "person_key", "source", "created_at"])

    conn = _connect(path)
    try:
        if not _has_table(conn, "enrolments"):
            return pd.DataFrame(columns=["course", "person_key", "source", "created_at"])
        raw = pd.read_sql_query(
            """
            SELECT c.title        AS course,
                   e.person_id    AS person_id,
                   e.source       AS source,
                   e.created_at   AS created_at_ms,
                   pi.external_id AS discord_id
            FROM enrolments e
            JOIN courses c ON c.id = e.course_id
            JOIN people p  ON p.id = e.person_id
            LEFT JOIN person_identities pi
                   ON pi.person_id = e.person_id AND pi.surface = 'discord'
            WHERE e.ended_at IS NULL AND p.deleted_at IS NULL
            """,
            conn,
        )
    finally:
        conn.close()

    if raw.empty:
        return pd.DataFrame(columns=["course", "person_key", "source", "created_at"])

    out = pd.DataFrame()
    out["course"] = raw["course"]
    out["person_key"] = ("discord:" + raw["discord_id"].astype(str)).where(
        raw["discord_id"].notna(), "person:" + raw["person_id"].astype(str)
    )
    out["source"] = raw["source"]
    out["created_at"] = to_local(raw["created_at_ms"])
    return out


def load_costs(path: Path | None = None) -> pd.DataFrame:
    """Model spend, in dollars, per surface and day. Only the current database has it."""
    path = Path(path or CONFIG.current_db)
    empty = pd.DataFrame(
        columns=["ts", "course", "surface", "model", "input_tokens", "output_tokens", "usd"]
    )
    if not path.exists():
        return empty

    conn = _connect(path)
    try:
        if not _has_table(conn, "cost_ledger_entries"):
            return empty
        raw = pd.read_sql_query(
            """
            SELECT l.created_at    AS created_at_ms,
                   l.model         AS model,
                   l.input_tokens  AS input_tokens,
                   l.output_tokens AS output_tokens,
                   l.cost_micros   AS cost_micros,
                   l.surface       AS surface,
                   c.title         AS course
            FROM cost_ledger_entries l
            LEFT JOIN courses c ON c.id = l.course_id
            """,
            conn,
        )
    finally:
        conn.close()

    if raw.empty:
        return empty

    out = pd.DataFrame()
    out["ts"] = to_local(raw["created_at_ms"])
    out["course"] = raw["course"].fillna("Unknown")
    out["surface"] = raw["surface"].fillna("unknown")
    out["model"] = raw["model"]
    out["input_tokens"] = raw["input_tokens"].fillna(0).astype(int)
    out["output_tokens"] = raw["output_tokens"].fillna(0).astype(int)
    # The ledger stores millionths of a dollar; the report speaks dollars.
    out["usd"] = raw["cost_micros"].fillna(0).astype(float) / 1_000_000.0
    return out
