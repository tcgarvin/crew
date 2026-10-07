# Contracts (W0)

The shared types and schemas every workstream builds against. Written in the W0 pass
(2026-09-30) before parallel work starts. If you need to change one, read "Changing a contract"
at the bottom first.

Sources: `docs/DECISIONS.md` (wins on conflict), `docs/PLAN.md` §3–§6,
`docs/design/simulation-design.md` (SD), `docs/review/2026-09-30-architecture-review-opus.md`.

## Index

All sim contracts live under `packages/sim/src/core/types/` and are re-exported from
`@crew/sim`. `planner/**` may import only `core/types*` and `view/**` (dependency-cruiser).

| Contract | File | Owner (writes it) | Consumers |
|---|---|---|---|
| Branded IDs, `ID_PREFIX`, `nextId` counters, `CommandId`, `TempRef` | `core/types/ids.ts` | W2 allocator | everyone |
| Tick, `TileCoord`, `PhysicalLocation`, `LocationRef`, RNG stream names, `TextRef`, `DeepReadonly` | `core/types/common.ts` | — | everyone |
| Content defs: `DeckDef`, `MachineDef`, `ItemDef`, `CrewDef`, `TraitDef`, `PortDef`, `ScenarioDef`, `ConfigDef`, `ContentBundle`, closed vocabularies (`SKILLS`, `MACHINE_TAGS`, …) | `core/types/content.ts` | W10 authors data | W2–W6, W9, W10 |
| `WorldState`, `SCHEMA_VERSION`, `WorkState`, `DynamicDefs` | `core/types/state.ts` | W2 | everyone |
| `Actor`, `Needs`, `MovementState`, `KnownFact`, `KnowledgeTable` | `core/types/actor.ts` | W3 (location/movement), W4a (needs), W4 (activity), perception (knowledge) | W3, W4, W7, W9 |
| `Machine`, `MachineFault`, `Door`, `Compartment`, `DeckState`, `Item`, `PowerState` | `core/types/ship.ts` | W3 (deck, doors), W5 (machines, power), transfers (items) | W3–W7, W9 |
| `TravelState`, `Job`, `MoneyState` | `core/types/travel.ts` | W6 | W7, W9 |
| **Work contract**: `Problem`, `Task`, `Claim`, `Action`, `Activity`, `Intent`, `UrgencyClass`, `TaskDerivationTable` | `core/types/work.ts` | problems: owning system (W5, W6); tasks/claims/activity: W4 | W4, W5, W6, W7 |
| `Decision`, `NarratorHook`, `NarratorState` | `core/types/decisions.ts` | W6 (hook points, decisions) + W2 (quiet timer) | W7, W8, W9 |
| `Command` union, `CommandSource`, `EnqueueResult`, `CommandRejection`, `CommandsState` | `core/types/commands/index.ts` (+ one file per system) | W2 applies; each system validates its own kinds | W6, W7, W9 |
| `AUTHORITY`, `NARRATOR_COMMAND_KINDS`, `NarratorCommand` | `core/types/commands/authority.ts` | W2 enforces | W9 |
| `SimEvent` union, `EventDraft`, `EVENT_SIGNIFICANCE` | `core/types/events/index.ts` (+ one file per system) | each system emits; W2 finalises | W7, W8, W9 |
| `PHASES`, `System`, `StepCtx`, `RngApi`, `DerivedCaches`, `Planner`, `PipelineEntry` | `core/types/pipeline.ts` | W2 | every system author |
| `AgentView`, `AgentViewSnapshot`, `RenderFrame` | `core/types/view.ts` | W4a (AgentView builder), W7/W3 (render projection) | planner, W7 |
| `ToWorker` / `FromWorker` (run-ahead protocol) | `core/types/protocol.ts` | W7 | W7 |
| `SaveEnvelope`, `Migration`, `SIM_VERSION` | `core/types/save.ts` | W2 | W7, W8, W9 |
| `Kernel`, `World`, `EffectiveConfig`, `AdvanceResult` | `core/types/kernel.ts` | W2 | W7, `apps/cli`, tests |
| Example `WorldState` fixture | `core/fixtures/example-world.ts` | — | tests |
| Zod schemas for every def + `contentJsonSchemas()` | `packages/content/src/schemas/*.ts` | W10 | W10, `apps/cli`, W9 |
| `validateBundle` (L1 done; L2/L3 stubs) | `packages/content/src/schemas/validate.ts` | W10 | CI, server |
| `NarratorRequest/Response`, `buildNarratorPlanSchema`, `TranslateIntents` | `packages/narrator/src/contract.ts` | W9 | W7, W8 |
| Routes, request/response bodies, table sketch | `packages/server/src/contract.ts` | W8 | W7 |

## Rules

These are the kernel rules from PLAN §5, made concrete.

1. **Kind tables.** State is `Record<Id, T>` per entity kind, one owned slice per system (see
   the owner notes on `WorldState`). A system writes only its own slice and the fields
   documented as its own on shared entities.
2. **POJOs only.** `WorldState` must survive `JSON.parse(JSON.stringify(state))` deep-equal. No
   `undefined` values (omit the key; `exactOptionalPropertyTypes` enforces this at the type
   level), no `NaN`/`±Infinity`/`-0`, no `Map`/`Set`/class instances/typed arrays/functions.
   Typed arrays are fine in `DerivedCaches`.
3. **Caches are rebuildable.** `World = { state, caches, content, config }`; only `state` is
   serialized. `restore()` rebuilds caches and sets every dirty flag.
4. **IDs.** Definition IDs are namespaced slugs (`machine.coolant_pump.mk1`, generated content
   under `gen.`). Instance IDs are prefixed strings from `state.nextId` and are **never reused**.
   Command IDs are caller-supplied and deduped.
5. **Custody has one source of truth.** An item's `location` is canonical; "what is X carrying" is
   a derived index, never a list on the actor.
6. **Events are outputs.** `advance()` returns them; no system reads an event emitted in the
   same tick. Cross-system communication goes through state (problems, queues, dirty flags).
   Every event carries `significance` and `causeIds`.
7. **Planner sees `AgentView` only.** No truth tables, no `StepCtx`, no RNG. Claims by others
   are known only through facts. A few things are common knowledge aboard and read as truth
   without facts: the roster (`roster()`), assigned beds (`assignedBeds()`, D74), and since slice 4
   the open and running group sessions (`sessions()`: the intercom, `social.sessions`), the
   travel stage (`travel()`) and the activity defs (`activities()`), and since slice 5 the
   alert (`alert()`: the klaxon, D94). Where a rock hit is not common knowledge: everyone holds a
   `hullImpact` fact about the field, with the compartment only for those who were in it, and
   damage is learned by sight or by an intercom report (`report` evidence, original
   `observedTick`).
8. **Validate, then apply.** A command is validated when enqueued and again when applied;
   validation is pure and produces a plan; applying cannot fail, so a rejection never leaves a
   partial mutation. `AUTHORITY[source]` is checked first.
9. **All tunables in `ConfigDef`.** No cost, rate, duration or threshold is hardcoded in `sim`.
   Content and config author seconds; state stores integer ticks (`ceil(seconds * tickRate)`).
10. **Randomness** only through `ctx.rng` over the named sfc32 streams in state. No
    `Math.random`, no `Date` in the kernel.
11. **Mutation model.** Systems mutate `WorldState` in place; entity types are mutable, value
    objects are `readonly` and replaced whole. Everyone else reads `ReadonlyWorldState`.

## How work is advertised

The one way a system asks the crew to do something (details in `core/types/work.ts`):

1. The owning system creates or revises a `Problem` in `state.work.problems`, deduped by
   `dedupeKey`. Equipment owns `machineSymptom`, `machineFault`, `maintenanceDue`,
   `partsNeeded`; travel owns `courseToPlot` (D78) and, with commerce, `cargoToLoad` and
   `cargoToUnload`; commerce owns `reserveLow` (D80: the ship's stores, bought like a part; D81:
   provisions are one of them, counted in days of meals); the watch owns `stationToStaff` (D77:
   the helm's `watch` and `relief` posts); the galley owns `mealToCook` and `mealToCarry` (D81);
   dirt owns `compartmentDirty` (D82); damage owns `machineDamaged`, `hullScar`, `hullDamaged`
   and `compartmentToCheck` (D93, D94; `hullDamaged` derives commerce's `buyParts` through
   `buySpec`).
2. The work system derives `Task`s through the `TaskDerivationTable`, one rule per problem kind.
   Each owning system exports its rules from `systems/<system>/tasks.ts`; `systems/work/`
   merges them.
3. The planner sees tasks whose problem the actor knows (`public` problems, or `discovered`
   ones with a `problem` fact) and returns an `Intent`; work turns it into a `Claim` and an
   `Action`.
4. Progress lives on the target (the fault's repair step, the item's location). The owning
   system marks the problem `resolved`; work completes tasks and releases claims.

Personal needs are not problems: the planner synthesises eat/sleep/rest/socialize candidates
from `self.needs` and known amenities.

## Adding a Command or Event variant without merge conflicts

Commands and events are split one file per system under `core/types/commands/` and
`core/types/events/`, each exporting a payload map interface (`TravelCommandPayloads`,
`TravelEventPayloads`) and, for events, a significance catalog.

- **New variant in an existing system:** add a key to *your* system's payload map (and its
  significance entry for events). Nothing else changes; the unions are mapped types over the
  merged interface, and `EVENT_SIGNIFICANCE` fails to compile if you forget the catalog entry.
  For a command, also add the kind to `AUTHORITY` for each source allowed to issue it; a kind no source lists is unreachable.
- **New system:** add `<system>.ts` with its payload map, then add one `extends` line to
  `CommandPayloadMap` / `EventPayloadMap` and one spread to `EVENT_SIGNIFICANCE` in the
  `index.ts`. That single line is the only shared edit.
- **Narrator vocabulary** (`NARRATOR_COMMAND_KINDS`) is not extended by a workstream on its own:
  it is an owner decision (D6, D11) and changes the narrator schema and tests together.

## Changing a contract

- Additive changes (a new optional field, a new variant in your own file) need no coordination
  beyond keeping `pnpm typecheck` green.
- Breaking changes to `WorldState` bump `SCHEMA_VERSION`. Before the slice is playable, wipe
  saves instead of writing a migration; after that, ship a `Migration`.
- Changing a closed vocabulary in `content.ts` (skills, tags, tool kinds) requires the matching
  enum in `packages/content/src/schemas/primitives.ts`; the `VOCABULARY_IN_SYNC` check fails to
  compile until both match.
- Shape decisions made in W0 are marked `// W0 decision:` in the source; the owner reviews
  them. Record any rule change in `docs/DECISIONS.md`.
