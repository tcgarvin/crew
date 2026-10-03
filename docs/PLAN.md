# Crew — Implementation Plan

Status: v2, 2026-09-30, after owner review of v1.
Sources: `docs/design/game-design-document.md` (GDD), `docs/design/simulation-design.md` (SD),
`docs/review/2026-09-30-architecture-review-opus.md` (design-partner critique of v1; parts of it
are superseded by the owner decisions in `docs/DECISIONS.md`).

## 1. Goal of the V1 sprint

One thin vertical slice, deployed, that lets us judge both GDD §25 hypotheses at 1× on a phone:

- a small freighter deck with 6–8 autonomous crew moving, working, eating, sleeping;
- a few ship systems that can degrade, fail and be repaired;
- three ports and a freight loop (job → load → travel → dock → deliver → pay);
- a narrator hook that pauses the sim, visibly generates something, and injects it;
- a full-screen binary decision modal whose outcome the crew carries out.

Every system is built to the depth needed to be *interesting to watch*, no deeper. Depth comes
after the slice, driven by what playtesting shows is boring or broken.

## 2. Decisions (see `docs/DECISIONS.md` for rationale)

| Topic | Decision |
|---|---|
| Language | TypeScript end-to-end. Kernel is a pure package with no runtime deps. |
| Hosting | Vercel (Vite SPA + Node functions) + Neon Postgres. No Next.js. |
| Sim authority | Client, in a Web Worker at 1×. The save is the state blob. Kernel is host-agnostic; a Node host exists for headless tests and could take authority later. |
| Determinism | **Not a goal.** No replay, no hashes, no cross-engine work. Keep only: seeded PRNG in state, no `Math.random`/`Date` in the kernel, JSON-safe state. |
| Narrator | Hook-driven and synchronous: sim pauses, UI shows a loading state, server calls the LLM, commands apply at the pause tick. Latency is not solved, just shown. |
| Narrator authority | Mechanical allow-list of command kinds (boundary spawns, machine faults, messages, jobs, decisions, soft-state nudges). No direct writes to bodies, positions, knowledge, money. |
| Map | Player sees **truth**. One render layer. Per-person view is a later feature. |
| Captain asleep/incapacitated | Perspective jumps to the first officer. |
| Save-scumming | None. One linear timeline per game. |
| Time | A gameplay knob, not a ratio. Docking ~seconds, short hop ≤30 s, long hop longer with events. Needs tuned for a 10–30 min session. |
| Content | Data from day one (Zod → JSON). Hand-authored first; LLM-generated later through the same validator. Images/ships/crews generation is post-V1. |

## 3. Architecture

```
 Browser                                Vercel Functions (Node)           Neon
 ┌────────────────────────────┐         ┌───────────────────────────┐    ┌──────────────────┐
 │ Worker: kernel, 20Hz step  │ save    │ auth (anon token)         │    │ users, games     │
 │  seeded rng, JSON state    │ ──────▶ │ games/saves API           │───▶│ saves (blob)     │
 ├────────────────────────────┤         │ narrator: snapshot →      │    │ narrative state  │
 │ Main: React UI, canvas     │ hook    │   digest → LLM → validate │    │ narrator_calls   │
 │  renderer, decision modal, │ ──────▶ │   → commands + card       │    │                  │
 │  host (speed/pause/hooks)  │ ◀────── │ content validation        │    │                  │
 └────────────────────────────┘ cmds    └───────────────────────────┘    └──────────────────┘
```

- **Saves**: gzipped state blob, IndexedDB locally on a short cadence, Neon every ~60 s and at
  every hook/decision/dock. `schema_version` + a migration function per bump so saves survive
  deploys. Before the slice is playable, wipe freely.
- **Hooks**: kernel emits `NarratorHook{kind, context}` at authored moments (approaching port,
  job board, quiet-too-long timer, notable event, `PolicyDecisionNeeded`). Host pauses, uploads
  the snapshot, awaits the response, applies commands, resumes. `NullNarrator` returns a
  deterministic job + template card so the game runs offline and in tests.
- **Narrator digest** is projected server-side from the uploaded snapshot by a pure function in
  `packages/narrator` (truth section + recent events + Neon narrative state). Prompt-cached
  static prefix. The plan schema rides in the prompt and the reply is validated (D53; was strict structured output, D45).
- **Decision** is sim state: `{origin, perspectiveActorId, left, right, nextDecisionId?}`; host
  pauses while one is pending; `ResolveDecision` applies the chosen side's commands.

## 4. Repository layout

```
crew/
  packages/
    sim/        kernel. zero deps. tsconfig lib ES2022, types: [] (no DOM/Node globals)
      core/     world, clock, ids, rng, events, pipeline, serialize/restore/migrate
      systems/  spatial, power, equipment, needs, work, travel, decisions, (later: atmosphere, bodies, social)
      planner/  task selection — imports view/** and core/types only (SD §4.3 boundary)
      view/     AgentView builder, render projection, narrator digest inputs
    content/    Zod schemas, authored JSON (deck, machines, items, crew, ports), validator, config
    narrator/   digest projection, prompts, output schemas, intent→command translation, authority table
    server/     Hono app, Drizzle + SQL migrations, auth, saves, narrator orchestration
  apps/
    web/        Vite + React. src/worker (host), src/render (canvas), src/ui. api/ mounts server app.
    cli/        headless runner, content validation, offline generation scripts
  docs/         design/ review/ DECISIONS.md PLAN.md playtests/
```

Rules enforced by dependency-cruiser: `sim` imports nothing; `content → sim` types only;
`web` never imports `narrator`/`server`; `planner` cannot see `state/**` or `systems/**`.

Toolchain: pnpm workspaces, `tsc -b`, strict TS (`strict`, `noUncheckedIndexedAccess`),
Vitest, Biome, Playwright for one e2e smoke only.

## 5. Kernel rules kept from v1

- State is POJOs in kind tables; no classes/Map/Set/undefined/NaN in state; caches rebuildable.
- Validate-then-apply mutation; no rollback machinery.
- IDs: namespaced slug definition IDs; prefixed-string instance IDs from a saved counter; never reused.
- Static declarative pipeline in SD §5.2 order; planner phase receives `AgentView`, not truth.
- Events are outputs of `advance()` with `significance` and `causeIds`; not read within a tick.
- `sfc32` seeded streams in state.
- `Decision` and `NarratorHook` are first-class state/event kinds.
- All tunables in `packages/content/config`, none hardcoded in `sim`.

## 6. V1 workstreams (subagent-owned)

**W0 — contracts (serial gate, types only, one agent).** Pins, in `packages/sim/src/core/types.ts`
and `packages/content/src/schemas/*`, before any parallel work: WorldState kind tables (one owned
slice per system, `schemaVersion`); Command and Event unions (one file per system, merged; common
`source`/`significance`/`causeIds`); system + pipeline signature; content def schemas (Deck,
Machine, Item, Crew, Port, Config); **Problem/Task advertisement** (how a broken pump or a crate
posts work the planner claims — the most cross-cutting contract); AgentView shape; render
projection (positions **+ per-actor action verb label** + machine states); worker↔main protocol
(in: load/setSpeed/pause/command/requestSave; out: frame/events/hookRaised/decisionPending/
saveBlob); NarratorHook, Decision, and the narrator HTTP exchange
(`POST {gameId, hook, snapshot} → {commands, card?}`); save envelope `{schemaVersion, state}`.

| # | Workstream | Scope for the slice | Starts after |
|---|---|---|---|
| W1 | Scaffold + CI | monorepo, tsconfigs, Vitest, Biome, depcruise rules, GitHub Actions, Vercel project, Neon | — |
| W2 | Kernel core | ids, rng, clock, pipeline, commands/events, serialize/restore/migrate, invariants, **quiet-too-long timer** | W0 |
| W3 | Deck + movement | tile geometry, compartments, doors, A* w/ fractional positions, interaction positions, overlap + speed penalty | W2 |
| W7 | Web | worker host, canvas dots + interpolation **+ action labels + notable-event ticker**, speed/pause, inspector, decision modal, narrator loading state, mobile layout | W0 (mock frames) → W3 for real |
| W4a | Needs + simple selector | hunger/fatigue/rest, eat/sleep actions, a simple priority selector behind the AgentView boundary | W3 |
| W5 | Ship systems | one power domain (generator, battery, consumers); small machine catalog; 3–4 faults; inspect/diagnose/repair recipes; engine heat → derate | W3, contract 5 |
| W6 | Travel + commerce | travel state machine, three ports, cargo ramp, hauling tasks, contracts, pay once, deterministic job source, NullNarrator, hook points | W3, contract 5 |
| W10 | Content | authored deck, machines, items, 8 crew w/ procedural traits, 3 ports, config; validator L1–3 | W0 contract 4 |
| W8 | Server + Neon | anon auth, games/saves, narrator endpoint, `narrator_calls` log, one `narrative_notes jsonb` per game | W0 |
| W9 | Narrator | digest projection, allow-list, prompts + structured output; **V1 commands: `offerJob`, `spawnAtBoundary`, `scheduleFault`, `surfaceDecision`**; card prose; running summary rewritten each call | fixtures early; W6+W8 for e2e |
| W4b | Full work model | claims, shifts, SD §15.3 five-class selector, ambient chat | first playtest |

Integration checkpoints, each a deployed build + playtest note: (1) W0–W3+W7: dots walking
through doors on a phone; (2) +W4a/W5/W6/W10: freight loop with things breaking; (3) +W8/W9:
narrator hook and decision modal end-to-end.

Cut from the v1 narrator design for this slice: captain-knowledge digest, showrunner/writer split,
citations, cadence table, `scheduleTrigger`, `socialBeat`, `adjustSoftState`, `suppressHazards`,
`dramaBudget`, `sendMessage`, arcs/hooks/canon tables. Kept: NullNarrator, allow-list, boundary-
only spawns, kernel-sampled fault tick, price bands, precondition revalidation, Decision as state.

## 7. Deferred (explicitly)

Atmosphere/fire/breach, bodies/wounds/medical, relationships/memories beyond ambient chat,
combat, per-actor knowledge rendering, replay/determinism, LLM-generated ships/images, off-ship maps.
