/**
 * The Command union (SD §19.2, PLAN §5).
 *
 * Commands are the only way anything outside the pipeline changes the world. Each system owns one
 * payload file in this folder (`<system>.ts` exporting `<System>CommandPayloads`); this file merges
 * them. The kernel validates a command when it is enqueued and again when it is applied
 * (validate-then-apply: a pure validation produces a plan; applying the plan cannot fail, so a
 * rejected command causes no partial mutation). Commands are idempotent by `id`.
 */
import type { Tick } from "../common";
import type { CommandId } from "../ids";
import type { CabinsCommandPayloads } from "./cabins";
import type { CallBackCommandPayloads } from "./callback";
import type { CommerceCommandPayloads } from "./commerce";
import type { DecisionCommandPayloads } from "./decisions";
import type { DocksideCommandPayloads } from "./dockside";
import type { EquipmentCommandPayloads } from "./equipment";
import type { FieldCommandPayloads } from "./field";
import type { ScenarioCommandPayloads } from "./scenario";
import type { SpawnCommandPayloads } from "./spawn";
import type { TravelCommandPayloads } from "./travel";

export type * from "./cabins";
export type * from "./callback";
export type * from "./commerce";
export type * from "./decisions";
export type * from "./dockside";
export type * from "./equipment";
export type * from "./field";
export type * from "./scenario";
export type * from "./spawn";
export type * from "./travel";

/** All command payloads keyed by kind. To add a system, extend this interface with its map. */
export interface CommandPayloadMap
  extends ScenarioCommandPayloads,
    DecisionCommandPayloads,
    TravelCommandPayloads,
    CommerceCommandPayloads,
    EquipmentCommandPayloads,
    SpawnCommandPayloads,
    DocksideCommandPayloads,
    CabinsCommandPayloads,
    FieldCommandPayloads,
    CallBackCommandPayloads {}

export type CommandKind = keyof CommandPayloadMap;

/**
 * Who issued a command. `player`: the UI (only at hooks, D14). `narrator`: the server's translated
 * narrator plan. `system`: kernel-internal and host plumbing (deterministic job source, policy
 * decisions, hook acknowledgement). `scenario`: world setup and test fixtures.
 */
export type CommandSource = "player" | "narrator" | "system" | "scenario";

export interface CommandEnvelope<K extends CommandKind = CommandKind> {
  readonly id: CommandId;
  readonly source: CommandSource;
  /** Apply at this tick; absent = the next tick. Must not be in the past. */
  readonly targetTick?: Tick;
  readonly kind: K;
  readonly payload: CommandPayloadMap[K];
}

/** Discriminated union of every command. Narrow on `kind`. */
export type Command = { [K in CommandKind]: CommandEnvelope<K> }[CommandKind];
export type CommandOfKind<K extends CommandKind> = Extract<Command, { kind: K }>;

/** A command without its envelope, as carried inside decision options. */
export type CommandDraft = {
  [K in CommandKind]: { readonly kind: K; readonly payload: CommandPayloadMap[K] };
}[CommandKind];

/** A command accepted into `state.commands.queue`, with its resolved apply tick and stable order. */
export type QueuedCommand = Command & { readonly applyAtTick: Tick; readonly seq: number };

export const REJECTION_CODES = [
  "unauthorized",
  "duplicate",
  "invalidPayload",
  "unknownEntity",
  "preconditionFailed",
  "outOfBounds",
  "budgetExhausted",
  "tickInPast",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

export interface CommandRejection {
  readonly code: RejectionCode;
  /** Human-readable, safe to show in logs and to feed back to the narrator. */
  readonly reason: string;
}

export type EnqueueResult =
  | { readonly status: "accepted"; readonly commandId: CommandId; readonly applyAtTick: Tick }
  | {
      readonly status: "rejected";
      readonly commandId: CommandId;
      readonly rejection: CommandRejection;
    };

/** Queue state owned by kernel core (W2). */
export interface CommandsState {
  /** Accepted, not yet applied; ordered by (applyAtTick, seq). Saved (SD §20.1). */
  queue: QueuedCommand[];
  /** Recently applied IDs for idempotency; a bounded tail. */
  recentIds: CommandId[];
  nextSeq: number;
}
