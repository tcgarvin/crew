import { configTicks } from "../../core/clock";
import { commandActor } from "../../core/command-actor";
import { newActor } from "../../core/command-handlers";
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
 * arms it carries exist as weapon items. A `plan` must be on the plan menu and available.
 *
 * Apply swaps the dock in place under scenario authority: the ramps are set shut, the hub's
 * locals and props go with its dock (`clearDockside`), `detachDock`, `travel` becomes docked at the
 * site, `attachDock` with the site's map, the ramps set open, the site dressed (no floor set: a
 * site has no regulars); each cast member is spawned as an actor (`crew: false`) on a generated
 * `gen.crew.site_*` def at their post, a combatant of side `them` with their disposition and their
 * weapon in hand; `state.expedition` is written, `mustering`, with the party the plan's squad rule
 * picks (`everyone` without a plan, call 11). The narrator's bookkeeping is untouched; commerce
 * raises no `captainAshore` at a site.
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
import { findCrewDef, findItemDef } from "../../core/defs";
import { berthDock, dockForPort, dockToDeck, isOnDock } from "../../core/docks";
import { allocateId } from "../../core/ids";
import { clearDockside, dressDock, postFacing } from "../../core/locals";
import { isSite } from "../../core/places";
import type { CommandOfKind, CommandRejection } from "../../core/types/commands";
import {
  CAST_ARMS,
  CAST_PARTS,
  type CastPart,
  type CrewDef,
  type DockDef,
  type DockPostKind,
  RESOLVE_TIERS,
  SITE_LIMITS,
  type SiteCastEntryDef,
  TIE_TIERS,
  WANTS_TIERS,
} from "../../core/types/content";
import { STAGING_LIMITS } from "../../core/types/dockside";
import type { ActorId, CrewDefId, ItemDefId, PortDefId } from "../../core/types/ids";
import type { BattlePlan, Expedition } from "../../core/types/state";
import { shipDeckId } from "../../core/world";
import { planMenu } from "../../view/planMenu";
import { attachDock, detachDock } from "../spatial/dock";
import { syncRampPassability } from "../spatial/geometry";
import { orderWithdrawal } from "./expedition";
import { dispositionOf } from "./morale";
import { squadFor } from "./plans";

type StartPayload = CommandOfKind<"scenarioStartExpedition">["payload"];

const includes = (list: readonly string[], value: unknown): boolean =>
  typeof value === "string" && list.includes(value);

/** Which post kinds each part may stand at (§5.2). */
const POSTS_FOR_PART: Readonly<Record<CastPart, readonly DockPostKind[]>> = {
  target: ["target"],
  guard: ["guard"],
  bystander: ["bystander"],
  ally: ["guard", "bystander"],
};

/** The weapon item each kind of arms is, by the first matching def (by id). */
interface CastWeapons {
  readonly blaster?: ItemDefId;
  readonly baton?: ItemDefId;
}

interface StartPlan {
  readonly siteId: PortDefId;
  readonly site: DockDef;
  readonly cast: readonly SiteCastEntryDef[];
  readonly weapons: CastWeapons;
  readonly plan?: BattlePlan;
  readonly party: readonly ActorId[];
  readonly leaderId: ActorId;
}

const fail = (kind: string, code: CommandRejection["code"], reason: string) =>
  reject(code, `${kind}: ${reason}`);

/** Why a text field is unusable, or undefined. */
function textProblem(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return "must be non-empty text";
  if (value.length > max) return `is longer than ${max} characters`;
  return undefined;
}

/** Why one cast entry is unusable on `site`, or undefined. */
function entryProblem(entry: SiteCastEntryDef, site: DockDef): string | undefined {
  for (const [field, max] of [
    ["name", STAGING_LIMITS.nameChars],
    ["role", STAGING_LIMITS.roleChars],
    ["look", STAGING_LIMITS.lookChars],
  ] as const) {
    const problem = textProblem(entry[field], max);
    if (problem !== undefined) return `${field} ${problem}`;
  }
  for (const [field, list] of [
    ["part", CAST_PARTS],
    ["arms", CAST_ARMS],
    ["resolve", RESOLVE_TIERS],
    ["tie", TIE_TIERS],
    ["wants", WANTS_TIERS],
  ] as const) {
    if (!includes(list, entry[field])) return `${field} must be one of ${list.join(", ")}`;
  }
  const post = site.posts.find((p) => p.key === entry.post);
  if (post === undefined) return `"${site.id}" has no post "${entry.post}"`;
  const allowed = POSTS_FOR_PART[entry.part];
  if (!allowed.includes(post.kind)) {
    return `a ${entry.part} stands at a ${allowed.join(" or ")} post, not "${post.key}" (${post.kind})`;
  }
  return undefined;
}

/** The first weapon item def (by id) of each kind, from content. */
function castWeapons(ctx: ValidateCtx): CastWeapons {
  const defs = Object.values(ctx.content.items)
    .filter((def) => def.weapon !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
  const blaster = defs.find((def) => def.weapon?.kind === "blaster")?.id;
  const baton = defs.find((def) => def.weapon?.kind === "baton")?.id;
  return {
    ...(blaster === undefined ? {} : { blaster }),
    ...(baton === undefined ? {} : { baton }),
  };
}

/** Why `cast` is unusable on `site` with `weapons`, or undefined (§5.2's caps and posts). */
function castProblem(
  cast: readonly SiteCastEntryDef[],
  site: DockDef,
  weapons: CastWeapons,
): { readonly code: CommandRejection["code"]; readonly reason: string } | undefined {
  if (!Array.isArray(cast)) return { code: "invalidPayload", reason: "cast must be a list" };
  const count = (pred: (e: SiteCastEntryDef) => boolean) => cast.filter(pred).length;
  const caps: [number, number, string][] = [
    [cast.length, SITE_LIMITS.people, "people"],
    [count((e) => e.arms !== "none"), SITE_LIMITS.armed, "armed"],
    [count((e) => e.part === "target"), SITE_LIMITS.targets, "targets"],
    [count((e) => e.part === "ally"), SITE_LIMITS.allies, "allies"],
  ];
  for (const [n, max, what] of caps) {
    if (n > max) return { code: "outOfBounds", reason: `${n} ${what} in the cast; at most ${max}` };
  }
  for (const [i, entry] of cast.entries()) {
    const problem = entryProblem(entry, site);
    if (problem !== undefined) return { code: "invalidPayload", reason: `cast ${i}: ${problem}` };
    if (entry.arms === "blaster" && weapons.blaster === undefined) {
      return { code: "preconditionFailed", reason: "no blaster item in content" };
    }
    if (entry.arms === "melee" && weapons.baton === undefined) {
      return { code: "preconditionFailed", reason: "no baton item in content" };
    }
  }
  return undefined;
}

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
function chosenPlan(ctx: ValidateCtx, planId: unknown): BattlePlan | string {
  if (typeof planId !== "string") return "plan must be a menu id";
  const option = planMenu(ctx.state, ctx.content, ctx.config).find((o) => o.id === planId);
  if (option === undefined) return `"${planId}" is not on the plan menu`;
  if (!option.available) return `"${planId}" is not available: ${option.why}`;
  return option.plan;
}

/** Who goes under `plan` (everyone fit without one), leader first, and who leads. */
function partyOf(
  ctx: ValidateCtx,
  plan: BattlePlan | undefined,
): { party: ActorId[]; leaderId: ActorId } {
  const party = squadFor(ctx, plan?.squad ?? "everyone");
  return { party, leaderId: party[0] ?? commandActor(ctx.state) };
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
    const chosen = chosenPlan(ctx, payload.plan);
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

/** A def id for a cast member: `gen.crew.site_<name>`, numbered past any taken. */
function castDefId(ctx: ApplyCtx, name: string): CrewDefId {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "cast";
  const base = `gen.crew.site_${slug}`;
  let id = base;
  for (let n = 2; findCrewDef(ctx.content, ctx.state, id as CrewDefId) !== undefined; n++) {
    id = `${base}_${n}`;
  }
  return id as CrewDefId;
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

/** Spawn one cast member at their post with their weapon in hand. */
function spawnCast(ctx: ApplyCtx, plan: StartPlan, entry: SiteCastEntryDef): ActorId {
  const { state } = ctx;
  const deckId = shipDeckId(state);
  const deck = ctx.content.decks[deckId];
  const post = plan.site.posts.find((p) => p.key === entry.post);
  if (deck === undefined || post === undefined) throw new Error("validated site post vanished");
  const def: CrewDef = {
    id: castDefId(ctx, entry.name),
    name: entry.name,
    roleTags: [],
    skills: { fighting: ctx.config.expedition.castFighting[entry.resolve] },
    traits: [],
    startingInventory: [],
    bio: entry.role,
    // A1: the look stands in until the narrator writes them a voice (A2).
    voice: entry.look,
  };
  state.defs.dynamic.crew[def.id] = def;
  const tile = dockToDeck(berthDock(plan.site, deck), post.tile);
  const id = allocateId(state, "actor");
  const actor = newActor(id, def, { kind: "onDeck", deckId, x: tile.x + 0.5, y: tile.y + 0.5 });
  const disposition = dispositionOf(entry, ctx.config);
  actor.crew = false;
  actor.facing = postFacing(post);
  actor.combatant = {
    side: "them",
    disposition,
    state: "steady",
    resolve: disposition.resolveBase,
    lastDecidedTick: ctx.tick,
  };
  state.actors[id] = actor;
  const weaponId =
    entry.arms === "blaster"
      ? plan.weapons.blaster
      : entry.arms === "melee"
        ? plan.weapons.baton
        : undefined;
  if (weaponId !== undefined) {
    const item = allocateId(state, "item");
    const weapon = findItemDef(ctx.content, state, weaponId);
    if (weapon === undefined) throw new Error("validated weapon def vanished");
    state.items[item] = {
      id: item,
      defId: weapon.id,
      stacking: "unique",
      location: { kind: "carriedBy", actorId: id },
      condition: 1,
    };
    ctx.caches.dirty.inventory = true;
  }
  return id;
}

export const scenarioStartExpedition: CommandHandler<"scenarioStartExpedition", StartPlan> = {
  validate(ctx, command) {
    return validateStart(ctx, command.payload);
  },
  apply(ctx, command, plan) {
    swapToSite(ctx, plan);
    const castIds = plan.cast.map((entry) => spawnCast(ctx, plan, entry));
    const expedition: Expedition = {
      siteId: plan.siteId,
      phase: "mustering",
      party: [...plan.party],
      leaderId: plan.leaderId,
      ...(plan.plan === undefined ? {} : { plan: plan.plan }),
      startedTick: ctx.tick,
      shots: 0,
      causeCommandId: command.id,
    };
    ctx.state.expedition = expedition;
    ctx.emit({
      ...causedBy(command),
      type: "expeditionStarted",
      subjectIds: [...plan.party, ...castIds],
      locationRef: { kind: "port", portId: plan.siteId },
      payload: { siteId: plan.siteId, party: [...plan.party] },
    });
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
    const chosen = chosenPlan(ctx, command.payload.planId);
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
