# Dockside: Arrivals, the Dock, and the Captain Ashore

Status: design agreed with the owner, 2026-10-03. Owner inputs are marked **(owner)**; everything
else is a design-partner call the owner delegated. Behaviour goes into `docs/spec/` as each
phase lands and real decisions into `docs/DECISIONS.md` (D57 records the rulings); this file
stays as the rationale. The
implementation plan is `docs/design/dockside-plan.md`.

## 1. Why

Everything outside the hull is abstract today. A port is a set of stores (warehouse, market,
lounge) that are not on any map. Freight appears in the warehouse when a job is accepted, and
crew "load" it by standing on a transfer tile inside the ramp while it jumps aboard. Port
locals exist only as narrator text (`castSeed`, cast notes). The renderer draws the deck on
black, so a 90-second voyage looks the same as sitting at a dock.

Owner: "when the ship lands, all relevant characters and potential jobs should be present." That
asks for three things this doc designs together:

1. **Motion.** Travel must read as travel: stars streaming past in transit, a station or a
   planet arriving, a dock sliding into place, ramps lowering.
2. **A place.** Each port gets a small, walkable dock with its own layout, where freight sits,
   locals stand at their posts, and crew have to walk out and fetch things.
3. **A cadence.** The narrator decides who is on the dock before it comes into view. That is a
   different job from moving the story forward, so it becomes a different kind of call.

GDD §10 already anticipated this ("later versions can add small off-ship maps"; "supporting NPCs
... until they physically enter a location where detailed simulation is necessary"). This is
the smallest version: one dock per port, and nothing simulated past the gate.

## 2. The ship holds still; the world moves past it

### 2.1 The rule

The ship never moves on screen. Scenery flows from fore to aft (west to east in deck
coordinates, which the portrait rotation in `DeckCanvas` carries along). Arrival never
reverses. On departure the ship carries on forward: out of the far end of a station bay, or up
and out of a planet's sky.

### 2.2 Where scenery comes from

Scenery is client-only presentation, so the sim has no animation state. It is split by what it
must get right:

- **Port-bound scenery** (the station's structure, the planet's disc and ground, and the dock map
  with everyone on it) is a pure function of `(stage, stageProgress, fromPort, toPort)`. The dock
  therefore lands exactly when `docking` completes, playback interpolation works, and a reload
  partway through a docking draws the right picture.
- **Stars carry no meaning**, so they scroll from a client-side accumulator whose speed follows
  the stage. Positions come from a fixed hash, wrapped. A reload re-scatters them, and nobody
  will notice.

`RenderFrame.travel` gains `fromPortId`, `toPortId` (or `portId` when docked) and `drifting`.
`stage` and `progress` are already there.

### 2.3 Layers, back to front

1. Sky: space black, or the planet's sky gradient during descent and ascent.
2. Stars: two or three parallax layers. Hidden at a station berth, faded out under a planet sky.
3. Far scenery: the station's outer structure growing ahead, or the planet's disc.
4. **The dock map** (§3): floor, props, freight, locals. Drawn at the dock offset.
5. Hull outline and engine plume (§2.5).
6. The deck, exactly as today, plus the dock-side actors and items (§3.4).
7. Foreground: station bay walls and gantries, or cloud banks. Semi-transparent where they cross
   the deck, so the crew stay legible.

All of it is procedural vector drawing in the current style (rectangles, arcs, gradients, alpha),
with a palette per dock map. There is no image pipeline.

### 2.4 Stage by stage

Current stage lengths are kept (`travel.*Seconds`); they already fit these beats.

| Stage | Station | Planet |
|---|---|---|
| `docked` | dock alongside, bay walls in the foreground, ramps down | landing pad under the ship, sky colour, ramps down |
| `preparingDeparture` (5 s) | ramps retract | ramps retract |
| `undocking` (4 s) | clamps release, the dock starts to drift aft | dust kicks up, the ground starts to drop away (scales down) |
| `departing` (5 s) | the dock and bay walls slide off aft as the ship leaves the bay; stars fade in, plume grows | clouds rush past fore to aft over the deck, the sky darkens to black, stars fade in |
| `transit` | stars stream at full speed, plume at full | same |
| `approaching` (8 s) | the station grows from a point ahead, the ship slows | the planet's disc swells to fill the view, the sky colour comes up, clouds rush past and thin out |
| `docking` (5 s) | bay walls slide past on both sides; the dock map, with its people already at their posts, slides in from the fore and stops; clamps | the ground scales up as the ship settles, the pad slides into place, a puff of dust |

Drifting with propulsion lost (`travel.drifting`) slows the stars to a crawl and kills the plume,
which is feedback the deck view has never had.

With `prefers-reduced-motion`, stars are static and port scenery cross-fades instead of sliding.

### 2.5 Hull outline and plume

The deck is drawn as rooms on black, with nothing to say it is a ship. Phase 1 adds a silhouette
built procedurally from the deck's bounds: a tapered nose beyond the bridge (fore), engine bells
beyond engineering (aft), and a plume whose length and brightness follow the stage's speed and
the engine's output (a derated engine gives a weaker plume). No content change; an optional
`hull` block on `DeckDef` can come with a second ship.

### 2.6 Ramps and doors

Ramps are already doors (`kind: ramp`) with the generic `doors.openSeconds` (0.75 s). They get:

- `doors.rampOpenSeconds` (about 2 s) in config;
- a drawing of their own: the cargo ramp is a hinged plate that extends about two tiles out over
  the dock, the personnel ramp a narrow gangway behind a sliding airlock door;
- passability only once fully open, as now.

Ramps open on `docked` and retract in `preparingDeparture`, as they do today; only the drawing
and the timing change.

### 2.7 Camera

In flight the camera frames the ship with a margin, for scenery. Docked, it fits ship plus dock
map. The transition eases during `docking` and `undocking` as a function of stage progress, like
everything else port-bound. Dock maps vary in size (a long pier, a crowded bay), which is why
this is a zoom rather than a fixed strip.

## 3. Dock maps

### 3.1 One authored map per port **(owner)**

Each port gets its own dock map, `packages/content/data/docks/<port>.json`, validated by Zod like
every other content type, with `crew content render-dock <id>` producing an ASCII rendering and
README in the style of `render-deck`.

```
DockDef {
  id: "dock.crossroads_hub"
  portId: "port.crossroads_hub"
  setting: "station" | "planet"
  palette: { floor, wall, accent, sky?, ... }
  width, height
  rows: string[]            // tile grid, legend below
  legend: { char: "floor" | "wall" | "void" | "berth" | "prop" ... }
  shipAt: { x, y }          // dock tile under deck tile (0,0); the "berth" tiles are the ship's footprint
  posts: [{ key, kind: gate | warehouseDoor | marketStall | kiosk | loungeDoor | bench, tile, facing }]
  areas: [{ key, kind: freightStaging | deliveryBay, tiles }]
  props: [{ kind, x, y, w, h, rot, blocking }]   // crates, cranes, hull scraps, planters
  foreground: [{ kind: bayWall | gantry | terminalEdge | awning, rect }]
  ambience: string          // one line the narrator sees: "Announcements every ninety seconds; the queue board flickers."
}
```

The validator checks that the ship's ramp landing tiles (the dock tiles just outside each ramp
door) are floor; that both landings reach the gate, the warehouse door, and the market stall if
there is one; that the staging and delivery areas are floor and reachable; that every post tile
is floor; and that the map stays under a size cap (about 48 × 36 including the ship) so the
docked camera stays legible on a phone.

Maps are authored against Freighter Mk1's footprint and ramp positions. A second ship class
would need a berth spec (footprint plus ramp offsets) and maps that declare compatible berths.
That is deferred.

### 3.2 Deck change: both ramps on one side

`personnel_ramp` moves from the airlock's west (fore) wall, (0,13) side w, to its south wall,
(1,17) or (2,17) side s. Both ramps then face the dock, and every map can treat the ship's south
flank as the quay. The deck README is regenerated.

### 3.3 The six docks

Two planets and four stations. Green Meridian becomes a planet so the cloud descent is on the
short core loop.

- **Crossroads Hub** (station): a busy bay. A queue-board kiosk by the ramps (Hal Petrosyan's post),
  a night-market stall (Anneke Vos), the Co-op dispatch window, a lounge gate, other ships' crates
  stacked as props.
- **Kessler Drift** (station, bolted to rock): bare, narrow, an ore conveyor as a blocking prop,
  the assay window, a rock-wall foreground.
- **Green Meridian** (planet, rewritten as a farming world with a spaceport): an open pad under a
  green-gold sky, a produce shed for the warehouse, a growers' co-op stall, planters as props.
  `description` and `character` get rewritten to match.
- **Ossory Station** (station): a yard. Half-cut hull sections as props, the claims office as a
  post, a salvage market built into a container.
- **Tern's Rest** (planet): one long pier into open sky, the trading post at the far end, so the
  walk is the point.
- **Vesper Gate** (station): dim and quiet, the chapel-lounge door, a small apothecary stall.

### 3.4 How the dock exists in the sim

The dock is a second walkable area joined to the ship at the two ramp doors. Its tiles,
pathfinding and occupancy use the same spatial system as the deck. It exists in sim state from
the start of `docking` until the end of `undocking`, so the people on it are real while it slides
in and out, but it is walkable only while `docked` with a ramp fully open.

The mechanism is the first implementation question (plan, phase 2). The recommendation is to give
the dock its own nav area (its own `deckId`-like id and grid) and add **portal edges** at the
ramps that pathfinding can cross between areas, rather than grafting dock tiles onto the ship's
grid. Locations already carry a `deckId`, nav caches are already per deck, and portals are what a
multi-deck ship will need anyway.

The renderer draws the dock area at `shipAt` plus the scenery offset, and everything on it
(people, crates) moves with it.

### 3.5 What stays abstract

The gate and the warehouse door are the edge of the simulated world. Through the gate is the
port (lounge, concourse, town); through the warehouse door is the warehouse. Port stores stay as
they are: a person who walks through the gate goes `offShip` into the lounge store, and freight
carted through the warehouse door goes into the warehouse store. Nothing past them is ever drawn.

## 4. Port work becomes physical

**Freight on offer.** When a job is offered at a port, its freight is carted out through the
warehouse door onto the staging area (a short scripted dock-hand walk, or the narrator stages it
in advance, §6.1) and sits there with the issuer standing by it. Nobody owns it until the job is
accepted. A declined or expired offer is carted back in. This replaces "freight spawns in the
warehouse store on accept".

**Loading.** Accepted freight on the staging area raises the same `cargoToLoad` problems. Crew
walk down the cargo ramp, pick crates up (the hand truck matters now: several per trip) and carry
them into the hold. The transfer-tile shortcut goes away for freight; `DockingInterfaceDef`'s
transfer tiles stay only as a fallback for saves and tests without a dock.

**Delivery.** At the destination, crew carry freight down to the delivery bay. Custody is checked
there: the job is delivered when every crate is in the delivery bay. `contractCompleted` and
payment are unchanged. A dock hand (or the narrator's named receiver) then carts the crates through
the warehouse door, and they leave the world into the store as today.

**Parts.** `buyParts` (§buying-parts) walks to the dock's market stall instead of a transfer tile.
Bought units are handed over at the stall and carried aboard like freight. A dock with no stall
means the market is through the gate: the buyer walks out, is off ship for `buySeconds`, and walks
back with the part. The market's stock and prices are unchanged.

**Passengers.** Boarding passengers walk from the gate across the dock and up the personnel
ramp. Going ashore, they walk down and out through the gate. Returning, they appear at the gate.

**Leaving.** Departure prep already waits on cargo work and holds. It now also waits for every
crew member and passenger due aboard to be aboard, and for no accepted freight to be left on the
dock (that is cargo work, so it blocks as cargo work does today). A dock with locals still on it
just slides away with them.

## 5. People on the dock

### 5.1 Locals: a new, lightweight kind of actor

A local is an actor with a position on the dock, a name, a role, a look (a palette seed for the
dot) and a post. Locals are not crew. They have no needs and no skills, are never task or post
candidates, and are not perception subjects for the work system. Each has one of a few scripted
behaviours at a time:

- `atPost`: stand at the post, with a small idle shuffle;
- `walkTo(tile)`: used for meeting the captain or carting freight;
- `leave`: walk to the gate or warehouse door and despawn.

Locals exist only while the dock does: created at the start of `docking`, removed when undocking
ends. A local's identity lives where it always has: the port's content (`castSeed`), a job's
issuer, a left-behind passenger's actor record, or the narrator's notes. A local is a presence,
not a new entity.

They render as dots with a distinct style (no crew gold, no passenger rim), are tappable in the
inspector (name, role, "at the queue kiosk"), and carry a label when doing something ("waiting by
three crates").

### 5.2 Who is on the dock: the floor set

Computed by the sim when `docking` begins, before the narrator dresses the dock:

1. **Regulars:** `castSeed` entries gain an optional `post` (a post key on that port's dock map).
   Hal Petrosyan stands at the queue kiosk every time you come in.
2. **The job in hand:** the receiver for freight bound here (a named person if the narrator gave
   one, otherwise a generic dock hand from the name table), and the issuer if the job is being
   finished here.
3. **A passenger due back** stands at the gate at their return tick (passage logic unchanged; only
   where they appear changes).
4. **A passenger left behind or put off at this port earlier** (§ending-a-passage-early) may appear
   on the bench.

The floor set alone is a complete, correct dock. It is what the dock looks like when the staging
call fails (§6.1).

## 6. Narration cadence

The owner's two inputs together split the narrator into two kinds of call.

### 6.1 The staging call: sets the stage, never moves the plot **(owner)**

Owner: "The narration that decides what's happening on the dock when we land should not result
in a card ... it simply sets the stage rather than moves the plot forward. It needs to be aware of
the narration so that it sets the stage appropriately, but does not create or impact any arcs
directly."

- **When:** a new hook, `stageDock`, raised `narrator.approachHookLeadSeconds` before `transit`
  ends. That config value exists today and nothing reads it. It is **guaranteed**: travel does not
  leave `transit` until `stageDock` has been raised and answered. Today `approachingPort` goes
  through `raiseHookIfIdle` and is silently dropped if another hook is pending, which would land
  the ship at an empty dock. It fires at every docking, waypoints included, since every dock is
  seen.
- **Reads:** everything the story narrator reads (threads, cast, "What the captain has seen", the
  job in hand, the port's character and seeds), plus the dock map's posts, areas and ambience, and
  the floor set already placed.
- **Writes:** one thing, a staging plan:
  - `place`: up to three people (existing cast, port seeds, or a new face with name, role and a
    one-line look) at a post, with an optional short activity label;
  - `props`: crates or objects on the staging area or by a post, drawn from the item catalogue,
    owned by nobody. Example: two sealed crates by Fenwick, which the story narrator may later
    turn into an offer;
  - `ambience`: one sentence for the log on arrival ("The queue board is flashing red; someone
    is shouting about berth fees").
- **Cannot:** offer jobs, surface or shape cards, schedule faults, stock markets, or write notes.
  Threads, summary and cast are untouched. It has its own system prompt, its own output schema and
  its own translator, which drops anything else with a reason.
- **Continuity runs through sim state, not notes.** The people and props it places are real, and
  the story narrator sees them in its digest under "On the dock". A new face it invents is treated
  like a port seed: available to the story, but not in the cast until the story narrator writes
  about them.
- **Failure is not an error panel.** This is a deliberate exception to D43: staging is not story,
  so a failed call logs its reason and the dock is the floor set (§5.2). The host still retries
  per D43, so a transient failure costs nothing.
- **Model:** the output is small and constrained, so it is a candidate for a cheaper model than
  the story narrator. That gets decided with the live suite, not here.

`approachingPort` as a story hook goes away; its job (offer work on arrival) moves to §6.2.

### 6.2 The captain goes ashore to look for work **(owner)**

Owner: "the captain should leave the ship to go look for work, and [their] leaving the ship
should trigger narration."

- **Trigger:** docked, the captain idle by today's `captainIsIdleAt` rules (no offer open, no job
  in hand, no course, not a waypoint, nobody disembarking), a ramp open. The command actor (the
  captain, or the first officer when the captain is asleep or incapacitated, D8) gets a
  `lookForWork` task at essential-operation urgency. They finish what they are doing, walk down
  the personnel ramp, and **the `captainAshore` hook fires the tick they step onto the dock**.
  This replaces `jobBoard`. It fires once per docking, the same rule D46 (as amended) settled on;
  `narrator.jobBoardLastAsk` becomes `captainAshoreLastAsk` with the same lifetime.
- **Narrator:** this is a story call, with the full intent set. The prompt is today's `jobBoard`
  text, reframed: the captain has walked out onto this dock looking for work, here is who is on it
  ("On the dock"), and here is the port beyond the gate. It may offer work, advance a thread whose
  next beat is ready, or deliberately give nothing.
- **Delivery in person.** An `offerJob` or `surfaceDecision` names a speaker. If that person is a
  local on the dock, the captain walks to them, they talk for a moment ("talking with Fenwick
  Adair", about 3 s), and the card comes up then. If the speaker is not on the dock, the captain
  walks out through the gate, is off ship for a short while, and the card comes up when they
  return aboard. A narrator who gives nothing gets a captain who wanders the dock, perhaps steps
  through the gate, and comes back. This replaces the earlier "offer cards wait for the dock" rule: in-person
  delivery falls out of the walk without being built separately.
- **The captain off ship** is an actor walking around like any other. Perspective (D8) does not
  change: the captain ashore is still fit for command.

### 6.3 What changes for the other hooks

- `approachingPort`: removed, replaced by `stageDock` (§6.1) and `captainAshore` (§6.2). Offers
  never arrive in flight any more.
- `jobBoard`: replaced by `captainAshore`.
- `quietTooLong`: unchanged, including its ability to offer work while docked and idle. In that
  case the speaker walks in through the gate to the foot of the ramp, and the card comes up when
  they get there.
- `notableEvent`, `policyDecision`: unchanged.
- The digest gains "On the dock" (who, where, doing what; props and staged freight) for every call
  made while docked.

### 6.4 Budget

Per round trip (the earlier pacing run measured 10 calls), approach calls become staging calls (4, possibly on a
cheaper model) and `jobBoard` calls become `captainAshore` calls (2). Quiet and notable calls are
unchanged. `crew pacing` is re-run at the end of phase 4 to confirm. A staging call adds no stall
when it lands inside the run-ahead lead, which is the normal case.

## 7. Where things live

| Concern | Package |
|---|---|
| Scenery function, layers, hull, plume, ramp drawing, camera | `apps/web/src/render` |
| `RenderFrame.travel` port ids and `drifting`; dock and locals in the render projection | `packages/sim` (`core/render.ts`, `core/types/view.ts`) |
| `DockDef` schema, six maps, castSeed `post`, port `setting`, validator rules | `packages/content` |
| Dock nav area and ramp portals, locals, physical cargo, `lookForWork`, `stageDock` gate, `captainAshore` | `packages/sim` |
| Staging prompt, schema, translator; captain-ashore prompt; "On the dock" digest | `packages/narrator` |
| `stageDock` route handling, fallback to floor set, call logging | `packages/server` |
| `render-dock` | `apps/cli` |

The dependency rules are unchanged: the renderer reads only `RenderFrame` and content, and the
planner sees locals only through `AgentView`, as obstacles.

## 8. Decisions

Owner:

1. One authored dock map per port.
2. The captain goes ashore to look for work, and that triggers narration (replaces `jobBoard`).
3. The arrival call sets the stage only: no card, no arcs, aware of the story.
4. Stars streaming past in transit, as part of the first deliverable.

Delegated, taken here:

5. The ship never moves on screen; port-bound scenery is a pure function of travel stage and
   progress; stars use a client accumulator.
6. Procedural vector art with per-dock palettes; no image pipeline.
7. Camera zooms between ship-only and ship-plus-dock (rather than a fixed strip), because map
   sizes vary.
8. Both ramps on the south flank.
9. Green Meridian becomes a planet; Tern's Rest is the other one.
10. Offered freight is physically staged on offer, not on accept.
11. Locals are scripted presences, not simulated people.
12. `stageDock` is guaranteed and gates arrival; its failure falls back to the floor set instead
    of pausing the game (an exception to D43).
13. Cards are delivered where the captain meets the speaker; the earlier wait-for-dock
    rule is superseded.

## 9. Deferred

- Locals who need simulating: needs, schedules, wandering between posts over a long stay.
- Anything past the gate; multiple docks per port; berths for other ship classes.
- The crew going ashore on their own time (shore leave, crew drinking at the stall): the
  mechanism (walk out through the gate, `offShip`, return) exists after phase 4, but no reason to
  use it does yet.
- Docking that requires a staffed bridge (SD §17.2 mentions it).
- In-flight encounters using the same scenery system (a derelict sliding past).

## 10. Testing

- **Unit (web):** the scenery function at stage boundaries (the dock offset is 0 at `docked` and
  off-screen at `transit`; continuous across `approaching` → `docking` → `docked`); camera fit at
  both ends; reduced-motion path.
- **Unit (content):** every dock map validates; ramp landings reach the gate, the warehouse door
  and the stall; a broken map fails with a readable message; castSeed `post` names a real post.
- **Unit (sim):** pathing through ramp portals; the dock exists from `docking` to the end of
  `undocking` and is walkable only while docked with the ramp open; staged freight on offer, carted
  back on decline; loading from staging; delivery by custody in the delivery bay; departure waits
  for everyone aboard and no accepted freight ashore; the floor set; `stageDock` gating the end of
  transit, including when another hook is pending; `lookForWork` fires `captainAshore` once per
  docking; a card delivered on meeting and on return through the gate.
- **Narrator:** the staging translator drops every non-staging intent with a reason; staging never
  writes notes; the "On the dock" digest section; captain-ashore hook text.
- **Kernel integration:** a full hub → Kessler run with freight: staged on arrival, captain ashore,
  offer delivered on the dock, loaded by hand, delivered to the bay, paid once.
- **Live:** one `stageDock` call (asserts staging-only output that names a real post) and one
  `captainAshore` call (asserts an offer or a stated reason).
- **Pacing:** `crew pacing` after phase 4, compared with the earlier pacing run (10 calls per round trip).
- **Playtest:** a phone playtest at the end of each phase.
