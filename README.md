# rat_delivery

BDI agents for the [Deliveroo.js](https://github.com/unitn-asa/Deliveroo.js) game — Autonomous Software Agents project @ UniTN (Alex Zanetti, Francesca Loffredo).

The project has three main operating modes:
- **Single agent** — one BDI agent on A* pathfinding, with optional LLM deliberation
- **Multi-agent** — two cooperative agents that split the map into zones, exchange belief updates, and hand off parcels to each other
- **PDDL** — single agent where every movement is planned by a symbolic PDDL solver (supports Sokoban-style crate pushing)

---

## Setup

Requires Node.js ≥ 18 and a running Deliveroo.js server.

```bash
npm install
cp .env.example .env
# edit .env
```

The minimum required fields are `HOST` and `TOKEN` (or `TOKEN_A`/`TOKEN_B` for multi-agent). All other options are documented in `.env.example`.

---

## Running

### Single agent

```bash
npm run single       # A* + heuristic deliberation 
npm run single:llm   # A* + LLM deliberation
npm run pddl         # PDDL planning
```

### Multi-agent (two separate terminals)

```bash
# terminal 1
npm run agent:a        # Agent A — plain BDI

# terminal 2
npm run agent:b        # Agent B — plain BDI
npm run agent:b:llm    # Agent B — LLM
```

Agent B acts as coordinator: it runs the zone assignment loop, receives natural-language objectives over the Deliveroo chat, and can negotiate handoffs with Agent A. Agent A accepts zone assignments and participates in the handoff protocol but has no LLM.

`TOKEN_A` and `TOKEN_B` must both be set in `.env`.

---

## PDDL planner

The PDDL solver runs locally as a Docker stack (planning-as-a-service). One-time setup:

```bash
bash setup.sh          # clones the upstream repo and builds the Docker image
# or just the build step:
npm run planner:build
```

Then to start/stop:

```bash
npm run planner:up     # starts the stack, HTTP API on :5001
npm run planner:down
npm run planner:logs   # follow web + worker logs
```

The PDDL domain (`src/pddl/domain.pddl`) models navigation and parcel pickup/delivery, plus Sokoban-style crate pushing — the planner finds routes around or through crates by reasoning about push preconditions.

---

## Configuration

The relevant `.env` variables beyond `HOST` and tokens:

| Variable | Default | Notes |
|---|---|---|
| `USE_PDDL` | `false` | Force PDDL planning in multi-agent mode (`npm run pddl` overrides this) |
| `USE_LLM` | `false` | Use LLM deliberation (also set by the `:llm` npm scripts) |
| `LITELLM_BASE_URL` | `https://llm.bears.disi.unitn.it/v1` | OpenAI-compatible gateway |
| `LITELLM_API_KEY` | — | Required when `USE_LLM=true` |
| `LOCAL_MODEL` | `llama-3.3-70b-lmstudio` | Model to use |
| `LLM_FAILURE_THRESHOLD` | `3` | Circuit breaker: failures before the LLM is disabled temporarily |
| `LLM_COOLDOWN_MS` | `120000` | How long the circuit breaker stays open |
| `PAAS_HOST` | `http://localhost:5001` | PDDL solver endpoint |

Tuning options (pickup scoring, spawner patrol behaviour, multi-agent coordination) are all in `.env.example` with comments.
