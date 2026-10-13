# Travel

Ports and routes, voyages, the travel stages, departure prep and the departure gate, and course
plotting. Config is `travel.*` and `hazards.*` in `packages/content/data/config/default.json`; code
is `packages/sim/src/systems/travel/`. The dock itself and its people are in `dockside.md`.

## Ports and routes

### Port graph

Six ports, and four landing sites that no port lists (§landing-sites, §known-sites): a core
triangle (Crossroads Hub, Kessler Drift, Green Meridian) and three far spurs
(Ossory Station off Kessler Drift, Vesper Gate off Green Meridian, Tern's Rest off the Hub). The
sites are the Boathouse off Tern's Rest, Harrow End off Green Meridian, the Lazaret off Vesper
Gate and the Boneyard off Ossory Station, each one route of 20 from its near port. Port
files are `packages/content/data/ports/*.json`; the legs there are the truth (the triangle's are
25, 45 and 70, each spur's 400). Routes are listed on both ends with equal distance, and the
loader checks it. Every port has a `character` and a `castSeed` for the narrator, a market of its
own and a lounge store where passengers ashore wait. Why: nine ports were rejected as more
content and continuity for no new kind of story.

`shortestPath` (`graph.ts`) is Dijkstra by route distance, ties broken by port key order, so a
route is deterministic for a content bundle.

### Known sites

A site's one authored route runs to its near port, and no port lists it back, so the graph the
ship flies is `portGraph(content, state, "known")` (`core/places.ts`): the authored ports with an
extra route from each near port to each known site, at the site's own distance. A site is known
(`knownSites`) while an errand names it with status `offered`, `accepted` or `inTransit`, and
while the ship is docked at it or heading for it (`travel.portId`, `toPortId`,
`voyageDestinationId`, `plannedDestinationId`). `setCourse`, voyage hops, `beginDeparture` and
the leg into transit all route on it, so a course to a site is a voyage through its near port
(D49) and the last leg has the authored distance. The errand price check measures on `"all"`,
every authored site added (§errand-pay). Freight and passage pay still measure on the authored
ports alone, so neither can name a site. Why `offered` counts: the offer card's accept side runs
`acceptContract` and `setCourse` to the site, and both are validated before either applies, while
the job is still offered.

At a site there is no docking fee and no staging call (`stageDockIfDue` skips one and
`stagingAnswered` reads true); lift-off clears the floor with no store, so anything left there is
gone (`leftOnDock`). A site's cast are not crew: departure prep never calls or carries them
aboard (`peopleAshore` and `clearDock` count crew only).

## Voyages and stages

### Travel stages

`docked -> preparingDeparture -> undocking -> departing -> transit -> approaching -> docking ->
docked`, run by `travel.ts`. Each stage but `transit` is a timer (`travel.prepareDepartureSeconds`
5, `undockSeconds` 4, `departSeconds` 5, `approachSeconds` 8, `dockSeconds` 5). Transit advances
route progress at `travel.nominalSpeed` times the mean output of the engines wanted on; no engines
in the content means unconstrained. Docking charges `commerce.dockingFee` and emits `arrived`.
`approaching` and `docking` hold in place until the helm is manned, and so does the end of transit
(§helm-vacancy). The dock is alongside from the start of `docking` to the end of `undocking`
(§dock-alongside).

### Voyages

A course or job may name any reachable port. `travel.voyageDestinationId` holds the far end;
`plannedDestinationId` is the next hop on the shortest path. Intermediate stops are real dockings
(fee, ramps, market, the usual `approachingPort`), and the ship continues on its own once nothing
holds it: no cargo work, no `buyParts` it could run here, no hold for repairs, no pending card, no
waiting passenger. `jobBoard` is not asked at a waypoint. Every hop is plotted at its waypoint
(§course-plotting). A voyage whose destination becomes unreachable is dropped.

A `setCourse` to a neighbour during a voyage is a detour: the voyage stays and the sim routes on
from wherever the ship docks. A far `setCourse` is refused when a live passage is bound elsewhere
(only a detour to a neighbour is allowed). Freight pay uses path distance. Headlines read "Under
way to Kessler Drift, bound for Ossory Station" and "Stopping at Kessler Drift on the way to
Ossory Station". Why: the captain choosing every leg was rejected; it costs a narrator call and a
card per waypoint, and the captain acts only through cards (D14).

### Limping under way

With every engine impaired beyond repair aboard, the ship limps rather than drifts (§limping).
`driftingChanged` fires when the ship starts or stops drifting.

## Departure

### Departure preconditions

A planned course starts `preparingDeparture` the first tick none of these holds: open freight work
(loading or unloading, or accepted freight still lying on the dock), a round-trip passenger ashore
or one walking off, a card held for delivery in person, an unplotted course (§course-plotting) or an
unanswered departure gate (§departure-gate). Prep then waits for someone at the helm, for everyone
to be aboard, and for the ramps to be up before it ends. A course set with nothing holding the ship
enters prep straight from `setCourse`.

### Calling the crew aboard

Prep keeps the ramps down while anyone is on the dock, walking onto it, or out through the gate on
a market errand, and while freight is still being loaded with a dock alongside. Its clock does not
run while anyone is out. Everyone out is called aboard with `comeAboard`, a personal activity the
planner never chooses: a walk at essential-operation urgency to the top of the nearest ramp. The
call waits while loading is open, since the loaders are out fetching freight. A passenger walking
off is never called back. The headline reads "Waiting for <name> to come aboard", or "raising the
ramps" if the clock has run out with a ramp still moving.

A departure is never held forever, and never silently. Someone on the dock who cannot walk back
(unavailable, not crew, or their walk failed) is brought up the ramp by the dock crew at once, and
everyone still out is once the call has run `travel.recallAboardSeconds` (60); both emit
`broughtAboard`, shown on the ticker. What is still on the dock at cast-off is §ramps-and-cast-off.
`ashore.ts` holds all of this.

### Departure gate

A planned departure with an impaired engine or generator raises one policy decision, "Hold for
repairs" / "Leave anyway", spoken by the engineer. A machine is impaired when it is blocked, has an
unrepaired `derate` or `inoperable` fault, or is wanted on with output below
`travel.departureMinOutput` (0.5). Symptoms, warm panels and moderate integrity never count
alone. Why: owner, "careful that we don't bother the player every time a single system isn't
100%".

- Hold (`holdDepartureForRepairs`, `departureHeld`) returns a ship in prep to `docked` with the
  course and its plot kept and the ramps open, so the crew can reach the market. It departs on its
  own once nothing is impaired (`departureHoldLifted`).
- Leave anyway (`acceptDepartureRisk`, `departureRiskAccepted`) is remembered with the impairment
  it answered (`acceptedImpairmentKey`) and carried through the whole voyage. It is asked again
  only when that set changes; a new fault or a repair does, and a machine that stops being
  impaired drops out.
- Only one gate card is queued at a time. `departureRiskAccepted` and `departureHoldLifted` are in
  the default `hookOnEvents`.

The key (`impairmentKey`) names each impaired machine with every fault on it
(`machineId:faultA+faultB`), not why it counts as impaired this tick. Why: a machine hovering at
its temperature limit flips between blocked and low-output every few ticks, and a key following
the reason raised the card again each time.

### Repairs out of reach

The gate never waits on a repair the ship cannot do; what makes an impairment out of reach is
§impairments-out-of-reach. The card is raised for the worst impairment in reach. With none in reach
there is nothing to choose: no card, the departure goes ahead, any hold ends, and
`departureRepairOutOfReach` (narrative, in the default `hookOnEvents`) says why per fault, for
example "No welder torch aboard and none to be had at Kessler Drift: leaving with the fusion
generator's electrical short unrepaired". It is remembered as "leave anyway" is, so it is said once.
A hold whose last in-reach repair becomes impossible ends the same way. An undiagnosed fault is
still work aboard, so the gate waits for the diagnosis before judging. Why: releasing every hold
after a timeout would cut real repairs short, and a card with only "leave" would bother the player
with no choice.

A repair short only of tools and parts is a `partsNeeded` (§parts-and-tools-needed): the crew buy
it where a port sells it, and a voyage waits at such a waypoint for the purchase.

## Plotting a course

### Course plotting

Every `setCourse` and every voyage hop leaves the course unplotted. While a nav terminal (a
machine tagged `navStation`) is aboard, `courseSystem` raises `courseToPlot` for the planned
destination, deriving one essential `plotCourse` task at the nav station that needs the helm's
`operatorSkill`. The work takes `watches.plotCourseSeconds` (20), shortened by skill above the
minimum: skill sets how long it takes, not how good. An interrupted plot starts again. Departure
prep waits for the plot beside the departure gate. A detour re-raises it; a hold for repairs keeps
it. The plot sets `travel.coursePlotted` and emits `coursePlotted`. A ship with no nav terminal
needs no plot. While the terminal is blocked (§output-and-blocking; in play, a `chart_fault`,
§authored-faults) nothing is plotted: the plan is blocked and a plot under way fails, both
`dependencyPending`, so the task backs off and the ship waits docked until the terminal is
repaired. The chart fault's repair spends no part, so it is always in reach.

## Navigation hazards

### Debris fields and ion storms

The narrator's `scheduleHazard` lever (§hazard-and-field-levers) places an instant hazard, kind
`debrisField` or `ionStorm`, with a difficulty tier and a fault window, and spends the hazard
budget. It needs a leg with transit still ahead and fires at the first transit tick at or after
its time (`systems/travel/hazards.ts`), as a piloting check at the helm (§hazard-roll). A hazard
whose leg ends first, or whose course is given up in port, is dropped with `navHazardMissed` and
never carried to the next leg. The asteroid field is §the-asteroid-field.
