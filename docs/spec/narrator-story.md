# Narrator story

What the story narrator can do (its levers and the translator that vets them), what it remembers
(notes, threads, past arcs, card history), what it is shown (the digest) and told (the prompt
rules), and the separate staging call that dresses a dock. When and how it is called is in
`narrator-calls.md`; the cards it produces are in `cards.md`. Code is in `packages/narrator/src`:
`capabilities.ts`, `contract.ts`, `translate.ts`, `notes.ts`, `history.ts`, `digest.ts` and its
`*-digest.ts` helpers, `prompts/`, `staging/`.

## Narrator levers

### Narrator authority

The narrator may decide outcomes; it may not do the impossible (D106). It acts only through kernel
commands on an allow-list (D6), each vetted by the translator against the snapshot and content and
revalidated by the kernel on apply, and "impossible" is theirs to judge: the ids exist, the sim can
execute the command now, the state stays coherent. It has exactly fifteen levers today: fourteen
intents in its plan (offers, spawns, faults, markets, hazards, fields, cards, strikes, sums of
money, memories, falling-outs, thoughts, reveals and faults now) and the unseen mark on the arrival
card it dresses (§unseen-lever). Seven set an outcome outright (§outcome-levers): `strike` wounds
or kills a person by the body rules, `transact` moves the ship's money, `plantMemory` and `fallOut`
change who feels what about whom, `giveThought` puts something on someone's mind, `reveal` lets the
crew notice a fault and `injectFault` breaks a machine now; an offer may name its exact pay and a
hazard its outcome. Nothing sets a position, a mood outright or what anyone does next (designed in
`docs/design/narrator-arcs.md` §4, not built), and everything the fifteen do not reach is the
sim's, shown in the digest. The
capability list (`buildCapabilities`) is generated from content, config and the ship's machines, so
the prompt never promises what the sim cannot do. It carries every id the plan may use (ports and
their legs, store keys, cargo items, machines and faults, each port's market); the plan's ids are
plain strings the translator checks against it (§plan-schema-in-the-prompt).

### The narrator and sites

The narrator sees every authored landing site (§landing-sites) and may send the ship to one, but
only through an errand (§offer-lever). The capability block's ports leave sites out; they go under
"Sites: where an errand goes", each under its near port, with its id, name, description,
character, its reach from here through the near port, and its default cast in words (name, role,
arms, look; the target by role only, since the errand's `targetName` becomes their name), never a
tier or a number about the fight. "From here" is measured from the near port while the ship is at
or bound for a site. `pathBetween` runs over the `"all"` graph (`portGraph`, §known-sites), so a
site is reached through its near port. Freight, a passage or a card's `setCourse` to a site is
dropped, and nothing is offered while the ship is set down at one.

At the site the narrator dresses the two kernel cards on `policyDecision` (§the-arrival-card,
§the-turn-card): only the words change, each side keeps its commands, and on the arrival card it may
mark one side as the way in unseen (§unseen-lever). It cannot choose the plans, stage the site, set
a stance, script a turn or parley: none of those levers is built yet (each is a new allow-listed
command, D6, in bounds since D106). It may strike anyone on the site floor, the party, the cast or
the target, and the strike lands like a shot (§strike-lever); nothing captures, so a capture is the
sim's and a card never states one that has not happened. The arms locker stays out of the capability lists and
the digest's machines, weapons out of the staging catalogue, and `fighting` out of a crew line's
skills. No `captainAshore` is raised at a site (§looking-for-work), and a fight's `alertCleared`
never hooks (§notable-event-hook); the fight's end and a failed errand do (`expeditionResolved`,
`jobFailed`). The digest sees the crew's bodies (§crew-lines) and the site (§dock-sections).

### Offer lever

`offerJob` makes a freight contract, a passenger passage, or an errand to a site.

- Every offer comes from a person (§issuers-and-pitches): `issuerName`, `issuerRole`, optional
  `issuerOrg`, and a `pitch` they say to the captain. Neither pitch nor description ever mentions
  pay; `payTier` (low, standard, generous) places the pay inside the class price band
  (§offer-command-and-price-bands) and the engine computes it, unless `payCredits` names the sum
  (§money-levers).
- `fromPort` must be the port the ship is docked at (offers are made in person). `toPort` may be
  any reachable port; beyond one hop the accepted job is a voyage.
- One job at a time: the translator drops an offer by the kernel's own rule (§one-job-in-hand).
- `surface: true` makes it an accept/decline card and counts as the call's one card; `false`
  posts it quietly on the port board. A passenger offer is always surfaced (a person at the ramp)
  and is dropped, not posted quietly, if the call's card is taken. `roundTrip` needs `passenger`.
  For a passenger `cargoItem` is luggage (one unit, or empty) and `quantity` is ignored.
- An errand (`errandKind` `fetchPerson` or `fetchItem`, §errand-job) goes to a site listed under
  "Sites" and back: `site` is the site and `toPort` is `fromPort` (a site written there is
  corrected, with a note). A `fetchPerson` names `targetName` (clipped to a cast name's length)
  and `wants` alive, either or dead (empty is offered as alive, with a note). A `fetchItem` names
  an existing `targetItem`, wants it either way, and is called by `targetName` or else the item's
  name. An errand carries no cargo and nobody rides on it; its pay is the sim's `errandPay` over
  the path there and back at the `payTier` (§errand-pay). A kill job (`wants: "dead"`) is
  accepted; the prompt keeps it rare and its issuer never clean (D103). Every errand field is
  empty for freight and passages.

### Spawn and fault levers

`spawnAtBoundary` puts existing cargo items into a port's external store, never aboard, at most
`narrator.maxSpawnsPerCommand` units. `scheduleFault` makes a machine develop one of its own
catalogued faults inside a `soon | later | muchLater` window; not on a machine that has or awaits
that fault. Both spend from the budgets shown in the digest (`spawns`, `faults`), which are advice
(§narrator-lever-budgets). A fault now, not in a window, is `injectFault`
(§forced-faults-and-hazards).

### Narrator lever budgets

Spawns, faults and hazards each spend from a budget the digest shows under "Your budget", and the
budget is advice, never a refusal: neither the translator nor the kernel drops a lever for it, the
counter goes below zero, and the digest shows a spent one as "0 (n past it)" under a line that
says it is advice. The prompt reads it as the pacing rule's measure of how much pressure the stretch
has had. Every `narrator.budgetRefillDays` (0.25) the three refill to their config values, counted
from the last refill (world creation in a fresh game); the refill runs before the quiet timer, so a
hook raised in the same tick sees the refilled budget. Fields have no budget (one per leg). Why: the
owner, budgets are advice; hard caps were D6(b) by another name (D106).

### Market lever

`stockMarket {port, item, count 0-4, priceTier cheap|fair|dear}` sets what a port's market sells
of one item (any item def, not only cargo; provisions included; §market-stock). Count is clamped
to `commerce.market.maxStockPerCommand` (4) and 0 withdraws the item. The price is the content
price for that item at that port times the tier's multiplier (`commerce.market.priceTiers`: cheap
0.6, fair 1, dear 1.6; `defaultPrice` 100). It is the only way a part reaches a port: the crew buy
for themselves from the ship's money (§buying-parts); the narrator has no lever that buys,
delivers or repairs (it moves money only through `transact`, §money-levers). There are no scheduled
deliveries. Why: the owner, "let's just deal with things
that are already there."

### Hazard and field levers

`scheduleHazard` places a piloting check for whoever holds the helm
(§debris-fields-and-ion-storms). `scheduleField` places an asteroid field, its severity, detection
and scripted impacts (§scheduling-a-field). For both:

- Only on a leg: a course set or the ship under way with transit left. Dropped while docked with
  no course, on approach or docking, or when the window opens after this leg's transit ends. The
  departure call the narrator requests with `callBack` is the natural moment.
- One hazard may wait at a time. One field per leg.
- A hazard's `outcome` is empty (the helm's roll decides) or decided (§forced-faults-and-hazards).
- A scripted impact names a machine id, a room name, or a machine name unique aboard, and a moment
  (`early | middle | late` of the field's length, 15, 50 and 85%; impacts at one moment land 4 s
  apart). A field failing the command's guard is dropped whole, and one is refused once the ship
  is lost.

### Card lever

`surfaceDecision` puts a two-sided card in front of the captain (§cards-and-sides). Each side has an
effect (§side-effects). The card also carries `speaker`, an aftermath per side, `beatOfThread` and
`closesThread`. A reply's `card` field is only for dressing a pending policy decision (and its
`unseen` mark, §unseen-lever); `beatOfThread` or `closesThread` written on it are stripped before
validation and fed back as a correction.

### Unseen lever

On the `policyDecision` hook for an expedition's arrival card the narrator may let the crew get in
unseen by one side: the card's `unseen` field (`UNSEEN_SIDES`: `left`, `right`, or empty for
neither) becomes `markUnseen` with that side's plan (`leftPlan` or `rightPlan`). The captain still
chooses, and the fight follows the choice: the marked side unseen, the other expected
(§getting-in-unseen). The translator drops the mark with a reason on any other card or on a side
that holds the ramp (a `hold` plan); an empty field sends nothing. Why: the owner, "if the player
picks the right option, the narrator says they sneak in and get the box, but another option the
narrator triggers defenders" (D105).

The prompt keeps it for a quiet way in the story has set up (a guard asleep, a back way, a friend
inside), and the card never gives it away: neither side's words say which is marked. The digest
never shows the mark before a plan is chosen; once the expedition is over its line at the site
(§dock-sections) says how the site noticed them: "nobody saw them come or go" when the marked
side went in and no fight came, "they were waiting" when the other did.

## Outcome levers

Levers that decide an outcome rather than place a pressure (D106). Each is an allow-listed kernel
command (narrator and scenario authority, never the player) whose guards are the impossible only,
run through the sim's own entry point, and emits an event the next digest's recent events show.
What happens in the world (a wound, a sum, a falling-out, a fault noticed or broken) has a log
line; what someone feels (a planted memory, a thought) has none, because a feeling is shown on a
card and in the crew lines, never stated by the log. Code: `systems/bodies/strike.ts`,
`systems/commerce/transact.ts`, `systems/social/levers.ts`, `systems/equipment/levers.ts`,
`systems/travel/hazards.ts`.

### Strike lever

`strike {who, severity graze|serious|grave, type blaster|blunt|stun, part (or empty), byWho (or
empty), how}` becomes the kernel's `strike {actorId, severity, type, part?, byActorId?, how}`: one
hit through `applyDamage` (§wounds-and-the-damage-entry-point), so the body rules decide whether
the person goes down or dies (a grave head hit kills at once, §bleeding-and-healing does the rest)
and the narrator never writes `dead`. `who` and `byWho` are full names as the digest lists them
(crew, passengers, the dock's and the site's people) or actor ids; a name two people share is
dropped as ambiguous.

- Impossible, and dropped by the translator and refused by the kernel: nobody by that name, someone
  already dead, someone not on the ship's floor or the site's (off the ship, in a port's lounge,
  a passenger ashore), and a `byWho` who is dead or off the floor. The captain is not special
  (owner: "Captain can die any way a regular crew member can die"); command passes by D8.
- `how` is one line of what happened, at most `STRIKE_HOW_MAX` (120) characters, held to the
  player-facing text checks (§player-facing-text-checks). Apply emits `struck` (narrative) before
  the hit's `wounded` and any `died` or `incapacitated`. Off the fight the log line is `how` and
  the hit's `wounded` carries `narrated` so the log does not tell it twice; in the fight
  (`struck.inFight`, the person has a combatant) `struck` has no line and the fight's own
  ("Corran Vale is hit", "is dead") tell it, and the next combat tick takes the down and the dead
  out of the fight (`syncBody`).
- Reactions as for a shot that hits (§thoughts-and-memories-from-a-fight): crew who see a
  crewmate hurt (not stunned) take `sawCrewHurt`, by line of sight for the party in the fight and
  in the same room aboard; a crew `byWho` whose blow killed takes `killedSomeone`. Bleeding,
  healing and incapacity are the bodies system's. A strike shakes no one's morale in the fight;
  the down and the dead leave it by the body sync.

### Money levers

- `transact {amount, memo, counterparty}`: `amount` signed whole credits into (positive) or out of
  (negative) the ship's money, written to the ledger as a `narrator` transaction with its `memo`
  and `counterparty` (each at most `TRANSACT_TEXT_MAX`, 80 characters, held to the text checks;
  the counterparty may be empty), and a `transacted` event (narrative) whose log line is "Paid
  Osei 200 cr: the gate fine" or "Received 500 cr from Ysolde Maren: a reward". Impossible: zero or
  a fraction, a debit the balance cannot cover (the translator counts the call's earlier sums), a
  credit above `narrator.maxWindfall` (2000). It applies with the plan, not on a card's side: a
  card side that pays is not built (narrator arcs §7.6).
- `offerJob.payCredits`: 0 lets `payTier` place the pay; any other number is the exact pay, a
  positive whole number at most `narrator.maxOfferPay` (10000), sent as the draft's `payNamed`.
  The kernel then checks the sum against that cap instead of the band, never scales it to the
  crates it caps, and takes a named pay from the narrator or a scenario only.
- No card text states a sum (§cards-never-mention-pay): the top bar and the log show money, and a
  card says "it costs us".

### Memory levers

- `plantMemory {from, to, key, lasting}` becomes the kernel's `plantMemory {fromActorId,
  toActorId, key, lasting}`: `from` remembers `key` about `to` (§memories), one way. The keys are
  the narrator's own (`NARRATOR_MEMORY_KEYS`, raised by nothing in the sim): `betrayedMe` (-5, 14
  days), `savedMyLife` (+5, 14), `wrongedOverSomeone` (-4, 10), `madeItRight` (+3, 10), each stack
  limit 1. With compatibility at most ±2, a betrayal or a life saved alone puts any pair past the
  ±3 of "at odds with" / "close to" (§crew-lines) and of the seats' `avoidBelow`
  (§seats-and-the-captains-table).
- `lasting: false` is an ordinary memory (it stacks and expires as `addMemory`'s do). `lasting:
  true` (owner) never expires, the season's grudge or debt: it takes the place of any timed memory
  of its key between the pair, and is cleared only by another planted memory from the same `from`
  about the same `to` (any key, lasting or not: `madeItRight` lays a grudge down). Planting first
  drops every lasting memory `from` holds about `to`, so at most one is held.
- `fallOut {a, b, over}` becomes `fallOut {aId, bId, over}`: `wrongedOverSomeone` planted both
  ways (not lasting), then a debate's argument (`argue`: the `argued` thought about the other and
  the `argued` memory, both ways), then an `argument` event (narrative) carrying `over` instead of
  a topic, whose log line is "Jax Okonkwo and Priya Kessler have fallen out over Ysolde Maren". So
  the pair is at odds both ways on the next digest and avoid each other at the table; the digest's
  "rivalries" line is games only and does not show it. `over` is at most `FALL_OUT_OVER_MAX` (80)
  characters and held to the text checks. Never violent (owner: the violent falling-out and its
  brawl are deferred, narrator arcs §4.3); a blow is a `strike` as well.
- Impossible, dropped by the translator and refused by the kernel: nobody by that name, someone
  dead, someone not crew or a passenger, someone off the ship (`offShip`: ashore), one person named
  twice, a key not in the set. `plantMemory` emits `memoryPlanted` (notable, no log line) and the
  `affinityChanged` the memory makes.

### Thought and reveal levers

- `giveThought {who, key, ref}` becomes `giveThought {actorId, key, refId?}`: `addThought` as the
  sim gives one (§thoughts), so it weighs on mood and work speed for its days
  (§mood-and-work-speed). Any thought key content defines; four are the narrator's own
  (`NARRATOR_THOUGHT_KEYS`): `worriedAbout` ("worried about {ref}", -0.15, 2 days), `grieving`
  ("grieving for {ref}", -0.35, 7), `shaken` (-0.2, 1), `heartened` (+0.2, 2), none stacking. The
  capability block lists those and the sim's own that a story may give off their path
  (`nearMiss`, `sawCrewHurt`, `killedSomeone`, `heldTheLine`, `ranFromAFight`). Impossible: nobody,
  the dead, someone not aboard, a key content lacks, a thought whose label names someone (`{ref}`)
  with no `ref`, a `ref` who is nobody. Emits `thoughtGiven` (notable, no log line) besides
  `thoughtAdded`.
- `reveal {machine, faultKey}` lets the crew notice an active, undiagnosed fault now. The symptom
  problem (§symptoms) is opened if missing and made `public`, as an intercom report makes the damage
  it relays, so every crew member's view has it and the planner sends someone to inspect it; the
  crew member aboard best at engineering (on their feet, crew not passengers, ties by id) is
  written the problem and the `machineSymptom` fact, so the digest marks the fault "symptom
  noticed"; `faultObserved` (notable) gives the log "Jax Okonkwo noticed grinding noise from the coolant pump".
  Impossible: no such machine or fault in its catalogue, the machine does not have it now (a
  scheduled fault, or one injected in the same plan, is revealed once it has happened), it is
  diagnosed, and (translator) the crew already noticed it. A fault the plan reveals is no longer a
  secret phrase for that plan's text checks (§player-facing-text-checks), so its card may name the
  symptom.

### Forced faults and hazards

- `injectFault {machine, faultKey}`: one of the machine's catalogued faults now, through the one
  fault path (`applyFault`: `faultOccurred` and the symptom problem by its channel, §symptoms),
  where `scheduleFault` picks a moment in a window. Impossible: no such machine (the arms locker is
  not the narrator's), a fault not in its catalogue, a machine that has or awaits it. It spends the
  fault budget (advice, §narrator-lever-budgets). A fault the plan injects is a secret phrase for
  that plan's text checks. `scenarioInjectFault` stays the scenario's.
- `scheduleHazard.outcome` is empty or `clean | scrape | delay` (`FORCED_HAZARD_OUTCOMES`; the
  kernel's payload omits it for empty). A decided hazard is placed and fires as any
  (§debris-fields-and-ion-storms) but skips the roll and its draw (§hazard-roll): the outcome is
  the decided one even at an empty helm (never the unattended scrape and delay), the stander still
  takes `helmCleanPass` or `helmScrape`, and `navHazard` carries `forced`. The prompt keeps it for
  when the story needs the result more than the pilot's skill.

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
blank aftermath is §aftermath-caption's "none". Both sides of a card may not share a label. The
staging translator reuses the same checks.

### One card per call

At most one card per call, counting a surfaced offer. The count starts at one if a decision is on
screen or held for in-person delivery, and a policy-decision call cannot surface a new card, only
dress the pending one. Policy-card prose that fails the text checks falls back to the template
card.

### Captain never speaks

The `captain`-tagged crew member is the player's avatar and never a card speaker. A card whose
speaker is the captain is kept as an observed scene and the model is told why, as a correction.
The captain's voice line, shown to the narrator only, shapes how others react to them.

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
- The `notableEvent` hook names `contractCompleted`, `passageEnded` and a failed errand's
  `jobFailed` as the moment for a job's closing card, or the next call if a card is already
  waiting.

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
yet"). They are not under pending decisions and not in "What the captain has seen"; they count
toward §one-card-per-call.

### Crew lines

Each crew line gives role tags, section and whether they are on watch, availability, what they are
doing and where, needs past the seek threshold (and "bored"), mood as a word with the three
heaviest thoughts (a thought's `{ref}` filled from its `refId`), their body when it is not whole
("down", "wounded in the head and the leg": regions head to foot, the side left out; nothing for
a whole body), skills of 3 or more, likes, dislikes, who they are close to or at odds with
(affinity +3 or more, -3 or less, two each), berth (own cabin, bunkroom, none), bio, and `voice`.
The captain is listed first and marked as never a speaker. Passengers get an "Aboard" line. Why
voice: crew have voices, not wants; wants surface as threads.

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

While a site map is alongside, "On the dock" becomes "At the site (<name>)" (`site-digest.ts`): the
place's ambience line; the errand it is for (who is sought, how they are wanted, for whom, and home
where); where the expedition stands (waiting on the captain's plan, arming, going down the ramp, out
on the ground, the fight, or over with how it ended and, after a mark, how the site noticed them,
§unseen-lever); the party and who leads once a plan is chosen; and each person at the site with
their role, what they are to the errand (the one it is after, one of theirs, a bystander, on the
crew's side), what they carry, where they stand by the map's posts, and their bearing as a word
(steady, wavering, breaking, fled, has given up, down, dead). It shows the arrival card's two plans
with their why while it is up (the chosen plan after), and the turn card's sides while it is up.
For an item errand it adds where the thing lies by the nearest post, or who carries it, or that it
is not in sight; the site's own target reads as "the one at the heart of it here (the errand is
after a thing, not them)", and a taken item errand ends "the party took what it went for". No digit
appears in the section; a head count is written in words.

## Prompt rules

The static system prompt (`prompts/system.ts`) and per-hook instructions (`prompts/hooks.ts`)
carry the narrator's judgement; the translator enforces only what is mechanical. The rules a
designer reasons about:

- Decide, roll, or let the sim run (D106). Decide when the story needs a fact and the captain's
  choice is not what it turns on, with a lever, and show it. Roll when the captain's choice is what
  it turns on: the sim's dice (a hazard, a field's rocks, the fight) decide, and the narrator never
  resolves a card's side for the captain. Let the sim run by default: between calls the narrator
  does not exist, and what the digest shows the sim has played is never re-decided. Today's levers
  decide only what they reach (§narrator-authority), a wound, a death, a sum, a grudge, a
  falling-out, a worry, a fault noticed or broken now and a hazard's result among them
  (§outcome-levers); the prompt says so, and keeps a decided hazard for when the story needs the
  result more than the pilot's skill. Continuity over
  invention: reuse cast, ports and threads.
- Pacing is the narrator's judgement, not a timer's. It reads "What the captain has seen" (with
  ticks) and the ship's state to choose forward motion (work, a thread beat, a consequence), a
  breath, or nothing. An idle docked captain gets work first. Faults, hazards and fields are
  pressure, never filler: never twice in a row, never on an unrepaired fault, a field the biggest.
  The budgets are advice the pacing reads, not a limit (§narrator-lever-budgets).
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
- Every card is brought by someone (§spoken-cards), never the captain. Each person is written in
  their `voice`. A card shows one concrete moment, 35 to 55 words (never over 70), with a
  stage line and quoted speech; sides are two to six words, a line of dialogue or a concrete act.
- No numbers or pay on any player-facing text. Nothing about an undiscovered fault until the crew
  notice it. What the narrator decides, it shows: a fault it made is a card from whoever found
  it, a field's scripted hit gets the crew's answer, a death gets a card from someone who saw it,
  a sum paid or taken a word on a card and never the number, a planted grudge or debt a card in the
  holder's voice (never a log line), a falling-out the loser's card or the first officer's, a
  revealed fault the card of whoever noticed it. Never a fact in prose that neither the sim
  nor a lever made true: a repair, delivery, purchase, meal, damage, passenger action or crew
  relationship the digest does not show. A card may state what someone intends or claims, never
  that it happened; the narrator may lie through a character, never through the ticker. Its levers
  on a passenger are `endPassage` and, aboard, `strike` and the memory and thought levers, so what
  else becomes of a passenger is the sim's. The captain can die like anyone; a death is the strongest card and is spent rarely.
- Route choice is the ship's; a detour card only when the story makes it the captain's choice.
- Weigh the hull before a field: never one the hull cannot survive unless the ship left port
  damaged. Helm failures and filthy rooms are the sim's, and so are moods and who likes whom except
  through a memory, a falling-out or a thought the narrator plants (§memory-levers,
  §thought-and-reveal-levers): a reason for a card, never a fact stated on someone's behalf.
- Hooks: `captainAshore` expects an offer from someone who fits the port, a deliberately rare
  "nothing", and a different kind of story than the past arcs; `requestedCall` is where a leg gets
  its beat; aftermath calls (`alertCleared`, `navHazard`, `faultRepaired`) belong to the people in
  them and add no new pressure, and so does `expeditionResolved`, the site's aftermath (the party,
  the captive, the hurt, the crew on an execution); `policyDecision` dresses the existing card.
- An errand is a story about a person; with no lever to stage a site, who is there is its default
  cast and the fight is the sim's to roll by default; a strike in it (the target too) is the
  narrator's to land when the story needs it, with why in its rationale. A
  kill job is rare and its issuer never clean, and its target taken alive is executed at the
  scene; errands are occasional among freight and passages. Putting off an errand's captive fails
  the errand, so a card offers it only when giving up the job is the real choice. On
  `policyDecision` the arrival and turn cards are dressed, never replaced: each side's aftermath is
  one concrete line of what the crew do next, in the speaker's voice, and the turn card (our side's
  setback) is never the captain's to bring. Whether a side of the arrival card gets in unseen is
  the story's call, made only when it set one up (§unseen-lever).

## Staging prompt

The staging call (`staging/`) is a separate model call, made before a ship comes alongside, that
sets the stage and nothing else. Its calling, budget and failure fallback are
§staging-hook-and-the-hold, §staging-call-on-the-server and §staging-retries-and-the-floor-set.

- It has its own system prompt (`STAGING_RULES`) and the item catalogue as a second cached block.
  The reply is `rationale` plus intents `placePerson`, `placeProp` and `setAmbience`, the parts of
  the `stageDock` plan with its limits (§staging-plan-command). It never offers, makes cards,
  schedules faults, stocks markets or writes notes.
- Its digest is the story digest minus the story budget and open threads, plus "The dock you are
  dressing": ambience, posts by key, areas and the floor set the sim places anyway
  (§staging-plan-dressing).
- The reply is parsed with intents left raw, so a story intent in it is dropped with a reason by
  the staging translator rather than failing the call; a reply with anything beside `rationale`
  and `intents` is `schemaInvalid`. The translator produces at most one `stageDock` command,
  checks each part against the kernel's rules plus cast names against stored notes, catalogue
  items and the text rules, clips labels, looks and the ambience line, refuses over-long names and
  roles, and drops each bad part alone so the kernel never refuses a whole plan for one placement.
  It reads the notes and never writes them.
- Prompt guidance: less is more (one or two touches; an empty list is valid), continuity before new
  faces, stage what the story may do next without doing it, never place anyone aboard.
