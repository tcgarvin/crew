# Narrator story

What the story narrator can do (its levers and the translator that vets them), what it remembers
(notes, threads, past arcs, card history), what it is shown (the digest) and told (the prompt
rules), and the separate staging call that dresses a dock. When and how it is called is in
`narrator-calls.md`; the cards it produces are in `cards.md`. Code is in `packages/narrator/src`:
`capabilities.ts`, `contract.ts`, `translate.ts`, `notes.ts`, `history.ts`, `digest.ts` and its
`*-digest.ts` helpers, `prompts/`, `staging/`.

## Narrator levers

### Narrator authority

The narrator sets things up; the sim decides outcomes (D6). It has exactly seven levers, each an
intent in its plan, and every one becomes a kernel command only through the translator. No lever
sets a body, a health, a position, a piece of knowledge or money. The capability list
(`buildCapabilities`) is generated from content, config and the ship's machines, so the prompt
never promises what the sim cannot do. It carries every id the plan may use (ports and their legs,
store keys, cargo items, machines and faults, each port's market); the plan's ids are plain
strings the translator checks against it. Why: strict structured output compiles the schema into a
grammar, and per-game enums for ids made it too large.

### Offer lever

`offerJob` makes a freight contract or a passenger passage.

- Every offer comes from a person: `issuerName`, `issuerRole`, optional `issuerOrg`, and a
  `pitch` of at most 30 words they say to the captain. Issuers join the narrator's cast, so they
  recur. Neither pitch nor description ever mentions pay; `payTier` (low, standard, generous)
  places the pay inside the class price band and the engine computes it.
- `fromPort` must be the port the ship is docked at: offers are made in person at the dock, never
  in flight. `toPort` may be any reachable port; beyond one hop the accepted job is a voyage.
- One job at a time. The translator drops an offer by the kernel's own rule
  (`jobBlockingAcceptance`), so freight being unloaded at its destination does not block a new
  offer, and a job still under way does.
- `surface: true` makes it an accept/decline card and counts as the call's one card; `false`
  posts it quietly on the port board. A passenger offer is always surfaced (a person at the ramp)
  and is dropped, not posted quietly, if the call's card is taken. `roundTrip` needs `passenger`.
  For a passenger `cargoItem` is luggage (one unit, or empty) and `quantity` is ignored.

### Spawn and fault levers

`spawnAtBoundary` puts existing cargo items into a port's external store, never aboard, at most
`narrator.maxSpawnsPerCommand` units. `scheduleFault` makes a machine develop one of its own
catalogued faults inside a `soon | later | muchLater` window; not on a machine that has or awaits
that fault. Both spend from the budgets shown in the digest (`spawns`, `faults`).

### Narrator lever budgets

Spawns, faults and hazards each spend from a budget the digest shows. Every
`narrator.budgetRefillDays` (0.25) the three refill to their config values, counted from the last
refill (world creation in a fresh game); the refill runs before the quiet timer, so a hook raised
in the same tick sees the refilled budget. Fields have no budget (one per leg).

### Market lever

`stockMarket {port, item, count 0-4, priceTier cheap|fair|dear}` sets what a port's market sells
of one item (any item def, not only cargo; provisions included). Count is clamped to
`commerce.market.maxStockPerCommand` and 0 withdraws the item. The price is the content price for
that item at that port times the tier's multiplier (`commerce.market.priceTiers`). It is the only
way a part reaches a port: the crew buy for themselves from the ship's money (see `commerce.md`),
and the narrator never buys, delivers, repairs or pays. There are no scheduled deliveries. Why: the
owner, "let's just deal with things that are already there."

### Hazard and field levers

`scheduleHazard` places a piloting check for whoever holds the helm (`debrisField`, `ionStorm`;
tier easy, hard or brutal mapped to `hazards.difficulty`). `scheduleField` places an asteroid
field (severity `light | heavy | brutal`, `detection` rolled or unseen, and up to
`field.maxScripted` (3) scripted impacts; the field's play is in `hull-and-field.md`). For both:

- Only on a leg: a course set or the ship under way with transit left. Dropped while docked with
  no course, on approach or docking, or when the window opens after this leg's transit ends. The
  departure call the narrator requests with `callBack` is the natural moment.
- One hazard may wait at a time (and spends the hazard budget). One field per leg, no budget.
- A scripted impact names a machine id, a room name, or a machine name unique aboard, a moment
  (`early | middle | late` of the field's length, 15, 50 and 85%; impacts at one moment land 4 s
  apart), and optionally a rock size and machine effect. A person is refused until bodies exist.
  Scripted impacts alone (an unsized rock priced large) must leave the hull above zero, or the
  whole field is dropped. A field is also refused once the ship is lost.

### Card lever

`surfaceDecision` puts a two-sided card in front of the captain (shape and delivery in
`cards.md`). Each side has an effect: none, `setCourse` (only docked, or a detour on a voyage),
`endPassage` (puts the current passenger off at the next docking, no fare, valid only with a
passenger aboard or ashore on a live passage), or `privateTalk` (a warm or stern word with a named
crew member aboard; never the captain, a passenger or someone ashore; see `social.md`). The card
also carries `speaker`, an aftermath per side, `beatOfThread` and `closesThread`. A reply's
`card` field is only for dressing a pending policy decision; `beatOfThread` or `closesThread`
written on it are stripped before validation and fed back as a correction.

## Translator

### Translation and drop reasons

`translateIntents` (`translate.ts`) treats the plan as untrusted: each intent is re-parsed against
its schema, ids are checked against the snapshot and content, tiers become numbers from config,
and pairings are checked (a fault in the machine's catalogue, a store in the port). A bad intent is
dropped alone with a reason prefixed by its kind; it never fails the call. Drop reasons, plus
non-fatal corrections, are stored as `lastRejections` (at most six) and shown next call under
"rejected last time", and the notes turn is told what became of the plan. The server logs
`[narrator] dropped` with kinds and reasons. Commands are targeted at the tick after the hook.

### Player-facing text checks

Every text a player can read (titles, situations, labels, aftermaths, pitches, descriptions,
speaker and issuer names) is clipped to its cap and refused if it is empty, states a numeric
consequence (a credit amount, a percentage, a signed delta), or contains a secret phrase: the name
or symptom of an undiscovered fault or a scheduled one (a deliberately conservative substring
check). Caps: situation 70 words, aftermath 20, pitch 30, side label 48 characters, title 60. A
blank aftermath means "none" and does not drop the card. Both sides of a card may not share a
label. The staging translator reuses the same checks.

### One card per call

At most one card per call, counting a surfaced offer. The count starts at one if a decision is on
screen or held for in-person delivery, and a policy-decision call cannot surface a new card, only
dress the pending one. Policy-card prose that fails the text checks falls back to the template
card.

### Captain never speaks

The `captain`-tagged crew member is the player's avatar. A card whose speaker is the captain is
kept as an observed scene and the model is told why. The captain's voice line only shapes how
others react to them.

## Notes, threads and arcs

### Narrator notes

The notes (`NarratorNotes`, stored per game) are rewritten in full by the model on a follow-up
turn after each plan, with the server carrying its own bookkeeping over: `summary`, `threads`,
`cast` (up to 12, the longest-unseen dropped first), `pastArcs`, `cardsShown`, `lastRejections`.
`parseNotes` is the boundary where stored notes are validated. Everyone who makes an offer is
added to the cast by the server if the model forgot them.

### Threads and scales

Threads are structured, TV-style. A thread has a title (its identity), a scale, up to six people,
`arcNotes` (the arc so far, at most 600 characters), a `nextBeat` condition, and server-kept
`openedTick`, `lastBeatTick` and `beatCardShown`. Scales: beat (one card with a follow-up),
episode (one complete story, usually a job's length, typically opening with the captain looking
for work; it need not involve a job), season (returns every few jobs), series (a slow pressure
that surfaces rarely). Two to four stay alive at different scales; at most six are stored. A
thread returns only when its `nextBeat` holds and something has changed. When several are ready,
the one with the oldest last beat goes first unless an episode is at its climax. `lastBeatTick` is
the hook tick of the last call that put one of the thread's people in front of the captain (a
card's speaker or named person, an offer's issuer).

### Beat cards

A beat card advances a thread without a decision: `beatOfThread` names it, both sides are the
captain's attitude (effect none), and the attitude is recorded into the thread's arc notes. One
per thread before its payoff, enforced by the translator; a thread that has had its beat card is
shown `(foreshadowed)` and its next card must pay it off. A title matching no stored thread starts
one (the notes turn writes it).

### Closing cards

The narrator ends its own arcs on an ordinary card (D54): when a thread is over (payoff landed,
its job done, or events made it moot) one closing card makes plain the story is finished and how it
came out, usually with two effect-none sides. There is no separate card type. Why: one kind of
card, and the narrator is responsible for its own arcs.

- `closesThread` is the exact title of a stored thread, copied from the digest's "Open threads".
  When the card goes up the server retires that thread whatever the model wrote, records the title
  on the card's history entry, and keeps retiring any thread whose closing card is still in the
  history. The ship's log marks the card "Story closed: <title>"; a title that fails the text
  checks shows as plain "Story closed".
- A card cannot both foreshadow and close. A title an earlier card already closed is dropped
  ("a thread closes once"). A title matching no stored thread does not drop the card: it goes up
  closing nothing and the model is told. Why: models wrote the offer's title or the issuer's name,
  and the captain lost the ending.
- The `notableEvent` hook names `contractCompleted` and `passageEnded` as the moment for a job's
  closing card, or the next call if a card is already waiting.

### Thread keeping and retirement

The server does not let a seen thread vanish unclosed. `mergeThreads`: if the model omits a thread
whose `lastBeatTick` is set (the captain has seen a beat of it) and no card closed it, the server
keeps it as it was and says so next call; a thread the captain never saw may go silently. The model
may list titles in `retired` for threads that end without a card of their own because events made
the ending plain (an offer turned down, a story another card wrapped up). Over the six-thread cap,
new unseen threads give way first. Why: the notes are rewritten whole each call, and a rewrite
between a delivery and its closing call swapped the job's thread for the next offer's.

### Past arcs

When a thread ends, by closing card or `retired`, the notes turn writes an `endedArcs` entry
(`shape`, a few words; `summary`, at most 500 characters) and the server appends a `PastArc`
(title, scale, people, opened and closed ticks, how it ended). An arc the model wrote nothing for
keeps its arc notes as its summary, and the next call is told. The digest's "Past arcs" lists all
of them, oldest first, up to 40, outside the digest's character budget. Why: the narrator cannot
see a pattern (six cargo runs, no trouble) from a card history of twelve and a summary of the
present, and the owner chose the tokens (about 100 per arc) over a narrator that forgets.

### Card history

`cardsShown` is the exact record of cards the captain has seen and the side chosen. The model never
writes it; the server maintains it (`history.ts`), twelve entries, each with a gist of 25 words.
It is fed by the call's own policy card and surfaced cards, and by the kernel's `decisionPending`,
`decisionResolved` and `decisionDropped` events. A surfaced card has no decision id until the
kernel mints one, so it is matched to its decision by title through the decision records in the
snapshot, which also fill in any resolution whose event was lost. A card held for in-person
delivery that is dropped before it came up is forgotten. The digest shows it as "What the captain
has seen".

## Digest

### Digest sections and budget

`buildDigest` is a pure, deterministic text projection of the snapshot for one call. It shows
truth, not captain knowledge, with undiscovered faults labelled `[undiscovered]` (the prompt and
the text checks forbid them in player-facing text). Sections: why you were called (the hook, plus
the standing call-back request), Ship, your budget, pending decisions, cards held for in-person
delivery, machines, jobs, crew, your notes, open threads, past arcs, what the captain has seen,
people you know here, on the dock, open problems, recent events (15 at most).

Over `DIGEST_MAX_CHARS` (10,000), lines are dropped from the lowest-priority section first, events
oldest first, with a note of how many. Never trimmed: why you were called, Ship, budget, open
threads, past arcs (outside the budget), and the staging call's dock section.

### Open threads list

"Open threads" lists each stored thread's title in quotes under a line saying to copy one exactly
into `closesThread` or `beatOfThread` (with none: leave `closesThread` empty). Thread lines in the
notes section quote the title too. The staging call is not shown it.

### Held cards

"Cards on their way to the captain in person" lists cards held for delivery (who, how, "not shown
yet"). They are not under pending decisions and not in "What the captain has seen"; they count as
the call's one card.

### Crew lines

Each crew line gives role tags, section and whether they are on watch, availability, what they are
doing and where, needs past the seek threshold (and "bored"), mood as a word with the three
heaviest thoughts (a thought's `{ref}` filled from its `refId`), skills of 3 or more, likes,
dislikes, who they are close to or at odds with (affinity +3 or more, -3 or less, two each),
berth (own cabin, bunkroom, none), bio, and `voice`. The captain is listed first and marked as
never a speaker. Passengers get an "Aboard" line. Why voice: crew have voices, not wants; wants
surface as threads.

### Ship life lines

Under Ship: the watch line and helm check (`time-and-watches.md`), field, hull and damage lines
(`hull-and-field.md`), `galley:` (counter servings with quality and cook, the next meal at the bell
and who is cooking while `mealToCook` is open, provisions in crates and days), `dirt:` (only while
a room is dirty or worse, filthy first), `off watch:` (sessions by venue and players, or still
gathering, and solo play) and `rivalries:`. Problem lines read from the same tables: a provisions
`reserveLow` as "provisions are low (about N days of meals left); K crates would restock the
galley", and `compartmentDirty` as "<Room> is <tier>; <who> mopping" or "nobody is mopping it yet,
the <role>'s to mop".

### Market and parts lines

When docked: `market here:` (item, count, price) and, if the departure is held for repairs, a line
naming the missing part and why (not available here, cannot afford, being bought). A
`partsNeeded` problem line says the machine, the part and the same reason. The capability list shows
each port's market as item, count and a tier word, never a price. Job offers possible now: the
docked port, or none in flight.

### Dock sections

With a dock alongside, every call (story calls included) gets "On the dock (<name>)": the place's
ambience line, the line the log showed on arrival, each local (name, role, post, label, and why
they are there: a regular, a dock hand and their errand, a passenger the ship left, a receiver for
freight, one of the port's people, in the cast, a new face with their look "not in your cast until
you write about them", or a visitor who "came in from the port with word for the captain"), props
by where they stand, then freight by job (on offer, waiting to be loaded, delivered to the bay,
unloading). The story prompt tells the narrator those people are really there and make natural
issuers and speakers; a new face is cast only if the story wants them.

## Prompt rules

The static system prompt (`prompts/system.ts`) and per-hook instructions (`prompts/hooks.ts`)
carry the narrator's judgement; the translator enforces only what is mechanical. The rules a
designer reasons about:

- Set things up, never decide outcomes. Continuity over invention: reuse cast, ports and threads.
- Pacing is the narrator's judgement, not a timer's. It reads "What the captain has seen" (with
  ticks) and the ship's state to choose forward motion (work, a thread beat, a consequence), a
  breath, or nothing. An idle docked captain gets work first. Faults, hazards and fields are
  pressure, never filler: never twice in a row, never on an unrepaired fault, a field the biggest.
  Why: after ten maintenance events in a row, the owner: "first there's an opportunity for work,
  then we pause, one or two small things happen, then we come back and move the story forward. The
  narrator ought to be able to govern that on its own." The owner withdrew timers and an ordered
  checklist: "I don't want the narrator to think we are asking it specifically to solve that."
  Hence `quietTooLong` is a neutral check-in listing what is available.
- A new card must bring something the captain has not seen on a card: new information, a person, a
  consequence, or a thread's next beat; otherwise do nothing. There is no spacing rule, and minor
  crew cards are welcome. Share the stage across the crew.
- Variety is the job: read "Past arcs"; two stories of one shape in a row means the next is a
  different kind; most episodes take a turn before they close; "never stack pressures" means one at
  a time, not none.
- Every card is brought by someone: a grievance by the crew member who has it, an operational
  matter by the first officer, an offer by its issuer; never the captain. Each person is written
  in their `voice`. A card shows one concrete moment, 35 to 55 words (never over 70), with a
  stage line and quoted speech; sides are two to six words, a line of dialogue or a concrete act.
- No numbers or pay on any player-facing text. Nothing about an undiscovered fault until the crew
  notice it. Never narrate what the digest does not show: a repair, delivery, purchase, meal,
  damage, passenger action or crew relationship. A card may state what someone intends or claims,
  never that it happened. A passenger's fate is the sim's; the narrator's one lever on a passenger
  is `endPassage`.
- Route choice is the ship's; a detour card only when the story makes it the captain's choice.
- Weigh the hull before a field: never one the hull cannot survive unless the ship left port
  damaged. Moods, thoughts, helm failures and filthy rooms are the sim's failings, a reason for a
  card, never a fact to cause or fix.
- Hooks: `captainAshore` expects an offer from someone who fits the port, a deliberately rare
  "nothing", and a different kind of story than the past arcs; `requestedCall` is where a leg gets
  its beat; aftermath calls (`alertCleared`, `navHazard`, `faultRepaired`) belong to the people in
  them and add no new pressure; `policyDecision` dresses the existing card.

## Staging prompt

The staging call (`staging/`) is a separate model call, made before a ship comes alongside, that
sets the stage and nothing else. Its calling, budget and failure fallback are in
`narrator-calls.md`.

- It has its own system prompt (`STAGING_RULES`) and the item catalogue as a second cached block.
  The reply is `rationale` plus intents `placePerson` (a seed, a cast member or a new face with
  role and look, at a post, with an optional label), `placeProp` (catalogue items on the staging
  area or by a post) and `setAmbience`. Limits come from `STAGING_LIMITS`: three people, three
  props, one ambience line, capped labels, looks and names. It never offers, makes cards, schedules
  faults, stocks markets or writes notes.
- Its digest is the story digest minus the story budget and open threads, plus "The dock you are
  dressing": ambience, posts by key, areas and the floor set the sim places anyway. Placing a
  floor-set person under their own name moves them and relabels them.
- The reply is parsed with intents left raw, so a story intent in it is dropped with a reason by
  the staging translator rather than failing the call; a reply with anything beside `rationale`
  and `intents` is `schemaInvalid`. The translator produces at most one `stageDock` command,
  checks each part against the kernel's rules (posts of this dock, seeds by exact name, cast names
  against stored notes, nobody aboard, no name twice, catalogue items, text rules), clips labels,
  looks and the ambience line, refuses over-long names and roles, and drops each bad part alone so
  the kernel never refuses a whole plan for one placement. It reads the notes and never writes
  them.
- Prompt guidance: less is more (one or two touches; an empty list is valid), continuity before new
  faces, stage what the story may do next without doing it, never place anyone aboard.
