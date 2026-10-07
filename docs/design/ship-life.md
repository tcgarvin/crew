# Ship Life: Watches, the Mess, Dirt, Off-Watch, Cabins, and Freighter Mk2

Status: proposal revised after owner review, 2026-10-04. Not yet implemented. Drafted with Fable
as design partner (first draft by Fable, one critique round), then revised with the owner's
rulings (§13). Written against GDD §2/§4/§8/§17/§25/§26, SD §9.5/§11/§15, Dockside §3, the v1
playtest note, and the deck/dock/config JSON. Decisions go into `docs/DECISIONS.md` as each
slice lands.

What exists today, briefly: four needs (hunger, fatigue, comfort, social), `mood` always 0; crew
on duty with nothing to do stand idle at a role post; shifts only toggle on/off duty; the helm
must be staffed only for departure and docking, by anyone; the cook role, cooking skill and stove
do nothing (everyone eats ration packs from the hold); eight unassigned bunks; ambient chat has no
effect; no dirt, recreation, interests or relationships; no skill checks of any kind; every dock
map draws the 32×18 Mk1 footprint into its rows; the bow is west.

## 1. The core idea: a day with a shape

Today every crew member runs on a private random walk: hunger fires, they eat; fatigue fires,
they sleep 90 s; otherwise they stand at a post. Nothing is synchronised, so nothing reads as
*ship life* at 1x on a phone, only as eight dots jittering. The richness comes from three
things, in this order: **rhythm** (the ship's day has bells, and bells pull people to the same
places at the same times: the helm changes hands, the mess fills, the off-going watch drifts to
the lounge), **grouping** (activities that need two to four people, so dots cluster around a
table and the ticker says who won), and **residue** (mood "thoughts", pair affinity, rivalries,
dirt, an assigned cabin, so the same two people keep ending up at the same card table and the
narrator can name that). The player sees: the bell in the ticker, a dot walking to the helm and
another leaving it, "at the helm" / "cooking" / "playing cards with Jax" / "mopping the galley"
labels, a dirty trail from the cargo ramp after a loading at a muddy port, and an inspector line
like "Mood: low (lost at cards again; bunkroom is filthy)". Every system below is justified by
one of those visible beats; anything that only moves a hidden number is cut.

## 2. Time and watches

**Terminology.** *Watch* = a duty period. *Section* = the group that stands it (Red, White,
Blue; three-section rotation). *Watch bill* = the roster (content/config, never player-edited).
*Bell* = the ticker/audio beat at each change: "Bell. White section has the watch." *Dayworker*
= crew not in a section (cook, medic, deckhand) who work by the meal/cargo rhythm, not the helm.
Drop "shift" from UI and rename `config.shifts` to `watches`. One bell per change; do not
reproduce the eight-bells half-hour system, it's illegible.

**Day length: 1200 s for now.** A 10–30 min session at 1× is then half to one-and-a-half days.
The owner accepts this provisionally: with much more happening, more play will be at 4–8×, and
the day length, beat spacing and need rates will all need retuning together. §9 makes that a
small number of knobs. What is clearly wrong today is *sleep*: 90 s of sleep makes "asleep in
her cabin" a state nobody ever sees. A full sleep becomes ~240 s (a fifth of the day). An
off-watch person then has 800 s: ~240 asleep, ~60 eating, ~200–300 recreation, ~100
rounds/cleaning, slack. No ship "night": continuous watches mean someone is always awake and the
canvas never goes still.

**Structure: three watches of 400 s.** About one meal per watch keeps everyone fed (§5), and one
sleep per day suffices, so most people sleep in the same off-watch window every day, which gives
each person a legible routine ("Priya sleeps after the second watch").

**A watch is a section rhythm, not a station schedule.** The section's post swaps with the
ship's state: underway it is the helm; docked it is the gangway. The bell fires regardless, and
meals and off-watch time hang on the bell, so the rhythm pays off even though a session is
mostly docked (estimate: 60–70% docked, 30–40% in transit). **Long hops are at least one watch
(400–800 s)** so a handover at sea is actually seen (owner: agreed).

**Helm as the duty station.** Rename `bridge_console` to `helm`, keep `pilotStation` +
`requiresOperator` + `operatorSkill piloting ≥3`, and *read* that skill (it is ignored today).

- Underway (undock, depart, transit, approach, dock): the section's helm-stander holds
  `staffStation` at the helm, label **"at the helm"**. Any other crew within 1 tile is *not*
  staffing (that fixes the "idle beside the console" complaint for real).
- **Handover**: at bell − 30 s the oncoming stander gets a `relieveHelm` task (essential class).
  They walk to the helm's second interaction position (`standby`, added to the machine def), a
  5 s `handover` action runs with both present, then the off-going is released. Ticker: "Jax
  relieves Noor at the helm." If the oncoming is late, the off-going holds; after 1.25 × watch
  length they get the thought *stood a long watch* (−).
- **Relief for needs**: a stander whose need passes `needEssentialAbove` raises
  `stationToStaff(helm, relief)`; the nearest qualified off-watch crew takes it as *routine*,
  stands in for up to 120 s, the original comes back. If nobody arrives within 45 s and the need
  is survival class, the stander leaves anyway. Leaving has a cost; it is not forbidden.
- **Vacancy is a gate, not a slowdown** (owner). An empty helm blocks the manoeuvres: the ship
  cannot depart, cannot begin or continue approach, and cannot dock; each holds in place until
  someone takes the helm. In transit the ship flies straight on with no progress penalty. The
  teeth are **piloting checks** (§6): an unattended helm fails them outright, or takes a heavy
  penalty where the check allows a "flying straight" outcome. After 20 s unattended in transit
  the sim emits `helmUnattended` (ticker "Nobody at the helm", narrator fact), which is also an
  invitation for the narrator to schedule a hazard.
- **Docked**: no helm watch; the section's helm-stander stands **gangway watch** at a post
  inside the airlock by the personnel ramp, label "on the gangway". That person is the one dock
  hands and the narrator's card-bearers find (`meetSpeaker`), which should cut `dockHandGaveUp`.
  A dot at the ramp while docked.
- **Qualified**: piloting ≥3. Today that is Mara 6, Jax 8, Dane 4: exactly three. **Add a ninth
  crew member** (owner: agreed): a junior with piloting 3 who learns at the helm (wire
  `work.skillGainPerSecond`, unused today, to the `staff` hold). That gives four qualified
  pilots for three helm watches. Nine is about the legibility ceiling for a phone canvas.
- Skill as fallback: if nobody qualified is available (injury, ashore), the planner takes anyone
  with piloting ≥1, who stands the helm and rolls piloting checks at their own skill. The
  narrator sees "helm stood by an unqualified hand".

**Officer of the watch.** The captain does not stand the helm. A section with an officer in it
has an *officer of the watch*. Their characteristic on-duty activity is **rounds**, not sitting
(owner: the captain should walk around while on duty): walk to engineering, the hold, the mess;
look in on whoever is working; exchange a word with the helm. Rounds do real work: the officer
notices dirt (raises the room's cleaning problem into their knowledge), hears a machine symptom,
and has short conversations that move affinity ("the captain checked on me" is a thought). The
captain's chair is only the place they go when there is nothing else to do; it is not a hold
and does not pin them. A helm vacancy pulls the officer of the watch back to the bridge to take
it, which is a visible beat. Docked, the gangway is stood by the helm-stander, never an officer,
so the captain goes ashore to look for work as today and the FO is officer of the watch aboard.

**Watch bill** lives in the scenario (`watchBill: { sections: [{ key, members }], dayworkers }`)
with an auto-generator when absent (greedy: one helm-qualified per section, spread engineers,
rest by role). Proposed default (9 crew): Red = new junior (helm), Mara (officer of the watch),
Priya, Bettina*; White = Jax (helm and watch), Tomas, Sunniva*; Blue = Dane (helm and watch),
Oyelaran*. Starred people are dayworkers listed in a section only so the "who is on" line reads
cleanly; their duty window is a long day span with sleep forced in the gap. The junior standing
the helm under the captain's eye makes their skill growth a supervised story. The player never
edits the bill.

**Short-handed rotation: deferred.** Today it can barely happen: there are no injuries and
nobody leaves the crew, and with four qualified pilots a single absence is covered by the
officer of the watch. Build only "the next qualified person covers, and accrues fatigue and a
*double watch* thought for it". Whether a lasting shortfall re-forms the bill automatically
(two sections of 600 s, *port-and-starboard watches* thought) or comes to the captain as a card
is decided once injuries exist.

## 3. Recreation and interests

**Need model.** Add one need, **recreation**, reaching the seek threshold in a bit under a day.
Keep hunger, fatigue, comfort (shown as "rest"), social. Do not add hygiene: a need with no
story. Add **mood** as the one aggregate that everything feeds, RimWorld-style but tiny:
`thoughts: [{ defId, value, expiresAt, refId? }]`, mood = clamp(Σ value, −1, 1). Thoughts are
content (`thoughtDef { id, label, value, duration, stacks? }`). Effects, bounded: mood < −0.4 →
workSpeed 0.9, declines group invites; > 0.4 → workSpeed 1.05, initiates groups. Mood and its
top three thoughts go into the digest. This is the glue: meals, cabins, dirt, cards, watches all
land as thoughts, so one mechanism makes every other system *felt*.

**Interests.** Per actor: `interests: { likes: InterestTag[]; dislikes: InterestTag[] }` and
`values: { orderFreedom, faithReason, loyaltyAmbition }`, each −2..2. Tags (content enum):
cards, boardgames, vids, debate, music, exercise, sparring, reading, tinkering, cooking,
stargazing, gossip. **Topics** are content: a small authored pool of 6–8 evergreen topics
(philosophy, politics, the Guild, faith, a sports league…), each carrying a weight vector over
the three value axes; a person's stance on a topic is the sign and size of the dot product. That
is cheaper than per-topic stances and generalises to new topics. In slice 5 a narrator
`seedTopic` command (topic + weights + expiry) lets ports bring news aboard ("the Guild raised
docking fees") that becomes the thing everyone argues about for a while; a vid the lounge
watched becomes a topic for free once sessions emit topics. Generation: 2 likes (one marked
strong), 0–1 dislike, values drawn from a bounded distribution; the starting nine are
hand-authored (Bettina: music + cooking, owns the harmonica; Mara: stargazing + reading; Jax:
cards + vids; Tomas: sparring + cards; Priya: tinkering + debate; Oyelaran: reading + debate;
Sunniva: exercise + gossip; Dane: boardgames + music). Interests are soft state the narrator may
nudge (GDD §17).

**Relationships.** Affinity in −10..10, directed, and derived rather than stored (D88, after
RimWorld's social memories and Dwarf Fortress's personality-driven bonds): a pair's
*compatibility* (±2, fixed by how far apart their values sit and which likes they share or
clash on) plus the *memories* one holds of the other (a good chat, a game, an argument, a private
talk), each with an opinion, a duration in days and a stack limit. Repetition holds a memory's
weight but never grows it, and memories expire, so affinity settles where a pair's company keeps
it instead of climbing for as long as the game runs. Ambient chat leaves `chatted`, or
`rubbedWrong` with a chance that falls with compatibility, so pairs who do not click cool by
talking. Seat and partner choice prefer affinity > 0 and avoid ≤ −3, so cliques appear on the
canvas without any new system. (Slice 4 shipped a running total; it reached +10 within a week.)

**Activity definition (content, Zod).**

```
ActivityDef {
  id: "activity.cards", label: "playing cards", interest: "cards",
  venue: { machineTag?: "gamesTable", compartmentTag?: "lounge", itemTag?: "deck_of_cards" },
  participants: { min: 2, max: 4 }, duration: "0.1 day", offWatchOnly: true,
  restores: { recreation: 0.4, social: 0.3 },
  solo?: { label: "playing solitaire", restores: { recreation: 0.2 } },
  outcome: "contest" | "bond" | "debate" | "perform" | "none",
  thoughts?: { win, lose, joined, listened },          // thoughtDef ids
  affinity?: { participants: +1, winnerToLoser: 0, loserToWinner: -1 },
  topics?: TopicId[],                                   // debate only
  skillGain?: { skill: "engineering", perDay: 0.2 },
  risk?: { injuryChance: 0.05, severity: "minor" },     // sparring
  dirt?: 0.05, noise?: true
}
```

**Joining.** An off-watch actor with recreation above the seek threshold scores each activity by
interest (strong like 3, like 2, neutral 1, dislike 0) × venue availability; group activities
need a `GroupSession` (state entity: activityId, venue, members, opensAt, startsAt). The
initiator opens one; it is announced ship-wide (the intercom: on a 36-tile ship everyone knows
cards are on). Others with score ≥2 walk over; the session starts at `min` members or 20 s after
opening if ≥ min, closes at `max`, and collapses to the `solo` variant if nobody comes. Members
hold a `recreate` action at the venue's interaction positions with the activity label.
Mid-session a bell or an essential task pulls a member out (the hold releases like `socialize`
today); a contest with fewer than `min` left ends with no result.

**How interests make stories.** *Contest* outcomes pick a winner by a small skill-or-trait
weighted roll and record a per-pair tally (`rivalries[a][b] = { wins, losses, streak }`).
Streak ≥3 → thought *Jax keeps beating me at cards*, affinity −1, and the digest line "Rivalry:
Tomas vs Jax at cards (0–3)". *Debate* compares stances on a shared topic: close → "spirited
talk", +2 affinity, thought +; far apart → "argument", −2 affinity, thought *argued about the
Guild* (−); if only one of the pair likes debate the other gets *got lectured*. *Perform*
(music) gives listeners in the compartment a passive thought by their interest (music-likers +,
dislikers −: a story with zero extra code). The narrator sees all of it and can build a card from
a rivalry or an argument that the sim actually produced.

**Starter activities (12).** Venue in brackets.

1. Cards [games table, lounge; 2–4; contest]
2. Board game [games table; 2; contest]
3. Watching vids [vid screen, lounge; 1–4; bond; topic "the vid"]
4. Video game [same vid screen; 1–2; contest] — one machine, two defs, no new art
5. Debate [mess or lounge; 2–3; debate; topics]
6. Exercise [exercise rig, gym; 1; none; small fatigue cost]
7. Sparring [mat zone, gym; 2; contest; minor injury risk → medic work]
8. Reading [own cabin preferred, else lounge; 1; needs a `book` item from the lounge shelf]
9. Playing music [anywhere, 1 + listeners; perform; needs the harmonica from her locker]
10. Tinkering [workbench, engineering; 1; skillGain engineering]
11. Stargazing [viewport, lounge; 1–2; bond; transit only]
12. Baking [stove, galley, off-meal windows; 1; produces a `treat` item others eat (+thought)]

## 4. Dirt and cleaning

**State is per tile; work and effects are per room** (owner: per tile, so paths show). A
`dirt: number[]` grid per deck (0..1, quantised; 720 values on Mk2, trivial in the save and sent
to the renderer only when it changes, at a low cadence).

**How dirt moves.**
- *Footfall*: entering a tile adds a little dirt to it.
- *Dirt on boots*: each actor carries a small `boots` value, picked up from dirty tiles and from
  dock tiles while ashore, and shed onto the next few tiles they walk. Trails from the cargo
  ramp to the stowage zone, or from the galley to the mess, then emerge on their own.
- *Port grime*: dock maps carry `grime: 0..1`. It sets how much a dock tile loads boots (muddy
  Green Meridian), and on planets with `airborneDust` it also settles slowly on deck tiles near
  an open ramp while docked (dusty Tern's Rest). Capped so one visit adds a bounded amount, or
  every landing becomes a cleaning chore.
- *Events* deposit around their source: meal served (mess tables, serving counter), cooking
  (stove), repair (around the machine), cargo handling (around the crate), sparring and
  exercise (gym), spoiled meal (galley).

**Rooms are the unit of work and effect.** A room's dirt is an aggregate of its tiles (mean,
with a weight on the worst tiles). Three word tiers: *untidy* (nothing), *dirty* (eating there
gives *ate in a dirty mess* (−); engineering machine hazard rises; meal quality −1 if the galley
is dirty), *filthy* (thought doubles, one ticker line on the transition). A `compartmentDirty`
problem at *dirty* (routine, ages; essential at *filthy* for galley and infirmary) derives a
`cleanCompartment` task: fetch the mop from the cleaning locker (Stores), then mop that room's
dirtiest tiles in order until the room drops below *untidy* or the task is interrupted. Label
"mopping the galley"; the cleaner visibly works along the trail. Role affinity decides who:
cook → galley/mess, deckhand → hold/corridor/gym, engineer → engineering, medic → infirmary,
anyone once aged. The key rule: **on-duty crew with nothing to do clean and do rounds instead
of standing at their post**, which turns the playtest's worst complaint into the dirt system's
labour supply.

**On screen**: a translucent grime tint per tile (simpler than specks, and it is what shows
paths); inspector "Galley: dirty"; ticker only on tier transitions and on the first "field day"
of a game. Nothing per mop stroke, so it never becomes noise.

## 5. Cook and other work

**Galley loop.** New item `provisions` (crate, 12 servings, bought at ports like parts; a stock
of about six days for nine). Zones: `pantry` (Stores), `serving` (galley counter), machine
`mess_table` with 4 `seat` interaction positions (two tables). Before each bell the cook gets
`cookMeal` (routine, deadline = bell): fetch provisions from the pantry, cook at the stove
("cooking"), produce `hot_meal` × (crew aboard + 1) on the serving zone. `eat` becomes: take a
hot meal from serving, sit at a mess seat, eat, thought by quality (cooking ≥6 *Bettina's stew*
+; 3–5 plain; <3 *burnt dinner* −). The oncoming watch eats first, the off-going after; the
helm-stander's meal is brought to the bridge (the cook or a dayworker carries it up, a visible
errand). Meals spoil after a while (galley dirt). Ration packs stay as the fallback (smaller
hunger relief, thought *ate a ration pack* −) when there is no meal, so nothing starves if the
cook is in the infirmary; anyone with cooking ≥1 substitutes, worse. `provisionsLow` (<1 day) is
a problem the narrator sees and a `buyProvisions` port task like `buyParts`. The cook also cleans
the galley after each meal and bakes for fun. The mess becomes the most crowded room three times
a day: the single biggest visible change in this proposal.

**Other work, with verdicts.**

- *Maintenance rounds* — **yes, cheap, high**. The on-watch engineer (or any idle duty crew in
  engineering) walks engine → pump → generator → battery → life support, a short `inspect`
  each, label "doing rounds". Surfaces `machineSymptom` earlier and feeds knowledge. Replaces
  the idle post.
- *Officer's rounds* — **yes** (§2): the officer of the watch's main on-duty activity.
- *Course plotting* — **yes, mandatory** (owner: part of the routine, not a bonus). See §6.
- *Drills* — **cut** (owner, 2026-10-06, D91). Was: every other day the FO calls a muster at
  the gym `muster` zone; everyone not on watch walks there; first-aid/firefighting skill ticks.
- *Sparring injuries* — yes, minor only, so the medic finally has work.
- *Reviewing the log at an ops terminal* — **cut** (owner). Too thin a mechanic.
- *Laundry* — **no**: no story, pure busywork. *Stocktake* — no, fold into Stores tidying.
  *Sick call* — later, when injuries are a system.

## 6. Bridge stations and piloting

Bridge 8×6 at the bow (east end) with stations along the fore wall and two reserved on the aft
bulkhead.

| Station | Now | Mechanic | Later |
|---|---|---|---|
| Helm (centre fore) | yes | duty station §2; gates departure/approach/docking; piloting checks | evasive manoeuvre during combat |
| Nav terminal (fore) | yes | `plotCourse`, required before departure | jump plotting, scanning |
| Ops terminal (fore) | placed, inert | none for now | shields, power routing, sensors, damage control |
| Captain's chair (centre) | placed | where an officer idles on the bridge; not a hold | — |
| Tactical (aft) | reserved tile | none | weapons |
| Shields (aft) | reserved tile | none | shields |

**Course plotting is part of the departure routine.** Setting a destination raises a
`courseToPlot` problem; a piloting-qualified crew member takes `plotCourse` at the nav terminal
("plotting a course to Kessler Drift"). Departure waits for a plotted course, in the same way it
waits on the existing departure gate (D36). Skill sets how long it takes, not how good the result
is. It runs in parallel with loading, so it delays departure only when no pilot is free, which
is itself a small story ("waiting on a course"). A detour mid-hop raises it again.

**Piloting checks** are the helm's stakes and the sim's first skill check. A `navHazard` (debris
field, asteroid belt, a rough approach, later combat manoeuvres) is a timed transit event with a
difficulty. When it arrives the helm-stander rolls piloting against it; outcomes are bounded and
physical: clean pass; a scrape (a machine fault or a minor hull/equipment knock via the existing
fault path); a delay (time added to the hop). An unattended helm fails automatically, or for
checks that allow "flying straight", takes a heavy penalty. Sources: a narrator command
`scheduleHazard`, modelled on `scheduleFault` with the same budget and window rules, and
optionally a kernel-sampled rate per route. The narrator sees the result and who was at the helm,
which is a story ("Noor took us through the Drift alone").

All stations are `station` machines with `role` tags and a `requiredWhen` list in the def
(underway stages for the helm, `["alert"]` for tactical/shields). A future `alert` ship state
then makes every alert station a `stationToStaff` at essential class with no new planner code,
which is how shields and weapons slot in. Stations also declare `operatorSkill`, read uniformly.

## 7. Cabins and berthing

Reverse "no cabins" partially (owner: agreed): **captain's cabin, first officer's cabin, one
two-berth passenger cabin, and an eight-bunk bunkroom** (two rows of four in a 6×6; seven
non-officers plus one spare, so a narrator-added crew member fits; hot-bunking stays a fallback
for when the pool overflows, since it destroys ownership and lockers). Not a cabin each: the
bunkroom is where grouped sleeping and noise stories happen, and a cabin is a *status resource*
the narrator can make a card out of ("the passenger cabin is empty; Priya has asked for it").

State: `berths: Record<actorId, machineKey>`, assigned at scenario start by rank and otherwise to
the first free bunk; passengers get the passenger cabin on boarding; a crew member without a
berth gets the thought *no bunk of my own* (−) and uses the unassigned pool as today. Each cabin
and bunk has a `locker` zone; items with a `personal` tag carry `homeZone`, so the harmonica
lives in Bettina's locker and playing it is a visible fetch. Privacy as a resource: sleeping in
your own cabin gives *own cabin* (+); sleeping in the bunkroom while someone in it is awake
gives *noisy bunkroom* (−); `loner` restores recreation faster when reading in a cabin. The
captain's cabin is the venue for `privateTalk` (narrator-driven: "Priya wants a word", both walk
there, short talk, affinity outcome), which gives the player's own character a room the story
visibly uses. The medbay bed stops counting as a `bed` for ordinary sleep.

## 8. The new ship layout: Freighter Mk2, 36 × 20

```
Freighter Mk2 (deck.freighter_mk2)   east = fore (bow), quay = south
36 x 20 tiles

  x: 0         1         2         3
     012345678901234567890123456789012345
 0   EEEEEELLLLLLLQQQQQQPPPFFFKKKBBBBBBBB
 1   EEEEEELLLLLLLQQQQQQPPPFFFKKKBBBBBBBB
 2   EEEEEELLLLLLLQQQQQQPPPFFFKKKBBBBBBBB
 3   EEEEEELLLLLLLQQQQQQPPPFFFKKKBBBBBBBB
 4   EEEEEELLLLLLLQQQQQQPPPFFFKKKBBBBBBBB
 5   EEEEEELLLLLLLQQQQQQPPPFFFKKKBBBBBBBB
 6   EEEEEECCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
 7   EEEEEECCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
 8   EEEEEEHHHHHHHHHHHHHHGGGGMMMMMMXXNNNN
 9   EEEEEEHHHHHHHHHHHHHHGGGGMMMMMMXXNNNN
10   EEEEEEHHHHHHHHHHHHHHGGGGMMMMMMXXNNNN
11   EEEEEEHHHHHHHHHHHHHHGGGGMMMMMMXXNNNN
12   EEEEEEHHHHHHHHHHHHHHSSSSMMMMMMXXNNNN
13   EEEEEEHHHHHHHHHHHHHHSSSSMMMMMMXXNNNN
14   EEEEEEHHHHHHHHHHHHHHSSSSYYYYYYXXAAAA
15   EEEEEEHHHHHHHHHHHHHHSSSSYYYYYYXXAAAA
16   EEEEEEHHHHHHHHHHHHHHSSSSYYYYYYXXAAAA
17   EEEEEEHHHHHHHHHHHHHHSSSSYYYYYYXXAAAA
18   EEEEEEHHHHHHHHHHHHHHSSSSYYYYYYXXAAAA
19   EEEEEEHHHHHHHHHHHHHHSSSSYYYYYYXXAAAA
                  ^ cargo ramp (13,19) ^ personnel ramp (34,19)
```

| Sym | Room | Size | Contents / rationale |
|---|---|---|---|
| B | Bridge | 8×6 (48) | helm (34,2) + standby, nav (34,0), ops (34,4), captain's chair (32,2), two reserved aft tiles (29,1)(29,4); one door (32,6)n |
| K | Captain's cabin | 3×6 (18) | cabin bunk, desk, locker zone; door (26,6)n; the narrow-but-mine feel is deliberate |
| F | FO's cabin | 3×6 (18) | same; door (23,6)n |
| P | Passenger cabin | 3×6 (18) | 2 bunks, locker; door (20,6)n; spare berth when no passenger |
| Q | Bunkroom | 6×6 (36) | 8 bunks (two rows of four) + lockers; door (16,6)n |
| L | Lounge | 7×6 (42) | games table (4 seats), vid screen (4 positions), book shelf zone, viewport; door (9,6)n |
| E | Engineering | 6×20 (120) | engine, pump, generator, battery, life support, engineering console, workbench; doors (5,6)e from the corridor and (5,14)e from the hold (two routes kept) |
| C | Corridor | 30×2 (60) | spine; opens into X at (30,8),(31,8) with no door |
| X | Cross-passage | 2×12 (24) | reaches airlock, infirmary, mess, gym; airlock door (32,16)w, mess door (29,10)e, gym door (29,16)e |
| N | Infirmary | 4×6 (24) | medbay bed, med locker; door (34,8)n |
| A | Airlock | 4×6 (24) | gangway post, personnel ramp (34,19)s, transfer tile (34,18) |
| M | Mess | 6×6 (36) | two mess tables (8 seats); doors (27,8)n and (29,10)e; serving hatch to the galley (23,9)e, open |
| G | Galley | 4×4 (16) | stove, serving zone; door (22,8)n |
| S | Stores | 4×8 (32) | pantry zone, parts zone, cleaning locker; doors (22,12)n from the galley, (19,14)e into the hold |
| Y | Gym | 6×6 (36) | exercise rig, sparring mat zone, muster zone (drills are visible here, and the hold is full of crates); door (29,16)e |
| H | Cargo hold | 14×12 (168) | crane, cargo_stow zone; door (15,8)n; cargo ramp (13,19)s, transfer tile (13,18) |

Door notation as in the deck JSON: `(x,y)side` is the named side of that tile.

Rationale: the bridge, the officers' cabins and the airlock are at the bow; engineering and the
engines are aft. The galley sits between the mess and the stores so the cook's loop is three
doors long, and the stores open into the hold so provisions come aboard by the cargo ramp; the
mess is off both the corridor and the cross-passage so meal traffic doesn't funnel through one
door; the lounge is next to the bunkroom and far from the bridge so off-watch noise is spatially
real; the passenger cabin is on the corridor close to the airlock; cabins are 18 tiles, which
fits a bunk, a desk, a locker and three floor tiles for a private talk. Engineering keeps two
entrances (README rule). Docked view: ship 36×20 with an 8–10 row quay south gives maps of
≤44×30, inside the 48×36 cap; all six maps must be re-authored for the new footprint, which is
why §10 exists. Single deck: a second deck would need a stair portal, the renderer's one-deck
assumption removed, and halves the canvas per deck; nothing here needs it. L-shaped rooms are
legal (compartments are symbol grids) but none are used, to keep the ASCII renderer's labels
honest.

## 9. Pacing: time in fractions of a day

With far more going on, more play will happen at 4× and 8×, and the owner expects to retune day
length and beat spacing more than once. Today about fifteen tunables are per-second rates that
silently assume a 1200 s day and 1× play; changing the day means retuning each by hand.

**Express time tunables relative to the ship's day.** Config gains `time.daySeconds` (1200 to
start) and `time.watchesPerDay` (3). Every other duration or rate is written in day-relative
units and converted at load:

- needs as cadences: "hunger: about 3 meals a day", "fatigue: one sleep a day, sleep lasts 0.2
  day", "recreation: once a day";
- activity, meal, cooking and cleaning durations as fractions of a day or watch;
- spoilage, drills ("every 2 days"), skill gain ("per day of practice");
- narrator cadence in ship time: `quietTooLong` at most once per watch, budget refills per day,
  rather than raw seconds.

Things that are about real-world feel, not ship life, stay in seconds: door and ramp timings,
walking speed, docking stage animation, handover action length. Changing `daySeconds` then
rescales the routine coherently while the physical motion stays the same speed.

**Auto-slowdown.** Fast-forward drops back to 1× on a notable event (a card, a fault, a piloting
check, an argument turning into a fight, a filthy-tier transition), with the event's ticker line
highlighted. 8× becomes a safe way to skip the quiet stretches without beats flying by. Which
event kinds slow the game is a config list, like `narrator.hookOnEvents`.

**Measure it.** A headless CLI report over N simulated days: beats per watch by kind (cards,
meals, arguments, faults, hazards), share of time each person spends at each activity, longest
idle stretch. Tuning then targets numbers ("one notable beat per watch at 1×") rather than
impressions, and the report is rerun whenever `daySeconds` changes.

## 10. Hull-class contract and berth spec

Add to `DeckDef`:

```
hull: {
  class: "light_freighter",            // informational
  sizeClass: "M",                      // S ≤ 24x14, M ≤ 36x20, L ≤ 40x24
  rampSlots: { personnel: { x: 34, y: 19 }, cargo: { x: 13, y: 19 } }   // hull-edge tiles on the quay side
}
```

**Orientation is an invariant, not a parameter.** The bow is always east (high x) and the quay
is always south; the validator rejects anything else. The owner ruled bow-east (it reads as
moving left to right); this is the moment to change it, since every dock map is being
re-authored anyway. In code, direction lives only in the renderer: hull nose and engine bells,
star streaming, scenery and the dock sliding past, and the portrait rotation, which flips from
clockwise to counter-clockwise so the bow still points up on a phone. The sim has no direction.
Mk1 is mirrored by a one-off script so it stays loadable as a second footprint.

Size classes are the only numbers dock authors need: the class box plus a quay depth of 8 rows
must fit under 48×36 with 2-tile side margins (L is the ceiling: 40+4 × 24+8 = 44×32).

**Required by any deck** (validated by a `hullContract` pass in the L3 geometry checks, with a
per-deck report): compartment tags `bridge`, `quarters` or ≥1 `cabin`, `mess`, `galley`,
`engineering`, `cargoHold`, `airlock`; optional `lounge` (falls back to `mess`), `stores` (falls
back to `cargoStowage`), `infirmary`, `gym`. Machines: one `pilotStation`, one `navStation`, one
`engine`, `bed` count ≥ crew + 1, ≥1 `messTable`, ≥1 `stove`. Zones: `cargoStowage`; optional
`pantry`, `serving`, `cleaningLocker`, `muster`, `locker` (per bed). Spawns: ≥1 `crew`, ≥1
`passenger`. Docking: both ramp doors on the south hull edge, transfer tiles inside and
adjacent, every compartment reachable from both ramps with all interior doors open. The renderer
stops keying the nose on the `bridge` tag: the high-x end is always the bow.

**Dock maps stop drawing the berth.** Replace `berth` tiles in `rows` with:

```
berth: { origin: { x: 2, y: 1 }, sizeClass: "M" }
```

At load the dock stamps the docked ship's footprint into the berth box (ship origin = berth
origin; a smaller ship is placed flush to the quay edge and centred), validates that the box is
`void` in the authored rows, that the quay row along the full berth width is floor (so any ramp
x in the class box lands on floor), and that both landings reach gate, warehouse door and staging
as today. Maps can optionally list `rampLandings` overrides for a particular class box; none of
the six need them. Changing the ship's footprint then costs one line per map plus a quay long
enough, and a second hull class costs nothing on the dock side. Dock maps also gain `grime` and
`airborneDust` (§4).

## 11. Extra ideas, ranked

1. **Thoughts/mood as the universal glue** — cheap, highest value; every other system becomes
   legible through it.
2. **Idle duty crew do rounds and cleaning** — cheap, high; kills the "stands idle" complaint.
3. **Gangway watch in port** — cheap, high; a dot at the ramp and a fix for dock-hand give-ups.
4. **Auto-slowdown** (§9) — cheap, high; makes fast play safe.
5. **Pair rivalry tally** — cheap, high narrative yield per line of code.
6. **Skill growth from standing watch** — cheap, medium; the junior's piloting rising is a slow
   story the narrator can notice ("Noor took the helm alone for the first time").
7. **Drills** — cheap, medium; whole-ship motion.
8. **Captain's table** — once a day the captain sits with the crew member of highest or lowest
   affinity (alternating); medium, medium; gives the player's character a social act.
9. **Ship's cat** — medium cost, high charm: a wandering actor, a dirt source, a thought for
   whoever it sleeps on. Later.
10. **Passive listeners** for music/vids (already in §3) — zero cost once activities exist.
11. Hygiene need + washroom — **cut**; a need without a story.
12. Day/night lighting — **cut**; continuous watches have no night.

## 12. Phasing

Each slice ships playable and passes the four checks. Geometry comes first: building mess tables
and serving zones onto Mk1's 6×8 galley would be thrown away, the deck move is the riskiest
change, and regressions are easiest to attribute while behaviour is otherwise unchanged.

1. **Freighter Mk2, hull contract, berth boxes, bow east.** `hull` block and invariants,
   validator pass, docks on `berth` boxes (re-author six maps), renderer flipped to bow-east,
   Mk1 mirrored and kept loadable so the berth-box loader is exercised with two footprints from
   day one, the Mk2 deck with every room and piece of furniture placed (mostly inert at first),
   berth assignment and lockers, the ninth crew member.
2. **The watch and the helm.** Day-relative time units (§9) and auto-slowdown; rename
   shifts→watches, three sections, watch bill, helm as duty station with handover, relief and
   vacancy gating, officer of the watch with rounds, gangway watch, mandatory course plotting,
   piloting checks with `scheduleHazard`, idle-on-duty rounds, sleep lengthened, thoughts/mood
   with the first few defs, the bell in the ticker, digest gets "watch: White has the helm
   (Jax)". Long hops lengthened to at least a watch. Fixes three playtest complaints (idle at
   post, "idle beside the console", dock hands giving up).
3. **Mess call and dirt.** Provisions, cook loop, mess tables, meal rhythm on bells, meals to
   the helm, spoilage, `buyProvisions`; per-tile dirt, boots, port grime and dust, room tiers,
   cleaning, grime tint. The cook now works.
4. **Off watch.** Recreation need, interests and value axes, topics, relationships, activity
   defs, group sessions, the twelve activities, rivalries and debates, own-cabin and bunkroom
   thoughts, narrator digest lines for interests/mood/rivalries/cabin and a `privateTalk`
   command for cards.
5. **The asteroid field** (re-sequenced 2026-10-06, D91). A narrator-scheduled field with
   narrator-chosen hits, detection by the helm and an alert state, random impacts with blast,
   machine outages and damage, a global hull bar with patching and port repair, getting stuck,
   ship loss as game over, intercom panels and scouts. See the plan's slice 5.
6. **Atmosphere and breaches**, with bodies and the medic.
7. **Fire.**
8. **Tactical and shields**: the `requiredWhen`/`alert` station framework, the alert bill and
   hold-until-relieved.

Cut from all eight (drills too, D91): laundry, hygiene, stocktake, sick call, an ops-terminal
mechanic, multi-deck, the cat, lighting.

## 13. Owner rulings and open questions

Ruled 2026-10-04 (to be recorded as D-entries when the slices land):

- Ninth crew member: yes.
- Day length: 1200 s provisionally; expect retuning as fast play becomes common (§9).
- Long hops at least one watch: yes.
- Dirt: per tile, with room-level work and effects (§4); planets can add dirt from the air.
- Empty helm: gates departure, approach and docking; no transit slowdown; fails or heavily
  penalises piloting checks (§2, §6).
- Course plotting: mandatory part of departure, not a bonus.
- Ops terminal: no mechanic for now.
- Captain's chair: must not pin the captain; the officer of the watch walks rounds.
- Bow east, quay south, fixed in the hull contract and done in slice 1.
- Cabins for captain, FO and passengers; eight-bunk bunkroom for the rest: yes.

Open:

1. **Short-handed rotation** — deferred until injuries exist (§2). Recommendation then:
   automatic re-forming of the watch bill, with a narrator card only when the shortfall will
   outlast a day.
2. **Target play speed** — which speed should a quiet stretch be tuned for (1×, or 4× with
   auto-slowdown)? Settle after the first slice-2 playtest using the beats-per-watch report.
3. **Hazard frequency** — narrator-scheduled only, or also a kernel-sampled rate per route?
   Recommendation: narrator-only first, so every hazard is placed for a reason.
