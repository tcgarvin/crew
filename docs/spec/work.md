# Work

Problems, tasks, claims, the planner, supplies, the hand truck and what crew know. The fuller
narrative of the three layers is `docs/design/simulation-design.md` §14-15; this file holds the
rules as built. Code is in `packages/sim/src/systems/work/`, `packages/sim/src/planner/` and the
contract in `packages/sim/src/core/types/work.ts`.

## Problems, tasks and claims

### Problem ownership

A problem is a durable condition owned by the system that detects it; only the owner creates,
revises and resolves it. Owners (`ProblemOwner`): equipment (`machineSymptom`, `machineFault`,
`maintenanceDue`, `partsNeeded`), travel (`cargoToLoad`, `cargoToUnload`, `courseToPlot`),
commerce (`reserveLow`), watch (`stationToStaff`, the helm's watch and relief posts), galley
(`mealToCook`, `mealToCarry`), dirt (`compartmentDirty`), damage (`machineDamaged`, `hullScar`,
`hullDamaged`, `compartmentToCheck`) and medical (`crewWounded`, §the-wounded-problem). One
open problem per `dedupeKey`: the owner bumps `revision` instead of duplicating. Personal needs
are never problems; the planner builds eat, sleep, rest and socialise candidates from the actor's
own needs. The watch's own rules are in `time-and-watches.md`.

Why: a repair, a meal and a cleaning each have one place that knows when they are done; the work
system never guesses.

### Tasks and claims

The work system derives tasks from problems through `TaskDerivationTable`, one rule per kind; each
owning system exports its rules and `derivation.ts` asserts every kind is covered. A task's identity
is `(problemId, derivationKey)`; a revised problem updates its task in place or cancels tasks the
problem stops deriving. A task is done when its completion predicate holds against truth, never when
an animation ends; progress lives on the target (the fault, the item's location), so a task survives
a change of worker.

A claim is a lease on a task slot, `work.claimLeaseSeconds` (4) long, renewed each tick the
holder works. An incapacitated or stuck holder lets it expire (`claimExpired`) and the activity
fails. Claims are public: every planner sees each task's claimant. A task has `workerSlots`
workers at most.

### Blockage and backoff

A step that cannot proceed fails with a `BlockageReason`, releases the claim and records a
backoff (`work.retryBackoffSeconds`, 5) so nothing is retried every tick. Causes about the task
rather than the actor (`missingTool`, `inaccessibleSupply`, `rampClosed`, `unknownDiagnosis`,
`dependencyPending`) block the task for everyone until its `retryAfterTick`.

## The planner

### Choosing what to do next

`selectIntent` (`planner/select.ts`) is pure over the actor's `AgentView`: no state, RNG or
clock. It takes the most urgent class with an executable candidate (immediate survival,
containment, essential, routine, voluntary), then the lowest estimated seconds to useful
intervention in `work.timeBucketSeconds` (1) buckets, then higher skill, older task, stable id.
Candidates that are claimed by someone else, backing off, blocked, unreachable or beyond the
actor's skill or tools are rejected and never compete. Each actor reconsiders every
`work.reconsiderEveryTicks` (10), staggered. Someone on a `muster` or `fight` activity is the
expedition's: the planner answers `continue` until it hands them back
(§the-combat-system-owns-its-combatants).

A problem's urgency is the owner's `baseUrgency` unless `planner/candidates.ts` says otherwise
(a fault on an engine or life support is containment; known heat escalates a repair).
`maintenanceDue` takes the owner's urgency (§maintenance-due).

### Selector commitment

A current activity is kept against same- or lower-class candidates. A higher class interrupts,
except that an activity younger than `work.switchCooldownSeconds` (2) yields only to containment
or above, and a sleep yields only to containment or above at any age. Why: the cooldown stops
flip-flopping when a need crosses its threshold just after a commitment; sleep is taken whole.

### What a crew member weighs

`weighOptions` (`planner/weigh.ts`) returns the ranked candidates, the rejected ones with a
reason ("off watch: routine work waits for their watch", "leaving it to Priya Kessler, who is
better at it") and the intent the selector would choose. It is computed on request for the
inspector and never stored or run by the pipeline; the worker words it
(`apps/web/src/worker/weighing.ts`).

## Planning and execution

### Planning against truth

The planner chooses from beliefs; the work system builds the plan against truth. Before an actor
gives up what they are doing for a new task or personal activity, the new plan is built
(`startTask`, `startPersonal`); if it cannot be carried out the current activity is left alone and
the candidate backs off (the task is blocked if the cause is task-level). Why: a repair whose part
is aboard nowhere, chosen from stale beliefs every time its blockage expired, made the crate
carrier set the crate down mid-dock and then fail.

### Setting down supplies

An actor who stops a task (interrupted, failed, incapacitated or cancelled) or finishes one,
completed or not, sets down the tools and consumables they picked up for it where they stand
(`dropTaskSupplies`), and every other crew member is told where (a `report` fact), since they
last believed those items in someone's hands. Why: carried on, the ship's only spares or wrench
are out of everyone's reach through meals and sleep, and every other repair is blocked on an
inaccessible supply.

## What crew know

### Beliefs and perception

Crew act on a table of facts (`Actor.knowledge`): item locations, machine status, problems,
other people. Each planner cycle an available, awake actor looks around their compartment, or
around the dock they stand on, before planning (`systems/work/perception.ts`). It updates item
locations (marking a believed item that is gone as `absent`), outward machine status (never
hidden faults), `discovered` problems at a machine or compartment in view (`problemObserved`) and
other people. `public` problems (cargo, staffing, meals, scheduled work) are known to everyone;
`discovered` ones (symptoms, faults) only once the actor holds a fact for them, from sight or a
report.

### Crew briefs

A crew member whose knowledge table is empty is briefed once at their first look with the
location of every on-deck item, standing for having loaded the ship's stores. Anything else that
writes facts for crew (the freight brief, the report of set-down supplies, the servings brief)
skips someone still awaiting it (`awaitsFamiliarityBrief`): one fact would make the table
non-empty and the brief would never run, and they would not learn where the stores are. A hauler
starting a task is told the manifest location of its crate if they hold no belief about it.

## The hand truck

### Hand truck trips

`ItemDef.capacityUnits` is how many units of freight a hand truck carries. Content validation
requires it (at least 2) on every `handTruck` tool, which must be unique, and allows it nowhere
else. The default scenario stows one in the hold (capacity 4, `hand-truck.json`).

When a haul starts (`systems/work/truck.ts`), the work system plans it as a trip if the actor
believes a free truck lies on deck (free: no activity names it) and knows of further open,
unclaimed, unblocked hauls in the same direction (loading with loading, unloading with unloading,
to the same zone or dock area) whose crates they believe lie on deck, nearest first, up to the
capacity. Otherwise it is one crate in the hands. Freight in a port store (a port with no dock
map) never goes on the truck. The planner is unaware of trucks: it picks one haul as always.

### One activity, several claims

The planner's task is the activity's own (`taskId`, the lead); the others are
`Activity.haul = { truckId, legs: [{ taskId, claimId }] }`, present only on a trip. Every held
claim is renewed, expires, shows its owner and keeps its task from being pruned like any other.
The trip fetches the truck, loads each crate within reach, unloads each at its own destination
(hold zone when loading, bay tile when unloading) and parks the truck: where the last crate went
if aboard, else at the top of the cargo ramp. A leg settles when its crate is set down (completed
if its custody predicate holds, else released); the lead settles last, after the truck is
parked. So cargo work, and with it departure (`hasOpenCargoWork`), waits for the truck to come
back aboard.

### Stopping a trip early

If the pusher is interrupted, fails, is incapacitated or is called aboard, they set the truck and
every crate on it down where they stand and know where they are; legs whose crate arrived are
completed, the rest released. Nothing rides a truck nobody pushes (`workViolations`: one trip per
truck, only its pusher holds it). The crates are ordinary on-deck freight again, picked up by
hand or by the next trip. A truck not where the actor believed turns the trip into a hand haul of
the lead; a crate not where they believed drops that leg and the trip goes on. A truck still on
the dock at cast-off is handed up the cargo ramp (`gearBroughtAboard`, notable;
§ramps-and-cast-off). The call aboard never starts on a
pusher mid-trip, since it starts only once loading is done.
