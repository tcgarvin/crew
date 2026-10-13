# Dockside

The dock a ship lies against: the authored dock map, its graft onto the ship's grid, the people
and props who dress it, freight work on foot, and the captain's walk ashore. Config is under
`travel.*` in `packages/content/data/config/default.json`; code in
`packages/sim/src/systems/spatial/dock.ts`, `core/{docks,locals,floor-set}.ts`,
`systems/travel/{locals,staging,ashore}.ts`, `systems/commerce/{dock-hands,captain-ashore}.ts`,
and `packages/content/src/schemas/{dock,validate-dock}.ts`.

## Dock maps

### Dock map content

Each port has one `DockDef` (`packages/content/data/docks/<port>.json`) that the sim reads
directly, with no conversion step: a tile grid with a legend (`floor`, `wall`, `void`), a berth
box for the ship, posts (`gate`, `warehouseDoor`, `marketStall`, `kiosk`, `loungeDoor`, `bench`),
areas (`freightStaging`, `deliveryBay`), props and foreground (rects of closed kind
vocabularies, so the renderer knows what it must draw), an `ambience` line, a palette (a planet
also has a `sky`), and `grime` and `airborneDust` (see `crew-life.md`). Walkable means a `floor`
tile under no blocking prop. A dock is a station or a planet because its port is, never by a
setting of its own: a planet port's dock must have a `sky`, and a station's has none and no
`airborneDust`. A landing site's map is a `DockDef` of `kind: "site"` with cover and posts of its
own (§site-maps).

A port's `castSeed` regulars name a `post` on its dock, and every port has at least one posted
regular. Kessler Drift has no stall (its market is through the gate); Vesper Gate's chapel doors
are its gate.

### Dock map validation

Content validation checks the geometry as plain grid rules: berth tiles are exactly the ship's
floor at its place in the box, ramps land on walkable floor outside any area, every post and area
is reachable from every landing, there is one gate, warehouse door, staging area and delivery bay
and at most one stall, and the map is within 48x36. The walkable rule is written twice (content
may only import types from sim), so `crew content validate` also grafts each dock with the sim's
builder and a test keeps the two masks identical. Every dock's warehouse door lies within eight
steps of its delivery bay. Why: a receiver sent from further lost the race to the cast-off and
the delivery was taken in instantly instead of on foot.

A landing site's map skips the gate, warehouse, stall and area rules for its own
(§site-map-validation). A port with no dock map (hand-built test content) keeps the transfer tiles
and stores, and none of the rules below apply.

## The graft

### Dock alongside

Travel attaches the port's dock at the start of `docking` and casts it off at the end of
`undocking` (`attachDock`, `detachDock`; `state.deck.dock`). A new game starts with its port's
dock alongside and the ramps down. A travel invariant (`travelViolations`) holds the dock to
exactly that window.

### The graft onto the deck grid

While a dock is alongside, its floor is stamped into the ship deck's nav grid in the deck's own
frame: one grid, one coordinate frame, one `deckId`. A person on the dock is an ordinary `onDeck`
location whose tile is dock floor, possibly at negative coordinates. Dock floor is in no
compartment and the hull walls it off except at the ramp doors; each ramp lands on the dock tile
across its hull edge. `onDeck` does not mean aboard, so "aboard" checks use `isOnDock`. Why:
portals would have needed an area tag on every bare `TileCoord` outside `systems/spatial` (D59).

### Ramps and cast-off

Ramps are owned by travel alone: they never auto-close, actors never request them, and planning
treats a ramp as passable only while fully open and still wanted open. `detachDock` refuses while
a ramp is down or anyone or anything is on the dock, so departure brings everyone aboard and keeps
the ramps down until it has (§calling-the-crew-aboard). Anything still lying on
the dock when it goes is left at the port's warehouse (`leftOnDock`), except the ship's own hand
truck, which the dock crew hand up the cargo ramp (`gearBroughtAboard`); anyone still on it is
brought aboard first as a last guard. Docked at a port, the ship's dead are carried ashore
(§laid-to-rest).

### Living on the dock

Someone on the dock looks around the dock (items and people), their walks are labelled "going
ashore", "walking on the dock" and "coming aboard", a step across a ramp emits `wentAshore` or
`cameAboard` (trace), and the narrator digest says "on the dock". A part on the dock is aboard for
`partsNeeded` (§parts-and-tools-needed); freight on the dock, and a put-off passenger's luggage, is
not aboard for loading.

## Locals

### Locals table

`state.dockside.locals` (ids `o<n>`) holds the dock's people who are not crew: name, role, a
palette seed from the name, an optional look line, an origin (regular, receiver, left-behind
passenger, staged, dock hand, visitor), a post, a label, a position, and one scripted behaviour.
They are a separate table, not actors. Why: an `Actor` flag would need some twenty loops (needs,
planner, perception, call aboard, door occupants, chat, roster, render) to skip them, and an actor
would carry needs, knowledge and skills that are lies; a separate table is excluded by
construction. The planner sees nothing of them. Props placed by a staging plan are presentation
records (`state.dockside.props`), never items, so nobody can eat or fit them.

### Local behaviour

`atPost` stands at the post and shuffles to a free neighbouring tile and back every
`travel.localShuffleSeconds` (8); `walkTo` walks to a tile and then stands; `leave` walks to an
exit and is gone on arrival, or at once if the way is blocked. Locals walk the crew's nav grid
and A* at `movement.walkSpeed` with every door impassable, so they never set foot aboard, and the
corridor-passing slowdown counts locals for the crew and crew for locals. Carried crates are
presentation (`Local.carrying`), never items, so custody stays one location per item.

### Locals come and go with the dock

The dock is dressed when it attaches (and at world creation; a restored save with an undressed
dock is dressed on its first tick) with the floor set plus the staging plan's people and props,
emitting `dockDressed` and, if the plan had a line, a notable `dockAmbience`. At the end of
`undocking` the locals and props go with it without walking, after any open dock-hand errand is
finished instantly. A person goes on their post's tile, else the nearest free floor tile, never
on a freight area, a ramp landing or another post. Departure never waits for a local: nothing
about them is cargo work or "ashore". Invariants: no local, prop or dressing without the dock
alongside, and every local on that dock's floor.

## The floor set

### Floor set rule

`floorSet` (`core/floor-set.ts`) lists who the sim puts on a dock by itself, pure over state and
content with no rng draw, so the staging hook can show the narrator exactly who will be there:
posted regulars at their posts; a receiver (dock hand) at the warehouse door for each freight job
bound here; a passenger left behind or put off here, on the bench. A dock hand's name is a hash
of the save's seed and the job into the content name table. One entry per name. A passenger due
back appears at the gate as an actor, not a local.

## Staging

### Staging plan command

`stageDock` is the kernel half of the staging call: a plan of up to three people (a port seed by
name, a cast member, or a new face with role and look) at posts of that dock with an optional
label, up to three props (catalogue items, 1 to 4 units, on the staging area or by a post) and
one ambience line. It is valid only while a `stageDock` hook is pending for the leg in flight and
the plan is unset (one plan per call). It is validated whole: posts exist on the dock, text is
non-blank with no control characters or template braces and within caps (`STAGING_LIMITS`), seeds
exist, nobody aboard is placed, no name twice. Any problem rejects the whole plan; the staging
translator drops bad parts first (§staging-prompt). `validateCommand` refuses it from the narrator
outside a pending `stageDock` hook (§staging-hook-and-the-hold) and refuses every other narrator
command while one is pending (`preconditionFailed`). Why: a staging-only vocabulary change is the
owner's ruling (D57).

### Staging plan dressing

The plan is added to the floor set: a placement naming someone already in it moves them to the
plan's post and label instead of adding a second. A plan sets the stage only: no card, no arc or
note changes. The ambience line reaches the ticker as a notable `dockAmbience`, never narrative.
With no plan (a failed or empty call, §staging-retries-and-the-floor-set) the dock is dressed with
the floor set alone.

## Dock hands

### Dock hand errands

Freight moves on foot (`systems/commerce/dock-hands.ts`). An offer's crates come out of the
warehouse door on a hand's trolley and are set on the staging area, the job being offered with no
crates until then; a withdrawn offer's crates are walked back in; a delivery's crates are taken
into the warehouse by the receiver (or a new hand) once every unload at the port is done and the
job is paid on the bay. Commerce dispatches and drives the errands, travel walks the locals.
Accepting an offer mid-walk stages its crates at once and the hand goes back in. A dock with no
warehouse-door post has no dock hands and the instant behaviour runs.

Dock hands never stall the game. An errand with no
route, or past `travel.dockHandGiveUpSeconds` (30), does its instant effect and emits
`dockHandGaveUp` (trace, reason `noRoute` or `timeout`); one still open when the dock is cast off
is finished the same way (reason `castOff`). The commerce invariant allows crates absent while a
hand brings them out and crates still on the dock while a hand fetches them back.

### Freight hand-off on the dock

Offered crates, loading and delivery to the bay are commerce's (§offered-freight,
§delivery-and-pay); on the dock, dock hands bring offered crates out of the warehouse and cart
delivered ones in (§dock-hand-errands). The hand truck's trips fetch it from wherever its pusher
believes it is, the dock included.

### Dock market and passengers

Buying parts on foot, at the stall or through the gate, is §buying-parts. Passengers come and go
through the gate: aboard as §passage-job says, and out through it when walking off. A walk
across a ramp still lowering waits.

## The captain ashore

### Looking for work

`lookForWork` is a personal activity the planner never chooses. Commerce hands it to the command
actor at essential-operation urgency, every tick until it starts, while docked at a port with a dock
map (never at a landing site), `captainIsIdleAt` holds (§offer-source), the personnel ramp is fully
down, and the actor is idle or passing the time (they finish what they are doing first). They walk
to the foot of the personnel ramp; on the tick they stand on dock floor `captainAshore` is raised,
once per docking (§captain-ashore-ask). If the captain stops being idle before stepping off (an
offer, a course) the walk is cancelled and the ask is not spent. On the dock the activity waits
(`awaitWord`) for the answer; if nothing is held for the captain it goes on to a look round: a dock
post, half the time out through the gate for `travel.gateVisitSeconds` (4), and back aboard. There
is no second ask. Why: the owner's ruling, "the captain should leave the ship to go look for work,
and [their] leaving the ship should trigger narration" (D57).

The captain out through the gate is still fit for command (`isFitForCommand`,
`core/command-actor.ts`), so going ashore never hands the ship or a card's perspective to the
first officer. This walk and the meeting walks (§meetings-and-visitors) are re-handed every tick
until they start, override routine work, and give way to anything at essential operation or above
and to the call aboard, as `comeAboard` does. An interrupted walk (a survival need, an emergency,
incapacity, the call aboard) just stops and is handed out again on the next free tick, to the first
officer if the captain is no longer fit. Log and headline: notable `lookingForWork`,
`talkingWith`, `wentToSee`, `cameToSee` (never narrative, so they neither wake `notableEvent` nor
reset the quiet timer), and trace `cardHeld`, `cardDelivered`.

### Offers in person

Offers are made in person at the dock (§offer-command-and-price-bands), and the digest says so
(§market-and-parts-lines). A passenger who walked over with their offer (or a local of that name)
becomes the passenger on acceptance: the local goes and the passenger boards from where they
stood, so the dock never has one person twice.

### Meetings and visitors

A card from one of the port's people is held (§holding-a-card) until the captain and the speaker
meet (§delivery). The meeting walks:

- Ashore, or on the way: `meetSpeaker` walks up beside the local on the dock and `talk`s for
  `travel.talkSeconds` (3) ("talking with Fenwick Adair"), and the card comes up at the
  `deliverCard` step; a speaker beyond the gate means out through it for `gateVisitSeconds`, the
  card coming up on the way back in. Then back aboard. The local walked to stands still for it.
- Aboard (a `quietTooLong` offer while docked): the speaker comes. A local on the dock walks to a
  free tile by the foot of the personnel ramp, or someone from the port walks in from the gate as
  a `visitor` local with the issuer's role (label "coming over to the ship"). The card comes up
  when they arrive; then a visitor goes back out and a local back to their post. A dock hand
  mid-errand finishes it first.

Nothing waits forever (§give-up-and-leaving, §stale-held-cards), and departure waits for a held
card (§departure-while-a-card-is-held). Meetings are plain state, so a save mid-walk finishes the
same way.
