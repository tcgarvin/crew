/**
 * AgentView builder (SD §4.3; W4a). A read-only facade over one actor's own state, their
 * knowledge, the work tables filtered to what they know, and the static schematic every crew
 * member knows (SD §13.5). Registered with `setAgentViewBuilder`; valid only during the planner
 * call that received it (it closes over live state).
 *
 * What the actor sees:
 * - `self`: body, needs, skills, carried items (truth: they know their own hands), shift status,
 *   retry backoff;
 * - facts: their latest-belief table;
 * - problems: open problems that are `public`, or `discovered` ones they hold a `problem` fact for;
 * - tasks: live tasks of those problems. Claims are public in V1 (W4a decision, see
 *   `systems/work/claims.ts`): `knownClaimantId` is another actor holding a claim;
 * - items: `itemLocation` beliefs joined with the item's static definition;
 * - schematic + roster: static layout and who is aboard with trained skills;
 * - berths (D74): the actor's own bed (`self.berth`) and every assigned bed (`assignedBeds`).
 *
 * W4a decision: `AgentView.tick` is `state.tick + 1`, the tick whose planning phase is running
 * (the same number as `StepCtx.tick` there). The resulting intent is applied by work in phase 3
 * of the following tick. Backoff and blockage `retryAfterTick`s compare against this tick.
 */
import type { Actor, FactType, KnownFact } from "../core/types/actor";
import type { DeepReadonly, TileCoord, TileEdge } from "../core/types/common";
import type { DeckDef, MachinePlacementDef } from "../core/types/content";
import type { ActorId, EntityId, ItemId, MachineId, ProblemId } from "../core/types/ids";
import type { World } from "../core/types/kernel";
import type { DeckGeometry, NavInteractionPosition } from "../core/types/nav";
import type { ReadonlyWorldState } from "../core/types/pipeline";
import type {
  AgentView,
  InventoryEntry,
  KnownItemView,
  MachinePlacementView,
  ProblemView,
  RosterEntry,
  SchematicView,
  SelfView,
  TaskView,
} from "../core/types/view";
import { isOnDuty } from "../systems/needs/shifts";
import { estimateTravelTicks } from "../systems/spatial/estimates";
import {
  compartmentAt,
  hasWall,
  isStaticWalkable,
  rotateOffset,
} from "../systems/spatial/geometry";

type ReadonlyActor = DeepReadonly<Actor>;

const tileOf = (p: { x: number; y: number }): TileCoord => ({
  x: Math.floor(p.x),
  y: Math.floor(p.y),
});

function inventoryOf(state: ReadonlyWorldState, actorId: ActorId): InventoryEntry[] {
  const out: InventoryEntry[] = [];
  for (const item of Object.values(state.items)) {
    const location = item.location;
    const held =
      (location.kind === "carriedBy" || location.kind === "equippedBy") &&
      location.actorId === actorId;
    if (!held) continue;
    out.push({
      itemId: item.id,
      defId: item.defId,
      count: item.stacking === "stack" ? item.count : 1,
    });
  }
  return out;
}

/**
 * D74: the machine of the actor's berth (`state.berths`), on the deck the view is built for.
 * Throws if the key names no machine there, which the needs invariants rule out.
 */
function berthOf(
  state: World["state"],
  actorId: ReadonlyActor["id"],
  deckId: DeckGeometry["deckId"],
): SelfView["berth"] {
  const key = state.berths[actorId];
  if (key === undefined) return undefined;
  return { machineId: bedMachine(state, key, deckId) };
}

function bedMachine(
  state: World["state"],
  key: World["state"]["berths"][ActorId],
  deckId: DeckGeometry["deckId"],
): MachineId {
  const machine = Object.values(state.machines).find(
    (m) => m.deckId === deckId && m.placementKey === key,
  );
  if (machine === undefined) throw new Error(`Berth "${key}" is no machine on ${deckId}`);
  return machine.id;
}

/**
 * D74: the machines of every berth in `state.berths` (see `AgentView.assignedBeds`): one pass
 * over the machines rather than one per berth, with `bedMachine`'s first match and its error.
 */
function assignedBeds(state: World["state"], deckId: DeckGeometry["deckId"]): MachineId[] {
  const byKey = new Map<string, MachineId>();
  for (const machine of Object.values(state.machines)) {
    if (machine.deckId !== deckId || byKey.has(machine.placementKey)) continue;
    byKey.set(machine.placementKey, machine.id);
  }
  return Object.values(state.berths).map((key) => {
    const machineId = byKey.get(key);
    if (machineId === undefined) throw new Error(`Berth "${key}" is no machine on ${deckId}`);
    return machineId;
  });
}

/** Placements by key per deck def; content is immutable, so never stale (first key wins). */
const placementsByDeck = new WeakMap<DeckDef, ReadonlyMap<string, MachinePlacementDef>>();

function placementsByKey(deck: DeckDef): ReadonlyMap<string, MachinePlacementDef> {
  const cached = placementsByDeck.get(deck);
  if (cached !== undefined) return cached;
  const byKey = new Map<string, MachinePlacementDef>();
  for (const placement of deck.machines) {
    if (!byKey.has(placement.key)) byKey.set(placement.key, placement);
  }
  placementsByDeck.set(deck, byKey);
  return byKey;
}

/**
 * Interaction positions by machine, in geometry order, per built geometry. A geometry's positions
 * are fixed when it is built and a rebuild makes a new object, so the entry cannot go stale.
 */
const interactionsByGeometry = new WeakMap<
  DeckGeometry,
  ReadonlyMap<MachineId, readonly NavInteractionPosition[]>
>();

function interactionsByMachine(
  geometry: DeckGeometry,
): ReadonlyMap<MachineId, readonly NavInteractionPosition[]> {
  const cached = interactionsByGeometry.get(geometry);
  if (cached !== undefined) return cached;
  const byMachine = new Map<MachineId, NavInteractionPosition[]>();
  for (const position of geometry.interactionPositions) {
    const list = byMachine.get(position.machineId);
    if (list === undefined) byMachine.set(position.machineId, [position]);
    else list.push(position);
  }
  interactionsByGeometry.set(geometry, byMachine);
  return byMachine;
}

function buildSelf(world: World, actor: ReadonlyActor, geometry: DeckGeometry): SelfView {
  const { state } = world;
  const config = world.config.values;
  const location = actor.location;
  const onDeck = location.kind === "onDeck";
  const tile = onDeck ? tileOf(location) : undefined;
  const compartmentId = onDeck ? compartmentAt(geometry, location.x, location.y) : undefined;
  const berth = berthOf(state, actor.id, geometry.deckId);
  return {
    id: actor.id,
    name: actor.name,
    roleTags: actor.roleTags,
    needs: actor.needs,
    capacities: actor.capacities,
    skills: actor.skills,
    traits: actor.traits,
    mood: actor.mood,
    location: actor.location,
    ...(tile === undefined ? {} : { tile }),
    ...(compartmentId === undefined ? {} : { compartmentId }),
    activity: actor.activity,
    inventory: inventoryOf(state, actor.id),
    onDuty: isOnDuty(actor.schedule, state.tick + 1, config),
    lastPlannedTick: actor.lastPlannedTick,
    ...(actor.workBackoff === undefined ? {} : { backoff: actor.workBackoff }),
    ...(actor.passenger === true ? { passenger: true as const } : {}),
    ...(actor.disembarking === true ? { disembarking: true as const } : {}),
    ...(berth === undefined ? {} : { berth }),
  };
}

function buildSchematic(world: World, geometry: DeckGeometry): SchematicView {
  const { state, content } = world;
  const deck = content.decks[geometry.deckId];
  if (deck === undefined) throw new Error(`AgentView: unknown deck ${geometry.deckId}`);
  let machines: MachinePlacementView[] | undefined;
  const allMachines = (): MachinePlacementView[] => {
    if (machines !== undefined) return machines;
    machines = [];
    const placements = placementsByKey(deck);
    const interactions = interactionsByMachine(geometry);
    for (const machine of Object.values(state.machines)) {
      if (machine.deckId !== geometry.deckId) continue;
      const def = content.machines[machine.defId];
      const placement = placements.get(machine.placementKey);
      if (def === undefined || placement === undefined) continue;
      machines.push({
        machineId: machine.id,
        defId: machine.defId,
        tags: def.tags,
        footprint: def.footprint.map((offset) => {
          const r = rotateOffset(offset, placement.rotation);
          return { x: placement.origin.x + r.x, y: placement.origin.y + r.y };
        }),
        interactionTiles: (interactions.get(machine.id) ?? []).map((p) => ({
          tile: p.tile,
          purposes: p.purposes,
        })),
      });
    }
    return machines;
  };
  return {
    deck,
    isFloor: (tile) => isStaticWalkable(geometry, tile.x, tile.y),
    compartmentAt: (tile) => compartmentAt(geometry, tile.x + 0.5, tile.y + 0.5),
    isWall: (edge: TileEdge) => hasWall(geometry, edge, edge.side),
    doors: () =>
      [...geometry.doors.values()].map((door) => ({
        doorId: door.id,
        edge: door.edge,
        kind: door.placement.kind,
      })),
    machines: allMachines,
    amenities: (tag) => allMachines().filter((m) => m.tags.includes(tag)),
  };
}

function knownProblemIds(state: ReadonlyWorldState, actor: ReadonlyActor): Set<ProblemId> {
  const ids = new Set<ProblemId>();
  for (const problem of Object.values(state.work.problems)) {
    if (problem.status !== "open") continue;
    if (problem.visibility === "public" || actor.knowledge[`${problem.id}/problem`] !== undefined) {
      ids.add(problem.id);
    }
  }
  return ids;
}

function knownTasks(
  state: ReadonlyWorldState,
  actor: ReadonlyActor,
  problems: Set<ProblemId>,
): TaskView[] {
  const out: TaskView[] = [];
  for (const task of Object.values(state.work.tasks)) {
    if (task.status === "completed" || task.status === "cancelled") continue;
    if (!problems.has(task.problemId)) continue;
    const { claimState: _claimState, ...rest } = task;
    const claimant = Object.values(state.work.claims).find(
      (claim) => claim.taskId === task.id && claim.ownerActorId !== actor.id,
    )?.ownerActorId;
    out.push(claimant === undefined ? rest : { ...rest, knownClaimantId: claimant });
  }
  return out;
}

function knownItems(world: World, actor: ReadonlyActor): KnownItemView[] {
  const { state, content } = world;
  const out: KnownItemView[] = [];
  const seen = new Set<ItemId>();
  const add = (
    itemId: ItemId,
    location: KnownItemView["location"],
    absent: boolean,
    observedTick: number,
  ) => {
    const item = state.items[itemId];
    const def = item === undefined ? undefined : content.items[item.defId];
    if (item === undefined || def === undefined || seen.has(itemId)) return;
    seen.add(itemId);
    out.push({
      itemId,
      defId: item.defId,
      name: def.name,
      tags: def.tags,
      toolKinds: def.toolKinds,
      location,
      ...(location.kind === "onDeck" ? { tile: tileOf(location) } : {}),
      absent,
      observedTick,
    });
  };
  // Own hands first: always known, whatever the table says.
  for (const entry of inventoryOf(state, actor.id)) {
    add(entry.itemId, { kind: "carriedBy", actorId: actor.id }, false, state.tick);
  }
  for (const fact of Object.values(actor.knowledge)) {
    if (fact.factType !== "itemLocation") continue;
    add(
      fact.subjectId as ItemId,
      fact.value.location,
      fact.value.absent === true,
      fact.observedTick,
    );
  }
  return out;
}

/**
 * Who is aboard: the living crew, passengers included, minus anyone off the ship (a passenger
 * ashore at a port, or one left behind or put off there; passengers §3.3, §4.2).
 */
function roster(state: ReadonlyWorldState): RosterEntry[] {
  return Object.values(state.actors)
    .filter((a) => a.crew && a.availability !== "dead" && a.availability !== "offShip")
    .map((a) => ({
      actorId: a.id,
      name: a.name,
      roleTags: a.roleTags,
      skills: a.skills,
      ...(a.passenger === true ? { passenger: true as const } : {}),
    }));
}

export function buildAgentView(world: World, actorId: ActorId): AgentView {
  const { state } = world;
  const actor = state.actors[actorId];
  if (actor === undefined) throw new Error(`AgentView: unknown actor ${actorId}`);
  const deckId =
    actor.location.kind === "onDeck"
      ? actor.location.deckId
      : Object.keys(world.caches.nav.decks)[0];
  const geometry =
    deckId === undefined
      ? undefined
      : world.caches.nav.decks[deckId as keyof typeof world.caches.nav.decks];
  if (geometry === undefined) throw new Error(`AgentView: no nav geometry for actor ${actorId}`);
  const self = buildSelf(world, actor, geometry);
  const schematic = buildSchematic(world, geometry);
  let problemIds: Set<ProblemId> | undefined;
  const problemsKnown = () => {
    problemIds ??= knownProblemIds(state, actor);
    return problemIds;
  };
  return {
    tick: state.tick + 1,
    self,
    schematic,
    fact<T extends FactType>(subjectId: EntityId, factType: T) {
      return actor.knowledge[`${subjectId}/${factType}`] as
        | Extract<KnownFact, { factType: T }>
        | undefined;
    },
    facts: () => Object.values(actor.knowledge),
    knownProblems: (): ProblemView[] =>
      [...problemsKnown()].map((id) => state.work.problems[id]).filter((p) => p !== undefined),
    knownTasks: () => knownTasks(state, actor, problemsKnown()),
    roster: () => roster(state),
    assignedBeds: () => assignedBeds(state, geometry.deckId),
    knownItems: () => knownItems(world, actor),
    estimateTravelTicks: (to: TileCoord, from?: TileCoord) => {
      const start = from ?? self.tile;
      if (start === undefined) return null;
      return estimateTravelTicks(geometry, start, to, world.config.values, 1, world.caches);
    },
  };
}
