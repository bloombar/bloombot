"""
Generate two mock databases that exercise every path in the pipeline.

The point of the mock is not realism for its own sake — it is that every
awkward case the real data will contain is present here, so the notebooks are
known to handle them before the real files arrive:

* a **pre-Fall-2026 database** in the old peewee shape, covering Fall 2025 and
  Spring 2026 plus a handful of early-September 2026 messages that were never
  imported (the cutover gap);
* a **current platform database** that already contains an imported copy of the
  historical Discord traffic — so the merge has real duplicates to drop — plus
  this term's Discord, web and chat-assistant traffic;
* a **soft-deleted conversation** and a **deleted person**, which must not
  appear in any aggregate;
* a **course owner** (ANLY-9) who is staff because a web identity of theirs holds
  an account with an active membership: they post across all four courses, in
  other students' private channels, on Discord, web and the chat assistant, and
  have imported legacy history. Two lookalikes must stay students: a person whose
  membership was **revoked**, and an owner of a *different* organization;
* a **test account** ("testbot"), which is dropped from every aggregate;
* a course with **enrolments but almost no usage**, so adoption is not uniform;
* **partial-term data**: this fall stops at the as-of date, three weeks into a
  fifteen-week term.

It also writes a third file, `combined.db` (ANLY-8): one platform-schema database in
which the whole legacy history sits as imported `legacy-message-<hash>` rows —
original Discord category and channel in `category_ref` / `channel_ref`, filed
under term-suffixed courses ("Introduction to Programming (Fall 2025)") whose
titles differ from the analysis' course names — followed by this term's native
traffic. It is built from the other two files so the three always agree.

Usage:  python analysis/mock/make_mock_data.py [--out tmp/analysis]
"""

from __future__ import annotations

import argparse
import hashlib
import random
import shutil
import sqlite3
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "analysis"))

AS_OF = date(2026, 9, 25)
FALL_2025 = (date(2025, 9, 3), date(2025, 12, 16))
SPRING_2026 = (date(2026, 1, 20), date(2026, 5, 12))
FALL_2026_START = date(2026, 9, 2)

COURSES = [
    ("Software Engineering", "Software Engineering", 34),
    ("Agile Software Development & DevOps", "Agile Dev", 21),
    ("Introduction to Programming", "Python", 47),
    ("Web Design", "Web Design", 23),
]

# Question templates per topic. The keyword classifier has to be able to tell
# them apart, and the mock report has to read like a real one, so these are
# written as a student would actually type them.
PROMPTS = {
    "Project & assignment requirements": [
        "does a webapp count as a subsystem for the project 5 requirement",
        "what are the user stories we need to hand in",
        "how big should the backlog be for this milestone",
        "what exactly does assignment 3 ask for",
        "where is the starter code for this assignment",
    ],
    "Deadlines & schedule": [
        "when is the next assignment due",
        "is the deadline for the project extended?",
        "what's on the schedule for next week",
        "what time is class on thursday",
    ],
    "Grades & grading": [
        "how is the project graded",
        "what is the rubric for the midterm",
        "how much is the final worth of my grade",
    ],
    "Course policies": [
        "how many extensions do we have",
        "can we use extensions for group projects",
        "is using chatgpt allowed for the homework",
        "what happens if I miss attendance one week",
    ],
    "Course concepts": [
        "can you explain what a closure is",
        "what is the difference between an interface and an abstract class",
        "why does the lecture say to avoid global state",
        "I don't understand the slide about normalization",
    ],
    "Quiz & exam questions": [
        "what about this one: Which of the following is a stateless protocol?",
        "true or false: a tuple is immutable",
        "is the quiz open book",
    ],
    "Code & debugging": [
        "why isn't my test working? def add(a, b): return a - b",
        "I get a traceback when I call the function with None",
        "my loop never ends and I can't find the bug",
    ],
    "Git & GitHub workflow": [
        "should we fork or branch first",
        "git says there is a merge conflict, how do I fix it",
        "do I git pull before I commit?",
    ],
    "Tools, setup & deployment": [
        "atlas or docker for mongodb",
        "how do I deploy this to digitalocean",
        "how do I set up the virtual environment on a mac",
        "npm install keeps hanging on my laptop",
    ],
    "Team coordination": [
        "I still wasn't assigned a group",
        "my teammate hasn't replied in days, what should we do",
        "how should our group split up the work",
        "can we change team members for the final project",
    ],
    "Discord & platform help": [
        "I can't find my team chat",
        "should it be a private channel",
        "how do I connect my account",
    ],
    "Greetings & bot questions": [
        "hi",
        "thanks!",
        "are you a real person",
        "what's in your profile picture",
    ],
    "Other": [
        "ok sounds good",
        "lol that's funny",
        "never mind",
    ],
}

# What a course owner types (ANLY-9/10): testing the bot, demonstrating it in
# class, announcements, directing it at students, lookups and course setup.
STAFF_PROMPTS = {
    "Testing the bot": [
        "are you there?",
        "do you know who I am?",
        "who do you work for?",
        "can you remember this number: 4417",
    ],
    "Demonstrating to class": [
        "can you explain what a stakeholder is to the class",
        "define merge hell to the students",
        "explain recursion to everyone in two sentences",
    ],
    "Announcements": [
        "@everyone - Bloombot is available in the course channels now",
        "@here reminder: class is moved to room 204 on Thursday",
    ],
    "Directing students": [
        "please make a new channel with the correct settings for the team",
        "help the student find the project 3 requirements",
        "tell the students to check the syllabus",
    ],
    "Course content & policy lookup": [
        "what is the policy on extensions",
        "when is project 1 due",
        "what are the office hours for this course",
    ],
    "Course setup": [
        "can you rename the course?",
        "upload the new syllabus as course material",
    ],
    "Other": [
        "ok sounds good",
        "never mind",
    ],
}

REPLIES = [
    "Here's what the course materials say about that, and where to look next.",
    "Good question — the short answer is yes, with one caveat worth knowing.",
    "That error usually means a missing dependency. Try these three steps in order.",
    "The syllabus covers this: the relevant deadline and policy are below.",
]

# Which topics each course skews toward, so the by-course chart has something
# real to show.
COURSE_TOPIC_WEIGHTS = {
    "Software Engineering": {"Team coordination": 3, "Project & assignment requirements": 3, "Git & GitHub workflow": 2},
    "Agile Software Development & DevOps": {"Tools, setup & deployment": 4, "Team coordination": 3, "Git & GitHub workflow": 2},
    "Introduction to Programming": {"Course concepts": 4, "Code & debugging": 3, "Tools, setup & deployment": 3},
    "Web Design": {"Course concepts": 2, "Discord & platform help": 2, "Project & assignment requirements": 2},
}


def weighted_topic(rng: random.Random, course: str) -> str:
    weights = COURSE_TOPIC_WEIGHTS.get(course, {})
    population, w = [], []
    for topic in PROMPTS:
        population.append(topic)
        w.append(weights.get(topic, 1))
    return rng.choices(population, weights=w, k=1)[0]


# ── Schemas ───────────────────────────────────────────────────────────────
# Shared with the tests, so a fixture can never drift from what this generator
# actually writes.
from bloombot_analysis.mock_schemas import CURRENT_DDL, LEGACY_DDL  # noqa: E402

ORG_ID = "org_mock"


def ms(dt: datetime) -> int:
    """
    Epoch ms of a naive wall-clock time, read as New York time.

    Fixed to the analysis' display timezone (not the machine's) so the mock
    databases, and the tests built on them, come out the same on any runner.
    """
    return int(dt.replace(tzinfo=ZoneInfo("America/New_York")).timestamp() * 1000)


@dataclass
class MockSession:
    """
    One student visit, with its messages materialised once.

    Materialising matters: a session that the importer carried into the
    platform database has to be written to *both* files with the same text and
    the same timestamps, or the merge's duplicate detection has nothing to
    detect. Regenerating the messages per writer is exactly the bug that made
    the first mock run report zero duplicates.
    """

    student: dict
    course: str
    surface: str
    started: datetime
    turns: int
    topic: str
    channel_kind: str
    messages: list = field(default_factory=list)
    # Staff sessions draw from STAFF_PROMPTS; `channel_name` is the student
    # whose private channel a staff message was posted in (default: the sender's).
    staff: bool = False
    channel_name: str = ""


def build_messages(rng: random.Random, session: MockSession) -> list:
    """Alternating student/bot messages with realistic within-session gaps."""
    out = []
    when = session.started
    for _ in range(session.turns):
        pool = STAFF_PROMPTS if session.staff else PROMPTS
        out.append((when, "from", rng.choice(pool[session.topic])))
        when += timedelta(seconds=rng.randrange(4, 25))
        out.append((when, "to", rng.choice(REPLIES)))
        # Think time stays under the 30-minute gap, so a session stays one session.
        when += timedelta(seconds=rng.randrange(20, 900))
    return out


def build_sessions(rng: random.Random, active, courses, start: date, end: date, surfaces):
    """
    Produce mock sessions across a date range.

    Activity is not uniform: it peaks in the first fortnight (setup questions)
    and again around fortnightly deadlines, which is the shape the real weekly
    chart is expected to have and which the report's commentary reads off.
    `active` maps a course to the students who actually use the bot — a subset
    of the roster, so adoption is a real fraction rather than 100%.
    """
    sessions = []
    day = start
    while day <= end:
        week = (day - start).days // 7
        # Volume is deliberately small — a handful of sessions a day across
        # four courses — because that is the scale the real data is at, and a
        # pipeline that only looks right on thousands of rows is not tested.
        base = 0.55 if week < 2 else 0.22
        if week >= 2 and week % 2 == 0:
            base += 0.30
        if day.weekday() >= 5:
            base *= 0.55
        count = max(0, int(rng.gauss(base * len(courses), 0.9)))
        for _ in range(count):
            course = rng.choice(courses)
            roster = active[course]
            if not roster:
                continue
            # Use is concentrated: a few students come back often, most do not.
            student = rng.choice(roster if rng.random() < 0.55 else roster[: max(1, len(roster) // 4)])
            # `surfaces` is either a plain list (one surface, the legacy era)
            # or a {surface: weight} mapping (this term's three-way split).
            surface = (
                rng.choices(list(surfaces), weights=list(surfaces.values()), k=1)[0]
                if isinstance(surfaces, dict)
                else rng.choice(surfaces)
            )
            hour = rng.choices(
                [9, 11, 13, 15, 17, 19, 21, 22, 23, 1],
                weights=[2, 3, 3, 3, 4, 5, 6, 6, 4, 2],
                k=1,
            )[0]
            started = datetime(day.year, day.month, day.day, hour, rng.randrange(60))
            turns = max(1, min(12, round(rng.lognormvariate(0.95, 0.55))))
            session = MockSession(
                student=student,
                course=course,
                surface=surface,
                started=started,
                turns=turns,
                topic=weighted_topic(rng, course),
                channel_kind=rng.choices(["GLOBAL", "STUDENT", "TEAM"], weights=[5, 4, 2], k=1)[0],
            )
            session.messages = build_messages(rng, session)
            sessions.append(session)
        day += timedelta(days=1)
    return sessions


def imported_message_id(org_id: str, legacy_id: int) -> str:
    """Mirror of `deterministicId('legacy-message', orgId, legacyId)` in packages/legacy-import/src/ids.ts."""
    digest = hashlib.sha256("\0".join(["legacy-message", org_id, str(legacy_id)]).encode()).hexdigest()
    return f"legacy-message-{digest[:32]}"


def write_combined(legacy_path: Path, current_path: Path, combined_path: Path) -> int:
    """
    Build the combined platform database from the mock legacy and current files.

    Native rows are the current file's messages from the Fall 2026 start on (its
    earlier rows are the mock's stand-in for an earlier import and are replaced
    by the faithful one below). Every legacy message becomes an imported row:
    timestamps read as New York wall-clock time, as the real importer did, and
    Python / Web Design history filed under "<name> (<Semester>)" courses.
    Returns the number of imported messages.
    """
    from bloombot_analysis.load import semester_of

    combined_path.unlink(missing_ok=True)
    shutil.copyfile(current_path, combined_path)
    conn = sqlite3.connect(combined_path)
    # The platform's title for this course is not the analysis' name for it
    # ("Introduction to Programming"): enrolments, costs and this term's native
    # messages sit under the platform title, and must still join up with the
    # imported history that sits in the same course.
    conn.execute("UPDATE courses SET title = 'Intro to Computer Programming' WHERE id = 'crs_3'")
    conn.execute("DELETE FROM messages WHERE created_at < ?", (ms(datetime.combine(FALL_2026_START, datetime.min.time())),))
    conn.execute("DELETE FROM conversations WHERE id NOT IN (SELECT conversation_id FROM messages)")

    legacy = sqlite3.connect(legacy_path)
    rows = legacy.execute(
        "SELECT m.id, m.created_at, m.content, m.category, m.channel, m.direction, u.discord_id "
        "FROM messages m JOIN users u ON u.id = m.user_id ORDER BY m.id"
    ).fetchall()
    legacy.close()

    person_of = dict(conn.execute("SELECT external_id, person_id FROM person_identities WHERE surface='discord'"))
    course_ids = {t: f"crs_{i}" for i, (t, _, _) in enumerate(COURSES, start=1)}
    by_prefix = {prefix: title for title, prefix, _ in COURSES}
    legacy_courses: dict[str, str] = {}
    conversations: dict[tuple, str] = {}
    seq: dict[str, int] = {}
    inserted = 0
    for lid, created, content, category, channel, direction, discord_id in rows:
        when = datetime.strptime(created, "%Y-%m-%d %H:%M:%S.%f")
        base = by_prefix[category.split(" - ")[0]]
        # Earlier Python and Web Design history is filed under a term-suffixed
        # course; the others, and Python from 2026 on, stay in their existing
        # course, as in production.
        if base == "Introduction to Programming" and when.year >= 2026:
            course_id = course_ids[base]
        elif base in ("Introduction to Programming", "Web Design"):
            title = f"{base} ({semester_of(when)})"
            if title not in legacy_courses:
                legacy_courses[title] = f"crs_legacy_{len(legacy_courses) + 1}"
                conn.execute(
                    "INSERT INTO courses VALUES (?,?,?,?,?,?)",
                    (legacy_courses[title], ORG_ID, "prj_legacy", title, 0, ms(when)),
                )
            course_id = legacy_courses[title]
        else:
            course_id = course_ids[base]
        person_id = person_of[str(discord_id)]
        key = (person_id, course_id)
        if key not in conversations:
            conversations[key] = f"cnv_legacy_{len(conversations) + 1:04d}"
            conn.execute(
                "INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)",
                (conversations[key], ORG_ID, course_id, person_id, "discord", None, None, None,
                 ms(when), ms(when)),
            )
        conv_id = conversations[key]
        seq[conv_id] = seq.get(conv_id, 0) + 1
        conn.execute(
            "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (imported_message_id(ORG_ID, lid), ORG_ID, conv_id, person_id, course_id,
             "from_person" if direction == "from" else "to_person", content, "discord",
             channel, category, seq[conv_id], ms(when)),
        )
        inserted += 1
    conn.commit()
    conn.close()
    return inserted


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(REPO_ROOT / "tmp" / "analysis"))
    parser.add_argument("--seed", type=int, default=20260925)
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    legacy_path = out_dir / "legacy.db"
    current_path = out_dir / "current.db"
    for path in (legacy_path, current_path):
        path.unlink(missing_ok=True)

    rng = random.Random(args.seed)

    # ── People ────────────────────────────────────────────────────────────
    students: dict[str, list[dict]] = {}
    everyone: list[dict] = []
    next_discord_id = 700000000000000000
    for title, _prefix, size in COURSES:
        roster = []
        for i in range(size):
            next_discord_id += rng.randrange(11, 999)
            person = {
                "discord_id": next_discord_id,
                "handle": f"student{len(everyone) + 1:03d}",
                "person_id": f"per_{len(everyone) + 1:03d}",
                "course": title,
            }
            roster.append(person)
            everyone.append(person)
        students[title] = roster

    # Staff by membership, not by name: the handle matches no override.
    owner = {
        "discord_id": 700999999999999999,
        "handle": "prof.rivera",
        "person_id": "per_owner",
        "course": COURSES[0][0],
    }
    testbot = {
        "discord_id": 700999999999999998,
        "handle": "testbot",
        "person_id": "per_testbot",
        "course": COURSES[0][0],
    }
    everyone += [owner, testbot]
    # Students that look like staff but are not (see the module docstring).
    revoked_person = students[COURSES[1][0]][1]
    other_org_person = students[COURSES[2][0]][1]

    # Who actually uses the bot: a share of each roster, varying by course, so
    # adoption is something to measure rather than a foregone 100%.
    uptake = {
        "Software Engineering": 0.62,
        "Agile Software Development & DevOps": 0.71,
        "Introduction to Programming": 0.48,
        "Web Design": 0.30,
    }
    active = {
        title: students[title][: max(1, int(len(students[title]) * uptake[title]))]
        for title, _, _ in COURSES
    }

    prefix_of = {title: prefix for title, prefix, _ in COURSES}
    course_ids = {title: f"crs_{i}" for i, (title, _, _) in enumerate(COURSES, start=1)}

    # ── Historical sessions (legacy bot, Discord only) ────────────────────
    historical = []
    for start, end in (FALL_2025, SPRING_2026):
        historical += build_sessions(
            rng, active, [c[0] for c in COURSES], start, end, ["discord"]
        )
    # The cutover gap: a few days of September 2026 the importer never picked up.
    cutover = build_sessions(
        rng, active, [c[0] for c in COURSES], FALL_2026_START, date(2026, 9, 8), ["discord"]
    )

    # ── This term (platform), across all three surfaces ───────────────────
    this_term = build_sessions(
        rng,
        active,
        [c[0] for c in COURSES],
        FALL_2026_START,
        AS_OF,
        {"discord": 6, "web": 3, "mcp": 1},
    )
    # The course owner uses it everywhere (ANLY-9). Historical sessions are on
    # Discord only (and so appear in the legacy file); this term's are spread
    # over all three surfaces, in shared and in students' private channels.
    course_names = [c[0] for c in COURSES]
    staff_topics = list(STAFF_PROMPTS)

    def owner_session(when, course, surface, kind, topic):
        roster = active[course]
        session = MockSession(
            student=owner, course=course, surface=surface, started=when,
            turns=rng.choice([1, 1, 2, 3]), topic=topic, channel_kind=kind, staff=True,
            channel_name=rng.choice(roster)["handle"] if kind == "STUDENT" else "",
        )
        session.messages = build_messages(rng, session)
        return session

    for i, (day, course) in enumerate(
        (d, c) for d in (date(2025, 10, 8), date(2026, 2, 11), date(2026, 3, 18)) for c in course_names[:2]
    ):
        historical.append(
            owner_session(datetime(day.year, day.month, day.day, 10 + i, 15), course, "discord",
                          ["GLOBAL", "STUDENT"][i % 2], staff_topics[i % len(staff_topics)])
        )
    for i in range(12):
        course = course_names[i % len(course_names)]
        surface = ["discord", "discord", "web", "mcp", "discord", "web"][i % 6]
        this_term.append(
            owner_session(
                datetime(2026, 9, 3 + (i * 2) % 22, 9 + i % 8, 5 + i), course, surface,
                ["GLOBAL", "STUDENT"][i % 2] if surface == "discord" else "GLOBAL",
                staff_topics[i % len(staff_topics)],
            )
        )
    # A test rig also posts, and is dropped from every aggregate.
    session = MockSession(
        student=testbot, course=COURSES[0][0], surface="web", started=datetime(2026, 9, 11, 16, 0),
        turns=2, topic="Greetings & bot questions", channel_kind="GLOBAL",
    )
    session.messages = build_messages(rng, session)
    this_term.append(session)

    # ── Write the legacy database ─────────────────────────────────────────
    legacy = sqlite3.connect(legacy_path)
    legacy.executescript(LEGACY_DDL)
    user_rows, user_ids = [], {}
    for i, person in enumerate(everyone, start=1):
        user_ids[person["discord_id"]] = i
        user_rows.append(
            (
                i,
                "2025-08-25 09:00:00",
                "2025-08-25 09:00:00",
                person["discord_id"],
                person["handle"],
                f"{person['handle']}@example.edu",
                "Last",
                "First",
                person["handle"],
            )
        )
    legacy.executemany("INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)", user_rows)

    legacy_messages = []
    message_id = 0
    for session in historical + cutover:
        student, course = session.student, session.course
        category = f"{prefix_of[course]} - {session.channel_kind}"
        channel = (
            "general"
            if session.channel_kind == "GLOBAL"
            else (
                (session.channel_name or student["handle"])
                if session.channel_kind == "STUDENT"
                else "team-1"
            )
        )
        for when, direction, content in session.messages:
            message_id += 1
            stamp = when.strftime("%Y-%m-%d %H:%M:%S.%f")
            legacy_messages.append(
                (message_id, stamp, stamp, content, category, channel, direction,
                 user_ids[student["discord_id"]])
            )
    legacy.executemany("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)", legacy_messages)
    legacy.commit()
    legacy.close()

    # ── Write the current database ────────────────────────────────────────
    current = sqlite3.connect(current_path)
    current.executescript(CURRENT_DDL)
    now_ms = ms(datetime(2026, 9, 1, 8, 0))
    current.execute("INSERT INTO organizations VALUES (?,?,?)", (ORG_ID, "Mock University", now_ms))
    current.executemany(
        "INSERT INTO courses VALUES (?,?,?,?,?,?)",
        [(course_ids[t], ORG_ID, "prj_1", t, 1, now_ms) for t, _, _ in COURSES],
    )

    # One student is soft-deleted (asked for their data to be removed) and must
    # vanish from every aggregate.
    deleted_person = students[COURSES[2][0]][0]
    people_rows, identity_rows = [], []
    for i, person in enumerate(everyone, start=1):
        deleted_at = ms(datetime(2026, 9, 20, 12, 0)) if person is deleted_person else None
        people_rows.append(
            (person["person_id"], ORG_ID, person["handle"], f"{person['handle']}@example.edu",
             "First", "Last", person["handle"], now_ms, None, None, deleted_at, None, now_ms)
        )
        identity_rows.append(
            (f"pid_{i}", ORG_ID, person["person_id"], "discord", str(person["discord_id"]), now_ms)
        )
    current.executemany(
        "INSERT INTO people VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", people_rows
    )

    # ANLY-9: accounts and memberships. Each of these three people has a web
    # identity naming an account; only the owner's membership makes them staff.
    other_org = "org_other"
    current.execute("INSERT INTO organizations VALUES (?,?,?)", (other_org, "Another University", now_ms))
    current.executemany(
        "INSERT INTO accounts VALUES (?,?,?)",
        [("acc_owner", "rivera@example.edu", "Prof. Rivera"),
         ("acc_revoked", "former-ta@example.edu", "Former TA"),
         ("acc_other_org", "owner@other.example.edu", "Other Owner")],
    )
    current.executemany(
        "INSERT INTO memberships VALUES (?,?,?,?)",
        [(ORG_ID, "acc_owner", "owner", None),
         (ORG_ID, "acc_revoked", "assistant", ms(datetime(2026, 9, 12, 12, 0))),
         (other_org, "acc_other_org", "owner", None)],
    )
    for person, account in (
        (owner, "acc_owner"), (revoked_person, "acc_revoked"), (other_org_person, "acc_other_org"),
    ):
        identity_rows.append(
            (f"pid_web_{account}", ORG_ID, person["person_id"], "web", account, now_ms)
        )
    current.executemany("INSERT INTO person_identities VALUES (?,?,?,?,?,?)", identity_rows)

    # Enrolments: every roster member, plus one course where most students
    # never actually used the bot (Web Design), so adoption varies.
    enrolment_rows = []
    for i, person in enumerate(everyone, start=1):
        if person is owner or person is testbot:
            continue
        enrolment_rows.append(
            (f"enr_{i}", ORG_ID, course_ids[person["course"]], person["person_id"],
             rng.choice(["join_link", "discord_role", "self_enrolment"]), now_ms, None, None, None)
        )
    current.executemany("INSERT INTO enrolments VALUES (?,?,?,?,?,?,?,?,?)", enrolment_rows)

    conversations, messages, costs, counters = [], [], [], {}
    conv_ids: dict[tuple, str] = {}
    seq: dict[str, int] = {}

    def conversation_for(person, course, surface, when, deleted=False):
        key = (person["person_id"], course, surface)
        if key not in conv_ids:
            conv_id = f"cnv_{len(conv_ids) + 1:04d}"
            conv_ids[key] = conv_id
            conversations.append(
                [conv_id, ORG_ID, course_ids[course], person["person_id"], surface, None,
                 ms(datetime(2026, 9, 20, 12, 0)) if deleted else None, None, ms(when), ms(when)]
            )
        return conv_ids[key]

    def add_session(session: MockSession, imported: bool):
        """
        Write one session's messages into the platform tables.

        `imported` marks history the importer carried across from the old
        database: identical text and timestamps to the legacy copy (so the
        merge has a duplicate to find) and no cost-ledger rows (the ledger only
        ever recorded live platform traffic).
        """
        student, course, surface = session.student, session.course, session.surface
        deleted = student is deleted_person
        conv_id = conversation_for(student, course, surface, session.started, deleted)
        category = (
            f"{prefix_of[course]} - {session.channel_kind}" if surface == "discord" else None
        )
        channel = None
        if surface == "discord":
            channel = (
                "general" if session.channel_kind == "GLOBAL"
                else (
                    (session.channel_name or student["handle"])
                    if session.channel_kind == "STUDENT"
                    else "team-1"
                )
            )
        for when, direction, content in session.messages:
            seq[conv_id] = seq.get(conv_id, 0) + 1
            mid = f"msg_{len(messages) + 1:06d}"
            messages.append(
                (mid, ORG_ID, conv_id, student["person_id"], course_ids[course],
                 "from_person" if direction == "from" else "to_person", content, surface,
                 channel, category, seq[conv_id], ms(when))
            )
            conversations[[c[0] for c in conversations].index(conv_id)][9] = ms(when)
            if direction == "from":
                day = when.date().isoformat()
                key = (course_ids[course], student["person_id"], day)
                counters[key] = counters.get(key, 0) + 1
                # The cost ledger only exists on the platform, so only
                # this term's live traffic carries a cost row — imported
                # history does not, and the report says so.
                if not imported:
                    tokens_in = rng.randrange(900, 3200)
                    tokens_out = rng.randrange(120, 700)
                    usd_micros = int(tokens_in / 1000 * 2.0 * 1000 + tokens_out / 1000 * 8.0 * 1000)
                    costs.append(
                        (f"cst_{len(costs) + 1:06d}", ORG_ID, course_ids[course],
                         student["person_id"], "gpt-4.1", tokens_in, tokens_out, usd_micros,
                         "measured", surface, ms(when))
                    )

    # The importer brought the historical Discord traffic across, but not the
    # cutover days — exactly the overlap the merge has to reconcile.
    for session in historical:
        add_session(session, imported=True)
    for session in this_term:
        add_session(session, imported=False)

    current.executemany(
        "INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)", [tuple(c) for c in conversations]
    )
    current.executemany("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", messages)
    current.executemany("INSERT INTO cost_ledger_entries VALUES (?,?,?,?,?,?,?,?,?,?,?)", costs)
    current.executemany(
        "INSERT INTO usage_counters VALUES (?,?,?,?,?)",
        [(ORG_ID, c, p, d, n) for (c, p, d), n in counters.items()],
    )
    current.commit()
    current.close()

    combined_path = out_dir / "combined.db"
    imported = write_combined(legacy_path, current_path, combined_path)
    print(f"combined → {combined_path}  ({imported:,} imported legacy messages)")
    print(f"legacy  → {legacy_path}  ({len(legacy_messages):,} messages)")
    print(f"current → {current_path}  ({len(messages):,} messages, {len(costs):,} cost rows)")
    print(f"as-of {AS_OF}  ·  {len(everyone) - 2} students  ·  {len(COURSES)} courses")


if __name__ == "__main__":
    main()
