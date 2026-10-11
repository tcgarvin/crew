import { templateCard } from "@crew/content";
/**
 * §card-history: the server's record of which cards the captain has seen
 * (`NarratorNotes.cardsShown`). The model never writes it. Two sources feed it:
 *  - this call's own output (the policy `card` prose and every translated `surfaceDecision`);
 *  - the kernel's decision events since the previous call (`decisionPending` for cards the
 *    kernel surfaced itself, such as job offers and follow-up cards; `decisionResolved` for the
 *    side chosen), `unseenRolled` for the roll on the arrival card's way in unseen (§unseen-odds)
 *    and `attemptRolled` for a tried side's (§tried-sides).
 *
 * The events carry only a decision ID, so the decision record in the snapshot (which the kernel
 * keeps after resolution) supplies the title through `templateCard`. A narrator-surfaced card
 * has no decision ID when it is recorded (the kernel mints it on apply), so it is matched to its
 * decision later by title and the ID is filled in then.
 */
import type { ContentBundle, DecisionId, NarratorCommand, SimEvent } from "@crew/sim";
import type { DecisionCardProse } from "./contract";
import type { State } from "./lookups";
import { type CardRoll, type CardShown, NOTES_LIMITS, clipWords } from "./notes";

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function fromRecord(
  state: State,
  decisionId: DecisionId,
  content: ContentBundle,
): CardShown | undefined {
  const record = state.decisions.records[decisionId];
  if (record === undefined) return undefined;
  const tick = record.deliveredTick ?? record.createdTick;
  return {
    ...fromCard(templateCard(record, content), tick),
    decisionId,
    chosen: record.chosen ?? null,
  };
}

/** The most recent entry still waiting for its decision ID, by title. */
function unmatchedByTitle(cards: readonly CardShown[], title: string): number {
  for (let i = cards.length - 1; i >= 0; i -= 1) {
    const card = cards[i];
    if (card !== undefined && card.decisionId === null && sameTitle(card.title, title)) return i;
  }
  return -1;
}

function cap(cards: CardShown[]): CardShown[] {
  return cards.slice(-NOTES_LIMITS.cardsShown);
}

/**
 * The web client clears its event buffer on any HTTP-ok reply, including a fallback reply that
 * carries no notes, so a `decisionResolved` event can be lost. The decision records in the
 * snapshot are the durable truth: every unresolved entry is checked against them, by ID or (for
 * an entry still waiting for its ID) by the title of a resolved record.
 */
/**
 * §unseen-odds, §tried-sides: a roll on a card the captain answered (the way in unseen on its
 * arrival card, or a tried side), put on its entry, from the event or, if that was lost, from the
 * snapshot.
 */
function withRoll(cards: readonly CardShown[], decisionId: string, tried: CardRoll): CardShown[] {
  return cards.map((c) =>
    c.decisionId === decisionId && c.tried === undefined ? { ...c, tried } : c,
  );
}

function rollFromSnapshot(cards: readonly CardShown[], state: State): CardShown[] {
  let next = [...cards];
  for (const card of cards) {
    if (card.decisionId === null || card.tried !== undefined) continue;
    const tried = state.decisions.records[card.decisionId as DecisionId]?.tried;
    if (tried !== undefined) {
      next = withRoll(next, card.decisionId, {
        odds: tried.odds,
        worked: tried.worked,
        kind: "try",
      });
    }
  }
  const expedition = state.expedition;
  const arrival = expedition?.cards?.arrival;
  const roll = expedition?.unseenRoll;
  if (arrival === undefined || roll === undefined) return next;
  return withRoll(next, arrival, { odds: roll.odds, worked: roll.worked, kind: "unseen" });
}

function reconcileWithSnapshot(
  cards: readonly CardShown[],
  state: State,
  content: ContentBundle,
): CardShown[] {
  const resolved = Object.values(state.decisions.records).filter(
    (d) => d.status === "resolved" && d.chosen !== undefined,
  );
  const claimed = new Set(cards.map((c) => c.decisionId).filter((id) => id !== null));
  return cards.map((card) => {
    if (card.chosen !== null) return card;
    const record =
      card.decisionId === null
        ? resolved.find(
            (d) => !claimed.has(d.id) && sameTitle(templateCard(d, content).title, card.title),
          )
        : state.decisions.records[card.decisionId as DecisionId];
    if (record === undefined || record.status !== "resolved" || record.chosen === undefined) {
      return card;
    }
    claimed.add(record.id);
    return { ...card, decisionId: record.id, chosen: record.chosen };
  });
}

/**
 * Fold the kernel's decision events into the history: cards the kernel surfaced are added, and
 * resolutions mark the side chosen (by decision ID, else by the decision's title). Then the
 * snapshot's resolved records fill in any resolution whose event never arrived.
 */
export function applyDecisionEvents(
  cards: readonly CardShown[],
  events: readonly SimEvent[],
  state: State,
  content: ContentBundle,
): CardShown[] {
  let next = [...cards];
  for (const event of events) {
    if (event.type === "unseenRolled" || event.type === "attemptRolled") {
      const { decisionId, odds, worked } = event.payload;
      const kind = event.type === "unseenRolled" ? "unseen" : "try";
      next = withRoll(next, decisionId, { odds, worked, kind });
      continue;
    }
    if (event.type === "decisionDropped") {
      // §card-history: a card held for delivery in person that never came up (its offer closed
      // first) was never seen: forget it, by ID or, for an entry still waiting for its ID, by
      // title.
      const record = fromRecord(state, event.payload.decisionId, content);
      const byId = next.findIndex((c) => c.decisionId === event.payload.decisionId);
      const index =
        byId >= 0 ? byId : record === undefined ? -1 : unmatchedByTitle(next, record.title);
      if (index >= 0 && next[index]?.chosen === null) next.splice(index, 1);
      continue;
    }
    if (event.type !== "decisionPending" && event.type !== "decisionResolved") continue;
    const decisionId = event.payload.decisionId;
    const known = next.findIndex((c) => c.decisionId === decisionId);
    const chosen = event.type === "decisionResolved" ? event.payload.side : null;
    if (known >= 0) {
      const card = next[known];
      if (card !== undefined && chosen !== null) next[known] = { ...card, chosen };
      continue;
    }
    const record = fromRecord(state, decisionId, content);
    if (record === undefined) continue;
    const byTitle = unmatchedByTitle(next, record.title);
    if (byTitle >= 0) {
      const card = next[byTitle];
      if (card !== undefined) {
        next[byTitle] = { ...card, decisionId, chosen: chosen ?? card.chosen };
      }
      continue;
    }
    next.push({ ...record, tick: event.type === "decisionPending" ? event.tick : record.tick });
  }
  return cap(rollFromSnapshot(reconcileWithSnapshot(next, state, content), state));
}

function fromCard(card: DecisionCardProse, tick: number): CardShown {
  return {
    tick,
    decisionId: card.decisionId,
    title: card.title,
    speaker: card.speaker ?? null,
    gist: clipWords(card.situation, NOTES_LIMITS.gistWords),
    leftLabel: card.leftLabel,
    rightLabel: card.rightLabel,
    chosen: null,
    closedThread: null,
  };
}

function fromSurfaced(
  command: NarratorCommand,
  tick: number,
  closedThread: string | undefined,
): CardShown | undefined {
  if (command.kind !== "surfaceDecision") return undefined;
  const { prompt, left, right } = command.payload.card;
  const params = prompt.params as Record<string, unknown>;
  return {
    tick,
    decisionId: null,
    title: typeof params.title === "string" ? params.title : "The captain's call",
    speaker: typeof params.speaker === "string" ? params.speaker : null,
    gist: clipWords(prompt.prose ?? "", NOTES_LIMITS.gistWords),
    leftLabel: left.label.prose ?? "",
    rightLabel: right.label.prose ?? "",
    chosen: null,
    closedThread: closedThread ?? null,
  };
}

/**
 * Record what this call put in front of the captain: the policy card's prose (replacing the
 * template entry the kernel's event may already have added for that decision) and every
 * surfaced decision, which gets its ID when its `decisionPending` event arrives.
 */
export function recordCardsFromCall(
  cards: readonly CardShown[],
  tick: number,
  card: DecisionCardProse | undefined,
  commands: readonly NarratorCommand[],
  /**
   * §closing-cards: the thread this call's surfaced card closed; there is at most one surfaced
   * card.
   */
  closedThread: string | undefined = undefined,
): CardShown[] {
  const next = [...cards];
  if (card !== undefined) {
    const entry = fromCard(card, tick);
    const known = next.findIndex((c) => c.decisionId === card.decisionId);
    const previous = next[known];
    if (previous === undefined) next.push(entry);
    else {
      next[known] = {
        ...entry,
        tick: previous.tick,
        chosen: previous.chosen,
        ...(previous.tried === undefined ? {} : { tried: previous.tried }),
      };
    }
  }
  for (const command of commands) {
    const entry = fromSurfaced(command, tick, closedThread);
    if (entry !== undefined) next.push(entry);
  }
  return cap(next);
}
