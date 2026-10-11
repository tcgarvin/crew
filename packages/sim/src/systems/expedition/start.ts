/**
 * Expeditions A1 (call 3) and A2 (calls 12 and 13): starting an expedition at the site alongside,
 * whoever starts it. `scenarioStartExpedition` (`command.ts`) swaps the dock for the site's and then
 * calls `startExpedition`; the expedition system calls `landedForErrand` every tick there is no
 * expedition under way, which starts one itself (no plan, the errand's `jobId`) the first tick the
 * ship is set down at a site for an errand. Both run the same cast checks (`castProblem`: the caps
 * and the posts) on the cast they spawn.
 *
 * `startExpedition` spawns each cast member as an actor (`crew: false`) on a generated
 * `gen.crew.site_*` def at their post, a combatant of side `them` with their disposition and their
 * weapon in hand, and writes `state.expedition`, `mustering`, with the party the plan's squad rule
 * picks (`everyone` without a plan, call 11). With no plan and a `jobId` it queues the arrival card
 * (`queueArrivalCard`, A2 call 4).
 *
 * Owner after the gate: W2 of expeditions A2. Gate stubs: `landedForErrand` starts nothing, and
 * `castFor` is the map's default cast unchanged.
 */
import { configTicks } from "../../core/clock";
import { commandActor } from "../../core/command-actor";
import { newActor } from "../../core/command-handlers";
import { type ApplyCtx, type ValidateCtx, causedBy } from "../../core/commands";
import { findCrewDef, findItemDef } from "../../core/defs";
import { berthDock, dockToDeck } from "../../core/docks";
import { allocateId } from "../../core/ids";
import { postFacing } from "../../core/locals";
import type { Command, CommandRejection } from "../../core/types/commands";
import type { DeepReadonly } from "../../core/types/common";
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
import type { EventDraft } from "../../core/types/events";
import type { ActorId, CrewDefId, ItemDefId, JobId, PortDefId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { BattlePlan, Expedition } from "../../core/types/state";
import type { Job } from "../../core/types/travel";
import { shipDeckId } from "../../core/world";
import { queueArrivalCard } from "./cards";
import { dispositionOf, initialState } from "./morale";
import { type SquadCtx, squadFor } from "./plans";

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
export interface CastWeapons {
  readonly blaster?: ItemDefId;
  readonly baton?: ItemDefId;
}

/** Everything `startExpedition` needs, checked: by the command's validation, or on landing. */
export interface StartPlan {
  readonly siteId: PortDefId;
  readonly site: DockDef;
  readonly cast: readonly SiteCastEntryDef[];
  readonly weapons: CastWeapons;
  readonly plan?: BattlePlan;
  readonly party: readonly ActorId[];
  readonly leaderId: ActorId;
  /** A2 call 12: the errand the expedition is for; only an expedition started on landing has one. */
  readonly jobId?: JobId;
}

/** What started an expedition: the scenario's command (call 3), or the sim on landing (A2 call 12). */
export type StartedBy =
  | { readonly kind: "command"; readonly command: Command }
  | { readonly kind: "landing" };

const SIM_CAUSE: Pick<EventDraft, "causeIds" | "source"> = { causeIds: [], source: "sim" };

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
export function castWeapons(ctx: Pick<ValidateCtx, "content">): CastWeapons {
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
export function castProblem(
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

/** Who goes under `plan` (everyone fit without one), leader first, and who leads. */
export function partyOf(
  ctx: SquadCtx,
  plan: BattlePlan | undefined,
): { party: ActorId[]; leaderId: ActorId } {
  const party = squadFor(ctx, plan?.squad ?? "everyone");
  return { party, leaderId: party[0] ?? commandActor(ctx.state) };
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

/** Spawn one cast member at their post with their weapon in hand. */
function spawnCast(
  ctx: ApplyCtx,
  plan: StartPlan,
  entry: SiteCastEntryDef,
  index: number,
): ActorId {
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
  const every = configTicks(ctx.config, ctx.config.expedition.decideEverySeconds);
  actor.combatant = {
    side: "them",
    disposition,
    state: initialState(disposition.resolveBase, ctx.config.expedition.morale),
    resolve: disposition.resolveBase,
    // Staggered by their place in the cast, as the planner staggers (call 9).
    lastDecidedTick: ctx.tick - (index % Math.max(1, every)),
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

/**
 * Start the expedition at the site alongside (already docked there): the cast spawned at their
 * posts, `state.expedition` written, `expeditionStarted`; and, started on landing for an errand
 * with no plan, the arrival card.
 */
export function startExpedition(ctx: ApplyCtx, plan: StartPlan, by: StartedBy): void {
  const castIds = plan.cast.map((entry, i) => spawnCast(ctx, plan, entry, i));
  const expedition: Expedition = {
    siteId: plan.siteId,
    phase: "mustering",
    party: [...plan.party],
    leaderId: plan.leaderId,
    ...(plan.plan === undefined ? {} : { plan: plan.plan }),
    startedTick: ctx.tick,
    shots: 0,
    ...(by.kind === "command" ? { causeCommandId: by.command.id } : {}),
    ...(plan.jobId === undefined ? {} : { jobId: plan.jobId }),
  };
  ctx.state.expedition = expedition;
  ctx.emit({
    ...(by.kind === "command" ? causedBy(by.command) : SIM_CAUSE),
    type: "expeditionStarted",
    subjectIds: [...plan.party, ...castIds],
    locationRef: { kind: "port", portId: plan.siteId },
    payload: { siteId: plan.siteId, party: [...plan.party] },
  });
  if (plan.plan === undefined && plan.jobId !== undefined) queueArrivalCard(ctx, expedition);
}

/**
 * A2 call 12: the first tick the ship is docked at a site with its site map alongside and an
 * `inTransit` errand naming it whose `outcome` is unset, start the expedition for it (no plan, the
 * cast `castFor` gives). Called at the top of the expedition system's `run` while there is no
 * expedition or the last one is `resolved`. Gate stub: no-op.
 */
export function landedForErrand(_ctx: StepCtx): void {}

/**
 * A2 call 13: the site's cast for an errand: the map's `defaultCast` with the one `target` entry
 * named for the errand's `targetName` (a `fetchItem` leaves the cast as it is). Gate stub: the
 * default cast unchanged.
 */
export function castFor(_job: DeepReadonly<Job>, site: DockDef): readonly SiteCastEntryDef[] {
  return site.defaultCast ?? [];
}
