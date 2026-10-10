/**
 * Expeditions A1 (§8.3, §8.5, plan call 12): battle plans on the sim side: who goes under each
 * squad rule (`squadFor`) and the default pair's plans (`DEFAULT_PLANS`). The menu itself is
 * `view/planMenu.ts` (pure over state and content, so the narrator and the kernel read the same).
 *
 * `squadFor` picks from crew who are `available`, awake, aboard (on the ship's own floor, not the
 * dock), not passengers, not the helm stander and not on gangway watch; captain first (owner
 * ruling 4), then the first officer, then by `fighting` (ties by id). `armedOnly` takes as many as
 * there are weapons in the arms locker's zone, `blastersOnly` as many as blasters, `smallTeam` the
 * captain and the two best at `fighting`.
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import { isOnDock } from "../../core/docks";
import { byId } from "../../core/ids";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ConfigDef, ContentBundle } from "../../core/types/content";
import type { ActorId } from "../../core/types/ids";
import type { ReadonlyWorldState } from "../../core/types/pipeline";
import type { BattlePlan, SquadRule } from "../../core/types/state";
import { shipDeckId } from "../../core/world";
import { gangwayStanderOf, whoHasTheHelm } from "../watch/helm";
import { lockerWeapons } from "./muster";

/** §8.4: the pair the sim offers when no narrator answers: hold versus assault, lethal, armed. */
export const DEFAULT_PLANS: readonly BattlePlan[] = [
  {
    id: "hold-lethal-armed",
    squad: "armedOnly",
    posture: "hold",
    fire: "lethal",
    objective: "takeTarget",
    targetMustLive: false,
    withdrawWhen: "halfDown",
  },
  {
    id: "assault-lethal-armed",
    squad: "armedOnly",
    posture: "assault",
    fire: "lethal",
    objective: "takeTarget",
    targetMustLive: false,
    withdrawWhen: "halfDown",
  },
];

/** What squad selection reads. */
export interface SquadCtx {
  readonly state: ReadonlyWorldState;
  readonly content: ContentBundle;
  readonly config: ConfigDef;
  readonly tick: number;
}

function asleep(actor: DeepReadonly<Actor>): boolean {
  const activity = actor.activity;
  return activity.kind === "personal" && activity.activity === "sleep";
}

/** On the ship's own floor (not the dock, not ashore), a crew member and not a passenger. */
function aboard(ctx: SquadCtx, actor: DeepReadonly<Actor>): boolean {
  if (!actor.crew || actor.passenger === true || actor.availability !== "available") return false;
  const location = actor.location;
  if (location.kind !== "onDeck" || location.deckId !== shipDeckId(ctx.state)) return false;
  return !isOnDock(ctx.content, ctx.state, location);
}

const fightingOf = (actor: DeepReadonly<Actor>): number => actor.skills.fighting ?? 0;

/** Captain first, then the first officer, then by `fighting`, ties by id. */
function rank(a: DeepReadonly<Actor>, b: DeepReadonly<Actor>): number {
  const order = (actor: DeepReadonly<Actor>) =>
    actor.roleTags.includes("captain") ? 0 : actor.roleTags.includes("firstOfficer") ? 1 : 2;
  return order(a) - order(b) || fightingOf(b) - fightingOf(a) || byId(a, b);
}

/** Everyone fit to go, in rank order (call 12). */
export function fitToGo(ctx: SquadCtx): DeepReadonly<Actor>[] {
  const helm = whoHasTheHelm(ctx.state, ctx.content);
  const gangway = gangwayStanderOf(ctx);
  return Object.values(ctx.state.actors)
    .filter((a) => aboard(ctx, a) && !asleep(a) && a.id !== helm && a.id !== gangway)
    .sort(rank);
}

/** Who goes under `squad`, leader first. */
export function squadFor(ctx: SquadCtx, squad: SquadRule): ActorId[] {
  const fit = fitToGo(ctx);
  const weapons = lockerWeapons(ctx.state, ctx.content);
  switch (squad) {
    case "everyone":
      return fit.map((a) => a.id);
    case "armedOnly":
      return fit.slice(0, weapons.length).map((a) => a.id);
    case "blastersOnly":
      return fit.slice(0, weapons.filter((w) => w.kind === "blaster").length).map((a) => a.id);
    case "smallTeam": {
      const [leader, ...rest] = fit;
      if (leader === undefined) return [];
      const best = [...rest].sort((a, b) => fightingOf(b) - fightingOf(a) || byId(a, b));
      return [leader, ...best.slice(0, 2)].map((a) => a.id);
    }
  }
}
