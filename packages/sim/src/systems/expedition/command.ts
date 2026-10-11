import { configTicks } from "../../core/clock";
/**
 * Expeditions A1 (plan calls 3 and 11): `scenarioStartExpedition`, `adoptPlan` and
 * `withdrawParty`. Validation is complete here (the kernel revalidates at apply, so every rule
 * holds at both moments).
 *
 * **Start.** Valid for a known port of `kind: "site"` with a site map, while the ship is docked
 * with no course set; nobody and nothing on the dock alongside (or in a ramp's aperture), no
 * ramp jammed, no dock hand on an errand, and no expedition under way. The cast (the payload's,
 * else the map's `defaultCast`) is within `SITE_LIMITS` (six people, three armed, one target, one
 * ally), every entry well formed and at a post of its part's kind on the site map (a `target` at a
 * `target`, a `guard` at a `guard`, a `bystander` at a `bystander`, an `ally` at either), and the
 * arms it carries exist as weapon items (`castProblem`, `start.ts`). A `plan` must be on the plan
 * menu and available.
 *
 * Apply swaps the dock in place under scenario authority: the ramps are set shut, the hub's
 * locals and props go with its dock (`clearDockside`), `detachDock`, `travel` becomes docked at the
 * site, `attachDock` with the site's map, the ramps set open, the site dressed (no floor set: a
 * site has no regulars); then `startExpedition` (`start.ts`, A2 call 12) spawns the cast and writes
 * `state.expedition`. The narrator's bookkeeping is untouched; commerce raises no `captainAshore`
 * at a site.
 *
 * **adoptPlan** chooses the plan for an expedition that has none (an available menu id) and picks
 * its party by the plan's squad rule. **withdrawParty** calls a party that is out back to the ramp
 * (`orderWithdrawal`).
 *
 * Owner after the gate: W2 of expeditions A1 (extends the validation tests).
 */
import {
  type ApplyCtx,
  type CommandHandler,
  NO_TEMP_REFS,
  type ValidateCtx,
  type Validation,
  causedBy,
  ok,
  reject,
} from "../../core/commands";
import { dockForPort, isOnDock } from "../../core/docks";
import { clearDockside, dressDock } from "../../core/locals";
import { isSite } from "../../core/places";
import type { CommandOfKind, CommandRejection } from "../../core/types/commands";
import type { ActorId, PortDefId } from "../../core/types/ids";
import type { BattlePlan } from "../../core/types/state";
import { shipDeckId } from "../../core/world";
import { planMenu } from "../../view/planMenu";
import { attachDock, detachDock } from "../spatial/dock";
import { syncRampPassability } from "../spatial/geometry";
import { orderWithdrawal } from "./expedition";
import { type StartPlan, castProblem, castWeapons, partyOf, startExpedition } from "./start";

type StartPayload = CommandOfKind<"scenarioStartExpedition">["payload"];

const fail = (kind: string, code: CommandRejection["code"], reason: string) =>
  reject(code, `${kind}: ${reason}`);

/** Why the dock alongside cannot be cast off now, or undefined (call 3's precondition). */
function dockProblem(ctx: ValidateCtx): string | undefined {
  const { state, content } = ctx;
  if (state.deck.dock === undefined) return undefined;
  const onDock = (location: Parameters<typeof isOnDock>[2]) => isOnDock(content, state, location);
  const person = Object.values(state.actors).find((a) => onDock(a.location));
  if (person !== undefined) return `${person.name} is on the dock`;
  const thing = Object.values(state.items).find((i) => onDock(i.location));
  if (thing !== undefined) return `item ${thing.id} is on the dock`;
  for (const door of Object.values(state.doors)) {
    if (door.kind !== "ramp") continue;
    if (door.occupants.length > 0) return `someone is on the ramp ${door.placementKey}`;
    if (door.physicalState === "jammed") return `the ramp ${door.placementKey} is jammed`;
  }
  const errand = Object.values(state.dockside.locals).find((l) => l.errand !== undefined);
  if (errand !== undefined) return `${errand.name} is on an errand`;
  return undefined;
}

/** The menu's option `planId`, if it is there and available; else why not. */
function chosenPlan(ctx: ValidateCtx, planId: unknown, siteId: PortDefId): BattlePlan | string {
  if (typeof planId !== "string") return "plan must be a menu id";
  const menu = planMenu(ctx.state, ctx.content, ctx.config, siteId);
  const option = menu.find((o) => o.id === planId);
  if (option === undefined) return `"${planId}" is not on the plan menu`;
  if (!option.available) return `"${planId}" is not available: ${option.why}`;
  return option.plan;
}

function validateStart(ctx: ValidateCtx, payload: StartPayload): Validation<StartPlan> {
  const kind = "scenarioStartExpedition";
  const { siteId } = payload;
  if (ctx.content.ports[siteId] === undefined) {
    return fail(kind, "unknownEntity", `unknown port "${String(siteId)}"`);
  }
  if (!isSite(ctx.content, siteId)) {
    return fail(kind, "invalidPayload", `"${siteId}" is a port, not a site`);
  }
  const site = dockForPort(ctx.content, siteId);
  if (site === undefined || site.kind !== "site") {
    return fail(kind, "invalidPayload", `"${siteId}" has no site map`);
  }
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") {
    return fail(kind, "preconditionFailed", `the ship is under way (${travel.stage})`);
  }
  if (travel.plannedDestinationId !== undefined || travel.voyageDestinationId !== undefined) {
    return fail(kind, "preconditionFailed", "a course is set");
  }
  const expedition = ctx.state.expedition;
  if (expedition !== undefined && expedition.phase !== "resolved") {
    return fail(kind, "preconditionFailed", `an expedition is under way at ${expedition.siteId}`);
  }
  const dock = dockProblem(ctx);
  if (dock !== undefined) return fail(kind, "preconditionFailed", dock);
  const cast = payload.cast ?? site.defaultCast ?? [];
  const weapons = castWeapons(ctx);
  const problem = castProblem(cast, site, weapons);
  if (problem !== undefined) return fail(kind, problem.code, problem.reason);
  let plan: BattlePlan | undefined;
  if (payload.plan !== undefined) {
    const chosen = chosenPlan(ctx, payload.plan, siteId);
    if (typeof chosen === "string") return fail(kind, "preconditionFailed", chosen);
    plan = chosen;
  }
  return ok({
    siteId,
    site,
    cast,
    weapons,
    ...(plan === undefined ? {} : { plan }),
    ...partyOf(ctx, plan),
  });
}

/** Shut every ramp of the ship at once (scenario authority: no travel time). */
function setRamps(ctx: ApplyCtx, to: "open" | "closed"): void {
  for (const door of Object.values(ctx.state.doors)) {
    if (door.kind !== "ramp") continue;
    door.physicalState = to;
    door.requestedState = to;
    door.transitionProgress = 0;
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete door.closeAfterTick;
  }
  syncRampPassability(ctx.state, ctx.caches);
}

/** Call 3: swap the dock alongside for the site's, in place. */
function swapToSite(ctx: ApplyCtx, plan: StartPlan): void {
  const deckId = shipDeckId(ctx.state);
  if (ctx.state.deck.dock !== undefined) {
    setRamps(ctx, "closed");
    clearDockside(ctx.state);
    detachDock(ctx);
  }
  ctx.state.travel = { stage: "docked", portId: plan.siteId };
  attachDock(ctx, { dockId: plan.site.id, deckId });
  setRamps(ctx, "open");
  const shuffle = configTicks(ctx.config, ctx.config.travel.localShuffleSeconds);
  dressDock(ctx.state, ctx.content, undefined, ctx.tick, shuffle);
}

export const scenarioStartExpedition: CommandHandler<"scenarioStartExpedition", StartPlan> = {
  validate(ctx, command) {
    return validateStart(ctx, command.payload);
  },
  apply(ctx, command, plan) {
    swapToSite(ctx, plan);
    startExpedition(ctx, plan, { kind: "command", command });
    return NO_TEMP_REFS;
  },
};

interface AdoptPlan {
  readonly plan: BattlePlan;
  readonly party: readonly ActorId[];
  readonly leaderId: ActorId;
}

export const adoptPlan: CommandHandler<"adoptPlan", AdoptPlan> = {
  validate(ctx, command) {
    const kind = "adoptPlan";
    const expedition = ctx.state.expedition;
    if (expedition === undefined || expedition.phase === "resolved") {
      return fail(kind, "preconditionFailed", "no expedition is under way");
    }
    if (expedition.plan !== undefined) {
      return fail(kind, "preconditionFailed", `the plan is already "${expedition.plan.id}"`);
    }
    const chosen = chosenPlan(ctx, command.payload.planId, expedition.siteId);
    if (typeof chosen === "string") return fail(kind, "preconditionFailed", chosen);
    return ok({ plan: chosen, ...partyOf(ctx, chosen) });
  },
  apply(ctx, _command, plan) {
    const expedition = ctx.state.expedition;
    if (expedition === undefined) throw new Error("validated expedition vanished");
    expedition.plan = plan.plan;
    expedition.party = [...plan.party];
    expedition.leaderId = plan.leaderId;
    return NO_TEMP_REFS;
  },
};

export const withdrawParty: CommandHandler<"withdrawParty", null> = {
  validate(ctx) {
    const expedition = ctx.state.expedition;
    if (expedition === undefined || expedition.phase === "resolved") {
      return fail("withdrawParty", "preconditionFailed", "no expedition is under way");
    }
    if (expedition.phase !== "approach" && expedition.phase !== "fight") {
      return fail("withdrawParty", "preconditionFailed", "the party is not ashore yet");
    }
    return ok(null);
  },
  apply(ctx, command) {
    orderWithdrawal(ctx, causedBy(command));
    return NO_TEMP_REFS;
  },
};
