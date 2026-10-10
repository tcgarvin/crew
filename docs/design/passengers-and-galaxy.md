# Passengers and the Galaxy

Status: proposal for the owner, 2026-10-01, revised the same day by a second design partner.
Each substantive change from the first draft is marked "(revised: reason)" so the owner can see
what moved. Behaviour taken from this doc goes into `docs/spec/` and real decisions into
`docs/DECISIONS.md`; this file stays as the design rationale. It builds on GDD §10 (ports), §11
(jobs and economy) and the canon rule in GDD §7 ("if a passenger is secretly smuggling a diamond,
the diamond must actually exist in the simulation").

## 1. Why

Playtests show the narrator has one kind of pressure (faults) and one kind of forward motion
(freight). Episodes are a single hop long because every port is one hop from every other, with
legs of 25 to 70 seconds plus about 27 seconds of departure and docking stages. There is nothing
aboard that persists across hooks except the crew.

Passengers fix the second and third of those. A passenger is a character who is physically on
the ship for several legs, has a reason for the trip that the narrator knows and the captain
learns, and a built-in payoff when they get off. That is an episode by construction, in sim
state rather than in notes. The galaxy change is the precondition: a passenger needs somewhere
to go that is not the next port.

**What a passenger gives the narrator that a cast entry cannot** (revised: the first draft did
not say, and it decides how much passenger to build). A cast entry in notes can pitch, recur and
be remembered, but it lives on a port. A passenger adds exactly four things, and v1 builds only
what serves them:

1. **Presence.** They walk the deck, eat, sleep and turn up in ambient conversation, so the sim
   produces true small facts about them ("Halla Thorne and Bettina Solheim talked in the
   galley") that the narrator can build on without inventing them.
2. **A sim-kept timeline.** Out, ashore, back. Each step is a state change and a natural beat;
   the narrator does not have to remember where the story is.
3. **Captain choices with consequences.** Take them, put them off, wait for them or leave them.
4. **A payoff the sim delivers.** The passage completes or fails as a sim event.

## 2. The galaxy

### 2.1 Shape

(revised: six ports, not nine. Nine ports triple the authored content (character, cast seeds,
markets) and the continuity the narrator has to hold, for no story the six do not already give.
GDD §24 and §27 favour depth over breadth. A passenger only needs a few places that are more
than one hop away, and those are best when they are clearly *out there*.)

Keep today's three ports as a fully connected **core** with today's short legs. Add three
**far ports**, each a spur off one core port, on long legs. Longest shortest-path is three hops.

```
   Ossory Station                         Vesper Gate
        | 120                                  | 120
   Kessler Drift ---------- 70 ---------- Green Meridian
            \ 25                           45 /
             \------- Crossroads Hub --------/
                            | 90
                       Tern's Rest
```

(New port names are placeholders. Numbers are route `distance`.) From the hub every far port is one or two hops; far port to far port is three. Routine freight
stays in the core and stays quick. The far ports are where passengers want to go, and getting
there takes a long leg, which is where shipboard life and in-transit beats live.

### 2.2 Legs and what an episode costs

(revised: the first draft proposed one to three minutes on every leg. That makes routine freight
slower at 1x, which pushes players further toward 8x, and at 4x and above episode length is set
by narrator calls, not by leg length; see the table.)

Core legs keep their distances (25 to 70). Far legs are 90 to 120. `nominalSpeed` is unchanged.

A there-and-back passage from the hub to Ossory (hub, Kessler, Ossory, Kessler, hub) is about
290 s of transit, 110 s of stages, 90 s ashore and 40 s of boarding and layovers: about nine
sim-minutes, with roughly eight narrator calls (offer, four arrivals, one or two quiet
check-ins, the return from ashore, completion). Each call takes about 25 s; the run-ahead lead
(60 sim-s) hides that at 1x and 2x and not above.

| Speed | Sim time | Narrator stall (about 8 calls) | Wall time |
|---|---|---|---|
| 1x | 9 min | none | 9 min |
| 2x | 4.5 min | none | 4.5 min |
| 4x | 2.2 min | about 10 s each | 3.5 min |
| 8x | 1.1 min | about 17 s each | 3.4 min |

Two consequences the build has to respect:

- **Episode length is counted in beats, not seconds.** Above 4x the narrator is the clock.
  More stops give more beats; longer legs mostly give more quiet check-ins.
- **The narrator budget is the real limit.** The default cap is 6 calls per game per rolling
  hour (`CREW_NARRATOR_MAX_CALLS_PER_HOUR`); one passage uses it up. See decision 6.

### 2.3 Multi-hop destinations: voyages

Jobs and passengers may name any reachable port. The sim keeps the travel system single-hop and
adds a **voyage destination** above it.

(revised: the first draft had the captain set course one leg at a time. The captain has no
course control outside cards (player input only at hooks, D14), so that means a narrator call
and a card at every intermediate port, spending the one card per call on "which way now" and
crowding out the story. Route choice is not a captain-level decision unless something makes it
one, and when something does, the narrator already has a lever for it.)

- **`travel.voyageDestinationId`** (optional, alongside the existing `plannedDestinationId`).
  Accepting a job or passage to a port beyond one hop sets it; `plannedDestinationId` is the
  next hop on `shortestPath(here, voyage)` (pure, content only, by distance).
- **Intermediate stops are real dockings.** The fee is charged, ramps open, the market is open,
  `approachingPort` fires as today. The ship continues to the next hop on its own when nothing
  holds it: no cargo work, no `buyParts` task that can run here (revised: otherwise a stalled
  repair could not buy parts at a waypoint, §buying-parts), no departure hold, no pending card.
- **Detours use the existing lever.** A card side with `setCourse` to a neighbouring port while
  a voyage is set is a detour: the voyage destination stays and the sim routes on from wherever
  the ship ends up. "The long way round is safer" is a narrator card, not a sim prompt.
- **The departure gate is asked once per voyage, not per docking** (revised: with
auto-continue a degraded engine would raise the departure gate's card (§departure-gate) at every
waypoint). "Leave anyway" persists until the voyage ends or the impairment changes (a new fault, or
  a repair).
- **Headline:** "Under way to Kessler Drift, bound for Ossory Station"; docked at a waypoint,
  "Stopping at Kessler Drift on the way to Ossory Station".
- **Pay** for freight and fares uses path distance (sum of legs) in the existing price band
  check, which today requires a direct route.

### 2.4 Port character

Each port gets two or three sentences of character in content (`description` exists; add
`character`: what kind of people are here, what they want, what the place is known for) and a
few named recurring locals in the narrator's cast seed. Markets differ by port (§market-stock). The
capabilities block lists the graph with leg lengths and hop counts from the current port, so
distances and detours are facts the narrator can use.

Not a living galaxy (GDD §10, §24): no off-ship maps, no factions yet, though port character
is where factions would attach later.

## 3. Passengers

### 3.1 The model: a passage is a job with a person in it

(revised: the first draft made a `Passage` entity beside jobs, with an itinerary array, staged
fares, its own status machine and a cabin. Almost all of that already exists on `Job`: issuer
person, pitch, description, from and to ports, urgency, pay in a price band, offer card, accept
and decline, expiry, delivery check, one payment, `contractCompleted`. SD §17.3 already says
jobs record "manifest/passengers". A second entity would duplicate the lifecycle, the offer
card path, the digest's Jobs section and the one-job rule, §one-job-in-hand.)

```
Job (existing) + {
  passage?: {
    actorId,                    // the issuer, spawned aboard on accept
    roundTrip: boolean,         // there (toPortId) and back (fromPortId)
    leg: "out" | "ashore" | "back",
    returnsAtTick?,             // while ashore: when they walk back up the ramp (sim-drawn)
    endReason?: "completed" | "leftBehind" | "putOff"
  }
}
```

- The **issuer is the passenger**: `issuerPerson`, `pitch` and `description` (their stated
  purpose, "a sister's funeral", "selling a claim") are what they already are for jobs.
- **Luggage is the cargo line**, optional: zero or one line of an existing item, hauled by the
  crew like freight and physically in the hold. That is the diamond rule with no new code.
- **Two shapes only**: one-way (board here, off there) and there-and-back.
  (revised: no general itinerary. The owner's shape is "go a few hops, do something, come
  back"; multi-stop itineraries add arrays to the plan schema and states to the sim for stories
  a detour card already tells.)
- **One passage at a time, and it is the job** (§one-job-in-hand, unchanged). A passenger competes
  with freight for the ship, not merely for the route; the fare is sized for that.

### 3.2 Aboard

While aboard a passenger:

- uses the bunk pool like everyone else (revised: no cabins. Bunks are not assigned, fatigue
  takes about 15 sim-minutes to send anyone to bed and sleep takes about a minute, so eight
  bunks for nine people never contend at these trip lengths. Revisit if passenger counts grow),
- eats from the galley through the existing needs system (hunger takes about ten sim-minutes to
  bite, so on a round trip they eat once, if at all: present, not a supply problem),
- walks the deck, is visible on it and joins ambient conversation,
- never plans work,
- appears in the digest's Crew section on an "Aboard" line: name, passenger, where to and
  whether back, where they are on deck now, and while ashore when they will return.

### 3.3 Ashore (there-and-back only)

Docked at `toPortId`, the passenger walks down the personnel ramp and goes off ship
(`availability: offShip`, held in that port's lounge store). The voyage home is planned at once,
but departure **waits for them**, like a departure hold: course kept, ramps open, headline
"Waiting for Halla Thorne". They walk back aboard at `returnsAtTick`.

`returnsAtTick` is drawn by the sim from `config.commerce.passage.ashoreSeconds` (say 60 to
180) on a seeded stream. If they are not back by `passage.overdueSeconds` (say 120), the kernel
queues a policy decision through `queuePolicyDecision`, brought by the first officer (§spoken-cards)
and narrated through the `policyDecision` hook (§policy-decision-hook): **"Wait for her" / "Leave
without her."**

(revised: the first draft's abandon card could only happen if the narrator claimed lateness the
sim did not show, since the dwell was fixed and only a captain card could move the ship. Now
lateness is a sim fact the narrator can see coming in the digest, and foreshadow, but cannot
cause. It is a sibling of the departure gate, reusing its machinery.)

Wait keeps waiting. Leave ends the passage `leftBehind`: no fare, the passenger stays at that
port, and the narrator gets them as a cast entry there, which is how a passenger becomes a
season thread.

In v1 waiting costs nothing but time, so this is a character choice, not an economic one,
which is why it should not be the only failure mode (§4.2).

### 3.4 Money

(revised: one payment on completion, not three stages. Pay never appears on a card
(§cards-never-mention-pay); the staging would be visible only as three small top-bar ticks, and
all-or-nothing makes "leave without her" and "put him off" weigh more, not less.)

The fare uses the job price band machinery with a passenger band
(`config.commerce.priceBands.passenger`, per distance unit) over path distance, doubled for a
round trip, placed by `payTier`. Luggage adds nothing. Docking fees at waypoints are real
costs, so a round trip through a waypoint pays four fees; the band is tuned so a standard fare
still clears them.

### 3.5 Boarding and leaving

Accept spawns the passenger at the personnel ramp (a generic `crew.passenger` template with
the issuer's name, no skills) and the luggage in the warehouse as freight, which departure waits
for like any cargo. At the end they walk to the ramp and despawn.

Events: `passengerBoarded`, `passengerAshore`, `passengerReturned`, `passageEnded {reason}`.
Only `passengerReturned` joins the default `hookOnEvents` (it is the turn of the episode).
Completion raises `contractCompleted` as freight does; lateness raises `policyDecision`.
(revised: the first draft hooked boarding and going ashore too. Boarding follows the offer card
by seconds and arrival is already hooked by `approachingPort`; each extra hook is a call against
the hourly cap.)

## 4. Narrator levers

### 4.1 Offer: two booleans on `offerJob`

(revised: the first draft added a sixth intent with an itinerary array of objects, a three-value
dwell enum and its own copies of payTier, urgency and surface. Earlier grammar-size work showed that the grammar pays
for every union member, enum and nesting level; an array of objects inside a new union member is
the expensive kind. Two booleans on the existing member cost almost nothing.)

```
offerJob { ...existing fields...,
  passenger: boolean,     // the issuer rides; cargoItem is their luggage, empty for none
  roundTrip: boolean      // passenger only: they come back to fromPort
}
```

Translator rules: `toPort` may be any reachable port (path checked); a passenger offer is
always surfaced, since it is a person at the ramp (`surface` is forced true; offer cards wait for
the dock, §offer-cards); `roundTrip` without `passenger` is dropped with a reason; quantity is
ignored for a passage beyond one luggage line; the passenger joins the narrator's cast
automatically, placed aboard. The stated purpose is `description`; the truth can differ in notes.

### 4.2 Putting a passenger off: one effect on a card side

(new in revision: the first draft gave the captain no way to act on a passenger after "welcome
aboard", which makes the crew-friction card a card with no real side.)

`decisionSide.effect` gains one value: `none | setCourse | endPassage`. Chosen, the passenger
leaves at the next docking (now, if docked), the passage ends `putOff` with no fare, and they
stay at that port as cast. One enum value, no new fields. This is the second failure mode, and
the one the narrator can set up: suspicion, a crew member's grievance, luggage that is not what
it seemed.

### 4.3 What already composes

`surfaceDecision` with the passenger as speaker carries the middle of the episode; beat cards
(§beat-cards) are their foreboding, one per thread as now; `setCourse` is the detour they ask for;
`stockMarket` makes the thing they came for scarce or dear at the far port; `scheduleFault` is
the complication on the long leg.

Prompt rules: the narrator never decides a passenger's fate (illness, death, leaving) and never
narrates what they did ashore as fact. A card may say what they claim or how they look ("came
back quiet and wouldn't say where she'd been"), never what happened off the ship.

### 4.4 Null narrator

Never offers passages (agreed with the first draft). Production has no offline narrator (D43);
tests create passages by scenario command.

## 5. The crew

Passengers are a social fact. v1 makes them one with what already exists:

- **Ambient conversation** (`lastConversationTick`): passengers are eligible partners, so the
  ticker shows "Halla Thorne and Bettina Solheim talked in the galley". Those lines are in the
  digest's recent events, so they are true things a crew card can open from.
- **Opinion lives in threads.** (revised: no per-crew-per-passenger opinion table in notes. It
  grows the notes schema and the digest for something a thread already carries: a thread's
`people` list and `stage` can say "Sunniva doesn't trust him", and the crew voice (§crew-lines)
  carries it onto the card.) Mood effects on crew from passengers are deferred.

## 6. Cards this produces

The same card grammar as today (§spoken-cards), with new true things to say:

- **Offer** (jobBoard, the passenger at the ramp): "Welcome aboard." / "Not this trip."
- **Waypoint or long-leg beat**: the passenger finds the captain. A beat card, attitude recorded.
- **Crew friction**: the first officer or the cook brings an observation about the passenger.
  Sides can be real now: "Put him off at Kessler." / "He stays."
- **The turn** (`passengerReturned`): they come back changed, or with less luggage than they
  left with, or with someone asking after them.
- **Overdue** (sim policy card): "Wait for her." / "Leave without her."
- **Payoff** (`contractCompleted`): their last word at the ramp; what the captain learns.

Each is grounded in state the digest shows (§market-and-parts-lines). Each is the call's one card,
so a passenger beat competes with whatever else is due under the arc selection rule
(§threads-and-scales).

## 7. Phasing

(revised: phase 1 is not worth a playtest on its own. Without passengers, multi-hop freight is
the same inert story stretched over more legs and more quiet check-ins; it tests pacing, which
can be measured headless. Build it first, playtest with passengers.)

1. **Galaxy and voyages**: three far ports with character and cast seeds, voyage destination
   and shortest path, waypoint auto-continue (with the market and gate rules in §2.3),
   path-distance pay, capabilities show hops. Merge behind a headless pacing run (calls per
   episode at each speed), not a playtest.
2. **Passengers v1**: `Job.passage`, spawn and despawn, ashore and return, the overdue policy
   card, `endPassage`, the passenger price band, the two `offerJob` booleans, digest and
   capability lines, events. Deploy with phase 1 and playtest.
3. **Passengers v2** (after a playtest): undisclosed destination (GDD §11), luggage that goes
   ashore and does not come back, a narrator lever on lateness if the sim draw feels arbitrary,
   passenger condition (illness) once crew incidents exist, passenger effects on crew mood.

Phase 1 is about a day; phase 2 about two (revised: no new entity, offer path or fare staging).

## 8. Decisions for the owner

Each changes what gets built. Recommendation first.

1. **Six ports or nine.** Recommend six: the core triangle plus three far spurs (§2.1). Nine
   is more content and continuity for no new kind of story. Port names are yours either way.
2. **Who picks the next hop.** Recommend the sim, along the shortest path, with detours only
   by narrator cards (§2.3). The first draft had the captain choose every leg, which costs a
   card and a narrator call per waypoint.
3. **Passage as a job, or a new entity.** Recommend a job with a `passage` block and two
   booleans on `offerJob` (§3.1, §4.1). The first draft's `Passage` entity and `offerPassage`
   intent duplicate the job lifecycle and cost grammar budget.
4. **Failure modes.** Recommend two: sim-drawn lateness with a "wait or leave" policy card, and
   an `endPassage` card effect the narrator can set up (§3.3, §4.2). The first draft had only
   abandonment, which the sim could not produce on its own.
5. **Fare.** Recommend one payment at completion over path distance, from a passenger price
   band (§3.4), rather than 25/50/25 staging. No narrator refunds.
6. **Narrator budget.** A passage is about eight calls; the default hourly cap is six. Recommend
   raising `CREW_NARRATOR_MAX_CALLS_PER_HOUR` to about 30 before the playtest, and raising
   `narrator.quietTooLongSeconds` from 40 to about 60 once far legs exist, so a long leg gets one
   quiet check-in rather than three. Measure both in the phase 1 headless run.

Settled without a ruling (were decisions in the first draft): no cabins (§3.2); passengers
compete with freight (one job at a time); the null narrator never offers passages; legs are
tuned by route distance, not `nominalSpeed`.

## 9. Testing

Unit: shortest path; voyage set on accept, next hop on each docking, detour keeps the voyage;
waypoint departure waits for a runnable `buyParts` task; the gate asked once per voyage;
path-distance price band; passage accept spawns the passenger and luggage; ashore, return,
overdue policy decision, wait and leave; `endPassage` docked and in transit; single payment;
translator rules for `passenger`/`roundTrip` (reachability, forced surface, roundTrip without
passenger dropped); digest "Aboard" line and capabilities hop counts.

Kernel integration: a round-trip passage hub to Ossory through Kessler with a late return and
"wait", money and events asserted; the same with "leave without her" leaving the passenger as
cast at Ossory.

Headless pacing run (phase 1 gate): narrator calls and wall time per round trip at 1x, 4x and
8x with a stub narrator at 25 s latency.

Live suite: one `jobBoard` call on a fixture docked at the hub with a far port two hops away,
asserting an `offerJob` with `passenger: true` or a rationale explaining the choice; one
`policyDecision` call on the overdue card asserting the first officer speaks.
