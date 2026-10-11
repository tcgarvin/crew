/**
 * Handlers for the kernel-owned decision kinds: `surfaceDecision` and `resolveDecision`
 * (§cards-and-sides). Decisions are kernel-owned (CONTRACTS: `Decision`/`NarratorHook` types), so
 * they live in core rather than in a system, unlike `resolveDecision`'s option commands, which
 * belong to their owning systems.
 *
 * §follow-up-cards: a card side may carry a `next` card (and a tried side a `failNext`).
 * `surfaceDecision` mints each as its own pending record, neither queued nor held, and links it
 * from the side; `resolveDecision` puts the follow-up of the branch taken at the head of the queue
 * and drops every other follow-up the card carried (`decisionDropped`), so no pending record is
 * left that nothing can reach. A follow-up card has no follow-ups of its own.
 *
 * §tried-sides: a side with an `attempt` is a try. Choosing it rolls the odds once on the seeded
 * `narrator` stream, writes `Decision.tried` and emits `attemptRolled`; it then runs the side as
 * usual if the roll worked, or its failure branch (`failCommands` as `player`, then `failLevers` as
 * `narrator`, each checked again at that moment) if not.
 */
import { commandActor, isFitForCommand } from "./command-actor";
import {
  type AppliedCommand,
  type ApplyCtx,
  type CommandHandler,
  NO_TEMP_REFS,
  type ValidateCtx,
  type Validation,
  causedBy,
  ok,
  reject,
  validateCommand,
} from "./commands";
import { dropFollowUps } from "./decisions";
import { cardSpeaker, queueOrHold } from "./delivery";
import { allocateId } from "./ids";
import type { KernelRegistry } from "./registry";
import type {
  Command,
  CommandDraft,
  CommandKind,
  CommandOfKind,
  CommandSource,
  DecisionCardSide,
  DecisionCardSpec,
} from "./types/commands";
import { AUTHORITY, FAIL_LEVER_KINDS } from "./types/commands/authority";
import type { Decision, DecisionAttempt, DecisionOption } from "./types/decisions";
import type { ActorId, CommandId, DecisionId, EntityId, TempRef } from "./types/ids";

const SIDES = ["left", "right"] as const;

/** A refusal, as `reject` builds it. */
type Rejection = Validation<never>;

// ---------------------------------------------------------------------------------------------
// surfaceDecision
// ---------------------------------------------------------------------------------------------

/**
 * A card side as a decision option; `aftermath` (§aftermath-caption) and `attempt` (§tried-sides)
 * only when the side has them (JSON-safe). The follow-up links are added by `mintFollowUps`.
 */
function optionFromSide(side: DecisionCardSide): DecisionOption {
  const attempt = side.attempt;
  return {
    label: side.label,
    commands: [...side.commands],
    ...(side.aftermath === undefined ? {} : { aftermath: side.aftermath }),
    ...(attempt === undefined
      ? {}
      : {
          attempt: {
            odds: attempt.odds,
            failCommands: [...attempt.failCommands],
            failLevers: [...attempt.failLevers],
            ...(attempt.failAftermath === undefined
              ? {}
              : { failAftermath: attempt.failAftermath }),
          } satisfies DecisionAttempt,
        }),
  };
}

/** A card option's draft as a command from `source` with id `id`, if `source` may issue it. */
function asCommand(id: string, source: CommandSource, draft: CommandDraft): Command | undefined {
  if (!(AUTHORITY[source] as readonly CommandKind[]).includes(draft.kind)) return undefined;
  return { id: id as CommandId, source, kind: draft.kind, payload: draft.payload } as Command;
}

/**
 * Why `drafts` cannot be a side's commands (each authorized for `player` and valid now), or
 * undefined. `where` names the side in the reason.
 */
function sideCommandsRejection(
  registry: KernelRegistry,
  ctx: ValidateCtx,
  idPrefix: string,
  where: string,
  drafts: readonly CommandDraft[],
): Rejection | undefined {
  for (const [index, draft] of drafts.entries()) {
    const sub = asCommand(`${idPrefix}#${index}`, "player", draft);
    if (sub === undefined) {
      return reject(
        "unauthorized",
        `surfaceDecision: ${where} option ${index} ("${draft.kind}") is not a player command`,
      );
    }
    const validation = validateCommand(registry, ctx, sub);
    if (!validation.ok) {
      return reject(
        validation.rejection.code,
        `surfaceDecision: ${where} option ${index} (${draft.kind}): ${validation.rejection.reason}`,
      );
    }
  }
  return undefined;
}

/**
 * §tried-sides: why a side's failure levers cannot go up: a kind not in `FAIL_LEVER_KINDS`, a card
 * not surfaced by the narrator or a scenario, or a lever the narrator could not issue now.
 */
function failLeversRejection(
  registry: KernelRegistry,
  ctx: ValidateCtx,
  source: CommandSource,
  idPrefix: string,
  where: string,
  drafts: readonly CommandDraft[],
): Rejection | undefined {
  if (drafts.length > 0 && source !== "narrator" && source !== "scenario") {
    return reject(
      "unauthorized",
      `surfaceDecision: ${where} failLevers come only from the narrator or a scenario`,
    );
  }
  for (const [index, draft] of drafts.entries()) {
    if (!(FAIL_LEVER_KINDS as readonly string[]).includes(draft.kind)) {
      return reject(
        "unauthorized",
        `surfaceDecision: ${where} failLever ${index} ("${draft.kind}") is not an outcome lever`,
      );
    }
    const sub = asCommand(`${idPrefix}#fail-lever#${index}`, "narrator", draft);
    const validation =
      sub === undefined
        ? reject("unauthorized", `"${draft.kind}" is not a narrator command`)
        : validateCommand(registry, ctx, sub);
    if (!validation.ok) {
      return reject(
        validation.rejection.code,
        `surfaceDecision: ${where} failLever ${index} (${draft.kind}): ${validation.rejection.reason}`,
      );
    }
  }
  return undefined;
}

/** Why a side cannot go up (its commands, and for a try its odds and failure branch), or not. */
function sideRejection(
  registry: KernelRegistry,
  ctx: ValidateCtx,
  source: CommandSource,
  idPrefix: string,
  where: string,
  side: DecisionCardSide,
): Rejection | undefined {
  const commands = sideCommandsRejection(registry, ctx, idPrefix, where, side.commands);
  if (commands !== undefined) return commands;
  const attempt = side.attempt;
  if (attempt === undefined) return undefined;
  const odds = attempt.odds;
  if (typeof odds !== "number" || !Number.isInteger(odds) || odds < 0 || odds > 100) {
    return reject(
      "invalidPayload",
      `surfaceDecision: ${where} odds must be a whole percent from 0 to 100`,
    );
  }
  return (
    sideCommandsRejection(
      registry,
      ctx,
      `${idPrefix}#fail`,
      `${where} failure`,
      attempt.failCommands,
    ) ?? failLeversRejection(registry, ctx, source, idPrefix, where, attempt.failLevers)
  );
}

/** The follow-up cards a card's sides carry (§follow-up-cards), with where each hangs. */
function followUpsOf(card: DecisionCardSpec): { where: string; card: DecisionCardSpec }[] {
  const out: { where: string; card: DecisionCardSpec }[] = [];
  for (const which of SIDES) {
    const next = card[which].next;
    if (next !== undefined) out.push({ where: `${which} follow-up`, card: next });
    const failNext = card[which].attempt?.failNext;
    if (failNext !== undefined) out.push({ where: `${which} failure follow-up`, card: failNext });
  }
  return out;
}

/**
 * Why `card` cannot go up: a side's commands are not the player's or not valid now, a try is
 * malformed, or a follow-up is nested or carries a job. `depth` is 0 for the card itself and 1
 * for a follow-up.
 */
function cardRejection(
  registry: KernelRegistry,
  ctx: ValidateCtx,
  source: CommandSource,
  idPrefix: string,
  card: DecisionCardSpec,
  depth: 0 | 1,
  label: string,
): Rejection | undefined {
  for (const which of SIDES) {
    const where = label === "" ? which : `${label} ${which}`;
    const problem = sideRejection(
      registry,
      ctx,
      source,
      `${idPrefix}#${which}`,
      where,
      card[which],
    );
    if (problem !== undefined) return problem;
  }
  const followUps = followUpsOf(card);
  if (depth === 1) {
    if (followUps.length > 0) {
      return reject(
        "invalidPayload",
        `surfaceDecision: ${label} has a follow-up of its own; a follow-up card has none`,
      );
    }
    if (card.jobId !== undefined) {
      return reject("invalidPayload", `surfaceDecision: ${label} cannot carry a job`);
    }
    return undefined;
  }
  for (const followUp of followUps) {
    const problem = cardRejection(
      registry,
      ctx,
      source,
      `${idPrefix}#${followUp.where.replaceAll(" ", "-")}`,
      followUp.card,
      1,
      followUp.where,
    );
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** The perspective a card is framed from: its own, if valid, else the D8 command actor. */
function perspectiveOf(
  ctx: ValidateCtx,
  card: DecisionCardSpec,
): { ok: true; actorId: ActorId } | { ok: false; rejection: Rejection } {
  if (card.perspectiveActorId === undefined) return { ok: true, actorId: commandActor(ctx.state) };
  const actor = ctx.state.actors[card.perspectiveActorId];
  if (actor === undefined) {
    return {
      ok: false,
      rejection: reject(
        "unknownEntity",
        `surfaceDecision: unknown perspective actor "${card.perspectiveActorId}"`,
      ),
    };
  }
  if (!isFitForCommand(actor)) {
    return {
      ok: false,
      rejection: reject(
        "preconditionFailed",
        `surfaceDecision: perspective actor "${card.perspectiveActorId}" is not available`,
      ),
    };
  }
  return { ok: true, actorId: actor.id };
}

interface SurfaceDecisionPlan {
  readonly perspectiveActorId: ActorId;
}

/** A new pending decision record for `card`, framed from `perspectiveActorId`. */
function recordFor(
  ctx: ApplyCtx,
  command: Command,
  card: DecisionCardSpec,
  perspectiveActorId: ActorId,
): Decision {
  const decisionId = allocateId(ctx.state, "decision");
  const record: Decision = {
    id: decisionId,
    origin: command.source === "narrator" ? "narrator" : "policy",
    perspectiveActorId,
    prompt: card.prompt,
    left: optionFromSide(card.left),
    right: optionFromSide(card.right),
    status: "pending",
    createdTick: ctx.tick,
    ...(card.jobId !== undefined ? { jobId: card.jobId } : {}),
  };
  ctx.state.decisions.records[decisionId] = record;
  return record;
}

/**
 * §follow-up-cards: mint each follow-up as a pending record (neither queued nor held: only its
 * branch brings it up) and link it from its side, as `nextDecisionId` or, after a failed try,
 * `attempt.failNextDecisionId`. A follow-up is framed from its own perspective if it names one,
 * else from the card's.
 */
function mintFollowUps(
  ctx: ApplyCtx,
  command: Command,
  card: DecisionCardSpec,
  record: Decision,
): void {
  const mint = (next: DecisionCardSpec): DecisionId => {
    const own = next.perspectiveActorId;
    const perspective =
      own !== undefined && ctx.state.actors[own] !== undefined ? own : record.perspectiveActorId;
    return recordFor(ctx, command, next, perspective).id;
  };
  for (const which of SIDES) {
    const side = card[which];
    const option = record[which];
    if (side.next !== undefined) option.nextDecisionId = mint(side.next);
    const failNext = side.attempt?.failNext;
    if (failNext !== undefined && option.attempt !== undefined) {
      option.attempt.failNextDecisionId = mint(failNext);
    }
  }
}

/**
 * Each option's commands are checked twice: authorized for `player` here (so a stale queued card
 * cannot smuggle in a command nobody could ever pick), and again, fully, by `resolveDecision` at
 * resolve time against the state as it is then. A follow-up card's sides are checked the same way
 * here, and again when its own side is chosen; a try's failure levers here and again on failure.
 */
function surfaceDecisionHandler(
  registry: KernelRegistry,
): CommandHandler<"surfaceDecision", SurfaceDecisionPlan> {
  return {
    validate(ctx, command): Validation<SurfaceDecisionPlan> {
      const { card } = command.payload;
      const problem = cardRejection(registry, ctx, command.source, command.id, card, 0, "");
      if (problem !== undefined) return problem;
      for (const followUp of followUpsOf(card)) {
        const perspective = perspectiveOf(ctx, followUp.card);
        if (!perspective.ok) return perspective.rejection;
      }
      const perspective = perspectiveOf(ctx, card);
      if (!perspective.ok) return perspective.rejection;
      if (card.jobId !== undefined) {
        const duplicate = Object.values(ctx.state.decisions.records).find(
          (d) => d.status === "pending" && d.jobId === card.jobId,
        );
        if (duplicate !== undefined) {
          return reject(
            "duplicate",
            `surfaceDecision: a decision for job "${card.jobId}" is already queued`,
          );
        }
      }
      return ok({ perspectiveActorId: perspective.actorId });
    },
    apply(ctx, command, plan): AppliedCommand {
      const { card } = command.payload;
      const record = recordFor(ctx, command, card, plan.perspectiveActorId);
      mintFollowUps(ctx, command, card, record);
      // §delivery: a card from one of the port's people waits to be delivered in person.
      queueOrHold(ctx, record.id, cardSpeaker(ctx.state, record));
      return NO_TEMP_REFS;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// resolveDecision
// ---------------------------------------------------------------------------------------------

interface SubCommand {
  readonly command: Command;
  readonly plan: unknown;
}

interface ResolvePlan {
  readonly subCommands: readonly SubCommand[];
  /** §tried-sides: the failure branch's player commands, validated with the side's own. */
  readonly failSubCommands: readonly SubCommand[];
}

/** Validate `drafts` as the chosen side's player commands against the state now. */
function validatedSubCommands(
  registry: KernelRegistry,
  ctx: ValidateCtx,
  idPrefix: string,
  drafts: readonly CommandDraft[],
): { ok: true; subCommands: SubCommand[] } | { ok: false; rejection: Rejection } {
  const subCommands: SubCommand[] = [];
  for (const [index, draft] of drafts.entries()) {
    const sub = asCommand(`${idPrefix}#${index}`, "player", draft);
    if (sub === undefined) {
      return {
        ok: false,
        rejection: reject("unauthorized", `option command "${draft.kind}" is not a player command`),
      };
    }
    const validation = validateCommand(registry, ctx, sub);
    if (!validation.ok) {
      return {
        ok: false,
        rejection: reject(
          validation.rejection.code,
          `option command ${index} (${draft.kind}): ${validation.rejection.reason}`,
        ),
      };
    }
    subCommands.push({ command: sub, plan: validation.plan });
  }
  return { ok: true, subCommands };
}

/** Apply one validated sub-command, followed by its `commandApplied`. */
function applySubCommand(
  registry: KernelRegistry,
  ctx: ApplyCtx,
  parent: Command,
  { command: sub, plan }: SubCommand,
): Record<TempRef, EntityId> {
  const handler = registry.commandHandler(sub.kind) as CommandHandler<CommandKind, unknown>;
  const applied = handler.apply(ctx, sub as CommandOfKind<CommandKind>, plan);
  ctx.emit({
    type: "commandApplied",
    subjectIds: Object.values(applied.tempRefs),
    causeIds: [parent.id],
    source: sub.source,
    payload: { kind: sub.kind, tempRefs: applied.tempRefs },
  });
  return applied.tempRefs;
}

/**
 * §tried-sides: a failed try's outcome levers, as `narrator` commands, each validated against the
 * state as it is now (after the branch's player commands) and applied, or refused with
 * `failLeverRefused` when it is no longer possible; the captain's choice is never undone by one.
 */
function applyFailLevers(
  registry: KernelRegistry,
  ctx: ApplyCtx,
  parent: Command,
  decisionId: DecisionId,
  drafts: readonly CommandDraft[],
): Record<TempRef, EntityId> {
  const tempRefs: Record<TempRef, EntityId> = {};
  for (const [index, draft] of drafts.entries()) {
    const sub = asCommand(`${parent.id}#fail-lever#${index}`, "narrator", draft);
    const validation =
      sub === undefined
        ? reject("unauthorized", `"${draft.kind}" is not a narrator command`)
        : validateCommand(registry, ctx, sub);
    if (sub === undefined || !validation.ok) {
      ctx.emit({
        ...causedBy(parent),
        type: "failLeverRefused",
        subjectIds: [decisionId],
        payload: {
          decisionId,
          kind: draft.kind,
          reason: validation.ok ? "not a narrator command" : validation.rejection.reason,
        },
      });
      continue;
    }
    Object.assign(
      tempRefs,
      applySubCommand(registry, ctx, parent, { command: sub, plan: validation.plan }),
    );
  }
  return tempRefs;
}

/**
 * §requested-call-back: a standing `afterCard` request comes due the tick after a card is answered
 * with no follow-up to come (the scene is over).
 */
function noteCardAnswered(ctx: ApplyCtx): void {
  const request = ctx.state.narrator.callBack;
  if (request === undefined || request.when !== "afterCard") return;
  if (request.servedByHookId !== undefined || request.cardResolvedTick !== undefined) return;
  request.cardResolvedTick = ctx.tick;
}

/**
 * The chosen side's commands run as source `player` through the same authority check and
 * validators. W2 decision: every option command is validated against the state before any of
 * them applies (a batch against a shared snapshot, SD §5.2); if any is rejected the whole
 * resolution is rejected and the decision stays at the head of the queue. For a try both branches'
 * player commands are validated, since the roll comes after; its failure levers are not (they are
 * checked when they would apply, and refused alone).
 */
function resolveDecisionHandler(
  registry: KernelRegistry,
): CommandHandler<"resolveDecision", ResolvePlan> {
  return {
    validate(ctx, command): Validation<ResolvePlan> {
      const { decisionId, side } = command.payload;
      const decision = ctx.state.decisions.records[decisionId];
      if (decision === undefined) {
        return reject("unknownEntity", `unknown decision "${decisionId}"`);
      }
      if (decision.status !== "pending" || ctx.state.decisions.queue[0] !== decisionId) {
        return reject("preconditionFailed", `decision "${decisionId}" is not the one presented`);
      }
      if (side !== "left" && side !== "right") {
        return reject("invalidPayload", `side must be "left" or "right"`);
      }
      const option = decision[side];
      for (const next of [option.nextDecisionId, option.attempt?.failNextDecisionId]) {
        if (next !== undefined && ctx.state.decisions.records[next]?.status !== "pending") {
          return reject("preconditionFailed", `next decision "${next}" is not pending`);
        }
      }
      // The card's drafts are its own `CommandDraft`s read through `DeepReadonly`, which the
      // checker no longer unfolds over the whole union (slice 4 made it one kind longer).
      const sub = validatedSubCommands(
        registry,
        ctx,
        command.id,
        option.commands as readonly CommandDraft[],
      );
      if (!sub.ok) return sub.rejection;
      const fail = validatedSubCommands(
        registry,
        ctx,
        `${command.id}#fail`,
        (option.attempt?.failCommands ?? []) as readonly CommandDraft[],
      );
      if (!fail.ok) return fail.rejection;
      return ok({ subCommands: sub.subCommands, failSubCommands: fail.subCommands });
    },
    apply(ctx, command, plan): AppliedCommand {
      const { decisionId, side } = command.payload;
      const decisions = ctx.state.decisions;
      const decision = decisions.records[decisionId];
      if (decision === undefined) throw new Error("validated decision vanished");
      const option = decision[side];
      const attempt = option.attempt;
      // §tried-sides: one draw on the seeded narrator stream, only when a try is chosen.
      const worked = attempt === undefined || ctx.rng.chance("narrator", attempt.odds / 100);
      if (attempt !== undefined) {
        decision.tried = { odds: attempt.odds, worked };
        ctx.emit({
          ...causedBy(command),
          type: "attemptRolled",
          subjectIds: [decisionId, decision.perspectiveActorId],
          payload: { decisionId, side, odds: attempt.odds, worked },
        });
      }
      const tempRefs: Record<TempRef, EntityId> = {};
      for (const sub of worked ? plan.subCommands : plan.failSubCommands) {
        Object.assign(tempRefs, applySubCommand(registry, ctx, command, sub));
      }
      if (!worked && attempt !== undefined) {
        Object.assign(
          tempRefs,
          applyFailLevers(registry, ctx, command, decisionId, attempt.failLevers as CommandDraft[]),
        );
      }
      decision.status = "resolved";
      decision.resolvedTick = ctx.tick;
      decision.chosen = side;
      const queue = decisions.queue.filter((id) => id !== decisionId);
      const next = worked ? option.nextDecisionId : attempt?.failNextDecisionId;
      decisions.queue = next === undefined ? queue : [next, ...queue.filter((id) => id !== next)];
      ctx.emit({
        ...causedBy(command),
        type: "decisionResolved",
        subjectIds: [decisionId, decision.perspectiveActorId],
        payload: { decisionId, side },
      });
      // §follow-up-cards: after the resolution, so the card history has the choice before it
      // forgets the follow-ups that will never come up.
      dropFollowUps(ctx, decision, next, "its branch was not taken");
      if (next === undefined) noteCardAnswered(ctx);
      return { tempRefs };
    },
  };
}

export function registerDecisionCommandHandlers(registry: KernelRegistry): void {
  registry.registerCommandHandler("surfaceDecision", surfaceDecisionHandler(registry));
  registry.registerCommandHandler("resolveDecision", resolveDecisionHandler(registry));
}
