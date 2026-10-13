# Crew life

Needs, the thoughts that make up mood, the galley and mess call, dirt and cleaning, and sleep.
Config is in `packages/content/data/config/default.json`; code in `packages/sim/src/systems/`
(`needs`, `galley`, `dirt`, `cabins`) and `packages/sim/src/planner/`.

## Needs

### Need rates and recovery

Everyone aboard (passengers too) has five deficits in [0, 1]: hunger, fatigue, comfort, social,
recreation. Rates per ship's day are `config.needs.*PerDay`. Fatigue rises faster during a task's
hands-on steps than while awake otherwise (standing the helm or gangway counts as awake), and falls
asleep; comfort and social fall while resting or chatting. A trait's `*Rate` modifier scales a rise
only, never a recovery. Needs never start or stop an activity: the planner turns a need into an
eat, sleep, rest or socialise candidate (`systems/needs/needs.ts`).

### Need urgency and crossings

A need above `needs.seekThreshold` (0.5) is a routine candidate, above `urgency.needEssentialAbove`
(0.7) essential, above `urgency.needSurvivalAbove` (0.9) immediate survival. `needThresholdCrossed`
fires at the seek threshold (trace) and rising past survival (notable); recreation has no survival
crossing. Above survival, fatigue lowers movement and manipulation linearly to
`movement.fatigueSpeedFloor` (0.6) at 1.0, times what the body allows (§bodies-and-capacities).

### Starting needs

Crew start with each need drawn from `needs.initialRange` on the `setup` stream. Why: the first
minutes have motion instead of everyone idling at zero.

## Thoughts and mood

### Thoughts

A thought is a closed `ThoughtKey` with a content def (`packages/content/data/thoughts/*.json`:
`label`, `value`, `durationDays`, `stacks`); the files are the catalogue. `addThought`
(`core/thoughts.ts`) gives one and emits `thoughtAdded`. A non-stacking def refreshes the held
thought with the same key and `refId` (extends expiry, keeps value); a stacking one adds another.
`moodSystem` drops expired thoughts each tick. `worriedAbout`, `grieving`, `shaken` and `heartened`
are the narrator's to give (`giveThought`, §thought-and-reveal-levers); nothing in the sim raises
them.

### Mood and work speed

Mood is the sum of live thoughts' values, clamped to [-1, 1]; `addThought` updates it at once, so
mood always equals its thoughts at the end of a tick. Work speed is its only effect: times
`mood.lowWorkSpeed` (0.9) below `mood.lowBelow` (-0.4), `mood.highWorkSpeed` (1.05) above
`mood.highAbove` (0.4). The digest and inspector show mood as a word and the three heaviest
thoughts.

## Galley and mess call

### Meal problem

`mealToCook { watchIndex }` is raised `galley.mealLeadDays` (0.08) before each watch's bell, once
per watch, on a ship with a `stove` machine and someone to feed. Not served `galley.mealGraceDays`
(0.1) after the bell, it is cancelled (`mealMissed`, said on the ticker). The `cookMeal` task is
the cook's at any hour, off duty included; anyone with cooking >= 1 may take it once the problem is
`galley.substituteAfterDays` (0.025) old.

### Cooking and serving

The cook splits one crate of provisions off the nearest known stack, cooks for `galley.cookSeconds`
at their skill rate, and serves on the `serving` zone's counter. The crate is used up whatever it
served; the stack is `eaters + galley.spareServings` servings, never more than
`galley.servingsPerCrate`. Every crew member is told where it is. Quality is the cook's `cooking`
skill (good at `galley.goodCookingAbove` 6, poor below `poorCookingBelow` 3, else plain), one step
lower in a `dirty` or `filthy` galley, fixed on the plate; serving a `good` meal gives the cook
`cookedWell`. A serving left on deck past `galley.mealSpoilDays` (0.25) is swept (`mealSpoiled`)
and dirties its tile; one in hand is the holder's to eat. Events: `mealServed`, `mealMissed`, `mealSpoiled`, `ateMeal`.

### Mess call

After a serve, anyone with a known served meal and hunger above `galley.mealCallHungerAbove` (0.1)
gets a routine eat candidate, except the section on watch, which eats after the bell as the
off-going section. The gangway stander is called off the post, which waits until they have eaten.
Same-class commitment means nobody is pulled off work or a sleep for dinner. Bedtime waits while
the call stands, so the off-going section eats before turning in; pressing tiredness still sleeps.
A ration in hand does not answer the call.

### Eating

A hungry person prefers a served meal to a ration and eats at a free mess seat (seat choice is in
`social.md`), else where they stand, for `needs.mealDays`. A meal gives `ateWell` (good),
`burntDinner` (poor), `ateRationPack` (food with no `meal`), plus `ateInDirtyMess` or
`ateInFilthyMess` by the room's tier, and an `eating` dirt deposit. A `treat` is a voluntary eat
above `galley.treatHungerAbove` (0.1), eaten where found, giving only `ateATreat`; never a hungry
person's ration.

### Helm plate

While someone holds the helm hungry with a served meal aboard and none within a tile of the seat,
`mealToCarry` sends the cook or a dayworker (anyone once `urgency.routineAgingDays` old, never the
stander) to set a plate at the standby tile. The stander eats it in the seat, so hold, relief and
vacancy never notice. Why: a hungry stander otherwise called relief for dinner.

### Galley provisions

A crate of `provisions` is one meal, a meal a watch. The galley counts days as crates (plus counter
servings as a fraction of a meal) over `time.watchesPerDay`. Why: counting crates as servings read
eight days for a six-day pantry and the ship ran dry without asking a market. Below
`galley.lowBelowDays` the crew restock through `reserveLow` (§reserve-kinds, where rations have
their own rule); `provisionsLow` is said once at the serve that crosses the mark. The scenario
stows 18 crates and 60 ration packs.

## Dirt and cleaning

### Dirt grid

One quantised grid per deck: 0-255 per authored tile; dock floor and machine footprints take none.

### Footfall and boots

Stepping onto a dock tile loads the boots by the dock's `grime × dirt.dockGrimePerStep`. Stepping
onto a deck tile adds `dirt.footfallPerStep` (0.01) plus a share (`bootsShed`) of the boots' load,
then the boots take `bootsPickup` of the tile's dirt. Pickup is a transfer, not a copy, so walking
carries dirt in a fading trail from the ramp and never multiplies it. Why: a copy grew busy
corridors without bound.

### Dirt deposits

Other sources use `depositDirt` (`dirt/deposit.ts`), sharing `dirt.deposits.*` (cooking, serving,
eating, spoiledMeal, repair, cargo) over floor within `depositRadiusTiles` of a tile in the same
room. While docked with a ramp open, dust settles near the ramp (dock `airborneDust`, falling with
distance, capped per visit by `airborneDustVisitCap`, reset on undocking).

### Room tiers

A room's dirt is its mean weighted toward its worst tile (`dirt.roomMaxWeight`). Tiers clean /
untidy / dirty / filthy rise at `dirt.tiers` (0.12 / 0.3 / 0.55) and fall `tierHysteresis` (0.05)
lower. Each change fires one event (`roomDirty`, `roomFilthy`, `roomTidied`); `roomFilthy` slows
fast-forward. The renderer's tint rides its own tick-keyed `dirt` message (§run-ahead-loop),
applied at the view tick (D14); the inspector shows a room's dirt (§items-places-and-locals).

### Room cleaning problem

`compartmentDirty` opens at dirty (routine; essential while a galley or infirmary is filthy) and
resolves when the room is clean and nobody holds its task: with `roomCleaned` at the end of the
trip that cleaned it. It never resolves mid-trip, so the mop always goes home.

### Mop trips

One `cleanCompartment` task covers the room's `dirt.mopTilesPerTrip` (12) dirtiest tiles, walked
nearest first from the `cleaningLocker`. Why: dirtiest first zigzagged a sixty-tile corridor. The
trip fetches the mop, mops, returns it, then settles: clean resolves and gives the mopper
`squaredAway`, otherwise the next trip re-derives. The plan reads its tiles from the grid, not the
task. Why: the task's tiles refresh late and a hand claiming in the gap re-mopped clean tiles.
Mopping clears a tile and wipes the mopper's boots.

### Who mops

By role (`cleaningRolesFor`, `planner/cleaning.ts`): cook keeps galley and mess; deckhand hold,
corridor, gym, airlock; engineer engineering; medic infirmary; the bridge its officers. Anyone on
duty once the problem is `urgency.cleaningAgingDays` (0.25) old, anyone when essential. Why:
reusing `routineAgingDays` made every room everyone's within one trip. Cleaning is routine and
keeps the off-duty rule: on-duty crew with nothing to do mop before rounds; off-duty crew never
start.

## Sleep and cabins

### Sleep timing

Routine tiredness is slept off in one's sleep watch (the watch after their own section's; for a
dayworker the first off after their last on), from `needs.bedtimeAbove` (0.3); outside it only
pressing tiredness sends anyone to bed. A sleep lasts at least `needs.sleepDays` and ends at
`needs.wakeBelow` fatigue (or when on duty and below the seek threshold), and is interrupted only
by containment or above. Why: one sleep a day in the same window, taken whole.

### Sleeping places

A person sleeps in their own berth, else a bed nobody is assigned, never another's assigned bed or
the infirmary bed (§sleeping-in-a-berth); no hot-bunking. A sleeper in a cabin is labelled by the
cabin ("asleep in the captain's cabin"), since content gives people no pronouns. Berth assignment is
in `ship.md`.

### Cabin thoughts

A completed sleep gives `ownCabin` in one's own berth in a `cabin` room, or `noisyBunkroom` in the
bunkroom after `cabins.noisySeconds` (60) of awake company. An interrupted sleep gives neither.

### Unberthed crew

Serving crew with no berth (not passengers, dead or ashore) carry `noBunkOfMyOwn`, checked every
`cabins.checkEverySeconds` (60) and removed once berthed.