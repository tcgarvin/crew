/**
 * Cheap physical and structural invariants (SD §19.4, CONTRACTS rules 2 and 4). Returns one
 * message per violation; empty means healthy. Used by tests after every step and by `restore`.
 */
import { capacitiesOf, isDeadBy } from "./body";
import { integrityFromScars } from "./hull";
import { parseInstanceId } from "./ids";
import { siteOf } from "./sites";
import { BODY_PARTS, INTEREST_TAGS } from "./types/content";
import type { InstanceKind } from "./types/ids";
import type { World } from "./types/kernel";
import type { ReadonlyWorldState } from "./types/pipeline";

/** Walk a value and report anything that would not survive a JSON round-trip unchanged. */
export function jsonSafetyViolations(value: unknown, path = "state"): string[] {
  const out: string[] = [];
  // The path to the current value as segments (an array index or an object key), joined only
  // when there is something to report: formatting every node's path up front made this walk the
  // main cost of tests that check invariants after every tick.
  const segments: (number | string)[] = [];
  const here = (): string => {
    let p = path;
    for (const segment of segments)
      p += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
    return p;
  };
  const walk = (v: unknown): void => {
    switch (typeof v) {
      case "undefined":
        out.push(`${here()} is undefined`);
        return;
      case "number":
        if (!Number.isFinite(v)) out.push(`${here()} is ${v}`);
        else if (Object.is(v, -0)) out.push(`${here()} is -0`);
        return;
      case "string":
      case "boolean":
        return;
      case "object": {
        if (v === null) return;
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            if (!(i in v)) continue; // a hole, which `forEach` would skip too
            segments.push(i);
            walk(v[i]);
            segments.pop();
          }
          return;
        }
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) {
          out.push(`${here()} is a ${(v as object).constructor?.name ?? "non-plain object"}`);
          return;
        }
        const record = v as Readonly<Record<string, unknown>>;
        for (const key of Object.keys(record)) {
          segments.push(key);
          walk(record[key]);
          segments.pop();
        }
        return;
      }
      default:
        out.push(`${here()} is a ${typeof v}`);
    }
  };
  walk(value);
  return out;
}

const TABLES: readonly [keyof ReadonlyWorldState, InstanceKind][] = [
  ["actors", "actor"],
  ["machines", "machine"],
  ["items", "item"],
  ["doors", "door"],
  ["compartments", "compartment"],
  ["jobs", "job"],
];

function idViolations(state: ReadonlyWorldState): string[] {
  const out: string[] = [];
  const check = (
    table: string,
    kind: InstanceKind,
    rows: Readonly<Record<string, { id: string }>>,
  ) => {
    for (const [key, row] of Object.entries(rows)) {
      if (row.id !== key) out.push(`${table}.${key} has id "${row.id}"`);
      const parsed = parseInstanceId(key);
      if (parsed === null || parsed.kind !== kind) {
        out.push(`${table}.${key} is not a ${kind} ID`);
      } else if (parsed.counter >= state.nextId[kind]) {
        out.push(`${table}.${key} is not below nextId.${kind} (${state.nextId[kind]})`);
      }
    }
  };
  for (const [table, kind] of TABLES) {
    check(table, kind, state[table] as Readonly<Record<string, { id: string }>>);
  }
  check("work.problems", "problem", state.work.problems);
  check("work.tasks", "task", state.work.tasks);
  check("work.claims", "claim", state.work.claims);
  check("decisions.records", "decision", state.decisions.records);
  check("money.transactions", "transaction", state.money.transactions);
  check("social.sessions", "session", state.social.sessions);
  return out;
}

function itemViolations(state: ReadonlyWorldState): string[] {
  const out: string[] = [];
  for (const item of Object.values(state.items)) {
    const where = `items.${item.id}`;
    const location = item.location;
    switch (location.kind) {
      case "onDeck":
        if (!Number.isFinite(location.x) || !Number.isFinite(location.y)) {
          out.push(`${where} has a non-finite deck position`);
        }
        break;
      case "carriedBy":
      case "equippedBy":
        if (!(location.actorId in state.actors)) {
          out.push(`${where} is held by missing actor ${location.actorId}`);
        }
        break;
      case "inContainer":
        if (!(location.containerId in state.items)) {
          out.push(`${where} is in missing container ${location.containerId}`);
        }
        break;
      case "installedIn":
        if (!(location.machineId in state.machines)) {
          out.push(`${where} is installed in missing machine ${location.machineId}`);
        }
        break;
      case "inExternalStore":
        if (location.portId.length === 0 || location.storeKey.length === 0) {
          out.push(`${where} is in an unnamed external store`);
        }
        break;
      default:
        out.push(`${where} has unknown location kind`);
    }
    if (item.stacking === "stack") {
      if (!Number.isInteger(item.count) || item.count < 0)
        out.push(`${where}.count is ${item.count}`);
      if (!Number.isInteger(item.reserved) || item.reserved < 0 || item.reserved > item.count) {
        out.push(`${where}.reserved ${item.reserved} is outside [0, ${item.count}]`);
      }
    } else if (!(item.condition >= 0 && item.condition <= 1)) {
      out.push(`${where}.condition ${item.condition} is outside [0, 1]`);
    }
    // §cooking-and-serving: a served meal spoils on a whole tick and names its cook.
    if (item.meal !== undefined) {
      if (!Number.isInteger(item.meal.spoilsAtTick)) {
        out.push(`${where}.meal.spoilsAtTick is ${item.meal.spoilsAtTick}`);
      }
      if (!(item.meal.cookId in state.actors)) {
        out.push(`${where}.meal.cookId ${item.meal.cookId} is not an actor`);
      }
    }
  }
  // Containment is acyclic: following inContainer links must terminate.
  for (const start of Object.values(state.items)) {
    const seen = new Set<string>([start.id]);
    let current = start;
    while (current.location.kind === "inContainer") {
      const next = state.items[current.location.containerId];
      if (next === undefined) break;
      if (seen.has(next.id)) {
        out.push(`items.${start.id} is in a containment cycle`);
        break;
      }
      seen.add(next.id);
      current = next;
    }
  }
  return out;
}

/** §market-stock: market stock is whole units at whole-credit prices, never negative. */
function marketViolations(state: ReadonlyWorldState): string[] {
  const out: string[] = [];
  for (const [portId, stock] of Object.entries(state.markets)) {
    for (const [itemDefId, line] of Object.entries(stock)) {
      const where = `markets.${portId}.${itemDefId}`;
      if (!Number.isInteger(line.count) || line.count < 0)
        out.push(`${where}.count is ${line.count}`);
      if (!Number.isInteger(line.price) || line.price < 0)
        out.push(`${where}.price is ${line.price}`);
    }
  }
  return out;
}

function actorViolations(state: ReadonlyWorldState): string[] {
  const out: string[] = [];
  const woundIds = new Set<string>();
  for (const actor of Object.values(state.actors)) {
    const location = actor.location;
    if (location.kind === "carriedBy" || location.kind === "equippedBy") {
      if (location.actorId === actor.id || !(location.actorId in state.actors)) {
        out.push(`actors.${actor.id} is held by invalid actor ${location.actorId}`);
      }
    }
    for (const [need, value] of Object.entries(actor.needs)) {
      if (!(value >= 0 && value <= 1)) out.push(`actors.${actor.id}.needs.${need} is ${value}`);
    }
    // §thoughts: a thought's value is a finite number and it expires on a whole tick.
    actor.thoughts.forEach((thought, i) => {
      const where = `actors.${actor.id}.thoughts[${i}]`;
      if (!Number.isFinite(thought.value)) out.push(`${where}.value is ${thought.value}`);
      if (!Number.isInteger(thought.expiresAtTick)) {
        out.push(`${where}.expiresAtTick is ${thought.expiresAtTick}`);
      }
    });
    out.push(...characterViolations(actor));
    out.push(...bodyShapeViolations(actor, state.nextId.wound, woundIds));
    // §footfall-and-boots: boots carry a share of dirt in [0, 1].
    if (!(actor.boots >= 0 && actor.boots <= 1)) {
      out.push(`actors.${actor.id}.boots is ${actor.boots}`);
    }
    // §sections-and-dayworkers: a section has a key and a place in the bill.
    const section = actor.schedule.section;
    if (
      section !== undefined &&
      (section.key.length === 0 || !Number.isInteger(section.index) || section.index < 0)
    ) {
      out.push(`actors.${actor.id}.schedule.section is ${JSON.stringify(section)}`);
    }
  }
  return out;
}

const INTEREST_TAG_SET: ReadonlySet<string> = new Set(INTEREST_TAGS);

type ReadonlyActor = ReadonlyWorldState["actors"][keyof ReadonlyWorldState["actors"]];

const inUnit = (v: number): boolean => v >= 0 && v <= 1;

/**
 * Expeditions A1 (§7.1): a body has the six parts with finite, non-negative damage; `blood`,
 * `pain` and `stun` in [0, 1]; wound ids allocated (below `nextId.wound`) and unique across
 * everyone (`seen` collects them).
 */
function bodyShapeViolations(actor: ReadonlyActor, nextWound: number, seen: Set<string>): string[] {
  const out: string[] = [];
  const where = `actors.${actor.id}.body`;
  const body = actor.body;
  for (const part of BODY_PARTS) {
    const damage = body.parts[part]?.damage;
    if (damage === undefined || !Number.isFinite(damage) || damage < 0) {
      out.push(`${where}.parts.${part} damage is ${String(damage)}`);
    }
  }
  if (Object.keys(body.parts).length !== BODY_PARTS.length) {
    out.push(`${where}.parts has ${Object.keys(body.parts).length} parts`);
  }
  for (const key of ["blood", "pain", "stun"] as const) {
    if (!inUnit(body[key])) out.push(`${where}.${key} is ${body[key]}`);
  }
  body.wounds.forEach((wound, i) => {
    const parsed = parseInstanceId(wound.id);
    if (parsed?.kind !== "wound" || parsed.counter >= nextWound) {
      out.push(`${where}.wounds[${i}] has unallocated id ${wound.id}`);
    }
    if (seen.has(wound.id)) out.push(`${where}.wounds[${i}] repeats id ${wound.id}`);
    seen.add(wound.id);
  });
  return out;
}

/**
 * Expeditions A1: the expedition names actors that exist, its leader among a non-empty party, and
 * a fight has a plan.
 */
function expeditionShapeViolations(state: ReadonlyWorldState): string[] {
  const expedition = state.expedition;
  if (expedition === undefined) return [];
  const out: string[] = [];
  for (const id of expedition.party) {
    if (state.actors[id] === undefined) out.push(`expedition.party names unknown actor ${id}`);
  }
  if (state.actors[expedition.leaderId] === undefined) {
    out.push(`expedition.leaderId ${expedition.leaderId} is not an actor`);
  }
  if (expedition.party.length > 0 && !expedition.party.includes(expedition.leaderId)) {
    out.push(`expedition leader ${expedition.leaderId} is not in the party`);
  }
  if (expedition.phase === "fight" && expedition.plan === undefined) {
    out.push("expedition is in a fight without a plan");
  }
  if (!Number.isInteger(expedition.shots) || expedition.shots < 0) {
    out.push(`expedition.shots is ${expedition.shots}`);
  }
  return out;
}

/**
 * Expeditions A1 (§7.1, plan call 5), the body rules that need config: `dead` exactly when the
 * body is dead by threshold (`isDeadBy`), and capacities as `applyCapacities` writes them (fatigue
 * composed with the body), so nothing else writes them. Tests and fixtures call it beside
 * `checkInvariants`, which sees state alone.
 */
export function bodyViolations(world: Pick<World, "state" | "config">): string[] {
  const out: string[] = [];
  const config = world.config.values;
  for (const actor of Object.values(world.state.actors)) {
    const where = `actors.${actor.id}`;
    const dead = isDeadBy(actor.body, config);
    if (dead !== (actor.availability === "dead")) {
      out.push(`${where} is ${actor.availability} with a body that is ${dead ? "" : "not "}dead`);
    }
    const expected = capacitiesOf(actor, config);
    for (const key of ["movement", "manipulation", "consciousness"] as const) {
      if (Math.abs(actor.capacities[key] - expected[key]) > 1e-9) {
        out.push(`${where}.capacities.${key} is ${actor.capacities[key]}, not ${expected[key]}`);
      }
    }
  }
  return out;
}

/**
 * Expeditions A1, the rules that need content: a combatant stands on the deck with the site
 * alongside (or is carried there), and an expedition that is not over has its site alongside.
 */
export function expeditionViolations(world: Pick<World, "state" | "content">): string[] {
  const out: string[] = [];
  const { state, content } = world;
  const site = siteOf(content, state);
  const presence = state.deck.dock;
  for (const actor of Object.values(state.actors)) {
    if (actor.combatant === undefined) continue;
    const location = actor.location;
    const onSiteDeck =
      site !== undefined &&
      (location.kind === "carriedBy" ||
        (location.kind === "onDeck" && location.deckId === presence?.deckId));
    if (!onSiteDeck) out.push(`actors.${actor.id} is a combatant away from a site`);
  }
  const expedition = state.expedition;
  if (expedition !== undefined && expedition.phase !== "resolved") {
    if (site === undefined) out.push(`expedition at ${expedition.siteId} with no site alongside`);
    else if (site.dock.portId !== expedition.siteId) {
      out.push(`expedition at ${expedition.siteId} with "${site.dock.id}" alongside`);
    }
  }
  return out;
}

/**
 * Slice 4: interests are known tags, the strong one among the likes, none both liked and
 * disliked; values are integers in [-2, 2]. (`needs.recreation` is in [0, 1] with the other
 * needs.)
 */
function characterViolations(
  actor: ReadonlyWorldState["actors"][keyof ReadonlyWorldState["actors"]],
): string[] {
  const out: string[] = [];
  const where = `actors.${actor.id}`;
  const { likes, strong, dislikes } = actor.interests;
  for (const tag of [...likes, ...dislikes, ...(strong === undefined ? [] : [strong])]) {
    if (!INTEREST_TAG_SET.has(tag)) out.push(`${where}.interests names unknown tag "${tag}"`);
  }
  if (strong !== undefined && !likes.includes(strong)) {
    out.push(`${where}.interests.strong "${strong}" is not one of its likes`);
  }
  for (const tag of likes) {
    if (dislikes.includes(tag)) out.push(`${where}.interests both likes and dislikes "${tag}"`);
  }
  for (const [axis, value] of Object.entries(actor.values)) {
    if (!Number.isInteger(value) || value < -2 || value > 2) {
      out.push(`${where}.values.${axis} is ${value}`);
    }
  }
  return out;
}

/**
 * Slice 4: social state names actors that exist. Relationship rows and their entries are keyed by
 * actors, and every memory's expiry is a whole tick after the last (§memories: the social system
 * drops them as they expire; keys and stack limits are config's, checked beside mood in
 * `systems/needs/invariants.ts`); every session's host and members are actors on deck, its
 * tick fields whole and `startedTick <= endsAtTick`; a private talk names two different actors.
 */
function socialViolations(state: ReadonlyWorldState): string[] {
  const out: string[] = [];
  const social = state.social;
  for (const [from, row] of Object.entries(social.relationships)) {
    if (!(from in state.actors)) out.push(`social.relationships.${from} is not an actor`);
    for (const [to, relationship] of Object.entries(row)) {
      const where = `social.relationships.${from}.${to}`;
      if (!(to in state.actors) || to === from) out.push(`${where} is not another actor`);
      for (const memory of relationship.memories) {
        // §memory-levers: a lasting memory has no expiry.
        if ("lasting" in memory) continue;
        if (!Number.isInteger(memory.expiresAtTick) || memory.expiresAtTick <= state.tick) {
          out.push(`${where} holds ${memory.key} expiring at ${memory.expiresAtTick}`);
        }
      }
    }
  }
  for (const session of Object.values(social.sessions)) {
    const where = `social.sessions.${session.id}`;
    for (const id of [session.hostId, ...session.members]) {
      const actor = state.actors[id];
      if (actor === undefined || actor.location.kind !== "onDeck") {
        out.push(`${where} names ${id}, who is not an actor on deck`);
      }
    }
    if (new Set(session.members).size !== session.members.length) {
      out.push(`${where}.members repeat someone`);
    }
    const { openedTick, startedTick, endsAtTick } = session;
    for (const [field, tick] of [
      ["openedTick", openedTick],
      ["startedTick", startedTick],
      ["endsAtTick", endsAtTick],
    ] as const) {
      if (tick !== undefined && !Number.isInteger(tick)) out.push(`${where}.${field} is ${tick}`);
    }
    if ((startedTick === undefined) !== (endsAtTick === undefined)) {
      out.push(`${where} has only one of startedTick and endsAtTick`);
    } else if (startedTick !== undefined && endsAtTick !== undefined && startedTick > endsAtTick) {
      out.push(`${where}.startedTick ${startedTick} is after endsAtTick ${endsAtTick}`);
    }
    const venue = session.venue;
    if ("postKey" in venue) {
      // §shore-leave: a session ashore lasts no longer than its dock alongside.
      if (state.deck.dock?.dockId !== venue.dockId) {
        out.push(`${where}.venue is ashore at ${venue.dockId}, which is not alongside`);
      }
    } else if (!(venue.compartmentId in state.compartments)) {
      out.push(`${where}.venue names unknown compartment ${venue.compartmentId}`);
    }
  }
  const talk = social.privateTalk;
  if (talk !== undefined) {
    if (!(talk.captainId in state.actors) || !(talk.actorId in state.actors)) {
      out.push("social.privateTalk names someone who is not an actor");
    } else if (talk.captainId === talk.actorId) {
      out.push("social.privateTalk names the same actor twice");
    }
  }
  return out;
}

/** §hazard-roll: scheduled hazards carry allocated ids, once each. */
function hazardViolations(state: ReadonlyWorldState): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  state.hazards.forEach((hazard, i) => {
    const where = `hazards[${i}]`;
    const parsed = parseInstanceId(hazard.id);
    if (parsed?.kind !== "hazard" || parsed.counter >= state.nextId.hazard) {
      out.push(`${where} has unallocated id ${hazard.id}`);
    }
    if (seen.has(hazard.id)) out.push(`${where} repeats id ${hazard.id}`);
    seen.add(hazard.id);
  });
  return out;
}

/** Floating-point slack for the hull's sums (patching restores fractions of a scar). */
const HULL_EPSILON = 1e-9;

/**
 * §hull-scars-and-ship-loss: the hull bar is `max` less every scar's damage left; a scar gives back
 * no more than it cost; scar ids are allocated and unique. (That a scar's tile is on the deck needs
 * content: the field system checks it.)
 */
function hullViolations(state: ReadonlyWorldState): string[] {
  const out: string[] = [];
  const hull = state.hull;
  if (!Number.isInteger(hull.max) || hull.max <= 0) out.push(`hull.max is ${hull.max}`);
  if (hull.integrity < 0 || hull.integrity > hull.max) {
    out.push(`hull.integrity ${hull.integrity} is outside [0, ${hull.max}]`);
  }
  const expected = integrityFromScars(hull);
  if (Math.abs(hull.integrity - expected) > HULL_EPSILON) {
    out.push(`hull.integrity ${hull.integrity} is not max less the scars' damage (${expected})`);
  }
  if (hull.lostAtTick !== undefined && hull.integrity > HULL_EPSILON) {
    out.push(`hull is lost at tick ${hull.lostAtTick} with integrity ${hull.integrity}`);
  }
  const seen = new Set<string>();
  hull.scars.forEach((scar, i) => {
    const where = `hull.scars[${i}]`;
    const parsed = parseInstanceId(scar.id);
    if (parsed?.kind !== "scar" || parsed.counter >= state.nextId.scar) {
      out.push(`${where} has unallocated id ${scar.id}`);
    }
    if (seen.has(scar.id)) out.push(`${where} repeats id ${scar.id}`);
    seen.add(scar.id);
    if (!(scar.damage > 0)) out.push(`${where} has damage ${scar.damage}`);
    if (scar.recovered < 0 || scar.recovered > scar.damage + HULL_EPSILON) {
      out.push(`${where} recovered ${scar.recovered} of ${scar.damage}`);
    }
    if (scar.recovered > 0 && !scar.patched) out.push(`${where} recovered hull unpatched`);
    if (state.compartments[scar.compartmentId] === undefined) {
      out.push(`${where} is in unknown compartment ${scar.compartmentId}`);
    }
  });
  return out;
}

/** §scheduling-a-field: the field's id is allocated; the alert's reports name compartments. */
function fieldViolations(state: ReadonlyWorldState): string[] {
  const out: string[] = [];
  const field = state.field;
  if (field !== undefined) {
    const parsed = parseInstanceId(field.id);
    if (parsed?.kind !== "field" || parsed.counter >= state.nextId.field) {
      out.push(`field has unallocated id ${field.id}`);
    }
    if (!Number.isInteger(field.impacts) || field.impacts < 0) {
      out.push(`field.impacts is ${field.impacts}`);
    }
    if (field.stuckImpacts > field.impacts) {
      out.push(`field.stuckImpacts ${field.stuckImpacts} exceeds impacts ${field.impacts}`);
    }
  }
  for (const compartmentId of Object.keys(state.alert?.reports ?? {})) {
    if (state.compartments[compartmentId as keyof typeof state.compartments] === undefined) {
      out.push(`alert.reports names unknown compartment ${compartmentId}`);
    }
  }
  return out;
}

/**
 * §berth-assignment: every berth belongs to an actor that exists, and no two actors share a bed.
 * That each value is a `bed` placement on the ship's deck needs content: `systems/needs` checks it.
 */
export function berthViolations(state: ReadonlyWorldState): string[] {
  const out: string[] = [];
  const holder = new Map<string, string>();
  for (const [actorId, placementKey] of Object.entries(state.berths)) {
    if (!(actorId in state.actors)) out.push(`berths.${actorId} is not an actor`);
    const other = holder.get(placementKey);
    if (other !== undefined) out.push(`berths: ${other} and ${actorId} share "${placementKey}"`);
    else holder.set(placementKey, actorId);
  }
  return out;
}

/**
 * §dirt-grid: every deck in `deck.tiles` has a dirt row of integers in [0, 255] (its length against
 * the deck def is `systems/dirt`'s check: core has no content); every tier is a room of some deck
 * (a key only, checked there too). §helm-plate: the helm meal names an actor and an item aboard.
 */
function dirtAndGalleyViolations(state: ReadonlyWorldState): string[] {
  const out: string[] = [];
  for (const deckId of Object.keys(state.deck.tiles)) {
    const cells = state.dirt.cells[deckId as keyof typeof state.dirt.cells];
    if (cells === undefined) {
      out.push(`dirt.cells has no row for deck ${deckId}`);
      continue;
    }
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i] as number;
      if (!Number.isInteger(cell) || cell < 0 || cell > 255) {
        out.push(`dirt.cells.${deckId}[${i}] is ${cell}`);
        break;
      }
    }
  }
  if (!(state.dirt.dustThisVisit >= 0))
    out.push(`dirt.dustThisVisit is ${state.dirt.dustThisVisit}`);
  if (!Number.isInteger(state.galley.lastMealWatch)) {
    out.push(`galley.lastMealWatch is ${state.galley.lastMealWatch}`);
  }
  const meal = state.galley.helmMeal;
  if (meal !== undefined) {
    if (!(meal.actorId in state.actors))
      out.push(`galley.helmMeal.actorId ${meal.actorId} is not an actor`);
    if (!(meal.itemId in state.items))
      out.push(`galley.helmMeal.itemId ${meal.itemId} is not an item`);
    if (!Number.isInteger(meal.startedTick))
      out.push(`galley.helmMeal.startedTick is ${meal.startedTick}`);
  }
  return out;
}

function taskCycleViolations(state: ReadonlyWorldState): string[] {
  const tasks = state.work.tasks;
  const out: string[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();
  const visit = (id: string): boolean => {
    if (done.has(id)) return false;
    if (onStack.has(id)) return true;
    onStack.add(id);
    const task = tasks[id as keyof typeof tasks];
    const cyclic = (task?.dependencyIds ?? []).some((dep) => visit(dep));
    onStack.delete(id);
    done.add(id);
    return cyclic;
  };
  for (const id of Object.keys(tasks)) {
    if (!done.has(id) && visit(id)) out.push(`work.tasks has a dependency cycle through ${id}`);
  }
  return out;
}

function queueViolations(state: ReadonlyWorldState): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of state.decisions.queue) {
    if (seen.has(id)) out.push(`decisions.queue lists ${id} twice`);
    seen.add(id);
    const record = state.decisions.records[id];
    if (record === undefined) out.push(`decisions.queue names missing decision ${id}`);
    else if (record.status !== "pending") out.push(`decisions.queue holds ${record.status} ${id}`);
  }
  // §holding-a-card: a held card is pending, held once, and never on the queue at the same time.
  const held = new Set<string>();
  for (const card of state.decisions.held) {
    const id = card.decisionId;
    if (held.has(id)) out.push(`decisions.held lists ${id} twice`);
    held.add(id);
    if (seen.has(id)) out.push(`decision ${id} is both held and queued`);
    const record = state.decisions.records[id];
    if (record === undefined) out.push(`decisions.held names missing decision ${id}`);
    else if (record.status !== "pending") out.push(`decisions.held holds ${record.status} ${id}`);
  }
  const hook = state.narrator.pendingHook;
  if (hook !== undefined) {
    const parsed = parseInstanceId(hook.id);
    if (parsed?.kind !== "hook" || parsed.counter >= state.nextId.hook) {
      out.push(`narrator.pendingHook has unallocated id ${hook.id}`);
    }
  }
  const queue = state.commands.queue;
  queue.forEach((command, i) => {
    if (command.seq >= state.commands.nextSeq) out.push(`commands.queue[${i}].seq >= nextSeq`);
    const prev = queue[i - 1];
    if (
      prev !== undefined &&
      (prev.applyAtTick > command.applyAtTick ||
        (prev.applyAtTick === command.applyAtTick && prev.seq > command.seq))
    ) {
      out.push(`commands.queue is out of order at ${i}`);
    }
  });
  return out;
}

export function checkInvariants(state: ReadonlyWorldState): string[] {
  const out = jsonSafetyViolations(state);
  if (!Number.isInteger(state.tick) || state.tick < 0) out.push(`tick is ${state.tick}`);
  const balance = state.money.balance;
  if (!Number.isInteger(balance) || balance < 0) out.push(`money.balance is ${balance}`);
  out.push(
    ...idViolations(state),
    ...itemViolations(state),
    ...actorViolations(state),
    ...marketViolations(state),
    ...berthViolations(state),
    ...hazardViolations(state),
    ...hullViolations(state),
    ...fieldViolations(state),
    ...dirtAndGalleyViolations(state),
    ...socialViolations(state),
    ...expeditionShapeViolations(state),
    ...taskCycleViolations(state),
    ...queueViolations(state),
  );
  return out;
}
