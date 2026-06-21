<script>
  import handoffImg from '../assets/handoff-flow.svg'
</script>

<h2 style="font-size: 1.7rem; margin-bottom: 0.15em;">Multi-agent: one BDI core, coordination on top</h2>
<p class="subtitle" style="font-size: 0.92rem; margin-top: 0.2em;">
  A coordination seam lets the same loop serve solo and paired play; zones, reservations and a payoff-gated handoff keep two agents out of each other's way.
</p>

<!-- diagram: the handoff choreography (scripts/handoff_diagram.py) -->
<div class="diagram-panel">
  <span class="panel-tag mono">handoff choreography</span>
  <img class="flow-img" src={handoffImg} alt="Handoff sequence: carrier A reaches the meet tile, drops parcels and vacates; receiver B goes to the staging tile, polls until parcels appear, steps onto the meet tile and picks up; messages HANDOFF_REQUEST, staging tile, and peerCarryingCount confirm pass between them" />
</div>

<!-- 2 x 2 grid of the four coordination pieces -->
<div class="ma-cards">
  <div class="card blue-border">
    <h3>Seam <span class="mono">coordination.js</span></h3>
    <ul>
      <li>Interface injected at startup. Solo returns neutral defaults; multi swaps in the real logic via <span class="mono">registerCoordination()</span></li>
      <li><strong>One BDI core serves both modes</strong> — no <span class="mono">if</span> on configuration</li>
    </ul>
  </div>

  <div class="card green-border">
    <h3>Zone assignment</h3>
    <ul>
      <li>Split by map aspect ratio; heuristic pre-assignment once the peer is located</li>
      <li>Reassigned every <span class="mono">15s</span> from per-zone stats; deferred during a handoff</li>
    </ul>
  </div>

  <div class="card orange-border">
    <h3>Reservations</h3>
    <ul>
      <li>Each agent broadcasts its current intention; the other yields if the peer is closer (<span class="mono">2</span>-tile margin, TTL)</li>
      <li>Avoids conflicts with <strong>no central lock</strong></li>
    </ul>
  </div>

  <div class="card purple-border">
    <h3>Handoff — carrier A farther than empty B</h3>
    <ul>
      <li>A drops at a <strong>meet tile</strong>, B picks up and delivers <span class="mono">(see diagram)</span></li>
      <li>Gated: steps A saves &gt; threshold <em>and</em> reward lost &#8804; 2; <strong>+200</strong> bonus per parcel B delivers. Re-checked after each pickup and on <span class="mono">BLOCKED_AT</span></li>
    </ul>
  </div>
</div>

<style>
  .diagram-panel { margin-top: 10px; }
  .diagram-panel .flow-img { max-height: 30vh; }

  .ma-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    width: 100%;
    max-width: 1060px;
    margin-top: 14px;
  }
  .ma-cards .card { padding: 11px 18px; }
  .ma-cards h3 { margin-bottom: 4px; font-size: 1.08rem; }
  .ma-cards ul { margin: 0; padding-left: 17px; }
  .ma-cards li {
    text-align: left;
    color: var(--text-muted);
    font-size: 0.92rem;
    line-height: 1.45;
    margin-bottom: 4px;
  }
  .ma-cards li strong { color: var(--heading); }

  @media (max-width: 860px) {
    .ma-cards { grid-template-columns: 1fr; }
  }
</style>
