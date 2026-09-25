"""
Chart builders for the report.

Every figure is a PNG embedded in a Markdown document, so the rules that matter
here are the static ones: a fixed categorical slot per series (never a cycled
hue), one axis, recessive grid and spines, thin marks, direct labels rather
than a number on every point, and a legend whenever two or more series share a
panel. Three of the light-mode palette steps sit below 3:1 contrast on the
chart surface, which is why every figure in the report is published with its
data table underneath — that table is the required relief, not a nicety.

Each function saves to `CONFIG.out_dir` and returns the path, so a notebook
cell is one call and the report assembles itself from the filenames.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # notebooks run headless under nbclient
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from .config import (  # noqa: E402
    CONFIG,
    GRID,
    INK_MUTED,
    INK_PRIMARY,
    INK_SECONDARY,
    PALETTE,
    SEQUENTIAL_HUE,
    SURFACE,
)

DPI = 160


def _style(ax, title: str, xlabel: str = "", ylabel: str = "", title_pad: int = 12) -> None:
    """Recessive chrome: the data carries the ink, the frame does not."""
    ax.set_title(title, color=INK_PRIMARY, fontsize=13, pad=title_pad, loc="left")
    ax.set_xlabel(xlabel, color=INK_SECONDARY, fontsize=10)
    ax.set_ylabel(ylabel, color=INK_SECONDARY, fontsize=10)
    ax.tick_params(colors=INK_SECONDARY, labelsize=9, length=0)
    for side, spine in ax.spines.items():
        spine.set_visible(side == "bottom")
        spine.set_color(GRID)
    ax.set_facecolor(SURFACE)
    ax.figure.set_facecolor(SURFACE)


def _save(fig, name: str) -> Path:
    path = CONFIG.figure_path(name)
    fig.tight_layout()
    fig.savefig(path, dpi=DPI, facecolor=SURFACE)
    plt.close(fig)
    return path


def bar_h(
    labels, values, name: str, title: str, xlabel: str = "", color: str | None = None
) -> Path:
    """Horizontal bars for magnitude, sorted by the caller, each value labelled."""
    color = color or PALETTE[0]
    fig, ax = plt.subplots(figsize=(9, max(2.4, 0.42 * len(labels) + 1.2)))
    ypos = np.arange(len(labels))
    ax.barh(ypos, values, height=0.62, color=color)
    ax.set_yticks(ypos, labels)
    ax.invert_yaxis()
    ax.xaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    span = max(values) if len(values) and max(values) else 1
    for y, v in zip(ypos, values):
        ax.text(v + span * 0.012, y, f"{v:,.0f}", va="center", fontsize=9, color=INK_SECONDARY)
    ax.set_xlim(0, span * 1.12)
    _style(ax, title, xlabel)
    return _save(fig, name)


def column_bar(
    labels, values, name: str, title: str, ylabel: str = "", color: str | None = None,
    label_every: int = 1,
) -> Path:
    """
    Vertical columns for an ordered axis — hours of the day, weeks of a term.

    Horizontal bars are for named categories; an ordered sequence reads left to
    right, and turning it on its side makes the reader rotate it back.
    """
    color = color or PALETTE[0]
    fig, ax = plt.subplots(figsize=(11, 3.8))
    xpos = np.arange(len(labels))
    ax.bar(xpos, values, width=0.72, color=color)
    ax.set_xticks(xpos[::label_every], [labels[i] for i in range(0, len(labels), label_every)])
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    span = max(values) if len(values) and max(values) else 1
    # Selective labels: only the columns worth naming, never a number on every bar.
    threshold = span * 0.45
    for x, v in zip(xpos, values):
        if v >= threshold:
            ax.text(x, v + span * 0.02, f"{v:,.0f}", ha="center", fontsize=8.5, color=INK_SECONDARY)
    ax.set_ylim(0, span * 1.15)
    _style(ax, title, "", ylabel)
    return _save(fig, name)


def grouped_bar(
    frame: pd.DataFrame, name: str, title: str, ylabel: str = "", xlabel: str = ""
) -> Path:
    """
    Side-by-side bars: index on x, one fixed-slot colour per column.

    Used for the like-for-like term comparison, where the whole point is that
    the two bars in a pair cover the same number of days of their own term.
    """
    fig, ax = plt.subplots(figsize=(10, 4.6))
    n_series = len(frame.columns)
    width = 0.8 / max(n_series, 1)
    xpos = np.arange(len(frame.index))
    for i, column in enumerate(frame.columns):
        offset = (i - (n_series - 1) / 2) * width
        bars = ax.bar(
            xpos + offset,
            frame[column].values,
            width=width * 0.92,  # the gap between adjacent fills
            color=PALETTE[i % len(PALETTE)],
            label=str(column),
        )
        for bar in bars:
            height = bar.get_height()
            if height:
                ax.text(
                    bar.get_x() + bar.get_width() / 2,
                    height,
                    f"{height:,.0f}",
                    ha="center",
                    va="bottom",
                    fontsize=8.5,
                    color=INK_SECONDARY,
                )
    ax.set_xticks(xpos, [str(i) for i in frame.index])
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    if n_series > 1:
        ax.legend(frameon=False, fontsize=9, labelcolor=INK_SECONDARY)
    _style(ax, title, xlabel, ylabel)
    return _save(fig, name)


def stacked_bar_h(
    frame: pd.DataFrame, name: str, title: str, xlabel: str = "", colors=None
) -> Path:
    """
    Stacked horizontal bars, at most a handful of series.

    A 2px surface-coloured gap separates adjacent segments so a thin slice is
    still visible against its neighbour.
    """
    colors = colors or PALETTE
    fig, ax = plt.subplots(figsize=(9.5, max(2.6, 0.55 * len(frame.index) + 1.4)))
    left = np.zeros(len(frame.index))
    ypos = np.arange(len(frame.index))
    for i, column in enumerate(frame.columns):
        values = frame[column].fillna(0).values.astype(float)
        ax.barh(
            ypos,
            values,
            left=left,
            height=0.6,
            color=colors[i % len(colors)],
            label=str(column),
            edgecolor=SURFACE,
            linewidth=2,
        )
        left = left + values
    ax.set_yticks(ypos, [str(i) for i in frame.index])
    ax.invert_yaxis()
    ax.xaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.legend(frameon=False, fontsize=9, labelcolor=INK_SECONDARY, ncols=min(4, len(frame.columns)),
              loc="lower right", bbox_to_anchor=(1.0, 1.0))
    _style(ax, title, xlabel)
    return _save(fig, name)


def line_series(
    frame: pd.DataFrame,
    name: str,
    title: str,
    ylabel: str = "",
    annotations: list[tuple] | None = None,
) -> Path:
    """
    A weekly time series, one line per column, points shown rather than smoothed.

    `annotations` places a dated vertical rule with a label — used to mark the
    Fall 2026 launch of the web and chat-assistant interfaces, so nobody reads
    our own feature release as a change in student behaviour.
    """
    fig, ax = plt.subplots(figsize=(11, 4.4))
    for i, column in enumerate(frame.columns):
        ax.plot(
            frame.index,
            frame[column].values,
            marker="o",
            markersize=4.5,
            linewidth=2,
            color=PALETTE[i % len(PALETTE)],
            label=str(column),
            markeredgecolor=SURFACE,
            markeredgewidth=1.2,
        )
    for when, label in annotations or []:
        ax.axvline(pd.Timestamp(when), color=INK_MUTED, linewidth=1, linestyle=(0, (4, 3)))
        ax.text(
            pd.Timestamp(when),
            ax.get_ylim()[1],
            f" {label}",
            fontsize=8.5,
            color=INK_MUTED,
            va="top",
        )
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    if len(frame.columns) > 1:
        # Above the plot, not inside it: a legend box dropped on a busy series
        # hides exactly the weeks the audience is being asked to look at.
        ax.legend(
            frameon=False,
            fontsize=9,
            labelcolor=INK_SECONDARY,
            ncols=min(4, len(frame.columns)),
            loc="lower left",
            bbox_to_anchor=(0, 1.02),
        )
    fig.autofmt_xdate()
    # The legend sits above the plot, so the title needs room above the legend.
    _style(ax, title, "", ylabel, title_pad=34 if len(frame.columns) > 1 else 12)
    return _save(fig, name)


def histogram(values, name: str, title: str, xlabel: str, bins=None) -> Path:
    """Distribution with the median called out — the report leads on the median."""
    values = pd.Series(values).dropna()
    fig, ax = plt.subplots(figsize=(8.5, 4.0))
    if len(values):
        bins = bins if bins is not None else range(1, int(values.max()) + 2)
        ax.hist(values, bins=bins, color=PALETTE[0], edgecolor=SURFACE, linewidth=1.5, align="left")
        median = float(values.median())
        ax.axvline(median, color=PALETTE[1], linewidth=2)
        ax.text(
            median,
            ax.get_ylim()[1] * 0.95,
            f" median {median:.0f}",
            fontsize=9,
            color=PALETTE[1],
            va="top",
        )
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    _style(ax, title, xlabel, "Sessions")
    return _save(fig, name)


def heatmap(frame: pd.DataFrame, name: str, title: str, cbar_label: str = "Sessions") -> Path:
    """
    A single-hue sequential grid for topic × course.

    Sequential because the value is magnitude, not identity; annotated because
    with a table this small the number matters more than the shade, and NA
    (suppressed) cells are drawn empty rather than as zero.
    """
    fig, ax = plt.subplots(
        figsize=(max(7.5, 0.95 * len(frame.columns) + 3), max(2.6, 0.55 * len(frame.index) + 2))
    )
    data = frame.astype(float).values
    cmap = matplotlib.colors.LinearSegmentedColormap.from_list("bloombot-seq", SEQUENTIAL_HUE)
    cmap.set_bad(color="#f4f3f0")
    masked = np.ma.masked_invalid(data)
    image = ax.imshow(masked, cmap=cmap, aspect="auto")
    ax.set_xticks(range(len(frame.columns)), [str(c) for c in frame.columns], rotation=35, ha="right")
    ax.set_yticks(range(len(frame.index)), [str(i) for i in frame.index])
    vmax = np.nanmax(data) if np.isfinite(data).any() else 1
    for r in range(data.shape[0]):
        for c in range(data.shape[1]):
            value = data[r, c]
            if np.isnan(value):
                ax.text(c, r, "—", ha="center", va="center", fontsize=9, color=INK_MUTED)
                continue
            ax.text(
                c,
                r,
                f"{value:,.0f}",
                ha="center",
                va="center",
                fontsize=9,
                color="#ffffff" if value > vmax * 0.6 else INK_PRIMARY,
            )
    bar = fig.colorbar(image, ax=ax, shrink=0.8)
    bar.set_label(cbar_label, color=INK_SECONDARY, fontsize=9)
    bar.ax.tick_params(colors=INK_SECONDARY, labelsize=8, length=0)
    bar.outline.set_visible(False)
    _style(ax, title)
    ax.grid(False)
    return _save(fig, name)
