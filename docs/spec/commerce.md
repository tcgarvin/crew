# Commerce

Jobs and offers, passages, pay, port markets and buying, and the ship's reserves. Config is
`commerce.*` in `packages/content/data/config/default.json`; code in
`packages/sim/src/systems/commerce/` (`jobs`, `passage`, `market`, `reserve`, `tasks`). One
per-tick pass (`commerce.ts`) runs after travel: passages, the job sweep, the captain ashore, the
reserves.

## Jobs and offers

### Offer source

The narrator is the only source of work (D40): commerce never creates a job on its own. The
`captainAshore` hook asks for an offer (§looking-for-work, §captain-ashore-ask); offline, the null
narrator answers with one templated offer through the same translator
(§no-offline-narrator-for-players). The ask is only
raised when the captain has nothing on at the port (`captainIsIdleAt`, `travel/hooks.ts`): no
offer open at the port, no job in hand, no passenger walking off, no job decision queued or held,
no course planned or voyage under way (a waypoint is not a port to look for work at), and no
offer from this port declined or expired within `commerce.reofferDays` (0.075).

### Issuers and pitches

Every `offerJob` carries an `issuer` person (name, role, optional organisation) and a `pitch` line
of dialogue; there are no companies. Issuers join the narrator's cast so they recur
(§narrator-notes). Pay is never on the card (§cards-never-mention-pay).

### Offer command and price bands

`offerJob` is rejected unless its pay sits inside the price band, inclusive:

- Freight: `commerce.priceBands[cargoClass]` `min`..`max` credits per unit per unit of path
  distance, times total units. All lines share one cargo class; distance is the shortest route
  between the two ports, so any reachable port may be named and a two-hop haul pays for two legs.
- Passage: see §passage-fare.

A freight job is clamped to `commerce.maxCratesPerJob` (6) units, dropping from the last line and
scaling pay by the same ratio. An offer expires `commerce.jobOfferTtlDays` (0.5) after it is made
(`jobExpired`). Offers are made in person at the dock: a surfaced offer (one that raises a card) is
refused unless the ship is docked at its origin, and the translator drops one in flight; its card
is held until the captain meets the issuer (§holding-a-card). A quiet offer may be posted anywhere,
for scenarios.

### Offer card

"Take the job" carries `acceptContract` then `setCourse` to the destination; "Pass" carries
`declineJob`. Accepting with freight still to load plans the course and stays docked with the ramp
open; travel departs once the last `cargoToLoad`/`cargoToUnload` problem is resolved.

### One job in hand

The kernel allows one job at a time (`jobBlockingAcceptance`, `travel/in-hand.ts`). `acceptContract`
is rejected while another job is in hand: accepted and not yet left; freight in transit anywhere
but its destination; or a passage with a port still to reach. A job being finished at this very
port (freight unloading at its destination, a passenger walking off) does not block. Why: an offer
carded on the first docked tick would otherwise deadlock behind its own card.

The translator drops an `offerJob` by the same rule (§offer-lever); hooks ask for one offer, and
none while a job is in hand or at a waypoint. A live passage limits `setCourse` to detours
(§voyages).

## Freight on the dock

### Offered freight

At a port with a dock map, an offer's crates (one per unit, `Job.cargoItemIds`) are set out on the
origin dock's staging area while that dock is alongside (`docking` or `docked`) and the offer is
still `offered`: at `offerJob` when docked there, else on the tick the dock comes alongside. The
crates are nobody's: no `cargoToLoad` exists, so no crew member touches them, equipment does not
count them as parts aboard, and the render frame marks them `offered`. A declined, expired or
departed-from offer has its crates withdrawn (`freightWithdrawn`). Dock hands do the carting
(§dock-hand-errands). `commerceViolations` (`invariants.ts`) holds the rule for tests. A port with
no dock map keeps the store and the cargo transfer tiles.

### Loading

Accepting opens `cargoToLoad` for the crates already on the dock and tells every crew member where
they lie, except those still owed their first look (their familiarity brief covers it). Loading is
an ordinary pickup down the cargo ramp, one crate per trip. Cargo work includes freight of a job
taken here that still lies on the dock: it holds a docked departure and keeps prep's ramps down.

### Delivery and pay

At the destination with its dock alongside, `cargoToUnload` is a haul to the delivery bay, each
crate aiming at its own bay tile first; the job is delivered when every crate is in the bay or the
port's store (`deliveryComplete`). Once the unload work is done commerce pays once
(`contractCompleted`, `paymentMade`, a `jobPayment` transaction, guarded by
`paymentTransactionId`), then dock hands cart the crates into the warehouse store
(§dock-hand-errands, `cargoTransferred`), whenever a dock is alongside, not only while `docked`.

## Passages

### Passage job

A passage is a job with a person in it (D50): `Job.passage` plus `passenger` and `roundTrip` on
`offerJob` (`roundTrip` without `passenger` is rejected). The issuer is the passenger; the
`description` is their stated purpose, which may differ from the truth in the narrator's notes.
Luggage is the job's cargo, zero or one line of one unit, hauled like freight. Two shapes only:
one-way and there-and-back. A passage is the job in hand, so a passenger competes with freight for
the ship.

Accepting spawns the passenger from the `crew.passenger` template, with the issuer's name. They
are `crew` (needs, movement, bunks, galley, conversation and perception work) and `passenger`
(no tasks, posts, bridge staffing or market). A passenger who was a dock local is that person,
not a second one. There are no cabins. Boarding is `passengerBoarded` at booking. With a dock
alongside they appear at the gate and walk aboard (`comeAboard`), waiting for a ramp still
lowering.

### Passage fare

One fare, paid on completion: `commerce.priceBands.passenger` (6..12) credits per unit of path
distance, doubled for a round trip; luggage adds nothing. The band clears the docking fees of a
long trip but a short hop is deliberately thin. Why: passengers should pay when they go far.

### Passage legs

On a one-way passage the passenger walks off at the destination and the passage ends `completed`
and is paid. On a round trip they go ashore at the far port (`availability: offShip`, held in the
port's lounge store, `passengerAshore`), the voyage home is planned at once, and departure waits
for them ("Waiting for <name>"). They return at a tick drawn from
`commerce.passage.ashoreDaysMin..ashoreDaysMax` (0.05..0.15) on the `commerce` RNG stream
(`passengerReturned`, the only passenger event in the default `hookOnEvents`), walk aboard, and
walk off at the origin: `completed`, paid. Luggage on a round trip is unloaded at the far port and
does not return.

### Passenger overdue

Not back `commerce.passage.overdueDays` (0.1) after going ashore, the kernel queues one policy
decision, `commerce.passengerOverdue`, brought by the first officer: "Wait for them" or "Leave
without them". A due return waits while that card is unanswered, since no decision can be
withdrawn. Names carry no pronouns, so cards say "them".

### Ending a passage early

`endPassage { jobId }` ends a passage with no fare, in two ways:

- `leftBehind`: the passenger is ashore (the overdue card's "leave"). They stay at that port as an
  off-ship actor, the narrator's to use as cast; the voyage home is kept.
- `putOff`: the card-side effect (§end-passage-effect) puts an aboard passenger off at the next
  docking (now, if docked). The voyage, and the course when docked, is cancelled (not for an
errand's captive, §settling-the-errand); luggage is
  unloaded where they leave and holds the ship until it is on the dock.

Either way the passenger leaves the roster and the digest's Aboard line and appears in the
narrator's people section at that port. The narrator never decides a passenger's fate and never
narrates what they did ashore as fact; the null narrator never offers passages. Events:
`passageEnded {reason}`.

## Errands

### Errand job

An errand is a job to a landing site (§landing-sites) to bring something back: `Job.errand`
(`kind`, `siteId`, `targetName`, `itemDefId`, `wants`, `returnToPortId`, and `outcome` once
settled). Two kinds: `fetchPerson` (bring back the named person, `wants` `alive`, `either` or
`dead`; `dead` is a kill job) and `fetchItem` (bring back the named item, which always wants
`either`). It is offered through `offerJob` with an `errand` draft
(`systems/commerce/command-handlers.ts` `errandProblem`), refused unless it comes back where it
starts (`toPortId` is `fromPortId`, which is `returnToPortId`), the site is an authored site whose
near port the origin reaches, it names its target in at most `STAGING_LIMITS.nameChars`
characters (the name goes on a cast entry), it names an existing item exactly when it fetches one,
it carries no cargo and nobody rides on it, and its pay is in the errand band (§errand-pay).

The offer card reads "Bring back Corran Vale from the Boathouse, alive" ("alive or dead" for
`either`), or "Fetch <item> from <site>", titled "A job: <target>". Its accept side runs
`acceptContract` then `setCourse` to the site (§known-sites), so the ship flies there through the
near port as a voyage; the site stays known for the whole episode. One job in hand holds as for
any job (§one-job-in-hand). The null narrator never offers an errand; only the narrator and
scenario commands do.

### Errand pay

`commerce.priceBands.errand` (6..12) credits per unit of path distance out to the site and back,
both measured on the graph with every authored site added (`checkErrandBand`, `errandPay` in
`systems/commerce/errand.ts`, shared with the translator so the two cannot drift); the offer's pay
tier picks a point inside it. Paid once, by how it was settled (§settling-the-errand): a captive
as a passage (they walk off at the return port, `completed`, `contractCompleted` and `paymentMade`
once); a target brought dead when the ship docks at the return port; a fetched item as freight,
once delivered to that port's bay or store. A failed errand is never paid. Why the band: an errand
to the nearest site pays about one and a half plain freight jobs after its three dockings' fees.

## Port markets

### Market stock

A port's market is content (`PortDef.market`: item, count, per-unit price); live stock and prices
are in `state.markets[portId]`, seeded from content at world creation and on first write. The
narrator's `stockMarket` lever sets a line (`marketStocked`, §market-lever).

### Buying parts

A repair short of a part or tool raises `partsNeeded` (§parts-and-tools-needed). While docked at a
port whose market has the item and the ship can pay for at least one unit, commerce derives one
`buyParts` task (`buySpec`, `tasks.ts`); any crew member may take it, no skill or tool. It is not a
captain decision. If the market lacks the item or money is short the problem stays open and the
digest says why (`marketBlock`: `notDocked`, `notSoldHere`, `cannotAfford`).

The buyer walks to the market counter (`marketCounter`, `core/docks.ts`: the floor tile the stall
post faces, leaving the post tile for its local) and spends
`commerce.market.buySeconds` (3) there. The `buy` step (`buyFromMarket`, `market.ts`) commits: up
to the wanted count that stock and money allow; the balance drops (a `purchase` transaction); the
market count drops; every crew member is told where the units are; `partsBought` is emitted; and
the matching `partsNeeded` or `reserveLow` problem is resolved, or its count reduced and revision
bumped so the task re-derives for the rest.

- With a dock stall, the units go into the buyer's hands at the stall's counter tile and they carry
  them up to the top of the cargo ramp (`stowBought`); the task ends when they are set down, so a
  claimed `buyParts` task outlives its resolved problem.
- With no stall the buyer walks to the gate and steps through (`throughGate`, off ship, in the
  port's market store, for `buySeconds`), then returns and carries the units aboard. Travel counts
  them ashore; an overdue call, or the dock's last-guard clear, ends the errand at the gate.
- With no dock alongside, the buyer goes to a cargo transfer tile and the units land at their feet.

## Reserves

### Reserve low problem

Commerce keeps the ship's stores through one routine problem, `reserveLow {itemDefId, count}`,
raised only while docked at a port whose market has the item in stock, and revised against what is
aboard every tick (`sweepReserves`, `reserve.ts`). It resolves when nothing is left to buy here:
stores up, market sold out, or the ship gone. It derives the same `buyParts` task as
`partsNeeded`. A restock never holds a departure; the next port that sells the item asks again.
Underway, or where nothing is for sale, the crew can do nothing, so there is no problem.

### Reserve kinds

- Provisions: counted in days of meals, a crate a meal (§galley-provisions). Under
  `galley.lowBelowDays` (2) the crew buy up to `galley.restockToDays` (5); `lowBelowDays` 0 turns
  it off. Bought only where a market stocks a `provisions` item; every port market lists them.
- Food (rations, any `food` without a `meal`): days of hunger, nutrition aboard over eaters (crew
  and passengers) times `needs.hungerPerDay`. Under `commerce.foodReserve.lowBelowDays` (1) the
  crew buy up to `restockToDays` (2). Why: one number for provisions and rations would let a hold
  of rations hide an empty pantry.
- Spares: each `spare`-tagged item the market sells is kept at `commerce.sparesReserve` (3)
  units. A repair short of a part right now is `partsNeeded`, bought on top of this.
- Patch kits: with fewer `patchKit` items aboard than the scenario's `startingItems` stocked, the
  difference is asked of the first market that sells one.
