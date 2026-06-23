#!/usr/bin/env python3
"""
Renders the LLM-over-BDI data flow for the LLM integration slide.

The story this version tells: a pending chat mission acts as a LOCK. The gate
is re-checked every tick and reads llmMemory.missions; while that list is
non-empty the agent is held in the LLM branch (re-deliberating each tick,
<= 4 rounds/tick). It is RELEASED back to BDI only when the mission is
completed (a flow tool finishes it) or discarded (resolve_mission), which
empties the list. The circuit breaker is a separate escape hatch.

Outputs a transparent SVG that sits on the slide's dark panel. Run:
    python3 scripts/llm_flow_diagram.py
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
    os.path.dirname(__file__), "..", "src", "assets", "llm-flow.svg"
)

fig, ax = plt.subplots(figsize=(7.2, 4.3))
ax.set_xlim(0, 150)
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
        ax.text(cx, cy - 3.2, subtitle, ha="center", va="center", fontsize=5.4, color=MUTED)
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


def label(x, y, text, color=MUTED, fontsize=6.6, ha="center", weight="normal"):
    ax.text(x, y, text, ha=ha, va="center", fontsize=fontsize, color=color, weight=weight)


# ---- Nodes ---------------------------------------------------------------
# Left: the per-tick lock gate and the BDI fall-through.
node(24, 56, 32, 16, "mission pending?", BLUE, subtitle="gate — checked every tick")
node(24, 14, 32, 16, "BDI", GREEN, subtitle="deliberation")
# Center/top: the LLM control branch.
node(70, 56, 30, 15, "LLM rounds", PURPLE, subtitle="T=0 \u00b7 tool_choice=required")
node(120, 56, 40, 15, "flow tools", PURPLE, subtitle="go_pick_up \u00b7 go_to \u00b7 drop_at")
node(120, 33, 40, 15, "config tools", ORANGE, subtitle="set_* \u00b7 blacklist \u00b7 command_peer")
node(120, 11, 40, 15, "llmMemory", ORANGE, subtitle="missions \u00b7 rules \u00b7 rewards")


# Gate -> LLM while a mission is pending (the forward lock edge).
arrow(24 + 32 / 2, 56, 70 - 30 / 2, 56, color=PURPLE, lw=1.6)

# Relock arc: each tick the LLM yields, but the unresolved mission still sits in
# llmMemory.missions, so the gate re-fires and routes back here. This loop is
# the lock: the agent cannot leave the LLM branch until the mission is resolved.
# Anchored to the box tops with a wide upward bow so it reads as a return loop.
arrow(70, 56 + 15 / 2, 24, 56 + 16 / 2, color=RED, lw=1.4,
      conn="arc3,rad=0.2")
label(47, 73, "held till a mission is cleared", color=RED, fontsize=7.8)

# ---- Release back to BDI -------------------------------------------------
arrow(24, 56 - 16 / 2, 24, 14 + 16 / 2, color=GREEN, lw=1.5)
label(27, 41, "no \u00b7 zero latency", color=GREEN, fontsize=6.2, ha="left")
label(27, 36.8, "RELEASE when missions empty:", color=RED, fontsize=5.9, ha="left", weight="bold")
label(27, 33, "\u2022 completed (flow tool finishes)", color=DIM, fontsize=5.7, ha="left")
label(27, 29.6, "\u2022 discarded (resolve_mission)", color=DIM, fontsize=5.7, ha="left")

# ---- LLM -> tools --------------------------------------------------------
arrow(70 + 30 / 2, 56, 120 - 40 / 2, 56, color=PURPLE, lw=1.2)
label(97, 59.5, "1 tool / round", color=DIM, fontsize=6.0)
arrow(70 + 30 / 2, 53, 120 - 40 / 2, 35, color=ORANGE, lw=1.2)

# ---- Persistent rule loop ------------------------------------------------
arrow(120, 33 - 15 / 2, 120, 11 + 15 / 2, color=ORANGE, lw=1.2)
label(124, 22, "persist", color=ORANGE, fontsize=6.0, ha="left")
# llmMemory rules feed BDI deliberation every tick (the config-application loop,
# distinct from the mission lock above).
arrow(120 - 40 / 2, 11, 24 + 32 / 2, 14, color=ORANGE, lw=1.5)
label(72, 16.5, "rules: read every tick", color=ORANGE, fontsize=6.4)

# ---- Executor sinks ------------------------------------------------------
label(120 + 40 / 2 + 2, 56, "\u2192 executor", color=MUTED, fontsize=6.4, ha="left")
label(24, 14 - 9.5, "\u2192 executor", color=MUTED, fontsize=6.4)


os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
fig.savefig(OUT_PATH, transparent=True, bbox_inches="tight", pad_inches=0.06)
print("wrote", os.path.normpath(OUT_PATH))

# Verification PNG on a dark backdrop (not committed).
fig.savefig("/tmp/llm-flow.png", facecolor="#1a1816", bbox_inches="tight", pad_inches=0.2, dpi=130)