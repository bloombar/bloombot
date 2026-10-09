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
    """Test rigs are dropped from every aggregate (ANLY-9: only test rigs)."""
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
            "handle": ["student042", "testbot"],
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


def _registered(course: str, n: int) -> pd.DataFrame:
    return pd.DataFrame({"course": course, "person_key": [f"p{i}" for i in range(n)]})


def test_adoption_is_unmeasurable_without_a_class_size():
    """ANLY-11: no class size means NA shares, never a share of registered users."""
    session_rows = sessions.session_frame(_messages(["2026-09-10 10:00"]))
    result = sessions.adoption(session_rows, _registered("Web Design", 1))
    assert result.loc[0, "active"] == 1 and result.loc[0, "registered"] == 1
    assert pd.isna(result.loc[0, "enrolled"])
    assert pd.isna(result.loc[0, "registered_share"]) and pd.isna(result.loc[0, "active_share"])


def test_adoption_divides_by_the_class_size_not_by_registered_users():
    """ANLY-11: 1 active of 3 registered of a class of 10."""
    rows = sessions.session_frame(_messages(["2026-09-10 10:00"]))
    result = sessions.adoption(rows, _registered("Web Design", 3), {"Web Design": 10})
    row = result.iloc[0]
    assert (row["enrolled"], row["registered"], row["active"]) == (10, 3, 1)
    assert row["registered_share"] == pytest.approx(0.3)
    assert row["active_share"] == pytest.approx(0.1)


def test_adoption_tolerates_more_registered_than_the_class_size():
    rows = sessions.session_frame(_messages(["2026-09-10 10:00"]))
    with pytest.warns(UserWarning, match="more registered users"):
        result = sessions.adoption(rows, _registered("Web Design", 12), {"Web Design": 10})
    assert result.loc[0, "registered_share"] == pytest.approx(1.2)


def test_adoption_totals_count_only_sized_courses_in_the_shares():
    rows = pd.concat(
        [
            sessions.session_frame(_messages(["2026-09-10 10:00"], person="a", course="Web Design")),
            sessions.session_frame(_messages(["2026-09-10 10:00"], person="b", course="Other")),
        ]
    )
    enrolments = pd.concat([_registered("Web Design", 2), _registered("Other", 4)])
    table = sessions.adoption(rows, enrolments, {"Web Design": 10})
    totals = sessions.adoption_totals(table)
    assert totals["enrolled_total"] == 10
    assert totals["registered_total"] == 6 and totals["active_total"] == 2
    assert totals["registered_share"] == pytest.approx(0.2)
    assert totals["active_share"] == pytest.approx(0.1)
    assert totals["courses_without_class_size"] == ["Other"]


def test_class_sizes_are_configured_by_term_and_pipeline_label():
    """ANLY-11: the summer course is keyed by the analysis label, not the platform title."""
    config = Config()
    assert config.class_sizes_for("summer_2026") == {"Introduction to Programming": 54, "Web Design": 28}
    assert config.class_sizes_for("fall_2026")["Software Engineering"] == 109
    assert config.class_sizes_for("summer_2025") == {}
    assert config.term("summer_2026").start == date(2026, 6, 1)
    assert not config.registration_existed("spring_2026") and config.registration_existed("fall_2026")


def test_term_adoption_computes_active_share_before_registration_existed():
    """ANLY-11: a term with class sizes but no registration has registered NA and a real share."""
    config = Config(as_of=date(2026, 10, 9))
    times = [f"2025-09-1{i} 10:00" for i in range(6)]
    frame = pd.concat(
        [_messages([t], person=f"p{i}", course="Software Engineering") for i, t in enumerate(times)]
    )
    rows = sessions.session_frame(frame).rename(columns={})
    table = sessions.term_adoption(rows, pd.DataFrame(columns=["course", "person_key"]), config)
    row = table[(table["term"] == "fall_2025") & (table["course"] == "Software Engineering")].iloc[0]
    assert pd.isna(row["registered"]) and not row["registration_existed"]
    assert row["enrolled"] == 100 and row["active"] == 6
    assert row["active_share"] == pytest.approx(0.06)
    assert not row["partial"]
    # The current term is flagged partial.
    assert table[table["term"] == "fall_2026"]["partial"].all()


def test_term_adoption_has_no_share_without_a_class_size_and_blanks_small_cells():
    config = Config(as_of=date(2026, 10, 9))
    frame = pd.concat(
        [_messages(["2025-07-10 10:00"], person=f"p{i}", course="Web Design") for i in range(6)]
        + [_messages(["2025-09-10 10:00"], person="solo", course="Software Engineering")]
    )
    table = sessions.term_adoption(
        sessions.session_frame(frame), pd.DataFrame(columns=["course", "person_key"]), config
    )
    summer = table[table["term"] == "summer_2025"].iloc[0]  # no class size configured
    assert summer["active"] == 6 and pd.isna(summer["enrolled"]) and pd.isna(summer["active_share"])
    solo = table[(table["term"] == "fall_2025") & (table["course"] == "Software Engineering")].iloc[0]
    assert pd.isna(solo["active"]) and pd.isna(solo["active_share"])  # 1 < min_cell_students


def test_window_active_share_ignores_unsized_courses():
    window = pd.concat(
        [
            _messages(["2026-09-10 10:00"], person="a", course="Web Design"),
            _messages(["2026-09-10 10:00"], person="b", course="Unsized"),
        ]
    ).rename(columns={})
    result = sessions.window_active_share(sessions.session_frame(window), {"Web Design": 4})
    assert result == {"active": 1, "enrolled": 4, "share": 0.25}


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
    assert labelled.loc[0, "topic"] == "Course concepts"


def _fake_openai(monkeypatch, label="Deadlines & schedule"):
    """Replace the model call with a counter, so cache behaviour is testable offline."""
    calls = []

    def fake(text, course, role="student"):
        calls.append((text, role))
        return label

    monkeypatch.setattr(topics, "classify_openai", fake)
    return calls


def test_model_cache_is_keyed_by_content_not_position(tmp_path, monkeypatch):
    """Re-sessionising must not silently invalidate every cached model label."""
    config = _config(tmp_path, None, None)
    calls = _fake_openai(monkeypatch)
    texts = pd.DataFrame(
        {"session_id": ["s1"], "course": ["Web Design"], "text": ["Student: when is hw2 due"],
         "student_text": ["when is hw2 due"]}
    )
    topics.classify_sessions(texts, method="openai", config=config)
    (key,) = topics.load_cache(config.topic_cache)
    assert key == (
        f"v2-student:openai-{topics.openai_fingerprint('student')}:"
        f"{topics.text_key('Student: when is hw2 due')}"
    )
    again = topics.classify_sessions(texts.assign(session_id=["s99"]), method="openai", config=config)
    assert again.loc[0, "topic_method"] == "openai-cached" and len(calls) == 1


def test_keyword_labels_are_never_cached_so_a_rule_edit_takes_effect(tmp_path, monkeypatch):
    config = _config(tmp_path, None, None)
    texts = pd.DataFrame(
        {"session_id": ["s1"], "course": ["Web Design"], "text": ["Student: tell me a joke"],
         "student_text": ["tell me a joke"]}
    )
    assert topics.classify_sessions(texts, config=config).loc[0, "topic"] == "Other"
    assert topics.load_cache(config.topic_cache) == {}
    edited = {
        "student": [("Greetings & bot questions", r"\bjoke\b"), *topics.STUDENT_RULES],
        "staff": topics.STAFF_RULES,
    }
    monkeypatch.setattr(topics, "KEYWORD_RULES", edited)
    again = topics.classify_sessions(texts, config=config)
    assert again.loc[0, "topic"] == "Greetings & bot questions"
    assert again.loc[0, "topic_method"] == "keyword"


def test_a_changed_prompt_relabels_a_cached_model_session(tmp_path, monkeypatch):
    config = _config(tmp_path, None, None)
    calls = _fake_openai(monkeypatch)
    texts = pd.DataFrame(
        {"session_id": ["s1"], "course": ["Web Design"], "text": ["Student: hi"], "student_text": ["hi"]}
    )
    topics.classify_sessions(texts, method="openai", config=config)
    assert topics.classify_sessions(texts, method="openai", config=config).loc[0, "topic_method"] == "openai-cached"
    edited = {**topics.STUDENT_DESCRIPTIONS, "Other": "something else entirely"}
    monkeypatch.setattr(topics, "STUDENT_DESCRIPTIONS", edited)
    out = topics.classify_sessions(texts, method="openai", config=config)
    assert out.loc[0, "topic_method"] == "openai" and len(calls) == 2


def test_agreement_rate_ignores_unaudited_rows():
    audited = pd.DataFrame(
        {
            "topic": ["Deadlines & schedule", "Other", "Other"],
            "hand_label": ["Deadlines & schedule", "Course concepts", ""],
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


# ── Staff and student roles (ANLY-9) ──────────────────────────────────────


def _platform_db(tmp_path: Path, with_accounts: bool = True) -> Path:
    """
    A platform database with four people in org 'org' and one message each:
    the linked owner, a person whose membership was revoked, an owner of a
    different organization, and a plain student.
    """
    path = tmp_path / "roles.db"
    conn = sqlite3.connect(path)
    conn.executescript(CURRENT_DDL)
    if not with_accounts:
        conn.executescript("DROP TABLE accounts; DROP TABLE memberships;")
    conn.executemany("INSERT INTO organizations VALUES (?,?,0)", [("org", "Org"), ("org2", "Org 2")])
    conn.execute("INSERT INTO courses VALUES ('crs','org','prj','Web Design',1,0)")
    people = {"owner": "prof", "revoked": "ta", "foreign": "visitor", "plain": "stu"}
    for person, handle in people.items():
        conn.execute(
            "INSERT INTO people VALUES (?,?,?,?,?,?,?,0,NULL,NULL,NULL,NULL,0)",
            (person, "org", handle, f"{handle}@example.edu", "F", "L", handle),
        )
        conn.execute(
            "INSERT INTO person_identities VALUES (?,?,?,?,?,0)",
            (f"d_{person}", "org", person, "discord", f"9{len(person)}{ord(person[0])}"),
        )
        conn.execute(
            "INSERT INTO conversations VALUES (?,?,?,?,?,NULL,NULL,NULL,0,0)",
            (f"cnv_{person}", "org", "crs", person, "web"),
        )
        conn.execute(
            "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,NULL,NULL,1,?)",
            (f"m_{person}", "org", f"cnv_{person}", person, "crs", "from_person", "hello",
             "web", _ms(datetime(2026, 9, 3, 10, 0))),
        )
    if with_accounts:
        conn.executemany(
            "INSERT INTO accounts VALUES (?,?,?)",
            [("acc_owner", "o@x.edu", "O"), ("acc_revoked", "r@x.edu", "R"), ("acc_foreign", "f@x.edu", "F")],
        )
        conn.executemany(
            "INSERT INTO memberships VALUES (?,?,?,?)",
            [("org", "acc_owner", "owner", None), ("org", "acc_revoked", "assistant", 5),
             ("org2", "acc_foreign", "owner", None)],
        )
        conn.executemany(
            "INSERT INTO person_identities VALUES (?,?,?,?,?,0)",
            [("w1", "org", "owner", "web", "acc_owner"), ("w2", "org", "revoked", "web", "acc_revoked"),
             ("w3", "org", "foreign", "web", "acc_foreign")],
        )
    # One ledger row and one enrolment per person, to test the role on both.
    for i, person in enumerate(people):
        conn.execute(
            "INSERT INTO cost_ledger_entries VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (f"c_{person}", "org", "crs", person, "gpt-4.1", 100, 10, (i + 1) * 1_000_000,
             "measured", "web", _ms(datetime(2026, 9, 3, 10, 0))),
        )
        conn.execute(
            "INSERT INTO enrolments VALUES (?,?,?,?,?,0,NULL,NULL,NULL)",
            (f"e_{person}", "org", "crs", person, "join_link"),
        )
    conn.commit()
    conn.close()
    return path


def _roles(frame: pd.DataFrame) -> dict:
    return dict(zip(frame["message_id"].str.replace("current:m_", "", regex=False), frame["role"]))


def test_staff_join_flags_the_linked_owner_only(tmp_path):
    """An active membership in the message's org makes staff; revoked or foreign ones do not."""
    roles = _roles(load.load_current(_platform_db(tmp_path)))
    assert roles == {"owner": "staff", "revoked": "student", "foreign": "student", "plain": "student"}


def test_cost_rows_carry_the_role_of_whoever_caused_them(tmp_path):
    costs = load.load_costs(_platform_db(tmp_path))
    roles = dict(zip(costs["usd"].round().astype(int), costs["role"]))
    # The ledger rows were written in the order owner, revoked, foreign, plain ($1..$4).
    assert roles == {1: "staff", 2: "student", 3: "student", 4: "student"}


def test_enrolled_staff_are_left_out_of_the_adoption_denominator(tmp_path):
    enrolments = load.load_enrolments(_platform_db(tmp_path))
    assert len(enrolments) == 3  # the owner is enrolled too, and is not counted


def test_roles_fall_back_to_handles_without_the_account_tables(tmp_path):
    """Older files have no accounts/memberships: no crash, and nobody is staff by membership."""
    frame = load.load_current(_platform_db(tmp_path, with_accounts=False))
    assert set(frame["role"]) == {"student"}
    config = Config(staff_handles=("prof",), excluded_handles=())
    merged, provenance = load.merge_messages(frame.iloc[:0], frame, config, dedupe="id")
    assert _roles(merged)["owner"] == "staff" and provenance["staff_rows"] == 1


def test_a_handle_override_marks_staff_and_is_kept_in_the_frame():
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
            "handle": ["student042", "Instructor Smith"],
            "role": ["student", "student"],
        }
    )
    merged, provenance = load.merge_messages(frame.iloc[:0], frame, Config())
    assert dict(zip(merged["person_key"], merged["role"])) == {"discord:1": "student", "discord:2": "staff"}
    assert provenance["staff_rows"] == 1 and provenance["excluded_account_rows"] == 0


def _unified_row(message_id, person_key, ts, content, source, role, handle):
    return {
        "message_id": message_id, "ts": pd.Timestamp(ts), "person_key": person_key,
        "course": "Web Design", "surface": "discord", "category": "Web Design - GLOBAL",
        "channel": "general", "channel_type": "Global", "direction": "from", "content": content,
        "source": source, "handle": handle, "role": role,
    }


def test_legacy_messages_of_a_staff_person_are_staff():
    """
    Two-file mode: a legacy row whose person_key is a staff person in the current
    database is staff. The legacy row is NOT a duplicate of anything current, so
    it survives the merge and only the promotion can make it staff.
    """
    legacy = pd.DataFrame(
        [
            _unified_row("legacy:1", "discord:7", "2025-10-01 10:00", "old staff question", "legacy", "student", "owner7"),
            _unified_row("legacy:2", "discord:8", "2025-10-01 11:00", "old student question", "legacy", "student", "stu8"),
        ]
    )
    current = pd.DataFrame(
        [_unified_row("current:1", "discord:7", "2026-09-04 10:00", "new staff question", "current", "staff", "Owner Seven")]
    )
    merged, provenance = load.merge_messages(legacy, current, Config())
    by_id = dict(zip(merged["message_id"], merged["role"]))
    assert by_id == {"legacy:1": "staff", "legacy:2": "student", "current:1": "staff"}
    assert provenance["duplicates_dropped"] == 0 and provenance["staff_rows"] == 2


def test_role_survives_on_imported_legacy_messages(mock_dbs):
    """Combined mode: the owner's imported history carries the staff role, through the discord key."""
    config = Config(input_mode="combined", combined_db=mock_dbs / "combined.db", topic_cache=mock_dbs / "t.json")
    merged, provenance = load.load_messages(config)
    imported = merged[merged["message_id"].str.startswith("current:" + load.IMPORTED_PREFIX)]
    owner = imported[imported["person_key"] == "discord:700999999999999999"]
    assert len(owner) > 0 and set(owner["role"]) == {"staff"}
    # The same single person appears on every surface.
    staff = merged[merged["role"] == "staff"]
    assert staff["person_key"].nunique() == 1 and {"discord", "web", "mcp"} <= set(staff["surface"])
    assert provenance["staff_rows"] == len(staff)
    assert provenance["excluded_account_rows"] > 0  # the test rig


def test_mock_lookalikes_count_as_students(mock_dbs):
    """A revoked membership and another org's owner are students, not staff."""
    conn = sqlite3.connect(mock_dbs / "combined.db")
    keys = {
        f"discord:{r[0]}"
        for r in conn.execute(
            "SELECT d.external_id FROM person_identities w JOIN person_identities d "
            "ON d.person_id = w.person_id AND d.surface='discord' "
            "WHERE w.surface='web' AND w.external_id IN ('acc_revoked','acc_other_org')"
        )
    }
    assert len(keys) == 2
    config = Config(input_mode="combined", combined_db=mock_dbs / "combined.db", topic_cache=mock_dbs / "t.json")
    merged, _ = load.load_messages(config)
    seen = merged[merged["person_key"].isin(keys)]
    assert len(seen) > 0 and set(seen["role"]) == {"student"}


def test_student_measures_exclude_staff(mock_dbs):
    """Sessions carry one role each, and a student-only summary counts no staff person."""
    config = Config(input_mode="combined", combined_db=mock_dbs / "combined.db", topic_cache=mock_dbs / "t.json")
    merged, _ = load.load_messages(config)
    frame = sessions.session_frame(merged)
    assert set(frame["role"]) == {"staff", "student"}
    students = frame[frame["role"] == "student"]
    assert "discord:700999999999999999" not in set(students["person_key"])
    summary = sessions.usage_summary(students)
    assert summary["students"] == students["person_key"].nunique()
    assert summary["sessions"] == len(frame) - (frame["role"] == "staff").sum()
    # A person has one role, so no session mixes the two.
    assert frame.groupby("person_key")["role"].nunique().max() == 1


def test_a_session_never_mixes_roles():
    times = pd.to_datetime(["2026-09-03 10:00", "2026-09-03 10:01"])
    frame = _messages(times).assign(role=["staff", "student"])
    assert sorted(sessions.session_frame(frame)["role"]) == ["staff", "student"]


# ── Topic sets (ANLY-10) ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,expected",
    [
        ("are late days or extensions available this term", "Course policies"),
        ("do extensions apply to pair assignments", "Course policies"),
        ("Which of the following describes an idempotent request?", "Quiz & exam questions"),
        ("do I make a feature branch before opening a pull request", "Git & GitHub workflow"),
        ("should I rebase before I push my commits?", "Git & GitHub workflow"),
        ("does a mobile app count as a component for the milestone 2 requirement", "Project & assignment requirements"),
        ("my group's channel disappeared", "Discord & platform help"),
        ("does the channel have to be invite-only", "Discord & platform help"),
        ("hi", "Greetings & bot questions"),
        ("are you there", "Greetings & bot questions"),
        ("should I use a managed postgres or run it in a container", "Tools, setup & deployment"),
        ("my unit test is not working\ndef mul(a, b): return a + b", "Code & debugging"),
        ("nobody told me which team I'm on", "Team coordination"),
        ("when is the third assignment due", "Deadlines & schedule"),
        ("hi, when is the third assignment due", "Deadlines & schedule"),
        ("how is the project graded", "Grades & grading"),
        ("can you explain what a closure is", "Course concepts"),
        ("ok sounds good", "Other"),
        # Over-matching words that once misrouted a session (ANLY-10 rework).
        ("what should our final project be about", "Project & assignment requirements"),
        ("can you test my understanding of loops", "Course concepts"),
        ("what does pull mean in pandas", "Other"),
        ("what is variable scope", "Course concepts"),
        ("I'm stuck on the wireframe", "Project & assignment requirements"),
        ("what's a database index", "Course concepts"),
        ("explain what an ide is", "Course concepts"),
        ("allowed characters in a variable name", "Other"),
        ("I need to rest my eyes", "Other"),
    ],
)
def test_student_keyword_rules(text, expected):
    assert topics.classify_keyword(text, "student") == expected


@pytest.mark.parametrize(
    "text,expected",
    [
        ("hello, can you hear me?", "Testing the bot"),
        ("do you recognize my name?", "Testing the bot"),
        ("remember this code word: tulip", "Testing the bot"),
        ("is the bot working now?", "Testing the bot"),
        ("@everyone the study bot is live in the course channels starting today", "Announcements"),
        ("please create a new channel for the design group", "Directing students"),
        ("describe dependency hell to everyone", "Demonstrating to class"),
        ("what is the rule about late homework", "Course content & policy lookup"),
        ("when is the third assignment due", "Course content & policy lookup"),
        ("please change the course title to Intro to Python", "Course setup"),
        ("how many students have joined", "Course setup"),
        ("ok sounds good", "Other"),
    ],
)
def test_staff_keyword_rules(text, expected):
    assert topics.classify_keyword(text, "staff") == expected


def test_every_rule_label_belongs_to_its_set():
    from bloombot_analysis.config import STAFF_TOPICS, STUDENT_TOPICS

    assert {t for t, _ in topics.STUDENT_RULES} <= set(STUDENT_TOPICS)
    assert {t for t, _ in topics.STAFF_RULES} <= set(STAFF_TOPICS)
    assert set(topics.STUDENT_DESCRIPTIONS) == set(STUDENT_TOPICS)
    assert set(topics.STAFF_DESCRIPTIONS) == set(STAFF_TOPICS)


def test_mock_prompts_classify_to_their_intended_topic():
    """The mock's prompts are the examples the rules are written against."""
    mock = _mock_module()
    for topic, prompts in mock.PROMPTS.items():
        for prompt in prompts:
            assert topics.classify_keyword(prompt, "student") == topic, prompt
    for topic, prompts in mock.STAFF_PROMPTS.items():
        for prompt in prompts:
            assert topics.classify_keyword(prompt, "staff") == topic, prompt


def test_sessions_are_classified_under_their_roles_set(tmp_path):
    config = _config(tmp_path, None, None)
    texts = pd.DataFrame(
        {
            "session_id": ["s1", "s2"], "role": ["student", "staff"], "course": ["Web Design"] * 2,
            "text": ["when is hw2 due"] * 2, "student_text": ["when is hw2 due"] * 2,
        }
    )
    out = topics.classify_sessions(texts, method="keyword", config=config)
    assert list(out["topic"]) == ["Deadlines & schedule", "Course content & policy lookup"]


def test_a_v1_cache_entry_is_not_reused(tmp_path, monkeypatch):
    """A label from the nine-label set must never be served under the new sets."""
    config = _config(tmp_path, None, None)
    calls = _fake_openai(monkeypatch, "Deadlines & schedule")
    text = "Student: when is hw2 due"
    topics.save_cache({f"openai:{topics.text_key(text)}": "Syllabus, schedule & deadlines"}, config.topic_cache)
    texts = pd.DataFrame(
        {"session_id": ["s1"], "course": ["Web Design"], "text": [text], "student_text": ["when is hw2 due"]}
    )
    out = topics.classify_sessions(texts, method="openai", config=config)
    assert out.loc[0, "topic"] == "Deadlines & schedule" and len(calls) == 1


def test_staff_prompt_says_it_classifies_an_instructors_conversation(monkeypatch):
    sent = {}

    class FakeOpenAI:
        def __init__(self, api_key):
            self.chat = type("C", (), {"completions": self})()

        def create(self, **kwargs):
            sent.update(kwargs)
            message = type("M", (), {"content": "Announcements"})()
            return type("R", (), {"choices": [type("Ch", (), {"message": message})()]})()

    monkeypatch.setitem(sys.modules, "openai", type("Mod", (), {"OpenAI": FakeOpenAI}))
    monkeypatch.setenv("OPENAI_API_KEY", "not-a-real-key")
    assert topics.classify_openai("@everyone hello", "Web Design", "staff") == "Announcements"
    system = sent["messages"][0]["content"]
    assert "instructor" in system and "- Testing the bot:" in system and "Quiz & exam" not in system
    topics.classify_openai("when is hw2 due", "Web Design", "student")
    assert "- Quiz & exam questions:" in sent["messages"][0]["content"]


def test_audit_sample_records_role_and_agreement_reports_per_role():
    sessions_frame = pd.DataFrame(
        {
            "session_id": [f"s{i}" for i in range(6)],
            "role": ["student"] * 4 + ["staff"] * 2,
            "course": "Web Design", "topic": ["Other"] * 6, "text": "x",
        }
    )
    sample = topics.audit_sample(sessions_frame, n=3)
    assert set(sample["role"]) == {"student", "staff"} and (sample["role"] == "staff").sum() == 2
    audited = sample.assign(hand_label="Other")
    audited.loc[audited["role"] == "staff", "hand_label"] = "Testing the bot"
    result = topics.agreement_rate(audited)
    assert result["by_role"]["student"]["rate"] == 1.0 and result["by_role"]["staff"]["rate"] == 0.0


def test_topic_tables_take_the_label_set():
    from bloombot_analysis.config import STAFF_TOPICS

    assert list(topics.topic_counts(pd.DataFrame(), STAFF_TOPICS)["topic"]) == STAFF_TOPICS
    frame = pd.DataFrame({"course": ["a"], "topic": ["Announcements"]})
    assert list(topics.topic_by(frame, "course", STAFF_TOPICS).columns) == STAFF_TOPICS


# ── The report's staff section (ANLY-9) ───────────────────────────────────


def test_mock_report_has_a_staff_section_and_student_only_figures(mock_dbs):
    """Run the whole notebook chain on the mock data; the report gains the staff slides."""
    out = mock_dbs / "report-out"
    env = {
        **os.environ,
        "BLOOMBOT_ANALYSIS_INPUT": "two-file",
        "BLOOMBOT_ANALYSIS_LEGACY_DB": str(mock_dbs / "legacy.db"),
        "BLOOMBOT_ANALYSIS_CURRENT_DB": str(mock_dbs / "current.db"),
        "BLOOMBOT_ANALYSIS_COMBINED_DB": str(mock_dbs / "combined.db"),
        "BLOOMBOT_ANALYSIS_TOPIC_CACHE": str(mock_dbs / "report_topics.json"),
        "BLOOMBOT_ANALYSIS_OUT_DIR": str(out),
        "BLOOMBOT_ANALYSIS_AS_OF": "2026-09-25",
        "BLOOMBOT_ANALYSIS_CLASS_SIZES": str(mock_dbs / "class_sizes.json"),
        "MPLBACKEND": "Agg",
    }
    # Execute copies of the notebooks, so the committed ones are never rewritten.
    code = (
        "import sys; sys.path.insert(0, %r)\n"
        "import nbformat\nfrom nbclient import NotebookClient\n"
        "from pathlib import Path\n"
        "import run_all\n"
        "for name in run_all.NOTEBOOKS:\n"
        "    nb = nbformat.read(Path(%r) / name, as_version=4)\n"
        "    NotebookClient(nb, timeout=300, resources={'metadata': {'path': %r}}).execute()\n"
    ) % (str(REPO_ROOT / "analysis"), str(REPO_ROOT / "analysis" / "notebooks"), str(REPO_ROOT))
    subprocess.run([sys.executable, "-c", code], check=True, env=env, capture_output=True)

    text = (out / "USAGE_REPORT.md").read_text()
    assert "## S23 · Staff use it too, and it is counted separately" in text
    assert "What staff used it for" in text
    assert "Testing the bot" in text and "Quiz & exam questions" in text
    metrics = json.loads((out / "metrics.json").read_text())
    staff, dataset = metrics["staff"], metrics["dataset"]
    assert staff["messages"] > 0 and dataset["staff_rows"] == staff["messages"]
    # Student figures are students only: the staff session count is not in them.
    assert dataset["sessions"] == staff["all_sessions"] - staff["sessions"]
    assert "quote" not in json.dumps(staff).lower()

    # ANLY-11: S09 reports enrolled students and registered users apart, and
    # "enrolled" never stands in for registered users anywhere in the report.
    s09 = text.split("## S09", 1)[1].split("\n## S", 1)[0]
    assert "enrolled students" in s09 and "registered" in s09
    assert "of 145 enrolled students" in s09  # mock class sizes 60 + 45 + 40
    for phrase in ("enrolled students used", "enrolled students tried"):
        assert phrase not in text
    assert "registration did not exist" in text  # the term-by-term slide
    volume = metrics["volume"]
    assert volume["adoption_total_enrolled"] == 145
    assert volume["adoption_total_registered"] > 0
    assert any(r["course"] == "Introduction to Programming" and pd.isna(r["enrolled"]) for r in volume["adoption"])

    # Every student notebook filters to students: the numbers they wrote match
    # a student-only recount of the tidy files, and differ from an all-roles one.
    data = pd.read_csv(out / "data" / "sessions.csv", parse_dates=["started_at"])
    students = data[data["role"] == "student"]
    assert len(students) < len(data)
    assert metrics["shape"]["sessions"] == len(students)  # notebook 02
    term = Config().term("fall_2026")
    now = students[(students["started_at"].dt.date >= term.start) & (students["started_at"].dt.date <= term.end)]
    assert metrics["volume"]["adoption_total_active"] == now.groupby("course")["person_key"].nunique().sum()  # 01
    cost = metrics["cost"]
    window = students[
        (students["started_at"] >= pd.Timestamp(cost["window_start"]))
        & (students["started_at"] <= pd.Timestamp(cost["window_end"]))
    ]
    assert cost["sessions_in_window"] == len(window)  # notebook 04
    assert cost["staff_usd"] > 0 and abs(cost["student_usd"] + cost["staff_usd"] - cost["total_usd"]) < 1e-6
    assert "$" in text and "all users, staff included" in text
    assert [s for s in staff["purposes"]][0]["topic"] in {p["topic"] for p in staff["purposes"]}
