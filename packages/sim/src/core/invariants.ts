/**
 * Cheap physical and structural invariants (SD §19.4, CONTRACTS rules 2 and 4). Returns one
 * message per violation; empty means healthy. Used by tests after every step and by `restore`.
 */
import { parseInstanceId } from "./ids";
import type { InstanceKind } from "./types/ids";
import type { ReadonlyWorldState } from "./types/pipeline";

/** Walk a value and report anything that would not survive a JSON round-trip unchanged. */
export function jsonSafetyViolations(value: unknown, path = "state"): string[] {
  const out: string[] = [];
  const walk = (v: unknown, p: string): void => {
    switch (typeof v) {
      case "undefined":
        out.push(`${p} is undefined`);
        return;
      case "number":
        if (!Number.isFinite(v)) out.push(`${p} is ${v}`);
        else if (Object.is(v, -0)) out.push(`${p} is -0`);
        return;
      case "string":
      case "boolean":
        return;
      case "object": {
        if (v === null) return;
        if (Array.isArray(v)) {
          v.forEach((item, i) => walk(item, `${p}[${i}]`));
          return;
        }
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) {
          out.push(`${p} is a ${(v as object).constructor?.name ?? "non-plain object"}`);
          return;
        }
        for (const [key, child] of Object.entries(v)) walk(child, `${p}.${key}`);
        return;
      }
      default:
        out.push(`${p} is a ${typeof v}`);
    }
  };
  walk(value, path);
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

/** D47: market stock is whole units at whole-credit prices, never negative. */
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
    ...taskCycleViolations(state),
    ...queueViolations(state),
  );
  return out;
}
