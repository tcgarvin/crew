# Crew: design critique and recommendations (senior design partner)

I read both documents in full: the GDD (§1–27) and the Simulation Design (§1–26). The sections below follow your A–G. Where I disagree with the docs, or where the docs leave something to decide, I say so directly.

---

## A. Architecture on Vercel + Neon with a client-authoritative sim

### A.1 What lives where

**Browser (authoritative for hard state while a game is open)**
- **Kernel in a dedicated Web Worker**, not on the main thread.
  - The worker owns `WorldState`, the fixed-step accumulator, the input log, serialization, compression (`CompressionStream`) and the local write-ahead to IndexedDB.
  - The main thread runs React (panels, decision cards) and a plain canvas renderer. React never renders per frame.
  - The worker posts a compact render frame each tick (a transferable `Float32Array` of positions plus a small list of dirty entities). The main thread interpolates between the last two frames.
  - The inspector asks for projections on demand (`getAgentView`, `getDebugSnapshot`) instead of receiving full state every tick.
- **Host logic around the kernel** (the "host" in sim doc §16): speed control, pause-on-decision, pause on `visibilitychange: hidden`, checkpoint scheduling, narrator trigger detection, and applying narrator proposals.
- **Content bundle**: static, hashed JSON served as an immutable asset. Per-game generated definitions arrive inside the snapshot (see C.6).

**Vercel Functions (Node, Fluid Compute)**
- Identity and auth. Anonymous token first, OAuth later. Do not overbuild this.
- The persistence API: games, checkpoints, input log, significant events, and narrator state.
- **Narrator orchestration.** The server builds the digest, calls Anthropic, validates output, translates it to kernel commands, dry-run-validates them, and persists a *proposal*.
- **Validation of generated content** through the same pipeline used for authored content (E).
- The server **uses the kernel as a library, never as a clock.** It calls `restore`, `validateCommand`, the digest projection and `getAgentView` on a stored snapshot. It never ticks in the request path. Headless forward simulation belongs to offline tools: replay verification, content smoke tests and seed sweeps.

**Neon (Postgres)**
- Durable records: users, games, checkpoints, input log, significant-event log (the source for the chronicle), narrator call records, and narrative state (arcs, hooks, canon, supporting-cast flavor, conversation annotations).
- **Narrative secrets never go to the client.** The client only receives commands and player-facing text.

### A.2 Persistence: cadence, size, compaction

**Inputs are tiny and rare.** Sim inputs are decision resolutions, narrator commands, contract acceptance and the like. Speed and pause are *not* sim inputs, because they do not change state. Store every input forever:
- `inputs(game_id, seq, command_id UNIQUE, target_tick, source, payload jsonb, created_at)`.
- Append-only, with idempotency by `command_id` (sim doc §19.2 already requires ID idempotency).

**Snapshot size estimate** for one deck (~40×25 tiles), 8 actors, a few hundred items, tasks, knowledge and reports: roughly 100–400 KB of JSON, or 20–80 KB gzipped. Two things make it grow without bound unless you design against it:
- Per-actor knowledge (§13).
- Retained history (dead entities, completed tasks, superseded facts).

Put a retention rule into the sim itself (G.14) and track snapshot size as a CI metric.

**Two-tier checkpointing:**

| Tier | Cadence | Purpose |
|---|---|---|
| IndexedDB (local write-ahead) | Every ~300 ticks (15 sim-s) while running, plus on every input | Durability against tab close, crashes and flaky mobile networks |
| Neon | Every ~60 wall-seconds while running, on every decision resolution, on every narrator trigger, on dock/undock ("milestone"), and best-effort on `pagehide` | Cross-device resume, narrator context, replay/desync forensics |

- Store checkpoints as gzipped `bytea` plus extracted columns: `tick, state_hash, schema_version, sim_version, deployment_id, content_hash, config_hash, parent_checkpoint_id, is_milestone`. Use `bytea`, not `jsonb`: nobody queries inside the blob, and `jsonb` normalization is wasted work. If size becomes a problem, move blobs to Vercel Blob and keep a pointer in the row. Do not start there.
- **Compaction:** keep every milestone checkpoint (dock/undock, arc boundaries) and the last N=5 rolling checkpoints; delete other rolling ones. Inputs plus milestone checkpoints are enough to reproduce any interval using the matching build (see risk 1).
- `pagehide` uploads are limited: `sendBeacon` and `fetch({keepalive})` cap the payload at about 64 KB in total. Send the input-log tail and the tick there, not the snapshot. IndexedDB is the real durability mechanism.
- **Resume logic:** on load, compare the local head with the server head by `(lineage, tick)`. If they share lineage, take the newer one and sync. If they diverge (two devices), the server head wins and the local copy is kept as an orphan for debugging.

### A.3 How the Narrator gets sim context

This is my strongest recommendation in this section: **the server projects the digest itself; it neither trusts a client-supplied digest nor re-simulates.**

1. The client detects a trigger (A.4 / D.4). It uploads or refers to a checkpoint at tick T, plus the significant events since the previous narrator call.
2. The server restores that snapshot with the shared kernel package and computes `NarratorDigest = project(snapshot, eventsSince, narrativeState)`. The projection is a pure, deterministic function. This removes digest/snapshot mismatch, keeps the client from shaping narrator context, and makes every narrator call reproducible offline from the stored inputs (important for prompt evals).
3. Re-simulating from a checkpoint is useful, but only off the hot path: desync detection and "what happened between T1 and T2" forensics. It is not how the narrator sees the world.

One temptation to resist: server-side *lookahead* ("run 600 ticks to see whether venting kills Nate") to inform card text. That leaks omniscient outcomes into captain-facing prose and quietly authors outcomes. At most, allow lookahead for pacing decisions that never reach the player, and I would defer even that.

### A.4 Server-originated commands into a real-time client sim

The docs do not address this. It is the defining problem of this architecture.

Narrator output is computed against tick T and arrives at T+Δ. Δ ranges from seconds to more than a minute for Opus, and is longer in sim time at 4× speed. Contract:
- Narrator commands never specify an absolute tick. They carry either a **window** (`earliest/latest` relative to receipt, or to a named future transition such as "after next undock"), or a **trigger condition** from a small whitelisted predicate set (C.8).
- Every proposal has `basisTick`, `validUntilTick` and per-command **preconditions**, e.g. "actor a12 alive", "ship docked at port p2".
- The client enqueues commands at `max(now+1, window start)`. The kernel re-validates at application time. The client acks the concrete tick or the rejection reason, and the server records `proposal.status = applied@tick | rejected(reason) | expired`. The next narrator call sees these outcomes, so the narrator adapts rather than protecting its outline (GDD §18).
- A narrator call runs to completion even if the tab closes. The function writes the proposal to Neon before responding; use `waitUntil` from `@vercel/functions` as a guard. On reload the client fetches pending proposals. **Nothing may depend on a live connection.** Plain request/response plus polling on resume is enough; WebSockets are unnecessary, and SSE is optional polish.

### A.5 The trust boundary

For a single-player game, cheating does not matter. The boundary still matters for four things:
1. **LLM spend.** A buggy or hostile client can spam narrator triggers. The server enforces a per-game budget in sim time (the ticks advanced between calls must be plausible for the elapsed wall time), per-user daily token quotas, and dedupe by `(game, trigger kind, tick window)`.
2. **Server robustness.** Uploaded snapshots are untrusted input. Enforce a size cap and schema version, and restore inside try/catch.
3. **Narrative secrets.** Arcs, hidden motives and planned beats stay server-side. Commands that reach the client (e.g. "spawn a diamond in this luggage") are visible in devtools. That is an acceptable single-player spoiler, but do not ship the arc document.
4. **Log ordering.** The client assigns ticks; the server assigns persistence order (`seq`) with optimistic concurrency on `games.head_checkpoint_id` / `lease_epoch`.

### A.6 What breaks when the tab closes mid-voyage

- **The sim stops.** That is correct: the GDD is about observed 1× play, and sim doc §19.4 says paused worlds do not advance. Make "the ship waits for you" explicit and pause on `hidden`, because browsers throttle background timers heavily anyway.
- **Unsaved ticks since the last local write are lost** (at most ~15 s with IndexedDB). Anything since the last *server* checkpoint is lost only if the user switches devices.
- **In-flight narrator calls finish server-side** and wait as pending proposals. Their windows are relative, so they remain applicable on resume, or they expire cleanly.
- **Open decision card:** the decision is sim state (D.6), so it restores correctly.

### A.7 The three biggest risks and their mitigations

**Risk 1: code version drift breaks saves and replays.** With client-authoritative play and frequent deploys, snapshots written by build N get loaded by build N+1. Sim doc §20.1 says to "fail clearly", which in a prototype means every deploy kills every game and the canon with it.
- Separate **`schemaVersion`** (the snapshot's shape; bump it only with a written migration) from **`simVersion`** (behavior, i.e. the git SHA).
- Loading under a different `simVersion` is allowed for *play*: continuation diverges from exact replay, which is fine. Exact replay requires the original build.
- Record `deployment_id` on every checkpoint. Vercel deployments are immutable and addressable, so a replay tool can load the kernel from the exact deployment that produced the checkpoint.
- Enable **Vercel Skew Protection** so a client bundle keeps talking to its own deployment's functions.
- Before M2, wipe saves freely. From M2 on, maintain pure `migrate_vN_to_vN+1` functions in the sim package.

**Risk 2: cross-engine nondeterminism.** Sim doc §5.4 only asks for determinism "on the same supported runtime". The product breaks that assumption three ways: players on Safari/WebKit (mobile-first), the server projecting and validating in Node/V8, and the owner's stated goal of moving the sim server-side later. IEEE-754 guarantees `+ − × ÷` and `sqrt` bit-for-bit across engines. It does **not** guarantee `Math.exp/log/pow/sin/cos/atan2/hypot/cbrt`, which can differ in the last bit between V8, JavaScriptCore and SpiderMonkey.
- Mitigation: upgrade the requirement to **cross-engine determinism** now, while it costs almost nothing. Details in C.9.

**Risk 3: narrator latency and staleness against a real-time sim.**
- Mitigation: relative windows and preconditions (A.4).
- Latency hiding: kick off port and job generation during *approaching*, not at *docked*.
- Use a fast model for card dressing (D.4).
- A **deterministic fallback for every narrator function**, so the game never blocks on an LLM. Sim-originated decisions always have template text.

Honorable mentions:
- Two tabs forking one game. Mitigate with a lease epoch: opening a game bumps `lease_epoch`, and writes with a stale epoch get 409, which turns the older tab read-only.
- Snapshot bloat from knowledge growth (G.14).

---

## B. Monorepo layout and package boundaries

```
crew/
  packages/
    sim/        # kernel: zero runtime deps, no DOM/Node types
    content/    # Zod schemas, authored JSON, validators, bundle compiler (dep: zod, sim[types])
    narrator/   # digest projection, prompts, LLM output schemas, intent→command translation,
                #   authority checks, captain-view text pipeline (deps: sim, content, @anthropic-ai/sdk injected)
    server/     # Hono (or plain) HTTP app, db queries/migrations, auth, narrator orchestration
                #   (deps: sim, content, narrator, @neondatabase/serverless or pg)
  apps/
    web/        # Vite + React SPA; src/worker (kernel host), src/render (canvas), src/ui;
                #   api/[[...route]].ts re-exports packages/server's app  (deps: sim, content)
    cli/        # headless runner, scenario/seed sweeps, replay-from-Neon, golden-hash update,
                #   offline content generation (deps: everything)
```

**Dependency rules** (enforce in CI with dependency-cruiser; tsconfig project references alone are not enough):
- `sim` imports nothing: no npm packages, no other workspace packages. Its tsconfig uses `"lib": ["ES2022"], "types": []`, so `setTimeout`, `performance`, `crypto`, `window` and `process` **fail to type-check** inside the kernel. That is a cheap, mechanical determinism guard.
- `content → sim` for types only. **`sim` owns the TypeScript interfaces for the definitions it consumes** (`MachineDef`, `DeckLayoutDef`, `ActionRecipeDef`). `content` owns Zod schemas statically asserted against those interfaces (`schema satisfies z.ZodType<MachineDef>`). The kernel stays dependency-free while one validation path serves everyone.
- `web` must not import `narrator` or `server`. That keeps secrets, prompts and the SDK out of the bundle.
- Inside `sim`, `planner/**` may import only `view/**` (the AgentView types) and `core/types`. It may not import `state/**` or any `systems/**`. This is the mechanical form of sim doc §4.3.

**Ownership of the §4.2 modules.** All of them live in `packages/sim`:
- `core/` holds world and lifecycle, clock and command queue, ids, rng, events, hash, pipeline, serialize/restore/migrate, and invariants.
- `systems/` holds spatial, networks, environment, equipment, bodies, perception, work-execution, social, travel, and decisions.
- `planner/` holds work selection only.
- `view/` holds the AgentView builder and render/debug projections.

"Persistence and diagnostics" is split: the *kernel* part (serialize, hash, invariants, bounded trace ring) is in sim; the *host* part (IndexedDB, Neon) is in web and server. The narrator digest projection lives in `narrator`. It is pure and uses `sim/view`, but it is server-only.

**Toolchain (lean):**
- pnpm workspaces and `tsc -b` with project references for type-checking.
- **Internal packages export TS source** (`"exports": {".": "./src/index.ts"}`). Vite and Vitest consume TS directly. *Risk:* Vercel's function bundler and workspace TS sources. Prove it in the M1 walking skeleton. If it is flaky, build `sim/content/narrator/server` with `tsc` or `tsup` to `dist` for the function path only.
- Strictness: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (matters for JSON state; see C.1), `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `verbatimModuleSyntax`.
- **Vitest** (workspace mode) everywhere; `fast-check` for invariant property tests; `vitest bench` for step timing; **Playwright** for cross-engine determinism (Chromium, WebKit, Firefox) and a thin e2e smoke test.
- **Biome** for formatting and linting (one tool, fast). Add a small custom lint for the sim determinism bans (C.9); Biome's `noRestrictedGlobals` / `noRestrictedImports` cover most of it, or a 30-line script over the TS AST.
- DB access: SQL migration files plus a thin typed query layer. Drizzle or Kysely are both fine. Choose one and don't let it grow.
- **No Next.js.** A canvas game plus a JSON API gets nothing from RSC or ISR. Use a Vite SPA plus functions in the same Vercel project, which gives same-origin requests and Skew Protection.

---

## C. Kernel decisions to make up front (expensive to change later)

### C.1 State representation
- **Plain JSON-compatible objects (POJOs). No classes in state.** Behavior lives in systems, i.e. functions over state. State must survive `JSON.parse(JSON.stringify(s))` exactly, and CI checks this on every tick in tests (C.10).
- Forbidden in state: `Map`, `Set`, class instances, `undefined` values, `NaN`, `±Infinity`, and `-0` (JSON turns it into 0, and `1/-0` differs). With `exactOptionalPropertyTypes`, "absent" and "undefined" stay distinct at the type level. Invariant checks assert that all numbers are finite.
- **Kind tables, not a generic ECS**: `state.actors: Record<ActorId, Actor>`, plus `machines`, `items`, `doors`, `compartments`, `tasks`, `reports`, `decisions`, and so on. Each kind has a fixed shape, and 8–20 actors do not justify component indirection. Sim doc §4.1 already makes ECS optional; I would decline it.
- **No structure-of-arrays** for entities. The scale is tiny, and SoA makes serialization, debugging and LLM-readable digests worse. The one exception is **static** deck geometry: tile grids and navigation caches as typed arrays in *derived caches*, rebuilt from content on restore and never serialized. Dynamic per-tile state (fire, floor integrity, local obstructions) stays in sparse records keyed by tile.
- **Split runtime from state:** `World = { state: WorldState /*serialized*/, caches: Derived /*rebuildable*/, content: ContentBundle /*by hash*/, config: EffectiveConfig }`. The O-scenario test (restore → rebuild caches → continuation equal) enforces that caches hold nothing authoritative.
- **Mutation model:** systems mutate state in place inside the worker. There is no Immer and no immutability, because it is too slow and unnecessary. The "no partial mutation" rule (§19.2) is met by **validate-then-apply**: `validate(state, cmd)` is pure and returns a resolved plan; `apply(plan)` cannot fail. There is no rollback machinery.

### C.2 IDs
- **Two ID spaces, never mixed:**
  - *Definition IDs* are namespaced, human-readable slugs (`machine.coolant_pump.mk1`, `gen.npc.7f3a2c`). Content authors and LLMs write these.
  - *Instance IDs* are allocated by the kernel from a serialized monotonic counter, as **prefixed strings**: `a17` (actor), `m4` (machine), `i203` (item), `t88` (task), `f1204` (fact).
- Prefixed strings, not numbers, for a specific JS reason: object keys that look like integers iterate in numeric order *ahead of* insertion order. Non-integer string keys keep insertion order, and that order survives a JSON round-trip. Prefixed strings are also self-describing in logs and in LLM digests. Use branded types (`type ActorId = string & {__k:'actor'}`) for compile-time safety.
- **Never reuse IDs.** Dead actors and consumed items keep theirs.
- **Temporary references in narrator batches.** A narrator plan that spawns a passenger and a diamond in their luggage refers to them as `$p1` and `$d1`. The kernel resolves those to real IDs in one validated batch and returns the mapping, which the server records in canon.

### C.3 Step pipeline (§5.2)
- A **static, declarative pipeline** in one file, e.g. `pipeline.ts: Phase[] = [{phase: 'inputs', systems: [...]}, ...]`, covering all 8 phases in doc order. There is no dynamic registration and no plugins: ordering is part of `simVersion` (§5.2 says so), and a static array makes that auditable and diffable.
- System signature: `(ctx: StepCtx) => void`. `ctx` carries `state`, `caches`, `content`, `config`, `rng` (named streams), `emit` (event buffer), `dirty` (topology/network flags), and `tick`.
- **Cadence is declared in the pipeline** (`every: 10, staggerBy: 'actor'`). Systems receive `elapsedTicks` so slower cadences integrate actual elapsed time (§5.3).
- **The planner phase (7) gets `AgentView`s, not `ctx`.** The pipeline builds each due actor's view and calls `plan(view, plannerConfig) => Intent`. Execution in phase 3 (next tick) turns intents into validated actions against truth. The §4.3 boundary thus shows up in the function signatures, not just in documentation.
- **AgentView is a read-only accessor facade** over the actor's knowledge store plus static schematic. It is not a deep copy: building copies every 10 ticks per actor is wasteful.

### C.4 Event buffer
- Events are **outputs, not state.** `advance()` returns them. The host decides what to persist (significance tiers, D.2).
- **Systems must not read events emitted earlier in the same tick.** Cross-system communication goes through state (queues, dirty flags, pending reports in state). This rules out hidden event-driven coupling and the unbounded in-tick cascades §5.2 warns about.
- IDs and sequence numbers are assigned in phase 8 as `(tick, seq)`. Every event carries a `significance: trace | notable | narrative` class defined in the event catalog. The host uploads `notable`/`narrative` events to Neon; `trace` events go only to the bounded diagnostic ring buffer.
- Every event carries `causeIds`. Every narrator-caused mutation's causal chain reaches back to a narrator command ID, so the chronicle, debugging and evals can tell "the sim did this" from "the narrator set this up".

### C.5 PRNG
- **Recommendation: `sfc32`** (128-bit state as four uint32 values; passes PractRand; uses only 32-bit ops, `>>>` and `Math.imul`, so it is fast and exact across engines). Seed each stream with `splitmix32(hash(masterSeed, streamName))`. `xoshiro128**` is equally acceptable; just pick one. **Avoid PCG32/64** in JS: its 64-bit multiply needs BigInt or emulation and is slow.
- **Named streams**, stored as `state.rng[streamName] = [a,b,c,d]`: `setup`, `failures`, `health`, `social`, `perception`, `narratorWindows`.
- Go one step beyond the doc: **per-entity keyed draws for independent processes.** Examples are a machine's failure threshold or a person's trait roll. Draw them via `hash(seed, stream, entityId, counter)` instead of consuming a shared stream. Adding a machine, or a narrator-accelerated fault, then does not perturb every other machine's future. That makes A/B tuning and seed sweeps meaningful and keeps narrator interventions local.
- Float conversion: `u32 / 2**32`. It is exact, with no `Math.random`-style ambiguity.

### C.6 Config and content: versioning and hashing (§20.1)
- `config` (tunables) is JSON, validated by Zod in `content`, **canonicalized** (sorted keys, no whitespace) and hashed at build time with SHA-256 via Node `crypto`, so the kernel has no hash dependency. The **snapshot embeds the full effective config** (the doc requires this; it is small) plus `configHash`.
- The **static content bundle** is compiled (resolved, validated, canonicalized) and hashed. The snapshot stores `contentHash`. The bundle is an immutable static asset named by hash, so old bundles stay available.
- **Dynamic definitions:** content created mid-game (narrator NPCs, cargo, ports, plot items) is **embedded in the snapshot** (`state.defs.dynamic`) and also mirrored in Neon `game_content`. A save must always be self-sufficient apart from the static bundle hash.
- **In-kernel state hash:** a synchronous, pure-TS non-cryptographic hash (FNV-1a 64 via two 32-bit halves, or Murmur3-128) over canonical serialization. It is fast enough for per-tick hashing in tests and sparse hashing in production.

### C.7 Numbers and time
- Ticks, money (integer credits), item counts and IDs are integers. Gas, heat, blood and fractional progress are floats, subject to the determinism rules.
- Time is integer ticks only. Convert durations with the documented ceiling rule (§5.1) in one helper.

### C.8 A small trigger/condition primitive, needed by the narrator from day one
Sim doc §19.2 has only "future tick" injection. The GDD's committed beats need conditional scheduling: "after leaving port", "next time Chen and Ortega are alone". Add a **kernel-evaluated `ScheduledTrigger`** to state: `{id, condition: TriggerPredicate, window, then: Command[], source, expiresAtTick}`.
- `TriggerPredicate` is a **closed union** evaluated in phase 6/7, e.g. `travelStateEntered(state)`, `actorsColocatedAlone(a,b,minTicks)`, `shipDockedAt(port)`, `tickAfter(n)`, `and(...)`.
- No expression language and no strings. It is deterministic, serialized, testable, and it caps narrator expressiveness mechanically.

### C.9 Determinism rules (cross-engine; this is risk 2)
- **Banned in `sim/**`:** `Math.random`, `Date`, `performance`, `setTimeout`/`setInterval` (already blocked by `types: []`), `localeCompare`/`Intl`, `Math.exp/log/pow/sin/cos/tan/atan2/hypot/cbrt/expm1/log1p`, `**` with non-integer exponents, `Array.prototype.sort` without a comparator, `for…in`, and `Object.keys` on anything whose order matters unless sorted.
- **Allowed Math:** `abs, min, max, floor, ceil, round, trunc, sign, sqrt, imul, fround, clz32`.
- Provide a **`dmath` module** with deterministic `exp`, `ln` and smoothstep/curve functions: fixed-order polynomial or rational approximations, or lookup tables with linear interpolation. The systemic modifier curves in §12.2 and the heat/gas models need only this.
- **Stable iteration:** kind tables iterate in insertion order, which is deterministic. Anything that must be order-independent, such as candidate ranking, sorts with explicit comparators and a final ID tie-break (§5.4, §15.3). Float reductions (gas transport sums) run in a fixed, documented order.

### C.10 Determinism testing strategy
1. **Golden scenario hashes.** Each §22 fixture runs N ticks and asserts the final state hash, plus hashes every 100 ticks. Goldens are committed. Changing one requires an explicit `pnpm golden:update` and a `simVersion` note, like snapshot tests.
2. **Replay equality:** two runs with the same seed and inputs produce hash sequences that match on every tick.
3. **Render independence** (scenario B): `advance(1)×N ≡ advance(N)`, and variable batching per frame gives the same result.
4. **Save/restore fuzz** (scenario O): at random ticks, serialize → JSON round-trip → restore → rebuild caches → continue, and compare against the uninterrupted run tick by tick. Also run with a **JSON round-trip on every tick** to catch `undefined`, `NaN`, `-0` and `Map` leaks.
5. **Cross-engine:** Playwright runs the golden scenarios inside a worker in Chromium, WebKit and Firefox and compares with Node's hashes. This single test turns risk 2 from a hope into a gate.
6. **Property tests** (fast-check) for the §19.4 invariants over random command sequences and seeds.
7. **Production desync detection:** the client records a sparse hash every 200 ticks alongside checkpoints. An offline CLI job replays `checkpoint_k + inputs → checkpoint_{k+1}` using the recorded deployment's kernel, and flags divergence with the first bad hash window for bisection.

---

## D. Narrator integration contract

### D.1 Principle
The narrator is an **optional enhancer with a deterministic null implementation.** `NullNarrator` uses template card text, a deterministic job source (§17.3) and no injections. It is the headless test host, the offline/dev mode, the budget-exhausted fallback and the zero-player baseline. If the game does not work with `NullNarrator`, the simulation hypothesis has failed, and you want to learn that without LLM noise.

### D.2 Read surface
The server builds `NarratorDigest` from the snapshot (A.3):
- **Truth section.** Omniscient, clearly labeled. Actors with capacities, wounds, mood, relationships; machines with faults (hidden and known); travel/contract state; notable inventory (plot items and their true locations); active triggers and pending narrator commands.
- **Captain-knowledge section.** A serialization of the command actor's AgentView: known facts with staleness and provenance, and what the captain believes versus what is true.
- **Recent significant events** since the last call, of `notable` and `narrative` significance, with `causeIds`.
- **Narrative state** from Neon: the primary arc, dormant hooks, supporting cast, relevant canon entries (retrieved by entity overlap with the current cast, location and port; plain SQL is enough, no vector DB needed yet), and the **authority budget remaining**.
- **Token discipline:** the digest is summarized, uses stable IDs plus display names, and has a hard token cap per cadence. Put static rules, the world bible and the command vocabulary in a **prompt-cached prefix**. The dynamic digest goes last.

**Neon narrative tables:**
- `arcs(id, game_id, status, premise, cast jsonb, beats jsonb, secrets jsonb, opened_tick, closed_tick, summary)`
- `hooks(...)`
- `canon(id, game_id, tick, kind, text, entity_ids[], cited_event_ids[], importance, visibility: captain|hidden)`
- `cast(npc_id, game_id, def_id, flavor jsonb, status)`
- `annotations(event_id, text)` for the discoverable dialogue in GDD §8
- `narrator_calls(id, cadence, basis_checkpoint_id, digest_hash, model, prompt_version, tokens, latency_ms, output jsonb, status)`

**Canon must cite events.** Every canon entry references sim event IDs. Ungrounded canon is how LLM continuity drifts.

**Hard canon lives in the sim; narrative canon lives in Neon.** "The diamond exists in cabin 3's footlocker" is sim state. "The passenger is secretly a courier for the Ashen syndicate" is Neon. Off-ship NPCs need a minimal hard record in sim (alive/dead, location port, possessions) so that their death or possessions are canonical (G.11).

**Timeline consistency:** narrative rows carry `created_tick`. If a dev rollback or local/server divergence resolves to an earlier tick, truncate narrative rows after that tick. Recommend **no player-facing save-scumming** in the prototype: one linear timeline per game.

### D.3 Write surface, enforced mechanically
The LLM emits `NarratorPlan { intents: NarratorIntent[], notes }` through structured output. The server translates intents into **`NarratorCommand`**, a *separate TS union that is a strict subset* of kernel commands. The kernel's `enqueueCommand` checks an **authority table `source × commandKind`** held in config; anything outside it is rejected.

| Intent → command | Mechanical rule (kernel-enforced) |
|---|---|
| `spawnAtBoundary(defs, location)` | Creation is allowed **only at the boundary of observation**: off-ship (port external stores, NPC records), inbound manifests and passenger luggage *before* boarding, incoming comms or vessels. Never directly into an on-deck location or container aboard. The diamond exists because it boarded in the luggage, which also fixes the "can't materialize retroactively" problem (GDD §2.3) by construction. |
| `scheduleFault(machineId, faultType, window)` / `accelerateFault` | The target must be a **machine or structure, never an actor, tile or compartment occupant**. The fault type must be in that machine's definition catalog. **The kernel samples the exact tick inside the window with its own RNG stream**, so the narrator cannot time a failure for the moment Nate walks by. This is the cleanest mechanical form of "guarantee the ambush, not the death". Recorded as a change to the failure schedule with an audit source (§19.2). |
| `suppressHazards(scale, window)` | Scales the failure hazard downward for decompression periods after tragedy. Bounded range. |
| `scheduleTrigger(predicate, window, then)` | Uses the closed predicate union (C.8). `then` may contain only other narrator-permitted commands. |
| `socialBeat(a, b, kind)` | Arms a *latent interaction* ("conflict comes to a head when alone"). The kernel's social system resolves the outcome with normal rules. |
| `adjustSoftState(a, b, dim, delta, citedEventIds)` | `delta` is capped per call and per sim-hour. **Each cited event must list both actors as subjects or witnesses**, which is checked against the event log the server holds. This makes GDD §17's "more freely *when justified by actual events*" enforceable. |
| `offerJob(contractDraft)` | Pay must fall inside config price bands for the distance and cargo class, so the narrator cannot mint money. The job becomes a decision card. |
| `sendMessage(channel, fromNpc, content)` | The **only** way the narrator can put information into crew knowledge is an in-world channel message (comms, a port authority notice, a letter). It then goes through normal delivery and can fail if the comms array is down. **No direct knowledge injection.** |
| `surfaceDecision(card)` | See D.6. |

**Structurally absent** (no command exists, so no prompt can reach it): set any body, blood, health, need or position field; kill or heal; teleport; delete an entity; edit knowledge; rewrite past events; set money directly.

**Budgets** such as `dramaBudget` (injections per sim-hour, spawn counts, soft-state delta per day) live in **sim state**, so they are deterministic, saved and replayable. The kernel decrements them. The digest shows what remains.

**Batch atomicity:** a plan may be flagged `atomic` (validate all, then apply at the same tick), e.g. "spawn a passenger *and* their luggage *and* a decision card".

### D.4 Cadence
The GDD (§26) is right that the functions differ. Make the **model configurable per cadence**. Keep `claude-opus-5` as the default for heavy calls, and allow a faster or cheaper model where latency blocks the player.

| Cadence | Trigger (deterministic, client-detected, server rate-limited) | Latency tolerance | Output |
|---|---|---|---|
| **Card dressing** | A kernel `DecisionNeeded` emitted (sim is paused) | **Low: the player is waiting.** Template shown immediately; prose swapped in if it arrives within ~2–3 s, otherwise the template stays. Tune after measuring. | Captain-POV text only |
| **Port/job generation** | Travel state enters *approaching* (hidden behind approach, docking and unloading) | Tens of seconds | Jobs, passengers, NPCs, cargo defs (boundary spawns) |
| **Arc management** | Arc-relevant notable events; dock/undock; quiet heartbeat (e.g. every N sim-minutes with no narrative events) | Minutes | Beats, triggers, fault scheduling, hooks |
| **Social interpretation** | Batched notable social events | Asynchronous | Soft-state adjustments with citations; conversation annotations |
| **Arc summary** | Arc closed (kernel or narrator predicate) | Asynchronous | Chronicle entry (captain-boundary rules apply; see D.5) |

Do **not** run an LLM "rapid check for captain-worthy decisions" (GDD §26). Captain-worthiness for sim crises is deterministic policy (sim doc §16: `PolicyDecisionNeeded`). Narrator-originated decisions arise in the arc and port cadences.

### D.5 The captain-information boundary for player-facing text
Enforce it by **context isolation plus citation checks**, not by prompt instructions:
1. **Two-stage generation.** The *showrunner* call (omniscient digest) produces **structured intents only, never player prose.** A separate *writer* call receives **only the captain's AgentView serialization**, the relevant captain-visible canon, and the card's structured content. The writer cannot leak what it never saw. The rare exception is hallucination that happens to guess right, which is a much smaller risk.
2. **Citations.** The writer's output schema requires `citedFactIds[]` (captain KnownFacts) and refers to entities only via placeholders (`{actor:a12}`). The server verifies that every cited fact is in the captain's knowledge store and that every referenced entity is known to the captain, then re-renders names. On failure, regenerate once, then fall back to the template.
3. **Optional leak judge.** Before display, a cheap model call checks the prose against the showrunner's `secrets[]` list. Add it only if (1) and (2) prove insufficient in evals.
4. **Perspective holder.** The perspective is whoever holds command authority: the captain, or the first officer when the captain is incapacitated (sim doc §13.6). The FO's knowledge does not inherit the captain's.
5. **Arc summaries are player-facing**, so they use the same writer path. Whether an epilogue may *reveal* undiscovered truths is an owner decision (G.4).

### D.6 Decision card flow
1. **Origin.** Either (a) the kernel emits `PolicyDecisionNeeded` with executable alternatives (§16), or (b) a narrator `surfaceDecision` arrives with two option command lists that the server has **dry-run-validated** against the basis snapshot.
2. **A `Decision` entity is created in sim state:** `{id, origin, perspectiveActorId, options: [left, right], each {label key, commands[] | nextDecisionId}, preconditions, createdTick}`. Because it is state, it survives save/load and replay, and "paused on decision" is reproducible. **Binary trees** use `nextDecisionId`.
3. **The host sees `pendingDecision` and pauses the clock** (GDD §22). The UI shows a full-screen card with template text immediately, and prose when ready (D.4). The player may leave the card to inspect state; the sim stays paused.
4. **The player chooses.** The client enqueues `ResolveDecision{decisionId, side}` at `currentTick+1`. The kernel **revalidates** the chosen option's commands. They normally stay valid because the sim was paused, but narrator-originated options could be stale. It applies them atomically, emits `DecisionResolved`, and the host resumes and uploads the input.
5. **Queueing.** Only one decision is presented at a time. Additional decisions queue in state in FIFO order by urgency class and are **revalidated on presentation**. If invalid, they are dropped with an event (G.6).
6. **Headless and zero-player.** A deterministic `DecisionPolicy` in the host resolves decisions (sim doc §16), so scenario M runs in CI.
7. **Contract acceptance** is a decision card as well, which gives the full loop before the narrator exists.

---

## E. Content-as-data pipeline

### E.1 Schemas
- **Zod 4 is the single source of truth.** Generate JSON Schema with Zod 4's built-in `z.toJSONSchema()`; the `zod-to-json-schema` package is unnecessary on v4. Generated JSON Schemas serve two uses:
  - `$schema` for editor autocompletion on hand-authored JSON.
  - Anthropic structured output (`output_config.format`).
- **Two schema layers.** This is the key point.
  - **Canonical definition schemas** are what the kernel consumes (resolved IDs, full numeric parameters).
  - **LLM-facing draft schemas** are flat and closed (`additionalProperties: false`), enum-heavy, name-based rather than ID-based, and give **archetype plus bounded parameters instead of free numbers**. Example: `{archetype: "coolant_pump", tier: 2, quirks: ["noisy"], flavor: "..."}` rather than raw hazard rates.
  - A deterministic **compiler** turns a draft into canonical form, deriving numbers from config tier tables. Generated content then cannot wreck balance, and the LLM-facing schema stays inside whatever subset structured outputs supports. Check the current Anthropic docs for supported keywords and limits and keep draft schemas conservative: no recursion, and shallow nesting.

### E.2 One validation path for authored and generated content
`validate(fragment, againstBundle) → Result<CompiledDefs, Issue[]>`, run in four levels:
1. **Structural:** Zod.
2. **Referential:** every definition ID resolves across the bundle plus dynamic defs; namespaces are respected (`gen.*` only for generated content); no ID collisions.
3. **Semantic/physical:** decks are connected; doors sit on boundaries; each interaction position is reachable and adjacent to its footprint; footprints do not overlap; power, cooling and comms graphs are connected where declared; recipes reference existing items and tools; the body tree is acyclic; station requirements are satisfiable by the roster's qualifications.
4. **Simulation smoke:** for structural content (ship layouts, machine definitions, action recipes), run the headless kernel on a canned scenario for N sim-minutes and assert no invariant violations, no planner exceptions, and basic liveness (e.g. crew eat, cargo moves).

Hand-authored content runs levels 1–4 in CI. Runtime-generated fragments (NPCs, cargo, plot items, ports) run levels 1–3 in the server function; level 4 is unnecessary for "things", only for "places and machines".

### E.3 Trajectory for generation
- **Phase 1 (M2 onward): offline generation.** Scripts in `apps/cli` call the model, compile and validate, and write JSON into `packages/content/data/**`, with provenance sidecars (model, prompt hash, generator version, date). **Review it in PRs like code.** Good first targets: crew flavor (names, backgrounds; traits stay procedurally sampled per GDD §2.5), port descriptions, cargo catalogs, NPC archetypes.
- **Phase 2 (narrator M4 onward): runtime per-game generation** of NPCs, cargo manifests, plot items, minor ports and outposts as abstract locations. The narrator emits drafts; the server compiles and validates at levels 1–3; the result is stored in Neon `game_content` and embedded as dynamic definitions via boundary spawns.
- **Phase 3 (post-slice): generated ships and machines.** Offline at first, requiring level 4 plus human review. Runtime only once level 4 is fast and trusted. Plan for layouts to be "archetype template plus parameterized variation" long before they are free-form.
- Definition IDs: generated content gets `gen.<kind>.<shortHash>`, derived from the canonical content hash, so regenerating identical content is idempotent.

---

## F. Revised milestone plan

Principles:
- Every milestone ends **deployed** to Vercel with a playable build, green acceptance fixtures in CI, and a short 1× playtest note.
- A **scenario gallery** (`/scenarios/:id`) runs each §22 fixture visually in the browser from the same fixture data CI uses. It is cheap to build and serves as the best observability tool you will have.
- Truth and knowledge overlays in the renderer from M1.

**M1: Physical kernel, walking skeleton, deployed**
- Kernel: sim doc M1 (ticks, IDs, rng, geometry with `deckId`, located objects and containment, A* movement with fractional positions, doors, commands/events, serialize/restore/hash, invariants, pipeline skeleton with all 8 phases, even if some are empty).
- Content: deck layout schema plus validation levels 1–3; one authored freighter deck.
- Web: worker host, canvas dots with interpolation, speed/pause, debug inspector.
- Server: anonymous auth, games, checkpoints (IndexedDB plus Neon), resume, lease epoch.
- CI: golden hashes, JSON round-trip, **cross-engine Playwright**.
- *Done:* open the Vercel URL on a phone, watch dots wander through doors, close the tab, reopen and resume at the same tick.
- *Unlocks:* **B**, **O** (movement/doors subset), **R** (determinism part), §19.4 location/containment/pause invariants.

**M2: Routine work, AgentView boundary, decision plumbing**
- Kernel: tasks, actions and claims (claims global and communicated when comms are up; partitioned claim knowledge deferred to M3), hauling, blockage reasons, hunger/fatigue/rest, authored shifts, staffed stations, travel state machine, contracts, payment exactly once, deterministic job source.
- The **AgentView and planner module boundary is enforced by dependency-cruiser** (as the doc insists: the boundary exists here).
- **Minimal ambient social:** proximity chat events with template lines, no relationships yet. This buys motion for the watchability test cheaply.
- `Decision` entities; the card UI (mobile-first) with template text; `DecisionPolicy` for headless runs; contract acceptance as a card.
- Offline content generation for crew flavor.
- *Done:* a complete freight loop between three ports at 1×, with no input except job cards.
- *Unlocks:* **A** (without faults), **L**, **R** (30-minute endurance, ordinary operation).
- **Gate:** the first honest check of the simulation hypothesis on a phone. If watching is dull here, fix it before adding crises.

**M3: Knowledge and equipment**
- Sim doc M3: typed facts with provenance, reports and delivery, comms and sensor graphs, power domains, a small fault catalog, diagnosis, repair recipes with target-owned progress, real resource acquisition, stale knowledge, partitioned claim knowledge.
- Renderer: a **captain-knowledge layer** alongside truth.
- *Unlocks:* **C, F, G, K**.

**M4: Narrator v0**
- Server orchestration, digest projection, Neon narrative tables, proposal lifecycle (proposed/applied/rejected/expired), the authority table and budgets in the kernel, `ScheduledTrigger`, boundary spawns, fault scheduling, the writer path with citation checks for card dressing, port/job generation at *approaching*, arc summaries, `NullNarrator` fallback, a call-log eval harness in `apps/cli`.
- *Why here, not after M7 as the sim doc implies:* the **narrative hypothesis** is half of what the prototype must answer (GDD §25). After M3 there is enough material (jobs, passengers, faults, repairs, imperfect knowledge) to test whether decisions feel contextual. The integration contract also gets exercised while sim modules are still cheap to change. The trade-off is that the narrator's most dramatic levers (fire, breach, injury) arrive later. I accept that; v0 tests *continuity and context*, not spectacle.
- *Narrator acceptance scenarios:*
  - **N1:** a hidden fault is never mentioned in card text until discovered (leak test on a fixture with a hidden truth).
  - **N2:** a stale proposal (target actor died, or the ship left port) is rejected cleanly and the next call sees the rejection.
  - **N3:** with the LLM unavailable or over budget, the game remains fully playable on `NullNarrator`.
  - **N4:** a generated job, NPC or cargo passes validation levels 1–3 and appears via a boundary spawn only.
  - **N5:** a scheduled fault fires inside its window at a kernel-sampled tick, and the replay is identical.
  - **N6:** attempts to issue forbidden command kinds are rejected by the kernel, regardless of prompt.

**M5: Environmental consequences**
- Sim doc M4: gas, heat, smoke, fire, breaches, patches, cooling loops, derating.
- *Unlocks:* **H, I, J**.

**M6: Bodies and damage control**
- Sim doc M5: body tree, wounds, capacities, exposure, incapacitation and death, first aid, extraction, treatment, triage.
- Succession as an external authority change, surfaced as a narrator or policy decision.
- *Unlocks:* **D, E, M, N, P, Q**.
- Scenario **M** belongs here, not in M5: venting outcomes need exposure and bodies.

**M7: Life between incidents, narrator v1**
- Sim doc M6: procedural traits, relationships, mood, coarse memories, maintenance variety.
- Narrator: `adjustSoftState` with citations, `socialBeat`, social interpretation, conversation annotations, canon reuse and retrieval, hooks, pacing and decompression.
- *Unlocks:* full **A** (with social life and maintenance), **R** (endurance with incidents plus headless decisions).

**M8: Vertical slice and hypothesis assessment**
- Sim doc M7: all fixtures, seed sweeps, save/replay forensics from production data, 20-crew benchmark on a mid-range phone, zero-player mode, a written assessment of both GDD hypotheses, and the list of deviations.

---

## G. What is wrong or under-specified in the docs

1. **No mapping between sim time and fictional time.** A meal takes 10–20 s, a voyage ~60 s, needs are tuned "across 10–30-minute sessions", and wounds heal "over multiple voyages". Yet the GDD speaks of "another six hours" (§2.2) and "a three-day struggle" (§20). The narrator, shifts, card text and the chronicle all need a calendar. **Decide a fixed ratio before M2**, e.g. 1 sim-second = 1 fictional minute, so a day lasts 24 real minutes at 1×. Then check shift and fatigue tuning against it. Walking will be absurdly slow in fictional terms; RimWorld has the same compression and nobody cares, but it must be deliberate.
2. **The determinism requirement is too weak for the chosen architecture.** "Same supported runtime" (§5.4) conflicts with Safari clients, a Node server and the owner's plan to move the sim server-side. Upgrade it to cross-engine now (C.9, C.10).
3. **Runtime creation of hard state is missing from the kernel API.** Sim doc §19.2 allows spawning only at scenario setup and fault injection at runtime, while GDD §16 requires runtime outposts, NPCs, cargo and plot objects. Add the boundary-spawn command (D.3).
4. **The player inspector versus hidden truth is unresolved, and it affects rendering on day 1.** The GDD lets the player inspect "substantial state"; the sim doc gives debug a truth view. A truth-rendering dot map shows the murdered prisoner's dot stop moving and a hidden fault's machine turn red, which defeats mysteries and the imperfect-information pillar the narrator is told to protect. **The owner must decide:** is the player's map truth (dramatic irony) or the captain's knowledge (mystery)? Build the renderer against a projection interface with both layers from M1. The same question decides whether arc epilogues may reveal secrets.
5. **Decisions while the captain sleeps.** GDD §3 says the first officer handles "routine command decisions" while the captain sleeps, but player decisions are the captain's. Does the player make a sleeping captain's decisions (perspective jumps to the FO), or is the captain woken, which takes physical time and is itself a story? Unspecified. Recommendation: significant decisions wake the captain, as an in-sim action that takes time; the FO handles `PolicyDecisionNeeded` items that the config classes as routine.
6. **Concurrent decisions and "cannot defer".** Two crises at once (fire plus a distress call) need a queue, an ordering rule and revalidation. The docs never say. D.6 proposes FIFO by urgency class with revalidation on presentation.
7. **Getting from N alternatives to a binary choice.** `PolicyDecisionNeeded` carries "executable alternatives" (plural), while GDD cards are strictly binary. Someone must reduce the alternatives to a binary tree. It must be a deterministic function in the kernel's decision system, not the narrator, or sim crises will depend on an LLM.
8. **There are no conditional scheduling primitives** for committed beats ("ambushed after leaving port", "when next alone"). Add `ScheduledTrigger` with a closed predicate set (C.8).
9. **No command for soft-state writes**, although GDD §17 grants the narrator that authority. Add a bounded, event-citing command (D.3).
10. **"Ambush" has no mechanics in the first build.** Combat is excluded, so the narrator's injection vocabulary for the prototype is: faults, boundary arrivals (passengers, NPCs, cargo contents), comms messages, route events (a distress beacon leading to a detour decision), social beats, and hazard suppression. Say so explicitly, or the narrator will promise things the sim cannot deliver.
11. **Off-ship NPCs have no hard-state home.** GDD §10 calls them "structured state"; the sim doc models external stores for items but not people. Add a minimal `OffstagePerson` record in sim (alive, location, possessions, relationships to crew) so their deaths and possessions are canonical. Personality and motive live in Neon.
12. **The narrator can mint money through job offers.** Payments are generated. Enforce config price bands in the kernel's contract validation (D.3).
13. **Narrator latency versus the real-time sim** is absent from both docs. Mitigation in A.4 and D.4.
14. **No retention rule for knowledge and history.** Per-actor `KnownFact`s sampled every 10 ticks, with `supersedesFactId` and no garbage collection, will bloat snapshots and slow planning. Recommendation: knowledge is a **latest-belief table keyed by `(subject, factType)`** with provenance. History is kept only for significant facts (casualties, diagnoses, orders), with a bounded per-actor cap. Completed tasks and old reports are compacted after N sim-minutes.
15. **Claim knowledge partitioned by comms domain (§14.5)** is a complexity trap if built in M2. Stage it: global claims when comms are up in M2; partitioned knowledge in M3 when comms can fail.
16. **Congestion (§7.4)** can absorb weeks. Allow friendly overlap with a speed penalty and exclusive work positions only, until a playtest shows it matters.
17. **Batch impacts "against a shared starting snapshot" (§5.2, phase 1)** requires double-buffering for specific fields. Name which ones (body damage, structural integrity) now so systems do not each invent their own approach.
18. **Mobile performance is unmeasured.** "A few ms on the reference dev machine" says nothing about a mid-range Android phone running a worker plus a canvas. Add a mobile benchmark to M2. Define the speed levels (1×/2×/4×/8×) and what happens when the budget is exceeded (effective speed drops, per §5.1).
19. **Save compatibility policy is missing.** "Fail clearly on unsupported versions" (§20.1) plus prototype-speed iteration means lost games and lost canon. Adopt the `schemaVersion`/`simVersion` split, migrations from M2, and replay via immutable deployment URLs (risk 1).
20. **The narrator's prompt and model behavior needs versioning like simVersion.** Log `prompt_version` and the model on every call and keep the call log as an eval corpus. Otherwise narrator regressions cannot be told apart from sim regressions.
