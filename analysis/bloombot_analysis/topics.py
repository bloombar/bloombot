"""
What each session was about.

Every session gets exactly one label (ANLY-10) from the set that matches its
role: `config.STUDENT_TOPICS` for students, `config.STAFF_TOPICS` (what an
instructor was using the bot *for*) for staff. Two classifiers are available:

* **`openai`** — the same approach `analytics.ipynb` has always used: one
  `gpt-4o-mini` call per session, temperature 0. Needs `OPENAI_API_KEY`.
* **`keyword`** — a transparent rule-based fallback, one rule list per role. It is what the mock run
  uses (no API key, no spend, deterministic output) and it is also a useful
  sanity check on the model: where the two disagree wildly, the label set is
  probably the problem.

Results are cached on disk keyed by a hash of the session's own text, so a
re-run never re-pays for a session already classified, and so the cache
survives re-sessionising (the old cache in `data/topic_classifications.json`
was keyed by a positional conversation number, which silently went stale the
moment the grouping changed). The key also names the label set and its version
(`v2-student`, `v2-staff`), so a label made under the old nine-label set is
never reused.

**The classifier is not ground truth.** `audit_sample()` draws a sample for
hand-checking and `agreement_rate()` turns the hand labels into the one number
the report must publish beside every topic chart.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

import pandas as pd

from .config import CONFIG, STAFF_TOPICS, STUDENT_TOPICS, Config, topic_set_key, topics_for

CLASSIFICATION_MODEL = "gpt-4o-mini"


def session_texts(tagged_messages: pd.DataFrame) -> pd.DataFrame:
    """
    Flatten each session into one 'Student: ... / Bot: ...' transcript.

    Discord @mentions are stripped: they are noise to a classifier and they are
    identifying detail we do not want leaving the analysis environment.
    """
    if tagged_messages.empty:
        return pd.DataFrame(columns=["session_id", "role", "course", "text", "student_text"])

    def clean(text: str) -> str:
        text = re.sub(r"<@!?\d+>", "", str(text))
        # A leading @name is the bot being addressed; @everyone / @here is kept
        # because it is what marks an announcement.
        text = re.sub(r"^@(?!everyone\b|here\b)\S+\s*,?\s*", "", text)
        return text.strip()

    rows = []
    for session_id, group in tagged_messages.sort_values(["session_id", "ts"]).groupby(
        "session_id", sort=False
    ):
        lines = [
            ("Student: " if d == "from" else "Bot: ") + clean(c)
            for c, d in zip(group["content"], group["direction"])
        ]
        # `student_text` is the student's side alone. The keyword classifier
        # reads only this: the bot's replies quote the syllabus, name tools and
        # mention deadlines whatever the question was, so including them drags
        # nearly every session toward whichever topics the reply templates
        # happen to mention.
        student_only = [
            clean(c) for c, d in zip(group["content"], group["direction"]) if d == "from"
        ]
        rows.append(
            {
                "session_id": session_id,
                "role": group["role"].iloc[0] if "role" in group else "student",
                "course": group["course"].iloc[0],
                "text": "\n".join(lines),
                "student_text": "\n".join(student_only),
            }
        )
    return pd.DataFrame(rows)


def text_key(text: str) -> str:
    """Cache key: the session's content, not its position in any ordering."""
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:20]


def load_cache(path: Path | None = None) -> dict[str, str]:
    path = Path(path or CONFIG.topic_cache)
    if path.exists():
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def save_cache(cache: dict[str, str], path: Path | None = None) -> None:
    path = Path(path or CONFIG.topic_cache)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, indent=2, sort_keys=True))


# ── Keyword classifier ────────────────────────────────────────────────────
# One ordered rule list per role. The first rule whose pattern matches wins, so
# order carries meaning: narrow, unmistakable signals come first, broad words
# (a bare "function", "what is") come late, and greetings come last so
# "hi, when is project 1 due" is a deadline question. A label may appear in
# more than one rule. Rules read only the sender's own words (`student_text`).
STUDENT_RULES: list[tuple[str, str]] = [
    # Pasted quiz items are long and mention anything, so their stock phrases win.
    ("Quiz & exam questions", r"\b(which of the following|select all that apply|true or false|multiple[- ]choice|answer choices?|correct answer)\b"),
    ("Discord & platform help", r"\b(discord|channels?|team chat|connect(ing|ed)? (my |an |the )?(account|discord|github)|(link|log|sign)(ing)? ?(in|into|to)? (my |the )?account|invite link|join link|notifications?|dm me|direct message)\b"),
    ("Course policies", r"\b(extensions?|late (work|submissions?|penalt\w*|days?|policy)|attendance|absen(t|ce)|plagiari\w+|academic (integrity|honesty)|cheat\w*|polic(y|ies)|allowed|penalty|unable to attend|chat ?gpt|ai (use|tools?|policy)|use (of )?ai|make-?ups?|excused|accommodations?|withdraw|drop the course)\b"),
    ("Deadlines & schedule", r"\b(due|deadlines?|when is|when are|when does|when do|what time|what day|schedule[ds]?|calendar|syllabus|next class|class time|office hours?|due date)\b"),
    ("Grades & grading", r"\b(grades?|graded|grading|rubric|gpa|curve|weighted|how many points|points? (off|deducted|possible|for)|worth|my score|feedback on)\b"),
    ("Git & GitHub workflow", r"\b(git|github|forks?|branch(es|ing)?|commits?|push(ed|ing)?|pull( requests?)?|merge( conflicts?)?|clone|rebase|repos?|repositor(y|ies)|stash|checkout|gitignore|prs?)\b"),
    ("Code & debugging", r"(\b(errors?|exceptions?|traceback|bugs?|debug\w*|stack ?trace|syntax|undefined|segfault|compil(e|er|ing)|runtime|stuck|(run|ran|running) (my|the) code)\b|\bdef \w+\(|```|\bconsole\.log|\bprint\(|[{};]\s*$|(isn'?t|not|doesn'?t|won'?t) (\w+ )?(working|work|run|pass|compile)\b|\btests? (fail\w*|is failing))"),
    ("Tools, setup & deployment", r"\b(install\w*|set ?up|docker|mongo\w*|atlas|digital ?ocean|droplet|deploy\w*|heroku|aws|vercel|netlify|npm|pip|venv|node(js)?|environment|\.env|vs ?code|terminal|command line|localhost|ports?|ssh|hosting|pylint|lint\w*|yaml|continuous integration|build script|packages?|readme|database|postgres\w*|mysql|sqlite|api keys?|containers?|ide)\b"),
    ("Project & assignment requirements", r"\b(requirements?|deliverables?|assignments?|homework|hw ?\d+|project \d+|project (requirements?|proposal|scope|ideas?|brief)|proposal|scope|sprints?|project ?\d+|vision statement|project board|subsystems?|user stor(y|ies)|wireframes?|backlog|epics?|milestones?|mock-?ups?|prototype|use cases?|labs?|exercises?|starter code|problem set|capstone|submit|submission)\b"),
    ("Team coordination", r"\b(teams?|team-?mates?|group (members?|number|work|leader|assign\w*)|(assigned|join|in|my|our|a|which|what|no) groups?|groups?\b(?! by)|partners?|pair(ed)? up|stand-?up|scrum master|product owner)\b"),
    ("Quiz & exam questions", r"\b(quiz(zes)?|exams?|midterms?|finals?|test prep|study guide)\b"),
    ("Course concepts", r"\b(explain|what is|what are|how does|how do|difference between|concepts?|lectures?|slides?|chapters?|topics?|understand|why does|defin(e|ition)|meaning of|example of|stakeholders?|agile|scrum|kanban|oop|polymorphism|inherit\w*|recursion|algorithms?|big o|apis?|rest|design patterns?|class diagram|uml|waterfall|covered|notes?)\b"),
    ("Greetings & bot questions", r"\b(hi|hello|hey|thanks?|thank you|are you (there|a real|a bot|an ai|human|working)|who are you|your (name|profile)|good (morning|afternoon|evening)|how old are (you|u)|do you (like|have|know)|previous instructions|recipe|test(ing)?)\b"),
]

STAFF_RULES: list[tuple[str, str]] = [
    ("Announcements", r"(@everyone|@here|\bannouncement\b|\b(is|are) (now )?available\b|\bwelcome (back |to )|\bplease (remember|note|join|check)\b|\breminder:|<@&\d+>|forms\.gle)"),
    ("Directing students", r"(<#\d+>|pinned message|see my note|\b((please )?(make|create|open) (a )?(new )?(private )?(channels?|groups?|teams?|roles?)|(tell|help|remind|show|guide|walk|assist) (the |this |that )?(students?|him|her|them|class)|help (out )?\w+ (with|find|understand|get))\b)"),
    ("Course setup", r"\b(renam\w+|course (name|title|settings?|instructions?|materials?)|upload\w*|attachments?|enable|disable|configur\w+|settings?|system prompt|instructions for the bot|add (a )?(student|ta|assistant)|enrol\w*|roster)\b"),
    ("Course content & policy lookup", r"\b(polic(y|ies)|due|deadlines?|when is|when are|syllabus|schedule|grading|extensions?|late|gradebook|grades?|points|credit|quizzes|private channels?|permissions?|what does the course|according to|rubric|requirements?|assignments?|project \d+|office hours?|attendance)\b"),
    ("Demonstrating to class", r"\b((to|for) (the )?(class|students|everyone|you all|them)|demo(nstrat\w*)?|in front of|explain|defin(e|ition)|describe|what is an?|what are|give (me )?an example|how does|what (is|does)|how (would|do) (i|you)|why (should|does|do)|is it possible)\b"),
    ("Testing the bot", r"\b(are you (there|working|online|a bot|real)|do you (know|remember)|who (am i|are you|do you work for)|what'?s your name|can you (remember|hear)|remember (this|that|my)|test(ing)?|hello|hi|hey|ping|what model|what can you do|are you \w+|do you \w+|your (most recent|last|previous) message|you (said|told|wrote)|recipe|ignore (all )?previous)\b"),
]

KEYWORD_RULES: dict[str, list[tuple[str, str]]] = {"student": STUDENT_RULES, "staff": STAFF_RULES}

# One line per label for the model prompt, in the same order as the label sets.
STUDENT_DESCRIPTIONS: dict[str, str] = {
    "Project & assignment requirements": "what a project or assignment asks for: scope, subsystems, wireframes, user stories, backlog, deliverables",
    "Deadlines & schedule": "when something is due, class times, the calendar or syllabus dates",
    "Grades & grading": "how work is graded, rubric, points, a grade the student received",
    "Course policies": "extensions, late work, attendance, AI use, academic integrity and other rules",
    "Course concepts": "explanations of subject-matter ideas taught in the course",
    "Quiz & exam questions": "quiz or exam items, often pasted in, or study questions about a test",
    "Code & debugging": "the student's own code, errors, failing tests, how to fix a bug",
    "Git & GitHub workflow": "git commands, forks, branches, pull requests, merge problems, repositories",
    "Tools, setup & deployment": "installing or configuring tools, databases, Docker, hosting and deployment",
    "Team coordination": "teammates, group assignment, splitting work, team logistics",
    "Discord & platform help": "finding channels, connecting an account, using Discord or the Bloombot platform",
    "Greetings & bot questions": "hellos, thanks, testing whether the bot is there, questions about the bot itself",
    "Other": "anything that fits none of the above",
}

STAFF_DESCRIPTIONS: dict[str, str] = {
    "Testing the bot": "checking the bot works or what it knows: 'are you there', 'who am I', memory tests",
    "Demonstrating to class": "asking the bot something to show students how it answers, often explaining a concept aloud",
    "Announcements": "messages written for the whole class, such as @everyone notices",
    "Directing students": "telling the bot to do something for students: make a channel, help a named student",
    "Course content & policy lookup": "the instructor looking up a policy, a date, an assignment or course content",
    "Course setup": "configuring the course or the bot: renaming, instructions, materials, enrolment",
    "Other": "anything that fits none of the above",
}


def classify_keyword(text: str, role: str = "student") -> str:
    """The first matching rule's label for the role's set, else 'Other'."""
    lowered = text.lower()
    for topic, pattern in KEYWORD_RULES["staff" if role == "staff" else "student"]:
        if re.search(pattern, lowered):
            return topic
    return "Other"


# ── OpenAI classifier ─────────────────────────────────────────────────────


def classify_openai(text: str, course: str, role: str = "student") -> str:
    """One classification call. Raises if the OpenAI client or key is missing."""
    from openai import OpenAI  # imported lazily: the keyword path needs no SDK

    labels = topics_for(role)
    descriptions = STAFF_DESCRIPTIONS if role == "staff" else STUDENT_DESCRIPTIONS
    topic_list = "\n".join(f"- {t}: {descriptions[t]}" for t in labels)
    who = (
        "Classify this conversation between an instructor and a course bot for the course "
        f"{course!r}, by what the instructor was using the bot for."
        if role == "staff"
        else f"Classify this student conversation with a course bot for the course {course!r}."
    )
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    response = client.chat.completions.create(
        model=CLASSIFICATION_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    f"{who} Choose exactly one topic from this list:\n{topic_list}\n\n"
                    "Reply with only the topic name, nothing else."
                ),
            },
            {"role": "user", "content": text[:12000]},
        ],
        max_tokens=20,
        temperature=0,
    )
    label = (response.choices[0].message.content or "").strip()
    return label if label in labels else "Other"


# ── Driver ────────────────────────────────────────────────────────────────


def classify_sessions(
    texts: pd.DataFrame,
    method: str = "keyword",
    config: Config | None = None,
    use_cache: bool = True,
) -> pd.DataFrame:
    """
    Label every session. Returns `texts` with `topic` and `topic_method` added.

    Each session is classified under its own role's label set (a `role` column;
    absent means every session is a student's). `method='openai'` falls back to
    the keyword classifier for any session whose API call fails, and records
    which classifier produced each label, so a partially-failed run is visible
    in the output rather than silently mixed.
    """
    config = config or CONFIG
    if texts.empty:
        return texts.assign(topic=pd.Series(dtype="object"), topic_method=pd.Series(dtype="object"))

    cache = load_cache(config.topic_cache) if use_cache else {}
    student_texts = texts["student_text"] if "student_text" in texts else texts["text"]
    roles = texts["role"] if "role" in texts else pd.Series("student", index=texts.index)
    labels, methods = [], []
    for text, student_text, course, role in zip(texts["text"], student_texts, texts["course"], roles):
        # Key on the label set's version and the text the chosen method actually
        # reads: the sets never collide, an old-version entry is never a hit, and
        # a hit always corresponds to the same input the label was derived from.
        key = f"{topic_set_key(role)}:{method}:{text_key(text if method == 'openai' else student_text)}"
        if key in cache:
            labels.append(cache[key])
            methods.append(method + "-cached")
            continue
        if method == "openai":
            try:
                label = classify_openai(text, course, role)
                used = "openai"
            except Exception:  # noqa: BLE001 — a failed call must not lose the run
                label = classify_keyword(student_text, role)
                used = "keyword-fallback"
        else:
            label = classify_keyword(student_text, role)
            used = "keyword"
        cache[key] = label
        labels.append(label)
        methods.append(used)

    if use_cache:
        save_cache(cache, config.topic_cache)

    return texts.assign(topic=labels, topic_method=methods)


def topic_counts(sessions: pd.DataFrame, labels: list[str] | None = None) -> pd.DataFrame:
    """Sessions per topic in a label set (students' by default), every label present even at zero."""
    labels = labels or STUDENT_TOPICS
    if sessions.empty or "topic" not in sessions:
        return pd.DataFrame({"topic": labels, "sessions": [0] * len(labels)})
    counts = sessions["topic"].value_counts().reindex(labels, fill_value=0)
    return pd.DataFrame({"topic": counts.index, "sessions": counts.values})


def topic_by(sessions: pd.DataFrame, column: str, labels: list[str] | None = None) -> pd.DataFrame:
    """Topic × any dimension (course, term, surface) as a wide count table."""
    labels = labels or STUDENT_TOPICS
    if sessions.empty or "topic" not in sessions:
        return pd.DataFrame(index=pd.Index([], name=column), columns=labels)
    return (
        sessions.groupby([column, "topic"])
        .size()
        .unstack(fill_value=0)
        .reindex(columns=labels, fill_value=0)
    )


def audit_sample(sessions: pd.DataFrame, n: int = 30, seed: int = 20260925) -> pd.DataFrame:
    """
    Draw a reproducible sample to hand-check the classifier against.

    Up to `n` sessions are drawn per role, so each label set gets its own
    audit. Written out as a CSV with an empty `hand_label` column; fill it in,
    read it back, and `agreement_rate()` gives the number that goes on the
    methodology slide.
    """
    if sessions.empty:
        return pd.DataFrame(columns=["session_id", "role", "course", "topic", "hand_label", "text"])
    frame = sessions if "role" in sessions else sessions.assign(role="student")
    parts = [
        group.sample(min(n, len(group)), random_state=seed)
        for _, group in frame.groupby("role", sort=True)
    ]
    sample = pd.concat(parts)
    return sample[["session_id", "role", "course", "topic", "text"]].assign(hand_label="")


def agreement_rate(audited: pd.DataFrame) -> dict:
    """
    Agreement between the classifier and the hand labels in a completed audit.

    `by_role` repeats the rate for each role present, since the two label sets
    are different instruments.
    """
    filled = audited[audited["hand_label"].astype(str).str.strip() != ""]
    if filled.empty:
        return {"checked": 0, "agreed": 0, "rate": float("nan")}
    agreed = int((filled["topic"] == filled["hand_label"]).sum())
    result = {"checked": int(len(filled)), "agreed": agreed, "rate": agreed / len(filled)}
    if "role" in filled:
        result["by_role"] = {
            role: {
                "checked": int(len(g)),
                "agreed": int((g["topic"] == g["hand_label"]).sum()),
                "rate": float((g["topic"] == g["hand_label"]).mean()),
            }
            for role, g in filled.groupby("role")
        }
    return result
