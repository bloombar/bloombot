"""
What each session was about.

Every session gets exactly one of the nine labels in `config.TOPICS`. Two
classifiers are available:

* **`openai`** — the same approach `analytics.ipynb` has always used: one
  `gpt-4o-mini` call per session, temperature 0. Needs `OPENAI_API_KEY`.
* **`keyword`** — a transparent rule-based fallback. It is what the mock run
  uses (no API key, no spend, deterministic output) and it is also a useful
  sanity check on the model: where the two disagree wildly, the label set is
  probably the problem.

Results are cached on disk keyed by a hash of the session's own text, so a
re-run never re-pays for a session already classified, and so the cache
survives re-sessionising (the old cache in `data/topic_classifications.json`
was keyed by a positional conversation number, which silently went stale the
moment the grouping changed).

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

from .config import CONFIG, TOPICS, Config

CLASSIFICATION_MODEL = "gpt-4o-mini"


def session_texts(tagged_messages: pd.DataFrame) -> pd.DataFrame:
    """
    Flatten each session into one 'Student: ... / Bot: ...' transcript.

    Discord @mentions are stripped: they are noise to a classifier and they are
    identifying detail we do not want leaving the analysis environment.
    """
    if tagged_messages.empty:
        return pd.DataFrame(columns=["session_id", "course", "text", "student_text"])

    def clean(text: str) -> str:
        text = re.sub(r"<@!?\d+>", "", str(text))
        text = re.sub(r"^@\S+\s*,?\s*", "", text)
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
# Ordered most-specific first: the first family whose pattern matches wins, so
# "when is the project due" lands on deadlines rather than team projects.
KEYWORD_RULES: list[tuple[str, str]] = [
    ("Syllabus, schedule & deadlines", r"\b(due|deadline|extension|late|syllabus|schedule|calendar|when is|exam date|midterm date)\b"),
    ("Grades & assessment", r"\b(grade|graded|grading|rubric|score|points|weight|curve|pass(ed)?|fail(ed)?|feedback on my)\b"),
    ("Professor & office hours", r"\b(office hours?|professor|instructor|ta\b|email you|meet with|appointment)\b"),
    ("Team projects & collaboration", r"\b(team|teammate|group|partner|merge conflict|pull request review|standup|sprint)\b"),
    ("Technical setup & tools", r"\b(install|setup|set up|error|traceback|exception|docker|venv|node|npm|pip|git\b|github|vs ?code|environment|path|port|localhost|deploy|command)\b"),
    ("Assignments & homework", r"\b(assignment|homework|hw\d*|problem set|lab\b|exercise|submit|submission|starter code|requirements? for)\b"),
    ("Resources & references", r"\b(reading|book|tutorial|documentation|docs\b|link|resource|example|reference|article|video)\b"),
    ("Course material & content", r"\b(explain|what is|how does|difference between|concept|lecture|slide|chapter|topic|understand|why does)\b"),
]


def classify_keyword(text: str) -> str:
    lowered = text.lower()
    for topic, pattern in KEYWORD_RULES:
        if re.search(pattern, lowered):
            return topic
    return "Other"


# ── OpenAI classifier ─────────────────────────────────────────────────────


def classify_openai(text: str, course: str) -> str:
    """One classification call. Raises if the OpenAI client or key is missing."""
    from openai import OpenAI  # imported lazily: the keyword path needs no SDK

    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    topic_list = "\n".join("- " + t for t in TOPICS)
    response = client.chat.completions.create(
        model=CLASSIFICATION_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "Classify this student conversation with a course bot for the course "
                    f"{course!r}. Choose exactly one topic from this list:\n{topic_list}\n\n"
                    "Reply with only the topic name, nothing else."
                ),
            },
            {"role": "user", "content": text[:12000]},
        ],
        max_tokens=20,
        temperature=0,
    )
    label = (response.choices[0].message.content or "").strip()
    return label if label in TOPICS else "Other"


# ── Driver ────────────────────────────────────────────────────────────────


def classify_sessions(
    texts: pd.DataFrame,
    method: str = "keyword",
    config: Config | None = None,
    use_cache: bool = True,
) -> pd.DataFrame:
    """
    Label every session. Returns `texts` with `topic` and `topic_method` added.

    `method='openai'` falls back to the keyword classifier for any session whose
    API call fails, and records which classifier produced each label, so a
    partially-failed run is visible in the output rather than silently mixed.
    """
    config = config or CONFIG
    if texts.empty:
        return texts.assign(topic=pd.Series(dtype="object"), topic_method=pd.Series(dtype="object"))

    cache = load_cache(config.topic_cache) if use_cache else {}
    student_texts = texts["student_text"] if "student_text" in texts else texts["text"]
    labels, methods = [], []
    for text, student_text, course in zip(texts["text"], student_texts, texts["course"]):
        # Key on the text the chosen method actually reads, so the two methods
        # never collide in the cache and a hit always corresponds to the same
        # input the label was derived from.
        key = f"{method}:{text_key(text if method == 'openai' else student_text)}"
        if key in cache:
            labels.append(cache[key])
            methods.append(method + "-cached")
            continue
        if method == "openai":
            try:
                label = classify_openai(text, course)
                used = "openai"
            except Exception:  # noqa: BLE001 — a failed call must not lose the run
                label = classify_keyword(student_text)
                used = "keyword-fallback"
        else:
            label = classify_keyword(student_text)
            used = "keyword"
        cache[key] = label
        labels.append(label)
        methods.append(used)

    if use_cache:
        save_cache(cache, config.topic_cache)

    return texts.assign(topic=labels, topic_method=methods)


def topic_counts(sessions: pd.DataFrame) -> pd.DataFrame:
    """Sessions per topic, every label present even at zero."""
    if sessions.empty or "topic" not in sessions:
        return pd.DataFrame({"topic": TOPICS, "sessions": [0] * len(TOPICS)})
    counts = sessions["topic"].value_counts().reindex(TOPICS, fill_value=0)
    return pd.DataFrame({"topic": counts.index, "sessions": counts.values})


def topic_by(sessions: pd.DataFrame, column: str) -> pd.DataFrame:
    """Topic × any dimension (course, term, surface) as a wide count table."""
    if sessions.empty or "topic" not in sessions:
        return pd.DataFrame(index=pd.Index([], name=column), columns=TOPICS)
    return (
        sessions.groupby([column, "topic"])
        .size()
        .unstack(fill_value=0)
        .reindex(columns=TOPICS, fill_value=0)
    )


def audit_sample(sessions: pd.DataFrame, n: int = 30, seed: int = 20260925) -> pd.DataFrame:
    """
    Draw a reproducible sample to hand-check the classifier against.

    Written out as a CSV with an empty `hand_label` column; fill it in, read it
    back, and `agreement_rate()` gives the number that goes on the methodology
    slide.
    """
    if sessions.empty:
        return pd.DataFrame(columns=["session_id", "course", "topic", "hand_label", "text"])
    sample = sessions.sample(min(n, len(sessions)), random_state=seed)
    return sample[["session_id", "course", "topic", "text"]].assign(hand_label="")


def agreement_rate(audited: pd.DataFrame) -> dict:
    """Agreement between the classifier and the hand labels in a completed audit."""
    filled = audited[audited["hand_label"].astype(str).str.strip() != ""]
    if filled.empty:
        return {"checked": 0, "agreed": 0, "rate": float("nan")}
    agreed = int((filled["topic"] == filled["hand_label"]).sum())
    return {"checked": int(len(filled)), "agreed": agreed, "rate": agreed / len(filled)}
