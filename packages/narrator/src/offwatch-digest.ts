/**
 * Off watch in the digest (slice 4, call 24; D87). Pure reads of the snapshot's social slice and
 * the actors' steps:
 *
 * - `off watch:` under "Ship": every open or running group session (`social.sessions`, by id)
 *   and everyone playing on their own now (a `recreate` step outside a listed session);
 * - `rivalries:` under "Ship": tallies from `social.rivalries` with three games or more, or a
 *   run of two or more, names in the key's order;
 * - the crew line's off-watch clauses after `good at`: likes and dislikes, who they are close to
 *   and at odds with (`affinitiesFrom`: compatibility and their own memories, D88), and their
 *   berth;
 * - a thought label's `{ref}` filled with the name of the thought's `refId`.
 */
import {
  type ActorId,
  type ContentBundle,
  type DeepReadonly,
  type InterestTag,
  type Thought,
  actionLabel,
  affinitiesFrom,
} from "@crew/sim";
import { type State, placePhrase } from "./lookups";

type Actor = State["actors"][keyof State["actors"]];
type Session = State["social"]["sessions"][keyof State["social"]["sessions"]];

/** Affinity at or above which someone is "close to" another, and at or below "at odds with". */
export const CLOSE_TO_AT_LEAST = 3;
export const AT_ODDS_AT_MOST = -3;
/** How many names each of "close to" and "at odds with" lists. */
const RELATIONS_SHOWN = 2;
/** A rivalry is named once this many games were played between the pair at the activity... */
const RIVALRY_GAMES_AT_LEAST = 3;
/** ...or one of them has won this many running. */
const RIVALRY_RUN_AT_LEAST = 2;

/** How an interest tag reads in prose. */
const INTEREST_WORDS: Readonly<Record<InterestTag, string>> = {
  cards: "cards",
  boardgames: "board games",
  vids: "vids",
  debate: "debate",
  music: "music",
  exercise: "exercise",
  sparring: "sparring",
  reading: "reading",
  tinkering: "tinkering",
  cooking: "cooking",
  stargazing: "stargazing",
  gossip: "gossip",
};

function nameOf(state: State, id: string): string | undefined {
  return state.actors[id as ActorId]?.name;
}

/** "Lounge": a compartment instance's authored name. */
function compartmentName(state: State, content: ContentBundle, id: string): string {
  const instance = state.compartments[id as keyof State["compartments"]];
  if (instance === undefined) throw new Error(`session venue: unknown compartment ${id}`);
  const def = content.decks[instance.deckId]?.compartments.find((c) => c.key === instance.key);
  if (def === undefined) throw new Error(`session venue: no compartment def ${instance.key}`);
  return def.name;
}

/** "cards" from "playing cards": what is played, for "cards in Lounge" and "at cards". */
export function activityNoun(content: ContentBundle, activityId: string): string {
  const def = content.activities[activityId as keyof ContentBundle["activities"]];
  if (def === undefined) throw new Error(`unknown activity ${activityId}`);
  return def.label.replace(/^playing /, "");
}

/** A session as the off-watch line says it: running with its players, or still gathering. */
function sessionPhrase(
  state: State,
  content: ContentBundle,
  session: DeepReadonly<Session>,
): string {
  const def = content.activities[session.activityId];
  if (def === undefined) throw new Error(`session ${session.id}: unknown activity`);
  const room = compartmentName(state, content, session.venue.compartmentId);
  const names = session.members.map((id) => nameOf(state, id) ?? id).join(", ");
  if (session.startedTick === undefined) {
    return `${names || "nobody yet"} ${def.waitingLabel} in ${room}`;
  }
  const topic = session.topicId === undefined ? undefined : content.topics[session.topicId]?.label;
  const about = topic === undefined ? "" : ` about ${topic}`;
  return `${activityNoun(content, session.activityId)}${about} in ${room} (${names})`;
}

/** The step an actor's plan is on, if they have a plan. */
function currentStep(actor: Actor) {
  const activity = actor.activity;
  if (activity.kind === "idle") return undefined;
  return activity.plan?.steps[activity.plan.stepIndex];
}

/**
 * `off watch: cards in Lounge (Jax Okonkwo, Tomas Ruiz); Bettina Solheim playing the harmonica
 * in Lounge`, or undefined when nobody is at leisure in an activity.
 */
export function offWatchLine(state: State, content: ContentBundle): string | undefined {
  const sessions = Object.values(state.social.sessions).sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true }),
  );
  const inSession = new Set<string>(sessions.flatMap((s) => s.members));
  const parts = sessions.map((s) => sessionPhrase(state, content, s));
  const solo = Object.values(state.actors)
    .filter((a) => !inSession.has(a.id) && currentStep(a)?.kind === "recreate")
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  for (const actor of solo) {
    parts.push(
      `${actor.name} ${actionLabel(actor, state, content)}${placePhrase(content, state, actor.location)}`,
    );
  }
  return parts.length === 0 ? undefined : `off watch: ${parts.join("; ")}`;
}

/**
 * "Tomas Ruiz vs Jax Okonkwo at cards (0–3, Jax Okonkwo's run of 3)": one rivalry, names in the
 * key's order, the tally from the first's side, the run when it is two or more. Undefined for a
 * pair one of whom is no longer aboard the record (a passenger who walked off).
 */
export function rivalryPhrase(
  state: State,
  content: ContentBundle,
  key: string,
  rivalry: DeepReadonly<{ wins: number; losses: number; streak: number }>,
): string | undefined {
  const parts = key.split("|");
  const [aId, bId, activityId] = parts;
  if (parts.length !== 3 || aId === undefined || bId === undefined || activityId === undefined) {
    throw new Error(`malformed rivalry key "${key}"`);
  }
  const a = nameOf(state, aId);
  const b = nameOf(state, bId);
  if (a === undefined || b === undefined) return undefined;
  const runner = rivalry.streak > 0 ? a : b;
  const run =
    Math.abs(rivalry.streak) >= RIVALRY_RUN_AT_LEAST
      ? `, ${runner}'s run of ${Math.abs(rivalry.streak)}`
      : "";
  return `${a} vs ${b} at ${activityNoun(content, activityId)} (${rivalry.wins}–${rivalry.losses}${run})`;
}

/** `rivalries: …`, the most-played first, or undefined when none is worth naming. */
export function rivalriesLine(state: State, content: ContentBundle): string | undefined {
  const named = Object.entries(state.social.rivalries)
    .filter(
      ([, r]) =>
        r.wins + r.losses >= RIVALRY_GAMES_AT_LEAST || Math.abs(r.streak) >= RIVALRY_RUN_AT_LEAST,
    )
    .sort(([ka, a], [kb, b]) => b.wins + b.losses - (a.wins + a.losses) || ka.localeCompare(kb))
    .flatMap(([key, r]) => rivalryPhrase(state, content, key, r) ?? []);
  return named.length === 0 ? undefined : `rivalries: ${named.join("; ")}`;
}

/** "likes: cards (keen), vids; dislikes: exercise". */
function interestsClause(actor: Actor): string {
  const { likes, strong, dislikes } = actor.interests;
  const liked = likes.map((tag) =>
    tag === strong ? `${INTEREST_WORDS[tag]} (keen)` : INTEREST_WORDS[tag],
  );
  const likesText = `likes: ${liked.join(", ") || "nothing in particular"}`;
  return dislikes.length === 0
    ? likesText
    : `${likesText}; dislikes: ${dislikes.map((t) => INTEREST_WORDS[t]).join(", ")}`;
}

/** "close to: Jax Okonkwo; at odds with: Priya Kessler", from the actor's own side; "" for none. */
function relationsClause(state: State, content: ContentBundle, actor: Actor): string {
  const felt = Object.entries(affinitiesFrom(state, content.config.social, actor.id))
    .flatMap(([id, affinity]) => {
      const name = nameOf(state, id);
      return name === undefined ? [] : [{ name, affinity }];
    })
    .sort((a, b) => b.affinity - a.affinity || a.name.localeCompare(b.name));
  const close = felt.filter((f) => f.affinity >= CLOSE_TO_AT_LEAST).slice(0, RELATIONS_SHOWN);
  const odds = felt
    .filter((f) => f.affinity <= AT_ODDS_AT_MOST)
    .reverse()
    .slice(0, RELATIONS_SHOWN);
  const parts: string[] = [];
  if (close.length > 0) parts.push(`close to: ${close.map((f) => f.name).join(", ")}`);
  if (odds.length > 0) parts.push(`at odds with: ${odds.map((f) => f.name).join(", ")}`);
  return parts.join("; ");
}

/** "own cabin" (a `cabin` room), "bunkroom" (`quarters`), the room's name otherwise, or "none". */
export function berthWord(state: State, content: ContentBundle, actor: Actor): string {
  const bedKey = state.berths[actor.id];
  if (bedKey === undefined) return "none";
  const bed = Object.values(state.machines).find((m) => m.placementKey === bedKey);
  const deck = bed === undefined ? undefined : content.decks[bed.deckId];
  const placement = deck?.machines.find((p) => p.key === bedKey);
  const symbol =
    placement === undefined ? undefined : deck?.tiles[placement.origin.y]?.[placement.origin.x];
  const room = deck?.compartments.find((c) => c.symbol === symbol);
  if (room === undefined) throw new Error(`berth of ${actor.id}: bed ${bedKey} is in no room`);
  if (room.tags.includes("cabin")) return "own cabin";
  if (room.tags.includes("quarters")) return "bunkroom";
  return room.name;
}

/**
 * The crew line's clauses after `good at`: "; likes: …; close to: …; berth: own cabin". Each
 * starts with "; " so the line reads `good at: …; likes: …`.
 */
export function crewOffWatchClauses(state: State, content: ContentBundle, actor: Actor): string {
  const relations = relationsClause(state, content, actor);
  return `; ${interestsClause(actor)}${relations === "" ? "" : `; ${relations}`}; berth: ${berthWord(state, content, actor)}`;
}

/**
 * A thought's label with `{ref}` filled from its `refId` ("Jax Okonkwo keeps beating me"); with
 * no `refId` the placeholder goes and the rest of the label stands alone.
 */
export function thoughtLabel(
  state: State,
  content: ContentBundle,
  thought: DeepReadonly<Pick<Thought, "key" | "refId">>,
): string {
  const label = content.thoughts[thought.key]?.label ?? thought.key;
  if (!label.includes("{ref}")) return label;
  if (thought.refId === undefined) return label.replace(/\s*\{ref\}\s*/g, " ").trim();
  return label.replaceAll("{ref}", nameOf(state, thought.refId) ?? "someone");
}
