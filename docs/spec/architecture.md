# Architecture

The kernel and the hosts that run it, run-ahead and playback, saves and migrations, content
loading and validation, the API, and the dev instruments. Layout and the dependency rules are in
`README.md`; deployment, environment variables, the narrator log and the live tests are in
`docs/DEPLOYMENT.md`. This file does not repeat them.

## Kernel and hosts

### Kernel and its hosts

The simulation is a host-agnostic kernel (`packages/sim`, `core/kernel.ts`): `createWorld`,
`advance`, `enqueueCommand`, `serialize`, `restore` and the read-only views, over a `World` whose
`state` is plain JSON. The kernel has no dependencies and no DOM or Node globals. It runs in the
browser in a Web Worker (`apps/web/src/worker/`, the player's host); a Node host runs it headless
for tests and the CLI. The save is the serialized state blob. D3.

Why: the owner wanted everything in the front end, with the option to move work between front and
back end later.

### Randomness and determinism

Determinism is not a goal. Randomness is seeded `sfc32` streams stored in `state.rng`, so a stream
survives a save; `Math.random` and `Date` are banned in the kernel; state is JSON-safe. These
exist for stable tests and reproducible bug reports, not for replay: there is no replay from
inputs, no state hash and no cross-engine guarantee. D4.

Why: the owner, "the determinism is not important... we're going to spend a lot of time
debugging the implementation of sin."

### Worker protocol

The worker's messages are typed in `packages/sim/src/core/types/protocol.ts`. `load` carries a
save envelope or a scenario and seed (never the content, which the worker imports itself).
`frame`, `dirt`, `events`, `hookRaised`, `decisionPending`, `shipLost` and `commandResult` flow
out; `command`, `viewProgress`, `setSpeed`, `pause`, `resume`, `requestSave`, `requestSnapshotAt`
and `requestAgentView` flow in. The host depends only on the `Kernel` interface; `sim.worker.ts`
is the one file that wires in a concrete kernel.

Player input happens only where the sim is halted: at a hook or a decision. Any future direct
input must itself be a hook. D14.

## Run-ahead and playback

### Run-ahead loop

The worker simulates ahead of the viewer, up to `runAheadCapSeconds` (60 sim-seconds), and stops
at the next hook or pending decision; the main thread plays the buffered frames at human speed.
A narrator call starts when the worker reaches its hook, so its latency overlaps the viewer's
catch-up. Why: the sim runs exactly once, so a delayed stream cannot diverge from the sim. D14.

The loop (`worker/host.ts`) runs every `loopIntervalMs` (50). While run-ahead budget remains it
runs at least `burstTicksPerLoop` (40) ticks per iteration, however slow the wall clock is, and
emits a frame every `frameEveryTicks` (2) ticks so playback has points to follow walking paths.
The lead is rebuilt after every hook. Why: advancing at wall-clock rate left the lead near zero,
so every hook stalled the viewer for the whole narrator round trip ("waiting for the narrator...
feels like we're waiting the entire cycle"). These are `HostDeps` defaults, not config.

The grime tint's dirt grid is posted on load and every `host.dirtFrameEverySeconds` (5) sim
seconds.

### Worker halts

`advance` returns at the tick that raises a hook or leaves a decision pending, and returns at once
while one is pending. The host posts `hookRaised` or `decisionPending` and spends no time while
halted; a queued `acknowledgeHook` or `resolveDecision` lifts the halt on the next probe. A lost
ship (`shipLost`) halts for good.

### Frame playback

`apps/web/src/host/playback.ts` consumes the buffered `RenderFrame`s and interpolates actor
positions and facing between consecutive frames. Everything else (machines, doors, the dock, the
hull and field, money, headline) snaps to the later frame: truth, not a smoothed guess (D7). Travel
progress interpolates within one stage of one leg. Impacts and shots are events, so both frames' are
kept, and a dropped frame's ride on to the frame shown, so no flash or tracer is skipped. The main
thread reports its position with `viewProgress`; that position, not wall time, sets the run-ahead
budget.

### Snapshot ring and the inspector

The worker keeps a ring of serialized snapshots of the past, one about every
`snapshotIntervalSeconds` (2), kept three run-ahead caps long, and always one at a halt tick. The
inspector and `requestSnapshotAt` read the ring, never the ahead-state, so the future does not leak.
An agent view restores the nearest snapshot and advances that copy to the tapped tick. Why: the
inspector must show what the viewer has seen. D14.

### Reload of a save

On load the viewer starts at the loaded tick: a reloaded game shows its saved ahead-state, not the
viewer's earlier position, and has its full run-ahead budget at once. Saves are taken from the
ahead-state at committed tick boundaries.

## Hook answers on the main thread

### Narrator call from the main thread

The worker never calls the narrator: on `hookRaised` the main thread
(`apps/web/src/host/narrator.ts`) makes the call and acknowledges the hook
(§browser-to-model-and-back), retrying on failure (§story-retry-schedule).

## Saves and migrations

### Save envelope

`serialize` produces a `SaveEnvelope`: `schemaVersion`, `simVersion` (informational, for bug
reports), `contentHash`, `configHash`, `savedAtTick`, the full effective `config` and `state`.
Content is referenced by hash only, plus whatever the state carries as dynamic defs. The host gzips
and stores it: IndexedDB locally (one slot, about every 15 sim-seconds and at every decision) and
the server about every 60 wall seconds and at milestones (`host/saves.ts`). An unreachable server
means local saves only.

### Server saves and leases

`PUT/GET /api/games/:id/save` (`packages/server/src/routes/saves.ts`) stores gzip(JSON(envelope)),
base64 on the wire, capped at `CREW_SAVE_MAX_BYTES` gzipped. The server checks the envelope's
shape and that its schema version, tick and content hash match the request; it never interprets
`state` or `config`. `POST /api/games/:id/open` bumps the game's lease epoch; a write with an older
epoch is refused `409 staleLease` and that tab stops writing for good, so two tabs cannot save
over each other.

### Restore of a save

`restore(envelope, content, registry)` (`core/save.ts`) fills missing config, migrates the state,
checks the invariants and rebuilds the caches. It throws `SaveCompatibilityError` for a malformed
envelope, a schema the build cannot reach, a refused migration or a state that fails the
invariants. A content hash mismatch does not throw: the save restores against the loaded content
and `RestoredWorld.warnings` says so. Why: tuning content must not wipe saves.

The worker host catches any restore failure, starts a new game on the first scenario and posts an
`error` saying why. Saves predate players: where a migration would be large and risky, the save is
refused rather than migrated.

### Save migrations

`state.schemaVersion` is `SCHEMA_VERSION`. Each schema bump ships a migration in
`core/migrations.ts`, keyed by the version it upgrades from; a bump that is not a pure addition
may instead refuse. `migrateState` applies them in order, and throws on a version newer than the
build, an invalid one, or a gap. A migration is pure over untrusted JSON and does not use the
live code it migrates around (the watch bill is read inline, for instance), so it stays as
shipped.

A migration receives a `MigrationContext`: the content being restored against (the port's dock
map, the hand truck item, the scenario's watch bill, the deck's hull), the config the restored
world will run with, and `warn`. A migration that gives an old save something it never had (stores
spawned into their zones, patch kits stowed in lockers) says so through `warn`, which `restore`
collects into `warnings`. A caller with nobody to tell omits `warn`.

Saves of schema 6 or older are refused: the deck was mirrored and the dock maps reshaped, and
the host starts a new game. Schema 7 onward migrate.

Schema 13 (expeditions) gives every actor a whole body (§bodies-and-capacities) and
`skills.fighting` from their crew def (0 without one), starts the `wound` id counter, instantiates
a deck's arms locker into a save that lacks the placement, and stows the scenario's weapons in it
(§arms-locker), with a warning. `combatant` and `expedition` are optional and absent.

### Config filling

A save keeps the config it was made with, but a key the loaded content has and the save lacks is
filled from the loaded content (`fillConfig`, recursing into objects), and `restore` warns with the
paths filled. Values the save has always win. A renamed key is a missing key, so the new name takes
the loaded value and the stale one is carried along unread. Why: an unfilled key reads as
`undefined` and turns timers into NaN. The narrator's snapshot upgrade and the narrator-log
rebuild use the same fill and the same migrations, so the digest only ever sees the current shape.

## Content

### Content as data

Content is Zod schemas over JSON in `packages/content`; hand-authored and LLM-generated content
share one validator. Generated content lives in the `gen.` id namespace. Generated ships, crews
and images are not yet used. D13.

### Content loading

`loadBundle()` (`packages/content/src/loader.ts`) imports every def under `data/`, strips the
editor-only `$schema` key, keys defs by `id` (thoughts by their `key`) and validates. The bundle's
`hash` is FNV-1a over canonical JSON (keys sorted), a cache-busting fingerprint rather than a
determinism tool. `packages/content` may import `@crew/sim` for types only.

### Content validation

`validateBundle` (`schemas/validate.ts` and the `validate-*.ts` files beside it) has four levels:

- **L1 structural**: Zod shape, types, enums and bounds.
- **L2 referential**: every def id resolves; record keys equal ids; id namespaces match their
  table; local keys are unique; routes are symmetric; price bands and config numbers are sane.
- **L3 semantic and physical**: tile maps match their legend and size; doors, ramps, footprints,
  interaction tiles, zones and spawns are on floor; the deck is connected; the hull contract,
  dock maps, watch bill, berths and activity venues hold (`validate-hull.ts`, `validate-dock.ts`,
  `validate-venues.ts`); every recipe tool kind is provided by some item def, and each scenario
  starts with one of every kind its deck's recipes name (§scenario-tools).
- **L4 simulation smoke** lives in `apps/cli`, not in the package.

## Dev instruments

### Content commands

`crew content validate` loads and validates the bundle, grafts every dock onto every deck with the
sim's own nav builder (`dockGraftIssues`, §dock-map-validation), and prints counts and the hash;
activity venues a deck no scenario sails lack are notes, not failures. `crew content schemas` writes
JSON Schemas; `render-deck <id>` and `render-dock <id>` draw maps as text (`apps/cli/src/index.ts`).

### The pacing instrument

`crew pacing` (`apps/cli/src/pacing.ts`) runs a scripted there-and-back voyage on the real content
with a stub narrator of configurable latency and a model of the host's run-ahead and the viewer
at each playback speed. It reports narrator calls per hook kind, sim time, wall time and stall per
speed (`--speeds`, `--latency`, `--scenario`, `--seed`, `--json`). Stall per call is the latency
less the lead in hand, so the narrator is the clock at high speeds. It replicates the host rather
than importing it; change the host's pacing and this file together. Use it when hook policy,
quiet-timer rules or run-ahead change.

### The beats instrument

`crew beats` (`apps/cli/src/beats.ts`, `beats-field.ts`) runs the pacing voyage round trip after
round trip for N ship's days with an instant narrator and every card answered by its left side,
and counts per watch: bells, handovers, meals served, eaten hot and as rations, missed and spoiled,
rooms filthy and mopped, faults, hazards, cards and conversations; the mess fill; per person, the
share of time by activity class and the longest idle stretch; provisions at the end; helm
coverage; port-call stalls; sleep starts; the off-watch family (sessions, contests, arguments,
boredom, affinity extremes, rivalries); machine wear; and, with `--fields` and `--seeds`, the
asteroid fields crossed, hull lost per severity and ships lost. Numbers are sim time, independent of
playback speed. It is the instrument tuning commits answer to: add a count here when a system
gains something to tune.

### The expeditions instrument

`crew expeditions [--site] [--plans <ids|all>] [--casts <default,shaky,hard|all>] [--n] [--seeds]
[--json]` (`apps/cli/src/expeditions.ts`) is the fight's tuning instrument (§the-fight). For each
plan, cast and seed it starts the default game, sets down at the site (`port.boathouse` by
default) with the plan at tick 0 and runs to `expeditionResolved` (cut off at 360 s), never
calling the narrator. Defaults: `--n` 20, seeds 1–5. `all` plans are the default pair, every
other posture lethal-armed and `assault-stun-armed`; the casts are the map's default, `shaky`
(every guard shaky and paid) and `hard` (every guard hard and devoted, armed with blasters up to
the cap). Per plan and cast it reports the outcome mix, seconds from contact to the end and from
the muster to contact, wounds per side by severity, people down and dead, how the fight ended, the
cast's fled and surrendered shares, shots and hit rate per side, party wavers and breaks, and log
lines per fight.

Its deep test (`expeditions.deep.test.ts`, run by `pnpm test` but not CI) runs
`hold-lethal-armed` and `assault-lethal-armed` against the default cast, four fights on each of
seeds 1 and 2, and asserts bounds, not values: party
deaths at most 0.25 a fight for each, no timeouts, `assault` taking the target in at least 60%,
`hold` ending `targetFled` or `targetTaken` in at least 80%, `hold`'s party wounds at most 0.75 of
`assault`'s, and `assault`'s fight at most 0.8 of `hold`'s long. At the Lazaret (§the-lazaret) it
runs `hold`, `assault` and `creep` the same way and asserts party deaths at most 0.25 a fight for
each, `hold` ending `targetFled` in at least 60%, `assault` and `creep` never timed out, `assault`
taking the target in at least 60% and `creep` in at least 80% at fewer party wounds than
`assault`. Seeded, so the same code and seed
give the same fight; not a determinism claim (D4).

### Narrator log and live tests

`pnpm --filter @crew/server narrator-log` reads recorded narrator calls and rebuilds the digest a
call saw; `pnpm test:live` is §live-narrator-tests. Both are in `docs/DEPLOYMENT.md`.

## The API and its build

### API build

The API is a Hono app (`packages/server/src/index.ts`; routes in `routes/`) that is stateless:
each request loads from the `Db` and writes back before responding. It ships as one function
bundled by `scripts/vercel-output.mjs` into Vercel's Build Output API, not as a zero-config `api/`
file, because the workspace packages are TypeScript source that only a bundler can resolve. See
`docs/DEPLOYMENT.md`, "The Vercel function". D23.
