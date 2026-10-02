# Passengers and the Galaxy

Status: proposal for the owner, 2026-10-01. Decisions taken from this doc get recorded in
`docs/DECISIONS.md`; this file stays as the design rationale. It builds on GDD §10 (ports),
§11 (jobs and economy) and the canon rule in GDD §7 ("if a passenger is secretly smuggling a
diamond, the diamond must actually exist in the simulation").

## 1. Why

Playtests show the narrator has one kind of pressure (faults) and one kind of forward motion
(freight). Episodes are a single hop long because every port is one hop from every other, with
legs of 25 to 70 seconds. There is nothing aboard that persists across hooks except the crew.

Passengers fix the second and third of those. A passenger is a character who is physically on
the ship for several legs, has a reason for the trip that the narrator knows and the captain
learns, and a built-in payoff when they get off. That is an episode by construction, in sim
state rather than in notes. The galaxy change is the precondition: a passenger needs somewhere
to go that is not the next port.

## 2. The galaxy

### 2.1 Shape

Grow from three ports to nine on a sparse graph. Two hubs with four or five links each, the rest
with two or three, two spur ports with one. Longest shortest-path is four hops. Every port is
reachable; no port is a dead end a passenger cannot leave.

```
            Halvard Reach ---- Ossory Station
                 |                   |
  Green Meridian -- Crossroads Hub -- Kessler Drift
        |               |                 |
   Tern's Rest     Saltmarsh Yard ---- Pell Anchorage
                        |
                   Vesper Gate
```

(Names are placeholders; the owner names the ports. Crossroads Hub and Saltmarsh Yard are the
hubs.)

### 2.2 Legs

Legs run one to three sim-minutes at nominal speed. The current `travel.nominalSpeed` and route
`distance` values scale; nothing else in the travel system changes. A two-hop trip is three to
five minutes of transit plus two dockings: long enough for a beat card in transit, a port
event, and a payoff, which is the minimum an episode needs.

### 2.3 Multi-hop destinations

Jobs and passengers may name a port more than one hop away. The sim stays single-hop: the
captain sets course one leg at a time. Three additions make far destinations work:

- **Route planning.** `shortestPath(from, to)` over the port graph, in the sim (pure, content
  only). The headline reads "Under way to Kessler Drift, next stop for Ossory Station".
- **Accept sets course to the first hop**, not the destination (today it sets the destination;
  with one-hop routes those were the same).
- **The captain may deviate.** Nothing forces the shortest path. A job or passenger has a
  destination, not a route; "the long way round is safer" is a real choice, and the narrator
  can see from the digest whether the ship is on the direct route.

### 2.4 Port character

Each port gets two or three sentences of character in content (`description` exists; add
`character`: what kind of people are here, what they want, what the place is known for) and a
few named recurring locals in the narrator's cast seed. Markets differ by port (D47). The
narrator's capabilities block lists the graph, so distances and detours are facts it can use.

### 2.5 What this is not

Not a living galaxy (GDD §10, §24). Ports are structured state and narrative continuity. No
off-ship maps. No factions yet, though port character is where factions would attach later.

## 3. Passengers

### 3.1 The model

A passenger is an `Actor` with `crew: false` (already supported, W0 decision) plus a
`passage` record in state:

```
Passage {
  id, actorId, issuerPerson (name, role, org?), pitch,
  originPortId,
  itinerary: Stop[],        // ordered; each { portId, dwellSeconds, purpose }
  stopIndex,                // which stop is next
  status: offered | aboard | ashore | completed | abandoned,
  fare: { onBoarding, perStop, onCompletion },   // credits
  paidTransactionIds[],
  cabinMachineId?,          // the bunk they were assigned
  boardedTick?, completedTick?
}
```

An itinerary of one stop is a simple fare: board here, get off there. The interesting one is
`[X (dwell), origin]`: go somewhere, do something, come home. That is the shape the owner asked
for, and the dwell is where the narrator puts the middle of the episode.

### 3.2 Aboard

While aboard a passenger:

- occupies a bunk (the deck has eight bunks for eight crew; see decision 8.1),
- eats and sleeps through the existing needs system, so galley stock matters,
- walks the deck like anyone else and is visible on it,
- never plans work, but can be the subject of a `partsNeeded`-style problem later (illness),
- appears in the digest's Crew section under a "Passengers" line with their purpose, mood and
  where they are, and in the capabilities block as a person the narrator may write.

### 3.3 Ashore

At a dwell stop the passenger leaves the ship (despawns to "ashore at port X, back in N
seconds"), the ship waits or does not, and the passage records it. If the ship leaves before
the dwell ends the passenger is left behind: status `abandoned`, remaining fare forfeited, the
narrator told. A passenger who is ashore when the ship departs is the one way a captain can
fail a passage, and it is a decision card ("Wait for Halla, or go").

### 3.4 Money

Fare is paid in stages so leaving early costs something visible:

| Stage | Share | When |
|---|---|---|
| Boarding | 25% | the passenger steps aboard |
| Each stop reached | split of 50% | docked at the stop |
| Completion | 25% | docked at the last stop with the passenger aboard |

Pay follows D24: never on a card. The fare total is derived from hops and dwell by the same
`payFor`-style function jobs use, with a narrator `payTier` lever as for jobs.

### 3.5 Boarding and leaving

Boarding happens while docked at the origin: the passenger spawns at the personnel ramp and
walks to their bunk. Getting off: at the final stop, they walk to the ramp and despawn. Both
emit narrative events (`passengerBoarded`, `passengerAshore`, `passengerLeft`,
`passengerAbandoned`) and the first two of those raise narrator hooks, since each is the start
of a beat.

## 4. Narrator levers

One new intent, mirroring `offerJob`:

```
offerPassage {
  issuerName, issuerRole, issuerOrg?, pitch,           // the passenger, in their own voice
  fromPort, itinerary: [{ port, dwell: none|short|long, purpose }],
  payTier, urgency, surface
}
```

- `purpose` is one line the narrator writes ("a sister's funeral", "selling a claim"). It is
  what the captain is told; the truth can differ in the narrator's notes (GDD §11's passenger
  who refuses to name their destination is `itinerary` with a single stop whose `port` the
  narrator reveals at departure: supported by letting the first stop be `"undisclosed"` and a
  follow-up `revealDestination` command at departure; proposed as a second step, see §7).
- The translator validates ports and path reachability, clamps dwell to config seconds, and
  computes the fare. Like jobs, the offer becomes a card when `surface` is set and otherwise
  sits on the board.
- The passenger joins the narrator's cast automatically with `aboard: true`.

Existing levers already compose: `surfaceDecision` with the passenger as speaker is how the
middle of the episode is told; beat cards (D39) are their foreboding; `spawnAtBoundary` puts
their luggage in the hold if it needs to exist (the diamond rule); `scheduleFault` is the
complication on the way.

What the narrator must not do (prompt rules): decide a passenger's fate (illness, death,
leaving) by narration. Those are sim events it can only set up once levers exist for them.

## 5. The crew

Passengers are a social fact. Two cheap mechanisms make them one in the sim:

- **Ambient conversation** already exists (`lastConversationTick`). Passengers join it; the
  ticker shows "Halla Thorne and Bettina Solheim talked in the galley".
- **Opinion.** Each crew member gets a one-line narrator-written opinion of each passenger,
  kept in notes (not sim state), and the prompt asks the crew's voices to carry it. Mood
  effects on crew from passengers are deferred; nothing in the sim has to change for the
  narrator to make Sunniva distrust a passenger who is "not tied down".

## 6. Cards this produces

The same card grammar as today (D29), with new true things to say:

- **Offer**: the passenger pitches the captain at the ramp. Sides: "Welcome aboard." / "Not
  this trip."
- **In transit beat**: the passenger finds the captain. A beat card, attitude recorded.
- **Dwell**: "Halla's not back and we're loaded. Wait, or go?" Sides carry real consequences:
  waiting costs time (jobs expire), going forfeits the fare and the person.
- **Crew friction**: the first officer or the cook brings an observation about the passenger.
- **Payoff**: at the last stop, the passenger's last word; what the captain learns.

Each of these is grounded in state the digest shows, which is the test every card has to pass
since D47.

## 7. Phasing

1. **Galaxy** (no passenger code): nine ports, sparse routes, port character, multi-hop
   destinations with route planning and first-hop course setting, capabilities list the graph.
   Jobs get longer immediately; this alone lengthens episodes.
2. **Passengers v1**: the `Passage` model, boarding and leaving, bunks, fares, the
   `offerPassage` intent, digest and capability lines, the four events and their hooks, the
   dwell-abandon decision. Itineraries fully disclosed.
3. **Passengers v2** (after a playtest): undisclosed destinations, luggage, a passenger
   condition lever (illness) once crew incidents exist, opinions in sim mood.

Phase 1 is a day; phase 2 is two to three. Each phase is deployed and playtested on its own.

## 8. Decisions for the owner

1. **Bunks.** Eight bunks, eight crew. Options: add two passenger cabins to the deck (content
   only, recommended), or let a passenger take a crew bunk and make the displaced crew member's
   fatigue a story. Recommendation: cabins now, bunk-sharing later as a lever.
2. **Can a passenger die or leave mid-trip?** Deferred to v2; v1 passengers ride, eat, talk,
   pay and get off.
3. **Does a passenger compete with cargo for the route?** Yes, by construction: the captain
   chooses each hop, and a job and a passage may want different next ports. Nothing in the sim
   arbitrates; it is a captain decision and that is the point. Confirm.
4. **Passengers on the board offline.** The null narrator offers jobs; should it offer passages
   too? Recommendation: no. Passages are story; the test path can create them by command.
5. **Port names and the graph** in §2.1 are placeholders for the owner to rename and reshape.
6. **Leg length.** One to three minutes at 1x is the proposal; the speed controls (2x to 8x)
   remain. If that feels slow in play, the knob is `nominalSpeed`, not the graph.
7. **Fare split** in §3.4, and whether a forfeited fare should be partly refunded by the
   narrator as a story choice (it has no money lever and should not; the sim's rule stands).

## 9. Testing

Unit: route planning, fare computation and staging, boarding/leaving/abandon transitions,
bunk assignment, translator validation of itineraries, digest and capability lines. Kernel
integration: a full passage over two hops with a dwell, money and events asserted. Live suite:
one `jobBoard` call on a fixture where a passenger fits, asserting an `offerPassage` or a
rationale that explains the choice.
