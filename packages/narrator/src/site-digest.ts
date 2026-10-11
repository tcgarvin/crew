/**
 * Expeditions A2 (§10.2): the digest's site lines, as plain lines for `digest.ts`.
 *
 * - "At the site (<name>)" replaces "On the dock" while a site map is alongside: the place, the
 *   errand it is for, where the expedition stands, the party and who leads once the captain has
 *   chosen a plan, each person at the site (who they are, what they carry, where they stand by the
 *   map's posts, their bearing as the crew can see it), and the expedition's two cards. Never a
 *   number: the fight is the sim's, and the narrator writes from what the crew can see. An item
 *   errand's thing is placed too. D105: a side the narrator marked unseen never shows before the
 *   captain chooses; then a line says what came of it, with the roll's odds (§unseen-odds), and
 *   once it is over the expedition line says whether the site saw the party come.
 * - The job line's errand phrase, and how an errand reads for the person it brought aboard.
 */
import { templateCard } from "@crew/content";
import {
  type BerthedDock,
  type CastPart,
  type CombatantState,
  type ContentBundle,
  type DeepReadonly,
  type ErrandKind,
  type ErrandOutcome,
  type ErrandWants,
  type ExpeditionOutcome,
  type ItemDefId,
  type Job,
  type JobErrand,
  deckToDock,
  isOnDock,
  siteOf,
} from "@crew/sim";
import type { DockLines } from "./dockside-digest";
import { type State, itemName, placePhrase, portName } from "./lookups";

type Actor = State["actors"][keyof State["actors"]];
type Expedition = NonNullable<State["expedition"]>;

/** Plan call 4: the arrival card's prompt key (`systems/expedition/cards.ts`). */
export const EXPEDITION_ARRIVAL_KEY = "expedition.arrival";
/** Plan call 15: the turn card's prompt key (`systems/expedition/cards.ts`). */
export const EXPEDITION_TURN_KEY = "expedition.turn";

/** §8.2: a combatant's bearing as the crew can see it, a word for each state. */
const BEARING: Readonly<Record<CombatantState, string>> = {
  steady: "steady",
  wavering: "wavering",
  breaking: "breaking",
  fled: "fled",
  surrendered: "has given up",
  down: "down",
  dead: "dead",
};

/** §5.2: what someone at the site is to the errand. */
const PART_WORDS: Readonly<Record<CastPart, string>> = {
  target: "the one the errand is after",
  guard: "one of theirs",
  bystander: "a bystander",
  ally: "on the crew's side",
};

const WANTS_WORDS: Readonly<Record<ErrandWants, string>> = {
  alive: "alive",
  either: "alive or dead",
  dead: "dead",
};

const ERRAND_OUTCOME_WORDS: Readonly<Record<ErrandOutcome, string>> = {
  broughtAlive: "taken alive",
  broughtDead: "brought back dead",
  broughtItem: "got what it went for",
  failed: "failed",
};

const OUTCOME_WORDS: Readonly<Record<ExpeditionOutcome, string>> = {
  targetTaken: "the target was taken",
  targetFled: "the target got away",
  partyWithdrew: "the party pulled back to the ship",
  partyRouted: "the party was routed",
  timedOut: "it came to nothing",
};

const NUMBER_WORDS = [
  "none",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
] as const;

/**
 * "hold the ramp from cover (3 go)" → "hold the ramp from cover (three go)": the plan menu's `why`
 * counts heads, and this section never shows a digit.
 */
export function withoutDigits(text: string): string {
  return text.replace(/\d+/g, (digits) => NUMBER_WORDS[Number(digits)] ?? "many");
}

/** "bring back Corran Vale from The Boathouse, alive" / "fetch the strongbox papers from ...". */
export function errandWhat(content: ContentBundle, errand: DeepReadonly<JobErrand>): string {
  const site = portName(content, errand.siteId);
  if (errand.kind === "fetchItem") {
    const item =
      errand.itemDefId === undefined
        ? ""
        : ` (${itemName(content, errand.itemDefId as ItemDefId)})`;
    return `fetch ${errand.targetName}${item} from ${site}`;
  }
  return `bring back ${errand.targetName} from ${site}, ${WANTS_WORDS[errand.wants]}`;
}

/** The errand as the job line says it, with how it came out once it has. */
export function errandJobPhrase(content: ContentBundle, errand: DeepReadonly<JobErrand>): string {
  const outcome = errand.outcome === undefined ? "" : `; ${ERRAND_OUTCOME_WORDS[errand.outcome]}`;
  return `errand: ${errandWhat(content, errand)}, home to ${portName(content, errand.returnToPortId)}${outcome}`;
}

/** What `actor` carries that is a weapon, in words. */
function armsOf(state: State, content: ContentBundle, actor: Actor): string {
  const weapons = Object.values(state.items)
    .filter((item) => item.location.kind === "carriedBy" && item.location.actorId === actor.id)
    .map((item) => content.items[item.defId]?.weapon?.kind)
    .filter((kind) => kind !== undefined);
  if (weapons.includes("blaster")) return "with a blaster";
  if (weapons.length > 0) return "with a club";
  return "unarmed";
}

/** Where someone stands on the site: at or near the map's nearest post, or off the ground. */
function standing(berth: BerthedDock, state: State, content: ContentBundle, actor: Actor): string {
  const location = actor.location;
  if (location.kind !== "onDeck") return location.kind === "carriedBy" ? "being carried" : "gone";
  if (!isOnDock(content, state, location))
    return `aboard the ship${placePhrase(content, state, location)}`;
  return postPhrase(berth, location);
}

/** A spot on the site floor by the map's nearest post: "at the weigh-house scale", "near ...". */
function postPhrase(berth: BerthedDock, at: { readonly x: number; readonly y: number }): string {
  const tile = deckToDock(berth, { x: Math.floor(at.x), y: Math.floor(at.y) });
  const gap = (p: { readonly tile: { readonly x: number; readonly y: number } }) =>
    Math.max(Math.abs(p.tile.x - tile.x), Math.abs(p.tile.y - tile.y));
  const nearest = [...berth.dock.posts].sort((a, b) => gap(a) - gap(b))[0];
  if (nearest === undefined) return "on the ground";
  // A post's name is a place ("the weigh-house scale") or already a spot ("behind the bale row").
  const spot = PLACE_PREPOSITION.test(nearest.name);
  if (gap(nearest) <= 1) return spot ? nearest.name : `at ${nearest.name}`;
  return spot ? `near the spot ${nearest.name}` : `near ${nearest.name}`;
}

/** A post name that starts with where, not what. */
const PLACE_PREPOSITION = /^(at|by|behind|inside|outside|in|on|under|beside|near|past|beyond)\b/i;

/** Who someone at the site is: the role their cast entry gave them. */
function roleOf(state: State, content: ContentBundle, actor: Actor): string | undefined {
  return (content.crew[actor.defId] ?? state.defs.dynamic.crew[actor.defId])?.bio;
}

/**
 * An item errand is after a thing, not the site's own target (`castFor` leaves the cast as it is),
 * so the target reads as who they are to the place.
 */
const ITEM_TARGET_WORDS = "the one at the heart of it here (the errand is after a thing, not them)";

function castLine(
  berth: BerthedDock,
  state: State,
  content: ContentBundle,
  actor: Actor,
  kind: ErrandKind | undefined,
): string {
  const combatant = actor.combatant;
  const role = roleOf(state, content, actor);
  const partOf = (part: CastPart) =>
    part === "target" && kind === "fetchItem" ? ITEM_TARGET_WORDS : PART_WORDS[part];
  const part = combatant === undefined ? "" : `, ${partOf(combatant.disposition.part)}`;
  const bearing = combatant === undefined ? "" : `: ${BEARING[combatant.state]}`;
  return `- ${actor.name}${role === undefined ? "" : ` (${role})`}${part}, ${armsOf(state, content, actor)}, ${standing(berth, state, content, actor)}${bearing}`;
}

/**
 * D105: how the site noticed the party, once it is over: "nobody saw them come or go" when
 * the marked way in was taken and no fight started, "they were waiting for the party" when the
 * other side was. Never before: the mark is the narrator's own, and until it is over the fight is
 * the sim's to tell.
 */
function noticeWords(expedition: DeepReadonly<Expedition>): string {
  if (expedition.notice === "seen") return "; they were waiting for the party";
  if (expedition.notice === "unseen" && expedition.fightStartedTick === undefined) {
    return "; nobody saw them come or go";
  }
  return "";
}

/**
 * §unseen-odds: once the captain chose, what came of the way in unseen the narrator named: the roll
 * on the marked side ("(70%): it worked") or the other side taken; nothing before the choice or
 * with no mark (§unseen-lever).
 */
function unseenLine(expedition: DeepReadonly<Expedition>): string | undefined {
  const roll = expedition.unseenRoll;
  if (roll !== undefined) {
    return roll.worked
      ? `the way in unseen you named (${roll.odds}%): the captain took it and it worked; the people here did not see the party come`
      : `the way in unseen you named (${roll.odds}%): the captain took it and it failed; they were waiting for the party`;
  }
  const marked = expedition.unseenPlanId;
  // A marked side taken with no roll is a mark saved before odds: D105 said nothing until the end.
  if (marked === undefined || expedition.plan === undefined || expedition.plan.id === marked) {
    return undefined;
  }
  return "the way in unseen you named: the captain took the other side; they were waiting for the party";
}

/** How it ended; for an item errand, taking the site is taking the thing, not the site's target. */
function outcomeWords(expedition: DeepReadonly<Expedition>, kind: ErrandKind | undefined): string {
  if (expedition.outcome === undefined) return "it ended";
  if (expedition.outcome === "targetTaken" && kind === "fetchItem") {
    return "the party took what it went for";
  }
  return OUTCOME_WORDS[expedition.outcome];
}

/** Where the expedition stands, in words. */
function phaseLine(expedition: DeepReadonly<Expedition>, kind: ErrandKind | undefined): string {
  if (expedition.plan === undefined && expedition.phase !== "resolved") {
    return "the expedition: nobody has gone out yet; the crew wait on the captain's plan";
  }
  switch (expedition.phase) {
    case "mustering":
      return "the expedition: the party is arming at the arms locker";
    case "walkingOut":
      return "the expedition: the party is going down the ramp";
    case "approach":
      return "the expedition: the party is out on the ground, not yet in a fight";
    case "fight":
      return "the expedition: the fight is on";
    case "resolved":
      return `the expedition: it is over; ${outcomeWords(expedition, kind)}${noticeWords(expedition)}`;
  }
}

function partyLine(state: State, content: ContentBundle, expedition: DeepReadonly<Expedition>) {
  const members = expedition.party.map((id) => {
    const actor = state.actors[id];
    if (actor === undefined) return "someone no longer aboard";
    const leads = id === expedition.leaderId ? "leads, " : "";
    const bearing = actor.combatant === undefined ? "" : `, ${BEARING[actor.combatant.state]}`;
    return `${actor.name} (${leads}${armsOf(state, content, actor)}${bearing})`;
  });
  return `the party: ${members.join(", ")}`;
}

/**
 * An item errand's thing while the expedition is on: who of those at the site carries it, else
 * where it lies on the site floor by the nearest post, else "not in sight".
 */
function soughtLine(
  berth: BerthedDock,
  state: State,
  content: ContentBundle,
  errand: DeepReadonly<JobErrand>,
): string | undefined {
  if (errand.kind !== "fetchItem" || errand.itemDefId === undefined) return undefined;
  const items = Object.values(state.items).filter((item) => item.defId === errand.itemDefId);
  for (const item of items) {
    const at = item.location;
    if (at.kind !== "carriedBy") continue;
    const holder = state.actors[at.actorId];
    if (holder?.combatant !== undefined) return `${errand.targetName}: carried by ${holder.name}`;
  }
  for (const item of items) {
    const at = item.location;
    if (at.kind === "onDeck" && isOnDock(content, state, at)) {
      return `${errand.targetName}: lying ${postPhrase(berth, at)}`;
    }
  }
  return `${errand.targetName}: not in sight`;
}

/** A string param of a decision's prompt, or undefined. */
function promptParam(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The expedition's arrival and turn cards: their two sides while up, the choice once made. */
function cardLines(state: State, content: ContentBundle, expedition: DeepReadonly<Expedition>) {
  const lines: string[] = [];
  const arrival = expedition.cards?.arrival;
  const arrivalCard = arrival === undefined ? undefined : state.decisions.records[arrival];
  if (arrivalCard !== undefined) {
    const card = templateCard(arrivalCard, content);
    const params = arrivalCard.prompt.params as Readonly<Record<string, unknown>>;
    const why = (side: "left" | "right", fallback: string | undefined) =>
      promptParam(params, `${side}Why`) ?? fallback ?? "";
    if (arrivalCard.status === "pending") {
      lines.push(
        `the arrival card (two plans, waiting on the captain): left "${card.leftLabel}": ${why("left", card.leftAftermath)}; right "${card.rightLabel}": ${why("right", card.rightAftermath)}`,
      );
    } else if (arrivalCard.chosen !== undefined) {
      const label = arrivalCard.chosen === "left" ? card.leftLabel : card.rightLabel;
      lines.push(`the captain's plan, from the arrival card: "${label}"`);
    }
  }
  const turn = expedition.cards?.turn;
  const turnCard = turn === undefined ? undefined : state.decisions.records[turn];
  if (turnCard !== undefined) {
    const card = templateCard(turnCard, content);
    if (turnCard.status === "pending") {
      lines.push(
        `the turn card (waiting on the captain): "${card.leftLabel}" or "${card.rightLabel}"`,
      );
    } else if (turnCard.chosen !== undefined) {
      const label = turnCard.chosen === "left" ? card.leftLabel : card.rightLabel;
      lines.push(`at the turn the captain chose "${label}"`);
    }
  }
  return lines;
}

/**
 * "At the site (<name>)" while a site map is alongside; undefined otherwise. Its lines carry no
 * digit (`withoutDigits` on everything) but the narrator's own odds on the way in unseen.
 */
export function atSiteLines(state: State, content: ContentBundle): DockLines | undefined {
  const berth = siteOf(content, state);
  if (berth === undefined) return undefined;
  const lines = [`the place: ${berth.dock.ambience}`];
  const expedition = state.expedition;
  const here = expedition !== undefined && expedition.siteId === berth.dock.portId;
  const job = here && expedition.jobId !== undefined ? state.jobs[expedition.jobId] : undefined;
  if (job?.errand !== undefined) {
    lines.push(
      `the errand: ${errandWhat(content, job.errand)}, for ${job.issuerPerson.name}, home to ${portName(content, job.fromPortId)}`,
    );
  }
  if (!here) {
    lines.push("the expedition: nobody has gone out");
  } else {
    lines.push(phaseLine(expedition, job?.errand?.kind));
    if (expedition.plan !== undefined && expedition.party.length > 0) {
      lines.push(partyLine(state, content, expedition));
    }
    const sought =
      job?.errand === undefined || expedition.phase === "resolved"
        ? undefined
        : soughtLine(berth, state, content, job.errand);
    if (sought !== undefined) lines.push(`what the errand is after: ${sought}`);
  }
  const people = Object.values(state.actors)
    .filter((a) => a.combatant?.side === "them")
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  lines.push(
    people.length === 0
      ? "people at the site: nobody in sight"
      : "people at the site (what the crew can see of them; how they fight is the sim's):",
  );
  const kind = job?.errand?.kind;
  for (const actor of people) lines.push(castLine(berth, state, content, actor, kind));
  if (here) lines.push(...cardLines(state, content, expedition));
  // §unseen-odds: the one number here is the narrator's own chance, said back to it.
  const roll = here ? unseenLine(expedition) : undefined;
  return {
    heading: `At the site (${berth.dock.name})`,
    lines: [...lines.map(withoutDigits), ...(roll === undefined ? [] : [roll])],
  };
}

/** The captive's "Aboard" line: who brought them aboard, from where, bound where. */
export function captiveAboard(content: ContentBundle, job: DeepReadonly<Job>): string | undefined {
  const errand = job.errand;
  if (errand === undefined) return undefined;
  return `taken at ${portName(content, errand.siteId)} on the errand for ${job.issuerPerson.name}, bound for ${portName(content, errand.returnToPortId)}`;
}
