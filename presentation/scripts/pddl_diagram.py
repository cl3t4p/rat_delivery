#!/usr/bin/env python3
"""
Renders the planWithPDDL() two-phase solve pipeline for the PDDL slide.

Each intention regenerates a PDDL problem from current beliefs, then runs the
solver twice at most: Phase 1 treats crates as walls; only if no free route
exists does Phase 2 enable crate pushing. Outputs a transparent SVG that sits
on the slide's dark panel. Run:
    python3 scripts/pddl_diagram.py
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
RED = "#ef4e5f"
DIM = "#7a7268"

OUT_PATH = os.path.join(
    os.path.dirname(__file__), "..", "src", "assets", "pddl-flow.svg"
)

fig, ax = plt.subplots(figsize=(7.4, 3.5))
ax.set_xlim(0, 162)
ax.set_ylim(0, 80)
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
        ax.text(cx, cy + 2.4, title, ha="center", va="center", fontsize=8.4, color=title_color)
        ax.text(cx, cy - 3.2, subtitle, ha="center", va="center", fontsize=5.6, color=MUTED)
    else:
        ax.text(cx, cy, title, ha="center", va="center", fontsize=8.4, color=title_color)


def arrow(x1, y1, x2, y2, color=MUTED, lw=1.3, dashed=False, conn=None):
    ax.add_patch(
        FancyArrowPatch(
            (x1, y1),
            (x2, y2),
            arrowstyle="-|>",
            mutation_scale=11,
            linewidth=lw,
            color=color,
            shrinkA=0,
            shrinkB=0,
            linestyle="--" if dashed else "-",
            connectionstyle=conn,
        )
    )


def label(x, y, text, color=MUTED, fontsize=6.6, ha="center", va="center", **kwargs):
    ax.text(
        x,
        y,
        text,
        ha=ha,
        va=va,
        fontsize=fontsize,
        color=color,
        **kwargs,
    )


# Two rows: Phase 1 walks across the top, Phase 2 drops to the bottom lane.
Y_T, Y_B = 60, 22

# Top lane: intention -> rebuilt problem -> Phase 1 solve -> route gate.
node(16, Y_T, 26, 15, "intention", BLUE, subtitle="+ beliefs")
node(52, Y_T, 32, 16, "build PDDL", PURPLE, subtitle="tiles · 1-way edges")
node(94, Y_T, 36, 16, "Phase 1 — no push", ORANGE, subtitle="crates = walls · 5s")
node(138, Y_T, 28, 15, "free route?", BLUE)

# Bottom lane: Phase 2 only runs when Phase 1 found nothing.
node(94, Y_B, 36, 16, "Phase 2 — push", PURPLE, subtitle="Sokoban · crate-slots · 5s")

# Right-hand outcomes, stacked under the gate.
node(138, 41, 28, 14, "moves", GREEN, subtitle="→ executor")
node(138, Y_B, 28, 14, "no_path", RED, subtitle="→ revision")

# Top-lane progression.
arrow(16 + 26 / 2, Y_T, 52 - 32 / 2, Y_T, color=MUTED, lw=1.1)
arrow(52 + 32 / 2, Y_T, 94 - 36 / 2, Y_T, color=MUTED, lw=1.1)
arrow(94 + 36 / 2, Y_T, 138 - 28 / 2, Y_T, color=ORANGE, lw=1.2)

# Gate "yes" drops straight to the moves outcome.
arrow(138, Y_T - 15 / 2, 138, 41 + 14 / 2, color=GREEN, lw=1.3)
label(142, 50, "yes", color=GREEN, fontsize=6.4, ha="left")

# Gate "no" diverts down-left into Phase 2 (the only path that pushes crates).
# Bows out to the right so it clears the Phase 2 -> outcome arrows below.
arrow(138 - 28 / 2, Y_T - 5, 94 + 36 / 2, Y_B + 5, color=RED, lw=1.2,
      conn="arc3,rad=0.32")
label(115, 49, "no clear path", color=RED, fontsize=6.2, ha="center",rotation=56)

# Phase 2 resolves to moves (plan) or no_path (empty / 5s timeout).
arrow(94 + 36 / 2, Y_B + 4, 138 - 28 / 2, 41 - 14 / 2, color=GREEN, lw=1.2,
      conn="arc3,rad=-0.12")
label(116, 36, "plan", color=GREEN, fontsize=6.2)
arrow(94 + 36 / 2, Y_B - 3, 138 - 28 / 2, Y_B - 3, color=DIM, lw=1.2)
label(116, Y_B - 10.5, "empty / 5s timeout", color=DIM, fontsize=5.8)


os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
fig.savefig(OUT_PATH, transparent=True, bbox_inches="tight", pad_inches=0.06)
print("wrote", os.path.normpath(OUT_PATH))

# Verification PNG on a dark backdrop (not committed).
fig.savefig("/tmp/pddl-flow.png", facecolor="#1a1816", bbox_inches="tight", pad_inches=0.2, dpi=130)
