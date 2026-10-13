/**
 * §crew-lines, §the-body-aboard, §laid-to-rest: the ship's dead in the digest. A crew member dead
 * aboard keeps their crew line, marked "(dead)"; the `bodyAboard` problem line says whose body,
 * where it goes and who is carrying it; once laid to rest ashore they leave the crew list for one
 * "Laid to rest" line. The world is the in-code fixture; deaths and problems are written by hand.
 */
import {
  type ActorId,
  type ClaimId,
  type PortDefId,
  type ProblemId,
  type SaveEnvelope,
  type TaskId,
  restingPlaces,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { buildDigest } from "./digest";
import { approachRequest } from "./fixtures";
import { EMPTY_NOTES } from "./notes";
import { content } from "./test-support";

type State = SaveEnvelope["state"];

function snapshot(): SaveEnvelope {
  return structuredClone(approachRequest(content()).snapshot) as SaveEnvelope;
}

function digest(snap: SaveEnvelope): string {
  return buildDigest(snap, [], EMPTY_NOTES, content(), undefined).text;
}

function crewSection(text: string): string[] {
  return text.split("## Crew")[1]?.split("\n\n")[0]?.split("\n") ?? [];
}

function actorNamed(state: State, name: string): ActorId {
  const actor = Object.values(state.actors).find((a) => a.name === name);
  if (actor === undefined) throw new Error(`fixture: no ${name}`);
  return actor.id;
}

function kill(state: State, id: ActorId): void {
  const actor = state.actors[id];
  if (actor === undefined) throw new Error(`fixture: no ${id}`);
  actor.availability = "dead";
}

/** Open `bodyAboard` for `body`, to the deck's first resting place, carried by `carrier`. */
function bodyAboard(state: State, body: ActorId, carrier?: ActorId): void {
  const deckId = Object.keys(state.deck.tiles)[0] as keyof ReturnType<typeof content>["decks"];
  const deck = content().decks[deckId];
  const tile = deck === undefined ? undefined : restingPlaces(content(), deck)[0];
  if (tile === undefined) throw new Error("fixture: no resting place");
  const problemId = "p902" as ProblemId;
  state.work.problems[problemId] = {
    id: problemId,
    kind: "bodyAboard",
    payload: { actorId: body, tile },
    owner: "medical",
    visibility: "public",
    dedupeKey: `body:${body}`,
    status: "open",
    createdTick: 30,
    revision: 1,
    baseUrgency: "routineObligation",
  } as State["work"]["problems"][ProblemId];
  if (carrier === undefined) return;
  const taskId = "t902" as TaskId;
  const claimId = "c902" as ClaimId;
  state.work.tasks[taskId] = {
    id: taskId,
    problemId,
    type: "carryBody",
    claimState: { kind: "claimed", claimIds: [claimId] },
  } as never;
  state.work.claims[claimId] = {
    id: claimId,
    taskId,
    ownerActorId: carrier,
    claimedTick: state.tick,
    expiresAtTick: state.tick + 100,
  };
}

describe("the ship's dead in the digest (§the-body-aboard, §laid-to-rest)", () => {
  it("a crew member dead aboard keeps a crew line marked dead", () => {
    const snap = snapshot();
    const tomas = actorNamed(snap.state, "Tomas Ruiz");
    kill(snap.state, tomas);
    const lines = crewSection(digest(snap));
    expect(lines.some((l) => l.startsWith("- Tomas Ruiz") && l.includes("(dead)"))).toBe(true);
    expect(lines.some((l) => l.startsWith("- Laid to rest"))).toBe(false);
  });

  it("the bodyAboard line names the body, where it goes and who is carrying it", () => {
    const snap = snapshot();
    const tomas = actorNamed(snap.state, "Tomas Ruiz");
    kill(snap.state, tomas);
    bodyAboard(snap.state, tomas, actorNamed(snap.state, "Jax Okonkwo"));
    expect(digest(snap)).toContain(
      "- bodyAboard (public) since tick 30: Tomas Ruiz's body, to be laid out in Cargo Hold; Jax Okonkwo carrying it",
    );
    const nobody = snapshot();
    kill(nobody.state, tomas);
    bodyAboard(nobody.state, tomas);
    expect(digest(nobody)).toContain(
      "- bodyAboard (public) since tick 30: Tomas Ruiz's body, to be laid out in Cargo Hold; nobody carrying it yet",
    );
  });

  it("laid to rest ashore, they leave the crew list for one line", () => {
    const snap = snapshot();
    const tomas = actorNamed(snap.state, "Tomas Ruiz");
    const before = crewSection(digest(snap))[0];
    kill(snap.state, tomas);
    const actor = snap.state.actors[tomas];
    if (actor === undefined) throw new Error("fixture");
    actor.location = {
      kind: "inExternalStore",
      portId: "port.terns_rest" as PortDefId,
      storeKey: "lounge" as never,
    };
    const lines = crewSection(digest(snap));
    expect(lines.some((l) => l.startsWith("- Tomas Ruiz"))).toBe(false);
    expect(lines).toContain("- Laid to rest: Tomas Ruiz at Tern's Rest.");
    // The heading counts the crew aboard: one fewer.
    const count = (heading: string | undefined) => Number(/\((\d+)\)/.exec(heading ?? "")?.[1]);
    expect(count(lines[0])).toBe(count(before) - 1);
  });
});
