<script>
</script>

<h2 style="font-size: 1.7rem; margin-bottom: 0.15em;">Beliefs: what we remember and why</h2>
<p class="subtitle" style="font-size: 0.92rem; margin-top: 0.2em;">
  The belief store holds the world model plus the assumptions that keep decisions stable between sensing events.
</p>

<div class="cols">
  <div class="card blue-border">
    <h3>Content</h3>
    <ul>
      <li>Map/grid, parcels (with <strong>current reward</strong>), agent position, <span class="mono">carrying</span></li>
      <li>Nearby agents and a <strong>crate cache</strong> for tiles that affect future paths</li>
    </ul>
  </div>
  <div class="card green-border">
    <h3>Event-driven update</h3>
    <ul>
      <li>Beliefs update on <strong>every server signal</strong> — new parcel, agent seen, etc.</li>
      <li>Meanwhile parcels <strong>lose value on their own every second</strong>, even with no new signals</li>
    </ul>
  </div>
</div>

<div class="cols">
  <div class="card orange-border">
    <h3>Peer stale tracking</h3>
    <ul>
      <li>Nearby agents are marked <span class="mono">stale</span> after a timeout with no updates</li>
      <li>A* and deliberation then <strong>ignore them</strong>, so we don't dodge obstacles that are no longer there</li>
    </ul>
  </div>
  <div class="card purple-border">
    <h3>Parcel suppression</h3>
    <ul>
      <li>If a peer already took a parcel, it <strong>temporarily disappears</strong> from our beliefs so we don't chase it too</li>
      <li><strong>Stronger for handoff:</strong> a parcel dropped on purpose for the peer is ignored, so we don't grab our own drop by mistake</li>
    </ul>
  </div>
</div>

<div class="card red-border" style="max-width: 920px; margin-top: 18px; flex: none;">
  <h3>Blacklist</h3>
  <ul>
    <li><strong>Permanent</strong> — tiles off-limits for the whole game; writable by both BDI logic and the LLM via <span class="mono">blacklist_tile</span></li>
    <li><strong>Temporary (TTL)</strong> — blocked tiles that self-unlock; created by executor recovery to avoid false positives in pathfinding</li>
  </ul>
</div>
