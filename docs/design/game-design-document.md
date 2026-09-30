Crew

Game Design Document — Draft v0.1

1. Concept

Crew is a top-down science-fiction simulation game about a small crew living and working aboard an independent starship.

The simulation is closely inspired by the emergent character and colony simulation of RimWorld, the physical starship systems and crises of FTL, and the independent-trader/adventure fantasy of games such as Escape Velocity.

The player is the captain of the ship, but does not directly control the captain or other crew members. The captain exists physically in the simulated world alongside everyone else: eating, sleeping, socializing, working, becoming injured, and potentially dying.

The crew autonomously operates the ship.

The player’s primary interaction is making captain-level decisions when situations arise with multiple materially defensible responses.

A routine fire is handled automatically.

A fire consuming the rear of the ship, where venting the compartment would save the vessel but kill a trapped crew member, becomes a player decision.

The game combines this autonomous simulation with an AI Narrator capable of recognizing stories in the simulation, creating new situations and characters, maintaining continuity with prior events, and occasionally applying pressure to the simulation in order to produce coherent episodic adventures.

The intended experience is not constant crisis.

Sometimes an adventure involves pirates, murder, betrayal, mechanical catastrophe, or desperate survival.

Sometimes the crew picks up a load of machine parts, delivers it safely, gets paid, and finally has enough quiet time to fix a troublesome hydrospanner.

Both are valid stories.

⸻

2. Design Pillars

2.1 The Crew Runs the Ship

The player does not micromanage pawns.

Crew members determine what work needs doing, move through the physical ship, use equipment, satisfy their needs, socialize, repair machinery, haul cargo, respond to emergencies, and carry out the captain’s decisions.

There is no normal interface for selecting a crew member and issuing an instruction such as:

Repair this generator.

The simulation should generally be capable of running indefinitely without player input.

A zero-player mode should eventually be possible, allowing the player to simply watch the captain and crew travel through the galaxy and make their own decisions.

⸻

2.2 The Player Makes Decisions, Not Assignments

Player interaction centers on binary captain decisions.

A decision should generally interrupt the player only when more than one potentially reasonable course of action exists.

Examples:

Engineering believes the engine can survive another six hours, but recommends shutting it down immediately. Do we risk reaching port on schedule?

A disabled freighter is broadcasting life signs. Do we alter course to investigate?

Fire has consumed the aft compartments. Venting them will probably save the ship, but Nate is still trapped there.

An official-looking courier has arrived at the docking ramp and insists that their sealed cargo cannot be inspected.

Every player decision is binary: left or right.

More complicated decisions should be represented as a sequence or tree of binary decisions rather than a larger option menu.

The player cannot defer a presented decision, although the decision screen can remain open while the player inspects the ship, crew, records, or other available information.

⸻

2.3 Simulation Creates Consequences

The simulation owns physical reality.

If a compartment is depressurized, it is depressurized.

If an object exists, it has a location.

If someone is injured, the injury exists as simulation state.

If a passenger is secretly smuggling a diamond, the diamond must actually exist in the simulation once that fact becomes canon. It cannot materialize retroactively when pirates later demand it.

This creates an important principle:

Narrative setup may be authored. Outcomes should emerge from simulation.

The Narrator can decide that a ship will be ambushed after departure.

It cannot simply decide that the engineer is killed during the ambush.

Once the encounter begins, simulated weapons, systems, wounds, behavior, and circumstances determine what actually happens.

⸻

2.4 The Ship Is a Physical Place

The ship is not a collection of abstract stat bars.

Crew physically move between compartments. Cargo exists in cargo spaces. Food is stored somewhere. Medical supplies must be accessible. Machines occupy locations and can fail individually.

Topology matters.

A failed pressure door may isolate engineering.

A fire can block the route to a coolant pump.

A medical kit can become inaccessible because the infirmary is burning.

A crew member may know about an injured coworker nearby without knowing that a separate hull breach exists two compartments away.

The ship should feel like a place in which stories occur.

⸻

2.5 People Matter

The simulation centers on a small enough crew that individual characters remain recognizable.

The expected practical ceiling is approximately 20 crew, with the initial prototype using roughly 6–8.

Characters have skills, physical needs, personalities, preferences, relationships, moods, and coarse social memories.

Personality should primarily be generated by normal procedural systems rather than invented wholesale by an LLM. LLMs can interpret and express personality, but the underlying diversity should come from actual randomized state to avoid converging on predictable archetypes.

Important experiences may alter soft state.

For example:

* Nate’s relationship with the captain decreases.
* Nate now feels betrayed by the captain.
* Chen becomes more trusting of Ortega.
* A crew member becomes fearful of EVA operations.

The game does not require an extremely granular structured-memory system for every incident.

⸻

3. The Captain

The player inhabits the role of the ship’s captain.

The captain is also an autonomous simulated character.

The player does not directly tell the captain when to eat, sleep, walk somewhere, socialize, or perform routine duties.

The captain can:

* become tired or hungry;
* form relationships;
* gain skills;
* become injured;
* become unconscious;
* become incapacitated;
* die.

The ship also has a First Officer / First Mate.

This is the only additional formal hierarchy currently required.

The first officer allows routine command decisions to continue when the captain is sleeping and provides a natural acting captain when the captain is incapacitated.

If the captain dies, succession should be handled as part of the narrative rather than through a fixed mechanical succession table. The Narrator can determine how the surviving crew selects or appoints a new captain based on the actual circumstances and characters involved.

The player’s perspective then shifts to the new captain.

⸻

4. Autonomous Work

Crew work is autonomous and should not require a RimWorld-style player-maintained priority spreadsheet.

However, the exact task-selection system is deliberately unresolved.

This is one of the major prototype questions.

Several potentially compatible mechanisms should be explored.

Eligibility

Characters know how to perform some categories of work and not others.

Skills and roles influence which tasks they are capable of performing and how effectively they perform them.

Crew can naturally cross-train through experience.

Task Urgency

Priority may belong primarily to the task, rather than permanently to the worker.

Routine examples:

* move cargo;
* cook meal;
* perform inspection;
* clean compartment.

Urgent examples:

* rescue bleeding crew member;
* restore life support;
* contain fire;
* seal decompression;
* restore electrical power.

A task’s urgency may change dynamically as circumstances change.

Context and Proximity

Crew should not necessarily evaluate every task on the ship globally.

Location matters.

Someone standing beside an injured crewmember may respond before a more medically skilled character several decks away.

This may both improve believability and reduce the need for complex global optimization.

Imperfect Knowledge

A crew member cannot act on a task they do not know exists.

This means task selection interacts with information propagation.

There may not even be a single globally correct task list available to all crew.

Open Question

The final combination of eligibility, urgency, distance, role, skill, current activity, and information availability should be determined experimentally.

The LLM Narrator should not participate in moment-to-moment task selection.

Task scheduling must remain inexpensive, deterministic enough to debug, and capable of running continuously without model inference.

⸻

5. Information Is Simulated

Information propagation is part of the simulation.

Crew know things because they:

* directly observe them;
* receive an intercom announcement;
* see them on a terminal;
* receive an order;
* are told by another person;
* have access to functioning ship sensors.

Under normal circumstances, ship-wide communications and sensors may make information flow extremely efficient.

Damage can disrupt this.

If the intercom in engineering is destroyed, the bridge may no longer know what is happening there.

If sensors fail, the crew may need to physically investigate.

An order may fail to reach its intended recipient.

A crew member may know there was an explosion aft but not know whether there is a fire, decompression, injury, or equipment failure.

These information failures are intended to create interesting situations rather than merely obscure UI.

The player may inspect substantial simulation state when desired, but decisions and generated narration must remain constrained by what the captain could plausibly know.

⸻

6. Ship Simulation

Ships have fixed hulls and fixed basic layouts.

The game is not primarily a construction puzzle.

Players will not build ships tile by tile.

Instead, ships contain individual machines and physical equipment that can potentially be repaired, replaced, moved within reasonable constraints, or upgraded.

Potential simulated systems include:

* power generation;
* electrical distribution;
* batteries;
* propulsion;
* maneuvering systems;
* cooling;
* atmosphere and life support;
* doors and pressure bulkheads;
* communications;
* sensors;
* medical equipment;
* cargo handling;
* galley equipment;
* bunks and living spaces;
* weapons in later versions.

Individual machines may degrade, fail, catch fire, become damaged, lose power, require parts, or produce cascading consequences elsewhere in the ship.

The simulation should be detailed in service of interesting failure modes, not for engineering realism as an end in itself.

The goal is not to build a starship plumbing puzzle.

⸻

7. Physical Resources

Important resources should physically exist.

Examples include:

* food;
* medicine;
* repair parts;
* tools;
* cargo;
* personal possessions;
* fuel or other consumables where useful;
* ammunition if weapons require it;
* contraband;
* plot-relevant objects.

Objects have actual locations.

Crew members haul and use them.

This supports emergent situations without requiring authored rules.

A replacement component may exist but be inaccessible.

Medical supplies may be on the wrong side of a pressure door.

A passenger’s illicit cargo can actually be discovered during unrelated work.

⸻

8. Character Simulation

Characters use a RimWorld-like level of simulation for ordinary biological and social life.

Relevant systems may include:

* hunger;
* fatigue;
* injury;
* pain;
* mood;
* comfort;
* social interaction;
* skills;
* relationships;
* preferences;
* traits;
* fears;
* coarse memories;
* physical health.

The exact set should remain conservative initially.

A system belongs in the game because it produces meaningful behavior or stories, not because humans possess that attribute in reality.

Crew autonomously eat, sleep, work, converse, rest, and socialize.

Conversation can usually be represented at RimWorld-like abstraction.

For example:

Chen joked about the food.

Ortega complained about the docking fee.

Important conversations can be expanded or annotated by the Narrator. Generated dialogue or narrative attached to a conversation should be discoverable afterward by the player rather than disappearing immediately.

⸻

9. Travel

Game time is approximately real-time while the player is observing the ship.

The normal target experience is enjoyable at 1× speed.

Short travel should be compressed enough that routine movement does not become tedious.

For example, a short trip might include:

* undocking;
* departure;
* transit;
* approach;
* docking;

and take approximately a minute if nothing significant occurs.

Long-distance travel can take longer and should contain opportunities for shipboard life, maintenance, relationships, failures, and encounters.

Clever acceleration or temporal shortcuts can compress periods where nothing meaningful is happening without making the ship feel as though it teleports between destinations.

⸻

10. Ports and Off-Ship Space

The initial game does not need a deeply simulated galaxy.

The first version can contain only a small number of ports, perhaps three.

Ports primarily provide:

* job opportunities;
* cargo;
* passengers;
* supplies;
* repairs;
* supporting NPCs;
* narrative contexts.

At minimum, the ship should visually interact with its environment through areas such as:

* docking interface;
* personnel ramp;
* cargo ramp.

Later versions can add small off-ship maps such as:

* station concourses;
* bars;
* remote outposts;
* landing pads;
* derelicts;
* planetary settlements.

Supporting NPCs do not need full pawn simulation while they are elsewhere in the galaxy.

They can exist primarily as structured state and narrative continuity until they physically enter a location where detailed simulation is necessary.

⸻

11. Jobs and Economy

The starting ship will often be an independent small freighter, although starting circumstances should eventually vary between games.

The basic commercial loop is:

Find job → load cargo/passengers → depart → travel → arrive → unload/deliver → receive payment → repeat

“Find job” is especially important because it provides a natural opportunity for the Narrator to introduce the next adventure.

This does not mean every job is presented as a menu.

The Narrator may instead introduce situations such as:

An official courier approaches the captain with sealed documents.

A passenger offers substantially more than the normal fare but refuses to identify their destination until departure.

A station commander asks for emergency transport.

A mundane freight company offers a completely uneventful cargo contract.

Job selection itself may therefore occur through one or more binary captain decisions.

The economy does not initially require deep simulation.

Prices, payments, expenses, and job availability can be generated from rules, randomness, and narrative context.

A simulated interstellar commodities market is not required.

⸻

12. Progression

Progression is primarily emergent rather than technological.

There is no research tree.

The crew are operators, traders, travelers, and survivors—not a research colony reinventing civilization.

Progression comes through:

* money;
* improved equipment;
* larger or more capable crew;
* crew skill development;
* relationships;
* reputation;
* accumulated possessions;
* better opportunities;
* eventually acquiring different ships.

The ship itself is not necessarily the permanent protagonist.

A crew may eventually sell, lose, abandon, or replace its vessel.

⸻

13. Long-Term Motivation

The game does not need a strongly prescribed campaign objective.

An initial long-horizon framing could be retirement.

The captain begins with insufficient resources to retire comfortably and may slowly build wealth over a very long career.

Retirement should be difficult enough that most runs are not simply optimized races toward a reachable victory number.

The more important motivation is:

See what happens to this captain and this crew.

The game produces a persistent history rather than a sequence of disposable missions.

⸻

14. Failure and Continuity

Ship destruction and crew death are serious possibilities.

The game should be dangerous enough that major failures matter.

If the captain dies but the crew survives, the game continues through succession.

If only a tiny number of crew remain, the simulation may continue as long as meaningful play is still possible.

Exact rules for hopeless states do not need to be solved initially.

True game-over likely occurs when there is no meaningful surviving continuity—for example, destruction of the ship and death of its crew.

⸻

15. The Narrator

The Narrator is an AI-assisted procedural showrunner.

It has access to the complete simulation state, including facts unknown to the captain.

It is responsible for:

* recognizing interesting developments;
* maintaining narrative continuity;
* creating opportunities;
* introducing supporting characters;
* creating locations when needed;
* creating cargo and physical plot objects;
* creating enemies or other crews;
* creating hidden motives;
* creating complications;
* revisiting unresolved relationships;
* managing dramatic pacing;
* determining when a captain-level decision should be surfaced;
* writing occasional significant dialogue or narrative;
* summarizing completed arcs.

The Narrator is omniscient but not omnipotent.

It knows the entire state of the simulation.

Its output to the player must respect the captain’s information.

It must not accidentally reveal:

The prisoner has been murdered.

when nobody has yet discovered the body.

⸻

16. Narrator Authority

The Narrator has substantial authority to influence the simulation.

It may create entirely new hard state.

For example, it can decide that the story currently needs a remote outpost and generate:

* the outpost;
* its commander;
* workers;
* relevant physical spaces or abstract location state;
* a problem;
* cargo;
* associated NPCs;
* a hostile crew.

Once created, those entities become part of canonical simulation state.

The Narrator may also influence apparently random occurrences.

For example:

* accelerating a gasket failure during an otherwise quiet stretch;
* suppressing another major encounter immediately after a devastating battle;
* causing a latent interpersonal conflict to surface when two characters are next alone;
* guaranteeing that an ambush occurs after the ship leaves port.

The Narrator therefore influences when events happen, not merely how they are described.

However, it should generally avoid directly authoring downstream outcomes.

It may guarantee the ambush.

It should not guarantee that a specific crew member dies in the ambush.

⸻

17. Hard, Soft, and Narrative State

The game should conceptually distinguish three kinds of state.

Hard Simulation State

Concrete reality:

* characters;
* wounds;
* objects;
* locations;
* machinery;
* atmosphere;
* power;
* cargo;
* money;
* physical damage.

Hard state cannot be casually rewritten for narrative convenience.

Soft Social State

Interpretive but mechanically meaningful state:

* trust;
* resentment;
* affection;
* suspicion;
* fear;
* loyalty;
* mood;
* coarse memories such as feels betrayed by.

The Narrator can influence this state more freely when justified by actual events.

Narrative State

Story-management state:

* active arcs;
* dormant hooks;
* unresolved relationships;
* pacing;
* intended setup beats;
* supporting cast;
* possible future developments.

Narrative state can be revised freely as events invalidate previous plans.

⸻

18. Narrative Arcs

The game internally organizes significant stories as arcs.

Arc structure should initially remain loose rather than conforming to rigid templates.

An arc may contain:

* premise;
* cast;
* relevant prior canon;
* active tension;
* hooks;
* planned opportunities or beats;
* unresolved questions;
* possible resolution conditions.

The Narrator can commit to certain future beats.

For example:

The ship will definitely be ambushed after leaving port.

or:

The next time Chen and Ortega spend meaningful time alone, their current conflict will come to a head.

The outcome of those beats remains simulated.

Arcs may fail to resolve as expected.

If one half of an interpersonal arc dies in an unrelated decompression accident, that death becomes part of the arc’s actual ending.

The Narrator adapts rather than protecting its outline.

⸻

19. Arc Concurrency and Pacing

The game should strongly limit simultaneous narrative pressure.

A good initial model is:

* approximately one primary active arc;
* a small number of dormant or background hooks;
* ordinary crew life continuing underneath.

The game should avoid becoming a collection of concurrent quest lines.

Not every arc is dramatic.

A quiet freight run can itself be an arc:

Accept cargo → travel safely → perform routine maintenance → deliver cargo → get paid.

Quiet periods are important.

After a major battle or tragedy, the Narrator may intentionally provide decompression rather than immediately injecting another disaster.

Conversely, if the simulation has been quiet for too long, the Narrator may deliberately introduce pressure.

⸻

20. Post-Hoc Storytelling

The Narrator should generally avoid constantly speaking over the simulation.

Its most explicit narrative voice may appear after a meaningful arc concludes.

For example:

The Long Way Home

What began as a routine delivery to Pallas became a three-day struggle with a failing coolant loop, an unexpected passenger, and the first serious reconciliation between Chen and Ortega since Talos.

These summaries create a sense of episodic history.

Not every freight run needs a dramatic title or narration.

The Narrator should recognize when enough actually happened to deserve one.

Over time these completed arcs become the game’s canon and can heavily constrain or inspire future generation.

⸻

21. Canon

Prior events should strongly affect future stories.

The Narrator should know:

* who betrayed whom;
* which stations the crew has visited;
* whom the captain helped;
* whom the crew angered;
* previous employers;
* enemies who survived;
* lost friends and family;
* significant injuries;
* unusual objects aboard;
* former crew;
* unresolved promises;
* past disasters.

Future arcs should preferentially reuse relevant canon rather than constantly invent unrelated content.

A station commander helped ten hours ago may call again.

A pirate who escaped can return.

A former crewmember may reappear aboard another ship.

The game gradually manufactures its own setting.

⸻

22. Decision Presentation

Captain decisions are designed primarily for a mobile phone interface.

When a decision occurs:

1. The simulation pauses.
2. A full-screen card presents the situation from the captain’s point of view.
3. The player receives two choices: left and right.
4. The player may temporarily leave the card to inspect relevant simulation state.
5. The unresolved card remains waiting.
6. The player eventually chooses one side.
7. The simulation resumes and autonomously carries out the decision.

The interface should not ordinarily expose explicit numerical consequences such as:

+5 morale
-10 credits
+3 loyalty

The player should reason from the situation, available information, character advice, and their understanding of the crew.

⸻

23. Combat

Combat is part of the intended full game but does not need to be included in the first playable build.

Eventually, combat should use a relatively deep simulation in order to create interesting situations.

Ship-to-ship combat may simulate opposing vessels even if the enemy ship is not visually rendered initially.

Potential enemy state includes:

* hull sections;
* propulsion;
* weapons;
* sensors;
* power;
* crew;
* fires;
* atmosphere;
* casualties;
* damage.

The Narrator may know this complete state.

The player sees only what the captain can reasonably know through sensors, communications, visual observation, reports, and other information channels.

Combat decisions remain captain-level:

* fight or flee;
* surrender or resist;
* pursue or disengage;
* take a dangerous tactical opportunity or remain cautious.

Moment-to-moment weapon operation and repairs remain autonomous.

Boarding actions are a desirable later feature because normal crew and ship-layout mechanics naturally become tactical combat mechanics.

They are explicitly outside initial scope.

⸻

24. Initial Prototype / Vertical Slice

The first prototype should be intentionally small.

World

* Three ports.
* Transit space between them.
* No deeply simulated galaxy.

Ship

* One fixed small-freighter hull.
* Fixed compartment layout.
* Individual machines.
* Physical inventory and cargo.
* Docking interface, personnel ramp, and cargo ramp.

Crew

* Approximately 6–8 crew members.
* Captain.
* First officer.
* Autonomous work.
* Skills and cross-training.
* Needs.
* Relationships.
* Social interaction.
* Injury and physical health.
* Basic schedules/shifts.
* Imperfect information.

Activities

* Find jobs.
* Load cargo.
* Carry passengers.
* Undock.
* Travel.
* Dock.
* Deliver cargo/passengers.
* Receive payment.
* Maintain and repair the ship.
* Satisfy ordinary life needs.
* Experience narrator-created situations.
* Make binary captain decisions.

Narrator

* Inspect simulation state.
* Maintain canon.
* Generate job opportunities.
* Generate supporting NPCs.
* Generate hard state needed by stories.
* Inject events.
* Maintain a small number of hooks.
* Surface captain decisions.
* Maintain captain information boundaries.
* Recognize arc resolution.
* Produce occasional post-hoc arc narration.

Explicitly Not Required for First Build

* Ship-to-ship combat.
* Boarding.
* Off-ship character maps.
* Ship construction.
* Deep economy simulation.
* Research.
* Faction simulation.
* Large procedural galaxy.
* Large crew.
* Player-managed work priorities.
* Departmental hierarchy.
* Multiple competing character goal systems.
* Elaborate mutiny mechanics.

⸻

25. Prototype Hypotheses

The initial implementation exists primarily to answer two questions.

Narrative Hypothesis

Can an autonomous ship simulation combined with an AI Narrator repeatedly produce binary captain decisions that feel contextual, consequential, and continuous with previous events?

If decisions feel arbitrary, obviously generated, disconnected from simulation state, or mechanically meaningless, the central game concept does not work.

Simulation Hypothesis

Is watching 6–8 autonomous people live and operate a physical starship interesting enough at 1× speed that the game remains engaging between major narrative events?

This may be the more important technical and design risk.

If normal ship operation is not satisfying to observe, the Narrator will be forced to generate constant incidents in order to entertain the player.

At that point the game becomes an event generator rather than the intended simulation.

The simulation itself must therefore create enough motion, comprehensible behavior, small problems, social activity, and physical consequence to sustain attention.

⸻

26. Major Open Design Questions

Autonomous Task Selection

The largest unresolved simulation problem.

We need a system that:

* generally does the obvious thing;
* handles emergencies sensibly;
* gracefully compensates for injured or unavailable specialists;
* respects physical location;
* respects imperfect information;
* allows skill specialization and cross-training;
* does not require player micromanagement;
* does not require an LLM in the scheduling loop.

Candidate ingredients include task urgency, worker eligibility, proximity, skill, current activity, role, contextual danger, and known information.

This should be prototyped rather than designed entirely on paper.

Narrator Frequency

How often should the Narrator evaluate the world?

It likely does not need to run continuously.

Different narrator functions may operate at different cadences:

* rapid checks for captain-worthy decisions;
* slower arc-management evaluation;
* major generation during job acquisition or arrival;
* occasional social/story interpretation.

This is both a pacing and cost problem.

Narrator Authority Boundaries

The current philosophy is permissive but requires implementation rules.

The Narrator may create new facts and influence event timing, but the exact boundary between acceptable setup and unacceptable outcome-writing will require experimentation.

Information Representation

The underlying information model needs to be simple enough to run efficiently while still allowing meaningful communication failures.

The first version should probably avoid simulating arbitrary human knowledge in detail.

Schedules and Routine Policy

Crew need schedules and normal operating assumptions, but the game must not become Schedule Approval Simulator.

The Narrator may occasionally surface a meaningful policy change as a captain decision.

Most routine scheduling should happen without player involvement.

Incapacitated Captain

Current direction is to shift captain-level perspective to the first officer while the captain cannot command.

Details remain unresolved.

End Conditions

Ship destruction and loss of the crew are clear failures.

Edge cases involving one survivor, stranded characters, abandoned ships, escape pods, or recovery after catastrophic loss can be solved later.

⸻

27. Development Philosophy

The first implementation should not attempt to prove that we can generate an entire living galaxy.

It should prove that one small ship can feel alive.

The project should favor simulation depth in a small space over breadth.

Every additional system should be evaluated against the central loop:

Observe → Situation → Captain Decision → Autonomous Response → Consequence → Memory → Observe

When a system creates new interactions inside that loop, it is likely valuable.

When it primarily adds scale, content volume, or management overhead without improving that loop, it can wait.

The long-term vision can become considerably larger.

The first milestone is simply a freighter, a handful of people, a few destinations, and enough simulation for something worth remembering to happen.