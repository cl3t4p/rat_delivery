#!/usr/bin/env python3
"""
Renders the executor's two views for the Executor slide:

  executor-loop.svg  - the per-tick guard gauntlet (a polling loop)
  executor-step.svg  - stepTowardsTarget: the move-or-resolve ladder

Both are transparent SVGs sized for the slide's dark panels. Run:
    python3 scripts/executor_diagram.py
Set PREVIEW_DIR to also dump opaque PNGs there for visual checking.
"""

import os
import matplotlib

matplotlib.use("svg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

matplotlib.rcParams["svg.hashsalt"] = "rat-delivery-executor-diagram"

# Deck theme (mirrors src/app.css variables).
HEADING = "#fff7eb"
MUTED = "#a89f94"
BORDER = "#3a342f"
FILL = "#201d1b"
BLUE = "#55c3ff"
GREEN = "#6fd48d"
ORANGE = "#ffb052"
PURPLE = "#c99cff"
DIM = "#7a7268"

ASSETS = os.path.join(os.path.dirname(__file__), "..", "src", "assets")


def node(ax, cx, cy, w, h, title, color, subtitle=None, title_color=HEADING):
    box = FancyBboxPatch(
        (cx - w / 2, cy - h / 2),
        w,
        h,
        boxstyle="round,pad=0,rounding_size=3",
        linewidth=1.6,
        edgecolor=color,
        facecolor=FILL,
        mutation_aspect=1,
    )
    ax.add_patch(box)
    if subtitle:
        ax.text(cx, cy + 2.4, title, ha="center", va="center", fontsize=9.5, color=title_color)
        ax.text(cx, cy - 3.8, subtitle, ha="center", va="center", fontsize=6.6, color=MUTED)
    else:
        ax.text(cx, cy, title, ha="center", va="center", fontsize=9.5, color=title_color)


def group_node(ax, cx, cy, w, h, title, bullets, color):
    box = FancyBboxPatch(
        (cx - w / 2, cy - h / 2),
        w,
        h,
        boxstyle="round,pad=0,rounding_size=3",
        linewidth=1.6,
        edgecolor=color,
        facecolor=FILL,
        mutation_aspect=1,
    )
    ax.add_patch(box)
    ax.text(cx, cy + h / 2 - 5.2, title, ha="center", va="center", fontsize=9.0, color=color)
    x_left = cx - w / 2 + 4
    y_top = cy + h / 2 - 12
    for i, line in enumerate(bullets):
        ax.text(x_left, y_top - i * 6.8, line, ha="left", va="center", fontsize=6.6, color=MUTED)


def arrow(ax, x1, y1, x2, y2, color=MUTED, style="-|>"):
    ax.add_patch(
        FancyArrowPatch(
            (x1, y1),
            (x2, y2),
            arrowstyle=style,
            mutation_scale=11,
            linewidth=1.2,
            color=color,
            shrinkA=0,
            shrinkB=0,
        )
    )


def label(ax, x, y, text, color=MUTED, fontsize=7.4, ha="center"):
    ax.text(x, y, text, ha=ha, va="center", fontsize=fontsize, color=color)


def new_ax(w, h, xlim, ylim):
    fig, ax = plt.subplots(figsize=(w, h))
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    ax.axis("off")
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)
    return fig, ax


def save(fig, basename):
    svg_path = os.path.join(ASSETS, basename + ".svg")
    os.makedirs(ASSETS, exist_ok=True)
    fig.savefig(
        svg_path,
        transparent=True,
        bbox_inches="tight",
        pad_inches=0.08,
        metadata={"Date": None},
    )
    print("wrote", os.path.normpath(svg_path))
    preview = os.environ.get("PREVIEW_DIR")
    if preview:
        fig.patch.set_alpha(1)
        fig.patch.set_facecolor("#141210")
        fig.savefig(
            os.path.join(preview, basename + ".png"),
            dpi=150,
            bbox_inches="tight",
            pad_inches=0.1,
        )


# ---------------------------------------------------------------------------
# Panel A: the per-tick guard gauntlet (a polling loop).
# ---------------------------------------------------------------------------
def build_loop():
    fig, ax = new_ax(5.6, 6.35, (0, 112), (23, 158))

    SX, SW, SH = 40, 54, 13
    RAIL_X = 102
    rows = [142, 119, 96, 73]

    guards = [
        ("socket connected?", "no  →  sleep"),
        ("position known?", "no"),
        ("paused by peer?", "yes  →  sleep"),
        ("have an intention?", "no"),
    ]
    pass_labels = ["yes", "yes", "no", "yes"]

    for (text, _), y in zip(guards, rows):
        node(ax, SX, y, SW, SH, text, BLUE)

    # Pass path down the spine.
    for i in range(len(rows) - 1):
        arrow(ax, SX, rows[i] - SH / 2, SX, rows[i + 1] + SH / 2)
        label(ax, SX + 6, (rows[i] - SH / 2 + rows[i + 1] + SH / 2) / 2, pass_labels[i])

    # Dispatch box at the bottom of the pass path.
    dispatch_y = 40
    arrow(ax, SX, rows[-1] - SH / 2, SX, dispatch_y + 8)
    label(ax, SX + 6, (rows[-1] - SH / 2 + dispatch_y + 8) / 2, pass_labels[-1])
    group_node(
        ax,
        SX,
        dispatch_y - 1,
        SW + 8,
        24,
        "dispatch by intention",
        [
            "wait → idle   ·   go_* → stepTowardsTarget",
            "go_handoff* → runHandoff",
        ],
        GREEN,
    )

    # Each guard's early-exit branch feeds the return rail.
    for (_, branch), y in zip(guards, rows):
        arrow(ax, SX + SW / 2, y, RAIL_X, y, color=DIM)
        label(ax, (SX + SW / 2 + RAIL_X) / 2, y + 3.2, branch, color=DIM, fontsize=6.6)

    # Dispatch result also returns to the rail.
    arrow(ax, SX + (SW + 8) / 2, dispatch_y - 1, RAIL_X, dispatch_y - 1, color=DIM)

    # Return rail: up the right side and back into the first guard ("next tick").
    arrow(ax, RAIL_X, dispatch_y - 1, RAIL_X, 150, color=DIM, style="-")
    arrow(ax, RAIL_X, 150, SX, 150, color=DIM, style="-")
    arrow(ax, SX, 150, SX, rows[0] + SH / 2, color=DIM)
    label(ax, (SX + RAIL_X) / 2, 153, "next tick  (loop)", color=DIM, fontsize=7.0)

    save(fig, "executor-loop")


# ---------------------------------------------------------------------------
# Panel B: stepTowardsTarget - the move-or-resolve ladder.
# ---------------------------------------------------------------------------
def build_step():
    fig, ax = new_ax(6.6, 7.0, (0, 126), (2, 162))

    SX, SW, SH = 30, 46, 13
    OX = 92
    rows = [140, 112, 84, 56]  # at target?, plan ready?, step valid?, emit move

    # Spine.
    node(ax, SX, rows[0], SW, SH, "at target?", GREEN)
    node(ax, SX, rows[1], SW, SH, "plan ready?", BLUE)
    node(ax, SX, rows[2], SW, SH, "next step valid?", BLUE)
    node(ax, SX, rows[3], SW, SH, "emit move", ORANGE)

    # Pass path down the spine.
    spine_pass = ["no", "yes", "yes"]
    for i in range(3):
        arrow(ax, SX, rows[i] - SH / 2, SX, rows[i + 1] + SH / 2)
        label(ax, SX + 6, (rows[i] - SH / 2 + rows[i + 1] + SH / 2) / 2, spine_pass[i])

    # at target? yes -> finalize.
    group_node(
        ax,
        OX,
        rows[0],
        58,
        32,
        "finalize → notifyIntentionDone",
        [
            "• go_pick_up → emitPickup · claim",
            "• go_deliver → emitPutdown · score",
            "• go_to / explore → arrived",
        ],
        GREEN,
    )
    arrow(ax, SX + SW / 2, rows[0], OX - 58 / 2, rows[0])
    label(ax, (SX + SW / 2 + OX - 58 / 2) / 2, rows[0] + 3.2, "yes")

    # plan ready? no -> computePlan.
    group_node(
        ax,
        OX,
        rows[1],
        58,
        24,
        "computePlan (A* | PDDL)",
        [
            "• moves found → follow plan",
            "• empty → notifyActionFailed(no_path)",
        ],
        ORANGE,
    )
    arrow(ax, SX + SW / 2, rows[1], OX - 58 / 2, rows[1])
    label(ax, (SX + SW / 2 + OX - 58 / 2) / 2, rows[1] + 3.2, "no")

    # next step valid? no -> drop plan & replan.
    node(ax, OX, rows[2], 50, SH, "drop plan → replan", PURPLE, title_color=MUTED)
    arrow(ax, SX + SW / 2, rows[2], OX - 50 / 2, rows[2])
    label(ax, (SX + SW / 2 + OX - 50 / 2) / 2, rows[2] + 3.2, "no")

    # emit move -> OK / socket null (right).
    node(ax, OX, rows[3] + 7, 50, 11, "OK → advance", GREEN, title_color=MUTED)
    node(ax, OX, rows[3] - 7, 50, 11, "socket null → requeue (retry)", DIM, title_color=MUTED)
    arrow(ax, SX + SW / 2, rows[3] + 2, OX - 50 / 2, rows[3] + 7, color=DIM)
    arrow(ax, SX + SW / 2, rows[3] - 2, OX - 50 / 2, rows[3] - 7, color=DIM)

    # emit move -> blocked -> conflict ladder (bottom, full width).
    arrow(ax, SX, rows[3] - SH / 2, SX, 30, color=ORANGE)
    label(ax, SX + 12, (rows[3] - SH / 2 + 30) / 2, "move blocked", color=ORANGE, fontsize=7.0)
    group_node(
        ax,
        62,
        16,
        118,
        22,
        "conflict ladder",
        [
            "• teammate carries more → retreat / wait  (right-of-way)",
            "• ≥3 fails → blacklist tile · handoff · backoff → notifyActionFailed(move_blocked)",
        ],
        ORANGE,
    )

    save(fig, "executor-step")


build_loop()
build_step()
