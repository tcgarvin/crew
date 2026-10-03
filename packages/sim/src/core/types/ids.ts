/**
 * Identity contracts (PLAN §5, review §C.2).
 *
 * Two ID spaces that never mix:
 *
 * - **Definition IDs** name authored or generated content: namespaced, human-readable slugs such
 *   as `machine.coolant_pump.mk1` or `gen.item.7f3a2c`. Content authors and LLMs write these.
 *   Generated content always uses the `gen.` namespace.
 * - **Instance IDs** name things that exist in one game. The kernel allocates them from the
 *   saved `WorldState.nextId` counters as a one- or two-letter prefix followed by a decimal
 *   counter (`a17`, `m4`, `i203`). They are never reused: dead actors and consumed items keep
 *   theirs. Prefixed strings (not numbers) keep insertion order in `Record` keys across JSON
 *   round-trips and are self-describing in logs and narrator digests.
 *
 * Every ID is a branded string so the compiler catches an `ItemId` passed where a `MachineId`
 * is expected. Brands are erased at runtime; the JSON form is a plain string.
 */

declare const brand: unique symbol;

/** Nominal typing helper. `Brand<string, "ActorId">` is a string the compiler treats as distinct. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

// ---------------------------------------------------------------------------------------------
// Definition IDs
// ---------------------------------------------------------------------------------------------

export type DeckDefId = Brand<string, "DeckDefId">;
export type MachineDefId = Brand<string, "MachineDefId">;
export type ItemDefId = Brand<string, "ItemDefId">;
export type CrewDefId = Brand<string, "CrewDefId">;
export type PortDefId = Brand<string, "PortDefId">;
export type TraitDefId = Brand<string, "TraitDefId">;
export type ScenarioDefId = Brand<string, "ScenarioDefId">;
/** Dockside spike: a port's dock map (`DockDef` arrives with phase 2; `DockLayout` is its nav subset). */
export type DockDefId = Brand<string, "DockDefId">;

/** Any definition ID. Used where a reference may point at several def kinds (e.g. narrator digests). */
export type DefId =
  | DeckDefId
  | MachineDefId
  | ItemDefId
  | CrewDefId
  | PortDefId
  | TraitDefId
  | ScenarioDefId
  | DockDefId;

/**
 * Pattern every definition ID must match: two or more lowercase dot-separated segments of
 * `[a-z0-9_]`, the first segment being the namespace (`deck`, `machine`, `item`, `crew`, `port`,
 * `trait`, `scenario`, or `gen` for generated content). Content validation (L1) enforces this.
 */
export const DEF_ID_PATTERN = "^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$";

/**
 * Keys that are local to one definition (a compartment key inside a deck, a fault key inside a
 * machine def, an interaction-position key). Plain lower-camel or snake slugs, not branded:
 * they are only meaningful next to the def they came from.
 */
export type LocalKey = string;

// ---------------------------------------------------------------------------------------------
// Instance IDs
// ---------------------------------------------------------------------------------------------

export type ActorId = Brand<string, "ActorId">;
export type MachineId = Brand<string, "MachineId">;
export type ItemId = Brand<string, "ItemId">;
export type DoorId = Brand<string, "DoorId">;
export type CompartmentId = Brand<string, "CompartmentId">;
export type TaskId = Brand<string, "TaskId">;
export type ProblemId = Brand<string, "ProblemId">;
export type JobId = Brand<string, "JobId">;
export type DecisionId = Brand<string, "DecisionId">;
export type HookId = Brand<string, "HookId">;
export type ClaimId = Brand<string, "ClaimId">;
export type TransactionId = Brand<string, "TransactionId">;
export type EventId = Brand<string, "EventId">;

/**
 * Prefix per instance kind. The kernel's ID allocator (W2) is the only writer; it formats
 * `${ID_PREFIX[kind]}${state.nextId[kind]++}`.
 */
export const ID_PREFIX = {
  actor: "a",
  machine: "m",
  item: "i",
  door: "d",
  compartment: "c",
  task: "t",
  problem: "p",
  job: "j",
  decision: "x",
  hook: "k",
  // W0 decision: claims use `l` (lease) and ledger transactions use `n`, since `c`/`t` are taken.
  claim: "l",
  transaction: "n",
  event: "e",
} as const;

export type InstanceKind = keyof typeof ID_PREFIX;

/** Maps an instance kind to its branded ID type. */
export interface InstanceIdOf {
  actor: ActorId;
  machine: MachineId;
  item: ItemId;
  door: DoorId;
  compartment: CompartmentId;
  task: TaskId;
  problem: ProblemId;
  job: JobId;
  decision: DecisionId;
  hook: HookId;
  claim: ClaimId;
  transaction: TransactionId;
  event: EventId;
}

/** Any kernel-allocated instance ID. */
export type InstanceId = InstanceIdOf[InstanceKind];

/**
 * Anything an event, fact or digest can name as a subject. Kept as an alias so it can widen
 * later (e.g. to include structural sections) without touching every consumer.
 */
export type EntityId = InstanceId;

/** Saved allocation counters: the next integer to hand out per instance kind. Start at 1. */
export type NextIdCounters = Readonly<Record<InstanceKind, number>>;

/**
 * Caller-supplied command ID. Not kernel-allocated: hosts, the server and the narrator mint
 * these (e.g. `cmd:player:<uuid>`, `cmd:narrator:<callId>:3`) so retries are idempotent.
 * W0 decision: command IDs are opaque caller strings; the kernel dedupes on them.
 */
export type CommandId = Brand<string, "CommandId">;

/**
 * Temporary reference inside one command (e.g. a narrator spawn that creates a passenger `$p1`
 * and a crate `$d1` in their luggage). The kernel resolves these to real instance IDs at apply
 * time and reports the mapping in the `commandApplied` event (review §C.2).
 */
export type TempRef = `$${string}`;
