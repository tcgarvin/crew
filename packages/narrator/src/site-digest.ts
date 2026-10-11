/**
 * Expeditions A2 (§10.2): the digest's site lines, as plain lines for `digest.ts`.
 *
 * - "At the site (<name>)" replaces "On the dock" while a site map is alongside: the place, the
 *   errand it is for, where the expedition stands, the party and who leads once the captain has
 *   chosen a plan, each person at the site (who they are, what they carry, where they stand by the
 *   map's posts, their bearing as the crew can see it), and the expedition's two cards. Never a
 *   number: the fight is the sim's, and the narrator writes from what the crew can see.
 * - The job line's errand phrase, and how an errand reads for the person it brought aboard.
 */
import { templateCard } from "@crew/content";
import {
  type BerthedDock,
  type CastPart,
  type CombatantState,
  type ContentBundle,
  type DeepReadonly,
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
  const tile = deckToDock(berth, { x: Math.floor(location.x), y: Math.floor(location.y) });
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

function castLine(berth: BerthedDock, state: State, content: ContentBundle, actor: Actor): string {
  const combatant = actor.combatant;
  const role = roleOf(state, content, actor);
  const part = combatant === undefined ? "" : `, ${PART_WORDS[combatant.disposition.part]}`;
  const bearing = combatant === undefined ? "" : `: ${BEARING[combatant.state]}`;
  return `- ${actor.name}${role === undefined ? "" : ` (${role})`}${part}, ${armsOf(state, content, actor)}, ${standing(berth, state, content, actor)}${bearing}`;
}

/** Where the expedition stands, in words. */
function phaseLine(expedition: DeepReadonly<Expedition>): string {
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
      return `the expedition: it is over; ${expedition.outcome === undefined ? "it ended" : OUTCOME_WORDS[expedition.outcome]}`;
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
 * digit (`withoutDigits` on everything).
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
    lines.push(phaseLine(expedition));
    if (expedition.plan !== undefined && expedition.party.length > 0) {
      lines.push(partyLine(state, content, expedition));
    }
  }
  const people = Object.values(state.actors)
    .filter((a) => a.combatant?.side === "them")
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  lines.push(
    people.length === 0
      ? "people at the site: nobody in sight"
      : "people at the site (what the crew can see of them; how they fight is the sim's):",
  );
  for (const actor of people) lines.push(castLine(berth, state, content, actor));
  if (here) lines.push(...cardLines(state, content, expedition));
  return { heading: `At the site (${berth.dock.name})`, lines: lines.map(withoutDigits) };
}

/** The captive's "Aboard" line: who brought them aboard, from where, bound where. */
export function captiveAboard(content: ContentBundle, job: DeepReadonly<Job>): string | undefined {
  const errand = job.errand;
  if (errand === undefined) return undefined;
  return `taken at ${portName(content, errand.siteId)} on the errand for ${job.issuerPerson.name}, bound for ${portName(content, errand.returnToPortId)}`;
}
