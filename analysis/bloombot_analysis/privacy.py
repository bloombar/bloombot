"""
What leaves the analysis environment.

Two rules from §5 of `docs/USAGE_REPORT_PLAN.md`, implemented once so no
notebook can forget them:

1. **No identity in output.** Names, Discord handles and person keys are
   replaced by stable pseudonyms ("Student 07") before anything is written to
   `tmp/analysis/out/`. No chart in the report is per-student anyway, but a
   pseudonym means an accidental one is harmless.
2. **Small cells are suppressed.** With cohorts this small, a course × topic
   cell covering one or two students is effectively a named individual, so any
   cell below `config.min_cell_students` distinct students is blanked.

`redact_quote()` handles the one place raw text reaches the page: the
illustrative exchanges. It is a mechanical scrub, not a guarantee — every quote
is still read by a human and paraphrased before it goes in the deck.
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd

from .config import CONFIG, Config


def pseudonyms(messages: pd.DataFrame) -> dict[str, str]:
    """
    Map each person key to 'Student NN', numbered by first appearance.

    Deterministic for a given dataset, so two runs produce the same labels and
    a figure can be regenerated without renumbering everyone.
    """
    if messages.empty:
        return {}
    order = messages.sort_values("ts").drop_duplicates("person_key")["person_key"]
    return {key: f"Student {i:02d}" for i, key in enumerate(order, start=1)}


def apply_pseudonyms(frame: pd.DataFrame, mapping: dict[str, str]) -> pd.DataFrame:
    """Replace `person_key` with its pseudonym and drop any handle column."""
    out = frame.copy()
    if "person_key" in out:
        out["person_key"] = out["person_key"].map(mapping).fillna("Student ??")
    return out.drop(columns=[c for c in ("handle", "display_name", "email") if c in out])


def suppress_small_cells(
    table: pd.DataFrame, student_counts: pd.DataFrame, config: Config | None = None
) -> pd.DataFrame:
    """
    Blank any cell backed by fewer than `min_cell_students` distinct students.

    `table` holds the values to publish and `student_counts` the distinct-student
    count behind each of them, in the same shape. Suppressed cells become NA,
    which charts render as a gap and the Markdown table renders as '—'.
    """
    config = config or CONFIG
    if table.empty:
        return table
    aligned = student_counts.reindex(index=table.index, columns=table.columns).fillna(0)
    return table.where(aligned >= config.min_cell_students)


def suppression_note(
    table: pd.DataFrame, suppressed: pd.DataFrame, config: Config | None = None
) -> str:
    """One sentence naming how much of a table was withheld, for its caption."""
    config = config or CONFIG
    total = int(table.notna().sum().sum())
    kept = int(suppressed.notna().sum().sum())
    hidden = total - kept
    if hidden <= 0:
        return ""
    return (
        f"{hidden} of {total} cells are suppressed: fewer than "
        f"{config.min_cell_students} distinct students behind them."
    )


# Patterns that most often carry identity in a student message. Deliberately
# blunt — over-redaction costs a little readability, under-redaction costs a
# student their privacy.
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
_MENTION = re.compile(r"<@!?\d+>|@[A-Za-z0-9_.#-]{2,}")
_URL = re.compile(r"https?://\S+")
_LONG_NUMBER = re.compile(r"\b\d{6,}\b")


def redact_quote(text: str, max_chars: int = 320) -> str:
    """Scrub the obvious identifiers from a quotable exchange and trim it."""
    out = _EMAIL.sub("[email]", str(text))
    out = _MENTION.sub("[@student]", out)
    out = _URL.sub("[link]", out)
    out = _LONG_NUMBER.sub("[id]", out)
    out = re.sub(r"\s+", " ", out).strip()
    return out if len(out) <= max_chars else out[: max_chars - 1].rstrip() + "…"


def quote_candidates(
    session_texts: pd.DataFrame, sessions: pd.DataFrame, per_topic: int = 1, seed: int = 20260925
) -> pd.DataFrame:
    """
    A short, redacted exchange per topic, for the 'in their words' slide.

    These are *candidates*: the plan requires a human to paraphrase them before
    they reach the deck, and the report labels them as such.
    """
    if session_texts.empty or sessions.empty:
        return pd.DataFrame(columns=["topic", "course", "quote"])
    # The caller may already have merged the session measures onto the texts
    # (notebook 03 does), so only pull across what is actually missing —
    # merging blindly produces `messages_x`/`messages_y` and loses the column.
    wanted = [c for c in ("prompts", "messages") if c not in session_texts.columns]
    joined = (
        session_texts.merge(sessions[["session_id", *wanted]], on="session_id", how="inner")
        if wanted
        else session_texts.copy()
    )
    if "topic" not in joined:
        return pd.DataFrame(columns=["topic", "course", "quote"])
    # Prefer short exchanges: they quote cleanly and carry less incidental detail.
    joined = joined[joined["messages"] <= 6]
    picked = (
        joined.sort_values("messages")
        .groupby("topic", group_keys=False)
        .head(per_topic)
        .sample(frac=1.0, random_state=seed)
    )
    return pd.DataFrame(
        {
            "topic": picked["topic"],
            "course": picked["course"],
            "quote": picked["text"].map(redact_quote),
        }
    ).reset_index(drop=True)


def share_or_na(numerator: pd.Series, denominator: pd.Series) -> pd.Series:
    """A share, or NA where the denominator is missing — never a silent zero."""
    return pd.Series(
        np.where(denominator.notna() & (denominator > 0), numerator / denominator, np.nan),
        index=numerator.index,
    )
