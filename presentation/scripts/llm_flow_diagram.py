#!/usr/bin/env python3
"""
Renders the LLM-over-BDI data flow for the LLM integration slide.

Shows the hybrid gate (mission? -> BDI vs LLM) and the key loop: config
tools persist rules into llmMemory, which BDI re-reads every tick. Outputs
a transparent SVG that sits on the slide's dark panel. Run:
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

fig, ax = plt.subplots(figsize=(7.2, 3.5))
ax.set_xlim(0, 156)
ax.set_ylim(0, 76)
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


def label(x, y, text, color=MUTED, fontsize=6.6, ha="center"):
    ax.text(x, y, text, ha=ha, va="center", fontsize=fontsize, color=color)


# The hybrid gate (left), the LLM tool path (top), the persistent loop (bottom).
node(18, 58, 26, 15, "mission?", BLUE, subtitle="pending in chat")
node(58, 58, 30, 15, "LLM rounds", PURPLE, subtitle="≤ 4 · T=0 · required")
node(108, 58, 44, 15, "flow tools", PURPLE, subtitle="go_pick_up · go_to · drop_at")
node(108, 34, 44, 15, "config tools", ORANGE, subtitle="set_* · blacklist · command_peer")
node(108, 12, 44, 14, "llmMemory", ORANGE, subtitle="stackRules · maxPickup · rewards")
node(18, 12, 26, 15, "BDI", GREEN, subtitle="deliberation")

# Hybrid gate branches.
arrow(18 + 26 / 2, 58, 58 - 30 / 2, 58, color=PURPLE)
label(36, 62, "yes", color=PURPLE, fontsize=6.4)
arrow(18, 58 - 15 / 2, 18, 12 + 15 / 2, color=GREEN)
label(21, 35, "no — zero latency", color=GREEN, fontsize=6.0, ha="left")

# LLM -> tools (flow tools act now; config tools persist rules).
arrow(58 + 30 / 2, 58, 108 - 44 / 2, 58, color=PURPLE, lw=1.2)
arrow(58 + 30 / 2, 54, 108 - 44 / 2, 36, color=ORANGE, lw=1.2)

# config tools -> llmMemory -> BDI (the persistent loop, the key edge).
arrow(108, 34 - 15 / 2, 108, 12 + 14 / 2, color=ORANGE, lw=1.2)
label(112, 23, "persist", color=ORANGE, fontsize=6.0, ha="left")
arrow(108 - 44 / 2, 12, 18 + 26 / 2, 12, color=ORANGE, lw=1.5)
label(63, 15.5, "read every tick", color=ORANGE, fontsize=6.6)

# Both producers reach the executor (labelled, no converging node).
label(108 + 44 / 2 + 2, 58, "→ executor", color=MUTED, fontsize=6.4, ha="left")
label(18, 12 - 9.5, "→ executor", color=MUTED, fontsize=6.4)

# Circuit breaker note (under the LLM round box).
label(58, 46, "circuit breaker", color=RED, fontsize=6.4)
label(58, 41.5, "3 fails → suspend 2 min → BDI", color=DIM, fontsize=6.0)

os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
fig.savefig(OUT_PATH, transparent=True, bbox_inches="tight", pad_inches=0.06)
print("wrote", os.path.normpath(OUT_PATH))

# Verification PNG on a dark backdrop (not committed).
fig.savefig("/tmp/llm-flow.png", facecolor="#1a1816", bbox_inches="tight", pad_inches=0.2, dpi=130)
