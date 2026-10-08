"""
Tests for the usage-report analysis library (`analysis/bloombot_analysis`).

These cover the decisions that would be invisible if they were wrong: the two
databases being reconciled into one dataset, what counts as a session, the
like-for-like truncation that keeps an in-progress term from being compared
against a finished one, and the privacy rules on published output. Each one is
a rule a reader of the report is trusting; a wrong answer here does not crash a
notebook, it just prints a plausible wrong number.
"""

import json
import os
import sqlite3
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "analysis"))

from bloombot_analysis import load, privacy, report, sessions, topics  # noqa: E402
from bloombot_analysis.config import Config, Term  # noqa: E402
from bloombot_analysis.mock_schemas import CURRENT_DDL, LEGACY_DDL  # noqa: E402


# ── Fixtures: two tiny databases holding the same conversation ────────────


@pytest.fixture
def legacy_db(tmp_path: Path) -> Path:
    """A pre-Fall-2026 database: one student, two messages, local-time strings."""
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.executescript(LEGACY_DDL)
    conn.execute(
        "INSERT INTO users VALUES (1,'2025-09-01 08:00:00','2025-09-01 08:00:00',"
        "555,'stu001','stu001@example.edu','Last','First','stu001')"
    )
    conn.executemany(
        "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)",
        [
            (1, "2025-09-10 14:00:00", "2025-09-10 14:00:00", "when is hw2 due",
             "Python - GLOBAL", "general", "from", 1),
            (2, "2025-09-10 14:00:05", "2025-09-10 14:00:05", "Friday at 5pm.",
             "Python - GLOBAL", "general", "to", 1),
        ],
    )
    conn.commit()
    conn.close()
    return path


def _current_db(tmp_path: Path, rows, deleted_conversation: bool = False) -> Path:
    path = tmp_path / "current.db"
    conn = sqlite3.connect(path)
    conn.executescript(CURRENT_DDL)
    conn.execute("INSERT INTO organizations VALUES ('org','Org',0)")
    conn.execute("INSERT INTO courses VALUES ('crs','org','prj','Introduction to Programming',1,0)")
    conn.execute(
        "INSERT INTO people VALUES ('per','org','stu001','stu001@example.edu',"
        "'First','Last','stu001',0,NULL,NULL,NULL,NULL,0)"
    )
    conn.execute("INSERT INTO person_identities VALUES ('pid','org','per','discord','555',0)")
    conn.execute(
        "INSERT INTO conversations VALUES ('cnv','org','crs','per','discord',NULL,?,NULL,0,0)",
        (1 if deleted_conversation else None,),
    )
    conn.executemany("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    conn.commit()
    conn.close()
    return path


def _ms(when: datetime, tz: str = "America/New_York") -> int:
    """Wall-clock local time → the epoch milliseconds the platform would store."""
    return int(pd.Timestamp(when).tz_localize(tz).timestamp() * 1000)


def _config(tmp_path: Path, legacy: Path | None, current: Path | None, **kwargs) -> Config:
    kwargs.setdefault("input_mode", "two-file")
    return Config(
        legacy_db=legacy or tmp_path / "missing-legacy.db",
        current_db=current or tmp_path / "missing-current.db",
        topic_cache=tmp_path / "topics.json",
        out_dir=tmp_path / "out",
        **kwargs,
    )


# ── Merging the two generations ───────────────────────────────────────────


def test_imported_history_is_counted_once(tmp_path, legacy_db):
    """The same message in both databases is one message, kept from the current one."""
    current = _current_db(
        tmp_path,
        [
            ("m1", "org", "cnv", "per", "crs", "from_person", "when is hw2 due", "discord",
             "general", "Python - GLOBAL", 1, _ms(datetime(2025, 9, 10, 14, 0))),
            ("m2", "org", "cnv", "per", "crs", "to_person", "Friday at 5pm.", "discord",
             "general", "Python - GLOBAL", 2, _ms(datetime(2025, 9, 10, 14, 0, 5))),
        ],
    )
    config = _config(tmp_path, legacy_db, current)
    merged, provenance = load.merge_messages(
        load.load_legacy(config.legacy_db), load.load_current(config.current_db), config
    )
    assert provenance["duplicates_dropped"] == 2
    assert len(merged) == 2
    assert set(merged["source"]) == {"current"}


def test_timestamps_from_both_generations_align(tmp_path, legacy_db):
    """
    Epoch milliseconds are read as local wall-clock time.

    Without the conversion the platform's UTC timestamp lands hours away from
    the legacy bot's naive local string, no duplicate is ever detected, and
    every hour-of-day number is wrong by the UTC offset.
    """
    current = _current_db(
        tmp_path,
        [
            ("m1", "org", "cnv", "per", "crs", "from_person", "when is hw2 due", "discord",
             "general", "Python - GLOBAL", 1, _ms(datetime(2025, 9, 10, 14, 0))),
        ],
    )
    frame = load.load_current(current)
    assert frame["ts"].iloc[0] == pd.Timestamp("2025-09-10 14:00:00")


def test_cutover_messages_survive_the_merge(tmp_path, legacy_db):
    """History the importer never carried across is still in the dataset."""
    current = _current_db(
        tmp_path,
        [
            ("m1", "org", "cnv", "per", "crs", "from_person", "a later question", "web",
             None, None, 1, _ms(datetime(2026, 9, 3, 10, 0))),
        ],
    )
    config = _config(tmp_path, legacy_db, current)
    merged, provenance = load.merge_messages(
        load.load_legacy(config.legacy_db), load.load_current(config.current_db), config
    )
    assert provenance["duplicates_dropped"] == 0
    assert len(merged) == 3
    assert set(merged["surface"]) == {"discord", "web"}


def test_deleted_conversations_never_load(tmp_path):
    """A student who asked for their history to be removed is out of every aggregate."""
    current = _current_db(
        tmp_path,
        [
            ("m1", "org", "cnv", "per", "crs", "from_person", "hello", "web",
             None, None, 1, _ms(datetime(2026, 9, 3, 10, 0))),
        ],
        deleted_conversation=True,
    )
    assert load.load_current(current).empty


def test_excluded_accounts_are_dropped(tmp_path):
    """Instructor and test accounts are not student usage."""
    frame = pd.DataFrame(
        {
            "message_id": ["a", "b"],
            "ts": pd.to_datetime(["2026-09-03 10:00", "2026-09-03 10:01"]),
            "person_key": ["discord:1", "discord:2"],
            "course": ["Web Design"] * 2,
            "surface": ["web"] * 2,
            "category": [""] * 2,
            "channel": [""] * 2,
            "channel_type": ["Direct"] * 2,
            "direction": ["from", "from"],
            "content": ["hi", "hi"],
            "source": ["current"] * 2,
            "handle": ["student042", "instructor"],
        }
    )
    merged, provenance = load.merge_messages(frame.iloc[:0], frame, Config())
    assert provenance["excluded_account_rows"] == 1
    assert list(merged["person_key"]) == ["discord:1"]


# ── Sessions ──────────────────────────────────────────────────────────────


def _messages(times, person="discord:1", course="Web Design", surface="web"):
    return pd.DataFrame(
        {
            "message_id": [f"m{i}" for i in range(len(times))],
            "ts": pd.to_datetime(times),
            "person_key": person,
            "course": course,
            "surface": surface,
            "channel_type": "Direct",
            "direction": ["from"] * len(times),
            "content": ["a question"] * len(times),
            "source": "current",
        }
    )


def test_a_gap_longer_than_the_threshold_starts_a_new_session():
    frame = _messages(
        ["2026-09-10 10:00", "2026-09-10 10:20", "2026-09-10 11:30"]
    )
    result = sessions.session_frame(frame, gap_minutes=30)
    assert len(result) == 2
    assert sorted(result["prompts"]) == [1, 2]


def test_two_students_never_share_a_session():
    frame = pd.concat(
        [
            _messages(["2026-09-10 10:00"], person="discord:1"),
            _messages(["2026-09-10 10:01"], person="discord:2"),
        ],
        ignore_index=True,
    )
    assert len(sessions.session_frame(frame, gap_minutes=30)) == 2


def test_bot_only_traffic_is_not_a_session():
    frame = _messages(["2026-09-10 10:00"])
    frame["direction"] = "to"
    assert sessions.session_frame(frame).empty


def test_like_for_like_truncates_both_terms_to_the_same_span():
    """
    The correction the year-over-year comparison depends on.

    Without it, three weeks of an in-progress term are compared against a full
    prior term, and the report describes the calendar rather than behaviour.
    """
    term = Term("fall_2026", "Fall 2026", date(2026, 9, 2), date(2026, 12, 15))
    frame = _messages(["2026-09-03 10:00", "2026-09-20 10:00", "2026-11-01 10:00"])
    window = sessions.like_for_like(frame, term, elapsed_days=23)
    assert len(window) == 2


def test_term_completeness_reports_a_partial_term():
    config = Config(as_of=date(2026, 9, 25))
    completeness = sessions.term_completeness(config)
    assert completeness["elapsed_days"] == 23
    assert 0 < completeness["fraction_elapsed"] < 1
    assert completeness["comparison_window_end"] == date(2025, 9, 26)


def test_adoption_is_unmeasurable_without_enrolments():
    """A course with no roster comes back as NA, never as a silent 0%."""
    session_rows = sessions.session_frame(_messages(["2026-09-10 10:00"]))
    result = sessions.adoption(session_rows, pd.DataFrame(columns=["course", "person_key"]))
    assert result.loc[0, "active"] == 1
    assert pd.isna(result.loc[0, "share"])


def test_weekly_matrix_leaves_the_summer_empty():
    """Weeks with no term running stay NA, so the line breaks instead of sloping."""
    config = Config()
    frame = _messages(["2025-09-10 10:00", "2026-09-10 10:00"])
    wide = sessions.weekly_matrix(sessions.session_frame(frame), config)
    july = wide[(wide.index >= "2026-07-01") & (wide.index < "2026-08-01")]
    assert july.isna().all().all()


def test_gap_sensitivity_reports_every_threshold():
    frame = _messages(["2026-09-10 10:00", "2026-09-10 10:45"])
    result = sessions.gap_sensitivity(frame, gaps=(15, 30, 60))
    assert list(result["gap_minutes"]) == [15, 30, 60]
    assert list(result["sessions"]) == [2, 2, 1]


# ── Topics ────────────────────────────────────────────────────────────────


def test_keyword_classifier_reads_the_students_words_not_the_bots():
    """
    The bot's replies mention syllabus, deadlines and tools whatever was asked.

    Classifying the whole transcript drags nearly every session toward whichever
    topics the reply templates happen to name, which is why `student_text`
    exists.
    """
    tagged = pd.DataFrame(
        {
            "session_id": ["s1", "s1"],
            "course": ["Web Design"] * 2,
            "ts": pd.to_datetime(["2026-09-10 10:00", "2026-09-10 10:01"]),
            "direction": ["from", "to"],
            "content": [
                "can you explain what a closure is",
                "The syllabus covers this; the deadline is Friday.",
            ],
        }
    )
    texts = topics.session_texts(tagged)
    labelled = topics.classify_sessions(texts, method="keyword", use_cache=False)
    assert labelled.loc[0, "topic"] == "Course material & content"


def test_topic_cache_is_keyed_by_content_not_position(tmp_path):
    """Re-sessionising must not silently invalidate every cached label."""
    config = _config(tmp_path, None, None)
    texts = pd.DataFrame(
        {"session_id": ["s1"], "course": ["Web Design"], "text": ["Student: when is hw2 due"],
         "student_text": ["when is hw2 due"]}
    )
    topics.classify_sessions(texts, method="keyword", config=config)
    cache = topics.load_cache(config.topic_cache)
    assert list(cache) == [f"keyword:{topics.text_key('when is hw2 due')}"]

    renumbered = texts.assign(session_id=["s99"])
    again = topics.classify_sessions(renumbered, method="keyword", config=config)
    assert again.loc[0, "topic_method"] == "keyword-cached"


def test_agreement_rate_ignores_unaudited_rows():
    audited = pd.DataFrame(
        {
            "topic": ["Assignments & homework", "Other", "Other"],
            "hand_label": ["Assignments & homework", "Course material & content", ""],
        }
    )
    assert topics.agreement_rate(audited) == {"checked": 2, "agreed": 1, "rate": 0.5}


# ── Privacy ───────────────────────────────────────────────────────────────


def test_small_cells_are_suppressed():
    values = pd.DataFrame({"Web Design": [9.0, 4.0]}, index=["Assignments", "Grades"])
    students = pd.DataFrame({"Web Design": [7, 2]}, index=["Assignments", "Grades"])
    published = privacy.suppress_small_cells(values, students, Config(min_cell_students=5))
    assert published.loc["Assignments", "Web Design"] == 9
    assert pd.isna(published.loc["Grades", "Web Design"])
    assert "1 of 2 cells are suppressed" in privacy.suppression_note(values, published)


def test_quotes_are_scrubbed_of_identifiers():
    scrubbed = privacy.redact_quote(
        "hi <@123456789> email me at sam.lee@example.edu or see https://x.test/abc 987654321"
    )
    assert "sam.lee@example.edu" not in scrubbed
    assert "123456789" not in scrubbed
    assert "https://" not in scrubbed
    assert "[email]" in scrubbed and "[link]" in scrubbed


def test_pseudonyms_replace_person_keys():
    frame = _messages(["2026-09-10 10:00"])
    mapping = privacy.pseudonyms(frame)
    anonymous = privacy.apply_pseudonyms(frame, mapping)
    assert list(anonymous["person_key"]) == ["Student 01"]


# ── Report structure ──────────────────────────────────────────────────────


def test_report_renders_the_structure_the_deck_is_parsed_from():
    doc = report.Report(title="Usage", subtitle="test")
    doc.part("Findings")
    doc.slide(
        "Adoption",
        takeaway="24 of 124 students used it.",
        figure=Path("/tmp/figures/adoption.png"),
        figure_caption="n = 24 students.",
        table="| a |\n| --- |\n| 1 |",
        notes="Say the n out loud.",
        confidence="indicative",
    )
    rendered = doc.render()
    assert "# Part — Findings" in rendered
    assert "## S01 · Adoption" in rendered
    assert "![Adoption](figures/adoption.png)" in rendered
    assert "**Confidence:** indicative" in rendered


def test_report_refuses_an_unknown_confidence_level():
    """The field is machine-read, so a typo must fail rather than ship."""
    doc = report.Report(title="Usage")
    doc.part("Findings")
    with pytest.raises(ValueError):
        doc.slide("Adoption", confidence="pretty sure")


def test_small_denominators_are_reported_as_counts():
    assert report.fmt_count_of(4, 21) == "4 of 21"
    assert report.fmt_count_of(24, 124) == "24 of 124 (19%)"
    assert report.fmt_count_of(3, None) == "3 (denominator unknown)"


# ── The combined database (ANLY-8) ────────────────────────────────────────


@pytest.fixture(scope="module")
def mock_dbs(tmp_path_factory) -> Path:
    """The synthetic legacy, current and combined databases, generated once."""
    out = tmp_path_factory.mktemp("mock")
    subprocess.run(
        [sys.executable, str(REPO_ROOT / "analysis" / "mock" / "make_mock_data.py"), "--out", str(out)],
        check=True,
        capture_output=True,
    )
    return out


def _mock_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "make_mock_data", REPO_ROOT / "analysis" / "mock" / "make_mock_data.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses looks the module up by name
    spec.loader.exec_module(module)
    return module


def _forgotten_keys(combined_db: Path) -> set[str]:
    """Person keys soft-deleted on the platform; the legacy file knows nothing of them."""
    return {
        f"discord:{r[0]}"
        for r in sqlite3.connect(combined_db).execute(
            "SELECT pi.external_id FROM people p JOIN person_identities pi "
            "ON pi.person_id = p.id WHERE p.deleted_at IS NOT NULL"
        )
    }


def test_imported_messages_label_exactly_like_the_legacy_loader(mock_dbs):
    """
    The core ANLY-8 guarantee: a legacy message read back out of the combined
    database carries the same labels as the same message read from the legacy
    file, whatever course title the importer filed it under.
    """
    mock = _mock_module()
    legacy = load.load_legacy(mock_dbs / "legacy.db")
    legacy["key"] = legacy["message_id"].str.replace("legacy:", "").astype(int).map(
        lambda i: mock.imported_message_id(mock.ORG_ID, i)
    )
    combined = load.load_current(mock_dbs / "combined.db")
    combined["key"] = combined["message_id"].str.replace("current:", "")

    joined = legacy.merge(combined, on="key", suffixes=("_l", "_c"), validate="one_to_one")
    # Every legacy message is found, except a soft-deleted person's (loader rule).
    forgotten = _forgotten_keys(mock_dbs / "combined.db")
    assert forgotten
    missing = legacy[~legacy["key"].isin(joined["key"])]
    assert set(missing["person_key"]) <= forgotten
    assert len(joined) > 1000
    for column in ("person_key", "course", "category", "channel", "channel_type", "direction", "content"):
        assert (joined[f"{column}_l"] == joined[f"{column}_c"]).all(), column
    assert (joined["ts_l"].dt.floor("s") == joined["ts_c"].dt.floor("s")).all()
    assert (
        joined["ts_l"].map(load.semester_of) == joined["ts_c"].map(load.semester_of)
    ).all()
    # The import really did file them under titles the analysis does not use.
    titles = {
        r[0]
        for r in sqlite3.connect(mock_dbs / "combined.db").execute("SELECT title FROM courses")
    }
    assert "Introduction to Programming (Fall 2025)" in titles


def test_combined_mode_reads_one_file_and_reports_the_import(mock_dbs):
    config = Config(
        input_mode="combined",
        combined_db=mock_dbs / "combined.db",
        topic_cache=mock_dbs / "topics.json",
        out_dir=mock_dbs / "out",
    )
    merged, provenance = load.load_messages(config)
    assert provenance["input_mode"] == "combined"
    assert provenance["duplicates_dropped"] == 0
    assert provenance["imported_legacy_rows"] == int(
        merged["message_id"].str.startswith("current:legacy-message-").sum()
    ) > 1000
    # Courses from both eras use one name each: no "(Fall 2025)" copies.
    assert not any("(" in c for c in merged["course"].unique())
    # Native web and assistant traffic comes through alongside the Discord history.
    assert {"discord", "web", "mcp"} <= set(merged["surface"])


def test_combined_mode_matches_the_two_file_run_on_the_same_history(mock_dbs):
    """Two routes to the same history give the same per-course, per-semester counts."""
    base = dict(topic_cache=mock_dbs / "topics.json", out_dir=mock_dbs / "out")
    combined, _ = load.load_messages(
        Config(input_mode="combined", combined_db=mock_dbs / "combined.db", **base)
    )
    two_file, _ = load.load_messages(
        Config(
            input_mode="two-file",
            legacy_db=mock_dbs / "legacy.db",
            current_db=mock_dbs / "current.db",
            **base,
        )
    )
    # The one legitimate difference: a person soft-deleted on the platform stays
    # in the legacy file, which knows nothing of deletions. The combined file
    # holds their imported history too, so it is dropped there. Leave them out
    # of the comparison and every other message must agree.
    forgotten = _forgotten_keys(mock_dbs / "combined.db")
    assert forgotten
    two_file = two_file[~two_file["person_key"].isin(forgotten)]
    key = ["course", "semester"]
    assert combined.groupby(key).size().equals(two_file.groupby(key).size())


def test_course_names_ignore_the_case_of_the_category():
    """`PYTHON - SUMMER 2025` (Summer imports) is the same course as `Python - GLOBAL`."""
    assert load.course_from_category("PYTHON - SUMMER 2025") == "Introduction to Programming"
    assert load.course_from_category("WEB DESIGN - STUDENTS 01") == "Web Design"
    assert load.course_from_category("Python - GLOBAL") == "Introduction to Programming"
    assert load.course_from_category("Banter") == "Banter"


def _bloombot_temp_dirs() -> set[str]:
    import tempfile

    return {p.name for p in Path(tempfile.gettempdir()).glob("bloombot-analysis-*")}


def test_reading_a_database_makes_no_temp_files_and_leaves_it_unchanged(tmp_path):
    """The loader copies into memory: no temp dir (a leaked copy of student data), no write to the source."""
    path = tmp_path / "platform.db"
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE t (x INTEGER)")
    conn.execute("INSERT INTO t VALUES (1)")
    conn.commit()
    conn.close()
    before_bytes = path.read_bytes()
    before_temp = _bloombot_temp_dirs()

    reader = load._connect(path)
    assert reader.execute("SELECT COUNT(*) FROM t").fetchone() == (1,)
    reader.close()

    assert path.read_bytes() == before_bytes
    assert _bloombot_temp_dirs() == before_temp


def test_rows_still_in_the_wal_are_read(tmp_path):
    """Rows not yet checkpointed into the main file must not silently vanish from the analysis."""
    path = tmp_path / "platform.db"
    writer = sqlite3.connect(path)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("PRAGMA wal_autocheckpoint=0")
    writer.execute("CREATE TABLE t (x INTEGER)")
    writer.execute("INSERT INTO t VALUES (1)")
    writer.commit()
    assert Path(f"{path}-wal").stat().st_size > 0
    before_bytes = path.read_bytes()
    before_temp = _bloombot_temp_dirs()

    reader = load._connect(path)
    assert reader.execute("SELECT COUNT(*) FROM t").fetchone() == (1,)
    reader.close()

    assert path.read_bytes() == before_bytes  # the main file was never written
    assert _bloombot_temp_dirs() == before_temp  # and nothing was copied to a temp dir
    writer.close()  # (closing checkpoints the WAL into the file, so only after the checks)


def test_enrolments_and_costs_use_the_same_course_label_as_messages(mock_dbs):
    """
    A course whose platform title differs from the analysis' name for it keeps one
    label everywhere, or a join on course (adoption, cost per course) silently splits.
    """
    db = mock_dbs / "combined.db"
    titles = {r[0] for r in sqlite3.connect(db).execute("SELECT title FROM courses")}
    assert "Intro to Computer Programming" in titles  # the platform's own title

    messages = set(load.load_current(db)["course"])
    enrolments = set(load.load_enrolments(db)["course"])
    costs = set(load.load_costs(db)["course"])
    assert "Intro to Computer Programming" not in messages | enrolments | costs
    assert "Introduction to Programming" in messages & enrolments & costs
    assert enrolments <= messages
    assert costs - {"Unknown"} <= messages


def test_an_imported_message_without_a_category_takes_its_courses_label(tmp_path):
    """No original category recorded: fall back to the course's label, not 'Unknown'."""
    base = ("org", "cnv", "per", "crs", "from_person", "hello", "discord", "general")
    rows = [
        ("legacy-message-a", *base, "PYTHON - SUMMER 2025", 1, _ms(datetime(2025, 6, 10, 14, 0))),
        ("legacy-message-b", *base, None, 2, _ms(datetime(2025, 6, 10, 14, 5))),
        ("legacy-message-c", *base, "", 3, _ms(datetime(2025, 6, 10, 14, 9))),
    ]
    frame = load.load_current(_current_db(tmp_path, rows))
    assert set(frame["course"]) == {"Introduction to Programming"}


def test_combined_mode_keeps_look_alike_messages_with_distinct_ids(tmp_path):
    """One database: two rows with different ids are two messages, even with identical text and time."""
    base = ("org", "cnv", "per", "crs", "from_person", "ok", "discord", "general", "Python - GLOBAL")
    when = _ms(datetime(2026, 2, 3, 10, 0))
    rows = [("msg-1", *base, 1, when), ("msg-2", *base, 2, when)]
    config = Config(
        input_mode="combined",
        combined_db=_current_db(tmp_path, rows),
        topic_cache=tmp_path / "t.json",
        out_dir=tmp_path / "out",
    )
    merged, provenance = load.load_messages(config)
    assert len(merged) == 2 and provenance["duplicates_dropped"] == 0
    # Two-file mode, by contrast, deliberately treats the pair as one message.
    assert len(load.merge_messages(pd.DataFrame(), load.load_current(config.combined_db), config)[0]) == 1


def test_an_unknown_input_mode_is_refused(tmp_path):
    with pytest.raises(ValueError):
        Config(input_mode="three-file")


def test_analytics_notebook_ships_without_outputs():
    """The repository is public: a committed notebook must not carry real-data output."""
    nb = json.loads((REPO_ROOT / "analytics.ipynb").read_text())
    assert all(
        not c.get("outputs") and c.get("execution_count") is None
        for c in nb["cells"]
        if c["cell_type"] == "code"
    )


def test_analytics_notebook_runs_on_the_combined_database(mock_dbs):
    """analytics.ipynb loads the combined file through the shared loader and reaches the summary table."""
    nbformat = pytest.importorskip("nbformat")
    nbclient = pytest.importorskip("nbclient")
    pytest.importorskip("seaborn")

    notebook = nbformat.read(REPO_ROOT / "analytics.ipynb", as_version=4)
    env = {
        "BLOOMBOT_ANALYSIS_INPUT": "combined",
        "BLOOMBOT_ANALYSIS_COMBINED_DB": str(mock_dbs / "combined.db"),
        "BLOOMBOT_ANALYSIS_TOPIC_CACHE": str(mock_dbs / "analytics_topics.json"),
        "BLOOMBOT_TOPIC_METHOD": "keyword",  # never the network
        "MPLBACKEND": "Agg",
    }
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        nbclient.NotebookClient(
            notebook, timeout=300, resources={"metadata": {"path": str(REPO_ROOT)}}
        ).execute()
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    text = "".join(
        "".join(o.get("text", ""))
        for c in notebook.cells
        if c["cell_type"] == "code"
        for o in c.get("outputs", [])
        if o.get("output_type") == "stream"
    )
    assert "combined:" in text and "Method: keyword" in text
    last = notebook.cells[-1]["outputs"][0]["data"]["text/plain"]
    assert "conversations" in last  # the ANLY-7 summary table
    # The position-keyed cache is never the one in use.
    assert (mock_dbs / "analytics_topics.json").exists()


# ── NULL text columns and the run_all guard (ANLY-8 rework) ───────────────


def test_a_null_category_does_not_crash_the_label_helpers():
    """pandas 3 hands a SQL NULL over as float NaN, which is truthy: `nan or ""` is still nan."""
    nan = float("nan")
    for missing in (None, nan, ""):
        assert load.course_from_category(missing) == "Unknown"
        assert load.channel_type_from_category(missing) == "Other"
    assert load.fingerprint("p", "2026-01-01 00:00:00", "from", nan) == load.fingerprint(
        "p", "2026-01-01 00:00:00", "from", ""
    )


def test_web_messages_with_no_category_load(tmp_path):
    """Native web / assistant rows have a NULL category and channel; they must load as Direct."""
    rows = [
        # A Discord row with a category beside the NULL ones makes the column text
        # (so a NULL arrives as NaN under pandas 3), as in the real database.
        ("m0", "org", "cnv", "per", "crs", "from_person", "yo", "discord", "general", "Python - GLOBAL", 0,
         _ms(datetime(2026, 9, 10, 13, 0))),
        ("m1", "org", "cnv", "per", "crs", "from_person", "hi", "web", None, None, 1,
         _ms(datetime(2026, 9, 10, 14, 0))),
        ("m2", "org", "cnv", "per", "crs", "to_person", "hello", "web", None, None, 2,
         _ms(datetime(2026, 9, 10, 14, 0, 5))),
    ]
    frame = load.load_current(_current_db(tmp_path, rows))
    web = frame[frame["surface"] == "web"]
    assert len(frame) == 3 and len(web) == 2
    assert set(web["channel_type"]) == {"Direct"}
    assert set(web["category"]) == {""}
    assert set(frame["course"]) == {"Introduction to Programming"}


@pytest.mark.parametrize("flag", ["--combined-db", "--legacy-db", "--current-db"])
def test_mock_run_refuses_real_input_paths(flag, tmp_path):
    """`--mock` writes executed notebooks back into the repository, so it must never read other data."""
    run = subprocess.run(
        [sys.executable, str(REPO_ROOT / "analysis" / "run_all.py"), "--mock", flag, str(tmp_path / "x.db")],
        capture_output=True,
        text=True,
    )
    assert run.returncode == 2
    assert "--mock uses its own synthetic databases" in run.stderr
