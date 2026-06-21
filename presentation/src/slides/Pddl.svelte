<script>
</script>

<h2>PDDL mode: planning <em>through</em> obstacles</h2>
<p class="subtitle" style="font-size: 0.95rem;">
  Same BDI loop — A* is swapped for a symbolic solver run as a service. Each intention regenerates a PDDL problem from current beliefs.
</p>

<div class="flow" style="margin-top: 14px;">
  <div class="flow-box orange">Phase 1 — no pushing<small>crates = walls</small></div>
  <span class="flow-arrow">&#8594;</span>
  <div class="flow-box red">no free route?</div>
  <span class="flow-arrow">&#8594;</span>
  <div class="flow-box purple">Phase 2 — push enabled<small>Sokoban-style</small></div>
</div>

<div class="cols">
  <div class="card blue-border">
    <h3>Planning-as-a-service</h3>
    <ul>
      <li>Symbolic solver via Docker + HTTP API (<span class="mono">@unitn-asa/pddl-client</span>)</li>
      <li>Every intention produces a PDDL <strong>problem regenerated from current beliefs</strong> (position, parcels, crates, delivery tiles)</li>
    </ul>
  </div>
  <div class="card green-border">
    <h3>Domain</h3>
    <ul>
      <li>Navigation (<span class="mono">move-right/left/up/down</span>), pickup and delivery</li>
      <li>Crate pushing (<span class="mono">push-right/left/up/down</span>) — crates can be pushed <strong>only</strong> onto <span class="mono">crate-slot</span> tiles (type 5)</li>
    </ul>
  </div>
</div>

<div class="cols">
  <div class="card orange-border">
    <h3>Two-phase strategy</h3>
    <ul>
      <li>Plan first with <strong>no pushing</strong> (crates = walls); enable pushing only if no free path exists</li>
      <li>Avoids needless pushes that clutter the map</li>
    </ul>
  </div>
  <div class="card purple-border">
    <h3>Directional tiles</h3>
    <ul>
      <li>Arrow-tile crossing constraints are encoded as facts <span class="mono">(right/left/up/down from to)</span></li>
      <li>The planner respects the allowed directions automatically</li>
    </ul>
  </div>
</div>

<div class="card red-border" style="max-width: 920px; margin-top: 16px;">
  <h3>Dynamic agents excluded &amp; timeout</h3>
  <ul>
    <li>Visible agents are treated as <strong>blocked tiles</strong> (removed from the tile set); the solver does not model their future movement</li>
    <li>Solver interrupted after <span class="mono">5s</span>; on failure the executor reports <span class="mono">no_path</span> and revision picks a new intention</li>
  </ul>
</div>
