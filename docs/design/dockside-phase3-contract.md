# Dockside phase 3: the sim's contract

What the sim side of phase 3 gives the narrator/server agent and the renderer agent. Types live in
`packages/sim/src/core/types/dockside.ts` (all exported from `@crew/sim`); this file is the
short version. Design: `dockside.md` §5, §6.1; spec: §staging-plan-command.

## 1. The `stageDock` hook

```ts
// HookContexts (core/types/decisions.ts); approachingPort is gone.
stageDock: { portId: PortDefId; dockId: DockDefId; floorSet: FloorSetEntry[] };

interface FloorSetEntry {
  name: string;
  role: string;            // lower case
  postKey: LocalKey;       // DockDef.posts[].key on that dock
  reason:
    | { kind: "regular" }                           // castSeed entry with a post
    | { kind: "receiver"; jobId: JobId }            // dock hand for freight bound here
    | { kind: "passenger"; actorId: ActorId };      // left behind / put off here (§ending-a-passage-early), on the bench
  label?: string;
}
```

- Raised by travel in `transit` when `routeDistance - routeProgress <= narrator.approachHookLeadSeconds
  * travel.nominalSpeed` (10 s ahead at default speed), at every docking whose port has a dock map,
  waypoints included. Never at a port without one.
- Guaranteed: if another hook is pending it waits (`travel.staging = { status: "due" }`) and is
  raised the first tick none is, before any other hook. Transit does not end until it has been
  raised and acknowledged.
- `floorSet` is `floorSet(state, content, portId)` at the raise tick: pure (no rng draw), so it is
  who the sim will place unless state changes before docking. The digest can list it as "already
  on the dock".
- `hook.tick` is the raise tick; the snapshot's `travel` is the `transit` stage object with
  `staging: { status: "raised", hookId }`.

## 2. The answer: one `stageDock` command, then `acknowledgeHook`

Delivery is unchanged (`apps/web/src/host/narrator.ts` `hookAnswer`): the response's commands are
retargeted to `hookTick + 1` and followed by `acknowledgeHook` at the same tick, so the plan
applies before the ack. An empty `commands` array (just the ack) means "the floor set only".

```ts
// CommandPayloadMap["stageDock"] = StagingPlan; source "narrator"
interface StagingPlan {
  place: StagedPlacement[];   // ≤ 3
  props: StagedProp[];        // ≤ 3
  ambience?: string;          // one sentence for the log
}
interface StagedPlacement { who: StagedPersonSpec; postKey: LocalKey; label?: string }
type StagedPersonSpec =
  | { kind: "seed"; name: string }                              // port castSeed, by name
  | { kind: "cast"; name: string; role: string }                // in the narrator's notes cast
  | { kind: "newFace"; name: string; role: string; look: string };
interface StagedProp {
  itemDefId: ItemDefId;       // any item def; drawn like it, never an Item
  count: number;              // 1..4
  at: { kind: "staging" } | { kind: "post"; postKey: LocalKey };
}
```

Kernel validation (`systems/travel/staging.ts`), all-or-nothing (the translator should drop bad
parts first, with reasons):

| Rule | Rejection |
|---|---|
| a `stageDock` hook is pending and `travel.staging` is `raised` for it | `preconditionFailed` |
| no plan yet for this hook (one per call) | `duplicate` |
| `place` ≤ 3, `props` ≤ 3 | `outOfBounds` |
| every `postKey` (placements and `at.post`) is a post on `hook.context.dockId` | `invalidPayload` |
| names, roles, labels, looks, ambience: non-blank, no control characters, no `{`/`}`; at most 60 / 60 / 48 / 120 / 200 characters (`STAGING_LIMITS`) | `invalidPayload` |
| a `seed` name matches a `castSeed` entry of that port (case-insensitive) | `invalidPayload` |
| no name is placed twice; no name belongs to anyone aboard (crew, passengers) | `invalidPayload` |
| `itemDefId` is in the catalogue (content or dynamic); count is an integer 1..4 | `invalidPayload` |

The kernel does not check the numeric-consequence or secret-phrase rules (`translate.ts`
`textProblem`); the staging translator should. Stored text is trimmed and whitespace-collapsed;
roles are lower-cased.

## 3. Authority

`NARRATOR_COMMAND_KINDS` gains `"stageDock"`; `STAGING_COMMAND_KINDS = ["stageDock"]` and
`StoryCommandKind` (everything else) are exported. `validateCommand` (`core/commands.ts`
`hookWindowRejection`), for source `narrator` only:

- a staging kind while no `stageDock` hook is pending: `preconditionFailed`;
- any other narrator kind while a `stageDock` hook is pending: `preconditionFailed`.

So the staging call can only stage, and a story call can never stage. The story translator
(`isNarratorKind`) already treats `stageDock` as "not something you can do".

## 4. What lands when the dock attaches (start of `docking`)

`dressDock` (`core/locals.ts`): the floor set, then the plan's placements (a placement naming
someone already in the floor set moves them to the plan's post and label rather than adding a
second one), each at their post tile or the nearest free dock floor tile (never on the staging
area, the delivery bay, a ramp landing or another post's tile); then props, then the ambience.
Events: `dockDressed` (trace: `localIds`, `props`, `staged`, `unplaced` names), `dockAmbience`
(notable, ticker text = the line; never narrative, so it does not wake `notableEvent` or reset
the quiet timer). A new game's dock and a restored schema-4 save's dock are dressed with the
floor set alone (at creation / on the first tick).

## 5. State the digest reads ("On the dock")

```ts
state.dockside: {
  dockId?: DockDefId;                 // set while dressed; absent with no dock
  locals: Record<LocalId, Local>;     // ids "o<n>"
  props: { itemDefId; count; tile }[];// tile in the deck frame
  ambience?: string;                  // the plan's line for this docking
}
Local {
  id; name; role; lookSeed: number; look?: string;
  origin: FloorSetReason | { kind: "staged"; source: "seed" | "cast" | "newFace" } | { kind: "dockHand" };
  postKey; label?; location: { deckId; x; y }; facing;
  movement; behaviour: atPost | walkTo | leave;
  errand?: stageOffer | withdrawOffer | takeDelivery;   // dock hands only
  carrying: ItemDefId[];                               // crates on a trolley (presentation)
}
```

Locals are never in `state.actors`: the crew section, roster, Aboard line and "people ashore"
never include them. A new face (`origin.source === "newFace"`) is not cast; write them into the
cast only when the story does. `dockside` is empty in flight, so "On the dock" is a docked-only
section. Freight lines are unchanged except that an offer's crates may be on a dock hand's
trolley (`errand.kind === "stageOffer"`, no `cargoItemIds` yet) or on their way back in.

## 6. Render frame

```ts
RenderFrame.locals: RenderLocal[];       // always present; [] with no dock
RenderFrame.dockProps: RenderDockProp[]; // always present; [] with no dock
interface RenderLocal {
  id: LocalId; name: string; role: string; deckId: DeckDefId;
  x: number; y: number;                  // deck frame, tile units, on the dock
  facing: number; lookSeed: number;      // palette seed (hash of the name)
  postKey: LocalKey; label?: string; look?: string;
  carrying: number;                      // crates on a dock hand's trolley
}
interface RenderDockProp {
  defId: ItemDefId; name: string; kind: RenderItemKind; cargoClass?: CargoClass;
  count: number; deckId: DeckDefId; x: number; y: number;   // tile centre, deck frame
}
```

Locals are always on the dock, so draw them with the dock layer (as `onDock` actors). Playback
already interpolates `locals` by id (`apps/web/src/host/playback.ts`). `RenderItem.offered` now
also marks a closed offer's crates still waiting for a dock hand.

## 7. Interim server behaviour (replaced by the staging call)

*Replaced:* the staging call now runs (§staging-call-on-the-server): its own prompt, schema and
translator in `packages/narrator/src/staging/`, the route's staging model, budget and call log, and
the client's fallback to the floor set. What follows is the interim behaviour as the sim side left
it.

`POST /api/games/:id/narrator` answers a `stageDock` hook at once with `{ commands: [] }` (model
`staging-floor-set`), skipping the budget, the spacing rule (both ways), the call log and notes;
`runNarrator` does the same without a model. The narrator/server agent replaces both with the
staging prompt, schema and translator, D43 retries then fallback to the floor set with
`[narrator] staging fallback <reason>`, and `narrator_calls` logging by kind, keeping stageDock
out of the story spacing rule.
