/**
 * Command queue and the validate-then-apply path (CONTRACTS rule 8, SD §19.2).
 *
 * `enqueue` checks `AUTHORITY[source]` first, dedupes by `id`, resolves the apply tick, then runs
 * the kind's registered `validate`. Accepted commands wait in `state.commands.queue` ordered by
 * `(applyAtTick, seq)`; phase 1 (`applyDueCommands`) revalidates each due command against the
 * state at that moment and either applies it (which cannot fail) or emits `commandRejected`.
 * Every kind plugs in through `registerCommandHandler(kind, { validate, apply })`.
 */
import { createDefLookup } from "./defs";
import type { KernelRegistry } from "./registry";
import type {
  Command,
  CommandKind,
  CommandOfKind,
  CommandRejection,
  EnqueueResult,
  QueuedCommand,
  RejectionCode,
} from "./types/commands";
import { AUTHORITY, STAGING_COMMAND_KINDS } from "./types/commands/authority";
import type { Tick } from "./types/common";
import type { ConfigDef, ContentBundle } from "./types/content";
import type { EventDraft } from "./types/events";
import type { CommandId, EntityId, TempRef } from "./types/ids";
import type { World } from "./types/kernel";
import type { DefLookup, ReadonlyWorldState, StepCtx } from "./types/pipeline";

/**
 * W2 decision: the idempotency tail keeps this many applied/rejected command IDs. An
 * implementation bound, not a gameplay tunable, so it is not in `ConfigDef`.
 */
const RECENT_COMMAND_IDS_CAP = 512;

/** What `validate` may read: truth, read-only. Pure. */
export interface ValidateCtx {
  readonly state: ReadonlyWorldState;
  readonly content: ContentBundle;
  readonly config: ConfigDef;
  readonly defs: DefLookup;
  /** The tick the command would apply at. */
  readonly tick: Tick;
}

/** What `apply` may touch. */
export type ApplyCtx = Pick<
  StepCtx,
  "state" | "caches" | "content" | "defs" | "config" | "rng" | "tick" | "emit"
>;

export type Validation<P> =
  | { readonly ok: true; readonly plan: P }
  | { readonly ok: false; readonly rejection: CommandRejection };

/** Result of applying a command: the IDs its temp refs resolved to (empty for most kinds). */
export interface AppliedCommand {
  readonly tempRefs: Readonly<Record<TempRef, EntityId>>;
}

export const NO_TEMP_REFS: AppliedCommand = { tempRefs: {} };

/**
 * One command kind's behaviour. `validate` is pure and returns a plan or a rejection; `apply`
 * executes a plan produced by `validate` against the same state and must not fail.
 */
export interface CommandHandler<K extends CommandKind, P = unknown> {
  validate(ctx: ValidateCtx, command: CommandOfKind<K>): Validation<P>;
  apply(ctx: ApplyCtx, command: CommandOfKind<K>, plan: P): AppliedCommand;
}

export function ok<P>(plan: P): Validation<P> {
  return { ok: true, plan };
}

export function reject(code: RejectionCode, reason: string): Validation<never> {
  return { ok: false, rejection: { code, reason } };
}

function validateCtxOf(world: World, tick: Tick): ValidateCtx {
  return {
    state: world.state,
    content: world.content,
    config: world.config.values,
    defs: createDefLookup(world.content, world.state),
    tick,
  };
}

/**
 * D66: the staging call's window. A staging-only kind (`STAGING_COMMAND_KINDS`) from the
 * narrator is valid only while a `stageDock` hook is pending, and while one is, no other
 * narrator kind is: the staging call sets the stage and never moves the plot (D57). Narrator
 * commands are applied at the hook tick + 1, ahead of the host's `acknowledgeHook` in the same
 * tick, so both enqueue and apply see the hook still pending. A timing rule, so
 * `preconditionFailed`, not `unauthorized`.
 */
function hookWindowRejection(
  state: ReadonlyWorldState,
  command: Command,
): Validation<never> | undefined {
  if (command.source !== "narrator") return undefined;
  const staging = (STAGING_COMMAND_KINDS as readonly CommandKind[]).includes(command.kind);
  const stagingHook = state.narrator.pendingHook?.kind === "stageDock";
  if (staging && !stagingHook) {
    return reject("preconditionFailed", `"${command.kind}" answers a stageDock hook only`);
  }
  if (!staging && stagingHook) {
    return reject(
      "preconditionFailed",
      `"${command.kind}" cannot answer a stageDock hook: staging sets the stage only`,
    );
  }
  return undefined;
}

/** Authority + handler lookup + validate: the pure part shared by enqueue and apply. */
export function validateCommand(
  registry: KernelRegistry,
  ctx: ValidateCtx,
  command: Command,
): Validation<unknown> {
  const allowed = AUTHORITY[command.source] as readonly CommandKind[] | undefined;
  if (allowed === undefined) {
    return reject("unauthorized", `Unknown command source "${String(command.source)}"`);
  }
  if (!allowed.includes(command.kind)) {
    return reject("unauthorized", `Source "${command.source}" may not issue "${command.kind}"`);
  }
  const windowRejection = hookWindowRejection(ctx.state, command);
  if (windowRejection !== undefined) return windowRejection;
  const handler = registry.commandHandler(command.kind);
  if (handler === undefined) {
    return reject("invalidPayload", `No handler is registered for command kind "${command.kind}"`);
  }
  return handler.validate(ctx, command as CommandOfKind<typeof command.kind>);
}

function isKnownCommandId(state: ReadonlyWorldState, id: CommandId): boolean {
  return (
    state.commands.recentIds.includes(id) || state.commands.queue.some((queued) => queued.id === id)
  );
}

function rememberCommandId(world: Pick<World, "state">, id: CommandId): void {
  const recent = world.state.commands.recentIds;
  recent.push(id);
  if (recent.length > RECENT_COMMAND_IDS_CAP) {
    recent.splice(0, recent.length - RECENT_COMMAND_IDS_CAP);
  }
}

/** Validate and queue. No state change on rejection. */
export function enqueueCommand(
  world: World,
  registry: KernelRegistry,
  command: Command,
): EnqueueResult {
  const rejected = (rejection: CommandRejection): EnqueueResult => ({
    status: "rejected",
    commandId: command.id,
    rejection,
  });
  const { state } = world;
  if (typeof command.id !== "string" || command.id.length === 0) {
    return rejected({ code: "invalidPayload", reason: "Command id must be a non-empty string" });
  }
  const allowed = AUTHORITY[command.source] as readonly CommandKind[] | undefined;
  if (allowed === undefined || !allowed.includes(command.kind)) {
    return rejected({
      code: "unauthorized",
      reason: `Source "${String(command.source)}" may not issue "${command.kind}"`,
    });
  }
  if (isKnownCommandId(state, command.id)) {
    return rejected({ code: "duplicate", reason: `Command "${command.id}" was already received` });
  }
  const earliest = state.tick + 1;
  const applyAtTick = command.targetTick ?? earliest;
  if (!Number.isInteger(applyAtTick)) {
    return rejected({ code: "invalidPayload", reason: "targetTick must be an integer" });
  }
  if (applyAtTick < earliest) {
    return rejected({
      code: "tickInPast",
      reason: `targetTick ${applyAtTick} is not after the current tick ${state.tick}`,
    });
  }
  const validation = validateCommand(registry, validateCtxOf(world, applyAtTick), command);
  if (!validation.ok) {
    return rejected(validation.rejection);
  }

  // Detach from the caller's object and drop any `undefined`-valued keys (JSON-safe state).
  const copy = JSON.parse(JSON.stringify(command)) as Command;
  const queued = { ...copy, applyAtTick, seq: state.commands.nextSeq } as QueuedCommand;
  state.commands.nextSeq += 1;
  const queue = state.commands.queue;
  let insertAt = queue.length;
  while (insertAt > 0 && (queue[insertAt - 1] as QueuedCommand).applyAtTick > applyAtTick) {
    insertAt -= 1;
  }
  queue.splice(insertAt, 0, queued);
  return { status: "accepted", commandId: command.id, applyAtTick };
}

/** Revalidate and apply one command now, emitting `commandApplied` or `commandRejected`. */
function executeCommand(
  registry: KernelRegistry,
  ctx: ApplyCtx,
  command: Command,
): Validation<AppliedCommand> {
  const validateCtx: ValidateCtx = {
    state: ctx.state,
    content: ctx.content,
    config: ctx.config,
    defs: ctx.defs,
    tick: ctx.tick,
  };
  const validation = validateCommand(registry, validateCtx, command);
  const base = { subjectIds: [], causeIds: [command.id], source: command.source } as const;
  if (!validation.ok) {
    ctx.emit({
      ...base,
      type: "commandRejected",
      payload: { kind: command.kind, rejection: validation.rejection },
    });
    return validation;
  }
  // validateCommand returned ok, so the handler exists.
  const handler = registry.commandHandler(command.kind) as CommandHandler<CommandKind, unknown>;
  const applied = handler.apply(ctx, command, validation.plan);
  ctx.emit({
    ...base,
    subjectIds: Object.values(applied.tempRefs),
    type: "commandApplied",
    payload: { kind: command.kind, tempRefs: applied.tempRefs },
  });
  return ok(applied);
}

/** Phase 1: apply every queued command whose `applyAtTick` has arrived, in `(tick, seq)` order. */
export function applyDueCommands(registry: KernelRegistry, ctx: ApplyCtx): void {
  const queue = ctx.state.commands.queue;
  while (queue.length > 0 && (queue[0] as QueuedCommand).applyAtTick <= ctx.tick) {
    const queued = queue.shift() as QueuedCommand;
    const { applyAtTick: _applyAt, seq: _seq, ...command } = queued;
    executeCommand(registry, ctx, command as Command);
    rememberCommandId(ctx, queued.id);
  }
}

/**
 * Validate and apply immediately, outside the pipeline (world setup). Throws on rejection: a
 * scenario that does not apply is a content bug. Events go to `emit`.
 */
export function applyCommandNow(
  registry: KernelRegistry,
  ctx: ApplyCtx,
  command: Command,
): AppliedCommand {
  if (isKnownCommandId(ctx.state, command.id)) {
    throw new Error(`Command "${command.id}" was already applied`);
  }
  const result = executeCommand(registry, ctx, command);
  if (!result.ok) {
    throw new Error(
      `Setup command "${command.id}" (${command.kind}) rejected: ${result.rejection.code}: ${result.rejection.reason}`,
    );
  }
  rememberCommandId(ctx, command.id);
  return result.plan;
}

/** Convenience for handlers: an event draft caused by `command`. */
export function causedBy(command: Command): Pick<EventDraft, "causeIds" | "source"> {
  return { causeIds: [command.id], source: command.source };
}
