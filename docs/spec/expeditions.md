# Expeditions

Bodies and arms, landing sites, and the fight a party walks into when the ship sets down at one.
Code is in `packages/sim/src/core/{body,sites,places}.ts`, `systems/bodies/`,
`systems/expedition/` and `view/planMenu.ts`; config is under `bodies.*` and `expedition.*` in
`packages/content/data/config/default.json`. Until the captain's card exists (phase A2) an
expedition starts only from `scenarioStartExpedition`, and the narrator never sees a site
(§the-narrator-and-sites). The owner's rulings that shape all of it are D103.

## Bodies

### Bodies and capacities

Every actor has a `body` (`Actor.body`): damage on six parts (`head`, `torso`, `leftArm`,
`rightArm`, `leftLeg`, `rightLeg`), `blood`, `pain` and `stun` in [0, 1], and open `wounds`. A
whole body is no damage, full blood, no pain or stun and no wounds, and gives every capacity 1, so
nothing changes until someone is hurt. The formulas are in `core/body.ts`:

- A part's function is `1 − damage / bodies.tolerance[part]`, clamped to [0, 1] (tolerance 2 for
  the head and each limb, 3 for the torso). A part's damage is the sum of its open wounds'.
- Movement is the mean of the two legs' function, manipulation the mean of the two arms'. One
  `serious` leg wound leaves movement at 0.7; two on one arm leave manipulation at 0.5.
- Consciousness is the weakest of the head's function, the blood term (`(blood −
  deadBelowBlood) / (1 − deadBelowBlood)`) and `1 − stun`, times `1 − pain / 2`.

Capacities have one formula and two writers: `applyCapacities` sets movement and manipulation to
fatigue's curve (§need-urgency-and-crossings) times the body's, and consciousness to the body's.
Needs calls it for the crew it steps, the bodies system for everyone else, and an invariant holds
every actor to it. Walking speed and work slow with no code of their own.

### Wounds and the damage entry point

`applyDamage(ctx, actorId, hit)` (`systems/bodies/damage.ts`) is the only way damage reaches a
body. The hit names a severity (`graze`, `serious`, `grave`), a type (`blaster`, `blunt`, `stun`),
optionally who did it and where it lands; otherwise the part is drawn on the `failures` stream
from `bodies.partTable` (head 10, torso 45, each arm 10, each leg 12.5), or for a stun hit from
`bodies.stunPartTable` (limbs only). It writes the wound, adds `bodies.severityDamage` (0.5, 1.2,
2.5) to the part and `bodies.severityPain` (0.1, 0.3, 0.6) to pain; a stun hit adds
`bodies.stunPerHit` (0.5) to stun instead and does no damage. Then it commits death or
incapacitation at once and emits `wounded` every time, then `died` or `incapacitated`. A
non-stun wound gives the `wounded` thought.

### Bleeding and healing

The bodies system (`systems/bodies/bodies.ts`, phase `needs`, every half second) steps every
living body. A `blaster` wound that is `serious` or `grave` bleeds `bodies.bleedPerSecond` (0.004,
0.012) off blood until it stops on its own `bodies.bleedStopsAfterSeconds` (60, 180) after it was
made; blood recovers `bloodRecoverPerSecond` (0.002) while nothing bleeds. Pain decays at
`painDecayPerSecond` (0.01) and stun at `stunDecayPerSecond` (0.004). A wound that has stopped
bleeding heals `healPerDay` (0.5) of its severity's damage a day and closes at 0 (`woundHealed`);
a stun wound closes when stun is back to 0. The `wounded` thought is kept while a wound is open.

So an untreated `serious` bleeder loses about a quarter of their blood and lives; a `grave` one
crosses the death floor at about 62 s, before the bleed stops. Every weapon deals `serious` (fists
a graze), so a fight makes no grave wound: death comes from a second hit to the head or a third to
the torso. There is no medicine yet.

### Going down and death

Death is a threshold, never a timer: head or torso damage at or past tolerance, or blood below
`bodies.deadBelowBlood` (0.25) (`isDeadBy`). Incapacity is consciousness below
`bodies.incapacitatedBelow.consciousness` (0.3) or movement below `.movement` (0.15), put down to
blood, stun or pain. Two stun hits put someone down. Going down (`systems/bodies/down.ts`) aborts
the activity, stops them where they stand and drops what is in their hands onto their tile.
`applyDamage` checks at the hit and the bodies system every step, so blood loss kills later than
the shot. Someone down whose body has recovered past both floors is `available` again; the bodies
system lifts only an incapacity a wound explains.

The dead free their berth (§berth-assignment) and are never planned or stepped. A dead or
incapacitated captain is not fit for command, so command, the card's perspective and the next
walk ashore pass to the first officer (D8, D103).

## Arms

### Weapons and fighting

A weapon is an item with the `weapon` tag and an `ItemDef.weapon` (`kind`, `range` in tiles,
`aimSeconds`, `hit`, `severity`, `damageType`, `stun`: whether it has a stun setting); the schema
requires the two together. `item.blaster`: range 8, aim 1.2 s, hit 0.55, `serious`, `blaster`,
stuns. `item.baton`: range 1, aim 0.6 s, hit 0.7, `serious`, `blunt`. A party member with nothing
in hand fights with fists, a baton at hit 0.5 that grazes. The arms live in the ship's arms locker
(§arms-locker); the config holds no count of them, since the muster hands out what the locker
holds, and a baton always needs adjacency.

`fighting` is the seventh skill. The crew have it from their defs (Dane 5, Sunniva and Mara 4,
Tomas and Jax 3, Noor, Priya and Oyelaran 2, Bettina 1); a cast member's comes from their resolve
tier (`expedition.castFighting`: shaky 1, steady 3, hard 5).

## Sites

### Landing sites

A site is a `PortDef` of `kind: "site"` (`core/places.ts` `isSite`): a landing that sells
nothing, with no market and no job templates, possibly no cast seeds or stores, a `nearPortId`
and exactly one route, to that port. No port lists a site in its routes; a site is on the graph
the ship flies only while it is known (§known-sites). At a site the headline reads "Set down at
<site>" (§the-ship-headline) and nobody goes looking for work (§looking-for-work); what the
narrator sees and may do there is §the-narrator-and-sites.

### Site maps

A site's map is a `DockDef` of `kind: "site"`, grafted alongside like any dock
(§the-graft-onto-the-deck-grid), so berthing, the camera and the drawing are the dock's. It adds:

- `cover` in the legend: not floor, so not walkable. Any tile under a blocking prop is cover too,
  so every dock map has cover (`core/sites.ts` `isCover`).
- Site posts: `target`, `guard`, `loot`, `exit`, `flank`, `bystander`. A dock may carry them and
  a site may carry a dock's; nothing reads a post it does not know.
- `noticeRadius`, the tiles at which the cast notice the party (required on a site, under the
  map's width), and `defaultCast`, the cast placed when nobody stages one (site only).

A cast entry (`SiteCastEntryDef`) is a name, role and look, a `part` (`target`, `guard`,
`bystander`, `ally`), `arms` (`none`, `melee`, `blaster`), `resolve` (`shaky`, `steady`, `hard`),
`tie` (`paid`, `bound`, `devoted`), `wants` (`money`, `out`, `blood`, `nothing`) and a `post` of
its part's kind (an ally at a guard or bystander post). `SITE_LIMITS` caps a cast at six people,
three armed, one target and one ally.

### Site map validation

A site skips a dock's gate, warehouse door, stall and area rules and keeps the rest
(§dock-map-validation). It must have one `target`, one `exit` and at least one `guard` post, and
each `flank` post must be a real second way in: for every ramp landing of every deck that berths
there, with one shortest walk from the landing to the target masked off south of the apron (the
first row with a wall in it), except the target's neighbours, the target must still be reachable
from the flank post. The default cast must fit the caps and stand at posts of the right kinds.

### The Boathouse

`port.boathouse` (planet, near Tern's Rest, one route of 20) and its map `dock.boathouse`, 44 x 30
with the Mk2 berthed at (4, 0); `crew content render-dock dock.boathouse` draws it, and its
README is the map. Below the berth lies the apron, a strip of open shingle with two crates of
cover at (20–21, 21). South of it stands a long shed: doors in its north wall at x 16 and 26, a
west door at (10, 26), net racks of cover at (13–14, 25) and (22–23, 25), barrels at (12, 23); a
hauled-out skiff, blocking, on the open ground east of the shed; a jetty at its east edge as
scenery. `noticeRadius` 4.

Posts: `target` the keeper's bench (21, 27), `loot` the strongbox shelf (22, 27), guards
`bench_end` (22, 26), `east_door` (26, 24) and `west_door_inside` (16, 24), `bystander` the net
bench (29, 27), `exit` `shingle_path` out the west end at (0, 26), `flank` `west_door` (8, 26).
The default cast: Corran Vale, the keeper (target, unarmed, steady, wants out); Hesk Marrow, a
hired hand with a blaster at `bench_end` (steady, paid); Darrow Finch, the keeper's nephew with a
baton inside the west door (shaky, bound); Old Pell, a net mender at the net bench (bystander).
Why: posted at the east door, Hesk never guarded the bench and assault walked over it; and a
keeper fleeing by the jetty ran past the ramp.

### Harrow End

`port.harrow_end` (planet, near Green Meridian, one route of 20) and its map `dock.harrow_end`, a
disused silo yard, 44 x 30 with the Mk2 berthed at (4, 0); its README is the map. Below the apron
lies open stubble with two bale rows of cover one tile thick (x 28 and 33, rows 21–23). A stone
weigh-house (x 14–22, rows 23–27) has a north door at (18, 23), a back door at (18, 27) and seed
sacks either side of the north door; two round silos and a grain auger stand to the west; a seed
container and a drystone wall along row 25 hide the back lane from the yard. `noticeRadius` 5.

Posts: `target` the weigh-house scale (16, 25), `loot` the seed container doors (23, 25), guards
`bale_row` (27, 22), `weigh_door` (18, 24) and `back_door` (18, 26), `bystander` `gleaning` (31,
27), `exit` `farm_track` out the west end at (0, 28), `flank` `back_lane` (18, 28). The default
cast: Teodor Lusk, the co-op steward who sold the Collective's seed (target, unarmed, steady,
bound, wants out); Rhee Castellan, the buyer's hired gun with a blaster at the bale row (steady,
paid); Mattie Lusk, his daughter with a blaster inside the door (shaky, devoted); Amos Wray, the
old silo keeper with a baton at the back door (shaky, bound); Wenna Brae, a gleaner (bystander).
Why: the bale row keeps Rhee in cover seven tiles from the hold spots, so `hold` is a long
exchange of fire where the Boathouse's is short; the weigh-house door stands within Mattie's
reach of the ramp (§the-cast-in-the-fight), so `hold` can draw her out, where a tile or two
further and every `hold` ends with the steward gone; and the yard wall keeps the flank's walk out
of Rhee's sight. Cover two tiles thick blocks a line like a wall, so firing cover is one tile.

## The expedition

### Starting an expedition

`scenarioStartExpedition { siteId, cast?, plan? }` (scenario authority; `systems/expedition/
command.ts`) sets a docked ship down at a site in place. It is refused for an unknown port, a port
that is not a site or has no site map, a ship under way or with a course set, an expedition under
way, anyone or anything on the dock or a ramp, a jammed ramp, a dock hand on an errand, a cast
over the caps or at the wrong posts, or a plan the menu does not hold or marks unavailable. Apply:
the ramps shut, the hub's locals and props go with its dock, the dock is detached, travel becomes
docked at the site, the site's map is attached and the ramps opened. Each cast member is spawned
at their post as an actor (`crew: false`) on a generated `gen.crew.site_*` def (role as bio, look
as voice), a combatant of side `them`, with their weapon in hand. `state.expedition` is written
`mustering` with the party the plan's squad rule picks (§who-goes), and `expeditionStarted` is
emitted.

Without a plan nothing moves until `adoptPlan { planId }` names one from the menu; it picks the
party again by the plan's squad rule. `withdrawParty` calls a party that is ashore back
(§the-objective-and-resolution). Both are also the player's: the sides of the arrival and turn
cards (§the-arrival-card, §the-turn-card). While an expedition is under way `setCourse` is refused,
so the ship never lifts off with the party ashore.

### Who goes

The squad rule picks from crew who are available, awake, aboard (not on the dock), not
passengers, not the helm stander and not on gangway watch, in rank order: the captain first, then
the first officer, then by `fighting`, ties by id (`systems/expedition/plans.ts` `squadFor`).
`everyone` takes them all; `armedOnly` as many as there are weapons in the locker; `blastersOnly`
as many as blasters; `smallTeam` the captain and the two best at `fighting`. The first is the
leader. While the leader is down or dead the lead passes to the first of the party in that rank
order who is not, and comes back when the leader is up (`leaderNow`); "leader near" in morale
(§morale) reads whoever leads now. Why the captain: the owner's ruling (D103).

### The muster

With a plan, the expedition system hands each party member a `muster` activity as commerce hands
out `lookForWork`: a personal intent at essential operation, re-handed every tick until it starts,
giving way to survival. They walk to the arms locker's `use` tile, `arm` for 2 s, and walk to the
foot of the personnel ramp. Arming gives the best weapon left: among the party not yet armed,
ranked by `fighting`, the top as many as there are blasters take one, the next as many as batons
a baton, the rest nothing, so whoever reaches the locker first never takes a better fighter's
blaster. Arming makes them a combatant of side `us`, and the weapon is recorded as the ship's
(`Expedition.arms`). When the ship plans her lift-off after the fight, every one of the ship's
weapons goes back into the locker wherever it ended up (in hand, dropped on the site's floor), and
the cast's weapons left on the ground stay there, so no "left behind" line. Why: nobody puts a
weapon back on their own and the muster arms only from the locker, so every fight emptied it.

Phases (`Expedition.phase`): `mustering`; `walkingOut` once the whole party is armed
(`partyMustered`); `approach` once the leader stands on the site floor in the fight (or anyone,
with the leader down); `fight` at contact; `resolved`. A party member on the site floor done with
the muster goes into the fight.

### The arrival card

Set down at a site for an errand, the expedition starts itself (`systems/expedition/start.ts`
`landedForErrand`): the first tick the ship is `docked` at a site with that site's map alongside
and no course away planned, with an `inTransit` errand naming the site whose `outcome` is unset,
and never twice for one errand. The cast is the map's `defaultCast` with the one `target` entry
named for the errand's `targetName` (`castFor`); a `fetchItem` errand leaves the cast as authored
and puts the item down at the `loot` post. The caps and posts are checked as for the start
command, and a cast that fails is a content bug and throws. The expedition is written with no
plan and `Expedition.jobId`; nobody moves until a plan is adopted.

It queues the arrival card through `queuePolicyDecision` (§policy-decision-cards): prompt key
`expedition.arrival`, no `jobId` on the record, so its `policyDecision` hook is raised the tick it
is queued and the world halts on the hook and then on the card; nothing of the fight runs while it
is up. The first officer brings it. Its sides are two plans from the menu (§the-plan-menu), each an
`adoptPlan`: `hold-lethal-armed` and `assault-lethal-armed` when both are available, else the
first two available. A side's label says what the plan does ("Hold the ramp from cover", "Go in
and take them", with ", to stun", ", holding fire", ", all hands", ", blasters only" or ", a small
team" when not the usual) and its aftermath what happens next ("We make them come to us."), with
no numbers. The prompt params name the job, the site, the target, the speaker and both plans
(`leftPlan`, `rightPlan`, `leftLabel`, `rightLabel`, `leftWhy`, `rightWhy`), and each side's own
refs carry its label and why. Choosing a side adopts the plan and the muster begins
(§the-muster). A plan adopted for an errand that wants the target `alive` has `targetMustLive`
(§fire-and-targets). With fewer than two plans available there is no card, and the expedition
resolves `timedOut` `expedition.maxApproachSeconds` (90) after it started. Why a policy card and
not a story hook: the narrator dresses the sim's pair and cannot choose the plans, a lever the
owner has not ruled on (D6).

### The turn card

Once in an expedition that started itself for an errand, and only in the fight, the turn card is
queued the tick the first of the party breaks, goes down or dies (`systems/expedition/cards.ts`
`queueTurnCard`). One of theirs breaking or giving up asks nothing: the fight going the party's
way is the ticker's to tell. Why: a card asking whether to press on as a guard runs was no
decision at all. It is not queued once `objectiveTick` or `withdrawTick` is set, nor if
the fight ends that tick; it is checked after the tick's withdrawal and objective, so a
`withdrawWhen` that fires that tick asks nothing. A policy card with prompt key `expedition.turn`
and no `jobId`, its params are `jobId`, `site`, `actorId`, `name`, `side` (`us` or `them`), `how`
(`breaking`, `down` or `dead`) and `speaker`: the first officer if they can stand, in the party or
calling it from the ramp head, else the first of the party in rank order (§who-goes) on their
feet; never the one in command (§captain-never-speaks) nor the one the card is about, and then
nobody is named. The arrival card's first officer is likewise never the one in command, and a
first officer who is down or dead brings no card (`firstOfficerOf`). "Press on" changes nothing;
"Pull back to the ship" is `withdrawParty` (§the-objective-and-resolution). `Expedition.cards`
records both cards. A `scenarioStartExpedition` run gets neither.

## The fight

### The combat system owns its combatants

During the approach and the fight each combatant's activity is a personal `fight` whose label is
what the combat system last decided ("in cover", "firing", "advancing", "running", "dragging
Priya"); the expedition system moves them itself through `requestMove` and `stopMovement`. The
planner answers `continue` for `fight` and `muster`, and work does not step a fighter. Cast actors
are never crew, so never planned or stepped at all. The system runs in phase `actions` after
spatial and before work.

Each combatant decides every `expedition.decideEverySeconds` (0.5), staggered by their place in
the party or cast. A tick: bodies first (the down and the dead are out; someone back on their
feet returns wavering), then shots whose aim is done, then the decisions due, then arrivals.

### Lines of sight and cover

A line runs centre to centre and is blocked by a wall, void or off-map tile, or by cover not
8-adjacent to either end (`systems/expedition/los.ts`); people never block. Through a tile corner
it is blocked only when both tiles beside the corner block. Someone is in cover from a shot when a
cover tile 8-adjacent to them lies on the line. Lines are walked only at decisions and shots.

### Contact and the alert

Contact (`expeditionContact`, the fight phase) comes at the first of:

- a guard or ally on their feet seeing a party member on the site floor within `noticeRadius`
  (half of it for one whose resolve starts below `morale.waverBelow`: the shaky are not
  watching);
- the first shot;
- the party ashore `expedition.contactAfterSeconds` (10) under any posture but `creep` (the
  landing was loud);
- a creeper beside the objective (they show themselves).

Contact raises the alert with cause `fight` (`alertRaised`), which works aboard as the field's
does (§sighting-and-the-alert), and puts the cast into the fight. An approach with no contact
`expedition.maxApproachSeconds` (90) after it began ends `timedOut`.

### Shots and hits

To fire, a combatant aims at a mark; the shot lands `aimSeconds` later if the mark is still on
their feet, in sight and in reach (a baton needs 8-adjacency). The chance is `weapon.hit ×
(expedition.hitSkillBase + hitPerFighting × fighting) × range falloff × cover × moving`, clamped to
[0.05, 0.95], drawn on the `failures` stream keyed by shooter, target and tick. Range falloff runs
linearly from 1 at point blank to `rangeFalloffFloor` at the weapon's range; cover is
`coverPenalty`; a moving target `movingTargetFactor`, a moving shooter `movingShooterFactor`. A
hit goes through `applyDamage` with the weapon's severity and type, or as `stun` when the party's
plan fires stun and the weapon has the setting. `shotFired` carries every shot;
`Expedition.shots` counts them.

| Key | Default |
|---|---|
| `hitSkillBase`, `hitPerFighting` | 0.5, 0.06 |
| `rangeFalloffFloor` | 0.3 |
| `coverPenalty` | 0.5 |
| `movingTargetFactor`, `movingShooterFactor` | 0.8, 0.7 |

Why: tuned with `crew expeditions` (§the-expeditions-instrument); at a higher skill base five
armed against one guard ended at the first aim and every posture played alike, and a higher
floor made trading shots from the ramp cost as much as walking in.

### Morale

Fights end mostly by breaking: resolve is the currency. Only the party, guards and allies have it;
the target and bystanders neither waver nor break.

- A cast member's resolve starts at `expedition.resolveTiers` (shaky 0.45, steady 0.7, hard 0.95)
  times their tie's `expedition.tie[...].resolve` (paid 0.8, bound 1, devoted 1.25), capped at 1;
  their loyalty is the tie's (0.3, 0.7, 1). A party member's is `crewResolve.base` (0.6) +
  `perFighting` (0.03) × fighting + `perMood` (0.1) × mood + `perLeaderAffinity` (0.02) ×
  affinity to the leader normalised by `social.affinityRange` (0 for the leader).
- At once (`expedition.morale`): hit −0.25; an ally down −0.2, dead −0.3; the target taken −0.4
  to the cast; each hit their side lands +0.05.
- Per second, at each decision after contact: under fire (someone aiming at them) and not in cover
  −0.05; outnumbered (more armed enemies in sight than armed friends in sight, self included)
  −0.03; in cover from the nearest armed enemy +0.02; whoever leads the party now (§who-goes)
  able and within `leaderNearTiles` (3) +0.02.
- The ladder: someone starts `wavering` if their resolve is below `waverBelow` (0.5), else
  `steady`. Below `waverBelow` they waver, below `breakBelow` (0.25) they break
  (`combatantBroke`), and a wavering one recovers only above `recoverAbove` (0.6). Breaking does
  not recover within a fight. `fled`, `surrendered`, `down` and `dead` end their part in it.

Outflanked: under `flank`, once the second group has reached the flank post, a guard or ally who
sees a member of each group takes `morale.outflanked` (−0.3), once a fight
(`Combatant.outflanked`).

### Postures

A battle plan (`BattlePlan`) is a squad rule, a posture, a fire rule (`lethal`, `stun`,
`holdFire`), an objective (`takeTarget`, `takeItem`, `breakThem`) and a `withdrawWhen` rule. The
posture sets each party member's mode (`postureMode`):

- **assault**: press. Go for the objective by the tiles beside it, firing at a mark on the way
  and standing to shoot within five tiles of it.
- **hold**: everyone who shoots takes a spot by the ramp: site floor beside cover, within four rows
  of the ramp foot, those in cover from the target's post first, one each. A holder with a mark
  steps up to two tiles into cover from it, else fires where they stand. A baton waits at the head
  of the ramp (its top, or a free deck tile beside it). After contact, once no cast member armed past arm's length can fight, they press.
- **flank**: the party ranked by `fighting` splits alternately; the second group goes to the flank
  post, firing on the way, while the first holds; once the second reaches it, all press. The
  second group walks the route the cast sees least of (a tile a watcher would notice them on
  costs twelve steps), a few straight tiles at a time. Why: by the shortest path the Boathouse's
  flankers walked through the shed past both guards; this way they go round the west end.
- **bait**: before contact the leader walks in on the nearest guard, "talking", and nobody fires;
  the rest hold. At contact everyone presses.
- **creep**: before contact everyone walks toward the objective by a route off every tile a
  watcher would notice them on (the shortest route if there is none), a few straight tiles at a
  time, without firing. At contact they press.

A wavering party member shoots but does not advance. A breaking one runs for the top of the ramp
and is `fled` once aboard. `holdFire` keeps the party's fire until contact.

Tuned on the Boathouse (`crew expeditions --plans hold-lethal-armed,assault-lethal-armed,
flank-lethal-armed --casts all --n 10 --seeds 1-3`): against the default cast `assault` takes the
target in 22 s from contact at 0.47 party wounds and 7 party shots a fight, `hold` in 40 s at
0.23 wounds, `flank` in 40 s, every fight ending with the cast broken and no party deaths; against
the `hard` cast `hold` watches the keeper go at 70 s, `assault` takes him in 31 s at 2.4 wounds,
and no party member dies.

### One to a tile

A side does not stack: every tile choice prefers a tile no other living combatant of that side
stands on or is walking to (a walk claims its end at the decision that starts it, so a later
decision the same tick sees it), falling back to the next best. That covers the hold spots,
taking cover, a wavering guard's cover, covering the way in, a guard closing in, the baton at the
head of the ramp, and a presser's side of the objective once within six tiles of it (further out
the nearest side, so the party does not split round it on the way in). Someone standing still on
a tile an ally earlier by id also stands still on steps to a free tile beside it, one with a line
to the nearest enemy in sight if there is one. Why: a phone shows one figure a tile, so a
stacked party read as one person.

### Fire and targets

The party fires only at cast who are armed and can still fight: never a bystander, never the
unarmed target, never someone running or giving up, and never the target at all under a plan's
`targetMustLive` (an errand that wants them alive, §the-arrival-card). The cast fire at any party member who can
fight. Each picks the nearest such mark in sight and reach.

### The cast in the fight

Before contact the cast keep their posts. After it:

- **Guards and allies**: unarmed, they keep back. With a mark they fire, a wavering one first
  stepping up to three tiles into cover from it; a devoted one (loyalty 1, steady) closes in from
  beyond three tiles, the rest stand. With no mark, a baton closes on the nearest party member in
  sight within four tiles (any distance if devoted); a steady blaster covers the way in from a
  spot within three steps of their post that sees the nearest party member, and from
  `expedition.guardSearchAfterSeconds` (6) after contact goes up to twelve steps to find one.
  Otherwise they go back to their post.
- **The target**: one who wants blood and is armed fights as a guard. One who wants out keeps low
  for `expedition.targetBoltsAfterSeconds` (60) after contact, then makes for the exit, unless a
  party member going for them stands beside them; any other keeps still.
- **A bystander** walks off by the exit at contact.
- **Breaking**: a guard or ally makes for the exit, and gives up (`combatantBroke` surrendered)
  when a party member is beside them (`surrenderIfCornered`), with no way out, or as a guard with
  no weapon.

A cast member who reaches the exit leaves the site with what they carry. The target leaving is
`targetFled`.

### Rescue

When no armed enemy is in sight, the able party member nearest a downed crewmate on the site floor
in their sight goes to them, picks them up (`carriedBy`) and carries them to the ramp foot; the
one set down there remembers `carriedMeOut` about the carrier.

### The objective and resolution

The objective is held when, during the approach or the fight:

- `takeTarget`: a party member going for the objective stands beside the target and no armed cast
  member who can fight is within four tiles with a line to it. The target gives up and walks to
  the ramp with them. Why: once the party spread round the target (§one-to-a-tile), a guard who
  stepped back into cover past two tiles let it take him from the other side before any exchange
  of fire, and `assault` lost half its shots.
- `takeItem`: the same beside the loot post (no item is taken yet).
- `breakThem`: after contact, no armed cast member can fight.

The cast still fighting take the target-taken shock. From then the party fires only where it
stands and falls back to the ramp foot, the down carried.

The party withdraws by its plan's `withdrawWhen` (`expedition.withdrawWhen`: `firstDown` at the
first party member down or dead, `halfDown` once 0.5 of the party is) or by `withdrawParty`: every
party member still fighting breaks for the ship and `partyWithdrew` says so once.

The expedition resolves (`expeditionResolved` with the tally of wounds and deaths per side since
the start, the shots and the seconds from contact) at the first of:

- `targetFled`: the target leaves by the exit;
- `targetTaken`: the objective held and the party (the down carried or set down) and the target at
  the ramp foot or aboard;
- `partyWithdrew`: a called-back party all aboard, down or dead;
- `partyRouted`: after contact, every party member down, dead or fled aboard uncalled;
- `timedOut`: `expedition.maxFightSeconds` (120) after contact.

The alert stands down `expedition.alertClearSeconds` (60) later (`alertCleared`, cause `fight`).
The party leave the fight and the planner has them again. The taken target and the cast's down and
dead are removed; the rest of the cast walk off by the exit and are removed there, or all at once
the tick the ship plans her lift-off, so departure prep never meets them (§known-sites). The
party's muster stops. The party's dead stay where they fell. `state.expedition` stays `resolved` until a new start replaces it.

### Settling the errand

When an expedition started for an errand (`Expedition.jobId`) resolves, the sim settles the errand
before the party and cast leave the fight (`systems/expedition/errand.ts` `settleErrand`):

- `targetTaken` with the target alive is `broughtAlive`: the cast actor is removed with what they
  carry and boards anew as the captive, a fresh `crew.passenger` with their name on their tile
  (whole, no combatant), riding home as the job's one-way passage (`spawnCaptive`,
  `passengerBoarded`). Why a new actor: the aftermath removes every actor that still has a
  combatant.
- `targetTaken` with the target dead is `broughtDead` when the job wants them `dead` or `either`
  way, else `failed`.
- A `fetchItem` taken is `broughtItem` once its item is stowed aboard as the job's one manifest
  line (from a party member's hands, else the floor nearest the loot post).
- Every other outcome is `failed`: the job fails there and then (`jobFailed`, outcome `failed`).

Whatever the outcome the voyage home (`returnToPortId`) is set, never the next hop, so travel
plans it once nothing holds the ship and departure prep begins at once. A captive put off later
fails the errand after all (`jobFailed` with the passage's end reason) and the voyage home
stands; one put off at the site is gone there, since a site has no lounge. Payment is
§errand-pay's.

### Thoughts and memories from a fight

- `killedSomeone` (−0.4, 3 days) for a crew shooter whose hit killed; `sawCrewHurt` (−0.2, 1 day,
  stacks) for each party member who sees a crewmate hit; `wounded` (§bleeding-and-healing).
- At resolution: `ranFromAFight` (−0.2, 1 day) for a living party member who broke on their own
  (not called back); `heldTheLine` (+0.2, 1 day) at a `targetTaken` for those who never did and
  can still fight.
- Memories (§memories): `foughtBeside` (+1, 7 days) pairwise among the living party who went;
  `carriedMeOut` (+3, 14 days) from a rescue; `leftMeBehind` (−3, 14 days) about the leader from a
  party member left down on the floor away from the ramp.

### Fight log lines

The ticker (`core/render.ts`): "Set down at Harrow End" on landing and "Lifted off from Harrow
End for Green Meridian" on leaving (the start itself has no line); "Mara Osei takes four down the
ramp" once the party is armed and walks out (`partyMustered`), since on a landing nobody moves
until the plan is chosen; at contact "Shots at the Boathouse"; "Jax Okonkwo
is hit in the leg" for crew, "Hesk Marrow is hit" for the cast, "... is stunned"; "... is down";
"... is dead"; "... runs for the ship" or "runs for <the exit post's name>"; "... gives up"; "The
party pulls back to the ramp"; and the end: "Corran Vale taken; two of ours hurt" (or "dead"),
"Corran Vale got away", "The party came back without Corran Vale", "The party is driven back to
the ship", "The fight at the Boathouse peters out". Shots and healed wounds have no line.
`expeditionContact` and `died` drop fast play to 1x (§auto-slowdown).

### The plan menu

`planMenu(state, content, config, siteId?)` (`view/planMenu.ts`) is pure, so the kernel validates a
chosen id against the same menu the narrator will read. It is the cross product of the five
postures, `lethal` and `stun` (and `holdFire` for `bait` and `creep`) and the four squad rules,
dropping a squad rule that picks the same people as an earlier one for the same posture and fire.
Ids read `<posture>-<fire>-<squad>` (`all`, `armed`, `blasters`, `small`). Order: the default
pair `hold-lethal-armed` and `assault-lethal-armed`, then the other postures' lethal-armed, then
`assault-stun-armed`, then the rest; eight at most. Every plan's objective is `takeTarget` on a
site with a target post, else `breakThem`, and it withdraws at `halfDown`.

An option is unavailable, with the reason as its `why`, when the squad is empty or the locker has
none of what it needs, when `flank` has no flank post or fewer than four go, when `bait` has fewer
than two, and when `bait` or `creep` comes after contact. An available option's `why` says what it
does and how many go.
