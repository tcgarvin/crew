/**
 * Expeditions A1 (§8.4): the plan menu, the capability list made spatial. Pure over state, content
 * and config, so the narrator (A2) reads the same menu the kernel re-derives to validate a chosen
 * id (`scenarioStartExpedition.plan`, `adoptPlan`).
 *
 * The cross product, pruned: every posture × `lethal`/`stun` × the four squad rules, and
 * `holdFire` only with `bait` and `creep`. A squad rule that picks the same people as one before it
 * (in the order `armedOnly`, `everyone`, `blastersOnly`, `smallTeam`) for the same posture and fire
 * is dropped. Order: the default pair for the expedition's errand (`defaultPairFor`:
 * `hold-lethal-armed`, `assault-lethal-armed`; for a `fetchItem`, `creep-holdFire-armed`,
 * `assault-lethal-armed`), then every other posture's `lethal`/`armedOnly`, then
 * `assault-stun-armed`, then the rest by posture, fire and squad; at most eight are shown. Ids read
 * `<posture>-<fire>-<squad>` with the squad as `all`/`armed`/`blasters`/`small`.
 *
 * `available` and `why` come from the roster (`fitToGo`: fit, awake, aboard, not the helm or the
 * gangway), the arms locker, the site's posts (`flank` needs a `flank` post and four in the
 * squad; `bait` two) and the phase (after contact `creep` and `bait` are out). Every plan's
 * objective is `takeItem` for a live expedition's `fetchItem` errand, else `takeTarget` on a site
 * with a target post, else `breakThem`; it withdraws at `halfDown`. The errand is the live
 * expedition's (`Expedition.jobId`); with none (a scenario start, or once it has resolved) the menu
 * is the errand-free one, so a new start never validates against the last errand's.
 *
 * The site is `siteId` when given (the start command validates its plan before the site is
 * alongside), else the expedition's, else the site alongside.
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import { dockAlongside, dockForPort } from "../core/docks";
import type { ConfigDef, ContentBundle, DockDef } from "../core/types/content";
import type { PortDefId } from "../core/types/ids";
import type { ReadonlyWorldState } from "../core/types/pipeline";
import {
  type BattlePlan,
  type FireRule,
  type Objective,
  POSTURES,
  type Posture,
  type SquadRule,
} from "../core/types/state";
import type { ErrandKind } from "../core/types/travel";
import type { PlanOption } from "../core/types/view";
import { lockerWeapons } from "../systems/expedition/muster";
import { defaultPairFor, squadFor } from "../systems/expedition/plans";

/** At most this many options are shown (§8.4). */
export const PLAN_MENU_SIZE = 8;

const SQUAD_WORDS: Readonly<Record<SquadRule, string>> = {
  armedOnly: "armed",
  everyone: "all",
  blastersOnly: "blasters",
  smallTeam: "small",
};
const SQUAD_ORDER: readonly SquadRule[] = ["armedOnly", "everyone", "blastersOnly", "smallTeam"];

const firesFor = (posture: Posture): readonly FireRule[] =>
  posture === "bait" || posture === "creep" ? ["lethal", "stun", "holdFire"] : ["lethal", "stun"];

const planId = (posture: Posture, fire: FireRule, squad: SquadRule): string =>
  `${posture}-${fire}-${SQUAD_WORDS[squad]}`;

const POSTURE_WORDS: Readonly<Record<Posture, string>> = {
  assault: "go in and take them",
  hold: "hold the ramp from cover",
  flank: "split, and go round by the flank",
  bait: "the leader walks in talking while the rest hold",
  creep: "keep out of sight and take them quietly",
};

const FIRE_WORDS: Readonly<Record<FireRule, string>> = {
  lethal: "",
  stun: ", stun only",
  holdFire: ", nobody fires first",
};

function siteDock(
  state: ReadonlyWorldState,
  content: ContentBundle,
  siteId: PortDefId | undefined,
): DockDef | undefined {
  const id = siteId ?? state.expedition?.siteId;
  if (id !== undefined) return dockForPort(content, id);
  const alongside = dockAlongside(content, state)?.dock;
  return alongside?.kind === "site" ? alongside : undefined;
}

/** Why `plan` cannot be chosen now, or undefined if it can. */
function unavailable(
  plan: BattlePlan,
  squadSize: number,
  site: DockDef | undefined,
  contact: boolean,
  weapons: { readonly all: number; readonly blasters: number },
): string | undefined {
  if (plan.squad === "armedOnly" && weapons.all === 0) return "the arms locker is empty";
  if (plan.squad === "blastersOnly" && weapons.blasters === 0) return "no blasters in the locker";
  if (squadSize === 0) return "nobody is fit to go";
  if (plan.posture === "flank") {
    if (site !== undefined && !site.posts.some((p) => p.kind === "flank")) {
      return "flank needs a way round, and this site has none";
    }
    if (squadSize < 4) return `flank needs four fit people: only ${squadSize} would go`;
  }
  if (plan.posture === "bait") {
    if (contact) return "bait: they have already seen you";
    if (squadSize < 2) return "bait needs two fit people";
  }
  if (plan.posture === "creep" && contact) return "creep: they have already seen you";
  return undefined;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * The live expedition's errand kind (`Expedition.jobId`), or undefined with no live expedition or
 * one without an errand (a scenario start). Throws for a `jobId` that names no errand on record, as
 * the arrival card does.
 */
function menuErrandKind(state: ReadonlyWorldState): ErrandKind | undefined {
  const expedition = state.expedition;
  if (expedition === undefined || expedition.phase === "resolved") return undefined;
  const jobId = expedition.jobId;
  if (jobId === undefined) return undefined;
  const errand = state.jobs[jobId]?.errand;
  if (errand === undefined) {
    throw new Error(`planMenu: the expedition's job "${jobId}" is not an errand on record`);
  }
  return errand.kind;
}

function objectiveFor(kind: ErrandKind | undefined, site: DockDef | undefined): Objective {
  if (kind === "fetchItem") return "takeItem";
  return site?.posts.some((p) => p.kind === "target") === false ? "breakThem" : "takeTarget";
}

/** Display order: the default pair, the other postures' lethal-armed, assault-stun, the rest. */
function rank(plan: BattlePlan, pair: readonly BattlePlan[]): number {
  const defaults = pair.findIndex((d) => d.id === plan.id);
  if (defaults >= 0) return defaults;
  if (plan.fire === "lethal" && plan.squad === "armedOnly")
    return 10 + POSTURES.indexOf(plan.posture);
  if (plan.id === "assault-stun-armed") return 20;
  return 100;
}

export function planMenu(
  state: ReadonlyWorldState,
  content: ContentBundle,
  config: ConfigDef,
  siteId?: PortDefId,
): PlanOption[] {
  const site = siteDock(state, content, siteId);
  const ctx = { state, content, config, tick: state.tick };
  const squads = new Map(SQUAD_ORDER.map((squad) => [squad, squadFor(ctx, squad)] as const));
  const locker = lockerWeapons(state, content);
  const weapons = {
    all: locker.length,
    blasters: locker.filter((w) => w.kind === "blaster").length,
  };
  const phase = state.expedition?.phase;
  const contact = phase === "fight" || phase === "resolved";
  const kind = menuErrandKind(state);
  const objective = objectiveFor(kind, site);
  const pair = defaultPairFor(kind);
  const options: PlanOption[] = [];
  for (const posture of POSTURES) {
    for (const fire of firesFor(posture)) {
      const kept: (readonly string[])[] = [];
      for (const squad of SQUAD_ORDER) {
        const people = squads.get(squad) ?? [];
        if (kept.some((ids) => sameIds(ids, people))) continue;
        kept.push(people);
        const plan: BattlePlan = {
          id: planId(posture, fire, squad),
          squad,
          posture,
          fire,
          objective,
          targetMustLive: false,
          withdrawWhen: "halfDown",
        };
        const why = unavailable(plan, people.length, site, contact, weapons);
        options.push({
          id: plan.id,
          plan,
          available: why === undefined,
          why: why ?? `${POSTURE_WORDS[posture]}${FIRE_WORDS[fire]} (${people.length} go)`,
        });
      }
    }
  }
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => rank(a.option.plan, pair) - rank(b.option.plan, pair) || a.index - b.index)
    .slice(0, PLAN_MENU_SIZE)
    .map((o) => o.option);
}
