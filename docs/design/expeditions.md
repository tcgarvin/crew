# Expeditions: Landing Sites, the Away Party, and Person-to-Person Combat

Status: design agreed with the owner, 2026-10-10. Owner inputs are marked **(owner)**; everything
else is a design-partner call the owner delegated. The owner's rulings become a `docs/DECISIONS.md`
entry and each phase's mechanics go into `docs/spec/` as it lands; this file stays as the
rationale. The
implementation plan for each phase is written when the phase before it lands, in the style of
`docs/design/ship-life-plan.md`.

Companions: `docs/design/game-design-document.md` (GDD §16 authority, §22 cards, §23 combat),
`docs/design/simulation-design.md` (SD §12 bodies, §18 combat extension contracts),
`docs/design/dockside.md` (the dock machinery this reuses), `docs/design/passengers-and-galaxy.md`
(a job with a person in it).

## 1. Why

Every story so far happens to the ship. The crew fix what breaks, thread what the narrator puts
in the way, and meet the people a port sends to the ramp. Nobody has ever been asked to go
somewhere and do something hard to someone. The narrator's levers are all pressure on the hull or
the schedule; it has no lever that makes a *person* the problem.

Owner: "We'll create a new mission type which is to go to a place on a planet, somewhere that's
not the usual dock, and either kill a specific character, or steal a specific thing. The narrator
needs to have a lot of flexibility to decide the narration around the quest and to influence
concepts like diplomacy. Maybe in some cases you can convince a character to come willingly
instead of having to kill them. Or maybe sometimes there's a bunch of guys, and you convince some
of them to run and let you take just the guy you want. Same for items. ... Then of course we
actually need the combat system to work, and we need, again back to narration, for the player to
be able to choose between lots of different strategies. For example when a fight is going to
break out, the player might be given two battle plans and pick between them."

That asks for four things this doc designs together:

1. **A place the ship goes.** A site is a landing somewhere that is not a port: its own
   destination, its own map, the ship set down beside it, no market and no gate.
2. **A job with a person or a thing at the end of it.** An errand: bring someone back (alive, or
   not), or bring something back. One job at a time, like every job (§one-job-in-hand).
3. **A fight that plays itself,** on the site's tiles, with bodies that can be hurt, arms that
   are scarce, and morale that ends most fights before the wounds do.
4. **A narrator with range and a captain with choices,** inside the rules that already hold:
   the narrator sets things up and never decides outcomes (GDD §16; the system prompt's first
principle), cards are binary and brought by someone (GDD §22, §spoken-cards), and the crew act on
   their own (GDD §2.1).

The design principle throughout is the one the project has already settled three times: the
sim owns the verbs, the narrator owns the nouns and the prose, and the kernel checks (D6
allow-list, the §narrator-authority capability list, the scripted impacts of §scheduling-a-field
behind a guard). "Lots of strategies" is a large menu of things the sim can really do, framed
well, chosen two at a time.

## 2. The shape of an expedition

Vocabulary: an **expedition** is the sim's name for the away episode; the job kind is an
**errand**; the place is a **site**; the people there are the **site cast**; the crew who go are
the **party**.

```
offer (at a port)  →  accept: course set to the site  →  leg  →  landing (stageSite answered)
→  expeditionArrived card (approach: a plan, a parley, or wait)  →  parley rolled / fight runs
→  expeditionTurn card (the lull: press, terms, let them go, change plan, withdraw)
→  resolved  →  party aboard with the target, the thing, the wounded  →  lift-off to returnTo
→  leg (aftermath cards)  →  delivery at the port, paid once  →  closing card (D54)
```

Three to four narrator calls more than a freight job, each at a moment the sim guarantees.
Between them the sim plays everything: walking, talking, shooting, breaking, carrying.

## 3. The site is a destination **(owner)**

Owner: the ship lands at a new place; the site is its own travel destination with a landing pad,
not something beyond a port's gate. The party walks down the ramp onto the site. Leaving, the
ship lifts off back to a port.

### 3.1 A site is a port that sells nothing

Every reader of travel state names places by `PortDefId` (`TravelState.toPortId`,
`shortestPath` in `systems/travel/graph.ts`, `Job.toPortId`, the headline, the scene). A second
id space for sites would touch all of them, and the compiler would not find the places where a
site must behave differently. So a site *is* a `PortDef` with `kind: "site"`:

```
PortDef {
  kind: "port" | "site"            // absent = "port"; every existing file is unchanged
  ...
  // for kind "site":
  nearPortId: PortDefId            // the port it hangs off; its one route goes there
  routes: [{ toPortId: nearPortId, distance }]   // a short leg, 15–30 (a core hop is 25–70)
  externalStores: []  market: []  jobTemplates: []   // nothing to buy, nothing to offer
  castSeed: []                     // the people here come from the errand, §5
  defaultCast: SiteCastEntry[]     // the sim's own cast when no narrator staged one, §5.3
}
```

The schema relaxes the `min(1)`/`min(2)` rules for `kind: "site"` and forbids a market and job
templates there. A port never lists a site in its `routes`: the graph is directed, and the site's
edge is added by the travel graph only while it is **known** (§3.2). Headlines and the digest say
"landed at" rather than "docked at", by `kind`.

What a site switches off, by one predicate `isSite(portId)` in `core/places.ts`, checked where
the behaviour lives rather than by a flag on each system: no docking fee; no `stageDock` (the
`stageSite` call stands in, §9.2); no `captainAshore` and no offers (the prompt is told, and the
translator drops an `offerJob` whose `fromPort` is a site); never a voyage waypoint
(`shortestPath` never routes through a site); no `buyParts`, provisions or plating purchases (the
§buying-parts, §reserve-low-problem and §plating-and-kits-at-port problems stay open and say "not
available here", which they already can); no passengers boarding or going ashore; no dock hands.
Everything else is ordinary: watches and the bell, the gangway watch at the ramp
(§gangway-watch-and-rounds, who now has something to watch), meals, dirt, sleep, repairs with what
is aboard, the departure gate.

### 3.2 How a site becomes reachable

A site is on the map only while something points at it. `knownSites(state)` is the set of
`siteId`s of every job with an `errand` whose status is `accepted` or `inTransit`, plus the site
the ship is at. `shortestPath` adds a known site's edge in both directions (to it from
`nearPortId`, and back). Accepting an errand therefore sets course to the site exactly as
accepting freight sets course to `toPortId` (§offer-card): if the ship is not at `nearPortId`, the
voyage runs there first (D49) and then makes the short hop. When the errand ends, the site drops
off the graph; the ship can always leave it because the edge back stays while the ship is there.

The narrator makes a site reachable by naming it on the offer, nothing more. In phase A2 it
chooses from authored sites (the capability block lists each site under its near port, one line
each); narrator-invented sites, through `DynamicDefsDraft` in the `gen.` namespace as crew and
items already can be, wait for phase C.

### 3.3 Landing reuses docking

`TRAVEL_STAGES` are unchanged. `approaching` and `docking` at a site *are* the landing: the scene
is a pure function of stage, progress and the two ports (§the-scene-outside-the-hull), and a site's
`setting` is `planet`, so the descent (`altitude`, the ground scaling up, dust off the pad) is
already drawn. `undocking` and `departing` are the lift-off. Two small changes in `sceneAt` and the
dock drawing (`apps/web/src/render/dock.ts`): a site has no quay structure (no clamps, no bay walls,
no terminal edge; the map's `foreground` is rock, scrub and buildings), and the ground is drawn from
the site map's palette the way an open planet berth is drawn as a pier (§dock-drawing). The headline
reads "Setting down at the Boathouse" / "Lifting off from the Boathouse".

The site map takes the dock map's place: it is the same content type (§4), so `attachDock` at
the start of `docking` grafts it onto the deck's grid (D59), `berthPlacement` puts the ship in
its pad box (§ship-placement), the ramps come down when `docked` (§ramps-and-cast-off) and the
camera zooms to hull plus map (§camera). A person who walks down the ramp is on site floor at a
negative coordinate like anyone on a dock; `isOnDock` already means "ashore".

The `stageDock` hold at the end of transit (§staging-hook-and-the-hold) is kept for sites and
answered by `stageSite` instead; the floor set is the site's `defaultCast` (§5.3). Nothing lands at
an empty site.

### 3.4 The ship is exposed **(owner)**

Owner: no market or warehouse; the ship is exposed; can the cast come to the ship?

Yes, and that is the point of landing rather than walking in from a gate. The ramp foot is on
the site floor; a cast member can walk to it (the `visitor` behaviour of §meetings-and-visitors,
already written for a local who brings word to the ramp), stand there and be the speaker of the
arrival card. In a fight, hostiles who break toward the ship are advancing on the ramp, and the
gangway watch at the ramp head is the last person between them and the deck; the party's `hold`
posture is a hold *at the ramp*. Travel owns the ramps (D59): a plan may ask for the cargo ramp up
and only the personnel ramp down (`rampsUp` is a phase C knob; in A1/A2 both ramps stay down while
the party is out, as at a dock). The crew aboard are not spectators: someone on the deck who sees a
fight through the ramp door reports it on the intercom (the reflex of §reporting-damage, with a new
fact), and the ship goes on `alert` (`WorldState.alert`, cause `fight`) with everything that already
follows from alert: recreation ends, the officer of the watch holds the bridge, sleepers in the hit
room wake.

The ship does not take damage from small arms in this design (misses that reach a hull tile are
absorbed); hull damage from a site is phase C at the earliest, and only if a site cast carries
something heavier than a blaster.

### 3.5 Leaving

Lift-off is departure prep as at a dock: the ramps stay down while anyone is on the site floor
(§ramps-and-cast-off), `comeAboard` calls the party in, a casualty is carried (`carriedBy`), the
target walks or is carried, and `detachDock` refuses until the floor is clear. Nobody is "brought
aboard by the dock crew" at a site: the last-guard rule (§ramps-and-cast-off) becomes a hard wait (a
dead or unconscious person on the floor is carried by the nearest fit party member, the `rescue`
action, §8.3).

What sets the course home: when the expedition resolves (§8.6) the sim sets `returnTo` as the
voyage destination on its own, the way a voyage continues from a waypoint (D49); the captain has
already chosen, on the lull card, whether to press on or go. The departure gate (§departure-gate)
asks as usual if the engines are impaired. A party that withdraws without resolving (the target got
away, or the captain pulled back) leaves the same way with `errand.outcome: "failed"` and the job
`failed`; the narrator is called on it like any other resolution.

## 4. The site map

A site map is a `DockDef` with three additions, so the validator, `render-dock`, the grafting and
the renderer are reused rather than copied:

```
DockDef {
  ...                               // rows, legend, palette, berth box, props, foreground, ambience
  kind: "dock" | "site"             // absent = "dock"
  legend: { char: "floor" | "wall" | "void" | "cover" }   // cover: new, site only
  posts: [{ key, kind, name, tile, facing }]
    // dock kinds as today, plus site kinds: target | guard | loot | exit | flank | bystander
  noticeRadius: number              // tiles at which the cast notice an approaching party (site only)
}
```

`cover` is floor that blocks a shot when the person is adjacent behind it, and never a route.
Posts are the spots the cast stand at and the plan menu reads: the `target` spot is where the
target stands and where the `loot` item lies when the errand is a thing; `guard` spots are the
cast's; `exit` is where a breaking cast member runs to and where a target slips away through if
nobody holds it; `flank` is a spot that reaches the target by a route sharing no tile with the
ramp foot's shortest route, which is what makes the `flank` plan available; `bystander` spots are
for people who are not in it. The L3 checks (`validate-dock.ts`): every post reachable from the
personnel ramp's landing; at least one `target`, one `exit`; a `flank` post passes the
disjoint-route test; the berth box as for any dock; size under the dock cap so the phone camera
still fits (§camera: 12.8–14.4 px a tile docked).

Phase A1 authors one site: **the Boathouse**, a planet pad on the coast below Tern's Rest (its
`nearPortId`), a long shed with a door at each end, net racks for cover, a jetty as the exit.
A2 adds a cutting shed in the hills above Ossory and a dry-dock warehouse outside the Hub (a
station site is a pressurised bay, `setting: "station"`, with the same rules). Templates
composed from a kit are deferred: three authored maps teach us what the kit needs.

## 5. People at the site

### 5.1 Combatants are actors; bystanders are locals

Dockside §5.1 locals are presences: no needs, no skills, no planner, their own table so no
system can forget to skip them. That is the right thing for someone mending a net in the
corner, and the wrong thing for someone with a blaster: SD §18.1 says hostiles use the same
bodies, movement, knowledge, inventories and actions as the crew. So the target and the guards are
`Actor`s with `crew: false` and a new `combatant: { side: "them" | "us"; disposition }`, spawned
from a per-game `gen.` crew def at landing, standing at their posts, carrying their arms as items
in hand; bystanders are locals at `bystander` posts. Cast actors never plan work: `crew: false`
keeps them out of the planner's ordinary classes exactly as it does for the D50 passenger
template, and the combat planner class (§8) is the only one that takes them.

### 5.2 Dispositions

A cast member's disposition is the narrator's main instrument. Written in tiers (words, not
numbers), mapped to numbers by the translator from `config.expedition`:

```
SiteCastEntry {
  name, role, look                      // as a staged new face (§staging-plan-command)
  part: "target" | "guard" | "bystander" | "ally"
  arms: "none" | "melee" | "blaster"
  resolve: "shaky" | "steady" | "hard"  // how much it takes to break them
  tie: "paid" | "bound" | "devoted"     // loyalty to the target; ignored for the target and bystanders
  wants: "money" | "out" | "blood" | "nothing"   // what a parley can offer them
  post: LocalKey                        // a target/guard/bystander post on the site map
}
targetStance: "willing" | "afraid" | "bargaining" | "defiant"
```

In sim state each becomes `Disposition { side; resolve: number; loyalty: number; wants; state:
"steady" | "wavering" | "breaking" | "fled" | "surrendered" | "turned" }`. `paid` guards break
early and take safe passage; `devoted` ones hardly break and never turn; `wants: blood` cannot
be bought. The target's stance is its own table for the parley roll (§9.1): `willing` comes at
the first word, `defiant` fights to the end unless everyone around them has gone.

Caps the kernel enforces (`SITE_LIMITS`, beside `STAGING_LIMITS`): six people, three armed, one
target, one ally, two scripted turns, text lengths as staging's.

### 5.3 The default cast

Each site def carries a `defaultCast` the sim places when the staging call fails or no narrator
is running (the null narrator, headless runs, A1 before the narrator knows sites): a target at
the target post with `stance: "bargaining"`, two guards, `paid` and `steady`, one with a blaster;
one bystander. It is a complete, correct site, as the floor set is a complete dock (dockside
§5.2), and it is what A1's instrument measures against.

## 6. The errand job

No new entity (D50's rule): `Job.errand`, beside `Job.passage`.

```
JobErrand {
  kind: "fetchPerson" | "fetchItem"
  siteId: PortDefId                    // a kind "site" port
  target: { name: string } | { itemDefId: ItemDefId; label: string }
  wants: "alive" | "either" | "dead"   // fetchPerson only
  returnToPortId: PortDefId
  outcome?: "broughtAlive" | "broughtDead" | "broughtItem" | "cameWillingly" | "failed"
}
```

`fromPortId` is where it was offered, `toPortId` is `returnToPortId`, so the pay band, the
receiver at the warehouse door and `contractCompleted` all work as for freight once the ship is
back. Pay is banded by path distance to the site and back plus a `config.commerce.priceBands.
errand` premium; `wants: "dead"` pays no more (§cards-never-mention-pay: nobody talks pay; the
premium would only show in the balance). The job carries no cargo until the expedition resolves: a
`fetchItem` then holds the thing as its one `CargoLine` (it is a real `Item`, carried aboard by hand
and delivered to the bay like a crate, §delivery-and-pay), and a `fetchPerson` brought alive gains a
`passage` (`captive: true`, `roundTrip: false`, `leg: "back"`) so the passenger machinery houses,
feeds and walks them: they board from where they stood, sleep in a spare bunk, never work, and are a
natural speaker on the way home. A target brought dead is a `body` item in the hold; the crew
notice it (a `sawTheBody` thought for whoever carries it).

**Kill jobs are allowed from the start, rare and dirty (owner).** The translator accepts
`wants: "dead"`; the prompt says the issuer of such a job is never clean, that it should be rare
against "Past arcs", and that the crew will carry it in their thoughts (§11). The sim does not
moralise: the captain chooses, the people in it react.

Failure: a target who reaches the `exit` while nobody holds it, or who dies when `wants:
"alive"`, or a party that withdraws, fails the errand (`status: "failed"`, no pay); the narrator
is told and the arc closes on a card like any other (D54, §past-arcs `shape: "snatch job gone wrong"`).

## 7. Bodies, arms and the damage path

### 7.1 Bodies, at SD §12's minimum

SD §12 and §18 are explicit: no parallel health model; one damage path. `Actor.body` lands now,
small enough to finish in a phase and shaped so medicine (phase B) and fire (ship-life slice 7)
extend it rather than replace it:

```
Body {
  parts: Record<"head" | "torso" | "leftArm" | "rightArm" | "leftLeg" | "rightLeg", { damage: number }>
  blood: number          // [0, 1]; falls while any wound bleeds; recovers slowly
  pain: number           // [0, 1]; the sum of wounds' pain, decays
  wounds: Wound[]
}
Wound { id; part; severity: "graze" | "serious" | "grave"; type: "blaster" | "blunt" | "stun"; bleeding: boolean; tick }
```

Capacities are derived by the SD §12.2 formulas into the `Capacities` that already sit on every
actor waiting for this (`movement` from the leg chains, `manipulation` from the arm chains,
`consciousness` from blood, pain and head damage), so walking speed, work and the helm slow down
with no new code in those systems. Incapacitation (`availability: "incapacitated"`) is
consciousness below a configured floor or movement at zero; death is a `grave` head or torso
wound past tolerance, or blood below the configured floor: thresholds, never a timer (SD §12.4).
A `stun` wound carries no damage, adds consciousness debt that clears in a few minutes, and never
bleeds. Bleeding stops on its own at a slow configured rate in A1; first aid is phase B, and until
then a `grave` bleeder is a race to the ship that can be lost. **Crew, the captain included, can
die, tuned rare; the narrator never scripts a death; the captain's death hands command to the
first officer (owner)** by D8's `isFitForCommand`, which already reads `availability`; the
expedition's leader passes the same way (§8.5).

`applyDamage(ctx, actorId, hit)` in `systems/damage` is the one entry point, beside the hull's:
it picks the part from the hit's table, writes the wound, recomputes capacities, commits
incapacitation or death at once (SD §5.2 step 1), and emits `wounded` / `incapacitated` / `died`
with `causeIds` naming the shooter and the expedition.

### 7.2 Arms

Weapons are items (`ItemDef.weapon: { kind: "blaster" | "baton"; range; aimSeconds; hit;
damage; stun?: true }`, tag `weapon`); fists are the absence of one. Mk2 gets an **arms locker**
in the officers' passage (`machine.arms_locker`, a lockable zone like the bunk lockers of §lockers)
holding three blasters with a stun setting and two batons. Scarcity is the design: with three
blasters for nine people, "only those with blasters go in" is a real squad rule and a plan that
sends six people in sends three of them unarmed. A new skill, `fighting`, joins `SKILLS` (a code
change by W0's rule); crew defs get values (the first officer and the deckhand highest, the cook
lowest) and it grows by use as other skills do. Armour is an equipped item with a protection
number in phase C; A1 has none.

## 8. The fight

### 8.1 Where it runs

A `combat` system in the pipeline at phase 3 (movement and actions), after travel and before
needs, active only while `state.expedition.phase` is `fight` (and `approach` for noticing, §8.4).
It gives each combatant an intent each half-second through a combat planner class that sits
above `immediateSurvival` for the party and is the only class for cast actors, reusing A* and the
movement system untouched. Everything it does is one of SD §18.1's list, no more:

- `takeCover`: the nearest `cover` tile with a line to a threat;
- `advance`: toward the objective post along a route that prefers tiles beside cover;
- `fire`: aim for `aimSeconds`, then roll; needs a line and range;
- `melee`: adjacent, a baton or fists;
- `guardPassage`: stand on a door or `exit` tile and hold it;
- `retreat`: to the ramp foot (party) or an `exit` (cast);
- `rescue`: drag an incapacitated ally out of every line of fire, then to the ramp.

Lines of sight are a tile walk on the grafted grid: `wall` blocks; `cover` blocks when the target
is adjacent behind it; people never block. Hit chance = weapon base × a `fighting` curve × range
falloff × cover penalty × posture (a mover is harder to hit; someone firing from cover is
hardest), clamped to [0.05, 0.95] like the piloting check (§hazard-roll). A miss ends on the first
wall tile along the line (no equipment damage in A1). A hit picks a part from a weighted table
(torso 45, legs 25, arms 20, head 10), limbs only on `stun`. A blaster hit is `serious` by default,
`grave` on the head or a torso crit, `graze` at long range; a baton is `blunt`, `graze` or
`serious`, never bleeding.

### 8.2 Morale is the engine

Fights end by breaking, with one or two wounds, not by attrition. Every combatant's `resolve`
moves each second: down for a wound, an ally down, no cover under fire, more enemies in sight
than friends, the target gone (for guards) or taken; up for an ally landing a hit, reaching
cover, the leader within three tiles. Thresholds with hysteresis: `steady` → `wavering` →
`breaking`; a breaking person `retreats` if an exit is reachable, else `surrenders` (drops the
weapon, kneels, out of the fight) — unarmed people surrender at once. A `turned` ally fights for
the party. The crew have resolve too: from `fighting`, mood (§mood-and-work-speed) and affinity to
the leader (§affinity): an unarmed cook sent in on `assault` wavers at the first shot, which is why
the squad rule matters, and why a captain the crew are at odds with leads a worse fight.

The owner's "convince some of them to run and take just the guy you want" is this system doing
its job: two `paid` guards `breaking` after the first exchange, and `parley(safePassage, "the
hired men")` on the lull card rolled against resolve that is already gone.

### 8.3 Battle plans

```
BattlePlan {
  id: PlanId                          // a menu id; a card carries only the id
  squad: "everyone" | "armedOnly" | "blastersOnly" | "smallTeam"
  posture: "assault" | "hold" | "flank" | "bait" | "creep"
  fire: "lethal" | "stun" | "holdFire"
  objective: "takeTarget" | "takeItem" | "breakThem"
  targetMustLive: boolean             // from errand.wants; the plan never overrides it
  withdrawWhen: "firstDown" | "halfDown" | "never"
}
```

What each posture does, and why it looks different on a phone at 1× with no number on screen:

- **assault**: every dot moves to contact at once, firing on the move; 20–30 s, loud, more wounds
  both sides, breaks them fastest; the target rarely reaches the exit.
- **hold**: the party fans into cover between the ramp and the site and fires only at what shows;
  slow, few crew wounds; the target walks out the exit unless an ally or a turn stops them, and a
  `devoted` guard set never comes to you.
- **flank**: the squad visibly splits, the smaller group round the `flank` post; needs four fit
  people and a flank post; when the second group appears every guard takes an "outflanked" hit to
  resolve, at the cost of the small group being exposed meanwhile.
- **bait**: one visible dot (the leader by default) walks in talking while the rest hold in
  cover; turns a parley into an ambush; a failed roll leaves the bait exposed.
- **creep**: approach outside `noticeRadius` to the target or loot post; against a `shaky` cast,
  or a target who is `willing`, it ends with nobody noticing; when noticed it becomes `assault`
  from close.

`fire: stun` needs about two hits to drop someone and moves resolve less; `lethal` drops in one
and leaves bodies and thoughts. `withdrawWhen` is visible on the floor: at `firstDown` the party
turns and runs the moment someone falls. The combat planner never second-guesses a plan; it is
the captain's order, and the crew carry it out as they carry out every card (GDD §22 step 7).

### 8.4 The plan menu

The menu is the capability list made spatial. `planMenu(state, content): PlanOption[]` is a pure
function in `packages/sim/src/view` (the narrator package reads it off the snapshot for the
digest; the kernel re-derives it at apply time to validate a chosen id, which is what the
`AUTHORITY.player` revalidation of a card side needs). Each option carries `id`, the plan, `
available`, and `why` ("flank needs four fit people and a second approach: only three fit";
"creep: they have already seen you"). The cross product of five postures, three fire rules and
four squad rules is pruned hard: a squad rule that changes nobody is dropped, `holdFire` exists
only with `bait` and `creep`, and the menu shows at most eight with handles the narrator copies
(`assault-stun-armed`). The default pair the sim offers when no narrator answers is `hold` versus
`assault`, both `lethal`, `armedOnly`, with `targetMustLive` from the errand.

Who writes plans was the sketch's weakest point. The model in production is luna at `low`
(§models-and-reasoning-effort, D102) and the grammar-size history is the model getting ids wrong; a plan composed from parts would be
infeasible often enough that a dropped side leaves a one-option card. So the sim writes the
plans, the narrator picks two by id and voices them, and the kernel falls back to the default
pair. Range comes from the size of the menu and the framing, not from free composition.

### 8.5 The party

The captain leads by default **(owner)**: it is a captain's job, and the cards at the site need a
perspective actor there (D8). The squad rule picks who else goes from the crew who are fit and
aboard, in rank order, never the helm stander or the gangway watch (§gangway-watch-and-rounds: the
ship keeps her watch). The party musters at the arms locker (blasters by `fighting`, then batons),
walks down the personnel ramp and stands at its foot: that is `approach`, and nothing has been
decided yet. If the leader falls, the senior fit party member (the first officer when present, else
highest `fighting`) leads, and D8 moves the card's perspective with command.

### 8.6 Legibility and ending

Everything surfaces through what exists: the action label on each dot ("in cover", "firing",
"wavering", "running", "down", "dragging Priya"); a brief tracer line per shot and a flash on a
hit (the field's impact flash, §asteroid-field-scars-and-alert); the alert banner; one word a side
in the shore header ("Us: steady · Them: breaking"); ship's-log lines only at the moments that
matter (first shot, first down, someone breaks, surrender, the target taken or gone); and
`host.slowDownOnEvents` gaining `expeditionContact` so fast play drops to 1× when the shooting
starts (§auto-slowdown). No numbers anywhere player-facing (GDD §22).

The fight resolves when one side is all down, fled or surrendered, when the objective is held
(the target in hand or carried, the item picked up, and the party back at the ramp foot), or when
`withdrawWhen` is met; `expeditionResolved { outcome }` is emitted, the alert stands down
`field.alertClearSeconds` later as after a field, and the party carries everyone and everything
aboard (§3.5).

## 9. Parley, and the narrator's range

Owner: the narrator needs a lot of flexibility. Everything here gives it range without a verb
the sim lacks.

### 9.1 Parley, rolled by the sim

A card side may carry `parley { offer: "money" | "safePassage" | "threat" | "appeal"; to: a cast
name | "them" }`. The sim rolls each addressed cast member's answer from a table of `offer` ×
`wants`, moved by resolve, the visible force ratio (armed party in sight against armed cast), the
target's stance when the target is addressed, and the leader's `fighting` for `threat`;
`p = clamp(base + terms, 0.05, 0.95)`. Answers are per person: `walks` (leaves by the exit),
`turns` (fights for you; allies and `paid` guards only), `holds`, `attacks` (the fight starts,
and that person fires first). `money` costs the ship a banded sum from its balance when accepted
(the only place an errand spends; never on a card, §cards-never-mention-pay) and is unavailable when
the balance cannot cover it (the capability block says so). The narrator loads the dice; the sim
throws them.

### 9.2 What the staging call writes

`stageSite` is a staging-class call (the rules of §staging-call-on-the-server: guaranteed,
story-free, its own schema and translator, failure falls back to the default cast, the hook window
admits only it). It is raised when the ship reaches the transit lead point before the site, exactly
where `stageDock` is raised for a port, so the narrator knows the leg's events when it casts the
site. It writes a `SitePlan`:

```
SitePlan {
  cast: SiteCastEntry[]                 // §5.2; the target's entry is required
  targetStance: "willing" | "afraid" | "bargaining" | "defiant"
  turns: ScriptedTurn[]                 // at most two, §9.3
  ambience?: string                     // one line for the log as the ship sets down
}
```

### 9.3 Scripted turns, under a guard

Owner-aligned: a capped form of scripted turns is in the first narrator phase, the way the scripted
impacts of §scheduling-a-field gave the narrator real control of the field.

```
ScriptedTurn {
  when: "onLanding" | "firstShot" | "firstDown" | "targetHit" | "lull"
  who: "guards" | "ally" | "newcomers" | <a cast name>
  does: "flee" | "turn" | "arrive" | "comeToTheRamp"
}
```

`flee` sets the named people to `breaking`; `turn` makes an ally or `paid` guard fight for the
party; `arrive` spawns up to two more cast at an `exit` post (armed as the turn's cast entry
says, counted against the three-armed cap); `comeToTheRamp` walks a cast member to the ramp foot,
which is how "a cast member approaches the ship on landing" happens, and makes them the speaker
of the arrival card in person (§delivery, unchanged). The kernel guard, the sibling of the
field's hull guard (§scheduling-a-field): **a turn may change who is on the floor and which way they
face; it may never wound, kill, move or remove the target, and never leave more armed people on the
site than `SITE_LIMITS.armed`.** A turn that would is dropped with a reason the narrator reads next
call.

### 9.4 The approach effect, before landing

The narrator asked for its departure call (§requested-call-back) sets the leg's beat; on this leg
that beat is usually a card about the job ahead, and its sides may carry `approach: "sendWordAhead"
| "comeInQuiet" | "showForce"`, stored on the expedition and applied to the cast at landing:
`sendWordAhead` moves the target's stance one step toward `bargaining` and sets every guard
`steady` or better (they know you are coming); `comeInQuiet` halves `noticeRadius` for `creep`
and leaves dispositions alone; `showForce` moves `paid` guards one step toward `shaky` and
`devoted` ones toward `hard`. The captain chooses with the first officer's or the deckhand's
word on the card ("Send word we're coming." / "Go in quiet."), and the approach card at the site
shows the result in the cast's bearing. It is a card side effect like `privateTalk`
(§private-talk-effect): a player-authority command, never the narrator's alone.

### 9.5 What stays the narrator's

The nouns and the prose: who is at the site, what they are like, what they want, what the
issuer said the job was and what it really is (the notes keep the truth until a card earns it,
as with passengers), which two of the menu's plans the captain is offered and in whose words,
which cast member speaks, and the turns. What stays the sim's: every roll, every wound, who
breaks, who dies, whether the target gets away. What the narrator cannot do: invent a posture,
offer or weapon (a wish goes in its notes), script a death or a capture, change dispositions
after landing except through the player's card sides.

## 10. Narration cadence

### 10.1 Calls

| Hook | Kind | When | Writes |
|---|---|---|---|
| `captainAshore` / `quietTooLong` | story | at a port | `offerJob` with errand fields |
| `requestedCall` (departure) | story | the leg out | a beat card, perhaps with `approach` sides |
| `stageSite` | staging | transit lead point before the site | the `SitePlan` |
| `expeditionArrived` | story, guaranteed | the party stands at the ramp foot, the cast in sight | one card: two of `adoptPlan`, `parley`, `wait`, `withdraw` |
| `expeditionTurn` | story, at most once a fight | first side to `breaking`, a `lull` turn, or `withdrawWhen` met; the sim holds fire | one card: two of `pressOn`, `acceptSurrender`, `letThemRun`, `adoptPlan`, `parley`, `withdraw` |
| `notableEvent` (`expeditionResolved`) | aftermath (§notable-event-hook list) | the fight over, the party aboard | the people in it, or nothing |
| `notableEvent` (`contractCompleted` / job `failed`) | story | delivery at `returnTo` | the closing card (D54) |

Four calls more than a freight job (one of them staging), inside D102's regime and the cadence of
§requested-call-back. `expeditionArrived` and `expeditionTurn` are spacing-exempt like
`requestedCall`: each is raised once and the sim is waiting on it. If `expeditionArrived` fails
after D43's retries, the default pair goes up as a template card (the only non-staging exception to
D43 in this design, because the party is standing in the open and the alternative is a frozen
fight); `expeditionTurn` failing lets the fight run on.

### 10.2 Contract changes

`packages/narrator/src/contract.ts`: `offerJob` gains `errandKind`, `site`, `targetName`,
`targetItem`, `wants`, `returnTo` (empty strings for freight and passages, §narrator-authority; the
translator checks the site is authored, the item exists, and `wants` is empty for a thing).
`decisionSide.effect` gains `adoptPlan` (`planId`), `parley` (`offer`, `to`), `wait`,
`withdraw`, `pressOn`, `acceptSurrender`, `letThemRun`, `approach` (`how`). `AUTHORITY.player`
gains the matching commands (`adoptPlan`, `parley`, `withdrawParty`, `acceptSurrender`,
`letThemRun`, `setApproach`); `narrator` and `STAGING_COMMAND_KINDS` gain `stageSite`.
`HookContexts` gains `stageSite { siteId; defaultCast }`, `expeditionArrived { jobId }`,
`expeditionTurn { jobId; reason }`. The capability block gains "Sites" (per port: each site,
one line, its posts that matter, its default cast's shape) and, while an expedition runs, "At the
site": the map in words (approaches, cover, exits), each cast member with role, arms, where they
stand and their *visible* bearing (a word from `state`, never the number), the target's stance
as the crew can see it, the party and their arms and fitness, and the plan menu with `available`
and `why`. Threads need nothing: the episode is a job-shaped thread (§threads-and-scales),
`arcNotes` and `endedArcs` carry it (§past-arcs), and a cast member who survives is a cast entry
with the site's near port as `portId`.

### 10.3 Prompt

A new paragraph in the system prompt (bump `PROMPT_VERSION`): an errand is the kind of story
that is about a person; who is at the site and what they want is yours to cast, and the sim will
play them; offer two of what "At the site" lists and say them in the words of whoever brings the
card (the first officer at the captain's shoulder, a cast member who has walked to the ramp);
never state a wound, a death or a capture the digest does not show; a kill job is rare and its
issuer is never clean; most expeditions should turn (a turn, a parley that fails, a guard who
was not paid enough) and "Past arcs" says whether the last one did. The three hook instructions
follow the table above.

## 11. Consequences

Thoughts (`THOUGHT_KEYS`, with content rows): `killedSomeone` (long, heavy), `sawCrewHurt`,
`heldTheLine`, `ranFromAFight`, `wounded` (while any wound is open, stacking by `refId`),
`broughtOneBackAlive`, `sawTheBody`. Memories (`social.memories`, §memories): `foughtBeside`,
`carriedMeOut`, `leftMeBehind`, with the affinity moves config gives them. Lasting wounds persist
across voyages and slow work and the helm (SD §12.8), which is the first thing the crew will
notice about a bad fight. Cast: every surviving cast member stays in the narrator's cast with
the near port, and the prompt says a man who ran from your crew remembers it. A per-port
`heat` (soft state, decays per day, narrator-visible under the port's line) rises with a loud
fight at a site near that port; it is a story lever for later ("the Rest's constable is at the
gate"), not a mechanic yet. A captive aboard is a passenger with a line in the digest and a
natural speaker; what the crew make of them is their cards.

## 12. Where things live

| Concern | Package |
|---|---|
| `PortDef.kind`, `DockDef.kind`, cover, site posts, `defaultCast`, L3 site checks | `packages/content` (`schemas/port.ts`, `schemas/dock.ts`, `validate-dock.ts`) |
| `isSite`, known sites in the graph, landing headlines, lift-off | `packages/sim/src/core/places.ts`, `systems/travel` |
| `Body`, `applyDamage`, capacities from wounds, weapons | `packages/sim/src/core/types/actor.ts`, `systems/damage`, `schemas/item.ts` |
| `Expedition` state, the muster, the walk, the combat planner class, morale, parley rolls, turns | `packages/sim/src/systems/expedition` (new), the planner's new class |
| `planMenu` | `packages/sim/src/view` |
| `stageSite`, errand offer fields, side effects, digest sections, prompt | `packages/narrator` (`contract.ts`, `translate.ts`, `staging/`, a `site-digest.ts`) |
| The site drawn in the dock's place, tracers, labels, the shore header | `apps/web/src/render`, `apps/web/src/ui` |
| `crew expeditions` instrument | `apps/cli` |

## 13. Decisions

Owner:

1. The ship lands at the site: a site is its own travel destination with a pad, not a place
   beyond a port's gate; the party walks down the ramp onto it; the ship lifts off back to a port.
2. Crew, the captain included, can die, tuned rare; the narrator never scripts a death; the
   captain's death hands command to the first officer.
3. Kill jobs are allowed from the start, rare and dirty.
4. The captain leads the away party by default.

Delegated, taken here:

5. A site is a `PortDef` of `kind: "site"` with one route to its near port, on the graph only
   while an errand names it, so travel, voyages and headlines change by a predicate, not a type.
6. The site map is a `DockDef` of `kind: "site"` with cover tiles and site posts, so grafting,
   berthing, validation, rendering and the camera are reused.
7. Landing is the existing approach/docking stage pair with a planet scene and no quay structure.
8. Combatants are actors with the crew's bodies and movement; bystanders are locals.
9. Bodies land at SD §12's minimum (six parts, three severities, blood, pain, consciousness) with
   one damage entry point; medicine follows in its own phase.
10. Arms are a scarce ship's locker; `fighting` is a skill.
11. Fights end mostly by breaking: morale is the resolution currency.
12. The sim writes the plan menu; the narrator picks two by id and voices them; the kernel's
    default pair is the fallback.
13. Dispositions, the target's stance, up to two scripted turns and the pre-landing approach
    effect are the narrator's range; turns never harm, move or remove the target.
14. `stageSite` is a staging-class call at the transit lead point, and the sim's default cast is
    its floor set.
15. `expeditionArrived` and `expeditionTurn` are guaranteed, spacing-exempt story calls; a failed
    arrival call puts up the default pair.
16. The expedition ends by setting course home itself; the captain's choice to go is on the lull
    card, not a second card.

## 14. Open questions, with recommendations

1. **Should a port's gate ever lead to a site?** Not now. Landing gives the exposed ship, the
   ramp as the line, and the gangway watch a job. If a town site is wanted later (a bar in
   Vesper Gate), the walk-through-the-gate version is a second entry path to the same expedition
   state, not a different design.
2. **Does the whole ship wait at the site, or can it lift off with the party out?** Recommend it
   waits: the ramp is the party's line of retreat and lift-off with people on the floor is
   refused today (D59). A "leave them" card is a phase C question, and a dark one.
3. **The sim setting course home itself versus a card.** Recommend the sim does (decision 16):
   the lull card already asked the real question and D49 rejected a card per leg. If a playtest
   shows players wanting to linger (loot, a second try), add `wait` to the resolved call's sides.
4. **Bodies versus a scalar.** Recommend the SD §12 minimum as designed; a scalar would be thrown
   away in phase B and SD §18 says not to build it.
5. **Should hostiles ever board?** A breaking guard runs to an exit, never up the ramp; a
   `devoted` one on `assault`-minded cast could. Recommend no boarding until the boarding slice
   (phase D), with `guardPassage` on the ramp foot as the party's standing order while any cast
   is up.
6. **Narrator-invented sites.** Recommend phase C, through the `gen.` namespace and a kit of
   authored map pieces; three authored sites first, so the kit is designed from what the maps
   needed.
7. **Game over.** With the captain dead the first officer commands and play continues (GDD §14).
   Recommend no new end state now; a ship with nobody fit to stand the helm is already a stuck
   ship, and that is the right failure for a slow game.

## 15. Phasing

Each phase is one gate commit for contracts, parallel workstreams, an integration commit, and a
D-entry; the plan for each is written when the one before lands.

**A1 — the fight, measured.** Bodies-lite and `applyDamage`; weapons and the arms locker;
`fighting`; `DockDef.kind: "site"`, cover and site posts, L3 checks, the Boathouse map with its
`defaultCast`; `Expedition` state driven by a scenario command (`scenarioStartExpedition`, no
travel yet: the ship starts landed at the Boathouse with the cast placed); the combat planner
class, the seven actions, lines, hits, wounds; morale, breaking, fleeing, surrender; the five
postures, fire rules, squad rules and `planMenu`; `rescue` and carrying aboard; the renderer's
site look, labels, tracers, the shore header; thoughts and memories. The **`crew expeditions`**
instrument (apps/cli, beside `crew beats`): N fights per plan against the default cast and two
tuned variants (`shaky`/`paid`, `hard`/`devoted`), reporting outcome mix, fight length, wounds and
deaths a side, the share of fights ended by breaking rather than attrition, and how often the
target reaches the exit. The acceptance question is the owner's: does `hold` play differently
from `assault`, visibly, at 1× on a phone, and are deaths rare? Save schema bump for `body`. (The plan, `docs/design/expeditions-plan.md`, brings
the site's `PortDef` of `kind: "site"` and its one route forward into A1, since a site map needs a
port to own it; the scenario command swaps the docked map for the site's. A2 keeps `knownSites`.)

**A2 — the expedition end to end.** `PortDef.kind: "site"`, known sites in the graph, landing and
lift-off scenes and headlines, the exposed ship (visitor to the ramp, alert on contact, the
intercom fact); `Job.errand` with both kinds and `wants`, the offer fields, pay, the captive as
passenger, the body item, delivery and `contractCompleted`; the muster and the walk; `stageSite`
with cast tiers, the stance and two scripted turns under the guard; parley with four offers; the
approach effect; hooks `expeditionArrived` and `expeditionTurn`, `expeditionResolved` in the
aftermath list, the default pair fallback; "Sites" and "At the site" in the capability block and
digest; prompt bump and `pnpm test:live` once; two more authored sites. A phone playtest of one
whole episode: offer at Tern's Rest, the leg, the landing, the card, the fight, home, the closing
card.

**B — medicine and the captive.** SD §12.5: first aid at the site (a kit in the locker), the
medbay bed and definitive treatment, supplies bought at ports; lasting impairment in duties and
the watch bill (the short-handed rotation `ship-life-plan.md` deferred); the captive aboard (a
bunk, a guard, a card when they talk, a passenger who may try the ramp at a port); port `heat`.

**C — range.** Armour; `rampsUp`; `bait` and `creep` tuned with stealth proper; bystanders and
hostages as a parley lever; mid-fight parley (a second `expeditionTurn`); misses damaging site
props and machines; narrator-invented sites from a kit; a cast carrying something that scars the
hull; a kill job's consequences at the near port.

**D — the same system aboard.** Boarding is this system on the ship's own deck (SD §18.1: the
cast arrive through a ramp or a breach, the crew hold passages), and ship-to-ship combat is how an
enemy crew gets there; both reuse bodies, arms, the combat class, morale and the menu.

## 16. Testing

- **Unit (content):** a site port validates with empty stores and no templates and fails with a
  market; a site map validates (cover, posts, the flank route test, the pad box); every authored
  site passes; `render-dock` renders a site.
- **Unit (sim, A1):** `applyDamage` writes wounds and capacities by the SD §12.2 formulas;
  incapacitation and death by threshold only; stun clears; lines of sight through cover and
  walls; hit chance bounds; each posture's first ten seconds of intents on the Boathouse (assault
  moves to contact, hold stays within cover reach of the ramp, flank splits, creep stays outside
  `noticeRadius`); morale crossing and hysteresis; surrender when cornered; `rescue` drags to the
  ramp; `planMenu` availability and `why`; a plan id the menu does not hold is refused at apply.
- **Unit (sim, A2):** a site on the graph only while known; course to a site through its near
  port; landing stages at a site with no fee, no `captainAshore`, no purchases; `stageSite`
  gating the end of transit and the default cast on failure; the guard dropping a turn that
  harms the target; parley answers per person at the table's bounds; the captive boards as a
  passenger; a `fetchItem` delivered to the bay; lift-off refused with anyone on the floor;
  course home set on resolution; `failed` on the target reaching the exit.
- **Narrator:** the site staging translator drops every non-staging intent; `adoptPlan` with an
  unavailable id and `parley` with a name not in the cast are dropped with reasons; the "At the
  site" section never shows a number; an `offerJob` from a site is dropped; the arrival fallback
  card is the default pair.
- **Instrument:** `crew expeditions` in CI at a small N as a regression on outcome mix bounds
  (deaths a fight below the tuned ceiling; `hold` and `assault` outcome mixes differ by a stated
  margin).
- **Live:** one `stageSite` call (a cast naming real posts, a target entry, turns inside the cap)
  and one `expeditionArrived` call (two sides from the menu or a parley, in a named speaker's
  words).
- **Playtest:** a phone playtest at the end of A1 (the scenario start) and A2 (a whole episode).

## 17. Deferred

- Sites reached on foot from a port's gate; several sites per port; sites as voyage waypoints.
- Hull damage from a site; boarding from a site; hostiles climbing the ramp.
- Dispositions changing after landing other than through the player's card sides.
- Composed site maps; narrator-invented sites (phase C).
- Medicine, armour, hostages, mid-fight parley, `rampsUp` (phases B and C).
- A moral or legal system; `heat` is a soft number the narrator reads, nothing enforces it.
- Succession beyond D8 when both officers are down.
