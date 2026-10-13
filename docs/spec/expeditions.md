# Expeditions

Bodies and arms, medicine aboard, landing sites, and the fight a party walks into when the ship
sets down at one. Code is in `packages/sim/src/core/{body,sites,places}.ts`, `systems/bodies/`,
`systems/medical/`, `systems/expedition/` and `view/planMenu.ts`; config is under `bodies.*`,
`medical.*` and `expedition.*` in `packages/content/data/config/default.json`. An expedition
starts when the ship sets down at a site for an errand (§errand-job, §the-arrival-card), or from
`scenarioStartExpedition` in tests and dev tools; what the narrator sees and may do is
§the-narrator-and-sites. The owner's rulings that shape it are D103, D104 and D105.

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
the torso. A wound treated at the medbay bed stops bleeding at the treatment and heals faster from
then (§treatment-at-the-medbay-bed); one nobody treats runs this clock unchanged.

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
walk ashore pass to the first officer (D8, D103). The ship's company grieve their dead
(§grief); a body aboard is laid out in the hold (§the-body-aboard) and carried ashore at the next
port (§laid-to-rest).

### Grief

Both ways of dying (`applyDamage` at the hit, the bodies system on blood) go through one rule
(`systems/bodies/death.ts` `die`): down for good, `died`, then grief. When a member of the ship's
company dies (crew, not a passenger; never the site's cast), every other living one, aboard or
ashore, has `grieving` about them (`refId` the dead; -0.35 for 7 days, stacking), and those whose
affinity for the dead (§affinity) is at least `medical.griefCloseAffinity` (3, "close to" in the
digest) have it `medical.griefStacksClose` (2) times. A passenger's death is grieved by nobody, and
passengers grieve nobody. The narrator's `giveThought` of `grieving` adds one more
(§thought-and-reveal-levers). Why stacking: two take a close friend's mood under `mood.lowBelow`
for the week, so they work slower (§mood-and-work-speed); one alone weighs on the rest without
slowing the ship.

## Medicine

Wounds are treated aboard, at the medbay bed (a `medBed`-tagged machine; both freighters have one
in the infirmary): the hurt walk there (the down are carried), someone with the skill fetches a
`medical` item and treats them, and the ship keeps a few kits in stock. Code is in
`systems/medical/` and `planner/medical.ts`. A deck with no medbay bed has no wounded problem and
no treatment.

### The wounded problem

The medical system (`systems/medical/medical.ts`, phase `needs`, after the bodies system, every
tick) raises `crewWounded {actorId, untreated}` (owner medical, dedupe `wounded:<actorId>`,
public, located at the medbay bed's compartment) for each living crew member who is not a
passenger, stands on the ship's floor (not the dock or a site) and is not in a fight, with an open
wound nobody has treated; stun hits never count. It is essential while one of those wounds bleeds
or is of a `medical.essentialSeverities` severity (`serious`, `grave`), and routine for grazes
alone (`woundedUrgency`); `bleeding` is on the payload while one bleeds. It is revised when the
count, the bleeding or the class changes, resolved when every wound is treated (or has closed), and
cancelled when the patient dies. Why serious without the bleed: a serious wound slows work and the
helm until it is treated (§bodies-and-capacities); routine, the patient finished the cooking, the
watch or the sleep first and was treated minutes after the hit. Once raised it stays open while
the patient is off the ship's floor. A site's cast and passengers get none: nobody aboard treats
them.

### Treatment at the medbay bed

The problem derives one `treatWounds` task (target the patient, progress their wounds) while at
least `medical.kitsPerTreatment` (1) units of a `medical` item are aboard, the first such def by
id: medical skill 1 or more, one worker, standing on the open floor beside the bed's `use` tile
(never on it), `medical.treatSecondsPerWound` (15) for each untreated wound. With no kit aboard
nothing is derived, and the task comes back when one is. While the patient is down off the bed the
problem derives their carry there instead (§extraction). Anyone awake with the skill answers it,
on duty or not, as cargo in port is all hands (§duty-and-the-sleep-watch), but leaves it a while to
the ship's medic (§the-medics-right). Nobody treats their own wounds.

The plan (`medical/plans.ts`) splits the units off the nearest `medical` stack the medic knows
of, walks to the tile beside the bed nearest them and works `treat`. It is built once the patient
lies at the bed, is walking to it (`convalesce`) or is within `medical.prepareWithinTiles` (2) of
it, so the kit is fetched while they come; before that it is blocked `dependencyPending`, and the
task backs off and is tried again. At the bedside the step waits while the patient is still on
their way and fails `dependencyPending` if they are neither there nor coming. The step
(`runTreat`) counts work at the medic's work rate; at the end the units are used up, every
untreated wound gets `Wound.treatedTick` and stops bleeding at once, pain drops by
`bodies.treatPainRelief` (0.3), `woundTreated` (notable) names medic, patient and wounds, and
the problem resolves. A treated wound heals `bodies.treatedHealFactor` (3) times `healPerDay` from
the treatment on, so a `serious` one closes in about two thirds of a day instead of two
(`core/body.ts` `woundDamage`). The ticker says "Oyelaran Abiodun treats Priya Kessler's leg";
a wound healing has no line. The hit's line names the part with the same word ("Priya Kessler is
hit in the chest").

### The medic's right

A crew member below `medical.medicLevel` (4) leaves a `treatWounds` (rejected `deferTo:<id>`) to
a crew member on the roster at or past it (not themselves, not the patient, not a passenger, not
down) whom they believe awake and available: their latest `actorStatus` sighting of them, of any
age, or with none the roster's word that they are up. They leave it only while the wounded problem
is younger than `medical.waitForMedicSeconds` (90); after that anyone with the skill treats, and a
bleeding patient (`bleeding` on the problem) never waits. The medic himself, and anyone at the
level, treats as soon as he answers. This replaces the generic deference to a better hand in sight
(§what-a-crew-member-weighs) for treatment only; the carries need no skill and defer to nobody.
Code: `planner/medical.ts` `medicToWaitFor`. Why: the generic rule yields only to a colleague in
sight, idle and awake that moment, so the nearest deckhand with medical 1 took every treatment and
the ship's medic watched a deckhand bandage the captain; the wait is bounded so a medic at the helm
or asleep costs a minute and a half, not the patient's treatment.

### Convalescing

A crew member aboard with a wound nobody has treated (`WoundView.treated` false) has a
`convalesce` candidate (`planner/medical.ts`): walk to the medbay bed's `use` position and hold
there, "in the medbay", at the wounded problem's class (§the-wounded-problem): essential while a
wound bleeds or is serious or grave, so it takes them off routine work like cooking or hauling once
the selector's cooldown has passed (§selector-commitment), and routine for grazes alone, so a
grazed cook finishes the meal first. It is not offered to a passenger, on the dock or in a fight,
while they believe no `medical` item is aboard and know of no treatment of their own wounds
(`noMedicine`; the task is derived only with a kit aboard, and a kit restocked in port may lie
where they never looked), or while they believe someone else lies there (`bedTaken`: another
person last seen on that tile). The hold ends when nothing is left to treat, or after
`medical.giveUpAfterSeconds` (300) with too few `medical` units aboard for a treatment; giving up
backs the candidate off for as long again. A helm-stander is not pulled off the seat by a wound:
the walk ranks no higher than the helm watch (both essential), so they go once the bell relieves
them (§selector-commitment); a sleeper sleeps on likewise, since only containment wakes one.

### Extraction

Someone down aboard cannot walk to the bed, so they are carried there (`medical/carry.ts`). While
the patient of an open wounded problem is incapacitated and not lying at the bed, the problem
derives one `carryCasualty` task in place of the treatment: no skill, one worker, standing on the
open floor beside the patient (never their tile), at the problem's urgency (§the-wounded-problem)
and all hands like the treatment. It is derived only while they lie on the
ship's floor or are in a carrier's arms, and only while nobody else lies or stands still at the
bed's `use` tile; a bed taken waits, and the carry comes back when it is free. Nobody carries
themselves. A downed patient already lying at the bed gets the treatment, and a medic treats them
where they lie (§treatment-at-the-medbay-bed).

The carrier walks to the tile beside the patient nearest them, takes them up over
`medical.liftSeconds` (2) (`carriedBy`, as in the fight's rescue, §rescue: the body goes where
the carrier goes), walks to the tile beside the bed nearest them and lays the patient on the `use`
tile over `medical.laySeconds` (2). The carry is done when they are laid down: `casualtyCarried`
(notable), and the ticker says "Bettina Solheim carries Priya Kessler to the medbay". The
carrier's label is "going to Priya Kessler", "picking up Priya Kessler", then "carrying Priya
Kessler to the medbay".

- A carrier who stops for any reason (a more pressing job, going down, a bed taken just as they
  arrive) sets the patient down where they stand, and the carry is derived afresh from there.
- Anyone carried aboard outside a carry of them (they died or came round in someone's arms, or the
  carrier stopped) is set down where the carrier stands, every tick before anyone plans them; the
  carry of the dead or the recovered is no longer derived.
- A fight's casualties are carried by the fight's own rule (§rescue); once they are aboard and out
  of the fight, the carry brings them on to the bed.

Why: someone down can lie for hours before they come round, and the treatment waits on a patient
at the bed.

### The body aboard

A dead member of the ship's company lying aboard (on the ship's floor or in someone's arms, out of
any fight) is carried to a resting place and left there (`systems/medical/rest.ts`, the carry in
`medical/carry.ts`). The medical system raises `bodyAboard {actorId, tile}` (owner medical, dedupe
`body:<actorId>`, public, routine, located at the resting place's compartment) for each such body
away from a resting place, unless the ship is docked at a port (§laid-to-rest). `tile` is the
first of the deck's resting places no other body lies at or is bound for, fixed when raised. The
problem derives one `carryBody` while the body lies away from `tile` and nobody else lies or stands
still there: the carry of §extraction (no skill, one worker, beside the body, a carrier who stops
sets it down, all hands) at routine urgency, ending on `tile` instead of the bed. It is resolved
once the body lies on `tile` and cancelled once it leaves the ship. A body laid out there, or one
that died on a free resting place, is left where it lies.

Resting places (`restingPlaces`, from the deck alone): the open floor of the room holding the cargo
ramp's transfer tile (the cargo hold on both freighters), leaving out every zone tile (the
stowage), the tiles at the room's doors and openings, every machine's interaction positions, the
ramps' transfer tiles and the spawn points; the most tucked away first (fewest open floor
neighbours in the room), then nearest the cargo ramp, then by row and column. Why: the body waits
near the ramp it leaves by, out of the way of the freight and the doors.

`bodyLaidOut` (notable) says "Bettina Solheim lays Tomas Ruiz out in the cargo hold". The
carrier's label is "going to Tomas Ruiz", "lifting Tomas Ruiz's body", then "carrying Tomas Ruiz's
body to the cargo hold". A party member dead on a site's floor stays where they fell through the
fight; the call aboard at lift-off brings them up the ramp with anyone else left on it
(§calling-the-crew-aboard), and from there they are laid out like any other.

### Laid to rest

While the ship is docked at a port (never a landing site), every dead member of the ship's company
aboard or on the dock is carried ashore at once (`layToRest`): what they held or wore is set down
where they lay, so the ship keeps its gear, and they leave the ship for the port's lounge store
(`inExternalStore`, still `dead`), as a passenger ashore does. `laidToRest {actorId, portId}`
(notable) says "Tomas Ruiz is carried ashore at Tern's Rest". They stay in `actors`, so thoughts,
memories, meals and notes that name them still resolve; the digest lists them on one "Laid to
rest" line instead of a crew line (§crew-lines). Why not removal: a grieving thought, a cook's
served meal and the relationships tables keep their id for days after.

### Medical supplies

The ship keeps `medical.reserve` (2) units of `medical` items aboard; with fewer, docked at a port
whose market sells one, the difference is a reserve to restock (§reserve-kinds). The default
scenario stows three med kits in the hold.

### Accidents aboard

Crew are hurt aboard outside a fight now and then, so the medbay works on an ordinary voyage
(`systems/bodies/accidents.ts`). Three hazards, each rolled on a keyed draw of the `failures`
stream (rolling moves no other system's draws):

- Hot work: a crew member on a machine's repair (`recipe`) or `mend` work step while that machine
  runs past its `heat.derateAbove`, at `accidents.hotWorkPerSecond` (0.002): a graze to an arm.
- A slip under a load: a crew member carrying cargo (an item with a cargo class, in hand or on the
  hand truck they push) in a `filthy` room (§room-tiers), at `accidents.slipPerSecond` (0.003): a
  graze to a leg, `serious` while the ship is on alert for an asteroid field.
- Thrown: as each rock lands (§rock-impacts), each crew member awake and on their feet in the
  struck room, unless braced on a machine's `operate` or `use` position, at
  `accidents.impactThrowChance` (0.15): a graze where `bodies.partTable` puts it, never the head.

The first two are rolled by the accidents system (phase `needs`, after the bodies system, every
half second); a throw is rolled by the field as the rock lands. Fatigue past
`urgency.needEssentialAbove` (0.7) doubles every chance. Passengers, the dock's and the site's
people and anyone in a fight are never hurt this way. An accident goes through `applyDamage`, emits
`accident {actorId, hazard, how, machineId?}` (notable; its `wounded` is marked `narrated`), and
crew in the room take `sawCrewHurt` (`systems/bodies/witness.ts`, shared with the strike,
§strike-lever). The ticker's line is `accidents.lines` for the hazard with `{who}` and `{machine}`
filled: "Tomas Ruiz is burned working on the fusion generator". `accidents.enabled` (true) off
rolls nothing; a test that pins a run's numbers turns it off.

An accident never kills: every one is `blunt`, so it never bleeds, never lands on the head, and a
roll that would take its part to tolerance is no accident. Why: an accident is a reason to walk to
the medbay and spend a kit, not a death the story never chose; a death is the narrator's to decide
(§strike-lever).

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

### The Lazaret

`port.lazaret` (station, near Vesper Gate, one route of 20) and its map `dock.lazaret`, the Gate's
old quarantine hulk, 44 x 30 with the Mk2 berthed at (4, 0); its README is the map. The berth
opens onto a bay two rows deep with crates of cover at (33, 21) and (36–37, 21). A bulkhead along
row 22 has the main hatch at (31, 22) and a service hatch at (40, 22). Inside is a warren of
one-tile doors: the intake (x 28–35, rows 23–24) under the main hatch, with no cover; a ward
corridor along row 26 from the intake's south door at (32, 25) west to the isolation ward (x 1–8,
rows 23–26); and north of the corridor the dispensary (x 10–15) and the long ward (x 17–26),
joined to each other and to the intake, a second way along the hulk through the rooms. The
service hatch drops into a duct down x 40 and west along row 28, under the whole hulk, to the
lifeboat lock at its west end; the isolation ward's back door at (4, 27) opens onto it. Cots of
cover stand in the wards. `noticeRadius` 3.

Posts: `target` the isolation cots (4, 24), `loot` the dispensary cage (11, 23), guards
`intake_desk` (29, 24), `corridor` (14, 26) and `ward_door` (8, 25), `bystander` `long_ward` (23,
24), `exit` `lifeboat_lock` (0, 28), `flank` `back_duct` (6, 28). The default cast: Orrin Sallow,
the Gate's dispenser, gone with its morphia (target, unarmed, shaky, paid, wants out); Brannoch
Teale, a hulk-breaker in Orrin's debt with a blaster in the intake (steady, bound, wants money);
Sister Hedda Vosk, a vowed warden with a baton in the corridor (hard, devoted, wants blood); Dace
Corley, a squatter Orrin keeps in pills, with a blaster inside the ward door (shaky, paid, wants
money); Ines Haddow, a patient who never left (bystander).
Why: walls, not cover, cut the lines here, so from the bay the party sees only down the main
hatch. `hold` trades a few shots with Brannoch through it while Orrin keeps low, then goes out by
the back door and the duct to the lifeboat lock, so where holding takes the target at the
Boathouse and Harrow End, here it mostly loses him: the way to him is in. The rooms beside the
corridor and the short notice radius let `creep` get deep before anyone sees it, and the duct is
the flank's own way to the back door, out of every guard's sight and beside the way out the cast
break for. The intake has no cover because a desk at the hatch let Brannoch trade shots through it
from cover, his resolve gaining faster than hits took it, until he had shot the holders down one
by one. The isolation ward is the length of the hulk from the personnel ramp, so a fight here runs
longer than at the other sites, most of it the walk out.

Its `holdWhy`, "They keep a lifeboat lock at the far end; hold the ramp and they're gone by it.", is
the hold side's why on the arrival card and on the hold plans of the menu (§the-arrival-card), so
the captain who holds here does it knowing. Why: `hold` is still a choice here, but the bolt-hole
is out of the ramp's sight, and the card read as at Harrow End, where holding works.

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
`adoptPlan`: the errand kind's pair when both are available (`plans.ts` `defaultPairFor`), else
the first two available. A `fetchPerson`'s pair is `hold-lethal-armed` and `assault-lethal-armed`;
a `fetchItem`'s is `creep-holdFire-armed` and `assault-lethal-armed`. Why creep for an item: the
owner's sneak-in is one where "they sneak in and get the box" (D105), and a `hold` side can never
be the way in unseen (§getting-in-unseen).

The situation names what the errand is after and asks the pair: "Teodor Lusk is at Harrow End,
and not alone. Hold the ramp from cover, or go in and take them?"; for an item, by the item's
name, "General Cargo Crate is at Harrow End, and guarded. Creep in quietly, holding fire, or go
in and take it?". A side's label says what the plan does ("Hold the ramp from cover", "Creep in
quietly", "Go in and take them", or "Go in and take it" for an item, with ", to stun", ", holding
fire", ", all hands", ", blasters only" or ", a small team" when not the usual) and its aftermath
what happens next ("We make them come to us."), with no numbers. A site map may carry `holdWhy`
(site only): what holding the ramp comes to there, said as the hold side's why in place of the
usual words (§the-lazaret); the narrator reads it in the card's `leftWhy`/`rightWhy` in the site
digest. The prompt params name the job,
the errand's `kind` (`fetchPerson` or `fetchItem`), the site, the target (the person, or the
item's name), the speaker and both plans (`leftPlan`, `rightPlan`, `leftLabel`, `rightLabel`,
`leftWhy`, `rightWhy`), and each side's own refs carry its label and why. While the card is up the
narrator may mark one side as the way in unseen (§getting-in-unseen). Choosing a side adopts the
plan and the muster begins (§the-muster). A plan adopted for an errand that wants the target
`alive` has `targetMustLive` (§fire-and-targets). With fewer than two plans available there is no
card, and the expedition resolves `timedOut` `expedition.maxApproachSeconds` (90) after it
started. Why a policy card and not a story hook: the narrator dresses the sim's pair; choosing
which plans the card offers would be a new allow-listed lever (D6), in bounds since D106 and not
built, and which side is taken is always the captain's. Its one mark on the card is
§unseen-lever.

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
`expedition.maxApproachSeconds` (90) after it began ends `timedOut`. A side the narrator marked on
the arrival card replaces these rules for the fight it starts (§getting-in-unseen).

### Getting in unseen

While the arrival card is up, the narrator may mark one of its sides as the way in unseen, with
the chance it works (`markUnseen { decisionId, planId, odds }`, narrator and scenario authority;
the lever is §unseen-lever, the chance §unseen-odds). The kernel refuses it, with the reason,
unless an expedition is under way with no plan and nothing marked yet, `decisionId` is its arrival
card (`Expedition.cards.arrival`) and still pending, `planId` is that card's `leftPlan` or
`rightPlan`, on the menu and not a `hold` plan, and `odds` is a whole percent from 0 to 100. Apply
writes `Expedition.unseenPlanId` and `unseenOdds`; the card does not change and the captain still
chooses. The world is halted on the card, so the mark applies in the tick the captain's answer
does, just ahead of it. Why no `hold`: a party holding the ramp never goes for the objective, so
unseen it could only wait out the clock.

`adoptPlan` then writes `Expedition.notice` (`NOTICE_RULES`): when the marked plan is adopted it
rolls the mark's odds once (§unseen-odds), `unseen` if the roll works and `seen` if not; `seen`
when the other plan is. With nothing marked it is absent and contact comes by the ordinary rules
(§contact-and-the-alert).

- **`unseen`**: the cast never notice the party. No guard or ally's sight, no loud landing and no
  creeper beside the objective bring contact; only the party's own first shot does (even one fired
  before the leader is ashore), so a fight that fires none has no contact, no alert and no
  `alertCleared`. During the approach the objective is held without its guard rule
  (§the-objective-and-resolution): nobody armed within four tiles stops the party taking it, and
  the cast take no target-taken shock from it. A plan that fires, such as an `assault` marked for a
  person, gets the drop: its first shot is contact. Why: a creeper beside the box who showed
  themselves would undo the sneak-in the owner asked for (D105).
- **`seen`**: they were waiting. Contact comes the first tick any party member stands on the site
  floor, even while the rest are still at the muster: the fight runs from then, the rest arm and
  walk out into it, and there is no walk-out (`partyMustered`, so no "down the ramp" line) and no
  approach. A party called back then leaves those not yet armed aboard.

`expeditionResolved` carries `notice`, and the end's ticker line adds "; nobody saw us" under
`unseen` when no shot was fired, or "; they were waiting for us" under `seen`: "General Cargo
Crate taken; nobody saw us".

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

A cast member who reaches the exit leaves the site with what they carry; the target leaving can
end the expedition (`targetFled`, §the-objective-and-resolution).

### Rescue

When no armed enemy is in sight, the able party member nearest a downed crewmate on the site floor
in their sight goes to them, picks them up (`carriedBy`) and carries them to the ramp foot; the
one set down there remembers `carriedMeOut` about the carrier. Once the objective is held
(§the-objective-and-resolution) sight is not needed: the party falling back goes for every
crewmate down on the site floor wherever they lie. Why: in the Lazaret's warren a crewmate who went
down behind a wall was never seen from the ramp foot, so the fight could not end and timed out
with them left there.

### The objective and resolution

The objective is held when, during the approach or the fight:

- `takeTarget`: a party member going for the objective stands beside the target and no armed cast
  member who can fight is within four tiles with a line to it (the guard rule, waived during an
  unseen approach, §getting-in-unseen). The target gives up and walks to the ramp with them. Why:
  once the party spread round the target (§one-to-a-tile), a guard who stepped back into cover
  past two tiles let it take him from the other side before any exchange of fire, and `assault`
  lost half its shots.
- `takeItem`: the same beside the loot post. The party member there picks the errand's item up
  (`carriedBy`, `errand.ts` `pickUpLoot`) and carries it back to the ramp. The target person is
  never taken under `takeItem`: they are cast like the rest, and leave or are removed with them.
- `breakThem`: after contact, no armed cast member can fight.

The cast still fighting take the target-taken shock. From then the party fires only where it
stands and falls back to the ramp foot, the down and the item carried.

The party withdraws by its plan's `withdrawWhen` (`expedition.withdrawWhen`: `firstDown` at the
first party member down or dead, `halfDown` once 0.5 of the party is) or by `withdrawParty`: every
party member still fighting breaks for the ship and `partyWithdrew` says so once.

The expedition resolves (`expeditionResolved` with the tally of wounds and deaths per side since
the start, the shots, the seconds from contact and `targetName`: the target's, or on an item
errand the errand's `targetName`, so the end reads "General Cargo Crate taken") at the first of:

- `targetFled`: under `takeTarget`, the target leaves by the exit; under any other objective the
  target leaving is one more of the cast gone, and the expedition goes on;
- `targetTaken`: the objective held and the party (the down carried or set down) and the target or
  the item at the ramp foot or aboard;
- `partyWithdrew`: a called-back party all aboard, down or dead;
- `partyRouted`: after contact, every party member down, dead or fled aboard uncalled;
- `timedOut`: `expedition.maxFightSeconds` (120) after contact.

The alert stands down `expedition.alertClearSeconds` (60) later (`alertCleared`, cause `fight`). The
party leave the fight and the planner has them again. A target taken under `takeTarget` and the
cast's down and dead are removed; the rest of the cast walk off by the exit and are removed there,
or all at once the tick the ship plans her lift-off, so departure prep never meets them
(§known-sites). The party's muster stops. The party's dead stay where they fell. `state.expedition`
stays `resolved` until a new start replaces it.

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
- A kill job (`wants: "dead"`) whose target is taken alive ends in an execution: whoever leads the
  party now shoots them where they stand, a grave blaster wound to the head through the one damage
  entry point (`executed`, "Mara Osei executes Teodor Lusk"; the executioner thinks
  `killedSomeone`), and the errand is `broughtDead`. Why: the party never fires at an unarmed
  target, so a kill job could never be a kill; owner: "Kill jobs should end in an execution if
  kills never happen." (D104)
- A `fetchItem` taken is `broughtItem` once its item is stowed aboard as the job's one manifest
  line: the one the party carried home (§the-objective-and-resolution), else the one on the site
  floor nearest the loot post.
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
the ship", "The fight at the Boathouse peters out", each with the notice's ending under a narrator's
mark (§getting-in-unseen). Shots and healed wounds have no line.
`expeditionContact` and `died` drop fast play to 1x (§auto-slowdown).

### The plan menu

`planMenu(state, content, config, siteId?)` (`view/planMenu.ts`) is pure, so the kernel validates a
chosen id against the same menu the narrator will read. It is the cross product of the five
postures, `lethal` and `stun` (and `holdFire` for `bait` and `creep`) and the four squad rules,
dropping a squad rule that picks the same people as an earlier one for the same posture and fire.
Ids read `<posture>-<fire>-<squad>` (`all`, `armed`, `blasters`, `small`). Every plan's
objective follows the live expedition's errand (`Expedition.jobId`): `takeItem` for a
`fetchItem`, else `takeTarget` on a site with a target post, else `breakThem`; a resolved
expedition's errand, or a scenario start's lack of one, counts as none. Every plan withdraws at
`halfDown`. Order: the errand kind's pair (`defaultPairFor`, §the-arrival-card; the person's pair
with no errand), then the other postures' lethal-armed, then `assault-stun-armed`, then the rest;
eight at most, so the item pair's `creep-holdFire-armed` is always on an item errand's menu.

An option is unavailable, with the reason as its `why`, when the squad is empty or the locker has
none of what it needs, when `flank` has no flank post or fewer than four go, when `bait` has fewer
than two, and when `bait` or `creep` comes after contact. An available option's `why` says what it
does and how many go, and a hold plan's then the site's `holdWhy` when it has one
(§the-arrival-card).
