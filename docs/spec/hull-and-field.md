# Hull and field

The asteroid field the ship crosses in transit, the hull bar and its scars, ship loss, and how
the crew find, report and repair damage. Config is `field.*`, `damage.*` and `intercom.*` in
`packages/content/data/config/default.json`; code is `packages/sim/src/systems/` (`field`,
`damage`, `intercom`), `core/hull.ts`, and `planner/alert.ts` and `planner/intercom.ts`. Drawing
the field and hull is in `client.md`; the narrator's `scheduleField` lever is in
`narrator-story.md`.

## The asteroid field

### Scheduling a field

A field is a narrator beat, not a route property: the `scheduleField` command (also a scenario
command) puts one field on the current leg. It carries `severity` (`light | heavy | brutal`, which
set rate, large-rock share and length in `field.severities`), `detection` (`rolled` or `unseen`),
`windowTicks` (sampled like `scheduleHazard`'s, never sooner than `field.warningSeconds`, 12, away)
and up to `field.maxScripted` (3) scripted impacts `{ atSeconds, target, rock?, effect? }` aimed at
a machine, a compartment or a deck tile. A person is refused as a target until bodies exist:
nobody aboard is hurt by a rock.

One field a leg, no budget. The guard: scripted impacts alone, an unsized rock priced large, must
leave the hull above zero. Random rocks can sink the ship; that is the danger.
Code: `field/command.ts`.

### Field lifecycle

A field scheduled before transit is held until the first transit tick, so the helm's check always
gets its warning. Once active it spans `lengthSeconds × travel.nominalSpeed` of route from where the
ship is, ending by the approach lead (`narrator.approachHookLeadSeconds`) at the latest so the ship
is out before travel holds for the dock staging call. A field due past that point is missed
(`fieldMissed`). It ends `crossed` (progress leaves it) or `drifted` (see "Stuck in the rocks"),
emitting `fieldCleared`, and is dropped with its leg. A field nobody noticed that hit nothing clears
as trace. Code: `field/field.ts`.

### Sighting and the alert

`field.warningSeconds` before a `rolled` field starts, whoever has the helm rolls piloting on the
nav-hazard curve (`hazards.difficulty` easy, hard, brutal for light, heavy, brutal). A pass is
`fieldSighted`. A fail, an empty helm or `unseen` leave the crew unaware until the first rock
(`fieldEntered`, notable only if the field was sighted). The first knowledge raises the alert
(`WorldState.alert`, `alertRaised`); it clears `field.alertClearSeconds` (60) after the field ends.
Code: `field/detection.ts`.

On alert, recreation ends and none is offered. The officer of the watch holds the bridge at the
captain's chair instead of walking rounds, and takes no damage work.

### Rock impacts

Rocks arrive as a Poisson process at the severity's `impactsPerMinute` (brutal 4.5) times a helm
factor: `1 − field.helmThreading × skill/10` (0.4) with someone at the helm,
`field.unmannedRateFactor` (1.5) with nobody. A centre is uniform over every deck tile (walls are
edges, not tiles); a large rock hits its tile and the eight around it. Scripted impacts thin the
random rate by their share of the expected count, so a scripted field is no heavier.

Every rock costs the hull once (`field.hullDamage`: small 3, large 8) and leaves a scar on its
centre tile. Anyone on a blast tile gets a `nearMiss` thought and ticker line, and crew unbraced in
the struck room may be thrown down (§accidents-aboard). Code: `field/impacts.ts`.

- Fragile freight in the struck compartment may be smashed, each crate at
  `field.fragileBreakChance` by rock (§fragile-cargo).

### Machines in the blast

Each ship machine in the blast rolls once on `field.machineEffects` (none, graze, damage, knockout,
fault), or takes the scripted effect. Graze and damage take `field.effectIntegrity` (0.2, 0.5);
knockout takes all integrity; fault applies one of its fault defs through the normal fault path
(D6). A machine with no fault left takes damage. `machineKnockedOut` fires when a machine goes from
running to blocked. Code: `field/effects.ts`.

### Stuck in the rocks

Stuck is in transit, drifting and not limping (engines out or off). A stuck ship makes no way, stays
in the field at `field.stuckRateFactor` (0.7) of the rate, and drifts clear after
`field.stuckDriftImpacts` (6) rocks taken stuck. Mending the engines resumes the transit
(`shipStuck`, `shipUnstuck`). Why: stopping is never the safe play. Code: `field/stuck.ts`.

## The hull bar

### Hull, scars and ship loss

`WorldState.hull { integrity; max; scars; lostAtTick? }`, `max` from the deck's hull class (100 on
both freighters). Invariant: `integrity` is `max` minus every scar's damage not yet recovered; the
field charges scars and damage response patches and plates them, all through `core/hull.ts`. This
supersedes simulation-design §10.6.

Hull zero is game over: `shipLost`, `lostAtTick`, and `advance` halts `{ kind: "lost" }` for good (a
lost save restores lost); the web shows an end screen (§asteroid-field-scars-and-alert). Nothing
gates departure on the hull: a clash between repairs and a departure, no money or no plating is the
narrator's hook, not a check.

### Patching and plating

Underway a scar is patched: engineering 1, a welder, a patch kit, `damage.patchSeconds` (20); it
gives back `field.patchRecovers` (0.5) of the scar's damage and leaves the scar open. Docked, with
plating aboard, `plateHull` (`damage.plateSeconds`, 40) restores the rest and removes the scar.
Kits and plates are found by item tag (`patchKit`, `plating`), never by def id. Why: the work
system must know what to set down if the job is given up. Mk2 carries 24 kits and a second welder
torch. Why: one patcher held the only welder while the engine waited.

### Plating and kits at port

Docked where the market stocks plating, with fewer plates aboard than scars, `hullDamaged` (routine,
public, at the port) names the shortfall and is bought through commerce's parts purchase
(§buying-parts). All six ports sell plating; Vesper Gate's line is at count 0. Spent kits are
restocked as a reserve (§reserve-kinds).

### Machine damage

A graze, damage or knockout raises `machineDamaged` (discovered, essential), revised on a repeat
hit. It is separate from faults: `repairDamage` needs engineering 1 and a welder, takes
`damage.repairSecondsPerIntegrity` (30) per unit of integrity missing, and resolves when the machine
is whole. A `fault` effect takes the fault's own recipe.

### Urgency of damage work

`hullScar` is essential on alert, routine after. Impact damage to the engine or life support is
containment class like a fault there; on alert the generator joins them, and a symptom on any of
them is containment. Why: otherwise a knocked-out engine waits behind a dozen essential patches
while the ship sits stuck. Code: `planner/candidates.ts`.

## Intercom and reporting

### Felt and seen

Every rock is felt by everyone aboard (a `hullImpact` fact) and placed only by those in the room;
a sleeper there wakes. The bridge has no hull sensors: the player sees the hull bar fall, the crew
learn where by eyes and the intercom. Code: `damage/machines.ts` (`onImpact`).

### Reporting damage

Panels are `machine.intercom` machines (one per compartment on Mk2, eight on Mk1). On alert,
whoever has seen damage first-hand that the ship has not heard of walks to the nearest panel they
believe working and reports for `intercom.reportSeconds` (3). Damage means an open `machineDamaged`,
`hullScar` or `machineSymptom` raised since the alert, still `discovered`, held by direct sight. It
is a containment-class planner reflex, not a weighed task.

The report gives every crew member aboard the reporter's facts as `report` evidence with the
original observation tick, marks `alert.reports` for each room covered, flips each problem to
`public` (which ends the reflex) and emits `intercomReport`. A dead panel sends the reporter to the
next; a panel without power marks every unpowered panel dead for that reporter. Why: with the
generator out, reporters otherwise toured all sixteen dark panels for minutes. Code:
`intercom/report.ts`.

### Scouts

While the officer holds the bridge they raise `compartmentToCheck` (public, essential) for each room
nobody has covered since the last rock. A room is covered by a report, by any crew member in it
(on watch or off, awake or asleep), or by someone who was there when the rock hit. While rocks fall
a room is looked at once; when the field ends, once more for rooms hit since. The nearest on-duty
hand is sent, never the captain or officer. The check settles by a report, the scout's look
(`damage.checkSeconds`, 3) or the alert clearing. `scoutSent` and `hullPatched` are trace. Why:
re-checking every room after every rock sent about 35 scouts in a heavy field.

### Naming rooms

Rooms are named in sentences through `roomPhrase` (`core/rooms.ts`): "the" and the lowercased name,
unless the compartment carries its own `phrase` (Engineering's is "engineering").

## Field hooks

Which field events wake the narrator is §notable-event-hook. `fieldSighted`, `fieldEntered`,
`shipStuck`, `machineKnockedOut` and `shipLost` drop play speed (§auto-slowdown).
