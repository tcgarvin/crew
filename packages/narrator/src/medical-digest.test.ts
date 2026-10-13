/**
 * §ship-life-lines, §medicine: the infirmary line and the `crewWounded` problem line in the digest.
 * The world is the in-code fixture (the default scenario's Mk2, its medbay bed and its three med
 * kits); the problem, its task, the claim and who lies in the bed are written by hand, so these
 * hold whatever the medical system does.
 */
import {
  type ActorId,
  type ClaimId,
  type ProblemId,
  type SaveEnvelope,
  type TaskId,
  medBedOf,
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

function infirmary(text: string): string | undefined {
  const ship = text.split("## Ship\n")[1]?.split("\n\n")[0]?.split("\n") ?? [];
  return ship.find((l) => l.startsWith("infirmary: "));
}

function actorNamed(state: State, name: string): ActorId {
  const actor = Object.values(state.actors).find((a) => a.name === name);
  if (actor === undefined) throw new Error(`fixture: no ${name}`);
  return actor.id;
}

/** Open `crewWounded` for `patient`, its `treatWounds` task held by `medic` when given. */
function wounded(state: State, patient: ActorId, medic?: ActorId): void {
  const problemId = "p901" as ProblemId;
  state.work.problems[problemId] = {
    id: problemId,
    kind: "crewWounded",
    payload: { actorId: patient, untreated: 1 },
    owner: "medical",
    visibility: "public",
    dedupeKey: `wounded:${patient}`,
    status: "open",
    createdTick: 20,
    revision: 1,
    baseUrgency: "routineObligation",
  } as State["work"]["problems"][ProblemId];
  const taskId = "t901" as TaskId;
  const claimId = "c901" as ClaimId;
  state.work.tasks[taskId] = {
    id: taskId,
    problemId,
    type: "treatWounds",
    claimState:
      medic === undefined ? { kind: "unclaimed" } : { kind: "claimed", claimIds: [claimId] },
  } as never;
  if (medic !== undefined) {
    state.work.claims[claimId] = {
      id: claimId,
      taskId,
      ownerActorId: medic,
      claimedTick: state.tick,
      expiresAtTick: state.tick + 100,
    };
  }
}

function onBed(state: State, id: ActorId): void {
  const bed = medBedOf(state, content());
  const actor = state.actors[id];
  const deckId = Object.keys(state.deck.tiles)[0];
  if (bed === undefined || actor === undefined || deckId === undefined) throw new Error("fixture");
  actor.location = {
    kind: "onDeck",
    deckId: deckId as never,
    x: bed.useTile.x + 0.5,
    y: bed.useTile.y + 0.5,
  };
}

function noKits(state: State): void {
  for (const [id, item] of Object.entries(state.items)) {
    if (item.defId === "item.med_kit") delete state.items[id as keyof State["items"]];
  }
}

describe("the infirmary line (§ship-life-lines, §medicine)", () => {
  it("is absent on a ship with nobody hurt and the kits at the reserve", () => {
    expect(infirmary(digest(snapshot()))).toBeUndefined();
  });

  it("names who lies in the bed, who is treating, and the kits against the reserve", () => {
    const snap = snapshot();
    const priya = actorNamed(snap.state, "Priya Kessler");
    wounded(snap.state, priya);
    expect(infirmary(digest(snap))).toBe(
      "infirmary: the bed is empty; 3 med kits aboard (the ship keeps 2)",
    );
    const treating = snapshot();
    wounded(treating.state, priya, actorNamed(treating.state, "Oyelaran Abiodun"));
    onBed(treating.state, priya);
    expect(infirmary(digest(treating))).toBe(
      "infirmary: Priya Kessler in the bed, Oyelaran Abiodun treating; 3 med kits aboard (the ship keeps 2)",
    );
  });

  it("shows up when the kits run under the reserve", () => {
    const snap = snapshot();
    noKits(snap.state);
    expect(infirmary(digest(snap))).toBe(
      "infirmary: the bed is empty; no med kits aboard (the ship keeps 2)",
    );
  });
});

describe("the crewWounded problem line (§the-wounded-problem)", () => {
  it("says who is wounded and who is treating, or that nobody is and why", () => {
    const treating = snapshot();
    const priya = actorNamed(treating.state, "Priya Kessler");
    wounded(treating.state, priya, actorNamed(treating.state, "Oyelaran Abiodun"));
    expect(digest(treating)).toContain(
      "- crewWounded (public) since tick 20: Priya Kessler is wounded; Oyelaran Abiodun treating",
    );
    const nobody = snapshot();
    wounded(nobody.state, priya);
    expect(digest(nobody).split("\n")).toContain(
      "- crewWounded (public) since tick 20: Priya Kessler is wounded; nobody treating yet",
    );
    noKits(nobody.state);
    expect(digest(nobody)).toContain(
      "- crewWounded (public) since tick 20: Priya Kessler is wounded; nobody treating yet, no kits aboard",
    );
  });
});
