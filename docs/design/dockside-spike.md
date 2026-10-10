# Dockside spike: how the dock joins the deck

Status: spike done, 2026-10-03 (phase 2, item 1 of `docs/design/dockside-plan.md`). Prototype in
`packages/sim/src/systems/spatial` (`dock.ts`, `grid.ts`, changes to `geometry.ts`,
`pathfind.ts`, `routing.ts`, `estimates.ts`, `doors.ts`, `movement.ts`, `topology.ts`,
`invariants.ts`), plus `requestRamps` in `systems/travel/travel.ts` and new optional fields in
`core/types` (`ids.ts`, `content.ts`, `ship.ts`, `nav.ts`). Tests in `dock.test.ts` over the
fixture `fixtures/dock.ts`. The decision is D59 in `docs/DECISIONS.md`; the rules are in
§the-graft-onto-the-deck-grid.

## 1. Answer

**Graft, not portals.** While a dock is alongside, its walkable tiles are stamped into the ship
deck's own nav grid, in the deck's own coordinate frame (deck tile = dock tile − `shipAt`). There
is one grid, one coordinate frame and one `deckId`. A person on the dock is an ordinary `onDeck`
location on the ship's deck whose tile happens to be dock floor (`isDockTile`); its coordinates
may be negative or past the deck's authored bounds. The hull walls the dock off everywhere
except across the two ramp doors, and a ramp is passable only while fully open.

The design (§3.4) recommended portals. The spike reverses that, for one concrete reason: **the
cost of portals is not in the spatial system, it is in every bare `TileCoord` outside it.**

## 2. Why not portals

Inside `systems/spatial`, portals are tractable: give each nav area its own grid, add portal edges
at the ramps, run A* over `(area, tile)` nodes, key reservations by area (they already are, by
`deckId`). That part would have been a few hundred lines.

What makes them invasive is that almost nothing outside `systems/spatial` says which area a tile
is in. A tile is a bare `{x, y}` that means "on the actor's current deck". With two areas, every
one of these becomes ambiguous and needs an area tag:

| Where | Field | Serialized? |
|---|---|---|
| `core/types/actor.ts` | `movement.path: TileCoord[]` (a route that crosses a ramp spans two areas) | yes |
| `core/types/actor.ts` | `RouteFailure.tile`, `actorStatus` fact `tile` | yes |
| `core/types/work.ts` | `Task.interactionTiles`, `Claim.tile`, `StepTarget` (`moveTo` plan steps) | yes |
| `core/types/work.ts` | `personal` intent `tile` (the planner's output) | no |
| `core/types/view.ts` | `SelfView.tile`, `KnownItemView.tile`, `SchematicView.isFloor/compartmentAt`, `estimateTravelTicks(to, from)` | no, but planner-facing |
| `planner/candidates.ts` | 15 uses: every travel estimate and target it builds | no |
| `core/types/events/spatial.ts` | `routeBlocked.tile`, `reachedTile.tile` | in the log |
| `core/types/view.ts` | `RenderActor.deckId` + x/y, `RenderItemLocation` | no |

`systems/work/plans.ts` alone resolves targets in four places through "the actor's deck"
(`actorDeck(actor)`), and `execute.ts`, `labels.ts`, `claims.ts`, `perception.ts`,
`commerce/passage.ts`, `commerce/market.ts` and `core/caches.ts` all look a tile up in
`content.decks[location.deckId]`. With portals, `OnDeckLocation.deckId` widens to a
deck-or-dock union and every one of those lookups has to handle a dock (TypeScript would find
those), but the bare `TileCoord`s above would not be found by the compiler: a planner that
estimates travel "to the crate at (5, 10)" while standing aboard silently means the deck's (5, 10).
Fixing that means an `AreaTile` type through work state, the planner, `AgentView` (a file being
changed concurrently on `main`), a save migration of every route and task, and movement
interpolating across a frame change at the ramp (or the two frames aligned anyway, at which
point the area tag is redundant).

The cheaper-looking variant, **portals in a shared frame** (separate grids, but the dock's grid
placed in deck coordinates so a bare `TileCoord` stays unambiguous), removes that argument, and
was considered. It still needs A* over two grids joined by portal edges, a two-geometry lookup at
every `deckGeometry(caches, deckId)` site, and area-keyed reservations and occupancy, and it gains
nothing over one grid with an origin: once the frames are shared, the area is a function of the
coordinate, which is exactly what `isDockTile` is.

Portals buy two things: the dock keeps its own coordinates in the sim, and a future multi-deck
ship would reuse them. The first is worth little: the dock's authored frame matters only to
content and validation, and one subtraction converts it (`dockToDeck`). The second is not on any
roadmap (W0: single ship, single deck), and grafting does not preclude adding portals between
decks later; it only means the dock is not where they get built.

Grafting's own cost, the one the plan named ("it makes the deck's dimensions dynamic"), turned
out to be small and contained: the grid gains an origin, all index arithmetic goes through
`grid.ts` (or a local copy in the two hottest files, see §6), and the geometry is rebuilt when a
dock attaches or detaches. No code outside `systems/spatial` reads `geometry.width`, `height` or
raw indices.

Grafting does move one cost outside spatial, which the review (§7) pointed out: **"on deck" no
longer means "aboard".** With portals, aboard would be `deckId === ship`; with the graft it is
"`onDeck` and not on a dock tile". `isOnDock(content, state, location)` answers that without the
nav cache, and the code that equates `onDeck` with aboard has to be swept (§4).

## 3. The mechanism as built

### 3.1 Data shapes

Since the spike, phase 2 replaced `DockLayout` with the authored `DockDef` itself:
`ContentBundle.docks` holds `DockDef`s, and the graft reads walkability through
`dockFloorMask(def)` (a `floor` legend tile under no blocking prop) instead of `.` rows. The
shapes below are as the spike built them.

```ts
// core/types/content.ts — the nav subset of phase 2's DockDef, in the dock's own frame
interface DockLayout {
  id: DockDefId;
  width: number;
  height: number;
  rows: readonly string[];   // "." walkable dock floor; anything else (wall, void, berth, blocking prop) not
  shipAt: TileCoord;         // dock tile under deck tile (0,0)
}
ContentBundle.docks?: Record<DockDefId, DockLayout>   // optional; phase 2 replaces with DockDef

// core/types/ship.ts — DeckState (spatial-owned, serialized)
dock?: { dockId: DockDefId; deckId: DeckDefId }       // the dock alongside, if any

// core/types/nav.ts — DeckGeometry (cache, never serialized)
originX, originY             // deck coords of grid index 0; negative when the dock reaches fore/above
width, height                // now the union of deck and dock bounds while docked
compartment[i] === DOCK_FLOOR (-2)   // dock floor: floor, in no compartment
dock?: { dockId, offset, landings: Map<rampDoorId, TileCoord> }
openRamps: Set<DoorId>       // ramps fully open right now
```

Ramp landings are not authored: each ramp lands on the dock tile across its hull edge, which the
graft computes (`rampLanding`) and the builder requires to be dock floor. Phase 2's `DockDef`
therefore needs no landing field, and cannot disagree with the deck about where its ramps are.

`DockDefId` is a new brand in `core/types/ids.ts` (added to `DefId`).

### 3.2 Building the grid

`buildDeckGeometry` takes an optional `dock` layout. With one, the grid's bounds become the union
of the deck rectangle and the dock map (in deck coordinates), dock floor is stamped in with
`DOCK_FLOOR`, and the implicit-wall pass treats dock floor as a region of its own, so a wall goes
up on every edge between ship floor and dock floor (on both tiles) as it does between two
compartments. Ramp doors already clear their edge's wall, so they are the only openings. The
builder throws if dock floor overlaps ship floor or a ramp does not open onto dock floor.

Dock coordinates live only in content. Everything in the sim (posts, staging areas, the gate)
is converted once with `dockToDeck(layout, tile)`.

### 3.3 Lifetime

`attachDock(host, { dockId, deckId })` and `detachDock(host)` (`systems/spatial/dock.ts`) are
the only writers of `state.deck.dock`. Both bump `geometryRevision` and rebuild the geometry
immediately, so the rest of the tick sees the change.

- `attachDock` validates first (`checkDockGraft` builds and discards the grid) and changes
  nothing if the layout is missing, overlaps the ship, or leaves a ramp landing on nothing.
- `detachDock` throws if any ramp on the deck is not fully closed, or any actor or on-deck item
  still stands on a dock tile (`occupantsOfDock`). Whoever drives departure must clear the dock
  and raise the ramps first. The closed-ramp rule also covers someone mid-step in a ramp's
  aperture, who would otherwise finish the step onto a tile that no longer exists; the door
  system never closes a ramp over an occupant. It drops per-tile state and reservations on dock
  tiles.
- On restore, the nav cache builder grafts whatever `state.deck.dock` names. `navRefresh` (phase
  2, topology) rebuilds the geometry if the graft ever disagrees with state; otherwise it only
  refreshes dynamic state.

Phase 2's travel calls `attachDock` at the start of `docking` and `detachDock` at the end of
`undocking`.

### 3.4 Ramps

These rules are what make "walkable only while docked with a ramp open" hold. The first one is
also a fix to today's game.

1. **Ramps never close themselves.** Until now a ramp that reached `open` under power got the
   generic `closeAfterTick`, so in the live game both ramps closed again
   `doors.autoCloseAfterSeconds` (3 s) after docking. Nothing noticed, because transfer tiles
   are inside the hull. Ramps are now opened and closed only by travel.
2. **Actors never ask a ramp to open.** Movement's door gate does not write `requestedState` on
   a ramp. An actor who reaches a ramp that is not open waits while it is lowering (travel has
   asked for `open`), and otherwise the route ends `blocked` there. No `jammed` fact is written,
   since planning already knows.
3. **Planning treats a ramp as free when it is fully open and travel still wants it open, and
   impassable otherwise** (`rampPassable`), in both the schematic policy (estimates, `AgentView`)
   and the actor policy, ignoring door facts. Ramp state and ramp requests are public: everyone
   aboard knows whether the ramps are down and whether they are about to come up. Once travel asks
   for the ramps up, nobody plans a trip down one, even while it is still physically open.
   `plannedDoorSeconds` in `routing.ts` holds the rule. Movement still lets someone already on
   their way cross a physically open ramp.
4. **`syncRampPassability` keeps `geometry.openRamps` in line with the doors**: the door system
   calls it after every run, and travel's `requestRamps` calls it as soon as it changes a request,
   so planning later in the same tick already sees it. On any change it bumps
   `geometryRevision`, clears the path cache (the `schematic` policy key carries no revision) and
   sets `dirty.navigation`.
5. Existing door rules carry over unchanged: a ramp with someone in its aperture does not start
   closing, and a closing ramp reopens if someone steps into it. Departure therefore has to stop
   people starting down the ramp before it asks for the ramps closed (§4, travel).

### 3.5 What did not change

Pathfinding, movement, reservations, passing (the corridor overlap slowdown), door occupants,
route continuation and save/restore all work across the ramp edge with no dock-specific code,
because the ramp is just a door on an edge between two adjacent tiles of one grid. Movement
interpolates continuously over the ramp. The cache key, the reservation key (`deck:x,y`) and
`TileKey` all accept negative coordinates.

## 4. What each caller has to change

Outside `systems/spatial`, the spike changed only travel's `requestRamps` (it now takes `caches`
and syncs ramp passability) and one test fake in `commerce/passage.test.ts` that stood in for a
nav cache with `{}`. For phase 2:

**Travel** (`systems/travel/travel.ts`)
- `attachDock` when entering `docking` at a port whose dock is in content; `detachDock` when
  `undocking` ends. A port without a dock keeps today's transfer-tile behaviour.
- **Ramp requests become a function of who is ashore, not a one-way close.** Today
  `preparingDeparture` requests the ramps closed every tick. Under rule 3.4.2 actors never ask a
  ramp down, so anyone still on the quay when that starts is stranded for good. Departure prep
  must keep (or put) the ramps down while any crew member or passenger due aboard is on a dock
  tile or walking to one, and request them up only once everyone is aboard and no accepted
  freight is on the dock (plan item 8). `detachDock` throws rather than strand anyone on tiles
  that no longer exist. Locals (phase 3) must be despawned before `detachDock`.
- A jammed ramp can never close, so it blocks `detachDock` and departure. That is the right
  outcome (the ship cannot leave with a ramp down) but needs a problem and a headline.
- `theDeckId` stays. There is still one deck.

**"Aboard" checks** (from the review): code that treats any `onDeck` location as aboard now
counts the quay as the ship. `core/render.ts` `isAboard` would draw staged freight on the dock as
cargo aboard and count it in "N of M crates aboard"; commerce custody, passage boarding and the
departure checks have the same shape. Sweep the `kind === "onDeck"` sites outside spatial and use
`isOnDock(content, state, location)`, which is pure over state and content, so `core` and
commerce can call it without the nav cache.

**Work** (`systems/work`)
- Freight on the dock is an ordinary `onDeck` item: `pickupTile`, `acquireSteps`, `runPickUp`
  (same `deckId`, adjacent) and `dropHaulCargo` work as they are.
- Delivery custody needs a completion kind for "item in a dock area" (`itemInDockArea { areaKey }`
  beside `itemInZone`), with the area's tiles converted to deck coordinates. `claims.ts` and
  `haulPlan` look zones up in `content.decks[..].zones` today.
- **Perception:** dock tiles are in no compartment, so `observe` returns early for someone on the
  dock and sees nothing there. Add a dock "region" to `perception.ts`: standing on a dock tile, see
  items and people on dock tiles. Until then, commerce briefing facts (as the manifest briefing
  does today) are enough for staged freight.
- **Labels:** `placeLabel` says "walking" for a dock target (no compartment); make it "walking
  to the dock" or "going ashore" using `isDockTile`.
- **Events:** stepping onto the dock leaves a compartment and enters none, so movement emits
  nothing. Phase 4's `captainAshore` hook and the narrator digest want a signal; add a
  `wentAshore`/`cameAboard` event in movement when a step crosses a ramp.
- `ambient.ts` chats by radius on the same `deckId`, so crew can now chat through the hull with
  someone on the quay. That already happens through interior walls; leave it.

**Planner / AgentView**: no shape change. `estimateTravelTicks`, `schematic.isFloor` and
`compartmentAt` already cover dock tiles, and a dock target behind a closed ramp estimates `null`
(unreachable), which the planner already handles. Phase 4's `lookForWork` will want the dock's
posts; add a `schematic.dock()` accessor to `core/types/view.ts` then, coordinated with whoever
owns that file.

**Commerce**: staged freight, the delivery bay and the stall are deck-frame tiles from
`dockToDeck`. `onTransferTile` and `dockedAt` stay for docks-less fallbacks. Passengers board
by spawning at the gate tile and walking (`passage.ts` spawns at the personnel transfer tile
today). Bought parts are handed over at the buyer's feet, which now can be the stall.

**Render projection** (`core/render.ts`, `core/types/view.ts`, being changed on `main`): no
change needed for correctness, since dock actors and items already project as deck positions
outside the hull rectangle. Phase 2 adds `RenderFrame.dock?: { dockId, shipAt }` so the renderer
can draw the dock layer and slide everything standing on dock tiles with it during `docking` and
`undocking`. A per-actor `onDock` flag is optional; the renderer can test tiles itself. These
are additive fields, which keeps the merge with the phase 1 work simple.

**Commands** (`core/command-handlers.ts`): `onDeck` spawn validation checks the authored deck
bounds and tiles, so a command cannot place anything on the dock. That is right for today's
commands; phase 3's `stageDock` command must validate against the nav geometry instead.

**Content validation**: `packages/content` may only `import type` from sim, so it cannot run the
graft. Zod checks shape (row widths, `shipAt` in bounds, legend). The geometric checks (berth
covers the ship, no overlap, ramps land on floor, landings reach the gate, warehouse door and
stall) should run in `apps/cli` content validation by calling sim's `checkDockGraft` and
`estimateTravelTicks` on a docked world, so there is one implementation of the rule.

**Save/migrations**: `state.deck.dock` is optional, so older saves need nothing for its absence.
Migration 3 → 4 sets it for a save docked at a port with a dock map (and bumps
`geometryRevision`); restore then grafts. No location or route changes shape.

A docked save is now coupled to its dock map: restore throws if the layout is gone from content,
and a map edited to overlap the ship or move a landing makes the graft throw. That is explicit
rather than silent, and tested, but it will bite while the six maps are being authored. Two
mitigations: validate every dock against the deck at content load (CLI, `checkDockGraft`), so a
bad map fails at build, not at restore; and treat a map edit that moves floor under a docked
save's people or freight as a content change needing a save migration, like any other.

**Invariants** (`spatialViolations`, added): the grid grafts exactly `state.deck.dock`; the
open-ramp set matches `rampPassable` for every ramp; every on-deck item lies on floor. The
existing "actors stand on floor" check covers anyone left on a detached dock. Phase 2 travel
should add "a dock is attached only from `docking` to the end of `undocking`".

## 5. What the tests show

`systems/spatial/dock.test.ts` (17 tests, over a 12×8 deck with two south ramps and a 16×12 quay
that wraps the berth and reaches fore of the bow, so deck x goes negative):

- the grid grows to origin (−2, −1), 16×12; dock tiles are floor in no compartment; ramps land
  where expected;
- the hull, checked exhaustively: every edge between ship floor and dock floor is walled on both
  tiles (17 edges) except the two ramp doors;
- a dock overlapping the ship, or a ramp landing on a wall, is refused with nothing changed;
- a closed ramp makes dock tiles unreachable to the actor policy, the schematic estimate and
  `requestMove`; a ramp still lowering is not passable either; once open, the estimate appears at
  once;
- the moment travel asks the ramps up (`requestRamps`), planning stops routing down them although
  they are still physically open;
- a walk from a room behind a manual door, down the cargo ramp, to the bow end of the quay (−1.5,
  3.5 is a well-formed `onDeck` location on the ship's deck, `isOnDock` true, in no compartment
  index), round the crate stack and back aboard, with kernel and spatial invariants checked every
  tick;
- spatial's and `AgentView`'s estimates agree and match the actual walk to within 2 ticks;
- two people cross one ramp in opposite directions, slow while passing, and both arrive;
- a deck interaction position held by someone aboard makes a walker from the dock wait aboard
  and give up with `positionTaken`;
- a ramp raised before a walker reaches it ends their route `blocked` on the dock, and it stays
  closed (nobody reopens it); a ramp told to close while someone is in its aperture waits for
  them, and `detachDock` refuses meanwhile;
- `detachDock` refuses with ramps down, then with someone on the quay, and then shrinks the grid
  back to 12×8;
- per-tile state on negative dock coordinates (an obstruction) reroutes walkers and is dropped
  with the dock;
- nav refresh regrafts when state names a dock the grid lacks (as a migration would write it);
- restoring a docked save whose layout is gone from content throws a clear error;
- save and restore mid-walk on the dock, then 300 ticks in lockstep to identical state.

The whole suite is green (`pnpm typecheck && pnpm lint && pnpm depcruise && pnpm test`: 82 files,
641 tests). One performance note: the first version of the origin-aware index arithmetic slowed
`apps/web/src/worker/fullSim.test.ts` by about 20% (17.4 s against 14.1 s for its three tests)
and pushed two of them past vitest's 5 s timeout. The profile showed the cost in cross-module
calls to the index helpers from pathfinding's innermost predicates, which the test runner's
module transform routes through binding getters. Keeping that arithmetic local in `geometry.ts`
and `findPath` brought it back to 14.2 s. Those three tests already ran at 4.6–4.9 s each before
this change, so they are close to the timeout on main regardless.

## 6. Known gaps

- **Posts with capacity.** Interaction positions belong to machines (`NavInteractionPosition`
  has a `machineId`, `InteractionTarget` is machine-keyed). A market stall that serves one
  person at a time needs a reservable position that is not a machine. Proposal: posts with a
  capacity become entries in `interactionByTile` with an owner of `machine | post`, and are
  addressed by tile. Not needed until the stall (phase 2 item 7) or locals (phase 3).
  `detachDock`'s sweep of reservations on dock tiles exists for them; today it never finds any.
- **Perception on the dock**, the **"aboard" sweep**, the **two-way ramp rule in travel** and the
**`wentAshore` event** (all §4). Done (§calling-the-crew-aboard), with the dock's lifetime, the
  travel invariant and migration 3 → 4.
- **Saves coupled to dock maps** (§4, save/migrations).
- **Ramp timing.** Phase 1 adds `doors.rampOpenSeconds`. The door system's `opening` branch
  picks the seconds, right next to this spike's no-auto-close change in `doors.ts`; expect a
  small merge there. `plannedDoorSeconds` makes an open ramp free, so a walker never budgets
  for ramp travel time; that is right, since only travel opens ramps.
- **The cargo ramp's plate** that reaches two tiles over the dock (§2.6 of the design) is drawing
  only: the plate covers ordinary dock floor tiles.
- **Ramps on other sides.** The graft works for a ramp on any hull side. Moving the personnel ramp
  to the south wall (plan item 2) is still right, so every dock can treat the south flank as the
  quay, but it is no longer a nav requirement.
- **Grid size.** The 48 × 36 cap gives 1,728 tiles against today's 576, and `findPath` allocates
  per call in proportion. `planner/candidates.ts` calls `estimateTravelTicks` uncached, about 15
  times per plan. Probably fine; measure with the first real map before phase 4's `lookForWork`
  adds more.

## 7. Review

A second opinion (a separate model, given this writeup and the code) agreed with the decision and
found problems in the prototype. What it found, and what was done:

1. **`detachDock` could strand someone mid-step** (verified by the reviewer): an actor in a ramp's
   aperture, still on a ship tile, was not counted as on the dock; detach succeeded and the
   actor finished the step onto void. **Fixed:** `detachDock` now also requires every ramp
   closed (the door system never closes over an occupant), with a test.
2. **Ramp passability ignored the request**, so on the tick departure asked the ramps up the
   planner still sent people down them; and with actors never requesting ramps, anyone on the
   quay when prep began would be stranded. **Fixed** the first: passable now means fully open
   *and* requested open, synced from the door system and from `requestRamps` the same tick, with
   a test. The second is travel's job in phase 2; it is now spelled out in §4 (ramp requests as a
   function of who is ashore).
3. **"On deck" no longer means aboard**, and pure code like `render.ts`'s `isAboard` would count
   staged freight on the quay as cargo aboard. **Added** `isOnDock(content, state, location)`, pure
   over state and content, and a sweep item in §4. §2 now names this as the graft's real cost
   outside spatial.
4. **Docked saves are coupled to dock maps.** Kept the explicit failure (restore throws, tested)
   rather than silently dropping the dock; recommended build-time validation and migrations (§4).
5. **The `schematic` policy key carries no revision**, so a cached schematic route could outlive a
   ramp change. **Fixed:** a ramp passability change clears the path cache.
6. Smaller: a `wentAshore` event (§4), grid size and uncached estimates (§6), test gaps. **Added**
   the exhaustive hull test, the mid-aperture detach test, the regraft-on-refresh test and the
   missing-layout restore test; dropped an assertion that was trivially true.

It also suggested the comparison should be against portals in a shared frame rather than
portals with their own coordinates. §2 now covers that variant.

## 8. Recommended build order for the rest of phase 2

1. **This spike, merged first**, with its D entry. It touches `doors.ts` near phase 1's ramp
   timing and `travel.ts`'s `requestRamps`, so merge it right after phase 1, or rebase phase 1's
   ramp change onto it. The ramp no-auto-close fix matters to phase 1 as well: without it the new
   ramp drawing would show both ramps folding back up 3 s after every docking.
2. **Deck change** (plan item 2): the personnel ramp to the airlock's south wall; spawn points,
   transfer tiles, deck README, pinned tests.
3. **`DockDef` and the Crossroads Hub map** (items 3 and 5, first map only): the schema in
   content, `dockLayoutOf(def)` deriving this spike's `DockLayout`, `ContentBundle.docks` keyed by
   dock id with `PortDef` → dock lookup, Zod shape checks, and the CLI geometric validation calling
   `checkDockGraft`. `render-dock` (item 4) alongside, since it is how the map gets reviewed.
4. **Dock lifetime in travel** (item 6) together with **departure waits for everyone aboard**
   (item 8) and the two-way ramp rule. These come together because a dock you can walk onto
   without them strands people on it. Add the travel invariant, the perception region, the
   labels and the `wentAshore` event.
5. **Render projection and the dock layer** (item 10), coordinated with the phase 1 renderer:
   `RenderFrame.dock`, the dock drawn at `shipAt` plus the scenery offset, the docked camera fit,
   and `isAboard` switched to `isOnDock`. Playtest walking on the hub's quay before any cargo
   changes.
6. **Physical cargo** (item 7): the "aboard" sweep in commerce, staging on offer, loading from
   staging, the delivery-bay completion kind, `buyParts` at the stall (posts with capacity, §6),
   passengers through the gate.
7. **The other five maps** (item 5), each validated and rendered.
8. **Migration 3 → 4** (item 9), once the state shape has stopped moving.
9. **Narrator digest** (item 11).

## 9. Draft decision entry

Merged as D59 in `docs/DECISIONS.md`.

> **D5x. The dock is grafted onto the deck's grid, not joined by portals.** The phase 2 spike
> (`docs/design/dockside-spike.md`) reverses the design's recommendation (dockside §3.4). While a
> dock is alongside (`state.deck.dock`, set by `attachDock` at the start of `docking` and cleared
> by `detachDock` at the end of `undocking`), its floor is stamped into the ship deck's nav grid
> in the deck's own frame: one grid, one coordinate frame, one `deckId`. A person on the dock is
> an ordinary `onDeck` location whose tile is dock floor, possibly at negative coordinates. Dock
> floor is in no compartment and the hull walls it off except at the ramp doors. Portals would
> have kept a separate area per dock, and every bare `TileCoord` outside `systems/spatial`
> (routes, tasks, claims, plan steps, `AgentView`, the planner's estimates) would then need an area
> tag, a change the compiler cannot find for us; portals in a shared frame avoid that but add a
> second grid for no gain. Grafting costs a grid origin and a rebuild on attach/detach inside
> `systems/spatial`, and one cost outside it: `onDeck` no longer means aboard, so "aboard" checks
> use `isOnDock`. Ramps are now owned by travel alone: they no longer auto-close (until now they
> closed 3 s after docking), actors never request them, and planning treats a ramp as passable
> only while it is fully open and travel still wants it open, from truth, since everyone knows
> whether the ramps are down. `detachDock` refuses while a ramp is down or anyone or anything is on
> the dock, so departure must bring everyone aboard, and keep the ramps down until it has, before
> raising them. Dock layouts carry no ramp landings; each ramp lands on the dock tile across its
> hull edge. A multi-deck ship would still want portals between decks; this does not preclude
> them.
