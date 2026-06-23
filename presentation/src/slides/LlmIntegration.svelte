<script>
  import flowImg from '../assets/llm-flow.svg'
</script>

<h2 style="font-size: 1.7rem; margin-bottom: 0.15em;">LLM integration: a mission compiler over BDI</h2>
<p class="subtitle" style="font-size: 0.92rem; margin-top: 0.2em;">
  The model runs only when a natural-language mission is pending; otherwise BDI plays unchanged. Its output is constrained to tools that install validated rules.
</p>

<!-- diagram: the hybrid gate and the persistent llmMemory loop (scripts/llm_flow_diagram.py) -->
<div class="diagram-panel">
  <span class="panel-tag mono">generateBestIntention()</span>
  <img class="flow-img" src={flowImg} alt="LLM data flow: a mission gate routes to BDI deliberation with zero latency when no mission is pending, otherwise to LLM tool rounds; flow tools act through the executor and executor results feed back as retry hints, while config tools persist rules into llmMemory, which BDI re-reads every tick" />
</div>

<!-- 2 x 2 grid of the four reasoning pieces -->
<div class="llm-cards">
  <div class="card green-border">
    <h3>Prompt</h3>
    <ul>
      <li>ASCII map of the grid + JSON state: position, parcels with score, delivery tiles, spawners, visible agents, blacklist, active rules</li>
      <li><span class="mono">tool_choice: required</span>, <span class="mono">temperature: 0</span>, max 4 rounds per tick</li>
    </ul>
  </div>

  <div class="card orange-border">
    <h3>11 tool functions</h3>
    <ul>
      <li><strong>Movement / flow:</strong> <span class="mono">go_pick_up</span>, <span class="mono">go_to</span>, <span class="mono">drop_at</span>, <span class="mono">wait</span>, <span class="mono">send_message</span>, <span class="mono">resolve_mission</span></li>
      <li><strong>Persistent config:</strong> <span class="mono">set_stack_rule</span>, <span class="mono">set_max_pickup</span>, <span class="mono">set_delivery_reward</span>, <span class="mono">blacklist_tile</span>, <span class="mono">command_peer</span></li>
    </ul>
  </div>

  <div class="card purple-border">
    <h3>Persistent rules in <span class="mono">llmMemory</span></h3>
    <ul>
      <li>Config tools write to <span class="mono">llmMemory</span>, read by BDI every tick: <span class="mono">stackRules</span> (delay delivery until N carried), <span class="mono">maxPickupReward</span> (exclude parcels over a threshold), <span class="mono">deliveryRewards</span> (override tile reward, <span class="mono">0</span> = never)</li>
    </ul>
  </div>

  <div class="card red-border">
    <h3>Executor feedback</h3>
    <ul>
      <li>Tool failures and executor outcomes feed the next LLM round/revision with <strong>targeted hints</strong> (e.g. occupied cell, no parcel carried, no path), so the mission can retry with a different action</li>
    </ul>
  </div>
</div>

<style>
  .diagram-panel { margin-top: 10px; }
  .diagram-panel .flow-img { max-height: 30vh; }

  .llm-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    width: 100%;
    max-width: 1060px;
    margin-top: 14px;
  }
  .llm-cards .card { padding: 11px 18px; }
  .llm-cards h3 { margin-bottom: 4px; font-size: 1.08rem; }
  .llm-cards ul { margin: 0; padding-left: 17px; }
  .llm-cards li {
    text-align: left;
    color: var(--text-muted);
    font-size: 0.92rem;
    line-height: 1.45;
    margin-bottom: 4px;
  }
  .llm-cards li strong { color: var(--heading); }

  @media (max-width: 860px) {
    .llm-cards { grid-template-columns: 1fr; }
  }
</style>
