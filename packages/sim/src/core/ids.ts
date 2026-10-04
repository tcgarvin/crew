/**
 * Instance ID allocator over `state.nextId` (CONTRACTS rule 4). IDs are `${prefix}${counter}`,
 * never reused: the counter only moves forward.
 */
import {
  ID_PREFIX,
  type InstanceId,
  type InstanceIdOf,
  type InstanceKind,
  type NextIdCounters,
} from "./types/ids";

/** The slice of state the allocator touches. */
export interface IdHost {
  nextId: NextIdCounters;
}

/** Counters for a fresh world: every kind starts at 1. */
export function initialIdCounters(): NextIdCounters {
  const counters = {} as Record<InstanceKind, number>;
  for (const kind of Object.keys(ID_PREFIX) as InstanceKind[]) {
    counters[kind] = 1;
  }
  return counters;
}

/** Allocate the next ID of `kind` and advance the saved counter. */
export function allocateId<K extends InstanceKind>(host: IdHost, kind: K): InstanceIdOf[K] {
  const n = host.nextId[kind];
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`nextId.${kind} is corrupt: ${String(n)}`);
  }
  // `NextIdCounters` is a readonly value object: replace it whole.
  host.nextId = { ...host.nextId, [kind]: n + 1 };
  return `${ID_PREFIX[kind]}${n}` as InstanceIdOf[K];
}

const KIND_BY_PREFIX: Readonly<Record<string, InstanceKind>> = Object.fromEntries(
  (Object.entries(ID_PREFIX) as [InstanceKind, string][]).map(([kind, prefix]) => [prefix, kind]),
);

const INSTANCE_ID_PATTERN = /^([a-z]+)([1-9][0-9]*)$/;

interface ParsedInstanceId {
  readonly kind: InstanceKind;
  readonly counter: number;
}

/** Parse an instance ID into its kind and counter; `null` if it is not a well-formed ID. */
export function parseInstanceId(id: string): ParsedInstanceId | null {
  const match = INSTANCE_ID_PATTERN.exec(id);
  if (match === null) {
    return null;
  }
  const kind = KIND_BY_PREFIX[match[1] as string];
  if (kind === undefined) {
    return null;
  }
  return { kind, counter: Number(match[2]) };
}

export function isInstanceIdOf<K extends InstanceKind>(kind: K, id: string): id is InstanceIdOf[K] {
  return parseInstanceId(id)?.kind === kind;
}

/** Brand a string as an ID of `kind`, throwing if it has the wrong shape. For boundaries/tests. */
export function asInstanceId<K extends InstanceKind>(kind: K, id: string): InstanceIdOf[K] {
  if (!isInstanceIdOf(kind, id)) {
    throw new Error(`"${id}" is not a ${kind} ID (expected ${ID_PREFIX[kind]}<n>)`);
  }
  return id;
}

/** True if `id` was allocated by `host` (its counter is below the next one). */
export function wasAllocated(host: IdHost, id: InstanceId): boolean {
  const parsed = parseInstanceId(id);
  return parsed !== null && parsed.counter < host.nextId[parsed.kind];
}

/** Order records by instance ID, counters numerically (`a2` before `a10`): a stable order. */
export function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id.localeCompare(b.id, "en", { numeric: true });
}
