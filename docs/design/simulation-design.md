Crew — Simulation Design

Version: Draft v0.1
Date: September 29, 2026
Audience: Implementing agent and project owner
Companion: Crew — Game Design Document, Draft v0.1
Purpose: Specify the autonomous physical simulation beneath the game. Narration and player interface design are outside this document except for the narrow integration contracts the simulation must expose.

1. Authority, interpretation, and implementation posture

The supplied GDD is the product brief. This document develops its simulation requirements into a proposed implementation specification. It does not replace the GDD, change its player-control model, or make every tuning value a settled product decision.

Distinguish three kinds of direction:

• Inherited requirement: A requirement already established in the GDD or the accompanying discussion. Preserve it.
• Implementation default: The proposed first implementation. Use it without repeatedly asking the owner to select routine technical details. Keep it configurable or replaceable where specified.
• Prototype hypothesis: A behavior or balance question to evaluate experimentally. Implement the stated baseline, instrument it, and report evidence before materially changing it.

Inherited requirements include autonomous crew, a physically simulated captain and first officer, a fixed initial freighter, approximately 6–8 initial crew, physical resources, imperfect information, smooth grid-based movement, meaningful bodily injuries, and no model inference in moment-to-moment simulation. The first playable build excludes ship combat and boarding. Approximately 20 crew is a later practical target, not an initial content requirement.

The phrase “RimWorld-like combat” is interpreted here as individual positioning, cover, weapons, armor, injuries, incapacitation, and rescue. Tactical execution remains autonomous under the supplied GDD. Direct player control of combat pawns would be a separate product decision; do not add drafting or pawn-command controls as an implementation convenience.

If an implementing agent encounters a conflict, retain the explicit GDD requirement and identify the conflict. Do not silently invent a new product rule to resolve it.

2. Central simulation objective

Build one small ship whose ordinary operation is comprehensible and interesting at 1× speed, and whose crises follow from the same rules used during ordinary operation.

The central causal relationship is:

> A person’s condition affects what they can do; what they do changes the ship; the ship changes the conditions under which everyone else must act.

A hand injury slows repair. A slow repair lets an engine overheat. An overheated engine reduces propulsion. A damaged communications circuit delays a report. A nearby crew member begins first aid before a distant medic arrives. These interactions should not require a separately authored event outcome.

The simulation must support headless execution. Rendering, narration, and interface availability must not determine physical outcomes.

3. First-build scope

|Area        |First simulation build                                                         |Extension supported, implementation deferred           |
|------------|-------------------------------------------------------------------------------|-------------------------------------------------------|
|Interior    |One authored freighter, one active deck, fixed rooms and equipment footprints  |Multiple decks, other ship classes, small off-ship maps|
|Characters  |6–8 crew, captain, first officer, a few passengers when needed                 |Approximately 20 crew, hostile boarding parties        |
|Movement    |Grid navigation with authoritative fractional positions                        |Additional locomotion, EVA navigation                  |
|Work        |Autonomous task selection, actions, claims, interruption, handoff              |More sophisticated coordination if evidence requires it|
|Ship systems|Power, cooling, propulsion, atmosphere, doors, sensors, communications         |Weapons, additional engineering systems                |
|Damage      |Local structural and equipment damage, faults, fire, breaches                  |Detailed explosions, combat damage delivery            |
|Health      |Local wounds, bleeding, pain, hypoxia, capacities, basic treatment and recovery|Surgery, prosthetics, extensive disease catalog        |
|Life        |Food, fatigue, rest, basic shifts, mood, relationships, coarse social memories |Additional needs if they produce useful behavior       |
|Inventory   |Located objects, carrying, stacks, tools, parts, food, medical supplies, cargo |Ammunition and specialized equipment                   |
|Travel      |Three abstract ports, departure/transit/approach/docking state                 |Detailed exterior maneuver and combat                  |
|Commerce    |Accepted jobs, physical loading and delivery, payment transactions             |Deep economy, factions, market simulation              |
|Integration |Validated commands, observations, events, external decision requests           |Narrator implementation and player presentation        |

Do not add ship construction, research, departments, a player-maintained priority table, a separate character-goal framework, elaborate mutiny, or a large galaxy to complete this specification.

4. Architectural boundaries

4.1 Simulation kernel

The kernel owns authoritative state and advances it through fixed steps. It accepts scheduled commands, runs simulation systems in a specified order, and emits structured events.

Use an entity/component style of data organization where useful. A full ECS framework is optional. Stable IDs, explicit ownership, testable systems, and a serializable state model matter more than framework choice.

The implementation language is intentionally unspecified. Schema examples in this document describe contracts rather than a required programming language or library.

4.2 Recommended modules

|Module                      |Responsibility                                                                |
|----------------------------|------------------------------------------------------------------------------|
|World and lifecycle         |IDs, entity creation/removal, ownership, transactional mutations              |
|Clock and command queue     |Fixed ticks, scheduled inputs, pause, deterministic ordering                  |
|Spatial model               |Geometry, footprints, interaction positions, navigation, movement             |
|Networks                    |Power, cooling, communications, sensor availability                           |
|Environment                 |Gas transport, pressure, oxygen, smoke, heat, fire, breaches                  |
|Equipment                   |Operation, wear, explicit faults, diagnostics, repairs                        |
|Bodies and needs            |Wounds, capacities, exposure, hunger, fatigue, rest, death                    |
|Perception and communication|Observations, reports, delivery, stale knowledge                              |
|Work                        |Task creation, known task candidates, selection, claims, actions, interruption|
|Social state                |Procedural traits, interaction outcomes, mood and relationship changes        |
|Travel and contracts        |Ship operating state, route progress, physical delivery, accounting           |
|Persistence and diagnostics |Snapshots, replay inputs, invariants, traces and measurements                 |

Keep task planning separate from physical action execution. Keep actor knowledge separate from world truth. Keep rendering separate from all three.

4.3 Access boundaries

The planner consumes an AgentView, not an unrestricted world object. It must not query hidden faults, undiscovered casualties, remote door states, or another person’s unreported injuries.

Physical execution and environmental systems can access authoritative state to enforce reality. A failed execution can produce an observation that changes an actor’s knowledge.

Debugging and permitted player inspection can access full state through a separate interface. That interface must not accidentally become an input to crew planning.

5. Time, update order, and reproducibility

5.1 One simulation clock

Default: 20 ticks per simulation second; dt = 0.05 seconds. Store time as an integer tick count. Durations are converted to integer ticks using an explicitly documented rounding rule, preferably ceiling for actions that must take at least a specified duration.

At 1×, one real second advances one simulation second. Gameplay rates and voyage durations are tuned for this clock rather than copied from real biological or engineering timescales.

Rendering can run at any frame rate. Speed controls change the number of steps processed per real second; they do not change dt, walking speed in simulation units, or hazard equations. Pause advances no ticks and accumulates no catch-up debt.

Use a real-time accumulator with bounded work per display frame. When unable to keep up, report the effective speed and allow presentation to lag. Do not enlarge dt or silently drop simulated time.

5.2 Fixed step sequence

Use the following initial order. Ordering changes are simulation-version changes and require regression verification.

1. Apply due inputs and impacts. Validate queued commands and scheduled damage. Resolve same-phase impacts as a batch against a shared starting snapshot where appropriate. Commit lifecycle changes and inventory transfers atomically. Recompute capacities and immediate incapacity/death from direct damage before any affected actor can move or perform work this tick.
2. Refresh invalidated topology and networks. Recompute affected connectivity; allocate power; determine operating equipment and cooling availability from the current state.
3. Advance movement and actions. Check actual preconditions and physical safety signals, advance movement, and accumulate work. Commit completed actions and door transitions in stable order.
4. Advance environment and equipment. Integrate machine heat, coolant behavior, gas sources and transport, smoke and fire. Apply environmental damage through a consistent damage path.
5. Advance bodies and needs. Evaluate exposure using positions reached this tick; integrate bleeding, oxygen debt, needs, rest, healing, and capacity changes. Commit incapacitation and death transitions immediately.
6. Deliver information and observe. Deliver due messages, sample observations, update local knowledge, and create or revise known work requests.
7. Plan and assign. Run due task reconsideration, immediately cancel invalid work, and assign next actions for the following tick.
8. Finalize events and diagnostics. Emit committed events, update metrics, and run enabled invariant checks.

Changes in later phases invalidate affected actions immediately, but newly planned actions begin next tick. A newly fired projectile cannot arrive earlier than the next tick in this initial contract. Combat is deferred; this rule establishes consistent ordering for future extensions.

An action completing early in a tick can affect that tick’s environment. For example, completing a patch can stop that tick’s gas loss. This bounded one-tick discretization is acceptable; preserve it consistently rather than varying it by frame rate.

Do not re-enter the entire step recursively when a component fails. Mark affected connectivity dirty and refresh it at the next specified phase. Events must not trigger an unbounded cascade within one call.

5.3 System cadence

|Work                                             |Initial cadence                              |
|-------------------------------------------------|---------------------------------------------|
|Movement, actions, environment, bodies           |Every tick                                   |
|Immediate sensed-danger response and invalidation|Every tick                                   |
|Ordinary task reconsideration                    |Every 10 ticks, staggered by actor           |
|Sensor sampling and routine observation          |Every 10 ticks, plus important transitions   |
|Social opportunities and coarse mood evaluation  |Every 20 ticks                               |
|Topology/connectivity                            |On invalidation, not continuous full rebuilds|

Cheap continuous need integration can remain every tick. Slower systems must integrate the actual elapsed simulation time and preserve threshold events; cadence must not change their effective rates.

5.4 Randomness

Use seeded, serialized PRNG state. Do not use wall-clock time or unseeded randomness for outcomes.

Prefer separate random streams for world setup, equipment failures, health complications, and actor social activity. Store their states or counters. Iterate candidates in stable order and use explicit tie-breakers.

The reproducibility target is identical authoritative state for the same initial state, configuration, implementation version, and ordered inputs on the same supported runtime. Cross-platform bitwise reproducibility is not an initial requirement. Floating-point operations still require stable ordering and bounded values.

5.5 Acceleration and shortcuts

The first implementation accelerates by executing normal steps in batches. It does not skip physical simulation because a situation appears quiet. Quiet can end with a latent failure, need threshold, or arrival.

Analytic fast-forward is later work and must preserve deadlines, scheduled hazards, communications, and intermediate threshold crossings. It is not necessary for the first vertical slice.

6. World and location model

6.1 Entities and identity

Every persistent person, machine, unique object, door, structural section, and task has a stable ID. An object replacement creates or transfers an actual object; it does not rename a broken component out of existence.

Every physical entity has exactly one location or owner at a time. Location variants include:

PhysicalLocation =
    OnDeck(shipId, deckId, x, y)
  | InContainer(containerId)
  | CarriedBy(actorId)
  | EquippedBy(actorId, slot)
  | InstalledIn(machineId, componentSlot)
  | InExternalStore(portId, containerId)

Containment must be acyclic. A carried object’s effective position is its carrier’s position. An installed component’s effective position is its machine’s footprint. Containers can be moved, but their contents must not acquire independent deck locations until transferred out.

An external store has canonical custody even though the port is not a full active map. Later materialization into a map preserves IDs and ownership.

6.2 Deck geometry

Use integer tile coordinates in ship-local space. A navigable tile represents standing space rather than a cubic volume of hull material.

Default: Floors occupy cells; walls and doors restrict transitions along cell boundaries. Unoccupied space outside the hull is not navigable. Large objects occupy multiple cells. Do not mix wall-cell and wall-edge geometry inconsistently.

Geometry records:

• Existence and integrity of floor cells.
• Compartment membership.
• Boundary segments with wall, hull, opening, or door state.
• Machine and furniture footprints.
• Interaction positions.
• Navigation costs and known local hazards.

Later decks connect through explicit transition entities. The coordinate model must include deckId from the start even though only one deck is initially authored.

6.3 Compartments

A compartment is a fixed authored environmental region with volume, gas, and thermal state. It may have semantic tags such as infirmary or cargo hold, but tags alone do not provide functionality. Equipment and objects provide functionality.

Opening a door adds atmospheric conductance between two compartments. It does not merge and reconstruct their gas state. Destroying a dividing wall adds another connection. This prevents losing or duplicating gas when topology changes.

An opening to exterior vacuum is an explicit connection to a sink. Fixed compartment regions are an acceptable first-build abstraction. More granular subdivision of large rooms can be added if room-level mixing conceals useful consequences.

6.4 Machines and interaction positions

A machine has a footprint and one or more legal interaction positions. Work requires both a reachable position and the ability to interact with the relevant component.

Worker capacity is explicit. A pump might support one repairer; a large patch might support two people; a bed may accept one patient and one treatment position.

Interaction positions are reserved independently from passage through nearby cells. Furniture or an unconscious person should not accidentally become an impenetrable wall unless its authored obstruction rules specify that.

7. Movement and doors

7.1 Authoritative movement

A moving actor stores a route and progress along the current route segment. Its world position is derived from segment endpoints and distance travelled, with enough persistent state to resume exactly after save/load.

MovementState
  path[]
  segmentIndex
  segmentDistanceTravelled
  effectiveSpeed
  navigationKnowledgeRevision
  blockedSinceTick?

Movement is continuous over simulation ticks. The actor is not teleported to the next tile with a visual animation attached afterward.

Use approximately constant speed through open space. Smooth visual interpolation and minor turning animation are presentation concerns; they must not alter arrival times or authoritative hit/exposure positions.

7.2 Pathfinding

Default: A* with cardinal cost 1 and diagonal cost sqrt(2). Diagonal movement is forbidden if it crosses either blocking orthogonal boundary. Doors are crossed through their actual opening and never diagonally through a corner.

Route planning uses the ship’s known schematic plus the actor’s latest observed or reported obstruction state. Do not secretly route around an undiscovered fallen object or remote failed door using omniscient dynamic geometry.

Execution validates actual geometry. Encountering an unexpected obstruction creates an observation, invalidates the route, and prompts replanning. The same applies when a door believed operational fails to open.

Cache static navigation and interaction positions. Dynamic route cache keys include relevant knowledge and geometry revisions. Avoid recomputing a full route every tick.

7.3 Speed

speed = baseSpeed
      * movementCapacity
      * fatigueModifier
      * loadModifier
      * terrainModifier

All modifiers have documented bounds. A nonmoving actor cannot finish a route through accumulated stale progress. Carrying a casualty uses the carrier’s speed and load; the patient remains physically attached to the carrier.

7.4 Congestion

Friendly crew may pass with a small delay or yield in corridors. They must not freely overlap at occupied work destinations, but first-build navigation does not need full multi-agent collision physics.

Use short destination and crossing reservations, stable arbitration with a fairness mechanism, and bounded waiting before rerouting. Prevent permanent face-to-face corridor deadlocks and starvation of higher-ID actors.

A legal passing abstraction can temporarily allow overlapping friendly movement footprints. Preserve distinct positions and prohibit simultaneous ownership of the same exclusive workstation. Hostile collision rules are a later combat extension.

7.5 Doors

Separate physical state from command intent:

Door
  physicalState: closed | opening | open | closing | jammed
  requestedState
  integrity
  sealQuality
  powerConnection?
  actuatorFault?
  manualOperationSupported
  transitionProgress

Power failure ordinarily leaves a door in its current physical state. An explicit spring-return design may behave differently. Do not give all doors an unexplained universal fail-open or fail-closed property.

Normal powered closure waits for a crossing actor to clear the aperture. It never teleports an actor to either side. Forceful closure, crushing, and pressure-driven movement are later mechanics requiring explicit damage rules.

Manual operation takes work and may require acceptable pressure differential. A jam, damaged actuator, and failed seal are distinct faults: a door can open while failing to isolate atmosphere.

Actors select routes and precautions using known conditions. Directly sensed pressure, smoke, heat, or equipment response can immediately change their decision.

Execution checks must not become a hidden safety oracle. Enforce real geometry and capabilities, but only disclose environmental danger through a supported local sense, instrument, report, or actual exposure. A route is not cancelled because an unopened distant compartment contains a danger the actor has no way to detect.

8. Physical inventory and transactions

8.1 Objects and stacks

Use unique entities for plot objects, personal possessions, installed components, and distinctive equipment. Interchangeable food, bandages, and generic repair stock may be stacks.

Stacks record type, count, condition where relevant, location, and reserved quantity. Splitting or merging is an atomic transaction. Count cannot become negative, and reservation cannot exceed available count.

Never represent a unique object solely as a fact in a character’s narrative record. A smuggled diamond requires an actual item in a canonical container before later events depend on it.

8.2 Acquisition and hauling

Using a resource normally requires acquiring it from its actual location. Inventory planning uses the actor’s known resource locations; physical pickup validates that the object or quantity is still present.

If a kit has moved, the actor discovers the discrepancy and updates knowledge. It does not receive the kit remotely or learn its new location automatically.

Tools can be reusable; consumables are removed when the relevant action commits their use. Define the commit point in each action recipe. Returning or abandoning a task must not refund an already applied consumable.

8.3 Incapacitation and death

An incapacitated actor stops work and movement, releases expiring work claims, and drops actively held loose tools or loads according to item rules. Worn equipment remains equipped. The actor’s body stays at its actual position.

A carrier becoming incapacitated places the carried patient at the carrier’s current legal position or a deterministic adjacent recovery position, without moving through a wall. This is a physical drop transition, not rescue completion.

Dead characters retain a body and possessions. Cleanup, transfer, and later disposal are separate work. Do not erase the person’s items merely because their actor state changes.

9. Equipment, faults, and ship networks

9.1 Machines

Machine
  id, type, footprint, interactionPositions
  integrity
  condition
  desiredOperatingMode
  actualOperatingMode
  powerInput
  temperature
  faults[]
  installedComponents[]
  operationRequirements

Integrity represents physical damage. Condition represents wear or maintenance state. A fault identifies a mechanically specific failure. A machine can have good integrity and still be inoperable because its controller failed.

Machine definitions declare inputs, outputs, operating requirements, heat generation, fault effects, and task/action recipes. Keep the initial fault catalog small.

Useful first faults include worn bearing, failed controller, coolant leak, electrical short, jammed actuator, damaged seal, and obstructed access.

9.2 Failure timing and maintenance

Schedule failure hazards from seeded randomness and current operating conditions. Hazard can depend on load, temperature, wear, and existing faults. An implementation can integrate an accumulated hazard against a sampled threshold, avoiding a fresh unseeded chance each frame.

Inspection and maintenance reduce identified risks or restore condition through actual work and resources. They do not eliminate all future failure.

Fault existence is authoritative; fault diagnosis is knowledge. A sensor can reveal high temperature without revealing the exact failed part. Successful diagnosis creates a repairable problem report with the relevant information.

9.3 Power

Use a graph of generators, batteries, distribution segments, breakers, and consumers. Graph nodes and serviceable connections have physical locations.

For the first version, a connected electrical domain shares available supply. Connections can be severed or isolated. Detailed voltage and current simulation is deferred. Initial connections may have unlimited transfer capacity; do not pretend to solve capacity-constrained power flow with a connectivity test.

Allocate supply using authored consumer priorities and operating minimums. An initial priority order is life support and essential controls, critical cooling, propulsion, then nonessential domestic and cargo equipment. This is a configurable operating policy, not a player priority spreadsheet.

Equipment definitions specify whether partial power reduces output or prevents operation. Consumers of equal priority require stable, documented allocation, with proportional allocation where supported. Avoid frame-to-frame flicker from unstable ordering.

Batteries store energy, not instantaneous power. Enforce maximum charge/discharge rates and energy bounds. Within a tick, discharge to cover generation shortfall or charge from genuine surplus; do not charge and discharge the same battery simultaneously.

An electrical short can trip its associated protection device through an explicit rule. Detailed overcurrent modeling is not initially necessary. A tripped breaker does not imply the short is repaired.

9.4 Cooling

Model a small number of authored cooling loops with coolant quantity, pump effectiveness, connected heat sources, and heat rejection equipment.

Available cooling depends on connectivity, pump power and condition, coolant quantity, and radiator availability. A leak reduces coolant stock. A pump failure reduces circulation. A damaged radiator reduces heat rejection.

Each heat-producing machine has thermal capacity:

machineTemperature += (generatedHeat - removedHeat) * dt / thermalCapacity

Account for transferred heat in the loop before rejecting it. A cooling loop must not remove unlimited heat merely because a pump is marked on. This model need not simulate flow through every pipe.

At authored thresholds, equipment can derate, shut down, or accumulate damage. Use distinct restart and shutdown thresholds to avoid rapid oscillation.

9.5 Propulsion, stations, and staffing

Propulsion output derives from operating machinery and supplies. Route progress responds to that output. The engine does not automatically stop because nobody is standing in engineering.

Station requirements are specific:

• Machinery may operate unattended.
• Some machinery needs periodic inspection.
• Docking may require a staffed control station.
• A degraded control system may require continuous attendance.

For a staffed station, define the consequences of vacancy and the requirements for takeover. Ordinary shift handoff reserves a standby position and transfers control when the replacement arrives. An urgent departure from a station can leave a genuine operating deficit.

9.6 Communications and sensors

Communications are a separate graph from power, although powered devices need power. Terminals, intercom endpoints, and sensor controllers fail independently.

A sensor generates readings of what it measures. A sensor does not grant unlimited knowledge of every entity in its room. A temperature sensor can detect heat; a configured life-sign sensor may detect occupancy; a general equipment monitor can report a fault code if that machine supports one.

Power or communications loss stops new readings and reports. Existing crew knowledge persists with its original timestamp and becomes stale.

10. Atmosphere, heat, fire, and structural damage

10.1 Environmental state

Each compartment stores volume, oxygen quantity, inert gas quantity, contaminant/smoke quantity, and air thermal energy. Use consistent game units and a reference pressure/temperature. Do not implement oxygen only as a percentage.

For an initial normalized gas model:

gasAmount = oxygen + inertGas + contaminantGas
pressure = (gasAmount / volume) * (airTemperature / referenceTemperature)
oxygenPartialPressure = pressure * oxygen / gasAmount

When gas amount is approximately zero, pressure and oxygen partial pressure are zero; air temperature is handled by a documented empty-gas convention without creating energy. Structural and machine heat are separate from gas heat.

For this normalized model, use a documented constant gas heat capacity and derive airTemperature = airThermalEnergy / (gasAmount * gasHeatCapacity) when gas amount is above epsilon. Moving gas carries its donor temperature and corresponding energy. When the final gas leaves, its remaining thermal energy leaves with it; an empty-room reference temperature used for display or subsequent initialization is not stored energy. A later species-specific heat-capacity model can replace this simplification.

Breathing suitability depends on oxygen partial pressure, total pressure, contamination, and temperature. Exact hazard curves are gameplay parameters rather than a medical simulation claim.

10.2 Gas exchange

Openings have area/conductance and endpoint compartments. Closed sealed doors have zero or small leak conductance depending on seal condition. Breaches lead to exterior vacuum.

Compute candidate transport from a shared pre-transport snapshot. For each donor compartment, sum requested outgoing gas and scale transfers so combined outgoing quantity cannot exceed available gas. Transfer species in the donor mixture proportions and transfer associated thermal energy.

Accumulate all deltas before applying them. This avoids negative gas, processing-order bias, and duplication when several doors drain the same room. Transport between interior compartments conserves each transported species and energy. Exterior loss is recorded in a sink ledger.

Source/sink processes—life support, breathing, combustion, filtration—are applied in a documented consistent stage. All gas quantities remain nonnegative. If the simplified chemistry converts oxygen into inert or contaminant gas, account for that conversion explicitly; do not hide it inside an unexplained clamp.

At very high conductance, cap transfers or use bounded internal substeps. Never compensate for numerical instability by making gas appear.

10.3 Heat and smoke

Air, machinery, and combustible objects exchange heat through configured rates. The first version can approximate room air as well mixed. Smoke exposure is therefore compartment-level, while the fire source is local.

Filtration and ventilation remove or transport smoke using actual operating equipment and gas connections. A closed door can slow spread only if its physical seal is adequate.

The visual appearance of smoke must not determine its hazard state.

10.4 Fire

Fire belongs to a tile, object, or machine and records intensity, combustible material remaining, and local heat contribution. It consumes available oxygen, produces heat and contaminants, damages nearby entities, and can ignite eligible neighbors through seeded rules.

Not every tile is combustible. Empty metal floor should not perpetually burn without a source. Equipment, furnishings, cargo, and leaking fuel can supply material.

Extinguishing reduces fire according to tool effectiveness, access, and actor capacity. Oxygen starvation suppresses combustion, but does not repair damaged equipment or instantly cool hot material. Reignition is permitted while relevant conditions remain.

A small fire can block an interaction position without disabling every machine in the compartment. This distinction is central to the design.

10.5 Breaches and patches

A breach has an aperture and a physical repair location. A patch changes aperture/seal state through actual work. Emergency patching can restore containment without fully restoring structural integrity.

Patch progress persists at the structure. Incomplete work must not be discarded merely because the worker changes. If a further impact destroys the patch, apply damage to that physical work and revise the task.

10.6 Local damage

Use a shared damage entry point for accidents, environment, and future combat:

DamageIntent
  targetId or spatialRegion
  damageType
  magnitude
  sourceId?
  incidentId
  tick

Damage can affect structure, machinery, inventory, and bodies through type-specific rules. A failure does not author a named victim’s death; location and exposure determine who is affected.

There is no mandatory global hull-health bar. Structural sections have integrity and can produce breaches, blocked routes, or loss of floor. Catastrophic ship loss requires an explicit lifecycle rule, not “one room reached zero.”

For the initial deck, loss of standing space is a severe local hazard that interrupts movement and work. Full ejection, EVA rescue, and exterior body trajectories are deferred. Do not teleport a displaced person into an unrelated safe room to avoid solving the edge case.

11. Character model

11.1 Baseline character state

Actor
  id, identity, crewMembership, roleTags
  physicalLocation, movementState
  body, capacities
  skills, qualifications
  needs, mood, traits, preferences
  schedule, currentDuty, activeTask, activeAction
  carriedInventory, equipment
  knowledge, navigationKnowledge
  relationships, coarseMemories
  availabilityState

The captain and first officer use this same actor model. A role tag does not exempt them from needs, injury, movement, or work requirements.

11.2 Skills and eligibility

Distinguish skill level from permission or qualification. A task can require a minimum competency, a tool, or a particular capability. Repeated successful participation can improve skill.

Cross-training happens through actual work or explicit supervised training when supported. Do not award experience simply because a job category is enabled. Rate gains conservatively to preserve specialization.

The initial crew should deliberately contain overlap: more than one person capable of basic first aid, firefighting, cargo work, and elementary repair. Some advanced work can remain specialist-dependent.

11.3 Needs and fatigue

Start with hunger, fatigue, comfort, and social contact. Needs create tasks or activity candidates rather than a second independent planning system.

Work and interrupted sleep increase fatigue. Rest reduces it. Hunger changes with elapsed time and food intake. Mood reflects needs and experienced events, with bounded effects on work and willingness.

Avoid immediate collapse at arbitrary mild thresholds. Severe deprivation can impair capacities; ordinary discomfort should generally modify behavior and performance.

11.4 Shifts and routine policies

Use an authored initial roster of working and resting windows, plus automatic coverage for required duties. An off-duty person remains eligible for an emergency.

First-officer availability can support routine command while the captain sleeps, but the work scheduler must not stop because either officer is unconscious. Ordinary task selection is not a physically centralized dispatch machine.

When a specialist is unavailable, substitutes may be slower or unable to complete advanced phases. Preserve the resulting limitation instead of granting universal competence.

11.5 Social behavior

Procedurally generate traits and preferences using bounded distributions and compatibility rules. Do not depend on model-generated prose to establish personality diversity.

Create brief social actions when compatible people are nearby, off duty, sharing a meal, or waiting without urgent work. Outcomes can adjust mood and relationships and produce coarse memories.

Memories record limited mechanically useful state: helped by, feels betrayed by, afraid of a situation, trusts a person more, or grieving a known death. Store cause/reference IDs where useful. Do not require a granular memory graph for every spoken sentence.

Social consequences depend on experienced or reported facts. A hidden death or secret act does not change everyone’s relationships merely because world truth records it.

12. Bodies, wounds, treatment, and recovery

12.1 Body structure

Use a body-part tree with a conservative initial catalog: torso; head and eyes; paired arms, hands, legs, and feet; and a few vital structures such as brain, heart, and lungs. Individual fingers and a large organ catalog are unnecessary initially.

Body-part definitions specify parent, structural tolerance, contribution to capacities, protection group, and whether loss is survivable under the game’s rules.

An absent parent makes its children unavailable. An absent arm does not leave a mechanically functional detached hand attached to the actor.

12.2 Wound records

Wound
  id, bodyPartId, damageType
  structuralDamage
  baseBleedingRate
  currentBleedingRate
  painContribution
  treatmentState, treatmentQuality
  createdTick, lastTreatedTick?
  healingProgress
  complicationState?
  incidentId

Whole-body state includes blood reserve, oxygen debt, systemic pain, consciousness, and life status. Wounds are persistent state, not temporary combat effects.

Compute local function from damage and conditions. Derive movement, manipulation, sight, breathing, and consciousness using data-defined aggregation rules. Document how bilateral parts combine. Avoid a single overall health number deciding every ability.

An adequate initial aggregation model is:

partFunction = present
  ? clamp(1 - activeStructuralDamage / partTolerance, 0, 1) * conditionModifier
  : 0

leftHandChain  = min(leftArmFunction, leftHandFunction)
rightHandChain = min(rightArmFunction, rightHandFunction)
manipulation   = mean(leftHandChain, rightHandChain) * systemicWorkModifier

leftLegChain  = min(leftLegFunction, leftFootFunction)
rightLegChain = min(rightLegFunction, rightFootFunction)
movement      = mean(leftLegChain, rightLegChain) * systemicMovementModifier

sight = mean(leftEyeFunction, rightEyeFunction) * neurologicalModifier

Clamp all resulting capacities to their documented range. Systemic modifiers are configured curves for blood loss, oxygen debt, pain, fatigue, and relevant vital function; use curves with safe normal ranges rather than multiplying every mild discomfort into catastrophic impairment. Consciousness and breathing use their own organ/systemic rules. Sleeping by choice is an activity state, not a traumatic loss-of-consciousness condition.

Tasks can require separate limb use, such as two usable hand chains, in addition to a scalar manipulation minimum. These deliberately simple formulas are implementation defaults for meaningful impairment, not final physiological balance. Treat missing-part and prosthesis definitions consistently when later extending them.

12.3 Injury production

Accidents, burns, exposure, and later weapons create injuries through a common body-damage path. Local impacts choose appropriate affected parts based on incident geometry and damage profile. Area hazards can affect several exposed parts.

For future weapon hits, first resolve physical hit and protection, then choose affected body parts using weapon and exposure rules. The body does not require voxel anatomy.

Severing requires an appropriate damage profile and severity. A zero-function limb can be crushed, burned, or disabled without being physically severed. A lost limb can leave a bleeding stump attached to the remaining parent body region; removing the part must not erase hemorrhage.

12.4 Incapacitation and death

Incapacitation can result from loss of consciousness, severe pain, blood loss, or inadequate movement. Distinguish unable to walk from unconscious: a conscious immobile actor can observe, communicate, and sometimes perform reachable actions.

Death occurs through explicitly configured terminal conditions such as destruction of a vital structure, extreme blood loss, or excessive oxygen debt. These thresholds are game mechanics. Do not use a generic “incapacitated too long” timer as a substitute for physical cause.

Death cancels future active work and broadcasts no information by itself. Someone or an instrument must discover and report it.

12.5 Medical workflow

Separate these tasks and allow handoff:

1. Initial aid: A nearby capable person addresses immediate bleeding or another supported threat.
2. Extraction: Move the casualty from an unsafe environment when feasible.
3. Definitive basic treatment: Use an appropriate kit, supplies, time, and skill to tend wounds.
4. Recovery support: Provide rest, food, safe atmosphere, and any required follow-up care.

The order depends on circumstances. A person in lethal smoke may need extraction before lengthy treatment. A person rapidly bleeding in a safe room may need immediate aid before transport.

All initial crew can be given a limited basic-aid qualification, while advanced treatment remains skill-sensitive. This avoids making the medic’s availability the only determinant of whether anybody helps.

Medical actions target actual wounds and consume appropriate supplies. Quality affects bleeding control and recovery. A severe wound may need a better tool or specialist rather than unlimited retries with ineffective aid.

12.6 Beds and infirmary equipment

A medical bed provides a safe resting position. Treatment equipment, supplies, power, and caregiver access provide additional benefits. Entering a room tagged infirmary does not regenerate health automatically.

Reserve patient capacity and caregiver interaction positions separately. A casualty waiting for a bed can receive useful aid elsewhere.

12.7 Triage and estimates

Use simple estimates from known observations: bleeding severity, consciousness, known oxygen hazard, travel time, and available treatment. Exact time-to-death need not be known to a character.

Avoid evaluating a distant patient’s hidden full wound list in the scheduler. Upon reaching and examining the casualty, new observations can refine urgency.

Triage considers whether useful intervention can finish before the known deadline, not simply which patient has the lowest health. If success is impossible, record that limitation and continue with defensible available work. Do not guarantee that every casualty can be saved.

12.8 Recovery and lasting effects

Treated wounds heal over time under configured conditions. Blood and oxygen debt recover through their own rules. Rest restores fatigue independently of wound repair.

Basic treatment does not restore a missing limb. Lasting impairment feeds back into duties and speed across subsequent voyages. Surgery and prosthetics are deferred, but the body schema should support replacement parts later.

An extensive infection/disease system is optional later work. Do not let placeholder fields expand first-build scope.

13. Information and communication

13.1 World truth and actor knowledge

World truth records what is happening. Actor knowledge records what a person has observed, received, or inferred. Neither substitutes for the other.

KnownFact
  subjectId or locationRef
  factType
  observedValue
  observedTick
  learnedTick
  sourceId
  evidenceKind: direct | sensor | report | inference
  certainty: confirmed | reported | suspected
  supersedesFactId?

“Confirmed” describes the observation at that time; it does not grant permanent truth. A door observed open can subsequently close.

Keep the fact catalog small and typed: hazard, occupancy, machine symptom, diagnosis, resource location, obstruction, casualty condition, order, and task claim/status.

13.2 Direct observation

Characters observe visible nearby people, relevant objects, smoke, fire, obstructed doors, and readable equipment. Define sensor ranges and occlusion in data. Directly experienced injury and breathing distress are personal observations.

A wall or closed opaque door blocks ordinary visual observation. Sound can reveal a coarse incident without revealing its exact cause: “explosion aft” need not imply confirmed fire and breach.

13.3 Reports

Reports have source facts, sender, intended recipients or channel, created tick, delivery tick, and delivery requirements. Preserve the original observation timestamp through relays.

Working intercom and terminals provide efficient normal information flow. Direct speech requires proximity and a usable communication capability. Reports may fail, queue, or become stale when connectivity fails.

Do not retroactively deliver a failed report at its original timestamp after repairs. A queued report arrives later with its old observation time visible; a new sensor reading is a new fact.

13.4 Work discovery

An actor acquires a task candidate from an observed problem, a received work request, an understood order, or a routine duty. The kernel may maintain a global registry for identity and diagnostics, but planners cannot enumerate all hidden tasks.

Routine inspections and investigation tasks are important. A crew member can investigate an observed temperature alarm without already knowing the failed component.

Do not generate an investigation assignment solely because an undiscovered fault exists. There must be a known symptom, a schedule, or another valid reason to inspect.

13.5 Knowledge about navigation and resources

Crew normally know the authored ship schematic, their training, and basic roster information. Dynamic state and resource locations are learned and updated. Roster availability can be stale during communication failure.

Planning estimates should use those known states. Physical validation reveals discrepancies when encountered.

13.6 Captain information

Expose a captain AgentView using the same knowledge rules as other actors. If incapacitated, an external command-authority service can switch perspective to the first officer. This switch does not grant the first officer the captain’s private observations automatically.

Succession after death is external to the work scheduler, as specified in the GDD. The simulation can validate a proposed successor and change command-role state, but should not invent a fixed election or succession table here.

14. Tasks, actions, claims, and interruption

14.1 Three layers of work

• Problem: A durable condition requiring attention, such as a diagnosed pump fault or wounded person.
• Task: A desired change or service, such as repair the pump, stabilize a wound, or staff docking control.
• Action: One executable step, such as pick up a kit, walk to a position, apply a bandage, or install a component.

This separation prevents duplicate task generation and allows a task to survive worker turnover.

14.2 Task schema

Task
  id, problemId?, type, targetId or locationRef
  createdTick, revision
  status: pending | claimed | active | blocked | completed | cancelled
  requiredSkills, qualifications, capacities
  requiredTools, consumables
  workerSlots, interactionPositions
  dependencyIds[]
  progressRef
  blockageReason?, retryAfterTick?
  claimState
  completionPredicate

Urgency is evaluated from the evaluating actor’s known situation and current policy. World truth can maintain an omniscient diagnostic urgency, but it must not be supplied directly to the planner.

Task identity is stable for a target/problem/revision. Repeated reports do not create twenty independent repair jobs for one fault. New damage can revise the problem and invalidate incompatible work.

14.3 Action contract

Every action definition declares:

• Preconditions and required knowledge.
• Actual execution checks.
• Required interaction positions and resources.
• Duration or work rate.
• Resource commit points.
• Progress ownership.
• Interruptibility and safe interruption behavior.
• Completion effects and observations.
• Failure reasons and retry policy.

An action is a bounded state machine, not an unbounded script or arbitrary generated code. Action transitions and effects occur through the kernel.

14.4 Progress ownership

Physical repair progress belongs to the damaged target/component. Wound treatment belongs to the wound. A carried item’s transfer state belongs to actual ownership. Personal route progress belongs to the actor.

Example repair recipe:

Observe symptom
→ reach diagnostic position
→ diagnose fault
→ acquire suitable tool and component
→ reach repair position
→ make equipment safe if required
→ remove damaged component
→ install replacement
→ test operation

Removing a component and installing a replacement are distinct committed physical changes. An interruption after removal leaves the machine with an empty slot. A replacement carried by the first worker does not become available to the second worker without transfer or pickup.

Generic patching may use cumulative work; component replacement may use discrete stages. Do not force every job into one generic progress bar if that loses important physical state.

14.5 Claims and reservations

Use task claims to coordinate intent and resource/position reservations to prevent conflicting mutations. Claims have an owner, expiry tick, and renewal conditions. An incapacitated or unreachable worker must not retain a claim forever.

Task claims can be announced over available channels. Claim knowledge is not automatically shared across disconnected communications domains.

Bookkeeping locks are not observations. If an actor does not know another worker claimed a task, the planner must not acquire remote facts through a detailed lock-failure response. It can continue toward the target or wait according to known information until a report or local observation reveals the conflict. Exclusive physical interaction is enforced when the actor reaches the target.

Resource reservations must validate quantities and known candidates but do not teleport supplies or reveal their new locations. Expire abandoned reservations deterministically. Use leases for temporary claims and explicit ownership for items already picked up.

14.6 Interruptions

Interrupt immediately for incapacity, invalid physical prerequisites, directly sensed severe danger, or a newly known materially more urgent task.

For equal-class alternatives, prefer finishing the current useful phase. Use switching hysteresis and a short reconsideration cooldown. A nearby alternative that saves a fraction of a second should not cause constant abandonment.

Action definitions determine what can stop safely. Walking can stop along its current segment without teleportation. A committed inventory transfer remains committed. Some repair phases can require a brief safe shutdown sequence unless incapacitation prevents it.

14.7 Blockages and dependencies

Record structured blockage reasons: unknown diagnosis, missing tool, inaccessible supply, unsafe known atmosphere, unreachable target, insufficient competency, occupied position, or unavailable power.

Retry when relevant information changes or after a bounded backoff. Do not retry a failed pickup every tick.

Tasks can generate known prerequisite requests, such as bring a patch kit, restore a breaker, or clear access. Ensure task dependencies are acyclic. Detect and report a cycle rather than deadlocking silently.

Some dependencies are genuine physical dilemmas: the life-support machine cannot be repaired safely without atmosphere or protective equipment. The scheduler should expose that limitation, not invent a hidden universal solution.

15. Autonomous task selection

15.1 Baseline approach

Implement a modest deterministic selector before considering optimization or learned behavior. The selector works from each actor’s knowledge and current state. It need not find a globally optimal assignment.

For each due actor:

1. Handle directly sensed immediate danger and invalid current actions.
2. Enumerate known duties, problems, orders, and personal need activities.
3. Filter by intrinsic capabilities, qualifications, known prerequisites, and known risk policy.
4. Assign an urgency class and any known deadline.
5. Compare feasible candidates using response time, useful completion time, skill, current commitment, and substitute availability known through roster/report state.
6. Apply commitment/switching rules and claim the selected work as appropriate.
7. Produce the next bounded action.

Ordinary evaluation order must be fair: rotate actor order or use a stable event-based priority that does not permanently privilege the lowest ID. Persist the fairness state.

15.2 Urgency classes

|Class              |Meaning                                                          |Examples                                                                         |
|-------------------|-----------------------------------------------------------------|---------------------------------------------------------------------------------|
|Immediate survival |A known person or essential survival function is at imminent risk|Rapid bleeding, evacuation from smoke, atmosphere loss threatening occupied space|
|Containment        |Prevent a developing hazard from reaching critical severity      |Small spreading fire, isolate a short, emergency patch                           |
|Essential operation|Keep the current operation safe and viable                       |Docking control, required cooling service, urgent rest replacement               |
|Routine obligation |Complete useful scheduled or requested work                      |Cargo, cooking, inspection, maintenance, cleaning                                |
|Voluntary activity |Improve comfort or relationships when obligations permit         |Conversation, recreation, optional tidying                                       |

These are starting classes, not rigid task-type labels. A coolant fault can move from routine to immediate survival as observed heat rises. Personal needs can move into essential or survival classes when genuinely severe.

Age routine obligations within their class so cleaning and replenishment do not remain ignored forever. Age alone must not promote arbitrary housekeeping above a known life-threatening emergency.

15.3 Within-class comparison

Prefer the candidate most likely to achieve useful intervention in time. Estimates include travel, acquiring equipment, and work—not just walking distance.

For deadlines, compare estimated intervention time against the known remaining window. Estimates may be coarse and wrong; characters are not omniscient.

Preserve scarce expertise when practical using the roster and last reported qualifications/availability known to the actor. Do not inspect every remote actor’s hidden true injury state to count substitutes.

Keep the ranking explainable. Use explicit ordered criteria and a small number of documented tie-breakers before introducing a large weighted utility score. Where weights are needed, expose them in configuration and log their contributions.

Use the following initial selection algorithm so the first implementation does not have to invent a scoring framework:

1. Take the highest urgency class containing a currently executable, useful candidate. A task blocked by a proven unmet prerequisite can remain visible but is not selected as if work could begin; consider its known prerequisite tasks instead.
2. For candidates with a known hard deadline, calculate latestUsefulStart = deadline - estimatedInterventionDuration. A candidate that is known to be too late for its specified intervention is marked deadline-blocked; alternative forms of useful aid may still be separate candidates. Prefer the earliest latest-useful-start. Candidates without deadlines follow deadline-bearing candidates of the same class.
3. Preserve a valid current phase if the commitment rule applies and keeping it does not knowingly miss a higher-priority deadline. This comparison includes remaining phase time, rather than always estimating a restart from scratch.
4. Apply a small scarce-skill opportunity cost when a suitable substitute is known and the actor is the only known qualified person for another pending task of the same or higher urgency. Waive this cost when waiting for the substitute would knowingly miss the chosen task’s deadline.
5. Prefer lower estimated time to useful intervention. Quantize estimates to a configurable small bucket, initially one second, so insignificant differences do not dominate.
6. Within an equivalent time bucket, prefer adequate higher skill, then older task age, then stable task ID.

Unknown deadlines are not treated as precise infinite safety. Hazard observations can assign a conservative urgency/window category. Record the estimate and its source. This initial algorithm is a hypothesis to test against scenarios D, E, and P, not a claim that decentralized scheduling always finds the best assignment.

15.4 Local first response and specialist handoff

A nearby qualified person should begin useful basic aid or containment when waiting for a specialist would worsen the situation. This does not grant advanced qualifications.

Different task phases can have different skill requirements. A deckhand can stabilize a casualty; the medic can subsequently take over more effective treatment. A crew member can bring a tool; the engineer performs the repair.

Handoff is an explicit physical and informational transition. Preserve supplies, progress, patient location, and the outgoing person’s ability to resume other work.

15.5 Operating commitments

Leaving a station has a known cost. Incorporate that cost within the same task system. Do not categorically forbid the pilot from rescuing somebody, and do not ignore the fact that docking control will be vacant.

Ordinary replacement is arranged before departure when time allows. During severe emergencies, an operating capability can be lost as a consequence of a defensible response.

15.6 Eligibility and failure

Distinguish incapable, unwilling under current policy, and blocked by resources. An injured specialist may retain knowledge while lacking manipulation capacity. A substitute may perform early stages but need help at a later stage.

The selector should usually perform the obvious useful action in straightforward fixtures. It need not resolve impossible cases perfectly. An impossible case must still advance time, preserve physical consequences, and report why useful work is unavailable.

15.7 Debug trace

For each assignment or meaningful rejection, capture a compact trace:

actor; known candidates; urgency/deadline;
eligibility failures; travel/acquisition/work estimates;
scarce-skill consideration; commitment rule;
selected task; next action; information sources

Retain recent traces in a bounded diagnostic buffer. Avoid logging every unchanged selection every tick.

16. Safety, policy, and high-level orders

Autonomy needs operating policy rather than an exhaustive list of player assignments. Policy describes acceptable known risk, priorities among essential systems, and when an action needs higher authority.

Routine firefighting, first aid, opening an ordinary door, and repair are authorized normal actions. Deliberately venting a compartment known to contain an unsuited person is a different policy case.

Default: Crew do not autonomously perform an action that knowingly sacrifices a person solely to protect equipment. They can issue a structured PolicyDecisionNeeded event containing known facts and executable alternatives. The external decision service determines presentation and authorization.

Uncertain occupancy must remain uncertain. A policy may require a sensor check or investigation before venting; the implementation must not secretly inspect all compartment occupants and reveal the result through a policy veto.

The simulation does not freeze itself merely because it emits a request. The host pauses immediately when appropriate under the GDD. In a headless test, the host can apply a deterministic preconfigured decision policy. This is the route to eventual zero-player operation, not permission to add an LLM to task selection.

An order states a goal, limit, or authorized operating change: restore life support, isolate aft, attempt docking, or disengage later in combat. Crew translate it into tasks using their knowledge and physical capabilities. An order can fail to arrive or become impossible to carry out.

Authorization does not guarantee success, alter physical costs, or author casualties. Commands remain subject to execution checks and actual world conditions.

17. Travel, docking, and the commercial shell

17.1 Travel states

Use an exterior state machine rather than full orbital physics:

docked → preparingDeparture → undocking → departing
       → transit → approaching → docking → docked

Each stage declares required ship capability, staffing where relevant, duration/work, and interruption conditions. A short healthy trip can take roughly a minute, as the GDD proposes. Cargo loading and significant events can extend the operation.

Route progress is authoritative. Propulsion loss stops or slows relevant progress. Repair resumes the remaining journey; it does not reset or instantly complete it. Distinguish drifting/stranded from destroyed.

17.2 Docking and ramps

Docking establishes valid external custody/access endpoints. Personnel and cargo ramps are physical interfaces. Their opening and use depend on docking state, atmosphere assumptions, power/manual operation, and obstruction.

Do not transfer cargo through a closed ramp merely because a contract was accepted. Loading creates hauling tasks from known manifests and available objects.

17.3 Jobs and money

Commercial jobs record issuer, destination, manifest/passengers, payment conditions, accepted state, and delivered state. A delivery checks actual custody and required conditions rather than completion of an animation.

Money changes through uniquely identified committed transactions. A repeated completion event must not pay twice. Failed, partial, or late delivery can be handled through simple explicit contract rules.

Port services may remain abstract timed operations, but transferred supplies and replacement components become actual inventory. Do not restore machinery and charge for a component while also leaving an identical free component in stores.

The simulation can run a simple deterministic job source for testing. Generating narrative employers and selecting adventures is outside this document.

18. Combat extension contracts

Combat is deferred. Do not build a parallel health or interior damage model in anticipation of it.

18.1 Boarding

Hostile characters use the same bodies, movement, knowledge, inventories, and actions. Add hostile intentions, weapons, cover evaluation, aim/fire/reload actions, and combat-specific collision rules.

Initial later tactics should be understandable: occupy cover, engage an observed target, guard a passage, retreat, or rescue when feasible. Deep squad optimization is not required by this specification.

Walls and doors affect line of sight and shots. A miss follows a defined trajectory/impact rule and can strike geometry or equipment. Armor is attached equipment with protection coverage. A hit resolves protection, then bodily damage. Aim time and shooter capacities affect outcomes.

Combat action selection remains autonomous. Captain directives constrain goals rather than specifying every tile and shot.

18.2 Ship combat

External combat determines attack delivery and impact location. Impacts enter the existing local damage system. Resulting fires, breaches, power loss, wounds, and damage-control work use ordinary rules.

Enemy vessels can use the same interior state without initially rendering it. Their casualties and equipment damage must remain canonical and persistent; sensors determine what the captain learns.

Do not introduce a required external combat grid size, targeting system, or fleet simulation in the first build. Those are separate design work.

19. Kernel API and event contracts

19.1 Public operations

createWorld(authoredScenario, seed, config) -> World
advance(world, tickCount) -> committedEvents[]
enqueueCommand(world, command, targetTick) -> accepted | rejected(reason)
getAgentView(world, actorId) -> AgentView
getDebugSnapshot(world) -> WorldSnapshot
serialize(world) -> SavedWorld
restore(savedWorld) -> World

All physical mutation passes through commands or systems with explicit ownership of the affected fields. Rendering and narration do not set arbitrary machine/body fields directly.

19.2 Commands

Commands have an ID, source, target tick, stable sequence, payload, and validation result. Typical commands include accept a contract, set course, authorize an operating policy action, transfer an object, and appoint a validated living command actor.

Scenario setup can spawn entities and faults before execution. Controlled external event injection can introduce an actual fault or impact at a specified future tick, with an audit source. Do not expose a general runtime command to set a named person’s blood reserve to zero or rewrite prior state for a desired story outcome.

Acceleration of a latent failure, where later authorized by the Narrator contract, is a recorded change to failure scheduling or an explicit fault event. It is not an invisible rewrite of history.

Commands are idempotent by ID where retries are possible. Invalid commands produce structured reasons and no partial mutation.

19.3 Events

SimulationEvent
  id, tick, sequence, type
  subjectIds[], locationRef?
  causeIds[]
  source
  payload

Useful events include entered compartment, task selected, action failed, fault observed, fault diagnosed, machine derated, door jammed, breach changed, wound created, treatment applied, actor incapacitated, actor died, report delivered, cargo transferred, contract completed, and policy decision needed.

Canonical events describe committed truth. Actor-facing reports describe acquired knowledge. Do not conflate them or label a hidden death as globally “discovered.”

Emit meaningful transitions rather than every fractional movement update. Event consumers must not change outcomes by being slow or disconnected. Simulation events can be buffered and consumed after the step.

19.4 Physical invariants

• Every persistent physical object has one valid location/owner.
• Containment is acyclic.
• Stack counts, gas quantities, blood reserve, and battery energy remain bounded and nonnegative.
• Atmosphere transport conserves quantities except recorded sources/sinks/conversions.
• No actor walks through a blocking physical boundary.
• No completed action consumes the same item twice.
• Exclusive work positions and patient positions do not have conflicting active ownership.
• Completed or cancelled claims release their temporary reservations.
• Incapacitated actors do not continue accumulating active repair work.
• Task dependencies have no cycles.
• Knowledge contains observation/report provenance and does not auto-refresh from truth.
• An already committed payment cannot execute again.
• Paused worlds do not advance.

20. Persistence, replay, and lifecycle

20.1 Save content

Save authoritative entities, tick, configuration/version identifiers, random stream state, queued commands/impacts, pending reports, task revisions, claims and expirations, active action stages, fractional route progress, body state, inventories, needs, knowledge, schedules, fairness state, travel, contracts, money, and relevant social state.

Persist the effective configuration values as well as their version/hash. Content definitions referenced by IDs must be available in the saved version or carried in a compatible definition snapshot. Restore must fail clearly on an unsupported definition/schema version rather than silently regenerate entities, random traits, or balancing constants.

Derived caches can be rebuilt from saved authoritative data. Do not discard stale beliefs or pending messages during restore; they are part of the simulation, not merely caches.

Save only at a committed tick boundary initially. Host requests can wait for the current step to finish.

20.2 Replay

Persist initial scenario/configuration identity, seed, and ordered external inputs. A diagnostic replay reproduces the same run for the same implementation version. A state hash can detect divergence.

A structured event history is useful for diagnosis and continuity, but full event sourcing is not mandatory. Snapshots plus ordered inputs are sufficient for initial reproducibility.

Bound high-frequency diagnostic history. Preserve significant committed events according to the host’s continuity needs; do not assume the full tick trace is the game’s permanent canon.

20.3 Death and continuity

Captain death does not automatically end the simulation. Surviving actors and machinery continue. Emit a command-authority vacancy event and permit an external validated successor assignment.

One injured survivor can remain simulated. Being stranded is not equivalent to death. The kernel exposes facts rather than inventing a narrative resolution.

For initial terminal-state handling, an explicit scenario rule can stop a run when no living continuity remains. Edge cases involving escape pods, distant survivors, and abandoned ships remain product questions. Do not build a large rescue/continuity system to solve them now.

21. Debugging and performance

21.1 Required inspection

Provide diagnostic access to:

• Current tasks/actions and why each actor selected them.
• Blocked tasks, missing prerequisites, and retry times.
• Claims, resource reservations, and lease age.
• Truth versus each actor’s relevant knowledge.
• Gas, oxygen partial pressure, heat, and transport source/sink accounting.
• Power domains, allocations, battery changes, and active faults.
• Body capacities, active wounds, exposure, and treatment.
• Route state, unexpected obstructions, and congestion waits.
• Per-system timing and candidate counts.

These are implementing-agent tools; they do not prescribe the product interface.

21.2 Performance posture

The first scene is small: one authored deck and 6–8 people. Optimize obvious repeated work without building a distributed architecture or optimizing a hypothetical galaxy.

Cache geometry and connectivity; stagger ordinary planning; use typed fact catalogs; avoid all-pairs full pathfinding every tick. Keep physics at a stable cadence.

Record reference hardware and scenario when reporting performance. An initial engineering target is a typical step well below the 50 ms tick interval, preferably a few milliseconds on the reference development machine. Measure rather than claim this target is already achieved.

After correctness at 6–8 crew, run a synthetic 20-crew interior benchmark. Performance targets must not justify skipped wounds, omniscient planning, or changing timestep size.

22. Acceptance scenarios

Acceptance scenarios are deterministic authored fixtures with explicit resources, competency, topology, clocks, and policy. Test physical and behavioral outcomes, not exact implementation method names.

For behavioral tests, avoid asserting one exact assignment when several are reasonable. Assert useful intervention, no impossible action, understandable reasons, and the relevant deadline/outcome. Use fixed seeds, then a modest seed sweep for scenarios whose randomness matters.

A. Ordinary freighter operation

Setup: Healthy ship, 6–8 crew with overlapping basic qualifications, supplies, shifts, one accepted freight job, three reachable ports.

Expected: Crew load through the cargo interface, staff required departure/docking operations, travel, unload, and receive payment exactly once. They also satisfy needs and perform due maintenance. No player pawn assignments or model calls are required.

Failure signals: Routine duties remain permanently unfilled; everybody chooses recreation; supplies are consumed without pickup; a required station is vacant without consequence; delivery occurs before custody changes.

B. Smooth movement is physical

Setup: Known route with a door and a marked halfway observation point.

Expected: Actor position progresses fractionally; arrival takes configured travel time; an observation or local hazard affects the actor at the actual intermediate position. Running with different render frame counts yields the same state.

C. Injured specialist and task takeover

Setup: A repair has physically committed partial progress. The repairer becomes incapacitated; a qualified substitute and needed resources are reachable.

Expected: The first actor stops accumulating work. Claims expire/release. The substitute continues from the actual component/patch state and retrieves supplies from their real location. No duplicated parts and no arbitrary progress reset.

D. Nearby aid, then medic

Setup: Bleeding casualty in a safe area, basic-aid crew nearby, medic farther away, suitable kit accessible.

Expected: Useful initial aid starts before waiting for the distant specialist when the initial aid can be delivered sooner. The medic subsequently takes over if beneficial. Wound/blood changes reflect actual treatment timing and supplies.

E. Preserve scarce expertise

Setup: Diagnosed life-support repair requiring one specialist; concurrent casualty carrying that several qualified crew can perform; working communications and known roster.

Expected: Ordinary selections favor the specialist’s repair and a substitute’s carrying when both can be completed usefully. No omniscient reading of unreported remote availability is needed.

F. Hidden fault and failed report

Setup: An aft fault produces an observable local symptom. Sensor/intercom connectivity to the bridge is broken.

Expected: Local witnesses can investigate and respond. The bridge and captain do not immediately acquire the diagnosis. A person or restored channel can later deliver a report with valid provenance and timestamps.

G. Stale location and obstruction

Setup: A known medical kit is moved without a report; a previously known route becomes blocked outside the actor’s observation range.

Expected: Planning can initially be wrong. Local execution discovers the missing kit/obstruction, revises knowledge, and backs off or replans. The actor never receives the kit remotely or routes around hidden damage using truth.

H. Gas conservation

Setup: Several sealed rooms, multiple simultaneous openings, no life-support sources or combustion, and other thermal exchanges disabled for the transport-only fixture. Then introduce one exterior breach.

Expected: Interior transfer conserves species and energy within numerical tolerance. Exterior loss equals the recorded sink. Values remain finite and nonnegative even when several openings drain one donor.

I. Containment versus repair

Setup: Small local fire near a serviceable machine, reachable extinguisher, nonzero combustible stock.

Expected: Firefighting can stop spread without restoring damaged equipment. A subsequent repair remains necessary. Oxygen starvation suppresses fire without instantly restoring temperature or integrity.

J. Cooling cascade

Setup: Pump fault or coolant leak under engine load; configured thresholds and an accessible repair path.

Expected: Cooling decreases, temperature increases, the engine derates/shuts down according to rules, and route progress changes. Repair restores relevant capability only after actual work. Restart hysteresis prevents rapid on/off oscillation.

K. Supplies behind failed door

Setup: Required supply behind a jammed pressure door; an alternate valid prerequisite route or repair is available in one variant, unavailable in another.

Expected: Crew undertake known prerequisite work when feasible. In the impossible variant, report blockage and preserve consequences rather than teleporting resources or endlessly retrying.

L. Shift coverage and fatigue

Setup: Required station, rested replacement, tired current operator, later emergency that interrupts sleep.

Expected: Ordinary coverage hands over physically. Emergency work can interrupt rest. Accumulated fatigue changes later behavior/performance. Captain sleep does not stop ordinary operation.

M. Known occupied venting

Setup: Dangerous fire; venting is feasible; crew have valid knowledge that an unsuited person remains in the affected compartment.

Expected: Default autonomy requests authority rather than silently sacrificing the person. If a test host authorizes venting, physical door/gas/exposure rules determine the outcome. Authorization does not directly set the occupant dead.

N. Limb injury and ongoing ability

Setup: Equivalent workers, one with impaired manipulation and another with impaired movement.

Expected: The first performs manipulation-dependent work more slowly or cannot perform a required phase; the second arrives more slowly. Qualification/knowledge are retained. Missing-part rules remain distinct from temporary pain or damage.

O. Save/load during active work

Setup: Save at a committed tick with a partly traversed route, partial repair, pending report, claim leases, and an active hazard.

Expected: Restored continuation matches uninterrupted continuation under the same inputs and version. No repeated consumable use, payment, fresh randomization, belief reset, or full-tile movement snap.

P. Impossible emergency

Setup: Deliberately insufficient resources/time or inaccessible casualty.

Expected: Crew attempt defensible known interventions, report limitations, and continue advancing the world. Harm follows exposure and delay. No guaranteed rescue, infinite decision loop, or silent frozen job.

Q. Captain death with survivors

Setup: Captain dies; other crew survive.

Expected: Routine work continues, the body and possessions remain, and succession is exposed as an external authority change. The kernel does not declare game-over solely from the captain’s death.

R. Determinism and autonomy endurance

Setup: Repeat a seeded run with identical scheduled inputs; run another with a headless host supplying deterministic high-level decision responses.

Expected: Matching authoritative state for repeated inputs. At least 30 simulated minutes of ordinary operation plus several configured incidents without planner exceptions, leaked claims, invalid ownership, or required pawn micromanagement.

Report qualitative behavior alongside checks: the same two workers should not thrash indefinitely while available crew never act. A seed sweep can reveal systematic failure without treating one authored optimal rescue as proof of general intelligence.

23. Suggested implementation milestones

Milestone 1 — Physical kernel

Implement fixed time, IDs, geometry, located objects, movement, doors, basic commands/events, and save/load. Establish movement, ownership, pause, and deterministic continuation checks.

Milestone 2 — Routine autonomous work

Implement task/action contracts, physical hauling, claims, blocked reasons, basic needs, shifts, station work, and ordinary travel/cargo operations. Use known tasks rather than a hidden omniscient work list.

Milestone 3 — Knowledge and equipment

Implement typed observations/reports, failed communication, diagnostics, repair recipes, power domains, and real resource acquisition. Demonstrate stale-information behavior.

Milestone 4 — Environmental consequences

Implement cooling, heat, compartment gas, doors as gas connections, smoke, local fire, breaches, and patches. Validate conservation and a causal machinery cascade.

Milestone 5 — Bodies and damage control

Implement wounds, capacities, exposure, incapacitation, basic aid, casualty carrying, treatment, and recovery. Tune task selection against the emergency fixtures and handoff cases.

Milestone 6 — Life between incidents

Add modest procedural traits, social interactions, mood/relationships, coarse memories, and routine maintenance variety. Run the complete commercial shell with quiet stretches.

Milestone 7 — Handoff-ready vertical slice

Complete the acceptance fixtures, replay/save checks, endurance run, diagnostics, and documented tuning. Assess the GDD’s simulation hypothesis at 1×. Combat and Narrator implementation remain separate milestones.

Do not defer imperfect information until after all emergency behavior is implemented. Its access boundary should exist in Milestone 2 and be exercised concretely in Milestone 3.

24. Initial tuning sheet

These are starting ranges for experimentation, not performance claims or realistic human/spacecraft parameters. Centralize them in versioned configuration.

|Parameter                   |Proposed starting point                                                         |What to evaluate                                            |
|----------------------------|--------------------------------------------------------------------------------|------------------------------------------------------------|
|Fixed tick                  |20 Hz                                                                           |Stable hazards and movement at acceptable cost              |
|Healthy walking             |Approximately 1.5–2.5 tiles/second                                              |Readable movement; cross-ship response takes meaningful time|
|Normal powered door         |Approximately 0.5–1 second                                                      |Doors matter without dominating routine travel              |
|Routine task reconsideration|0.5 seconds                                                                     |Responsive selection without excessive churn                |
|Same-class switch cooldown  |Approximately 2 seconds                                                         |Commitment versus missed urgent opportunities               |
|Temporary claim lease       |Approximately 3–5 seconds, renewed while progressing                            |Prompt takeover without stealing active work                |
|Basic inspection            |Approximately 3–8 seconds                                                       |Visible useful work and timely symptom discovery            |
|Ordinary repair phase       |Approximately 5–20 seconds                                                      |Multiple workers/interruptions can matter                   |
|Basic initial aid           |Approximately 2–5 seconds after acquiring supplies                              |Nearby response can materially help                         |
|Meal action                 |Approximately 10–20 seconds                                                     |Eating is visible but not a major operational stall         |
|Need cadence                |Tune to observable crew life across 10–30-minute sessions                       |Routine needs neither absent nor constant emergencies       |
|Rest action                 |Tune separately from fatigue accrual; initially tens of seconds to a few minutes|Shifts and interrupted rest create consequences             |
|Wound recovery              |Multiple voyages for meaningful wounds                                          |Treatment and injury remain consequential                   |
|Healthy short voyage        |Approximately 60 seconds excluding substantial loading/events                   |Ordinary loop works at 1×                                   |
|Initial endurance fixture   |At least 30 simulated minutes                                                   |Leaks, starvation, repeated faults, routine plausibility    |

Never use arbitrary timed failures to guarantee casualties simply because a repair duration was selected. Tune hazard rates and intervention rates together using explicit fixtures.

25. Decisions to evaluate experimentally

|Question                                         |Baseline                                                                 |Evidence that would justify changing it                                         |
|-------------------------------------------------|-------------------------------------------------------------------------|--------------------------------------------------------------------------------|
|Per-actor selection versus coordinated allocation|Per-actor selection with communicated claims and known roster information|Persistent avoidable conflicts or waste despite simple handoff rules            |
|Urgency/ranking                                  |Explicit urgency classes and explainable comparisons                     |Common unreasonable choices not addressed by eligibility/deadline rules         |
|Compartment mixing                               |One well-mixed region per authored compartment                           |Large-room hazards conceal meaningful distance/access effects                   |
|Friendly congestion                              |Simple passing/yielding and exclusive work positions                     |Frequent unnatural overlap or corridor deadlock                                 |
|Needs and shifts                                 |Small need set, authored shifts with automatic coverage                  |Quiet operation lacks motion or emergencies permanently destroy routine         |
|Work persistence                                 |Target-owned physical progress and explicit stages                       |Excess bookkeeping without useful physical consequences                         |
|Injury granularity                               |Conservative body tree with capacities                                   |Too few distinct medical/operational outcomes, or excessive treatment complexity|
|Power/cooling detail                             |Connected domains and small loops                                        |Failure states feel arbitrary or disconnected from physical layout              |
|Knowledge complexity                             |Small typed fact catalog with provenance/time                            |Cannot express a required information failure without hidden truth leaks        |
|1× pacing                                        |Rates tuned on a single consistent clock                                 |Ordinary activity is tedious or happens too quickly to follow                   |

Do not change these by adding hidden omniscience, model inference, or mandatory player assignments. Improve the causal rules and observe the results.

26. Implementing-agent handoff

Build the specified autonomous freighter simulation before broadening content. Preserve the inherited constraints. Use the defaults as a starting implementation and record any deviations with reasons.

The implementation handoff should include:

1. A runnable headless scenario and a minimal means of observing the same authoritative state.
2. Source and configuration with clear world/knowledge/planning/execution boundaries.
3. Acceptance fixtures and their actual results, including unresolved failures.
4. A save/load example and reproducible incident replay.
5. Task-selection traces and environmental/resource accounting.
6. A short assessment of ordinary 1× operation and the task-selection hypotheses.
7. A list of deferred systems, remaining product questions, and material specification deviations.

The first proof is one believable operating ship. Its crew should normally handle straightforward work, compensate when someone is unavailable, and sometimes fail because the physical situation is genuinely difficult. Every success and failure should be explainable from state, knowledge, timing, and action.