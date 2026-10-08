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
    role        str   'staff' | 'student' (ANLY-9), the sender's role in the message's course

Role (ANLY-9). A person is staff in a course when a web identity of theirs holds
an account (`person_identities.external_id` = `accounts.id`) with a
non-revoked `memberships` row in the message's organization, whatever its role
(owner, instructor, assistant). Membership of a *different* organization, or a
revoked one, does not count. `Config.staff_handles` is a manual override on top.
A database without `accounts`/`memberships` falls back to the handles alone.
Staff are kept in the frame, tagged, so they can be reported separately;
`Config.excluded_handles` (test rigs) are still dropped.

By default (ANLY-8) everything comes from ONE platform-schema file, `data/data.db`,
in which `packages/legacy-import` has already merged the old bot's history
(message ids `legacy-message-<hash>`, the original Discord category and channel
in `category_ref` / `channel_ref`). The older two-file arrangement is still
available as `input_mode='two-file'`.

Three reconciliation hazards this module exists to handle:

1. **Double-counting.** `packages/legacy-import` may already have imported some
   or all of the Discord history into the current database. The same message
   would then appear in both files. `merge_messages()` deduplicates on a content
   fingerprint and keeps the current-database copy.
2. **Identity.** The same student is `users.discord_id` in the old database and
   a `people` row in the new one. They are joined through
   `person_identities` (`surface = 'discord'`, `external_id` = the Discord id);
   anyone who cannot be joined keeps their own key rather than being guessed at.
3. **Labels.** An imported message sits in a platform course whose *title*
   ("Intro to Computer Programming (Summer 2025)") need not match what the old
   analysis called that course ("Introduction to Programming"). Imported
   messages are therefore labelled from their original Discord category, exactly
   as `load_legacy` labels them, so a legacy-period result is the same whichever
   file it came from and the same course lines up across terms. Native platform
   messages keep their course title.
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
    "role",
]


def _empty_unified() -> pd.DataFrame:
    frame = pd.DataFrame({c: pd.Series(dtype="object") for c in UNIFIED_COLUMNS})
    frame["ts"] = pd.Series(dtype="datetime64[ns]")
    return frame


# Prefix of every message id `packages/legacy-import` mints (ids.ts:
# `deterministicId('legacy-message', …)`), which is how an imported message is
# told apart from one the platform recorded itself.
IMPORTED_PREFIX = "legacy-message-"


def _connect(path: Path) -> sqlite3.Connection:
    """
    Open a database strictly read-only and return an in-memory copy of it.

    The file is opened `mode=ro` with ordinary locking, so SQLite sees any rows
    still in a `-wal` file and never reads a half-written page, then copied into
    memory and closed. Nothing is written to the source (SQLite may create its
    own `-wal`/`-shm` bookkeeping files beside a WAL-mode database, which is
    harmless) and no temporary files are made anywhere. The copy is the whole
    database, which is small beside the memory of a machine running the analysis.
    """
    source = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        memory = sqlite3.connect(":memory:")
        source.backup(memory)
    finally:
        source.close()
    return memory


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


def _course_labels(conn: sqlite3.Connection) -> dict[str, str]:
    """
    One analysis label per platform course (ANLY-8), used for messages,
    enrolments and costs alike so a join on course never splits.

    A course that holds imported legacy messages is named by what the old
    analysis called those messages' Discord categories ("Introduction to
    Programming"), whatever the course is titled on the platform ("Intro to
    Computer Programming"); the most common such label wins. Any other course
    keeps its title.
    """
    rows = conn.execute(
        "SELECT course_id, category_ref, COUNT(*) FROM messages "
        "WHERE id LIKE ? AND category_ref IS NOT NULL AND category_ref <> '' "
        "GROUP BY course_id, category_ref",
        (IMPORTED_PREFIX + "%",),
    ).fetchall()
    tally: dict[str, dict[str, int]] = {}
    for course_id, category, n in rows:
        label = course_from_category(category)
        tally.setdefault(course_id, {})[label] = tally.get(course_id, {}).get(label, 0) + n
    labels = {
        cid: sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        for cid, counts in tally.items()
    }
    for course_id, title in conn.execute("SELECT id, title FROM courses"):
        labels.setdefault(course_id, title)
    return labels


def _has_table(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def _staff_pairs(conn: sqlite3.Connection) -> set[tuple[str, str]]:
    """
    (person_id, organization_id) pairs that are staff by membership (ANLY-9).

    A person's web identity names an account; that account must hold an active
    membership in the same organization the message belongs to. Older files
    without the account tables yield an empty set, so the role then rests on the
    handle override alone.
    """
    if not (_has_table(conn, "accounts") and _has_table(conn, "memberships")):
        return set()
    rows = conn.execute(
        """
        SELECT DISTINCT pi.person_id, mb.organization_id
        FROM person_identities pi
        JOIN accounts a     ON a.id = pi.external_id
        JOIN memberships mb ON mb.account_id = a.id
        WHERE pi.surface = 'web' AND mb.revoked_at IS NULL
        """
    ).fetchall()
    return {(person, org) for person, org in rows}


# ── Derived dimensions ────────────────────────────────────────────────────


# COURSE_MAP keyed case-insensitively (ANLY-8): `PYTHON - SUMMER 2025` is the
# same course as `Python - GLOBAL`.
_COURSE_MAP_FOLDED = {k.casefold(): v for k, v in COURSE_MAP.items()}


def _text(value) -> str:
    """
    A string, or '' for anything that is not one.

    A NULL column arrives as `None` in some pandas versions and as float `NaN`
    (which is truthy) in others, so `value or ""` is not a safe guard.
    """
    return value if isinstance(value, str) else ""


def course_from_category(category: str) -> str:
    """Discord categories are '<Course> - <SECTION>'; the prefix names the course."""
    prefix = _text(category).split(" - ")[0].strip()
    return _COURSE_MAP_FOLDED.get(prefix.casefold(), prefix or "Unknown")


def channel_type_from_category(category: str) -> str:
    """
    Classify a Discord category as a shared space or a private one.

    The suffix convention is the one `analytics.ipynb` established: a category
    ending GLOBAL is the whole-course space, STUDENT is a student's own private
    channel, TEAM is a project team's.
    """
    category = _text(category)
    suffix = category.split(" - ")[-1].upper() if " - " in category else ""
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
    digest = hashlib.sha1(_text(content).strip().encode("utf-8")).hexdigest()[:16]
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
    # The legacy bot kept no roles. Staff among these rows are found later, in
    # `merge_messages`, from the handles and from the current database's staff.
    out["role"] = "student"
    return out


# ── Current (Fall 2026 platform) database ─────────────────────────────────


def load_current(path: Path | None = None) -> pd.DataFrame:
    """
    Read the platform database into the unified shape.

    Soft-deleted conversations and people are excluded here rather than in the
    notebooks: a student who asked for their history to be removed stays out of
    every aggregate, and there is no code path that forgets to filter.
    """
    path = Path(path or CONFIG.platform_db)
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
                   m.organization_id AS organization_id,
                   m.course_id     AS course_id,
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
        labels = _course_labels(conn)
        staff = _staff_pairs(conn)
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
    # One label per course (see `_course_labels`). An imported legacy message is
    # labelled from its own original Discord category, exactly as `load_legacy`
    # does (ANLY-8); with no category recorded it falls back to its course's label.
    imported = raw["message_id"].astype(str).str.startswith(IMPORTED_PREFIX)
    course_label = raw["course_id"].map(labels).fillna(raw["course"]).fillna("Unknown")
    has_category = raw["category_ref"].fillna("") != ""
    out["course"] = course_label.where(
        ~(imported & has_category), raw["category_ref"].map(course_from_category)
    )
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
    # ANLY-9. Decided on the person and organization, before `person_key` folds
    # a Discord id and a person id together, so the role cannot be lost there.
    out["role"] = [
        "staff" if (person, org) in staff else "student"
        for person, org in zip(raw["person_id"], raw["organization_id"])
    ]
    return out


# ── Merge ─────────────────────────────────────────────────────────────────


def merge_messages(
    legacy: pd.DataFrame,
    current: pd.DataFrame,
    config: Config | None = None,
    dedupe: str = "fingerprint",
) -> tuple[pd.DataFrame, dict]:
    """
    Concatenate both generations, drop imported duplicates and test accounts, tag staff.

    `dedupe='fingerprint'` (two-file mode) matches the same message across the
    two databases by person, second, direction and text. `dedupe='id'` (one
    database) only drops a repeated message id: within a single database two
    rows with different ids are two messages, even if the text is the same.

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
            "staff_rows": 0,
            "student_rows": 0,
            "rows": 0,
        }

    merged = pd.concat(frames, ignore_index=True)
    merged["ts"] = pd.to_datetime(merged["ts"])

    legacy_rows = int((merged["source"] == "legacy").sum())
    current_rows = int((merged["source"] == "current").sum())

    # Prefer the current database's copy of any message present in both: it is
    # the one the platform will keep writing to, and its ids are the ones an
    # instructor sees in a transcript.
    if dedupe == "id":
        merged["_fp"] = merged["message_id"]
    else:
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

    handle = merged.get("handle", pd.Series([""] * len(merged), index=merged.index))
    handle = handle.fillna("").str.lower()

    # Test rigs are dropped outright (ANLY-9: only these; staff are kept).
    excluded = handle.apply(lambda h: any(x in h for x in config.excluded_handles))
    excluded_rows = int(excluded.sum())
    merged = merged[~excluded]
    handle = handle[~excluded]

    # Staff (ANLY-9). `role` is set from memberships by `load_current`; here the
    # handle override adds to it, and a legacy message (which has no membership
    # to read) is staff when its person_key is a staff person in the current
    # database. Only legacy rows are promoted this way: a current row's role is
    # already organization-specific and must not be overridden by another's.
    if "role" not in merged:
        merged["role"] = "student"
    merged["role"] = merged["role"].fillna("student")
    by_handle = handle.apply(lambda h: any(x in h for x in config.staff_handles))
    merged.loc[by_handle, "role"] = "staff"
    staff_keys = set(merged.loc[merged["role"] == "staff", "person_key"])
    legacy_of_staff = (merged["source"] == "legacy") & merged["person_key"].isin(staff_keys)
    merged.loc[legacy_of_staff, "role"] = "staff"
    staff_rows = int((merged["role"] == "staff").sum())

    merged = merged.drop(columns=["_fp", "_pref"]).sort_values("ts").reset_index(drop=True)
    merged["semester"] = merged["ts"].map(semester_of)
    merged["date"] = merged["ts"].dt.date
    merged["week"] = merged["ts"].dt.to_period("W").dt.start_time

    provenance = {
        "legacy_rows": legacy_rows,
        "current_rows": current_rows,
        "duplicates_dropped": int(duplicates),
        "excluded_account_rows": excluded_rows,
        "staff_rows": staff_rows,
        "student_rows": len(merged) - staff_rows,
        "rows": len(merged),
        "first_message": merged["ts"].min() if len(merged) else None,
        "last_message": merged["ts"].max() if len(merged) else None,
    }
    return merged, provenance


def load_messages(config: Config | None = None) -> tuple[pd.DataFrame, dict]:
    """
    Load the messages and tidy them. The one entry point the notebooks use.

    Combined mode (ANLY-8, the default) reads the single platform-schema file;
    nothing can be double-counted, so only a repeated message id is dropped (never
    a look-alike by text), and the provenance says how many of its rows were
    imported from the legacy bot. Two-file mode
    loads both generations and reconciles them as before.
    """
    config = config or CONFIG
    if config.input_mode == "combined":
        current = load_current(config.combined_db)
        merged, provenance = merge_messages(_empty_unified(), current, config, dedupe="id")
        provenance["input_mode"] = "combined"
        provenance["imported_legacy_rows"] = int(
            current["message_id"].str.startswith("current:" + IMPORTED_PREFIX).sum()
        ) if len(current) else 0
        return merged, provenance
    return merge_messages(
        load_legacy(config.legacy_db), load_current(config.current_db), config
    )


# ── Supporting tables (current database only) ─────────────────────────────


def load_enrolments(path: Path | None = None) -> pd.DataFrame:
    """
    Active student enrolments per course — the denominator for adoption (staff left out).

    Only the current database has enrolments; the legacy bot had no roster at
    all, so adoption rates can only be computed for courses that exist here.
    """
    path = Path(path or CONFIG.platform_db)
    if not path.exists():
        return pd.DataFrame(columns=["course", "person_key", "source", "created_at"])

    conn = _connect(path)
    try:
        if not _has_table(conn, "enrolments"):
            return pd.DataFrame(columns=["course", "person_key", "source", "created_at"])
        raw = pd.read_sql_query(
            """
            SELECT c.title        AS course,
                   e.course_id    AS course_id,
                   e.person_id    AS person_id,
                   e.organization_id AS organization_id,
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
        labels = _course_labels(conn)
        staff = _staff_pairs(conn)
    finally:
        conn.close()

    # ANLY-9: enrolled staff are not students, so they are left out of the
    # adoption denominator as well as its numerator.
    raw = raw[[(p, o) not in staff for p, o in zip(raw["person_id"], raw["organization_id"])]]
    if raw.empty:
        return pd.DataFrame(columns=["course", "person_key", "source", "created_at"])

    out = pd.DataFrame()
    out["course"] = raw["course_id"].map(labels).fillna(raw["course"])
    out["person_key"] = ("discord:" + raw["discord_id"].astype(str)).where(
        raw["discord_id"].notna(), "person:" + raw["person_id"].astype(str)
    )
    out["source"] = raw["source"]
    out["created_at"] = to_local(raw["created_at_ms"])
    return out


def load_costs(path: Path | None = None) -> pd.DataFrame:
    """Model spend, in dollars, per surface and day. Only the current database has it."""
    path = Path(path or CONFIG.platform_db)
    empty = pd.DataFrame(
        columns=["ts", "course", "surface", "model", "input_tokens", "output_tokens", "usd", "role"]
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
                   l.course_id     AS course_id,
                   l.person_id     AS person_id,
                   l.organization_id AS organization_id,
                   c.title         AS course
            FROM cost_ledger_entries l
            LEFT JOIN courses c ON c.id = l.course_id
            """,
            conn,
        )
        labels = _course_labels(conn)
        staff = _staff_pairs(conn)
    finally:
        conn.close()

    if raw.empty:
        return empty

    out = pd.DataFrame()
    out["ts"] = to_local(raw["created_at_ms"])
    out["course"] = raw["course_id"].map(labels).fillna(raw["course"]).fillna("Unknown")
    out["surface"] = raw["surface"].fillna("unknown")
    out["model"] = raw["model"]
    out["input_tokens"] = raw["input_tokens"].fillna(0).astype(int)
    out["output_tokens"] = raw["output_tokens"].fillna(0).astype(int)
    # The ledger stores millionths of a dollar; the report speaks dollars.
    out["usd"] = raw["cost_micros"].fillna(0).astype(float) / 1_000_000.0
    # ANLY-9: spend is split by the role of whoever caused it, so a cost per
    # student is not inflated by staff demonstrations. An entry with no person
    # is not provably staff and counts as student.
    out["role"] = [
        "staff" if (p, o) in staff else "student"
        for p, o in zip(raw["person_id"], raw["organization_id"])
    ]
    return out
