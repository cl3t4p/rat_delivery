#!/usr/bin/env python3
"""
Renders the handoff choreography for the Multi-agent slide.

Two swimlanes (carrier A, receiver B) flowing left -> right, with the
inter-agent messages drawn as vertical arrows between them. Outputs a
transparent SVG that sits on the slide's dark panel. Run:
    python3 scripts/handoff_diagram.py
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
    os.path.dirname(__file__), "..", "src", "assets", "handoff-flow.svg"
)

fig, ax = plt.subplots(figsize=(7.0, 3.5))
ax.set_xlim(0, 150)
ax.set_ylim(0, 72)
ax.axis("off")
fig.patch.set_alpha(0)
ax.patch.set_alpha(0)


def node(cx, cy, w, h, title, color, subtitle=None, title_color=HEADING):
    box = FancyBboxPatch(
        (cx - w / 2, cy - h / 2),
        w,
        h,
        boxstyle="round,pad=0,rounding_size=2.5",
        linewidth=1.5,
        edgecolor=color,
        facecolor=FILL,
        mutation_aspect=1,
    )
    ax.add_patch(box)
    if subtitle:
        ax.text(cx, cy + 2.3, title, ha="center", va="center", fontsize=8.4, color=title_color)
        ax.text(cx, cy - 3.0, subtitle, ha="center", va="center", fontsize=6.3, color=MUTED)
    else:
        ax.text(cx, cy, title, ha="center", va="center", fontsize=8.4, color=title_color)


def arrow(x1, y1, x2, y2, color=MUTED, style="-|>", lw=1.3, dashed=False):
    ax.add_patch(
        FancyArrowPatch(
            (x1, y1),
            (x2, y2),
            arrowstyle=style,
            mutation_scale=11,
            linewidth=lw,
            color=color,
            shrinkA=0,
            shrinkB=0,
            linestyle="--" if dashed else "-",
        )
    )


def label(x, y, text, color=MUTED, fontsize=6.6, ha="center", rotation=0):
    ax.text(x, y, text, ha=ha, va="center", fontsize=fontsize, color=color, rotation=rotation)


# Lane geometry.
A_Y, B_Y = 56, 16          # swimlane centres
BW, BH = 28, 13            # box size
cols = [30, 62, 94, 126]   # stage centres

# Lane tags.
label(4, A_Y, "A", color=GREEN, fontsize=10, ha="left")
label(4, A_Y - 6, "carrier", color=MUTED, fontsize=6.0, ha="left")
label(4, B_Y, "B", color=BLUE, fontsize=10, ha="left")
label(4, B_Y - 6, "receiver", color=MUTED, fontsize=6.0, ha="left")

# Carrier A lane.
a_boxes = [
    ("reach meet", "carrying"),
    ("drop parcels", "on meet tile"),
    ("vacate", "step opposite B"),
    ("free", "after confirm"),
]
for (cx, (t, s)) in zip(cols, a_boxes):
    node(cx, A_Y, BW, BH, t, GREEN, subtitle=s)

# Receiver B lane.
b_boxes = [
    ("go to staging", "tile adj. meet"),
    ("poll ≤ 20", "until parcels"),
    ("step on meet", "pick up ≤ 5"),
    ("→ delivery", "+200 bonus"),
]
for (cx, (t, s)) in zip(cols, b_boxes):
    node(cx, B_Y, BW, BH, t, BLUE, subtitle=s)

# Intra-lane progression arrows.
for i in range(3):
    arrow(cols[i] + BW / 2, A_Y, cols[i + 1] - BW / 2, A_Y, color=GREEN, lw=1.1)
    arrow(cols[i] + BW / 2, B_Y, cols[i + 1] - BW / 2, B_Y, color=BLUE, lw=1.1)

# Inter-agent messages (vertical, between lanes).
# 1) HANDOFF_REQUEST: A -> B, before stage 1.
arrow(cols[0] - 4, A_Y - BH / 2, cols[0] - 4, B_Y + BH / 2, color=MUTED, dashed=True, lw=1.0)
# Vertical so the long label runs parallel to the arrows instead of crossing them.
label(cols[0] - 12, 36, "HANDOFF_REQUEST", color=MUTED, fontsize=6.0, ha="center", rotation=90)
label(cols[0] - 18, 36, "(timeout 1.5s)", color=DIM, fontsize=5.6, ha="center", rotation=90)

# 2) staging tile reply: B -> A.
arrow(cols[0] + 5, B_Y + BH / 2, cols[0] + 5, A_Y - BH / 2, color=MUTED, dashed=True, lw=1.0)
label(cols[0] + 9, 36, "staging tile", color=MUTED, fontsize=6.0, ha="left")

# 3) carrying confirm: B -> A, near the end.
arrow(cols[3] - 4, B_Y + BH / 2, cols[3] - 4, A_Y - BH / 2, color=ORANGE, dashed=True, lw=1.0)
label(cols[3] - 30, 38, "peerCarryingCount", color=ORANGE, fontsize=6.0, ha="left")
label(cols[3] - 30, 33, "confirm (2s)", color=DIM, fontsize=5.6, ha="left")

os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
fig.savefig(OUT_PATH, transparent=True, bbox_inches="tight", pad_inches=0.06)
print("wrote", os.path.normpath(OUT_PATH))

# Verification PNG on a dark backdrop (not committed).
fig.savefig("/tmp/handoff-flow.png", facecolor="#1a1816", bbox_inches="tight", pad_inches=0.2, dpi=130)
