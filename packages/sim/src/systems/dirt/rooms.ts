/**
 * Rooms and their `compartmentDirty` problem (D82), shared by the dirt pass (`dirt.ts`) and the
 * end of a mopping trip (`clean.ts`).
 *
 * The problem (owner dirt, public, dedupe `dirty:<key>`, located at the room) opens once the room
 * is `dirty` or worse; each tier change revises it (`payload.tier`, `baseUrgency`, `revision`):
 * routine, essential while `filthy` in a room tagged `galley` or `infirmary`. It resolves once the
 * room is back to `clean` (below `untidy`, with hysteresis): at the end of the trip that got it
 * there, with `roomCleaned` naming the mopper, or, when nobody holds its task (a trip that was cut
 * short), by the dirt pass with no `roomCleaned`. It never resolves under someone mid-trip: the
 * task would complete with the mop still in their hands.
 *
 * Owner: W2 of ship life slice 3.
 */
import { cellIndex } from "../../core/dirt-grid";
import { allocateId } from "../../core/ids";
import type { CompartmentDef, DirtTier } from "../../core/types/content";
import type { ActorId, CompartmentId, DeckDefId, LocalKey, ProblemId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { ProblemOfKind, Task, UrgencyClass } from "../../core/types/work";
import { resolveProblem } from "../equipment/problems";
import { mopWorthy, roomDirt, tierOf, tierRank } from "./grid";

/** A room of a deck in state: its def and its instance. */
export interface Room {
  readonly deckId: DeckDefId;
  readonly def: CompartmentDef;
  readonly compartmentId: CompartmentId;
}

export const dirtyKeyOf = (key: LocalKey): string => `dirty:${key}`;

/** The rooms of every deck that has a dirt row, in deck then authored order. */
export function roomsOf(ctx: Pick<StepCtx, "state" | "content">): Room[] {
  const ids = new Map<string, CompartmentId>();
  for (const c of Object.values(ctx.state.compartments)) ids.set(`${c.deckId}/${c.key}`, c.id);
  const rooms: Room[] = [];
  for (const deckId of Object.keys(ctx.state.dirt.cells) as DeckDefId[]) {
    for (const def of ctx.content.decks[deckId]?.compartments ?? []) {
      const compartmentId = ids.get(`${deckId}/${def.key}`);
      if (compartmentId !== undefined) rooms.push({ deckId, def, compartmentId });
    }
  }
  return rooms;
}

/** The room's tier now, from its cells against its stored tier. */
export function currentTier(ctx: Pick<StepCtx, "state" | "content" | "config">, room: Room) {
  const deck = ctx.content.decks[room.deckId];
  const cells = ctx.state.dirt.cells[room.deckId];
  const stored: DirtTier = ctx.state.dirt.tiers[room.def.key] ?? "clean";
  if (deck === undefined || cells === undefined) return stored;
  return tierOf(roomDirt(cells, deck, room.def.key, ctx.config), stored, ctx.config);
}

export function urgencyFor(tier: DirtTier, room: Pick<CompartmentDef, "tags">): UrgencyClass {
  const critical = room.tags.includes("galley") || room.tags.includes("infirmary");
  return tier === "filthy" && critical ? "essentialOperation" : "routineObligation";
}

export function openDirtProblem(
  ctx: Pick<StepCtx, "state">,
  key: LocalKey,
): ProblemOfKind<"compartmentDirty"> | undefined {
  const dedupeKey = dirtyKeyOf(key);
  return Object.values(ctx.state.work.problems).find(
    (p): p is ProblemOfKind<"compartmentDirty"> =>
      p.kind === "compartmentDirty" && p.status === "open" && p.dedupeKey === dedupeKey,
  );
}

/** The live tasks derived from `problem`. */
function liveTasks(ctx: Pick<StepCtx, "state">, problem: { readonly id: ProblemId }): Task[] {
  return Object.values(ctx.state.work.tasks).filter(
    (t) => t.problemId === problem.id && t.status !== "completed" && t.status !== "cancelled",
  );
}

/** Does anyone hold a claim on the problem's task (a trip under way)? */
export function heldByAnyone(ctx: Pick<StepCtx, "state">, problem: { readonly id: ProblemId }) {
  const tasks = new Set(liveTasks(ctx, problem).map((t) => t.id));
  return Object.values(ctx.state.work.claims).some((claim) => tasks.has(claim.taskId));
}

/** Is some tile of the problem's task no longer worth a mop stroke (mopped on a cut-short trip)? */
export function staleTiles(
  ctx: Pick<StepCtx, "state" | "content" | "config">,
  problem: ProblemOfKind<"compartmentDirty">,
  room: Room,
): boolean {
  const deck = ctx.content.decks[room.deckId];
  const cells = ctx.state.dirt.cells[room.deckId];
  if (deck === undefined || cells === undefined) return false;
  const worthy = mopWorthy(ctx.config);
  return liveTasks(ctx, problem).some((task) =>
    task.interactionTiles.some((tile) => (cells[cellIndex(deck, tile)] ?? 0) < worthy),
  );
}

export function raiseDirtProblem(ctx: StepCtx, room: Room, tier: DirtTier): void {
  const id = allocateId(ctx.state, "problem") as ProblemId;
  ctx.state.work.problems[id] = {
    id,
    kind: "compartmentDirty",
    payload: { compartmentId: room.compartmentId, key: room.def.key, tier },
    owner: "dirt",
    visibility: "public",
    dedupeKey: dirtyKeyOf(room.def.key),
    status: "open",
    createdTick: ctx.tick,
    revision: 1,
    baseUrgency: urgencyFor(tier, room.def),
    location: { kind: "compartment", compartmentId: room.compartmentId },
  };
  ctx.emit({
    type: "problemRaised",
    subjectIds: [id],
    causeIds: [],
    source: "sim",
    payload: { problemId: id, kind: "compartmentDirty" },
  });
}

/** A tier change: the payload, the class and the revision (so the task re-derives). */
export function reviseDirtProblem(
  problem: ProblemOfKind<"compartmentDirty">,
  room: Room,
  tier: DirtTier,
): void {
  problem.payload = { ...problem.payload, tier };
  problem.baseUrgency = urgencyFor(tier, room.def);
  problem.revision += 1;
}

/**
 * Resolve the room's problem, with `roomCleaned` when `byActorId` mopped it clean. The problem
 * must be open.
 */
export function resolveDirtProblem(
  ctx: StepCtx,
  problem: ProblemOfKind<"compartmentDirty">,
  byActorId?: ActorId,
): void {
  const event = resolveProblem(ctx.state, problem.dedupeKey);
  if (event !== undefined) ctx.emit(event);
  if (byActorId === undefined) return;
  const { compartmentId, key } = problem.payload;
  ctx.emit({
    type: "roomCleaned",
    subjectIds: [byActorId, compartmentId],
    causeIds: [],
    source: "sim",
    payload: { compartmentId, key, byActorId },
  });
}

/** Is `tier` one the problem opens at? */
export const opensProblem = (tier: DirtTier): boolean => tierRank(tier) >= tierRank("dirty");
