<script>
</script>

<h2>Executor: one action at a time, replan on the fly</h2>
<p class="subtitle" style="font-size: 1rem;">
  The executor runs a continuous loop, firing a single socket action per iteration and re-checking validity before every step.
</p>

<div class="cols">
  <div class="card blue-border">
    <h3>Step-by-step loop</h3>
    <ul>
      <li>Executes <strong>one socket action at a time</strong> — a step, a pickup, a delivery</li>
      <li>Never blocks the main loop</li>
    </ul>
  </div>
  <div class="card green-border">
    <h3>Replan on the fly</h3>
    <ul>
      <li>The A* plan is computed on demand; before each step it checks the move is still valid (<span class="mono">isStepValid</span>)</li>
      <li>Tile became blocked (crate moved, agent arrived) &#8594; clear the plan and replan next iteration</li>
    </ul>
  </div>
</div>

<div class="cols">
  <div class="card orange-border">
    <h3>Priority yield &amp; <span class="mono">BLOCKED_AT</span></h3>
    <ul>
      <li>Teammate blocks the path: the one carrying <strong>fewer</strong> parcels yields (retreat opposite or wait); if empty, holds <span class="mono">350ms</span> after retreat</li>
      <li>First failure on a teammate-occupied tile &#8594; broadcast <span class="mono">BLOCKED_AT</span> with own parcel count; the blocker keeps priority if it carries more, else does a perpendicular side-step or same-direction backoff</li>
    </ul>
  </div>
  <div class="card purple-border">
    <h3>Recovery</h3>
    <ul>
      <li><strong>Auto temporary blacklist:</strong> 3 failures on the same non-critical tile &#8594; <span class="mono">5s</span> blacklist + replan; spawner and delivery tiles are never blacklisted</li>
    </ul>
  </div>
</div>
