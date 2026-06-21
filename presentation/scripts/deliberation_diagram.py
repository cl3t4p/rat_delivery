#!/usr/bin/env python3
"""
Renders the getBestIntention() decision spine for the Deliberation slide.

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

fig, ax = plt.subplots(figsize=(5.4, 7.4))
ax.set_xlim(0, 100)
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
        ax.text(cx, cy + 2.6, title, ha="center", va="center", fontsize=10.5, color=title_color)
        ax.text(cx, cy - 4.0, subtitle, ha="center", va="center", fontsize=7.0, color=MUTED)
    else:
        ax.text(cx, cy, title, ha="center", va="center", fontsize=10.5, color=title_color)


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
SX, SW, SH = 30, 46, 17  # spine decision nodes
OX, OW, OH = 79, 38, 17  # right-hand outcome nodes
rows = [128, 100, 72, 44]

# Decision spine.
node(SX, rows[0], SW, SH, "position known?", BLUE)
node(SX, rows[1], SW, SH, "carrying a parcel?", GREEN)
node(SX, rows[2], SW, SH, "parcel on my tile?", ORANGE)
node(SX, rows[3], SW, SH, "best scored pickup?", ORANGE)
node(40, 14, 64, SH, "explore / patrol spawners", PURPLE)

# Outcomes on the right.
node(OX, rows[0], 26, SH, "wait", DIM, title_color=MUTED)
node(OX, rows[1], OW, OH, "go_deliver", GREEN, subtitle="best tile · maybe detour")
node(OX, rows[2], OW, OH, "go_pick_up", ORANGE)
node(OX, rows[3], OW, OH, "go_pick_up", ORANGE)

# Down arrows along the spine (the "continue" path).
down_labels = ["yes", "no", "no", "none"]
spine_tops = rows + [14]
for i in range(4):
    y_from = spine_tops[i] - SH / 2
    y_to = spine_tops[i + 1] + SH / 2
    arrow(SX, y_from, SX, y_to)
    label(SX + 6, (y_from + y_to) / 2, down_labels[i])

# Branch arrows to the right-hand outcomes.
branch_labels = ["no", "yes", "yes", "yes"]
for i in range(4):
    x_from = SX + SW / 2
    x_to = OX - OW / 2 if i > 0 else OX - 26 / 2
    arrow(x_from, rows[i], x_to, rows[i])
    label((x_from + x_to) / 2, rows[i] + 3.4, branch_labels[i])

os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
fig.savefig(OUT_PATH, transparent=True, bbox_inches="tight", pad_inches=0.06)
print("wrote", os.path.normpath(OUT_PATH))
