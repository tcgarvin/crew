/**
 * The staging call (Dockside §6.1, D66): the guaranteed `stageDock` hook and the transit hold,
 * and the `stageDock` command that answers it.
 *
 * At a port with a dock map, travel raises `stageDock` once the ship is within
 * `narrator.approachHookLeadSeconds` of the end of its route (as a distance at
 * `travel.nominalSpeed`, so a drift only delays it), and holds in `transit`, at the end of the
 * route, until that hook has been raised and acknowledged. Unlike every other hook it is never
 * dropped: if another is pending at the lead point the record waits as `due`, and travel raises
 * it on the first tick no hook is (travel runs before commerce, `notableEvent`, the policy hook
 * and the quiet timer, so it is first in line on the tick after the other's acknowledgement).
 * The record rides on the `transit` and `approaching` stage objects and is spent at the start of
 * `docking`, where its plan dresses the dock with the floor set; the `docking` object is built
 * without it, so a record never outlives its leg.
 *
 * A port without a dock map (hand-built test bundles) has nothing to stage: no hook, no hold.
 */
import { type CommandHandler, NO_TEMP_REFS, ok, reject } from "../../core/commands";
import { findItemDef } from "../../core/defs";
import { dockForPort } from "../../core/docks";
import { floorSet } from "../../core/floor-set";
import { raiseHookIfIdle } from "../../core/hooks";
import type { CommandOfKind } from "../../core/types/commands";
import type { DockDef } from "../../core/types/content";
import type { NarratorHook } from "../../core/types/decisions";
import {
  STAGING_LIMITS,
  type StagedPersonSpec,
  type StagedPlacement,
  type StagedProp,
  type StagingPlan,
} from "../../core/types/dockside";
import type { ItemDefId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { TravelStage, TravelState } from "../../core/types/travel";

/** Travel away from the dock: the stage objects that carry route progress. */
type InFlight = Extract<TravelState, { stage: Exclude<TravelStage, "docked"> }>;

/** The lead point: route distance left at which the staging call is raised. */
function leadDistance(ctx: Pick<StepCtx, "config">): number {
  return ctx.config.narrator.approachHookLeadSeconds * ctx.config.travel.nominalSpeed;
}

/**
 * Transit, every tick, before the end-of-route check: open the staging record at the lead point
 * and raise the hook as soon as no other hook is pending.
 */
export function stageDockIfDue(ctx: StepCtx, travel: InFlight): void {
  const dock = dockForPort(ctx.content, travel.toPortId);
  if (dock === undefined) return;
  if (travel.staging === undefined) {
    if (travel.routeDistance - travel.routeProgress > leadDistance(ctx)) return;
    travel.staging = { status: "due" };
  }
  if (travel.staging.status !== "due" || ctx.state.narrator.pendingHook !== undefined) return;
  const raised = raiseHookIfIdle(ctx, "stageDock", {
    portId: travel.toPortId,
    dockId: dock.id,
    floorSet: floorSet(ctx.state, ctx.content, travel.toPortId),
  });
  // Re-read: the narrowing above does not know `raiseHookIfIdle` wrote it.
  const hook = ctx.state.narrator.pendingHook as NarratorHook | undefined;
  if (!raised || hook?.kind !== "stageDock") {
    throw new Error("stageDock: raising failed with no hook pending");
  }
  travel.staging = { status: "raised", hookId: hook.id };
}

/**
 * May transit end? Yes at a port with no dock map; otherwise only once the staging hook has been
 * raised and is no longer pending (the host acknowledged it, with or without a plan).
 */
export function stagingAnswered(
  state: Pick<ReadonlyWorldState, "narrator">,
  content: StepCtx["content"],
  travel: Pick<InFlight, "toPortId" | "staging">,
): boolean {
  if (dockForPort(content, travel.toPortId) === undefined) return true;
  const staging = travel.staging;
  return staging?.status === "raised" && state.narrator.pendingHook?.id !== staging.hookId;
}

// ---------------------------------------------------------------------------------------------
// The stageDock command
// ---------------------------------------------------------------------------------------------

/** No control characters, no template braces, not blank, at most `max` characters. */
function textProblem(value: unknown, what: string, max: number): string | undefined {
  if (typeof value !== "string") return `${what} must be text`;
  const text = value.trim();
  if (text === "") return `${what} is empty`;
  if (text.length > max) return `${what} is longer than ${max} characters`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
  if (/[\u0000-\u001f\u007f]/.test(text)) return `${what} has control characters`;
  if (/[{}]/.test(text)) return `${what} has template braces`;
  return undefined;
}

function personProblem(
  who: StagedPersonSpec,
  ctx: { readonly content: StepCtx["content"]; readonly state: ReadonlyWorldState },
  portId: string,
): string | undefined {
  if (typeof who !== "object" || who === null) return "a placement needs a person";
  const name = textProblem(who.name, "a name", STAGING_LIMITS.nameChars);
  if (name !== undefined) return name;
  const lower = who.name.trim().toLowerCase();
  const crew = Object.values(ctx.state.actors).find((a) => a.name.toLowerCase() === lower);
  if (crew !== undefined && crew.availability !== "offShip") {
    return `"${who.name}" is aboard, not on the dock`;
  }
  switch (who.kind) {
    case "seed": {
      const seeds = ctx.content.ports[portId as keyof typeof ctx.content.ports]?.castSeed ?? [];
      return seeds.some((s) => s.name.toLowerCase() === lower)
        ? undefined
        : `"${who.name}" is not one of this port's people`;
    }
    case "cast":
      return textProblem(who.role, "a role", STAGING_LIMITS.roleChars);
    case "newFace":
      return (
        textProblem(who.role, "a role", STAGING_LIMITS.roleChars) ??
        textProblem(who.look, "a look", STAGING_LIMITS.lookChars)
      );
    default:
      return `unknown kind of person "${String((who as { kind: unknown }).kind)}"`;
  }
}

function placementProblem(
  placement: StagedPlacement,
  dock: DockDef,
  ctx: { readonly content: StepCtx["content"]; readonly state: ReadonlyWorldState },
): string | undefined {
  if (typeof placement !== "object" || placement === null) return "a placement must be an object";
  const who = personProblem(placement.who, ctx, dock.portId);
  if (who !== undefined) return who;
  if (!dock.posts.some((p) => p.key === placement.postKey)) {
    return `"${String(placement.postKey)}" is not a post on ${dock.name}`;
  }
  if (placement.label === undefined) return undefined;
  return textProblem(placement.label, "a label", STAGING_LIMITS.labelChars);
}

function propProblem(
  prop: StagedProp,
  dock: DockDef,
  ctx: { readonly content: StepCtx["content"]; readonly state: ReadonlyWorldState },
): string | undefined {
  if (typeof prop !== "object" || prop === null) return "a prop must be an object";
  if (findItemDef(ctx.content, ctx.state, prop.itemDefId as ItemDefId) === undefined) {
    return `"${String(prop.itemDefId)}" is not in the item catalogue`;
  }
  if (!Number.isInteger(prop.count) || prop.count < 1 || prop.count > STAGING_LIMITS.propUnits) {
    return `a prop's count must be 1 to ${STAGING_LIMITS.propUnits}`;
  }
  const at = prop.at;
  if (at?.kind === "staging") return undefined;
  if (at?.kind === "post") {
    return dock.posts.some((p) => p.key === at.postKey)
      ? undefined
      : `"${String(at.postKey)}" is not a post on ${dock.name}`;
  }
  return "a prop goes on the staging area or by a post";
}

/** The plan as stored: text trimmed, nothing the payload carried beyond the plan's fields. */
function normalised(plan: StagingPlan): StagingPlan {
  const trim = (s: string) => s.trim().replace(/\s+/g, " ");
  const who = (p: StagedPersonSpec): StagedPersonSpec => {
    switch (p.kind) {
      case "seed":
        return { kind: "seed", name: trim(p.name) };
      case "cast":
        return { kind: "cast", name: trim(p.name), role: trim(p.role).toLowerCase() };
      case "newFace":
        return {
          kind: "newFace",
          name: trim(p.name),
          role: trim(p.role).toLowerCase(),
          look: trim(p.look),
        };
    }
  };
  return {
    place: plan.place.map((p) => ({
      who: who(p.who),
      postKey: p.postKey,
      ...(p.label === undefined ? {} : { label: trim(p.label) }),
    })),
    props: plan.props.map((p) => ({
      itemDefId: p.itemDefId,
      count: p.count,
      at: p.at.kind === "staging" ? { kind: "staging" } : { kind: "post", postKey: p.at.postKey },
    })),
    ...(plan.ambience === undefined ? {} : { ambience: trim(plan.ambience) }),
  };
}

/**
 * `stageDock` (D66): the staging plan for the dock the ship is about to come alongside. Valid
 * only while a `stageDock` hook is pending for the leg in flight and its plan is not yet set
 * (one plan per call); every person, post, prop and line is checked against content and the
 * dock map, and any problem rejects the whole plan (the translator drops bad parts first, with
 * reasons; the kernel never applies half a plan).
 */
export const stageDock: CommandHandler<"stageDock", StagingPlan> = {
  validate(ctx, command) {
    const hook = ctx.state.narrator.pendingHook;
    if (hook?.kind !== "stageDock") {
      return reject("preconditionFailed", "stageDock: no stageDock hook is pending");
    }
    const travel = ctx.state.travel;
    if (
      travel.stage !== "transit" ||
      travel.staging?.status !== "raised" ||
      travel.staging.hookId !== hook.id
    ) {
      return reject("preconditionFailed", "stageDock: the staging call is not open");
    }
    if (travel.staging.plan !== undefined) {
      return reject("duplicate", "stageDock: this dock is already staged");
    }
    const dock = ctx.content.docks?.[hook.context.dockId];
    if (dock === undefined || dock.portId !== hook.context.portId) {
      return reject("unknownEntity", `stageDock: no dock "${hook.context.dockId}"`);
    }
    const plan = command.payload;
    if (!Array.isArray(plan.place) || !Array.isArray(plan.props)) {
      return reject("invalidPayload", "stageDock: place and props must be lists");
    }
    if (plan.place.length > STAGING_LIMITS.people) {
      return reject("outOfBounds", `stageDock: at most ${STAGING_LIMITS.people} people`);
    }
    if (plan.props.length > STAGING_LIMITS.props) {
      return reject("outOfBounds", `stageDock: at most ${STAGING_LIMITS.props} props`);
    }
    const env = { content: ctx.content, state: ctx.state };
    const names = new Set<string>();
    for (const placement of plan.place) {
      const problem = placementProblem(placement, dock, env);
      if (problem !== undefined) return reject("invalidPayload", `stageDock: ${problem}`);
      const key = placement.who.name.trim().toLowerCase();
      if (names.has(key)) {
        return reject("invalidPayload", `stageDock: "${placement.who.name}" is placed twice`);
      }
      names.add(key);
    }
    for (const prop of plan.props) {
      const problem = propProblem(prop, dock, env);
      if (problem !== undefined) return reject("invalidPayload", `stageDock: ${problem}`);
    }
    if (plan.ambience !== undefined) {
      const problem = textProblem(plan.ambience, "the ambience line", STAGING_LIMITS.ambienceChars);
      if (problem !== undefined) return reject("invalidPayload", `stageDock: ${problem}`);
    }
    return ok(normalised(plan));
  },
  apply(ctx, _command: CommandOfKind<"stageDock">, plan) {
    const travel = ctx.state.travel;
    if (travel.stage !== "transit" || travel.staging?.status !== "raised") {
      throw new Error("stageDock: validated staging record vanished");
    }
    travel.staging.plan = plan;
    return NO_TEMP_REFS;
  },
};
