"""
Assemble the Markdown report.

The report is written to be *parsed*, not only read: it is the source the deck
is generated from (via The Slide Machine), so its structure is a contract.

    # Part N — <Part title>          a section of the talk
    ## S<nn> · <Slide title>         exactly one slide
    **Takeaway:** ...                the one line that goes on the slide
    ![...](figures/<name>.png)       at most one figure per slide
    *Figure: <caption> (n = ...).*   every figure caption states its n
    | ... |                          the figure's data table (also the a11y relief)
    **Speaker notes:** ...           spoken, not shown
    **Confidence:** measured | indicative | speculative

`Confidence` is the field that keeps the deck honest, and it is machine-read so
that speculative slides can be styled differently from measured ones:

* **measured** — a count straight out of the data.
* **indicative** — a real pattern, but on an n small enough that it could move.
* **speculative** — an interpretation. The evidence is stated; the claim is ours.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

CONFIDENCE_LEVELS = ("measured", "indicative", "speculative")


def fmt_int(value) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return "—"
    return f"{int(round(float(value))):,}"


def fmt_share(value, denominator=None) -> str:
    """
    A share, expressed as a count-of-count when the denominator is small.

    Below 30 the plan calls for "11 of 24" rather than "45.8%": the percentage
    implies a precision that a two-dozen-student cohort cannot support.
    """
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return "—"
    return f"{float(value) * 100:.0f}%"


def fmt_count_of(numerator, denominator) -> str:
    if denominator is None or (isinstance(denominator, float) and pd.isna(denominator)):
        return f"{fmt_int(numerator)} (denominator unknown)"
    if float(denominator) < 30:
        return f"{fmt_int(numerator)} of {fmt_int(denominator)}"
    share = float(numerator) / float(denominator) if float(denominator) else float("nan")
    return f"{fmt_int(numerator)} of {fmt_int(denominator)} ({fmt_share(share)})"


def fmt_num(value, digits: int = 1) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return "—"
    return f"{float(value):.{digits}f}"


def markdown_table(frame: pd.DataFrame, index_label: str | None = None, max_rows: int = 40) -> str:
    """A GitHub-flavoured table, NA rendered as an em dash rather than 'NaN'."""
    if frame is None or frame.empty:
        return "_No rows._"
    working = frame.copy()
    if index_label is not None:
        working = working.reset_index().rename(columns={working.index.name or "index": index_label})
    working = working.head(max_rows)

    def cell(value):
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return "—"
        if isinstance(value, float):
            return f"{value:,.2f}" if abs(value) < 1000 else f"{value:,.0f}"
        return str(value)

    header = "| " + " | ".join(str(c) for c in working.columns) + " |"
    rule = "| " + " | ".join("---" for _ in working.columns) + " |"
    rows = [
        "| " + " | ".join(cell(v) for v in row) + " |"
        for row in working.itertuples(index=False, name=None)
    ]
    return "\n".join([header, rule, *rows])


@dataclass
class Slide:
    number: int
    title: str
    takeaway: str = ""
    body: str = ""
    figure: Path | None = None
    figure_caption: str = ""
    table: str = ""
    notes: str = ""
    confidence: str = "measured"

    def render(self, figures_prefix: str = "figures") -> str:
        parts = [f"## S{self.number:02d} · {self.title}", ""]
        if self.takeaway:
            parts += [f"**Takeaway:** {self.takeaway}", ""]
        if self.body:
            parts += [self.body.strip(), ""]
        if self.figure is not None:
            parts += [f"![{self.title}]({figures_prefix}/{Path(self.figure).name})", ""]
            if self.figure_caption:
                parts += [f"*Figure: {self.figure_caption}*", ""]
        if self.table:
            parts += [self.table, ""]
        if self.notes:
            parts += [f"**Speaker notes:** {self.notes}", ""]
        parts += [f"**Confidence:** {self.confidence}", ""]
        return "\n".join(parts)


@dataclass
class Report:
    title: str
    subtitle: str = ""
    preamble: str = ""
    parts: list[tuple[str, list[Slide]]] = field(default_factory=list)
    _counter: int = 0

    def part(self, title: str) -> str:
        self.parts.append((title, []))
        return title

    def slide(self, title: str, **kwargs) -> Slide:
        """Append a slide to the current part; `confidence` is validated, not trusted."""
        if not self.parts:
            self.part("Findings")
        confidence = kwargs.get("confidence", "measured")
        if confidence not in CONFIDENCE_LEVELS:
            raise ValueError(f"confidence must be one of {CONFIDENCE_LEVELS}, got {confidence!r}")
        self._counter += 1
        slide = Slide(number=self._counter, title=title, **kwargs)
        self.parts[-1][1].append(slide)
        return slide

    def render(self, figures_prefix: str = "figures") -> str:
        out = [f"# {self.title}", ""]
        if self.subtitle:
            out += [f"_{self.subtitle}_", ""]
        if self.preamble:
            out += [self.preamble.strip(), ""]
        for part_title, slides in self.parts:
            out += [f"# Part — {part_title}", ""]
            out += [slide.render(figures_prefix) for slide in slides]
        return "\n".join(out).rstrip() + "\n"

    def write(self, path: Path, figures_prefix: str = "figures") -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.render(figures_prefix))
        return path

    def slide_count(self) -> int:
        return self._counter
