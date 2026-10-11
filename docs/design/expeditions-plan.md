# Expeditions: Implementation Plan

Status: phase A1 landed on `expeditions-a1`, 2026-10-10; what was built is in
`docs/spec/expeditions.md` and D103, and where it differs from this plan the spec wins. Phase A2 is
planned below as tonight's slice (2026-10-11, "Phase A2 (tonight's slice)"): one errand end to
end, with the design's narrator range (`stageSite`, parley, scripted turns, the approach effect)
deferred to a second A2 pass the owner rules on in the morning. Design and
rationale: `docs/design/expeditions.md` (section references below are to that file unless another
doc is named). Phases B, C and D are planned here when the one before each lands, as
`docs/design/ship-life-plan.md` did its slices. A1 ends with all four checks green
(`pnpm typecheck && pnpm lint && pnpm depcruise && pnpm test`), `crew content validate` clean, the
`crew expeditions` numbers recorded, a phone playtest, the owner's rulings as the next
`docs/DECISIONS.md` entry, and the A1 mechanics in `docs/spec/` (see the closing section).

## Phase A1: the fight, measured

### Scope

Everything the owner's acceptance question needs and nothing the narrator needs: does `hold`
play differently from `assault`, visibly, at 1× on a phone, and are deaths rare?

- Bodies at SD §12's minimum (§7.1): six parts, three severities, blood, pain, consciousness;
  capacities derived from wounds and composed with fatigue; incapacitation and death by threshold;
  one damage entry point.
- Arms (§7.2): weapons as items, the arms locker on Mk2, the `fighting` skill.
- The site map as a `DockDef` of `kind: "site"` (§4) with cover tiles and site posts, its
  validator rules, `render-dock` for sites, and one authored site, the Boathouse, with its
  default cast.
- The expedition started by a scenario command, with the ship already set down at the site: the
  muster at the locker, the walk down the ramp, the cast at their posts.
- The combat system (§8): the seven actions, lines of sight and cover, hits and wounds, morale
  with wavering, breaking, fleeing and surrender, the five postures, three fire rules and four
  squad rules, the plan menu, `rescue` and carrying aboard, the alert.
- Legibility (§8.6): the site's look, cover, tracers and hit flashes, action labels, the shore
  header word per side, log lines, the slow-down event, the inspector's body line.
- Thoughts and memories from a fight (§11).
- The `crew expeditions` instrument and its CI regression.
- Save schema 12 → 13, migrated.

### Non-goals (A2 and later)

No `PortDef` graph change beyond the one port the Boathouse needs (§3.2's `knownSites` is A2);
no landing or lift-off scenes, headlines or travel rules for sites (§3.3, §3.5); no `Job.errand`,
pay, captive or body item (§6); no `stageSite`, cast tiers, scripted turns, parley or the
approach effect (§9); no narrator hooks, digest sections, capability lines or prompt change
(§10) beyond hiding the site port from the narrator; no medicine; no armour; no `rampsUp`; the
ship takes no damage; nobody boards. The default scenario is unchanged and the game plays as
before unless the scenario command is sent.

### How the phase runs

As slice 5 did (`ship-life-plan.md`, "Slice 5"): one serial **gate** commit of contracts by one
agent on a branch `expeditions-a1`; five **workstreams** in parallel, each a subagent in its own
worktree owning the files named below and no others; **integration** by the lead in the order
given, with a tuning commit against the instrument; then the D-entries, a README line and the
playtest. No two streams edit the same file; content data, generated schemas, deck READMEs and
narrator fixtures are the lead's at integration, and a stream that needs a content or config
change names it in its report.

## Calls made against the code

Decisions the design left to the plan, each made after reading the code it lands in.

1. **The Boathouse needs a port in A1.** `systems/travel/invariants.ts` `travelViolations`
   requires the dock alongside to be `expectedDock(content, travel)`: the dock map of the port
   the ship is docked at, by `DockDef.portId`. So a site map cannot be alongside without a port
   that owns it, and `PortDef.kind: "site"` (§3.1's shape, routes and all) comes forward from A2,
   without A2's graph rule: `port.boathouse` has one route to `port.terns_rest` and no port
   lists it, so the ship can never be sent there yet. `shortestPath` is untouched.
2. **No second content scenario.** `apps/web/src/worker/content.ts` and `apps/cli/src/pacing.ts`
   `loadPacingContent` both take `Object.keys(bundle.scenarios)[0]`, so a second scenario would
   change which game the web starts by import order. The expedition starts from a scenario
   command instead: `scenarioStartExpedition` moves a docked ship to the site in place.
3. **The scenario command swaps the dock.** Apply, under scenario authority: `travel` becomes
   `{ stage: "docked", portId: siteId }`; the ramps are set shut, `detachDock` (which refuses
   while a ramp is down or anyone is on the floor, §ramps-and-cast-off; the command's
   precondition is nobody on the dock and no dock hand errand), `attachDock` with the site's
   map, the ramps set open (`syncRampPassability`); the hub's locals and props are cleared with
   the dock (§locals-come-and-go-with-the-dock); the
   cast is spawned on the site floor at their posts; `state.expedition` is written. The world's
   narrator bookkeeping is untouched (`captainAshoreLastAsk` stays spent at the hub, so no
   `captainAshore` fires at the site).
4. **The narrator never sees the site port in A1.** `packages/narrator/src/capabilities.ts`
   lists every port with legs and distances through `lookups.ts` `pathBetween`; an unreachable
   port there is new ground. `isSite(content, portId)` (`core/places.ts`) filters sites out of
   the capability block, the port lines in `lookups.ts`, and the null narrator's offers. A2 puts
   them back in their own "Sites" section.
5. **Capacities have one formula and two callers.** `systems/needs/needs.ts` `updateActor`
   writes `capacities.movement` and `.manipulation` from `fatigueCapacity` every tick, for crew
   only. Bodies must compose with that, so `core/body.ts` `applyCapacities(actor, config)` owns
   the formula (`movement = fatigueCapacity × bodyMovement`, `manipulation = fatigueCapacity ×
   bodyManipulation`, `consciousness = bodyConsciousness`); needs calls it where it wrote the two
   fields, and the bodies system calls it for everyone needs skips (non-crew, incapacitated). A
   whole body gives 1, so no number changes until someone is hurt.
6. **The combat system owns its combatants.** `core/pipeline.ts` `runPlannerStage` plans only
   `actor.crew && availability === "available"`, and `systems/work/work.ts` steps only
   `actor.crew`. Cast actors are `crew: false` and so are never planned or stepped, which is what
   we want; the party are crew and would be. During `approach` and `fight` the combat system
   sets each combatant's activity to `personal` `fight` with its own `label` and drives movement
   through `systems/spatial/movement.ts` `requestMove` / `stopMovement` directly; `planner/
   select.ts` returns `continue` for an actor in `fight` (the `disembarking` rule's pattern) and
   `work.ts` skips them. No new `ActivityStep` kinds, so `steps.ts`, `plans.ts` and `actions.ts`
   are untouched. `abortActivity` (`work/execute.ts`) is called once when the fight takes someone.
7. **Spawning the cast.** `core/command-handlers.ts` `newActor` sets `crew` from the location
   (`!== "inExternalStore"`); the expedition command calls it and then sets `crew: false`,
   `combatant`, `body`, and gives them their weapon in hand (`carriedBy`). Their crew def is a
   `gen.crew.<slug>` dynamic def written to `defs.dynamic.crew` from the cast entry (name,
   role as `bio`, `fighting` from the tier), as `spawnAtBoundary` writes generated defs.
8. **Cover is a tile kind and a blocking prop.** A `cover` legend tile is not floor (so not
   walkable, like a blocking prop; `dockFloorMask` already treats non-floor so), and a line of
   fire is blocked by it unless it is adjacent to either end, in which case that end "is in
   cover" (a hit penalty on shots at them). Blocking props count the same, so every dock map
   has cover already (crates, the conveyor, hull sections) for boarding later. Walls block
   always. People never block. `core/sites.ts` reads the kinds off the dock def; nothing is
   added to `DeckGeometry`.
9. **A fight is in sim seconds and tick-sampled, not per tick.** The combat system runs every
   tick in phase `actions` but each combatant decides every `expedition.decideEverySeconds`
   (0.5 s) staggered by actor index, as the planner staggers; lines of sight are computed only
   at decisions and on each shot, over at most eight combatants, so a fight costs well under a
   millisecond a tick on a phone (one tile walk is at most 44 cells).
10. **Posts of site kinds on a dock map, dock kinds on a site map, both allowed.** The schema is
    one `DockDef`; the L3 rules differ by `kind` (§4): a site needs no gate, warehouse door,
    stall or areas, keeps the quay row (the pad's apron) and the landings, and must have a
    `target`, an `exit` and a reachable `flank` by a disjoint route. A dock may carry a `bench`
    and a site may carry a `bench`; nothing reads a post it does not know.
11. **The party is who the squad rule picks when the plan is adopted**, not before. The command
    takes an optional `plan`; without one the party is `everyone` fit and the fight does not
    start until `adoptPlan` (scenario) is applied, so the instrument and a test can stage the
    approach, then choose. With one, the muster and the walk happen and the fight starts when
    the party stands at the ramp foot. A2's card is the same command from `player`.
12. **Who goes.** `squad` picks from crew who are `available`, awake, aboard, not the helm
    stander, not on gangway watch (`systems/watch/helm.ts` `whoHasTheHelm`, the `standWatch`
    activity), captain first (owner ruling 4), then the first officer, then by `fighting`.
    `armedOnly` takes as many as there are weapons in the locker; `blastersOnly` as many as
    blasters; `smallTeam` the captain and the two best `fighting`. The muster is a personal
    activity `muster` (walk to the locker's `use` position, a `work` step, the weapon into
    hand) handed out by the expedition system the way commerce hands out `lookForWork`
    (`systems/commerce/captain-ashore.ts`: `pendingIntent` at `essentialOperation`, re-handed
    until it starts); its plan is built in the expedition system's own `plans.ts` and routed
    from `buildPersonalPlan` by one line the gate adds.
13. **Schema 13.** Every actor gains `body` (whole) and `skills.fighting` (from the crew def by
    `defId`, else 0); `expedition` is optional and absent; the Mk2's arms locker is instantiated
    into a save that lacks the placement (by `placementKey`, the `instantiateDeck` path for one
    placement), and the scenario's weapons are stowed through `spawnScenarioStores` as the
    patch kits were (§save-migrations). Old saves play on with three blasters in the locker
    they never had.

## Gate: contracts (one agent, serial)

One commit, all four checks green, `crew content validate` clean. Stubs are allowed where
behaviour is a stream's; types, schemas, generated schemas, content, the migration, the
commands and their validation, the ticker lines, the protocol and the registries are not. Every
stub is a named function in a file its stream owns, called from the shared file, so after the
gate no stream edits `core/types/**`, `core/render.ts`, `core/world.ts`, `core/migrations.ts`,
`core/invariants.ts`, `core/command-handlers.ts`, `view/agentView.ts`, `planner/select.ts`,
`planner/candidates.ts`, `systems/work/**`, `systems/needs/needs.ts`, `packages/sim/src/index.ts`,
`apps/web/src/worker/registry.ts` or `apps/cli/src/pacing.ts`'s registry. With no expedition
started the game is unchanged: every body is whole, capacities equal what fatigue gave them
before, the locker holds five items nobody wants, and the narrator's prompt is byte-identical.

**Sim types.**

- `core/types/content.ts`: `SKILLS` + `"fighting"`; `ITEM_TAGS` + `"weapon"`; `MACHINE_TAGS` +
  `"armsLocker"`; `THOUGHT_KEYS` + `killedSomeone`, `sawCrewHurt`, `heldTheLine`,
  `ranFromAFight`, `wounded`; `MEMORY_KEYS` + `foughtBeside`, `carriedMeOut`, `leftMeBehind`;
  `DOCK_TILE_KINDS` + `"cover"`; `DOCK_POST_KINDS` + `target`, `guard`, `loot`, `exit`, `flank`,
  `bystander`; `DOCK_KINDS = ["dock", "site"]`; `DockDef.kind?`, `DockDef.noticeRadius?`,
  `DockDef.defaultCast?: readonly SiteCastEntryDef[]`; `PORT_KINDS = ["port", "site"]`,
  `PortDef.kind?`, `PortDef.nearPortId?`; `ItemDef.weapon?: WeaponDef { kind: "blaster" |
  "baton"; range: number; aimSeconds: number; hit: number; severity: WoundSeverity; damageType:
  "blaster" | "blunt"; stun: boolean }`; `BODY_PARTS = ["head", "torso", "leftArm", "rightArm",
  "leftLeg", "rightLeg"]`, `WOUND_SEVERITIES = ["graze", "serious", "grave"]`, `DAMAGE_TYPES =
  ["blaster", "blunt", "stun"]`; `SiteCastEntryDef { name; role; look; part: CastPart; arms:
  CastArms; resolve: ResolveTier; tie: TieTier; wants: WantsTier; post: LocalKey }` with
  `CAST_PARTS = ["target", "guard", "bystander", "ally"]`, `CAST_ARMS = ["none", "melee",
  "blaster"]`, `RESOLVE_TIERS = ["shaky", "steady", "hard"]`, `TIE_TIERS = ["paid", "bound",
  "devoted"]`, `WANTS_TIERS = ["money", "out", "blood", "nothing"]`; `ConfigDef.bodies` and
  `ConfigDef.expedition` (values under "Content and schemas").
- `core/types/actor.ts`: `Body { parts: Record<BodyPart, { damage: number }>; blood: number;
  pain: number; stun: number; wounds: Wound[] }`, `Wound { id: WoundId; part; severity; type;
  bleeding: boolean; tick: Tick; causeActorId?: ActorId }`; `Actor.body: Body`;
  `Actor.combatant?: Combatant { side: "us" | "them"; disposition: Disposition; state:
  CombatantState; resolve: number; lastDecidedTick: Tick; cover?: TileCoord; aim?: { targetId:
  ActorId; sinceTick: Tick } }` where `Disposition { part: CastPart; resolveBase: number;
  loyalty: number; wants: WantsTier }` and `COMBATANT_STATES = ["steady", "wavering",
  "breaking", "fled", "surrendered", "down", "dead"]`; `FactValues.fightSeen { expeditionTick:
  Tick }` (for the intercom reflex, A2; written now by nobody).
- `core/types/ids.ts`: `WoundId` (prefix `w`), in `ID_PREFIX`, `InstanceIdOf` and
  `NextIdCounters`.
- `core/types/state.ts`: `BattlePlan` (§8.3, with `id: PlanId` a plain string handle);
  `ExpeditionPhase = "mustering" | "walkingOut" | "approach" | "fight" | "resolved"`;
  `Expedition { siteId: PortDefId; phase; party: ActorId[]; leaderId: ActorId; plan?: BattlePlan;
  startedTick: Tick; fightStartedTick?: Tick; resolvedTick?: Tick; outcome?: ExpeditionOutcome;
  shots: number; causeCommandId?: CommandId }` with `EXPEDITION_OUTCOMES = ["targetTaken",
  "targetFled", "partyWithdrew", "partyRouted", "timedOut"]`; `WorldState.expedition?`;
  `AlertState.cause` + `"fight"`; `SCHEMA_VERSION = 13` and its history line.
- `core/types/work.ts`: `PERSONAL_ACTIVITIES` + `muster`, `fight`; `WorkStageKey` + `arm`.
  `core/types/pipeline.ts`: `PlannerConfig` + `expedition`, `bodies`.
- `core/types/view.ts`: `SelfView.body: BodyView { capacities; wounded: boolean; bleeding:
  boolean }`, `RosterEntry.down?: true`; `PlanOption { id; plan: BattlePlan; available:
  boolean; why: string }`; `RenderActor.state?: CombatantState`, `RenderActor.side?: "us" |
  "them"`, `RenderActor.wounded: boolean`; `RenderShot { tick; fromX; fromY; toX; toY; hit:
  boolean }`; `RenderExpedition { phase; us: SideWord; them: SideWord }` with `SIDE_WORDS =
  ["steady", "shaky", "breaking", "done"]`; `RenderFrame.shots`, `RenderFrame.expedition?`.
  `core/types/protocol.ts` restates nothing (frames carry it).
- Commands: `core/types/commands/expedition.ts` (new): `scenarioStartExpedition { siteId:
  PortDefId; cast?: readonly SiteCastEntryDef[]; plan?: PlanId }`, `adoptPlan { planId }`,
  `withdrawParty {}`; `commands/index.ts` merges it; `authority.ts`: `scenario` gains all three,
  `player` gains `adoptPlan` and `withdrawParty` (A2's card sides; nothing issues them yet),
  `system` nothing; `contracts.test.ts` follows. Handlers complete at the gate in
  `systems/expedition/command.ts` (call 3's swap, the precondition list, the cast caps
  `SITE_LIMITS { people: 6, armed: 3, targets: 1, allies: 1 }`, posts that exist on the site
  map and are of the entry's part's kind, a `plan` that `planMenu` holds and marks available),
  registered by `registerExpedition`.
- Events: `events/bodies.ts` (`wounded { actorId; woundId; part; severity; type; byActorId? }`,
  `incapacitated { actorId; cause: "blood" | "pain" | "movement" | "stun" }`, `died { actorId;
  cause: "wound" | "blood"; byActorId? }`, `woundHealed { actorId; woundId }`), `events/
  expedition.ts` (`expeditionStarted { siteId; party }`, `partyMustered { party; armed }`,
  `expeditionContact { siteId }` (narrative), `shotFired { byActorId; atActorId; hit }` (trace),
  `combatantBroke { actorId; side; how: "fled" | "surrendered" }`, `partyWithdrew`,
  `expeditionResolved { siteId; outcome; seconds; shots; woundsUs; woundsThem; deadUs; deadThem
  }` (narrative), `alertRaised`/`alertCleared` reuse the field's with `cause: "fight"`);
  `events/index.ts` merges both.
- `core/body.ts` (new, complete; owner W1 may extend): `wholeBody()`, `partFunction(body,
  part, config)`, `bodyCapacities(body, config)` by SD §12.2's formulas, `applyCapacities(actor,
  config)` (call 5), `isDeadBy(body, config)`, `incapacityOf(body, config)`. `core/sites.ts`
  (new, complete): `siteOf(content, state)` (the site dock alongside, or undefined),
  `tileKindAt(berth, tile)`, `isCover(berth, tile)` (legend `cover` or a blocking prop),
  `postsOfKind(dock, kind)`, `rampFoot(content, state)` (the personnel ramp landing, from
  `systems/spatial/dock.ts` `rampLanding`'s rule restated pure). `core/places.ts` (new):
  `isSite(content, portId)`. `core/world.ts`: `emptyState` actors get `wholeBody()`; crew get
  `fighting` from their def through the existing skills copy. `core/migrations.ts` `12:` (call
  13); `save.test.ts` adds a 12 → 13 case. `core/invariants.ts`: every actor has a body with the
  six parts, `blood`, `pain`, `stun` in [0, 1], wound ids below `nextId.wound` and unique;
  `dead` actors are `dead` by `isDeadBy`, and vice versa; `expedition.party` are actors,
  `leaderId` among them, `phase` consistent with `plan` (fight needs one); a `combatant` only on
  an actor on the site's deck; no `expedition` without a site dock alongside.
- `systems/bodies/` (new; owner W1): `bodies.ts` (`bodiesSystem`, phase `needs` after
  `needs.needs`; stub calls `applyCapacities` for non-crew actors and nothing else),
  `damage.ts` (`applyDamage(ctx, actorId, hit: Hit): DamageResult` with `Hit { part?: BodyPart;
  severity; type; byActorId?; partTable?: Record<BodyPart, number> }` and `DamageResult {
  woundId; part; incapacitated: boolean; died: boolean }`; stub throws `NotImplementedError`),
  `index.ts` with `registerBodies`.
- `systems/expedition/` (new; owner W2): `command.ts` (complete), `expedition.ts`
  (`expeditionSystem`, phase `actions` before `work.execute`: the registry order puts it there;
  stub: no-op), `muster.ts` (`musterPlan(ctx, actor)` blocked `unreachableTarget`;
  `handOutMuster(ctx)` no-op), `combat.ts`, `actions.ts`, `los.ts`, `morale.ts`, `plans.ts`
  (`planMenu`'s sim-side twin is `view/planMenu.ts`), `labels.ts` (`fightLabel`: "in cover",
  "firing", "advancing", "wavering", "running", "down", "dragging <name>", "surrendered";
  `musterLabel`: "going to the arms locker", "arming", "going ashore to the site"), `index.ts`
  with `registerExpedition`.
- `view/planMenu.ts` (new; owner W2): `planMenu(state, content, config): PlanOption[]` stub
  returning the default pair (`hold-lethal-armed`, `assault-lethal-armed`) both available;
  exported from `view/index.ts` and `packages/sim/src/index.ts`.
- `planner/select.ts`: `continue` for `fight` and `muster` activities (call 6). `systems/
  work/work.ts`: skip an actor in `fight`. `systems/work/plans.ts` `buildPersonalPlan`:
  `muster` → `musterPlan`; `labels.ts`: `muster` and `fight` through W2's labels. `systems/
  needs/needs.ts`: the capacity write becomes `applyCapacities(actor, ctx.config)` (call 5).
- `view/agentView.ts`: `self.body`, `roster()[].down`; `toAgentViewSnapshot` carries them.
  `core/render.ts`: `renderActor` gains `state`, `side`, `wounded`; the frame gains `shots`
  (from the tick's `shotFired` events) and `expedition` (side words from the combatants'
  states: `steady` while most are steady, `shaky` when any wavers, `breaking` when any breaks,
  `done` when none can fight); ticker lines (streams write none): `expeditionStarted` → "Mara
  Osei takes four down the ramp", `partyMustered` → trace, `expeditionContact` → "Shots at the
  boathouse", `wounded` → "Jax Okonkwo is hit in the leg" / "Hesk is hit", `incapacitated` →
  "Jax Okonkwo is down", `died` → "Jax Okonkwo is dead" (narrative), `combatantBroke` →
  "Darrow Finch runs for the jetty" / "Hesk throws down his blaster", `partyWithdrew` → "The
  party pulls back to the ramp", `expeditionResolved` → "Corran Vale taken; two of ours hurt" /
  "Corran Vale got away" / "The party is driven back to the ship", `shotFired` hidden.
  `docs/CONTRACTS.md`: bodies, the combat system owning its combatants, the `bodies` owner.
- `packages/sim/src/index.ts` exports `registerBodies`, `registerExpedition`, `applyDamage`,
  `planMenu`, `isSite`, the new enums, `wholeBody`, `bodyCapacities`; `apps/web/src/worker/
  registry.ts` and `apps/cli/src/pacing.ts` register expedition before work (phase `actions`
  order is registration order within the phase: spatial, then expedition, then work) and bodies
  after needs.

**Content and schemas (`packages/content`).**

- `schemas/primitives.ts`: the enums follow (`AssertEqual` guards for skills, item tags,
  machine tags, thought and memory keys). `schemas/port.ts`: `kind`, `nearPortId`; for `kind:
  "site"` `castSeed` may be empty, `externalStores` may be empty, `market` and `jobTemplates`
  must be empty, `routes` must have exactly one entry to `nearPortId`; a port never lists a
  site in `routes` (L2). `schemas/dock.ts`: `kind`, `cover` in the tile kinds, the six site post
  kinds, `noticeRadius` (positive, required for a site), `defaultCast` (site only; the cast
  schema with `SITE_LIMITS`; posts named must exist and match the part: a `target` at a
  `target` post, a `guard` at a `guard` post, a `bystander` at a `bystander`, an `ally` at a
  `guard` or `bystander`). `schemas/item.ts`: `weapon` (range positive, `aimSeconds` positive,
  `hit` in (0, 1], the enums), allowed only with the `weapon` tag and vice versa. `schemas/
  crew.ts`: nothing (`fighting` is a skill id). `schemas/config.ts`: `bodies` and `expedition`
  blocks, strict. `validate-dock.ts`: the site branch (call 10; the rules in "W3").
  `crew content schemas` regenerated.
- Data: `ports/boathouse.json` (`port.boathouse`, `kind: "site"`, `setting: "planet"`,
  `nearPortId: "port.terns_rest"`, `routes: [{ toPortId: "port.terns_rest", distance: 20 }]`,
  `description` "A boat shed on the shingle below the Rest", `character` two sentences,
  `castSeed: []`, `externalStores: []`, `market: []`, `jobTemplates: []`);
  `docks/boathouse.json` (below) and its README via `render-dock`; `items/blaster.json`
  (`item.blaster`, unique, tags `["weapon"]`, mass 1.5, `weapon: { kind: "blaster", range: 8,
  aimSeconds: 1.2, hit: 0.55, severity: "serious", damageType: "blaster", stun: true }`),
  `items/baton.json` (`item.baton`, unique, mass 1, `weapon: { kind: "baton", range: 1,
  aimSeconds: 0.6, hit: 0.7, severity: "serious", damageType: "blunt", stun: false }`);
  `machines/arms-locker.json` (`machine.arms_locker`, tag `armsLocker`, one tile, one `use`
  position at (0, 1), no power, no heat, no wear, no faults); placed on `freighter-mk2.json` as
  `arms_locker` against the cross-passage's north wall at (31, 7) with its `use` tile (31, 8) on
  the passage floor (free of spawn points, zones and interaction tiles; the lead checks the
  README), and a one-tile zone `arms` (`tags: ["armsLocker"]`, `machineKey: "arms_locker"`) on
  the locker's tile for `startingItems`; Mk1 gets the same in its corridor. `scenarios/
  default.json`: `item.blaster` × 3 and `item.baton` × 2 in zone `arms`. Crew defs gain
  `fighting`: Dane 5, Sunniva 4, Mara 4, Tomas 3, Jax 3, Noor 2, Priya 2, Oyelaran 2, Bettina 1;
  `crew.passenger` 0. `thoughts/`: `killed-someone.json` (−0.4, 3 days, no stack),
  `saw-crew-hurt.json` (−0.2, 1 day, stacks 2), `held-the-line.json` (+0.2, 1 day),
  `ran-from-a-fight.json` (−0.2, 1 day), `wounded.json` (−0.2, 0.5 day, no stack: the bodies
  system re-raises it while a wound is open). `config/default.json`:
  `bodies { tolerance: { head: 2, torso: 3, leftArm: 2, rightArm: 2, leftLeg: 2, rightLeg: 2 },
  severityDamage: { graze: 0.5, serious: 1.2, grave: 2.5 }, severityPain: { graze: 0.1,
  serious: 0.3, grave: 0.6 }, painDecayPerSecond: 0.01, bleedPerSecond: { graze: 0, serious:
  0.004, grave: 0.012 }, bleedStopsAfterSeconds: { graze: 0, serious: 60, grave: 180 },
  bloodRecoverPerSecond: 0.002, stunPerHit: 0.5, stunDecayPerSecond: 0.004,
  incapacitatedBelow: { consciousness: 0.3, movement: 0.15 }, deadBelowBlood: 0.25,
  healPerDay: 0.5, partTable: { head: 10, torso: 45, leftArm: 10, rightArm: 10, leftLeg: 12.5,
  rightLeg: 12.5 }, stunPartTable: { head: 0, torso: 0, leftArm: 25, rightArm: 25, leftLeg: 25,
  rightLeg: 25 } }`;
  `expedition { decideEverySeconds: 0.5, maxFightSeconds: 120, alertClearSeconds: 60,
  hitSkillBase: 0.7, hitPerFighting: 0.06, rangeFalloffFloor: 0.5, coverPenalty: 0.5,
  movingTargetFactor: 0.8, movingShooterFactor: 0.7, meleeAdjacentOnly: true, resolveTiers: {
  shaky: 0.45, steady: 0.7, hard: 0.95 }, crewResolve: { base: 0.6, perFighting: 0.03,
  perMood: 0.1, perLeaderAffinity: 0.02 }, morale: { hitSelf: -0.25, allyDown: -0.2,
  allyDead: -0.3, underFireNoCoverPerSecond: -0.05, outnumberedPerSecond: -0.03, allyHit: 0.05,
  inCoverPerSecond: 0.02, leaderNearPerSecond: 0.02, outflanked: -0.3, targetTaken: -0.4,
  waverBelow: 0.5, breakBelow: 0.25, recoverAbove: 0.6 }, withdrawWhen: { firstDown: 1,
  halfDown: 0.5 }, leaderNearTiles: 3, surrenderIfCornered: true, blasters: 3, batons: 2 }`;
  `host.slowDownOnEvents` + `expeditionContact`, `died`. `loader.ts` imports; `loader.test.ts`
  counts (ports 7, docks 7, machines 22, items 22, thoughts 32). Deck READMEs regenerated.
- Hand-built sim bundles: `core/fixtures/ship-life.ts` gains the five thoughts in
  `FIXTURE_THOUGHTS` and `FIXTURE_BODIES`, `FIXTURE_EXPEDITION`; every fixture config spreads
  them; `example-world.ts` actors gain `body` and the state `nextId.wound`.

**Tests the gate must fix to stay green** (literals and renames only): `loader.test.ts` and
`schemas.test.ts` counts; `contracts.test.ts` authority; `save.test.ts` 12 → 13; every test that
builds an `Actor` by hand gains `body: wholeBody()` (the fixtures' helpers do it in one place);
`needs.test.ts` still sees `movement < 1` under fatigue (call 5 keeps the number); the
narrator's `capabilities.test.ts` and `lookups` tests that count six ports pass once the gate's
`isSite` filter is in (`packages/narrator/src/lookups.ts` and `capabilities.ts` are gate files
for that one change; W5 owns them after); `apps/web/src/worker/fullSim.test.ts`'s eight-minute
run keeps its seed unless the locker's one failure-threshold draw at world creation shifts the
`failures` stream, in which case the gate moves the seed and says so; narrator fixtures under
`packages/narrator/fixtures/` load through the migration (regenerated at integration).

## The Boathouse

`packages/content/data/docks/boathouse.json`: `dock.boathouse` for `port.boathouse`, `kind:
"site"`, 44 × 30, `berth { origin: { x: 4, y: 0 }, sizeClass: "M" }`, palette floor `#8a8577`
(shingle), wall `#4a3f33`, accent `#c9b27a`, sky `#b7c7cf`; `grime: 0.6`, `airborneDust: 0.4`,
`noticeRadius: 6`, ambience "Gulls on the shed roof, the tide pulling at the jetty piles, and
nobody in sight who wants to be."

Rows 0–19 are void except the berth box, as at Tern's Rest. Rows 20–29, with the Mk2 at (4, 0)
so the personnel ramp (deck (34, 19), south) lands at (38, 20) and the cargo ramp at (17, 20):

```
   0         1         2         3         4
   01234567890123456789012345678901234567890123
20 ............................................   the apron: the quay row across the pad
21 ....................cc........cc............   c = cover (crates on the apron)
22 ..........######.#########.#####..........     shed north wall; doors at x=16 and x=26; jetty x=40–41
23 ..........#....................#..........
24 ..........#....................#..........     guard posts (16,24) and (26,24)
25 ..........#..nn.......nn.......#..........     n = cover (net racks)
26 ...............................#        ..     west door at (10,26); water east of the shed
27 ..........#....................#        ..     target (21,27), loot (22,27), bystander (29,27)
28           #....................#        ..
29           ######################        ..     exit at the jetty's end (41,29)
```

Legend: `.` floor, `#` wall, ` ` void, `c` cover, `n` cover. Posts: `target` (21, 27) facing n
("the keeper's bench"), `loot` (22, 27) n ("the strongbox shelf"), `guard` `east_door` (26, 24)
n and `west_door_inside` (16, 24) n, `bystander` `net_bench` (29, 27) w, `exit` `jetty_end`
(41, 29) s, `flank` `west_door` (8, 26) e. Props: `hullSection` ("a hauled-out skiff") at
(33, 23) 3 × 2 rot 0, blocking (cover on the east side of the apron); `lamp` at (2, 21) and
(39, 21), not blocking; `barrels` at (12, 23) 2 × 1 blocking. Foreground: `awning` over the
shed's north wall (10, 22) 22 × 1; `rockWall` (0, 28) 10 × 2. The lead renders it with
`crew content render-dock dock.boathouse` and fixes the README before W3 reads it.

Routes the plan menu needs: direct, from (38, 20) west along the apron to the east door (26, 22)
and in to (21, 27); flank, from (8, 26) through the west door to the same tile; they share no
tile south of the apron (rows ≥ 22) except the target post's neighbours, which is the L3 test.
`hold` has cover at (30, 21), (31, 21) and behind the skiff; `creep` approaches along the apron's
far edge, outside six tiles of both guards, to the west door.

Default cast (`defaultCast`): Corran Vale, "boat-shed keeper", "grey, wiry, never still",
`target`, arms `none`, resolve `steady`, wants `out`, at `target`; Hesk Marrow, "hired hand",
"big, bored, a blaster across his knees", `guard`, `blaster`, `steady`, tie `paid`, wants
`money`, at `east_door`; Darrow Finch, "the keeper's nephew", "young, trying to look hard",
`guard`, `melee`, `shaky`, tie `bound`, wants `out`, at `west_door_inside`; Old Pell, "net
mender", "deaf, or pretending", `bystander`, `none`, `shaky`, wants `nothing`, at `net_bench`.
The two instrument variants: `shaky` sets both guards `shaky`/`paid`; `hard` sets both
`hard`/`devoted` and gives Darrow a blaster (three armed is the cap: the target stays unarmed).

## Workstreams (parallel after the gate)

No two streams edit the same file. `docs/DECISIONS.md`, `packages/content/schema-json/*`,
`packages/content/data/**`, the deck and dock READMEs and `packages/narrator/fixtures/*` are the
lead's at integration. Each stream's report names the files it touched, the D-entry text it
proposes, and what it saw in a headless run.

**W1 — Sim: bodies and the damage path.** Owns `packages/sim/src/systems/bodies/**` (+ tests
and `fixtures/bodies-deck.ts`: the field fixture's four-room ship with four crew, whole bodies,
and helpers to wound someone by hand), `core/body.ts` (+ test).
- `damage.ts` `applyDamage`: the part from `hit.part`, else `hit.partTable`, else
  `bodies.partTable` (stun uses `stunPartTable`) on the `failures` stream; the wound
  (`allocateId(state, "wound")`, `bleeding` for a blaster `serious`/`grave`), `parts[part].damage
  += severityDamage[severity]` (stun adds `stunPerHit` to `body.stun` instead and no damage),
  `pain += severityPain`, `applyCapacities`, then `isDeadBy` (head or torso damage at or past
  tolerance, or blood below `deadBelowBlood`) → `availability: "dead"`, `abortActivity`,
  `stopMovement`, `died`; else `incapacityOf` (consciousness below the floor, or movement) →
  `incapacitated`, `abortActivity`, `stopMovement`, `incapacitated` with its cause; `wounded`
  every time. A dead or incapacitated actor drops what is in hand (`touchInventory`'s rule:
  items `carriedBy` them go `onDeck` at their tile). Returns `DamageResult`.
- `bodies.ts` `bodiesSystem` (phase `needs`, after `needs.needs`, `every: 10`): per actor with a
  body and not dead: bleeding wounds take `bleedPerSecond[severity] × dt` off `blood`, and stop
  bleeding `bleedStopsAfterSeconds` after their tick; blood recovers at `bloodRecoverPerSecond`
  while nothing bleeds; pain decays; stun decays; wounds heal `healPerDay` of their damage a day
  once not bleeding (`woundHealed` when a wound's damage reaches 0 and it is removed);
  `applyCapacities` for every actor needs does not cover (call 5); incapacitation and death
  re-checked (blood loss kills later than the shot); an incapacitated actor whose consciousness
  and movement recover above the floors becomes `available` again; `wounded` thought kept
  while any wound is open (`addThought`, `core/thoughts.ts`, non-stacking: extends).
- `core/body.ts` is the gate's; W1 may extend it with helpers it needs and keeps the formulas
  there, since `view/agentView.ts` reads `bodyCapacities` for `SelfView.body` and the planner
  may not import systems.
- Tests (`damage.test.ts`, `bodies.test.ts`, `core/body.test.ts`): a `serious` blaster wound to
  a leg halves movement by SD §12.2's leg-chain mean and manipulation is unchanged; two
  `serious` arm wounds on the same arm leave manipulation at half; a `grave` head wound kills
  at once with `died`; a `grave` torso wound bleeds to death in about `(1 − 0.25) / 0.012` s
  untreated unless it stops first (it does: 180 s stops it at blood ≈ 0.1 below the floor, so
  death; the test pins which); a `serious` torso bleeder stops at 60 s and lives; stun drops
  consciousness below the floor after two hits and recovers in about two minutes; an
  incapacitated actor drops the blaster at their feet; a dead actor is never planned or stepped
  (`fullSim`-style assertion on the fixture); fatigue and a leg wound multiply (call 5);
  `wounded` is on them while the wound is open and gone a day after it heals.
Done when the sim suite is green and the bodies fixture shows a wounded crew member slow, a
bleeder saved by time and one not, and capacities back to 1 when healed.

**W2 — Sim and view: the expedition and the fight.** Owns `packages/sim/src/systems/
expedition/**` (+ tests and `fixtures/boathouse.ts`: the real Mk2 and the real Boathouse
through `@crew/content`'s bundle, the ship swapped to the site by the command at tick 0, with
helpers to adopt a plan, run to resolution and read the tally), `view/planMenu.ts` (+ test).
- `command.ts` is the gate's; W2 extends its validation tests.
- `muster.ts`: `handOutMuster` (phase `actions`, from `expeditionSystem`) hands `muster` to each
  party member in turn as commerce hands `lookForWork` (`pendingIntent` `personal` at
  `essentialOperation`, re-handed until it starts, giving way to survival); `musterPlan`: to the
  locker's `use` position, a `work` step `arm` of 2 s whose commit moves the best weapon left
  in the locker's zone into the actor's hands (blasters to the best `fighting` first, batons
  next, nothing for the rest), then `moveTo` the ramp foot; the party is `walkingOut` once all
  are armed, `approach` when the leader stands on the site floor. A party member who cannot be
  armed under `armedOnly`/`blastersOnly` was never in the party.
- `combat.ts`: the combatant loop every `decideEverySeconds` staggered by actor index. The
  fight begins (`expeditionContact`, `fightStartedTick`, alert `cause: "fight"`) when a cast
  member notices the party (any party member within `noticeRadius` of them with a line of
  sight) or the party fires. Noticing is checked every decision in `approach`; `creep` keeps the
  party on tiles outside every awake cast member's `noticeRadius` where it can; `bait` sends the
  leader alone toward the nearest guard while the rest hold. Each decision picks one action
  (`actions.ts`) by the combatant's state and side:
  - `down`/`dead`: nothing. `fled`/`surrendered`: nothing (a fled cast member walks to the exit
    and is removed when they reach it, `combatantBroke` once).
  - `breaking`: `retreat` to the exit (cast) or the ramp foot (party); cornered (no route) or
    unarmed → `surrender`.
  - party on `hold`: `takeCover` at the nearest cover tile with a line to any cast member,
    within four tiles of the ramp foot's row; `fire` at the nearest cast member in sight and
    range; `guardPassage` on the ramp foot when none is in sight. `assault`: `fire` when a target
    is in range and sight with aim ready, else `advance` toward the objective post by a route
    preferring cover-adjacent tiles. `flank`: the party splits by alternating `fighting` rank;
    the smaller group `advance`s to the flank post then on to the objective; the larger holds as
    `hold` until the small group reaches the flank post, then `assault`s; every cast member in
    sight of both groups takes `outflanked` once. `bait`: the leader `advance`s talking (no fire
    until fired on); the rest `hold`; at first contact everyone `assault`s. `creep`: `advance`
    along the route that keeps outside notice radii; noticed → `assault`.
  - cast `guard`: `takeCover` by their post, `fire` at party in sight and range, `guardPassage`
    on their door when nobody is in sight; a `devoted` guard `advance`s on a party member in
    sight. `target`: stays at the post; `wants: out` and the party adjacent → taken (`targetTaken`
    once the leader or any party member stands adjacent and no armed cast member is within two
    tiles); `defiant` targets fight if armed. `bystander`: `retreat` to the exit at first shot.
  - `rescue`: any party member with no target in sight and a `down` ally in sight drags them to
    the ramp foot (the ally `carriedBy` them, movement at half; `carriedMeOut`/`foughtBeside`
    memories at resolution).
  - `fire`: aim starts (`combatant.aim`) and the shot lands after `aimSeconds` if the target is
    still in sight; hit chance `weapon.hit × (hitSkillBase + hitPerFighting × fighting) ×
    rangeFalloff × (target in cover ? coverPenalty : 1) × (target moving ? movingTargetFactor :
    1) × (shooter moving ? movingShooterFactor : 1)`, clamped to [0.05, 0.95]; a hit calls
    `applyDamage` with the weapon's severity and type (`stun` under `fire: stun`); a miss emits
    `shotFired { hit: false }`; `expedition.shots` counts. A baton needs adjacency. Fists are a
    `baton` at `hit` 0.5, `graze`.
  - `objective`: `takeTarget` (above), `takeItem` (stand adjacent to the loot post for 2 s; A2
    gives it an item), `breakThem` (every cast guard broken or down).
- `los.ts`: `lineOfSight(berth, from, to)` by a supercover tile walk (every tile the segment
  touches): blocked by a `wall` tile, by void, or by cover not adjacent to either end; `inCover
  (berth, tile, from)`: a cover tile adjacent to `tile` lies on the line from `from`. Pure over
  the dock def and `core/sites.ts`; unit-tested on the Boathouse rows.
- `morale.ts`: resolve per the config table, applied at each combatant's decision for the
  interval since the last; the thresholds with hysteresis (`waverBelow`, `breakBelow`,
  `recoverAbove`); a party member's base from `crewResolve` (mood from `actor.mood`, leader
  affinity from `affinityOf`, `systems/social/relationships.ts`); a cast member's from
  `resolveTiers[tier]` with `tie`: `paid` × 0.8, `bound` × 1, `devoted` × 1.25 (capped 1). The
  party's `withdrawWhen` is checked here: `firstDown` on the first party member `down` or
  `dead`, `halfDown` at half the party; `withdrawParty` (the command, or the rule) puts every
  party member in `breaking` toward the ramp, and the expedition resolves `partyWithdrew` when
  all alive are aboard.
- `expedition.ts`: the phases; resolution (`targetTaken` when the objective is held and the
  party, the target and the carried are at the ramp foot or aboard; `targetFled` when the target
  reaches the exit; `partyRouted` when every party member is `down`, `dead` or aboard having
  broken; `timedOut` at `maxFightSeconds`); `expeditionResolved` with the tally; the alert
  cleared `alertClearSeconds` later; the thoughts and memories (`killedSomeone` for a shooter
  whose hit killed, `sawCrewHurt` for a party member in sight of a `wounded` ally, `heldTheLine`
  for every party member not broken at a `targetTaken`, `ranFromAFight` for one who broke,
  `foughtBeside` pairwise among the party, `carriedMeOut` and `leftMeBehind` from rescues and
  from an incapacitated party member left on the floor at resolution); `fight` activities
  cleared and the planner given everyone back; the cast's survivors walk to the exit and are
  removed; the dead stay on the floor until `detachDock` (A2 says what then; A1 removes them
  at resolution with a `trace` event). `state.expedition` stays, `resolved`, until a new
  command replaces it.
- `view/planMenu.ts`: the cross product pruned (§8.4): every posture × `lethal`/`stun` ×
  `everyone`/`armedOnly`/`blastersOnly`/`smallTeam`, `holdFire` only with `bait` and `creep`;
  `available` and `why` from the roster (fit, awake, aboard, not the helm or gangway), the
  locker's weapons, the site's posts (`flank` needs a `flank` post and four fit; `creep` needs
  nobody noticed yet; `bait` needs two fit) and the phase (after contact `creep` and `bait` are
  out); at most eight shown: the default pair first, then by posture order, dropping squad
  variants that pick the same people. Pure over state and content, re-derived at apply.
- Tests (`command.test.ts`, `muster.test.ts`, `combat.test.ts`, `los.test.ts`,
  `morale.test.ts`, `expedition.test.ts`, `view/planMenu.test.ts` on the Boathouse fixture, seeds
  fixed): the command refuses an unknown site, a port that is not a site, a ship under way,
  anyone on the dock, seven cast, four armed, two targets, a post of the wrong kind, a plan the
  menu does not hold; after it the ship is docked at the site with the Boathouse alongside and
  the hub's locals gone; `everyone` musters nine minus the helm and gangway, three with
  blasters and two with batons, and the walk ends at (38, 20); `armedOnly` musters five; lines
  of sight through the east door and not through the north wall, the net racks block from
  across the shed and not from beside them, crates on the apron give cover against a shot from
  the shed; `assault` against the default cast reaches contact within 15 s and ends under 45 s;
  `hold` against `hard`/`devoted` ends `targetFled` more often than not over ten seeds, and
  against the default cast ends `targetTaken` with fewer party wounds than `assault` over ten
  seeds; `flank` applies `outflanked` to both guards; `creep` against the `shaky` cast reaches
  the target unnoticed in at least half of ten seeds; a `paid` guard breaks before a `devoted`
  one under the same fire; `firstDown` withdraws the party on the first casualty; a rescuer
  drags a down ally to the ramp and the ally gets `carriedMeOut`; a killed guard gives the
  shooter `killedSomeone`; the planner never plans a combatant mid-fight and plans them again
  after; resolution clears the alert a minute later; `planMenu` marks `flank` unavailable with
  three fit and says why.
Done when the sim suite is green and a headless run on the fixture plays each posture to a
resolution with the events in order and no invariant violation.

**W3 — Content tools and the instrument.** Owns `packages/content/src/schemas/validate-dock.ts`
(+ test; the site branch only: the gate lands the schema), `apps/cli/src/render-dock.ts`,
`apps/cli/src/expeditions.ts` (new, + test), `apps/cli/src/index.ts` (the `expeditions`
dispatch line).
- `validate-dock.ts` site branch: for `kind: "site"` skip the gate/warehouse/stall reachability
  and the areas requirement; keep the grid, size cap, quay row, landings, posts-on-floor and
  reachability-from-the-landing rules; require one `target`, one `exit`, at least one `guard`;
  a `flank` post's route to the target disjoint from the landing's route south of the apron
  except the target's neighbours (BFS over `dockWalkableMask`, which already excludes
  non-floor, so `cover` is excluded as a wall is); `noticeRadius` under the map's width;
  `defaultCast` posts existing and of the right kind, within `SITE_LIMITS`. For `kind: "dock"`
  the site kinds are allowed on posts and ignored.
- `render-dock.ts`: `cover` drawn as `c`/`n` by the legend's own character, site posts in the
  post list with their kinds, the default cast listed under the map.
- `expeditions.ts`: the instrument (below), a generator drained with `yielding.ts` like
  `runBeats`, so its test turns the event loop.
- Tests: the Boathouse validates; a site without an exit, with a flank post whose route shares
  a shed tile, with a cast of seven, with a target at a guard post, each fails with a readable
  message; a dock with a `bench` still validates; `render-dock` output for the Boathouse matches
  the README; the instrument's test runs two plans against the default cast for `--n 4` on two
  seeds under the per-test timeout and prints the table.
Done when the content and CLI suites are green and `crew expeditions` prints a table for the
default cast with W2 merged (before that, on the gate's stub, it prints zeros without error).

**W4 — Web: the fight on the phone.** Owns `apps/web/**` except `worker/registry.ts` (the
gate's).
- `render/dockArt.ts`: `cover` tiles drawn as net racks or crates by the legend character's
  palette (`n` dark lattice, `c` the crate glyph `crates.ts` already draws); a `kind: "site"`
  map gets no quay structure, clamps or bay walls (`dockShape.ts`, `scenery.ts`: the planet pad
  look (§dock-drawing) with the site's sky); site posts drawn as a small marker only when tapped.
- `render/shots.ts` (+ test): a tracer line per `RenderShot`, keyed by tick so it plays once at
  playback, 120 ms, a flash on `hit`. `render/draw.ts`: `actorDotColor` adds a rim for
  `side: "them"` (never crew gold; the local-dot rule of §locals-and-props), a dimmed dot for `down`, a cross
  for `dead`; the action label from `actionLabel` as now.
- HUD: the shore header in `ui/Headline.tsx`'s row while `frame.expedition` is set: "Us: steady
  · Them: breaking"; the alert tint reused. `ui/Inspector.tsx`: a body line per person
  ("wounded: right leg (serious), bleeding"; "stunned"; "unhurt") from the snapshot's
  `self.body` and the actor's wounds; a tapped site post shows its name and kind.
- Dev start: `App.tsx` reads `?expedition=<siteId>[&plan=<planId>]` in `import.meta.env.DEV`
  and, after the worker's `load`, posts `scenarioStartExpedition` through the existing command
  message; nothing in production builds.
- Slow-down: nothing in code (`host/slowdown.ts` reads config).
- Test pins: `fullSim.test.ts` and `integration.test.ts` register nothing new (the registry
  does); `playback.test.ts` interpolation (`shots` accumulate; `expedition` snaps to `next`).
Done when the web suite is green and a browser run at 390×700 with `?expedition=port.boathouse&
plan=assault-lethal-armed` shows the muster, the walk, dots in cover with labels, tracers, a
hit flash, someone wavering, a guard running for the jetty, the header word changing, and the
log lines; and the same with `hold-lethal-armed` visibly different.

**W5 — Narrator and CLI pins.** Owns `packages/narrator/**` (after the gate's `isSite` filter
lines, which it keeps), `packages/server/src/routes/narrator*.test.ts`, `apps/cli/src/beats.ts`
and `beats-field.ts` (no change expected; the registry line is the gate's).
- The digest's crew lines gain a body phrase ("wounded in the leg", "down") from `Actor.body`
  so the narrator never narrates a whole person as hurt or the reverse (`watch-digest.ts`'s
  crew line builder); no prompt text changes (the prompt version stays); `capabilities.test.ts`
  asserts the site port is absent and the six ports present; `run.test.ts` and
  `kernel-integration.test.ts` on regenerated fixtures.
- `crew beats` and `crew pacing` must not see the Boathouse: `VoyageScript` uses fixed ports;
  a test that lists ports from content gets the `isSite` filter.
Done when the narrator, server and CLI suites are green and `pnpm test:live` is not needed (no
prompt change); the lead runs it anyway once if the fixture regeneration touched a hook line.

## The `crew expeditions` instrument

`crew expeditions [--site <portId>] [--plans <ids|all>] [--casts <default,shaky,hard|all>]
[--n <fights>] [--seeds <a-b|list>] [--json]`. Defaults: `port.boathouse`, `all` (the menu's
default-pair plus every available posture under `lethal`/`armedOnly`, and `assault-stun-armed`),
`all`, `n` 20, seeds 1–5. For each (plan, cast, seed, i): `createWorld` on the default scenario,
`scenarioStartExpedition { siteId, cast, plan }` at tick 0 (the `shaky` and `hard` casts are
the Boathouse default with the overrides in "The Boathouse"), advance until
`expeditionResolved` or `maxFightSeconds` past contact plus the muster, record. The run never
calls the narrator (no hook is raised at a site in A1) and answers nothing.

Metrics per (plan, cast), over `n × seeds` fights: outcome mix (`targetTaken`, `targetFled`,
`partyWithdrew`, `partyRouted`, `timedOut`) as shares; seconds from `expeditionContact` to
resolution, mean/min/max; muster-to-contact seconds; wounds per fight per side by severity;
incapacitations and deaths per side as rates per fight; how the fight ended (`broke`: every
remaining cast fled or surrendered; `attrition`: all down; `objective`; `withdraw`; `timeout`);
cast fled and surrendered shares; shots fired and the hit rate per side; party members who
wavered and who broke (rates); the ticker's notable-or-better lines per fight. Output is a
table per cast with a row per plan, like `crew beats`'s sections; `--json` dumps the records.

CI: `apps/cli/src/expeditions.test.ts` runs `hold-lethal-armed` and `assault-lethal-armed`
against the default cast, `--n 6`, seeds 1–2, under the 15 s sim timeout rule (each fight is
about 60 s of sim at 20 Hz on the real deck, so twelve fights are a few seconds), and asserts
bounds, not values, so a tuning change inside the bounds never fails it: party deaths per fight
≤ 0.15 for both; party wounds per fight for `hold` ≤ 0.75 × `assault`'s; `assault`'s mean
contact-to-resolution ≤ 0.8 × `hold`'s; `assault` ends `targetTaken` in ≥ 60 % and `hold` ends
`targetFled` or `targetTaken` in ≥ 80 % combined; no `timedOut`. Seeded, so repeatable; not a
determinism claim (D4), only that the same code and seed give the same fight, which `sfc32` and
no `Math.random` already guarantee.

The tuning loop (lead, integration step 6), one knob at a time, re-running the instrument:
- `hold` and `assault` look the same: raise `coverPenalty` toward 0.35 (cover matters more) and
  `movingShooterFactor` down (assault costs accuracy), or widen `hold`'s cover band.
- Deaths too common: lower `partTable.head`, raise `tolerance.torso`, or make a blaster `grave`
  only on a head hit (change `severityDamage` or the weapon's `severity`); raise
  `bleedStopsAfterSeconds.grave` only if bleeders die at the ramp.
- Fights end by attrition rather than breaking: raise `morale.hitSelf` and `allyDown` in
  magnitude, lower `breakBelow` less, or lower `resolveTiers.steady`.
- `creep` never works: raise `noticeRadius` on the map (it is authored) or widen the apron.
- Fights too long: shorten `aimSeconds`, raise `hit`; too short: the reverse.
- The party breaks too easily: raise `crewResolve.base`; the cook wavering at the first shot is
  wanted, Dane doing so is not.

## Integration order

1. **Gate** on `expeditions-a1`: the four checks; `crew content validate`; a browser smoke run
   (no expedition: the locker on the wall, nothing else changed).
2. **W1** (bodies): the four checks; a headless wound on the bodies fixture.
3. **W2** (the fight): the four checks; the Boathouse fixture plays every posture.
4. **W3** (validator, render-dock, instrument): the four checks; `crew expeditions` prints the
   table; the README regenerated.
5. **W4** (web): the four checks; browser at 390×700 and 1280×800 with both default plans.
6. **W5**: regenerate `packages/narrator/fixtures/*` with `crew narrator fixtures` (schema 12 →
   13, bodies whole, the locker), then the four checks.
7. **Tuning commit (lead):** `crew expeditions --n 20 --seeds 1-5` on all three casts, against
   the targets: party deaths per fight under 0.1 on the default cast and under 0.25 on `hard`;
   `assault` under 45 s, `hold` under 90 s; at least 60 % of fights ending by breaking on the
   default cast; `hold` versus `assault` differing by the CI margins with room; `creep` reaching
   the target unnoticed in half the `shaky` fights. Numbers into the fight's spec section.
8. The decision entry and spec sections (closing section), `README.md` line ("the ship can
   set down at a site and the crew go in after someone, with blasters and a plan"), deploy via
   the `ops` agent (a preview: the default game is unchanged, but the schema bump is live), and
   the playtest checklist below.

## Risks and hidden coupling

- **Hot files with one owner and gate stubs**: `planner/select.ts`, `systems/work/work.ts`,
  `systems/work/plans.ts`, `labels.ts`, `systems/needs/needs.ts`, `core/render.ts`,
  `view/agentView.ts`, `core/world.ts`, `core/migrations.ts`, `core/invariants.ts`,
  `core/command-handlers.ts`, `packages/narrator/src/lookups.ts` and `capabilities.ts` (the
  filter lines), the registries. Streams reach them only through their own files.
- **W2 calls W1 at one point**: `applyDamage`. The gate's stub throws, so W2's combat tests run
  on a fixture that installs a test double (`fixtures/boathouse.ts` takes an `applyDamage`
  option; the default is W1's once merged). W2 reads bodies only through `availability` and
  `Actor.body.wounds.length`.
- **The dock swap under scenario authority** is the only code that detaches a dock while
  docked. `detachDock`'s refusal (a ramp down, anyone on the floor) is honoured by shutting the
  ramps first and by the precondition; `rebuildNav`/`checkDockGraft` run on attach as travel's
  docking does. A save made mid-expedition restores with the site alongside and the invariant
  holds because `travel.portId` is the site. The web's `playback` and the camera read
  `frame.dock` as for any dock.
- **Two actors in one tile** are allowed by spatial (overlap slows); combat never needs
  exclusion. A dead actor on the floor is `onDeck` and drawn; A1 removes them at resolution.
- **The planner and the combat system**: `continue` for `fight` is the whole handshake. If an
  `immediateSurvival` candidate (a starving fighter) ever had to win, it does not: the fight is
  at most two minutes. The gate's `select.ts` rule is checked by a test that a hungry combatant
  keeps fighting.
- **Fatigue and bodies write one field** through one function (call 5); the invariant that
  `capacities === applyCapacities(actor)` after every tick is cheap and in `core/invariants.ts`.
- **Line-of-sight cost**: at most eight combatants, decisions twice a second each, a 44-cell
  walk per pair: under 2,000 cell reads a second. Shots add one walk each. Nothing is cached;
  if a phone profile shows the combat system above 1 ms a tick, cache LoS per (from, to) tile
  pair for the tick.
- **Test-suite time**: the Boathouse fixture is the real Mk2 and the real map, about 2 s a
  fight at 20 Hz; W2's seeded ten-fight tests give themselves `{ timeout: 15_000 }` and sum to
  under a minute in the sim project; the instrument's test is small-N and drained with yields.
- **Stable tests without determinism as a goal**: seeds are fixed and assertions are bounds over
  several seeds, never a single fight's exact event list; a test that pins an exact tick of
  contact is wrong by construction.
- **Counts and literals pinned in tests**: ports 6 → 7, docks 6 → 7, machines 21 → 22, items
  20 → 22, thoughts 27 → 32; `contracts.test.ts` authority; the narrator's "six ports" wording
  (the filter keeps it true); `fullSim.test.ts`'s seed if the locker's threshold draw shifts
  the `failures` stream (as the intercom panels did).
- **`people.ts`'s `ports` record**: if `checkPeopleReferences` requires an entry per port,
  `port.boathouse` needs an empty one or the rule skips sites; the gate finds out.
- **The arms locker's tile on Mk2**: the cross-passage is the busiest corridor; the locker's
  `use` tile must not be a chokepoint tile two people need at a bell. The lead checks the
  README's interaction tiles and moves it to the airlock's north wall if the passage is tight.
- **Old saves and the locker**: the migration instantiates one placement; `instantiateDeck`'s
  per-placement path must exist as a function the migration can call for one key, which the
  gate extracts (`instantiatePlacement`).
- **Captain death and the game**: `commandActor` falls back to the first officer; the
  departure gate, `captainIsIdleAt`, `lookForWork` and the card perspective all go through
  `isFitForCommand` and `commandActor` already. A dead captain's `availability: "dead"` is
  what `agentView.ts`'s roster already filters. One test in W1: with the captain dead, the
  first officer is the command actor and the ship still raises `captainAshore` at the next
  docking.

## Phone playtest checklist (A1, 390×700, 1×)

1. `?expedition=port.boathouse` with no plan: the ship sits on the shingle pad, the shed and
   jetty read as a place, Corran at his bench, Hesk at the east door with a blaster, Darrow
   inside the west door, Old Pell by the nets; the camera fits ship plus map.
2. With `plan=assault-lethal-armed`: the muster at the locker is visible as "arming" labels;
   the party walks down the ramp; "Shots at the boathouse" in the log at contact; tracers; the
   header reads "Us: steady · Them: steady" then changes; a hit flash; a guard runs for the
   jetty with "running"; Corran taken; the party back at the ramp; the alert tint clears.
3. With `plan=hold-lethal-armed`: the party fans out behind the crates and the skiff and
   stays; fewer tracers from us; Corran slips out along the jetty more often than not; the
   difference from 2 is plain without reading a number.
4. With `plan=assault-stun-armed`: the same fight with nobody dead at the end.
5. With `plan=flank-lethal-armed`: two groups, the small one round the west end; both guards
   waver when it appears.
6. Tap a wounded crew member: the inspector's body line; watch them walk slower afterwards.
7. The ship's log at the end tells the fight in under fifteen lines.
8. Fast-forward drops to 1× at contact and at a death.

## Decision and spec for A1

- **Decision (the next `D<n>` in `docs/DECISIONS.md`).** The owner's rulings on
  `docs/design/expeditions.md` (§13 items 1–4): a site is a landing the ship sets down at; crew
  and the captain can die, rare, never scripted, command to the first officer; kill jobs from
  the start, rare and dirty; the captain leads. The delegated calls of §13 items 5–16 stand as
  the design's.
- **Spec, new `docs/spec/expeditions.md`.** Bodies and arms: `Actor.body` at SD §12's minimum
  with one damage entry point, capacities from wounds composed with fatigue through one
  function, incapacitation and death by threshold, stun as a wound type; weapons as items, the
  Mk2 arms locker, `fighting` as the seventh skill; `PortDef.kind: "site"` and
  `DockDef.kind: "site"` with cover tiles and site posts, and the Boathouse (calls 1, 5, 7, 8
  and 13). The fight: the combat system owns its combatants; the seven actions, lines of sight
  and cover, hits and wounds; morale as the resolution currency; the five postures, fire and
  squad rules; the plan menu written by the sim; `scenarioStartExpedition` (calls 3, 6, 9, 11
  and 12, with the tuning numbers from integration step 7).
- **Spec, existing files.** Save schema 13 and the `crew expeditions` instrument with its CI
  bounds in `architecture.md`; the site look and the fight on the phone in `client.md`; the
  narrator's blindness to sites until A2 (call 4) in `narrator-story.md`.

## Phase A2 (tonight's slice): one errand, end to end

### Scope

A real player reaches the fight and comes home paid, with nothing the owner has not ruled on:

- `Job.errand` (§6): `fetchPerson` first, `fetchItem` as W1's stretch; `wants` accepted for both.
  The narrator offers it through `offerJob`'s new errand fields and sees every authored site in a
  "Sites" section of the capability block; pay is a new `commerce.priceBands.errand` band over the
  path to the site and back.
- Known sites on the graph (§3.2): a site is reachable while an errand names it and while the ship
  is at it. Accepting sets course to the site; a far near-port is a voyage (D49).
- Landing and lift-off at a site (§3.3, §3.5): no fee, no staging call, no `captainAshore`
  (already so), the headline says "Setting down at" and "Lifting off from".
- The site dressed from the map's `defaultCast` with the errand's target name on the target entry.
  The expedition starts itself the tick the ship is docked there, with no plan.
- Two kernel policy cards dressed by the narrator on the existing `policyDecision` hook
  (§policy-decision-cards): the **arrival card** (two plans from the menu, the default pair when
  both are available, brought by the first officer) and the **turn card**, once a fight, at the
  first side to break or the first party member down ("Press on" / "Pull back to the ship").
- Resolution settles the errand: a target taken alive boards as a passenger with their own name
  (the captive, §6), a target dead counts as brought dead when the job wanted that, anything else
  fails the job with a new `jobFailed` event; the sim sets the voyage home; the captive walks off at
  the return port and the job is paid as a passage is (`contractCompleted`, the closing card, D54).
- Two sites: the Boathouse (A1, off Tern's Rest) and **the Meridian site**, authored tonight by a
  content agent in parallel (a planet pad, `nearPortId: port.green_meridian`, one route of about 20,
  its own port and dock ids under `packages/content/data/{ports,docks}/`), so a first errand from
  the Hub is 65 of transit away and not 420. Every stream works for any site: nothing names
  `port.boathouse` outside the Boathouse's own tests and the instrument's default.
- A deep episode test on the null narrator, the spec sections, a prompt bump with one live run.

### Non-goals (deferred to the morning's ruling), each with why

- **`stageSite`, cast tiers, the target's stance, scripted turns (§5.2, §9.2, §9.3):** a new entry
  in `NARRATOR_COMMAND_KINDS` is a lever, and D6 says adding one is the owner's decision; D103
  records only §13's rulings 1–4. The default cast is the design's own fallback, so the episode is
  whole without it.
- **Parley (§9.1) and the approach effect (§9.4):** parley is a new player command that spends the
  ship's money (D6 names money); the approach effect is a new card-side effect in the narrator
  schema. Both are range, not the spine.
- **The narrator choosing which two plans (§8.4, design call 12):** needs `expeditionArrived` as a
  story hook (design call 15, with a D43 exception for its fallback). Tonight the sim writes the
  pair and the narrator voices it; the story hook can replace the policy card later without a state
  change (see call 4).
- **The body item and `sawTheBody` (§6):** a `fetchPerson` brought dead pays with no corpse in the
  hold; the item belongs with phase B's medicine.
- **The intercom `fightSeen` fact, a cast member walking to the ramp (§3.4):** colour, not spine.
- **`cameWillingly` as an outcome:** it is parley's.
- **Port `heat`, `rampsUp`, a station site:** C.

### Calls made against the code (A2)

1. **Known sites include offered errands.** `surfaceOfferCard`'s accept side runs `acceptContract`
   then `setCourse`, and `resolveDecision` validates both before applying either, so `setCourse`
   sees the job still `offered`. `knownSites(state)` (`core/places.ts`) is therefore the `siteId` of
   every errand whose status is `offered`, `accepted` or `inTransit`, plus the port the ship is
   docked at or heading for when it is a site. An offer that expires or is declined drops its site
   again; nothing can be under way to it then.
2. **One graph function, two modes.** `portGraph(content, state, mode)` in `core/places.ts` returns
   a ports record whose near ports carry an extra route to each site: `"known"` adds the known
   sites, `"all"` every authored site. Every caller that today passes `content.ports` to
   `shortestPath` or `nextHop`, and both places that read `fromPort.routes` directly (`findRoute` in
   `systems/travel/travel.ts`: `beginDeparture` and `advanceStage` to `transit`), go through the
   `"known"` graph; without that the leg to a site has `routeDistance 0` and the ship arrives the
   tick it leaves. Price checks (`bandRoute` in `systems/commerce/jobs.ts`, the narrator's
   `pathBetween`) use `"all"`, since the site is not known until the offer exists.
3. **The accept side sets course to the site.** `surfaceOfferCard` (`systems/commerce/jobs.ts`)
   writes `setCourse { destinationPortId: job.errand.siteId }` for an errand; `toPortId` is the
   return port and equals `fromPortId`, which `setCourse` would refuse as "must differ".
4. **The arrival and turn cards are policy decisions, not story hooks.** `queuePolicyDecision`
   (`core/decisions.ts`) with prompt keys `expedition.arrival` and `expedition.turn`; the record
   carries no `jobId` (a decision with one never gets its `policyDecision` hook,
   `headNeedingNarration`) and names the job in `prompt.params`. The world halts on the hook before
   the card shows, so the fight holds while the narrator writes, and a failed call follows D43's
   retry and error panel instead of the design's template exception. Reversal later: an
   `expeditionArrived` story hook whose card carries `adoptPlan` sides; `Expedition.cards` keeps
   the decision ids either way.
5. **`settleErrand` runs before `castAfter`, and the captive loses `combatant`.** In
   `systems/expedition/expedition.ts` `resolve()`, `settleErrand(fight, outcome)` is called after
   `afterTheFight` and before the party/cast loop. It deletes the taken target from `state.actors`
   and spawns the captive as a fresh `crew.passenger` actor (no `combatant`), because `castAfter`
   removes a taken target and `aftermath()` removes every actor that still has a `combatant` once
   the expedition is `resolved`.
6. **One pay-band function.** `errandPay(config, distance, tier)` lives in `packages/sim`
   (`systems/commerce/errand.ts`, exported from `@crew/sim`) and both `checkErrandBand` (kernel)
   and the translator (`payFor`'s errand case) call it; `translate.test.ts` pins that the kernel
   accepts the translator's pay for each tier on the real content, as the passenger fare is pinned.
7. **Schema-size discipline.** `plan.test.ts` holds the plan schema to 8 KiB. The five new
   `offerJob` fields get descriptions of at most eight words each, and the capability block (not the
   schema) explains them; if the budget still trips, `errandKind` and `wants` become two-value enums
   plus `""` and the descriptions go.
8. **Lift-off from a site must not reach the port's store.** `castOffDock` (`systems/travel/
   travel.ts`) computes `portStoreLocation(ctx.defs.port(portId))` unconditionally and that throws
   for a port with no external store, so every lift-off would crash at the end of `undocking`. At a
   site `clearDock` is given no store: anything left on the floor (a dropped blaster, a dead cast
   member's items are already gone) is deleted with `leftOnDock` as its event. Dead crew on the
   floor are brought aboard by the existing straggler rule (`bringAboard`); the fiction is thin and
   the spec says so.
9. **No staging call at a site.** `stageDockIfDue` returns at once when `toPortId` is a site, and
   `stagingAnswered` answers true for one (both in `systems/travel/staging.ts`); with only the
   first, transit holds at the end of the route for ever. The site is dressed with the (empty) floor
   set by `dressDockAlongside` as any dock is; the cast are the expedition's, not locals.
10. **Config arrays and old saves.** `jobFailed` joins `narrator.hookOnEvents` and
    `expeditionResolved` joins it too; config filling adds missing keys but never merges arrays
    (§notable-event-hook), so games saved before tonight get neither hook, while
    `priceBands.errand` fills. No schema bump: `Job.errand`, `Expedition.jobId` and
    `Expedition.cards` are optional.
11. **A captive put off is a failed job already.** `endPassageEarly` (`systems/commerce/passage.ts`)
    sets `job.status = "failed"` for any passage ended early, so an `endPassage` side on a card
    about the captive fails the errand with no new code; W1 pins it and `settleErrand` writes
    `errand.outcome: "failed"` when the passage ends other than `completed`.
12. **The expedition starts itself.** `startExpedition(ctx, plan)` (`systems/expedition/start.ts`,
    extracted from `command.ts`'s apply minus the dock swap) is called by `scenarioStartExpedition`
    as before and by the expedition system on the first tick the ship is `docked` at a site with
    its site map alongside and an `inTransit` errand naming it whose `outcome` is unset
    (`landedForErrand`). `Expedition.jobId` is set only on that path, so the A1 instrument and
    every A1 test are unchanged.
13. **The cast is the map's, with the errand's name on the target.** `castFor(job, site)`
    (`start.ts`) copies `site.defaultCast` and sets the one `target` entry's `name` to
    `errand.targetName`; for `fetchItem` the cast is untouched and the item is spawned at the `loot`
    post. Caps and posts are the same checks the command runs.
14. **The null narrator never offers an errand** (its `captainAshore` answer stays the port's
    `jobTemplates`), so the default offline game is unchanged; the deep episode test and the
    fixtures make the offer with a scenario `offerJob` carrying `errand`. The null narrator still
    dresses the two new policy cards with their templates.
15. **The turn card is once a fight and only in the fight.** Queued the tick of the first
    `combatantBroke` of either side or the first party member `down` or `dead`, while
    `phase === "fight"` and neither `objectiveTick` nor `withdrawTick` is set; never again that
    expedition. `withdrawWhen` still fires on its own.

### Gate (one agent, serial)

All four checks green, `crew content validate` clean, every existing test literal fixed. Stubs are
named functions in files their stream owns. After the gate no stream edits `core/types/**`,
`core/places.ts`, `core/render.ts`, `core/decisions.ts`, `systems/travel/**`,
`systems/commerce/jobs.ts`, `systems/commerce/command-handlers.ts`, `systems/expedition/command.ts`,
`packages/content/src/**`, `packages/content/data/config/**`, `packages/narrator/src/contract.ts`
or `docs/CONTRACTS.md`.

**Sim types.**

- `core/types/travel.ts`: `ERRAND_KINDS = ["fetchPerson", "fetchItem"]`, `ERRAND_WANTS = ["alive",
  "either", "dead"]`, `ERRAND_OUTCOMES = ["broughtAlive", "broughtDead", "broughtItem", "failed"]`;
  `JobErrand { kind: ErrandKind; siteId: PortDefId; targetName: string; itemDefId?: ItemDefId
  (fetchItem only); wants: ErrandWants (fetchItem: "either"); returnToPortId: PortDefId; outcome?:
  ErrandOutcome }`; `Job.errand?: JobErrand`. `core/types/commands/commerce.ts`: `JobDraft.errand?:
  Readonly<Pick<JobErrand, "kind" | "siteId" | "targetName" | "itemDefId" | "wants">>`
  (`returnToPortId` is `fromPortId`; `toPortId` must equal it).
- `core/types/state.ts`: `Expedition.jobId?: JobId`; `Expedition.cards?: { arrival?: DecisionId;
  turn?: DecisionId }`.
- `core/types/content.ts`: `ConfigDef.commerce.priceBands` keyed by `CargoClass | "passenger" |
  "errand"`.
- `core/types/events/commerce.ts`: `jobFailed { jobId: JobId; outcome: ErrandOutcome |
  PassageEndReason }`, significance `narrative`.
- `core/places.ts`: `knownSites(state)`, `portGraph(content, state, "known" | "all")`,
  `siteNearPort(content, siteId): PortDefId | undefined` (calls 1, 2); exported from
  `packages/sim/src/index.ts`.
- `core/render.ts`: ticker `jobFailed` → "The job for Ysolde Maren is lost: Corran Vale got away"
  / "... the party came back without him" / "... <name> was put off" (by outcome; narrative);
  `shipHeadline` reads "Setting down at <site>" on `approaching`/`docking` toward a site, "Lifting
  off from <site>" on `undocking`/`departing` from one, and "Set down at <site> — lifting off for
  <port>" when docked at a site with a course planned (never "Stopping at").
- `core/decisions.ts`: nothing new; `queuePolicyDecision` is the cards' path (call 4).
  `core/command-actor.ts`: `firstOfficerOf(state)`, moved from `passage.ts`'s private
  `firstOfficerName` (which now calls it), so the cards and the overdue card name the same person.
- `docs/CONTRACTS.md`: the errand is commerce's slice of the job; the expedition system reads
  `job.errand` and writes `outcome` through `settleErrand` only.

**Sim behaviour the gate completes (contract, not stream work).**

- `systems/travel/travel.ts`: `beginDeparture` and `advanceStage` route by `portGraph(…, "known")`
  (call 2); no `dockingFee` at a site; `castOffDock` at a site (call 8).
  `travel/command-handlers.ts` `setCourse`: `shortestPath` over the known graph.
  `travel/staging.ts`: call 9. `continueVoyageIfFree` over the known graph.
- `systems/commerce/jobs.ts`: `checkErrandBand(ctx, fromPortId, siteId, pay)` (distance = the
  `"all"` graph's path to the site and back, through `errandPay`, W1's file, gate-stubbed to the
  passenger formula so the number is right from the start); `surfaceOfferCard` call 3 and
  `offerPromptParams` gains `errand`, `target`, `site`, `wants` when the job has one; `jobFulfilled`
  takes `Pick<state, "items" | "deck" | "travel">` and, for a job with `errand`, returns
  `errandFulfilled(state, content, job)` (stub: false) unless the job has a passage (the passage
  rule stands). `command-handlers.ts` `offerJob`: an errand needs `toPortId === fromPortId`, a known
  `siteId` that `isSite`, a near port reachable from `fromPortId`, non-empty `targetName`,
  `itemDefId` an existing item iff `fetchItem`, `wants` in the enum, cargo empty, and the errand
  band; apply copies `errand` with `returnToPortId: fromPortId`.
- `systems/expedition/`: `start.ts` (new; owner W2) with `startExpedition(ctx, plan: StartPlan)`
  extracted from `command.ts` (which now calls `swapToSite` then `startExpedition`), plus stubs
  `landedForErrand(ctx): void` (no-op) and `castFor(job, site)` (returns `site.defaultCast`);
  `cards.ts` (new; owner W2) with stubs `queueArrivalCard(ctx, expedition)` and
  `queueTurnCard(ctx, fight)` (no-ops); `errand.ts` (new; owner W1) with stubs `settleErrand(fight,
  outcome)` (no-op) and `errandFulfilled` (false); `expedition.ts` calls `landedForErrand` at the
  top of `run` when there is no expedition or it is `resolved`, `queueArrivalCard` from
  `startExpedition` when `plan` is absent and `jobId` is set, `queueTurnCard` after `runCombat`, and
  `settleErrand` in `resolve()` (call 5). `systems/commerce/errand.ts` (new; owner W1):
  `errandPay(config, distance, tier)` and `PAY_TIER_FRACTION` (0.15, 0.5, 0.85, today a private
  constant of the narrator's `lookups.ts`), both exported from `@crew/sim`; W3 makes `lookups.ts`
  re-export the sim's so the two cannot drift (the narrator imports the sim, never the reverse).

**Content (`packages/content`).**

- `schemas/config.ts`: `priceBands.errand: band`. `data/config/default.json`: `"errand": { "min":
  6, "max": 12 }` (per unit of path distance there and back; W1 tunes against the Hub → Meridian
  site run so an errand pays about one and a half plain freight jobs); `narrator.hookOnEvents` +
  `jobFailed`, `expeditionResolved`.
- `src/templates.ts`: `job.offer` renders an errand ("bring back Corran Vale from the Boathouse,
  alive" / "fetch the strongbox papers from …"), title "A job: Corran Vale"; `expedition.arrival`
  (situation "<speaker> at the ramp head: Corran Vale is at the Boathouse, two of his people with
  him. Hold the ramp, or go in?", speaker from `params.speaker`, title "At the Boathouse"), sides
  `expedition.arrival.left` / `.right` rendered from `params.leftLabel` / `rightLabel` ("Hold the
  ramp from cover", "Go in and take them") with `.aftermath` from `params.leftWhy` / `rightWhy`;
  `expedition.turn` ("<speaker>: <name> is breaking. Press on, or pull back?"), sides
  `expedition.turn.press` "Press on" / `expedition.turn.withdraw` "Pull back to the ship" and their
  `.aftermath`. `SPEAKERS` and `TITLES` entries for both keys.
- Nothing under `data/ports` or `data/docks`: the Meridian site is the content agent's, in flight.

**Narrator (`packages/narrator/src/contract.ts` only).**

- `offerJob` gains `errandKind: z.enum(["", ...ERRAND_KINDS])`, `site: idOf("Site id")`,
  `targetName`, `targetItem: idOf("Item id")`, `wants: z.enum(["", ...ERRAND_WANTS])`, every one
  empty for freight and passages (§narrator-authority), descriptions under eight words (call 7).
  Every `offerJob` literal in `translate.test.ts`, `null.test.ts` and the fixtures' expected plans
  gains the five empty fields; the translator ignores them until W3 (empty strings translate as
  today).

**Tests the gate fixes:** `contract.test.ts`/`plan.test.ts` size; `translate.test.ts` literals;
`loader.test.ts`/`schemas.test.ts` only if the Meridian site has landed on `main` first (then ports
8, docks 8); `commerce` price-band tests for the new key; `render.test.ts` headline cases.

### Workstreams (parallel after the gate)

No two streams edit the same file. `packages/content/data/**` is the content agent's (new site
files) and the lead's (config, templates at integration); `packages/narrator/fixtures/*` and
`docs/spec/**` are the lead's.

**W1 — Sim: the errand.** Owns `systems/commerce/errand.ts`, `systems/commerce/passage.ts`,
`systems/expedition/errand.ts`, `systems/commerce/fixtures-errand.ts` (new: the real bundle, docked
at a port with an errand offered by a scenario command, helpers to accept, land and resolve by
command), their tests.
- `errandPay` and `checkErrandBand`'s number (gate stub replaced); `errandFulfilled`: `broughtDead`
  when docked at `toPortId`; `broughtItem` through `deliveryComplete`; `broughtAlive` is the passage
  rule; `failed` never.
- `settleErrand(fight, outcome)` (call 5): the job by `expedition.jobId` (none: return); the target
  by `disposition.part === "target"`. Outcome: `targetTaken` with the target alive → `broughtAlive`;
  the target dead → `broughtDead` when `wants` is `dead` or `either`, else `failed`; `targetFled`,
  `partyWithdrew`, `partyRouted`, `timedOut` → `failed`; `fetchItem` → `broughtItem` on
  `targetTaken`, else `failed`. Writes `errand.outcome`; on `failed` sets `job.status = "failed"`,
  `closedTick`, emits `jobFailed`; sets `travel.voyageDestinationId = returnToPortId` whatever the
  outcome (the ship goes home; D49 plans the hop once nothing holds it).
- `spawnCaptive(ctx, job, target)` in `passage.ts`: `newActor` from `crew.passenger`, `name` the
  target's, on the target's tile, `crew: true`, `passenger: true`, `job.passage = { actorId,
  roundTrip: false, leg: "out" }`, `passengerBoarded`; the cast actor and its carried items go first
  (`removeCast`'s rule, re-stated here so expedition does not reach into commerce's table order).
- `fetchItem` (stretch): the loot item (spawned at the `loot` post by W2's `startExpedition` when
  the errand is a `fetchItem`, as `castFor`'s companion) is moved on `targetTaken` to the ship's
  `cargoStowage` zone tile and recorded as the job's one `cargoItemIds` entry and `cargo` line, so
  `raiseUnloadProblems` and `deliveryComplete` pay it at the return port.
- Tests: the band accepts the translator's pay at each tier (with W3's number, cross-package pin in
  `translate.test.ts` is W3's); an errand accepted at the Hub for the Meridian site sets course via
  Green Meridian and the leg to the site has the authored distance; no fee, no `stageDock`, no
  `captainAshore` at the site; the offer card's accept side validates whole (call 1); a captive
  boards at resolution and walks off at the return port, `contractCompleted` and `paymentMade` once;
  a target who fled fails the job with `jobFailed` and the ship still sets course home; a put-off
  captive fails the job (call 11); lift-off with a dropped blaster on the floor does not throw
  (call 8); `fetchItem` pays at the bay.
Done when the sim suite is green and the fixture plays accept → land → resolve → home → paid by
commands alone.

**W2 — Sim: landing and the two cards.** Owns `systems/expedition/start.ts`, `cards.ts`,
`expedition.ts`, `combat.ts`, `fixtures/landing.ts` (new: the real bundle docked at Green Meridian
with an `inTransit` errand for the Meridian site, then travel to the site by advancing), their
tests.
- `landedForErrand` (call 12) and `castFor` (call 13); `startExpedition` writes `jobId`.
- `queueArrivalCard`: perspective `commandActor`, speaker the first officer (the gate's
  `firstOfficerOf` in `core/command-actor.ts`), prompt
  `expedition.arrival` with params `jobId`, `site`, `target`, `speaker`, `leftPlan`, `rightPlan`,
  `leftLabel`, `rightLabel`, `leftWhy`, `rightWhy`; sides `adoptPlan { planId }`; the pair is
  `hold-lethal-armed` and `assault-lethal-armed` when both are available on `planMenu`, else the
  first two available options, else no card and the expedition resolves `timedOut` at
  `maxApproachSeconds` as now. `Expedition.cards.arrival` set.
- `queueTurnCard` (call 15): speaker the first officer if in the party and up, else whoever leads
  now; left "press" (no commands), right `withdrawParty`; `Expedition.cards.turn` set.
- `combat.ts`: `targetMustLive` (unread today) set from `wants === "alive"` on the adopted plan's
  copy in `adoptPlan`'s apply (W2 may edit `command.ts`'s apply for this one line; the gate notes
  it) and honoured by never firing at the target.
- Tests: docked at a site with its errand the expedition starts once, with the target renamed and
  nobody moving; the arrival card is queued with no `jobId` and its `policyDecision` hook is raised
  the next tick; choosing a side adopts the plan and the muster begins; the turn card appears once
  at the first break and "pull back" withdraws; a `scenarioStartExpedition` run queues no card; the
  arrival card is answered by `adoptPlan` with the ids it carries (both validate at resolve).
Done when the sim suite is green and the landing fixture plays landing → card → fight → resolution.

**W3 — Narrator.** Owns `packages/narrator/**` except `contract.ts`.
- `translate.ts`: `translateOfferJob`'s errand branch: `errandKind` set ⇒ `site` is an authored site
  reachable from `fromPort`'s `"all"` graph, `toPort === fromPort`, `targetName` passes the text
  checks (fetchPerson), `targetItem` is an existing item (fetchItem) and `wants` is empty for it,
  `passenger`/`roundTrip` false, cargo empty; pay by `errandPay` over the round-trip distance; the
  draft carries `errand`. Freight and passages unchanged.
- `capabilities.ts`: a "## Sites" section after the ports: each site under its near port (id,
  name, description, character, the hop count and distance from here through the near port, and the
  default cast in words: "a keeper, two of his people, one with a blaster"); `offerJob`'s text gains
  the errand sentence (an errand is a job to a site: `errandKind`, `site`, `targetName` or
  `targetItem`, `wants`; `toPort` is the port the ship is at; the ship goes, the crew fight, and the
  job pays on the way back; a kill job is rare and its issuer is never clean). `reachLine` and
  `portHereOrNext` measure from a site's near port when the ship is at or heading for a site.
- `digest.ts`: the job line for an errand; `travelLine` "set down at" / "setting down at"; "On the
  dock" becomes "At the site (<name>)" while a site is alongside: each cast member with role, arms,
  where they stand (the post's name) and their visible bearing as a word (`combatant.state`, never
  a number), the party and who leads once there is one, and the two plans on the arrival card with
  their `why`. The "NPCs" line goes.
- `prompts/hooks.ts` `policyDecision`: `expedition.arrival` is brought by the first officer at the
  ramp head, the two sides are the two plans in the order given, the situation shows what the crew
  can see of the site and its people; `expedition.turn` names who broke and what the party is doing.
  `prompts/system.ts`: one errand paragraph (an errand is the kind of story that is about a person;
  who is at the site is the sim's tonight; never state a wound, a death or a capture the digest does
  not show; most expeditions should turn; a kill job is rare and dirty), `PROMPT_VERSION` v0.29.
- `null.ts`: unchanged (call 14). `lookups.ts` `pathBetween` uses `portGraph(…, "all")` and no
  longer excludes sites; the six-port count in `capabilities.test.ts` holds because sites are listed
  under "Sites".
- Tests: the errand offer translates and its pay is inside the kernel's band on the real bundle for
  each tier (call 6); an errand with `toPort` elsewhere, an unknown site, a `fetchItem` with
  `wants`, or `passenger` set is dropped with a reason; the "At the site" section never shows a
  number; the Sites section lists every authored site once; the `policyDecision` instruction names
  both keys.
Done when the narrator suite is green; `pnpm test:live` is the lead's at integration.

**W4 — CLI, web, the deep episode.** Owns `apps/cli/src/expedition-episode.deep.test.ts` (new),
`apps/cli/src/episode.ts` (new: the harness), `apps/web/src/ui/**`, `apps/web/src/render/**`.
- The harness: the real bundle and full registry (`createPacingRegistry`), a scenario `offerJob`
  with `errand` at tick 0 for the authored site nearest the start port by the `"all"` graph (the
  Meridian site when it has landed, else the Boathouse), the null narrator answering hooks and a
  decision policy that takes the offer, picks `hold` on the arrival card and "press" on the turn
  card, as `runBeats` answers cards.
- The deep test: offer → accept → the leg (a waypoint docking at the near port) → landing →
  arrival card → fight → resolution → lift-off → home → paid or failed, under the deep-test timeout,
  with the events in order, no invariant violation, money up on a success, and the ticker telling
  it in under thirty narrative-or-notable lines. Two seeds.
- Web: the offer card for an errand reads from its template (no numbers); the inspector's job line
  names the errand; nothing else is expected (the site look, the shore header and the tracers are
  A1's; `TravelBar` and the scene read ports, and a site is one).
Done when the CLI and web suites are green and the episode runs headless end to end.

### Integration order (A2)

1. **Gate** on `expeditions-a2`: the four checks, `crew content validate`, a browser smoke run (a
   plain freight game unchanged).
2. **The Meridian site** (content agent): `crew content validate`, `render-dock`, its README; the
   lead fixes `loader.test.ts` counts.
3. **W1**, **W2**, **W3**, **W4** in that order, the four checks after each.
4. **Lead:** `pnpm test:live` once (prompt v0.29); regenerate `packages/narrator/fixtures/*` only if
   a fixture's snapshot shape changed (none expected: no schema bump); tune `priceBands.errand`
   against the deep test's balance; the spec sections below; a phone playtest at fast-forward: offer
   at the Hub, the leg via Green Meridian, the landing, the arrival card, the fight, the turn card
   if it comes, lift-off, home, the closing card.
5. **Spec, same commit as the code it describes** (`docs/spec/README.md` rules): `commerce.md`
   "### Errand job" (the shape, the band, the accept side's course, the captive as a passage, pay,
   `jobFailed`); `travel.md` "### Known sites" (the graph rule, call 1) and the landing headline;
   `expeditions.md`: "### Landing sites" loses "no course reaches one yet", new "### Landing and the
   arrival card", "### The turn card", "### Settling the errand", "### Lift-off"; `cards.md`
   "### Policy decision cards" lists the two; `narrator-story.md` "### The narrator and sites"
   rewritten (what it sees and offers, what it still cannot do), "### Offer lever" gains the errand
   sentence, the digest's "At the site" under "### Dock sections"; `narrator-calls.md`
   "### Notable event hook" gains `jobFailed` and `expeditionResolved` with the old-save note.
6. No D-entry: the owner's rulings stand as D103; the policy-card shape is call 4 and reversible.
   The morning's note to the owner: the levers deferred under "Non-goals" and why.
