# Equipment

Machines, their faults and symptoms, heat and integrity, diagnosis and repair, the parts and tools a
repair needs, and routine servicing. Code is in `packages/sim/src/systems/equipment/` (and
`systems/power/` for what a machine is allocated); machine content is
`packages/content/data/machines/*.json`; knobs are `config.equipment.*`.

## Machine state

### Heat

A machine heats while it is on and not under an `inoperable` fault, and cools every tick; the
temperature stays in [0, 1.5]. Cooling is a flat `coolPerSecond` from the machine's def, so a machine
whose rise beats its cooling would reach 1.0 and stop: the engine and generator cool faster than
they rise and do not overheat in normal running. Heat comes from `overheat` fault effects and from a
downed coolant pump. A pump is any machine tagged `cooling` on the machine's power domain; while
others on the domain are all off, cooling falls to a fifth. A domain with no pump is unaffected.
Above `derateAbove` output falls linearly to 0 at 1.0, where the machine stops. Above 1.0 it loses
integrity at `equipment.overheatDamagePerSecond` (0.02).

### Integrity

Integrity is what overheating costs and only a completed fault repair restores. Output derates
linearly below `equipment.integrityDerateBelow` (0.5) and the machine is blocked (off, shown as
"failed") below `equipment.integrityInoperableBelow` (0.15). A completed fault repair raises
integrity to at least the derate threshold. Why: the generator showed "bad shape" and the ship flew
anyway; the owner wanted integrity to matter.

### Output and blocking

Output is the product of four factors: power fraction, heat, fault derates and integrity;
`machineDerated` names the smallest as its cause. A machine is blocked when an `inoperable` fault is
present, its temperature is at 1.0, or integrity is below the inoperable threshold
(`isMachineBlocked`, shared with the departure gate). Power sets a consumer's mode first; equipment
may only push it toward off. Generators and batteries take `desiredMode` each tick unless blocked,
so a cleared fault resumes without a command.

### Wear and fault draws

While on, a machine wears (`wearPerSecond`) and accrues hazard, faster when hot or worn. Crossing the
sampled threshold draws one absent fault by weight on the `failures` stream (D6); the narrator's
`scheduleFault` fires a chosen one instead. A machine holds one fault per key.

## Faults and symptoms

### Symptoms

A fault raises a `machineSymptom` problem, essential urgency. A `sensor`-channel symptom (the
engine's stall warning, the generator's coil burnout) is public at once, like a panel alarm; a
`visual` or `audible` one is discovered only by someone in the compartment. Faults injected by a
scenario get the same problem: the tick opens one for any undiagnosed fault without one.

### Diagnosis

Diagnosing a fault is an `inspect` task of 20 s at engineering 1, no tool, at the machine's repair
positions (`DIAGNOSE_SECONDS`, `DIAGNOSE_SKILL`). It marks the fault diagnosed, resolves the symptom
and opens `machineFault` (`faultDiagnosed`). Diagnosis needs no tool or part, so it is work aboard
the departure gate waits for (see `travel.md`).

### Repair

A diagnosed fault's `repair` task runs the fault def's recipe steps in order (work seconds, skill,
tools, consumed parts, location). Progress lives on the fault, so a swap of hands or a save resumes
mid-step. A step's parts leave the repairer's hands once, when that step completes; tools are never
consumed. On the last step the fault is removed, condition rises by 0.5, integrity is restored as
above, the repair leaves dirt round the machine, and `faultRepaired` is emitted carrying the fault's
cause (the narrator's aftermath call needs it).

## Parts and tools

### Parts and tools needed

A diagnosed fault's repair is short of a part when its remaining steps consume more than the ship
has, and short of a tool when nothing aboard provides a kind its recipe names (any step; one unit is
wanted of the most specific item providing it: fewest tool kinds, then id). Either shortfall is a
`partsNeeded {machineId, itemDefId, count}` problem (once per machine and item, public, essential,
revised against truth every tick, resolved when covered). "Aboard" is on deck, in hands, worn, or on
the dock beside the ship; freight on offer is nobody's. An undiagnosed fault needs nothing yet. The
crew buy the shortfall at a port that sells it; see `commerce.md`. The narrator's `stockMarket`
lever may make a part available at a port, but never buys, delivers or repairs (see
`narrator-story.md`).

### Tool shortfall

Content validation requires every scenario to carry a tool of every kind that a repair or
inspection recipe on its decks names. Why: a tool sold only at a far port leaves the repair
impossible everywhere else. Markets may still sell tools as replacements; a lost welder makes
`partsNeeded` like a part. Repair out of reach is `repairOutOfReach` (`supplies.ts`): a diagnosed
fault whose shortfall the ship lacks and the port market cannot sell in full now (out of stock, or
beyond the ship's money).

### Impairments out of reach

The departure gate judges each impairment (see `travel.md`); equipment supplies what "out of reach"
means. A fault-driven impairment is out of reach when its fault's repair is. An impairment with no
fault of its own that another machine causes (a consumer starved on a bus whose generators are
impaired, a machine hot on a bus whose coolers are all impaired) is out of reach only if every cause
is, and the reason named is the cause's fault. With no cause to point at (integrity alone, an
overloaded bus), it counts as in reach.

### Limping

When every engine wanted on is below `travel.limpSpeedFraction` (0.2) of nominal and impaired by a
fault whose repair nothing aboard can finish (judged with no market, under way), the ship moves at
that fraction, sets `travel.limping` and says `shipLimping` once (narrative, hooked). While a repair
aboard could still restore an engine, the ship drifts and the crew work. Why: at sea the narrator
has no lever to rescue a ship; a parts delivery was rejected (the owner: "let's just deal with
things that are already there") and so was ending a drift on a timer.

## Servicing

### Maintenance due

A machine with a `maintenance` def (engine, generator, coolant pump, life support, battery bank,
cargo crane, galley stove, helm) is serviced when worn. `maintenanceDue` is raised routine below
`equipment.maintenanceConditionBelow` (0.3) and raised, never lowered, to essential below
`equipment.maintenanceEssentialBelow` (0.15); only the service resolves it. The service is a
ten-second task (tools and skill per def; skill 1, so every section has someone who can do it) that
restores `conditionRestored`. The stove is serviced from its front and the helm from its standby
position, so neither cook nor stander is moved off. The planner uses the problem's own urgency;
essential puts the service ahead of the on-duty engineer's chores and ends their game, but calls no
one off watch (see `time-and-watches.md`). Why: with servicing only on the engine and generator,
every other machine wore to 0%; letting routine watch work end a game at the bell doubled abandoned
games and left wear unchanged.
