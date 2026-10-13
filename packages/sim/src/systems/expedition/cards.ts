/**
 * Expeditions A2 (plan calls 4 and 15): the expedition's two policy cards, queued through
 * `queuePolicyDecision` (prompt keys `expedition.arrival` and `expedition.turn`) with no `jobId` on
 * the record, so each gets its `policyDecision` hook and the world halts on it (the fight with it)
 * until it is answered; the job is named in `prompt.params`. Each is queued at most once an
 * expedition, and only for one that started itself for an errand (`Expedition.jobId`), and is
 * recorded in `Expedition.cards`.
 *
 * - The arrival card, from `startExpedition` when the expedition started itself on landing with no
 *   plan: two plans from the menu (the errand kind's default pair, `defaultPairFor`, when both are
 *   available: `hold-lethal-armed` and `assault-lethal-armed`, or for a `fetchItem`
 *   `creep-holdFire-armed` and `assault-lethal-armed`; else the first two available, else no card),
 *   brought by the first officer (`firstOfficerOf`), each side an `adoptPlan`. Prompt params:
 *   `jobId`, `kind` (the errand's), `site`, `target`, `speaker`, `leftPlan`, `rightPlan`,
 *   `leftLabel`, `rightLabel`, `leftWhy`, `rightWhy`; each side's label ref carries its own label
 *   and its aftermath ref its own why (the templates read the ref, not the prompt). For an item
 *   they say "it" ("Go in and take it", "We slip in, take it and get out."). No numbers in any of
 *   them. While it is pending the narrator may mark one side the way in unseen
 *   (`markUnseen`, D105).
 * - The turn card, once a fight and only in the fight: the tick of the first fighter of either
 *   side to break or give up, or the first party member down or dead (`Fight.turns`), while
 *   neither the objective nor a withdrawal has come and the fight does not end that tick. Brought
 *   by the first officer if in the party and on their feet, else whoever leads now (never the one
 *   it is about); "Press on" (nothing) or "Pull back to the ship" (`withdrawParty`). Prompt params:
 *   `jobId`, `site`, `actorId`, `name`, `side`, `how` (`breaking`, `down` or `dead`), `speaker`.
 *
 * Owner after the gate: W2 of expeditions A2.
 */
import { commandActor, firstOfficerOf } from "../../core/command-actor";
import type { ApplyCtx } from "../../core/commands";
import { queuePolicyDecision } from "../../core/decisions";
import { dockForPort } from "../../core/docks";
import type { DecisionOption } from "../../core/types/decisions";
import type { ActorId } from "../../core/types/ids";
import type { ReadonlyWorldState } from "../../core/types/pipeline";
import type { Expedition, FireRule, Posture, SquadRule } from "../../core/types/state";
import type { ErrandKind, JobErrand } from "../../core/types/travel";
import type { PlanOption } from "../../core/types/view";
import { planMenu } from "../../view/planMenu";
import type { Fight } from "./combat";
import { upright } from "./morale";
import { defaultPairFor, leaderNow } from "./plans";

/** Call 4: the arrival card's prompt key (its templates are `@crew/content`'s). */
export const ARRIVAL_PROMPT_KEY = "expedition.arrival";
/** Call 15: the turn card's prompt key. */
export const TURN_PROMPT_KEY = "expedition.turn";

/**
 * A side's label: what the posture does (a person is "them", an item "it"), then the fire rule and
 * squad when not the usual.
 */
const PERSON_POSTURE_LABELS: Readonly<Record<Posture, string>> = {
  assault: "Go in and take them",
  hold: "Hold the ramp from cover",
  flank: "Go round by the flank",
  bait: "Walk in talking",
  creep: "Creep in quietly",
};
const POSTURE_LABELS: Readonly<Record<ErrandKind, Readonly<Record<Posture, string>>>> = {
  fetchPerson: PERSON_POSTURE_LABELS,
  fetchItem: { ...PERSON_POSTURE_LABELS, assault: "Go in and take it" },
};
const FIRE_LABELS: Readonly<Record<FireRule, string>> = {
  lethal: "",
  stun: ", to stun",
  holdFire: ", holding fire",
};
const SQUAD_LABELS: Readonly<Record<SquadRule, string>> = {
  armedOnly: "",
  everyone: ", all hands",
  blastersOnly: ", blasters only",
  smallTeam: ", a small team",
};

/** A side's aftermath: what happens next, plainly (§aftermath-caption), naming a person. */
const PERSON_POSTURE_WHYS: Readonly<Record<Posture, (target: string) => string>> = {
  assault: (target) => `We go in hard and bring ${target} out.`,
  hold: () => "We make them come to us.",
  flank: () => "Some of us keep them busy while the rest go round.",
  bait: () => "The leader walks in talking while the rest hold back and cover.",
  creep: () => "We keep low and quiet and take them before they know.",
};
/** An item is "it", and the quiet way in takes it and is gone. */
const POSTURE_WHYS: Readonly<
  Record<ErrandKind, Readonly<Record<Posture, (target: string) => string>>>
> = {
  fetchPerson: PERSON_POSTURE_WHYS,
  fetchItem: {
    ...PERSON_POSTURE_WHYS,
    assault: () => "We go in hard and bring it out.",
    creep: () => "We slip in, take it and get out.",
  },
};
const FIRE_WHYS: Readonly<Record<FireRule, string>> = {
  lethal: "",
  stun: " Stun only.",
  holdFire: " Nobody fires first.",
};
const SQUAD_WHYS: Readonly<Record<SquadRule, string>> = {
  armedOnly: "",
  everyone: " Everyone goes.",
  blastersOnly: " Only the blasters go.",
  smallTeam: " A small team goes.",
};

function sideLabel(option: PlanOption, kind: ErrandKind): string {
  const { posture, fire, squad } = option.plan;
  return `${POSTURE_LABELS[kind][posture]}${FIRE_LABELS[fire]}${SQUAD_LABELS[squad]}`;
}

/** A side's why; a site that gives holding away (`holdWhy`) says so on its hold side. */
function sideWhy(option: PlanOption, errand: ArrivalErrand, holdWhy: string | undefined): string {
  const { posture, fire, squad } = option.plan;
  const what =
    posture === "hold" && holdWhy !== undefined
      ? holdWhy
      : POSTURE_WHYS[errand.kind][posture](errand.targetName);
  return `${what}${FIRE_WHYS[fire]}${SQUAD_WHYS[squad]}`;
}

/** What of the errand the arrival card's wording reads. */
type ArrivalErrand = Readonly<Pick<JobErrand, "kind" | "targetName">>;

/**
 * The arrival card's two plans: the errand kind's default pair (`defaultPairFor`) if both are
 * available, else the first two.
 */
export function arrivalPair(
  menu: readonly PlanOption[],
  kind: ErrandKind,
): readonly [PlanOption, PlanOption] | undefined {
  const available = menu.filter((o) => o.available);
  const [left, right] = defaultPairFor(kind).map((d) => available.find((o) => o.id === d.id));
  if (left !== undefined && right !== undefined) return [left, right];
  const [first, second] = available;
  return first === undefined || second === undefined ? undefined : [first, second];
}

/** One side of the arrival card: adopt `option`, its label and why on its own refs. */
function arrivalSide(
  which: "left" | "right",
  option: PlanOption,
  errand: ArrivalErrand,
  holdWhy: string | undefined,
): DecisionOption {
  return {
    label: {
      key: `${ARRIVAL_PROMPT_KEY}.${which}`,
      params: { [`${which}Label`]: sideLabel(option, errand.kind) },
    },
    commands: [{ kind: "adoptPlan", payload: { planId: option.id } }],
    aftermath: {
      key: `${ARRIVAL_PROMPT_KEY}.${which}.aftermath`,
      params: { [`${which}Why`]: sideWhy(option, errand, holdWhy) },
    },
  };
}

/**
 * Call 4: queue the arrival card for an expedition that started itself on landing (no plan, its
 * errand's `jobId`), once; no card when the menu has no two plans available.
 */
export function queueArrivalCard(ctx: ApplyCtx, expedition: Expedition): void {
  if (expedition.cards?.arrival !== undefined || expedition.plan !== undefined) return;
  const jobId = expedition.jobId;
  const errand = jobId === undefined ? undefined : ctx.state.jobs[jobId]?.errand;
  if (jobId === undefined || errand === undefined) {
    throw new Error(`queueArrivalCard: the expedition at ${expedition.siteId} has no errand`);
  }
  const menu = planMenu(ctx.state, ctx.content, ctx.config, expedition.siteId);
  const pair = arrivalPair(menu, errand.kind);
  if (pair === undefined) return;
  const [left, right] = pair;
  const speaker = arrivalSpeaker(ctx.state);
  const target = errand.targetName;
  const holdWhy = dockForPort(ctx.content, expedition.siteId)?.holdWhy;
  const decisionId = queuePolicyDecision(ctx, {
    perspectiveActorId: commandActor(ctx.state),
    prompt: {
      key: ARRIVAL_PROMPT_KEY,
      params: {
        jobId,
        kind: errand.kind,
        site: expedition.siteId,
        target,
        ...(speaker === undefined ? {} : { speaker }),
        leftPlan: left.id,
        rightPlan: right.id,
        leftLabel: sideLabel(left, errand.kind),
        rightLabel: sideLabel(right, errand.kind),
        leftWhy: sideWhy(left, errand, holdWhy),
        rightWhy: sideWhy(right, errand, holdWhy),
      },
    },
    left: arrivalSide("left", left, errand, holdWhy),
    right: arrivalSide("right", right, errand, holdWhy),
  });
  expedition.cards = { ...expedition.cards, arrival: decisionId };
}

/**
 * Who brings the arrival card: the first officer, unless they are the one in command (D8), since
 * the captain never speaks a card (§captain-never-speaks); then nobody is named.
 */
function arrivalSpeaker(state: ReadonlyWorldState): string | undefined {
  const firstOfficer = firstOfficerOf(state);
  return firstOfficer === undefined || firstOfficer.id === commandActor(state)
    ? undefined
    : firstOfficer.name;
}

/**
 * Who brings the turn card: the first officer if they can stand, in the party or calling it from
 * the ramp head; else the first of the party in rank order (§who-goes) who is on their feet; never
 * the one in command (§captain-never-speaks) nor the one the card is about (then nobody is named).
 */
function turnSpeaker(
  state: ReadonlyWorldState,
  expedition: Expedition,
  about: ActorId,
): string | undefined {
  const command = commandActor(state);
  const firstOfficer = firstOfficerOf(state);
  if (firstOfficer !== undefined && firstOfficer.id !== command && firstOfficer.id !== about) {
    return firstOfficer.name;
  }
  const speaker = expedition.party
    .map((id) => state.actors[id])
    .find((a) => {
      if (a === undefined || a.id === command || a.id === about) return false;
      return a.combatant !== undefined && upright(a.combatant);
    });
  return speaker?.name;
}

/**
 * Call 15: queue the turn card when the fight first turns, once. Called after the tick's checks
 * (contact, withdrawal, the objective) when the expedition does not resolve that tick, so the card
 * never asks about a fight that is over or a party already pulling back.
 */
export function queueTurnCard(fight: Fight): void {
  const { ctx, expedition } = fight;
  if (expedition.jobId === undefined || expedition.cards?.turn !== undefined) return;
  if (expedition.phase !== "fight") return;
  if (expedition.objectiveTick !== undefined || expedition.withdrawTick !== undefined) return;
  // Only our own setbacks ask the captain anything: one of theirs breaking is the fight going our
  // way, and the ticker tells it.
  const turn = fight.turns.find((t) => t.side === "us");
  if (turn === undefined) return;
  const speaker = turnSpeaker(ctx.state, expedition, turn.actorId);
  const decisionId = queuePolicyDecision(ctx, {
    perspectiveActorId: commandActor(ctx.state),
    prompt: {
      key: TURN_PROMPT_KEY,
      params: {
        jobId: expedition.jobId,
        site: expedition.siteId,
        actorId: turn.actorId,
        name: turn.name,
        side: turn.side,
        how: turn.how,
        ...(speaker === undefined ? {} : { speaker }),
      },
    },
    left: {
      label: { key: `${TURN_PROMPT_KEY}.press`, params: {} },
      commands: [],
      aftermath: { key: `${TURN_PROMPT_KEY}.press.aftermath`, params: {} },
    },
    right: {
      label: { key: `${TURN_PROMPT_KEY}.withdraw`, params: {} },
      commands: [{ kind: "withdrawParty", payload: {} }],
      aftermath: { key: `${TURN_PROMPT_KEY}.withdraw.aftermath`, params: {} },
    },
  });
  expedition.cards = { ...expedition.cards, turn: decisionId };
}
