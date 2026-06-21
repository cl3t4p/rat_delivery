<script>
</script>

<h1>rat_delivery</h1>
<div class="title-divider"></div>
<p class="subtitle">A Deliveroo.js agent: one BDI core, three operating modes, and an optional LLM layer for natural-language missions.</p>

<div class="title-badges">
  <span class="tag tag-blue">Single agent — BDI + A*</span>
  <span class="tag tag-green">Multi-agent — two cooperative agents</span>
  <span class="tag tag-orange">PDDL — symbolic planning</span>
  <span class="tag tag-purple">LLM mission layer</span>
</div>

<div class="content-row" style="margin-top: 26px;">
  <div class="card blue-border">
    <h3>Three operating modes</h3>
    <ul>
      <li><strong>Single agent</strong> — deterministic BDI with A* pathfinding</li>
      <li><strong>Multi-agent</strong> — two cooperative agents sharing zones and handoff</li>
      <li><strong>PDDL</strong> — symbolic planning with Sokoban-style crate pushing</li>
    </ul>
  </div>
  <div class="card green-border">
    <h3>BDI architecture</h3>
    <ul>
      <li>One loop: <strong>Beliefs &#8594; Deliberation &#8594; Intention Revision &#8594; Executor</strong></li>
      <li>Sensing is <strong>event-driven via socket</strong> — beliefs react to server signals as they arrive</li>
    </ul>
  </div>
</div>

<div class="flow" style="margin-top: 22px;">
  <div class="flow-box blue">Beliefs<small>map, parcels, agents</small></div>
  <span class="flow-arrow">&#8594;</span>
  <div class="flow-box blue">Deliberation<small>score one intention</small></div>
  <span class="flow-arrow">&#8594;</span>
  <div class="flow-box blue">Revision<small>keep or replace</small></div>
  <span class="flow-arrow">&#8594;</span>
  <div class="flow-box blue">Executor<small>plan, move, recover</small></div>
</div>

<div class="card purple-border" style="max-width: 920px; margin-top: 20px;">
  <h3>Optional LLM integration</h3>
  <p style="color: var(--text-muted);">
    The model <strong style="color:var(--heading)">replaces BDI deliberation</strong> only to handle missions written in natural language.
    With no pending missions it <strong style="color:var(--heading)">falls back automatically</strong> to the deterministic BDI — zero latency, zero API calls.
  </p>
</div>

<p class="subtitle" style="font-size: 1rem; margin-top: 22px;">
  Alex Zanetti &nbsp;&bull;&nbsp; Francesca Loffredo &nbsp;&mdash;&nbsp; Autonomous Software Agents, UniTN
</p>
