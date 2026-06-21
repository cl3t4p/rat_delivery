<script>
</script>

<h2>Intention Revision: commit, but not blindly</h2>
<p class="subtitle" style="font-size: 1rem;">
  Before each revision the active intention is re-validated, then replaced only if the gain is real — and never if it is a bilateral commitment.
</p>

<div class="cols">
  <div class="card blue-border">
    <h3>Validity check</h3>
    <ul>
      <li>Active intention is verified first: parcel gone, taken by another agent, reward at <span class="mono">0</span>, or a closer peer</li>
      <li>Any of these &#8594; <strong>invalidated immediately</strong></li>
    </ul>
  </div>
  <div class="card green-border">
    <h3>Improvement threshold (+5)</h3>
    <ul>
      <li>An active intention is replaced only if the new one beats it by <strong>5 points</strong></li>
      <li>Stops the agent oscillating between options of similar value</li>
    </ul>
  </div>
</div>

<div class="cols">
  <div class="card orange-border">
    <h3>Stuck watchdog</h3>
    <ul>
      <li>Each sensing tick stores the best-ever Manhattan distance to target (<span class="mono">bestDist</span>)</li>
      <li>No improvement for <span class="mono">4s</span> &#8594; intention failed, <span class="mono">peerGoToLock</span> cleared, re-deliberation forced</li>
      <li>Covers <strong>any</strong> cause of stall: rival agent, crate in the way, cyclic path</li>
    </ul>
  </div>
  <div class="card red-border">
    <h3>Wait expiry</h3>
    <ul>
      <li>A <span class="mono">wait</span> expires after <span class="mono">3s</span> even with no new events</li>
      <li>The agent never stays still indefinitely</li>
    </ul>
  </div>
</div>

<div class="card purple-border" style="max-width: 920px; margin-top: 18px;">
  <h3>Protected from preemption &amp; <span class="mono">interruptForRevision()</span></h3>
  <ul>
    <li><strong>Bilateral commitments</strong> — an in-progress handoff and peer-commanded moves are never interrupted by a higher-scoring intention</li>
    <li><strong><span class="mono">interruptForRevision()</span></strong> — used by the LLM to preempt the current intention immediately, without waiting for the next tick; also invalidates any async deliberation already running</li>
  </ul>
</div>
