# Narrator arcs, outcome levers and narrator-set odds

Status: agreed with the owner 2026-10-11 (D106); slices 1-4 and 6 built. Reworked after the owner's ruling on the narrator's
authority (§2). Owner inputs are marked **(owner)**; everything else is a design-partner call.
The ruling becomes D106 in `docs/DECISIONS.md`; mechanics go into `docs/spec/narrator-story.md`,
`cards.md`, `expeditions.md` and `social.md` as each slice lands. Companions:
`docs/spec/narrator-story.md` (what the narrator has today), `docs/design/expeditions.md` §9
(parley, scripted turns and the approach effect, designed and not yet built; reused here).

## 1. Why

**(owner)** "I want to keep investing in the narrator. More levers, more opportunity for variety
and combining. I'd like the narrator to be instructed to sketch a season arc with a narrative pace
sketched as part of it, a multi-episode arc again with that pace, and an episode arc. The narrator
should adjust the arcs as needed, but should have good stories planned out. … Another thing we
should do here is let the narrator pick the odds of something given a player choice. … So more
directed structure, a lot more levers, and narrator-determined odds of things."

**(owner)**, on the first draft: "We should rethink D6. Maybe a better rule of thumb is that the
narrator can't do anything impossible. But it can and should influence the sim and bend it to its
will when needed. If the narrator decides someone is going to die, or an offer to buy something is
for a given amount of money, or that two close friends will have a violent falling out over a
girl, or if the enemy will get sudden reinforcements, etc etc etc, all that is in bounds. The sim
exists to service the narrative and bring it to life and to add some spice and structure, not to
try to limit the narration. (Though obviously the sim has limits.)"

Today the narrator has memory and judgement with no intent: threads (`notes.ts` `Thread`) record
what happened and the one condition for the next beat; nothing records what it means to happen
next week. And it has no outcome: every lever places a pressure the sim resolves, so a story
"about the death of a crew member" can only be hoped for. The ruling removes the second
limit; this proposal gives the narrator a plan (§6), the levers to land it (§4, §7), and odds as
the one place the dice stay in the captain's hands (§8).

## 2. The ruling: D106, and what it supersedes

### 2.1 D6 has two halves

D6 says two things. **(a) Authority is mechanical**: the narrator acts only through kernel
commands on an allow-list (`AUTHORITY.narrator`, `authority.ts`), each vetted by the translator
against the snapshot and content and revalidated by the kernel on apply. **(b) A content ban**:
"no command sets a body, health, position, knowledge or money directly", restated in the spec as
"the narrator sets things up; the sim decides outcomes" (§narrator-authority) and in the prompt's
first principle. The owner overturns (b). Half (a) survives and *is* "can't do anything
impossible": the ids exist, the sim can execute the command now, and the state stays coherent
(`invariants.ts`). A command that fails that is dropped with a reason the narrator reads next
call, exactly as today.

### 2.2 Draft D106

> **D106. The narrator may decide outcomes; it may not do the impossible.** Supersedes D6(b) and
> the rules downstream of it. The narrator's authority is still a mechanical allow-list of kernel
> commands, each vetted by the translator and the kernel (D6(a) stands), but the list may now
> include commands that set an outcome: a wound or a death, a sum of money, a memory between two
> people, people arriving at a site, a roll's result, a fact someone learns. "Impossible" is the
> kernel's word, not a prompt's: the actor exists and is alive, the post is on the map, the caps
> hold, the balance covers it, the leg is still ahead. Everything else is craft, in the prompt
> (§5). Owner: "the narrator can't do anything impossible. But it can and should influence the
> sim and bend it to its will when needed … The sim exists to service the narrative and bring it
> to life and to add some spice and structure, not to try to limit the narration." Rejected: a
> narrator that only sets things up (D6(b)), which left a planned death a hope; a narrator that
> writes state directly (no allow-list), which would lose the translator's checks and the
> kernel's invariants. See §narrator-authority and `docs/design/narrator-arcs.md`.

`DECISIONS.md` has no superseded entry yet (numbers are permanent; folded entries become gaps).
Recommend D6 stays with one leading line, "*Half (b) superseded by D106; half (a) stands.*", so a
reader who finds D6 cited in code lands on the ruling.

### 2.3 What else D106 supersedes or amends

Listed, not rewritten; each is rewritten in the spec commit of the slice that touches it.

Decisions:
- **D103** "crew and the captain can die, tuned rare, never scripted by the narrator": amended; the
  narrator may script a death (§4.1) under the craft rules of §5.
- **D104** (a kill job's live target is executed): stands; it becomes one case of §4.1.
- **D105** (the unseen mark): stands, generalised to a chance (§8).
- **D40**, **D46**, **D54**: unaffected.

Spec rules (`docs/spec/`):
- §narrator-authority: "The narrator sets things up; the sim decides outcomes (D6). … No lever sets
  a body, a health, a position, a piece of knowledge or money."
- §the-narrator-and-sites: "cannot choose the plans, stage the site, set a stance, script a turn or
  parley (deferred: each is a new lever, D6), and it never states a wound, a death or a capture the
  digest does not show."
- §market-lever: "the narrator never buys, delivers, repairs or pays"; §9.1 of the expeditions
  design's "`money` … the only place an errand spends".
- §prompt-rules: "Set things up, never decide outcomes"; "Never narrate what the digest does not
  show: a repair, delivery, purchase, meal, damage, passenger action or crew relationship. A card
  may state what someone intends or claims, never that it happened"; "A passenger's fate is the
  sim's"; "Moods, thoughts, helm failures and filthy rooms are the sim's failings, a reason for a
  card, never a fact to cause or fix"; "An errand is a story about a person; who is at the site is
  the sim's, and so is the fight."
- §the-arrival-card: "the narrator dresses the sim's pair and cannot choose the plans, a lever the
  owner has not ruled on (D6)".
- `commerce.md` §ending-a-passage-early: "The narrator never decides a passenger's fate".
- `prompts/system.ts`: the first principle, "You never decide a passenger's fate", the policy-card
  "never state a wound, a death or a capture the digest does not show", and the field rule "aim
  them at a machine or a room, never a person: nobody can be hurt yet".

Not superseded, because they are craft or sim limits rather than D6(b): the text checks
(§player-facing-text-checks), one card per call, the captain never speaks, the field's hull
guard (a sunk ship ends the game; §5.2), site caps (`SITE_LIMITS`), one job in hand.

## 3. Decide, roll, or let the sim run

Odds are for player agency: the captain's choice should matter, so a side's odds are the
narrator's honest read and the dice keep the narrator from always getting its way; deciding
outright is for things off the captain's cards. This becomes the rule of three, the prompt's
replacement for "set things up, never decide outcomes":

- **Decide** when the story needs a fact and the captain's choice is not what it turns on: who is
  at the site and what they want, the price of the thing, the reinforcements, the old grudge that
  breaks tonight, the death the season has been walking toward. Decide with a lever (§4), then
  show it (§5.3). Deciding is for off the card, or for the side the captain did not pick.
- **Roll** when the captain's choice *is* what it turns on: a side the captain picks that might
  work or not. The narrator sets the odds (§8) and says what each way looks like; the dice decide,
  so the captain's gamble is real and the narrator cannot script the captain's luck.
- **Let the sim run** by default. Between calls the narrator does not exist; the fight, the
  repair, the meal, the rivalry at cards and the helm in the rocks are the sim's, and the digest
  shows them. The narrator steps in at its six or so calls an episode (§call-spacing) with a few
  levers, and a lever is a noun the sim then plays: a wound bleeds and heals by the body rules,
  reinforcements fight by morale, a falling-out shows in who sits where. Never re-decide what the
  sim has already played: a lever on a fact the digest shows (a guard already dead, a job already
  paid) is a continuity error, and the translator drops the obvious cases (§4).

Never decide the captain's own choice (a card's side resolved for them). The captain's life is
not special **(owner)**: "Captain can die any way a regular crew member can die. We will change
things later if need be." Command passes to the first officer (D8) and play goes on.

## 4. Outcome levers

Each is a kernel command on the narrator allow-list with a translator guard that is only
"impossible", an event with a ticker line (§5.3), and an intent in the plan schema with tiers
where a tier will do. Cost: cheap (translator, intent, a handler over an entry point that exists),
medium (a new system path), big (new sim behaviour).

### 4.1 Wound, down or kill a person (cheap; the entry point exists)

`strike { actorId, severity: light|serious|grave, type, part?, byActorId?, how }` through
`applyDamage` (`systems/bodies/damage.ts`, the one damage entry point): the body rules then say
whether they are down or dead (head or torso at tolerance, blood below `deadBelowBlood`,
`bodies.ts`, which emits `died`), and bleeding, healing and incapacity follow. A `grave` head
`strike` is a death by rule, not a flag; the narrator never writes `dead`. `how` is one line the
ticker shows ("Jax Okonkwo is hit in the head" already exists for fights; aboard it reads from
`how`: "Jax Okonkwo falls from the hold ladder").

When: in a fight (the narrator's strike lands like any shot, with `byActorId` a cast member);
aboard (a fall, a burn at the stove, a blow in a brawl, §4.3); never off-screen, because the body
is on the deck and the crew react (`sawCrewHurt`, the medic's task). Impossible: no such actor,
already dead, a passenger ashore, a cast member not on the floor. The captain: §5.1. Dispositions
in a fight: a dead guard leaves the fight by the existing removal.

### 4.2 Money: a price, a sum, a payment (cheap)

- `offerJob.pay` already carries the number the engine computed from the tier; add `payCredits`
  (0 for "use the tier") so the narrator can name the sum when the story is the sum ("he offers
  eight hundred, which is too much").
- `transact { amount, memo, counterparty }` writes `money.balance` and a `Transaction` (the
  ledger that `MoneyState` already keeps): a bribe paid on a card side, a fine at the gate, a
  parley's `money` offer (expeditions design §9.1, now in bounds), a windfall. Impossible: a
  debit the balance cannot cover (the translator knows the balance), a credit above
  `narrator.maxWindfall`. The sum never appears in card text (§cards-never-mention-pay stays: the
  top bar shows money; the card says "it costs us").
- `stockMarket` keeps its tiers; a `price` override is the same change as `payCredits`.

### 4.3 Relationships, and a falling-out (cheap to medium)

Affinity is not stored; it is compatibility plus memories (`affinityOf`, `core/social.ts`), so the
lever is a memory. `plantMemory { from, to, key, lasting }` through `addMemory`
(`systems/social/relationships.ts`), with new narrator-only keys in `MEMORY_KEYS` sized to carry a
story (`betrayedMe` −5, 14 days; `owesMeMyLife` +5, 14 days; `wrongedOverSomeone` −4, 10 days;
`madeItRight` +3), content-tuned so a planted memory can push two crew past the ±3 that makes
them "close to"/"at odds with" on the digest and the seats. `lasting` **(owner)** makes it never
expire (a season's grudge), cleared only by another planted memory between the same two. Impossible: an actor not aboard, a
key not in the set, `from` is `to`.

A **falling-out** is `plantMemory` both ways plus an `argument` event, which the social system
already emits from a debate, so the ticker, the digest's "rivalries" line and the `argued` thought
all fire from the existing path: `fallOut { a, b, over, violent }`. With `violent`, each takes a
`light` `blunt` `strike` from the other (§4.1) and the thoughts and memories of a sparring knock;
"violent" is bounded to light by rule so a brawl hurts and never kills. There is no brawl
animation today (sparring is an activity with a knock as its risk); the medium part is a short
`brawl` activity so the two are seen in the lounge trading blows for a few seconds before the
event, in a later slice. The owner's "over a girl" is the `over` line in the event, a passenger
or a cast member by name, and the thread the notes keep.

### 4.4 Reinforcements and turns at a site (cheap; designed)

The expeditions design's scripted turns (§9.3) become live commands rather than a `stageSite`
script: `arriveAtSite { entries: SiteCastEntry[], post }` spawns cast through `spawnCast`
(`start.ts`, already parameterised by entry and post) at an `exit` post with the arms the entry
says; `turnCast { who, does: flee|turn|comeToTheRamp }`. Impossible: no expedition under way,
over `SITE_LIMITS` (six people, three armed), a post not on the map, a name not on the floor. The
narrator may now also `strike` the target or remove them: the §9.3 guard "never wound, kill, move
or remove the target" is D6(b) and goes **(owner)**: "Narrator can do whatever they want."

### 4.5 Force a roll (cheap)

- `scheduleHazard.outcome: "" | clean | scrape | delay` skips the roll in `hazardOutcome`
  (`hazards.ts`) when set; `navHazard` still fires with the stander and the outcome, so the story
  is the pilot's and the pilot's skill still decides when the field is empty.
- `injectFault { machine, faultKey }` is `scenarioInjectFault` promoted to the narrator (the
  handler exists; the symptom problem opens by the existing rule). It spends the fault budget.
- `scheduleField.scripted` already is a forced roll; its target may now be a person (a rock
  through the hold with Priya in it is a `strike` at that moment), under §5.1.

### 4.6 Move people (medium; defer)

The planner owns positions, and a position written under a task's feet is the kind of thing the
compiler cannot find (D59's lesson). `comeToTheRamp` for cast (§4.4) is the one move that is
cheap. For crew, the honest lever is a task: `sendTo { actorId, room, why }` opens an essential
problem the planner routes them to. Defer until a story needs it; the digest shows where people
are and a card can summon anyone to the cabin already (`privateTalk`).

### 4.7 Knowledge (cheap)

`reveal { faultId }` makes an undiscovered fault's symptom public (the `sensor` channel path,
§symptoms), so the engineer "notices" when the story says so; `giveThought { actorId, key, ref }`
plants a thought from the closed `THOUGHT_KEYS` with a ref, so someone can be `worried` about a
named person before any card says why. Impossible: no such fault, a key not in the set.

### 4.8 Passengers and the dock

`endPassage` exists; the narrator may now also `transact` a fare, `strike` a passenger aboard,
and state a passenger's fate ashore in prose. Story calls may `placePerson` on the dock (today
staging-only, `STAGING_COMMAND_KINDS`).

## 5. The guardrails that remain, and why

None of these is D6(b). They are craft, and they live in the prompt and the translator's
"impossible", not in a content ban.

### 5.1 The captain

No special rule **(owner)**: the captain can die any way a crew member can, aboard or at a site,
by the sim's fire or the narrator's `strike`; D8 passes command to the first officer and play
goes on. The design-partner's proposed guardrail (only in a fight, only after a card named the
stake) was declined: "we will change things later if need be." The prompt keeps one craft note,
not a rule: a death the captain could not have seen coming is the strongest card the narrator
has, and it is spent once a game.

### 5.2 Impossible, and the sim's limits

The translator and the kernel keep the sim coherent: ids exist, caps hold, the balance covers it,
the leg is still ahead, a dead actor is not struck twice. The hull guard on `scheduleField` stays
as a refusal, since a lost hull ends the game and that is a game-design limit, not a story one.
Budgets (spawns, faults, hazards) become advice **(owner)**: counters the digest shows and the
prompt reads, the kernel no longer refusing; a narrator that spends every budget every call is
told so by the pacing rule. Rejected: hard caps, which are D6(b) by another name.

### 5.3 Shown, never silent

Every outcome lever emits an event of `narrative` significance with a ticker line, and the digest
shows the state it changed next call, so the player sees the death on the deck and the narrator
sees it in "recent events". The prompt rule replacing "never narrate what the digest does not
show": *what you decide, you show: a death gets a card from someone who saw it, a debt gets its
line on the ledger and a word on a card, a falling-out gets the loser's card; never a fact in
prose that no lever made true.* The text checks stay (no numbers, no undiscovered fault, no
secret phrase), and so does "a card may state what someone claims": the narrator may lie through
a character and may not lie through the ticker.

### 5.4 What keeps the sim mattering

- The narrator acts only at its calls, six or so an episode and spaced (§call-spacing); the hours
  between are the sim's, and most of what the captain watches is never narrated.
- A lever is a noun the sim plays: a `strike` bleeds and heals and the medic is pulled off the
  engine; reinforcements take cover and break by morale; a planted memory changes who sits with
  whom for ten days; a forced `scrape` scars the hull the crew must plate. The narrator sets the
  fact; the consequences are the sim's and are what the next card is about.
- The fight stays mostly the captain's: the plan menu is the sim's, the captain picks, the fire
  and the breaking are rolled. The narrator stages (cast, stance, reinforcements, a death the
  story needs) and may take the target off the board; the prompt asks it to say why in
  `rationale` when it does, since a win the captain did not earn is a card that teaches nothing.
- Odds (§8) are a real roll on the captain's choice: the narrator names the chance, and below a
  hundred the dice can still say no.
- "Spice" is the sim surprising the narrator too: the prompt tells it to read what the sim did
  before deciding more, and the plan's cascade (§6.4) is built for the sim deviating.

## 6. The plan: season, arc, episode

### 6.1 What a pace sketch is, concretely

An ordered list of named beats, each with a one-line intent and a tension tier, and (for the two
upper tiers) a condition for moving on. Not an intensity curve, not positions in time: the
narrator reasons badly over numbers, and the sim has no clock an episode runs against. Named
beats with a tier are how the prompt already describes a good episode.

```
PlannedBeat {
  name: string                 // 2-6 words: "Jax dies at Harrow End"
  what: string                 // one line of intent, max 160 chars
  tension: "setup" | "breath" | "rising" | "turn" | "peak" | "release"
  thread: string               // "" or the exact title of an open thread it advances
  decided: boolean             // the narrator means to make it so (a lever), not hope for it
  status: "planned" | "landed" | "skipped" | "changed"   // server-kept, §6.4
  landedTick: number | null    // server-kept
}
ArcSketch {
  premise: string              // one or two sentences; for the season, the question it asks
  beats: PlannedBeat[]         // episode 3-6; arc 3-5 (one per episode); season 3-5 movements
  until: string                // when this sketch is done (empty for the episode)
  tempo: "slowBurn" | "steady" | "headlong"   // §6.5
  revised: string              // why it last changed; "" when never
  revisions: number            // server-kept
}
NarratorNotes.plan { season, arc, episode: ArcSketch }
```

One shape at all tiers; an episode beat is a card, an offer, a pressure or an outcome lever, an
arc beat is an episode, a season beat is a movement. `decided` is new with D106: "Jax dies at
Harrow End" is a beat the narrator lands with `strike` at the peak; "the crate is not a crate" is
a beat the captain's choice and the dice may bend. The prompt asks for a mix: an episode with
every beat decided is a cutscene.

### 6.2 How it fits the threads

Threads stay as memory (what happened, who is in it, `nextBeat` as the trigger); the plan is
intent. They meet at `PlannedBeat.thread`. Rejected: folding the plan into threads (a season
movement spans many threads; a beat may be a pressure with no thread) and replacing `nextBeat`
(the trigger `mergeThreads` and the prompt lean on). The `beat` scale becomes redundant once a
follow-up card exists (§7.2); drop it in a later cleanup.

### 6.3 Who writes it, and when

The notes turn (§notes-turn), as part of the notes it already rewrites in full; no new call. The
notes schema (`buildNotesSchema`) gains `plan`; `notesRequest` (`run.ts`) prompts for a tier at
game start ("no season stands: sketch one", after the first offer, so it is not written blind),
at episode open (`captainAshore` with no live episode: the offer is the episode's `setup`), and at
episode close (`contractCompleted`, `passageEnded`, `jobFailed`, the closing card). **(owner)**
"Plan at the usual time. Might need to make the planning agent more powerful (ie tool use) to be
able to do everything we're asking it." Rejected: a planning call at game creation. Tool use for
the notes turn is §6.7.

### 6.4 Revision, the cascade, and honest bookkeeping

With D106 the plan deviates for two reasons, not three: the captain chose the other side, or the
dice (§8, the sim's own rolls) went the other way. The narrator's own decided beats land when it
lands them. The prompt: *revise the episode first; mark beats the deviation makes impossible
`changed`, add the beats it demands, keep landed ones; if the episode's ending changed, check the
arc; if the arc's premise no longer holds, the season; say why in `revised`.* The worked example
inverts the first draft's: the plan has `peak: Jax dies at Harrow End (decided)` and the captain
picks the side that holds the ramp, so Jax never goes in; the narrator may still `strike` Jax on
the ramp (in bounds) but the prompt's rule of three says the captain's choice was the point, so
it marks the peak `changed`, lands `turn: the keeper's man comes to the ramp` with `turnCast`,
and moves "Jax dies" to the arc's next episode, where the captain's refusal is the reason it
costs more.

`mergePlan` (`notes.ts`, the sibling of `mergeThreads`):
- Attribution by name: `surfaceDecision`, `offerJob`, the pressures and every outcome lever gain
  `beat` (empty, or a planned episode beat's exact name). A card or offer lands at the hook tick.
  A pressure or outcome lever lands **when it fires**: the beat holds the translator-minted command
  id (`cmd:narrator:<callId>:<n>`, kept by the kernel as `causeCommandId`), and the next call's
  `recentEvents` are matched by it (`faultOccurred`, `navHazard`, `fieldEntered`/`fieldSighted`,
  `wounded`/`died`, `argument`, `transaction`, `expeditionCastArrived`) to stamp `landed` at the
  event's tick; one the kernel dropped or the leg left unfired goes back to `planned` with a
  correction line. The model never writes `status` or `landedTick`.
- A landed beat the model omits is kept and reported; an omitted tier is kept whole; a rewritten
  tier bumps `revisions` and its previous premise rides one call as "was: …".
- A closing card marks still-planned beats of that thread `changed`.
- `NOTES_LIMITS`: six beats a tier, `what` 160, premise 300; about 1,500 characters stored.

### 6.5 Tempo, the season's life, and stalls

**(owner)** "a narrative pace sketched as part of it." `tempo`, one word a sketch, says how thick
the breaths are between forward beats: `slowBurn` (two or three small things between forward
beats; the long spur legs), `steady` (the prompt's rhythm), `headlong` (forward beats back to
back; an episode with a death in it, a finale). The one thing the beat list cannot say, and cheap.
Advisory, never a timer (D46); the episode's tempo wins over the arc's over the season's.

A season ends when its `until` holds, by the narrator's judgement: a finale `release` beat, and
the notes turn after the closing card ends it; the server appends it and its arc to `pastArcs`
(scale `season`; premise as `shape`) and asks for the next, knowing "Past arcs". An abandoned
season ends the same way with `revised` saying so. The arc stalls when the captain takes work that
touches none of it: after three episodes without an arc beat the server says so and nothing more;
the narrator may bring the arc to the captain (its people at the next port, §7.5), retime it
(the arc walks into the next job), or let it go. The prompt prefers the second: the narrator is
the only source of work (D40), so an arc beat can always be the next offer, and with D106 it can
walk in with a lever.

### 6.6 The digest

"Your plan", never trimmed, after "Your notes so far": each tier's premise, revisions, `until`,
and its beats with status and tier, the episode's with ticks; then "You are at the turn (tempo:
steady)", the first beat not landed, computed from the server's stamps. The server states the
record and nothing more: no advice line, which would be the server making the pacing judgement
the owner withdrew (D46). About 300 tokens a call; +300 to 500 output tokens a notes turn, off
the player's wait; the staging call is not shown it (D57).

### 6.7 Tool use for the notes turn

Today a call is one chat completion (`openrouter.ts`: a `messages` array, the static system
blocks with `cache_control`, no `tools`), and the notes turn is a second completion in the same
conversation (`run.ts` `runNotesTurn`). Everything the model may want is stuffed into the digest
in advance, under a 10,000-character budget that drops low-priority sections first
(§digest-sections-and-budget). The plan, the season's past arcs, a cast of twelve and the sites
all compete for that budget, and the notes turn, which is the one asked to think across them,
gets exactly what the plan call got.

Tool use would give the notes turn a loop: the model asks, the server answers from the snapshot
and notes, the model writes. Tools worth having, all read-only over data the server already
holds: `pastArcs(scale?)`, `thread(title)`, `castMember(name)`, `site(id)` with its cast and
posts, `cardsShown(n)` beyond the digest's twelve, `crew(name)` with the full crew line, and
`eventsSince(tick, type?)`. What it buys: a planning turn that can read the whole game when it
revises a season (forty past arcs are already outside the budget, but the sites and the cast are
not), a smaller digest for the plan call (the plan call stays one-shot: it is on the player's
wait, under `NARRATOR_TIMEOUT_MS` 25 s inside Vercel's 30 s), and a path to issuing levers as
tool calls later (D53 already names "one tool per intent" as the owner's preferred shape and
"the likely next shape"). What it costs: a tool loop in the transport (`ModelTransport` becomes
multi-turn, with OpenRouter's `tools`/`tool_calls` and the reasoning-details round trip the notes
turn already does), two to four more round trips a notes turn inside `NOTES_TIMEOUT_MS` 45 s, and
a live test per tool. Where it fits: after the plan is in notes (slice 3) and before the notes
turn is asked to run a season across a long game; recommended as its own slice (§9, slice 5),
read-only tools first, levers-as-tools when the plan schema next outgrows its prompt budget.

## 7. Pacing levers

Levers that place a beat in time and compose. All cheap unless marked.

- **7.1 A card that comes up later.** `surfaceDecision.when: now | departure | midLeg |
  nextPort` (the `CALL_BACK_WHEN` moments); stored in `state.narrator.scheduledCards`, surfaced
  by travel through `queueOrHold`, dropped with a trace line if its speaker is gone, its thread
  closed or a card is on screen; counts as the call's one card. Words frozen at translation where
  the text checks run; the window is a leg at most.
- **7.2 A follow-up card.** `DecisionOption.nextDecisionId` exists and nothing narrator-side uses
  it. `surfaceDecision.followUp { on: left|right|either|"", card }`: a two-panel scene in one
  call, counted as one card; no nested follow-ups. The mechanism §8 branches on.
- **7.3 Call-back moments.** `callBack.when` gains `arrival` (the approach lead point) and
  `afterCard` (the tick after the next card resolves); `callBack.holdQuiet` doubles the quiet
  window once. The narrator owns its own quiet; the sim imposes none (D46).
- **7.4 Pressures and outcomes at a moment.** `scheduleFault`, `scheduleHazard` and the outcome
  levers of §4 gain `at: now | early | middle | late` of the leg, resolved as `FIELD_MOMENTS`
  are, so a departure call shapes a leg: a card at `departure`, the field at `middle`, Priya's
  fall at `late`.
- **7.5 Cards delivered at a later port.** `surfaceDecision.at: <portId>` with a speaker whose
  cast entry has that `portId` holds the card (`HeldCard`) until the ship docks there; dropped
  past `narrator.heldCardMaxDays`. A season thread's returning face without a call.
- **7.6 Side effects.** `holdDeparture` (`holdDepartureForRepairs`, a player command already),
  `transact` on a side (a bribe the captain chooses to pay), `withdrawParty`/`adoptPlan` on a
  narrator card at a site, `strike` on a side only through odds' failure branch (§8.3).
- **7.7 The expedition's range** (big, designed): `stageSite` with cast and stance, parley
  (§9.1 of the expeditions design, `money` now allowed), the approach effect (§9.4).

Every lever takes `beat`, so a planned beat lands as a later card, a follow-up, a pressure at a
moment, an outcome at a moment, or a face at the next port, from one call.

## 8. Narrator-set odds

### 8.1 What odds are for, now

With D106 the narrator can simply decide, so odds are not how it shapes outcomes; they are how it
keeps its hands off the captain's. A side with odds is the narrator's honest read of a choice the
captain made ("go in quiet" against a guard the notes say is half asleep), and the kernel's roll
is what keeps the narrator from always getting its way on the one thing that is the player's.
The framing stays "the narrator loads the dice; the sim throws them" (expeditions design §9.1):
the narrator names the chance, one `chance` draw on the seeded `narrator` stream (`RNG_STREAMS`)
at `resolveDecision` decides, stored with the save and replayable (D4's streams), the same shape
as `scheduleHazard`'s difficulty and as `markUnseen`.

### 8.2 Where odds attach

To a card side, as `unseen` does today:

```
decisionSide { ..., odds: "" | "0".."100" (a whole percent as a string), failLabel }
surfaceDecision { ..., leftFailAftermath, rightFailAftermath,
                  followUp { on, card }, failFollowUp { on, card } }
```

A side with `odds` is a try: the kernel rolls once, writes `Decision.tried { odds, worked }`,
emits `attemptRolled` (`notable`, not hooked; the follow-up is the reaction), and runs the branch:
the side's commands, aftermath and `followUp`, or its `failCommands`, `failAftermath` and
`failFollowUp`. The card stays binary; the branch is inside the side. On the arrival card
`card.unseen` becomes `unseenOdds { side, odds }`: `markUnseen` carries the chance, `adoptPlan`
rolls when that side is chosen, `notice` is `unseen` on success and `seen` on failure; `hold`
still cannot be marked.

### 8.3 What "working out" gates

1. Prose and the next card: aftermath and follow-up differ by branch.
2. Effects by branch (`effect`/`failEffect`), from the side-effect list of §7.6; with D106 the
   failure branch may carry an outcome lever (`strike` light on the one who tried, `transact` the
   bribe lost, `turnCast` the guards alerted), which is how "push the envelope" costs something.
   Side commands run as `player` today (`AUTHORITY.player`); a failure branch runs its outcome
   levers as `narrator`, minted at translation and applied by `resolveDecision`, so the authority
   list is unchanged.
3. The expedition's notice, and parley's chance when §7.7 lands.

The translator refuses odds on beat and closing cards (sides are the captain's attitude), and a
try whose branches are identical.

### 8.4 A number, unbounded, voiced as the narrator likes

**(owner)** on what the player sees: "Whatever the narrator wants to say. A scientist might
literally say 'captain I estimate 20% odds'." So the narrator writes the chance itself, a whole
percent from 0 to 100, with no clamp **(owner)**: "constrain the narrator as little as
possible." A 0 or a 100 is a decision dressed as a try, which D106 already allows; the prompt says
so, and says a try is for a chance the narrator means. How it is voiced is the card's
own business: the scientist says twenty percent, the deckhand says "a long shot", the first
officer says nothing and the side carries no hint. Rejected (the first draft): a hidden four-tier
map with generous numbers behind the labels. With the narrator naming the number there is no map
to hide, and a scientist who says twenty and is right one time in five is the honest version of
"players overweight failure"; the prompt keeps a craft note that a stated chance is a promise the
dice keep, so round up when unsure and never say "likely" of anything under sixty.

The text checks change in one place: §player-facing-text-checks refuses a percentage and a
numeric consequence in any player-facing text. A side's `odds`, and a percentage in a card's
situation or a side's label that equals that side's `odds`, are exempt; any other number is still
refused, so pay, distances and hull never leak through the exemption. The client shows the
number nowhere the narrator did not: `Decision.tried.odds` is for the roll and the history.

### 8.5 What the narrator is told, and when odds are fair

`CardShown.tried` and the digest line `chose "Go in quiet" (70%): it failed`; the roll is folded
into the thread's arc notes. Prompt: odds belong on a choice whose chance the captain could judge
from the card and the story; never a long shot on a side the card made look safe; the failure
branch is a story, not a punishment; odds are rare, one tried side a card and most cards none;
decide instead (§3) when the captain's choice is not what it turns on.

## 9. Phasing

Small shippable slices, each green on the four checks and spec'd in the same commit.

1. **D106 and the prompt's rule of three.** The decision entry, D6's superseding line, the spec
   rules of §2.3 rewritten, `prompts/system.ts` first principle and the rules of §3 and §5.3,
   `pnpm test:live`. No new command yet; this slice changes what the narrator thinks it is for.
2. **The first outcome levers.** `strike`, `transact` with `offerJob.payCredits`, `plantMemory`
   with the narrator memory keys, `fallOut` (non-violent), `injectFault`, `reveal`, `giveThought`,
   `scheduleHazard.outcome`: each a handler over an entry point that exists, with its events and
   ticker lines, the translator's impossible-guards, and the budgets turned
   to counsel. Spec: a new "Outcome levers" section in `narrator-story.md`.
3. **The plan in notes.** `PlannedBeat`/`ArcSketch` with `decided` and `tempo`, `mergePlan`,
   `beat` on every intent with fire-time landing, "Your plan" in the digest, `notesRequest`
   lines, the revision and cascade rules, season life.
4. **Odds on the sneak-in.** `unseenOdds`, `markUnseen` with a chance, `adoptPlan` rolls,
   the text-check exemption, the result in card history and the
   site line, an odds column in `crew expeditions`. The owner's own example first, on two
   existing handlers.
5. **Tool use for the notes turn** (§6.7): the tool loop in the transport, read-only tools over
   the snapshot and notes, a live test per tool.
6. **Follow-up card, call-back moments, odds on narrator cards.** `followUp`, `arrival`,
   `afterCard`, `holdQuiet`; then `odds` with fail branches, `Decision.tried`, `attemptRolled`,
   failure-branch outcome levers.

Later, when a story needs them **(owner)**: "you don't need to build it now" of the examples.
`arriveAtSite` and `turnCast` (reinforcements), `fallOut` violent and the `brawl` activity,
`placePerson` on story calls, later cards (§7.1), `at:` moments (§7.4), port-held cards (§7.5),
`sendTo` (§4.6), and the expedition's range (§7.7: `stageSite`, parley with `money`, the approach
effect). Each is designed above so that the slice that builds it is a day's work with no new
decision.

## 10. Owner rulings on the draft's questions

Ruled **(owner)**, folded in above: odds are voiced however the narrator likes, numbers included
(§8.4); the captain dies like anyone (§5.1); the plan is written at the usual time, with tool use
if the planning turn needs it (§6.3, §6.7); budgets are advice (§5.2); episode titles in the log
"later if ever"; the narrator may strike or remove the errand's target (§4.4); a decided death
between calls is fine on screen (§7.4: an `at:` moment on the deck, the ticker and the crew's
reaction showing it; never off-screen); reinforcements and the violent falling-out are examples,
not a build order (§9); the notes turn's tools are read-only first (§6.7); odds are not clamped,
"constrain the narrator as little as possible" (§8.4); a planted memory may be `lasting` (§4.3).

## 11. Rejected along the way

- **A narrator that writes state directly**: loses the translator's checks and the invariants;
  D6(a) stands.
- **A state machine for the plan** (the server advances beats on events): D46. The server stamps;
  the narrator decides.
- **A hidden tier map behind the odds** (the first draft): with the narrator naming the number
  there is nothing to hide (§8.4).
- **A captain-death guardrail** (fight only, stake named): declined by the owner (§5.1).
- **Odds on other policy cards** (the departure gate, the overdue passenger): their sides are the
  sim's rules.
- **A separate "try" card type**: D54.
- **Rolling at translation time**: the roll would precede the choice and leave the seeded stream.
- **Keeping §9.3's "never harm the target" and the budgets as kernel refusals**: both are D6(b);
  what is impossible stays impossible, what is unwise is the prompt's.
