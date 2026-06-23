#!/usr/bin/env python3
"""
Renders the getBestIntention() decision spine for the Deliberation slide.

Three steps:
  1. carrying a parcel?  -> worth grabbing another, else deliver
  2. best pickup in beliefs / view?  -> go_pick_up
  3. nothing to pick up  -> explore / patrol spawners

Outputs a transparent SVG that sits on the slide's dark panel. Run:
    python3 scripts/deliberation_diagram.py
"""

import os
import matplotlib

matplotlib.use("svg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

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

OUT_PATH = os.path.join(
    os.path.dirname(__file__), "..", "src", "assets", "deliberation-flow.svg"
)

fig, ax = plt.subplots(figsize=(6.4, 6.6))
ax.set_xlim(0, 120)
ax.set_ylim(0, 140)
ax.axis("off")
fig.patch.set_alpha(0)
ax.patch.set_alpha(0)


def node(cx, cy, w, h, title, color, subtitle=None, title_color=HEADING):
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
        ax.text(cx, cy + 2.6, title, ha="center", va="center", fontsize=10.0, color=title_color)
        ax.text(cx, cy - 4.2, subtitle, ha="center", va="center", fontsize=6.8, color=MUTED)
    else:
        ax.text(cx, cy, title, ha="center", va="center", fontsize=10.0, color=title_color)


def group_node(cx, cy, w, h, title, bullets, color):
    """Outcome box with a colored title and a list of left-aligned bullet lines."""
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
    ax.text(cx, cy + h / 2 - 5.5, title, ha="center", va="center", fontsize=9.5, color=color)
    x_left = cx - w / 2 + 4
    y_top = cy + h / 2 - 13
    for i, line in enumerate(bullets):
        ax.text(x_left, y_top - i * 7.2, line, ha="left", va="center", fontsize=7.0, color=MUTED)


def arrow(x1, y1, x2, y2, color=MUTED):
    ax.add_patch(
        FancyArrowPatch(
            (x1, y1),
            (x2, y2),
            arrowstyle="-|>",
            mutation_scale=12,
            linewidth=1.3,
            color=color,
            shrinkA=0,
            shrinkB=0,
        )
    )


def label(x, y, text, color=MUTED, fontsize=8.0):
    ax.text(x, y, text, ha="center", va="center", fontsize=fontsize, color=color)


# Geometry.
SX, SW, SH = 26, 44, 16  # left-hand decision spine
OX = 90  # right-hand outcome column center
rows = [116, 72, 28]  # carrying, best pickup, explore

# Decision spine (left).
node(SX, rows[0], SW, SH, "carrying a parcel?", GREEN)
node(SX, rows[1], SW, SH, "best pickup?", ORANGE, subtitle="best parcel in beliefs / view")
node(SX, rows[2], SW, SH, "explore / patrol", PURPLE, subtitle="spawners")

# Outcomes (right).
group_node(
    OX,
    rows[0],
    58,
    32,
    "deliver  vs.  detour",
    [
        "• worth grabbing another → go_pick_up",
        "• else → go_deliver",
    ],
    GREEN,
)
node(OX, rows[1], 36, SH, "go_pick_up", ORANGE)
group_node(
    OX,
    rows[2],
    58,
    38,
    "exploration modes",
    [
        "• frequent → camp nearest",
        "• sparse / rare → patrol + dwell",
        "• no zone spawner → half-point",
    ],
    PURPLE,
)

# Down arrows along the spine (the "continue" path).
down_labels = ["no", "none"]
for i in range(2):
    y_from = rows[i] - SH / 2
    y_to = rows[i + 1] + SH / 2
    arrow(SX, y_from, SX, y_to)
    label(SX + 6, (y_from + y_to) / 2, down_labels[i])

# Branch arrows to the right-hand outcomes.
group_left = OX - 58 / 2
branch_targets = [group_left, OX - 36 / 2, group_left]
branch_labels = ["yes", "yes", ""]
for i in range(3):
    x_from = SX + SW / 2
    arrow(x_from, rows[i], branch_targets[i], rows[i])
    if branch_labels[i]:
        label((x_from + branch_targets[i]) / 2, rows[i] + 3.4, branch_labels[i])

os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
fig.savefig(OUT_PATH, transparent=True, bbox_inches="tight", pad_inches=0.06)
print("wrote", os.path.normpath(OUT_PATH))
