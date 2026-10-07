/**
 * D77-D79 in the digest: the watch line, duty tags, mood and the helm's stakes. The world comes
 * from the in-code fixtures (the default scenario's bill) and the helm, thoughts and hazards are
 * written by hand, so these hold whatever the sim's helm rules do and whenever fixtures change.
 */
import {
  type ActorId,
  type EventId,
  type MachineId,
  type SaveEnvelope,
  type SimEvent,
  type TaskId,
  type ThoughtKey,
  rotateOffset,
  watchTicks,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { buildDigest } from "./digest";
import { approachRequest, quietTooLongRequest } from "./fixtures";
import { machineName } from "./lookups";
import { EMPTY_NOTES } from "./notes";
import { content } from "./test-support";

type State = SaveEnvelope["state"];
type Actor = State["actors"][ActorId];

function clone(req: { readonly snapshot: SaveEnvelope }): SaveEnvelope {
  return structuredClone(req.snapshot) as SaveEnvelope;
}

function actorNamed(state: State, name: string): Actor {
  const actor = Object.values(state.actors).find((a) => a.name === name);
  if (actor === undefined) throw new Error(`fixture: no ${name}`);
  return actor;
}

function machineOf(state: State, defId: string): MachineId {
  const machine = Object.values(state.machines).find((m) => m.defId === defId);
  if (machine === undefined) throw new Error(`fixture: no ${defId}`);
  return machine.id;
}

/** `tick` inside watch `index` of the second day, `secondsLeft` before its bell. */
function atWatch(snapshot: SaveEnvelope, index: number, secondsLeft: number): void {
  const config = snapshot.config;
  const length = watchTicks(config);
  const day = length * config.time.watchesPerDay;
  snapshot.state.tick = day + length * (index + 1) - secondsLeft * config.time.tickRate;
}

/** The helm's seat: its first `operate` position, placed and turned as the deck has it. */
function helmSeat(state: State): { x: number; y: number; deckId: string } {
  const helm = state.machines[machineOf(state, "machine.helm")];
  if (helm === undefined) throw new Error("fixture: no helm");
  const def = content().machines[helm.defId];
  const placement = content().decks[helm.deckId]?.machines.find((p) => p.key === helm.placementKey);
  const seat = def?.interactionPositions.find((p) => p.purposes.includes("operate"));
  if (placement === undefined || seat === undefined) throw new Error("fixture: no helm seat");
  const offset = rotateOffset(seat.offset, placement.rotation);
  return {
    x: placement.origin.x + offset.x,
    y: placement.origin.y + offset.y,
    deckId: helm.deckId,
  };
}

/**
 * Put `actor` in the helm seat: standing on it, in a `staff` hold on a `staffStation` task at
 * the helm (what the sim's `whoHasTheHelm` reads).
 */
function takeHelm(state: State, actor: Actor, sinceTick: number): void {
  const helm = machineOf(state, "machine.helm");
  const seat = helmSeat(state);
  actor.location = {
    kind: "onDeck",
    deckId: seat.deckId as never,
    x: seat.x + 0.5,
    y: seat.y + 0.5,
  };
  const taskId = "t900" as TaskId;
  state.work.tasks[taskId] = {
    id: taskId,
    type: "staffStation",
    target: { kind: "machine", machineId: helm },
  } as never;
  actor.activity = {
    kind: "task",
    taskId,
    claimId: "c900" as never,
    urgency: "essentialOperation",
    action: { kind: "idle" } as never,
    sinceTick,
    plan: {
      steps: [
        { kind: "moveTo", target: { kind: "tile", x: 0, y: 0 } as never, requested: false },
        { kind: "hold", hold: "staff", sinceTick },
      ],
      stepIndex: 1,
    },
  };
}

function event<T extends SimEvent["type"]>(
  tick: number,
  type: T,
  payload: Extract<SimEvent, { type: T }>["payload"],
): SimEvent {
  return {
    id: `e${tick}` as EventId,
    tick,
    seq: 0,
    type,
    subjectIds: [],
    causeIds: [],
    source: "sim",
    significance: "narrative",
    payload,
  } as unknown as SimEvent;
}

function digest(snapshot: SaveEnvelope, events: readonly SimEvent[] = []): string {
  return buildDigest(snapshot, events, EMPTY_NOTES, content(), undefined).text;
}

function lineStarting(text: string, prefix: string): string {
  const line = text.split("\n").find((l) => l.startsWith(prefix));
  if (line === undefined) throw new Error(`no line starting "${prefix}"`);
  return line;
}

function label(key: ThoughtKey): string {
  return content().thoughts[key].label;
}

describe("buildDigest: the watch line (D77)", () => {
  it("under way: the section on watch, who has the helm with their piloting and since when, the officer, the next bell", () => {
    const snapshot = clone(quietTooLongRequest(content()));
    atWatch(snapshot, 1, 120);
    const jax = actorNamed(snapshot.state, "Jax Okonkwo");
    takeHelm(snapshot.state, jax, snapshot.state.tick - 400);
    const text = digest(snapshot);
    expect(lineStarting(text, "watch: ")).toBe(
      `watch: White section has the watch; Jax Okonkwo has the helm (piloting ${jax.skills.piloting}) since tick ${snapshot.state.tick - 400}; officer of the watch: none; next bell in ~120s (Blue section)`,
    );
    // The watch line sits in the Ship section, which is never trimmed.
    expect(text.indexOf("watch: ")).toBeLessThan(text.indexOf("## Your budget"));
  });

  it("names the officer of the watch and flags an unqualified hand at the helm", () => {
    const snapshot = clone(quietTooLongRequest(content()));
    atWatch(snapshot, 0, 30);
    const priya = actorNamed(snapshot.state, "Priya Kessler");
    takeHelm(snapshot.state, priya, snapshot.state.tick);
    const min = content().machines["machine.helm" as never]?.operation.operatorSkill?.min;
    expect(lineStarting(digest(snapshot), "watch: ")).toBe(
      `watch: Red section has the watch; Priya Kessler has the helm (piloting ${priya.skills.piloting}, below the helm's ${min}: an unqualified hand) since tick ${snapshot.state.tick}; officer of the watch: Mara Osei; next bell in ~30s (White section)`,
    );
  });

  it("an empty helm under way says so, with how long it has stood empty", () => {
    const snapshot = clone(quietTooLongRequest(content()));
    atWatch(snapshot, 2, 200);
    const rate = snapshot.config.time.tickRate;
    snapshot.state.watch.helm.unattendedSinceTick = snapshot.state.tick - 35 * rate;
    expect(lineStarting(digest(snapshot), "watch: ")).toBe(
      `watch: Blue section has the watch; nobody has the helm (empty since tick ${snapshot.state.tick - 35 * rate}, ~35s); officer of the watch: Dane Whitcross; next bell in ~200s (Red section)`,
    );
  });

  it("docked: no helm unless someone holds it, and who stands the gangway", () => {
    const req = approachRequest(content());
    const snapshot = clone(req);
    snapshot.state.travel = { stage: "docked", portId: "port.kessler_drift" as never };
    atWatch(snapshot, 0, 100);
    const noor = actorNamed(snapshot.state, "Noor Haddad");
    noor.activity = {
      kind: "personal",
      activity: "standWatch",
      urgency: "routineObligation",
      action: { kind: "idle" } as never,
      sinceTick: snapshot.state.tick,
      plan: {
        steps: [{ kind: "hold", hold: "gangway", sinceTick: snapshot.state.tick }],
        stepIndex: 0,
      },
    };
    expect(lineStarting(digest(snapshot), "watch: ")).toBe(
      "watch: Red section has the watch; officer of the watch: Mara Osei; Noor Haddad on the gangway; next bell in ~100s (White section)",
    );
    noor.activity = { kind: "idle" };
    expect(lineStarting(digest(snapshot), "watch: ")).toContain("; nobody on the gangway;");
  });

  it("without a bill says everyone works days", () => {
    const snapshot = clone(quietTooLongRequest(content()));
    for (const actor of Object.values(snapshot.state.actors)) actor.schedule = {};
    expect(lineStarting(digest(snapshot), "watch: ")).toBe(
      "watch: no watch bill aboard; everyone works days",
    );
  });
});

describe("buildDigest: duty and mood on the crew lines (D77, D79)", () => {
  it("tags each crew member with their section or as a dayworker, on or off", () => {
    const snapshot = clone(quietTooLongRequest(content()));
    // Watch 2 (Blue): the dayworkers' default window is watches 0 and 1.
    atWatch(snapshot, 2, 200);
    const text = digest(snapshot);
    expect(lineStarting(text, "- Mara Osei ")).toMatch(
      /^- Mara Osei \[captain\] \[Red, off watch\]: /,
    );
    expect(lineStarting(text, "- Dane Whitcross ")).toContain("[Blue, on watch]");
    expect(lineStarting(text, "- Bettina Solheim ")).toContain("[dayworker, off duty]");
    atWatch(snapshot, 1, 200);
    expect(lineStarting(digest(snapshot), "- Bettina Solheim ")).toContain("[dayworker, on duty]");
  });

  it("says mood as a word and the three live thoughts that weigh most, a stacked one counted", () => {
    const snapshot = clone(quietTooLongRequest(content()));
    const tick = snapshot.state.tick;
    const jax = actorNamed(snapshot.state, "Jax Okonkwo");
    const thought = (key: ThoughtKey, expiresAtTick = tick + 100) => ({
      key,
      value: content().thoughts[key].value,
      expiresAtTick,
    });
    jax.thoughts = [
      thought("helmCleanPass"),
      thought("stoodLongWatch"),
      thought("helmScrape"),
      thought("doubleWatch"),
      thought("helmScrape"),
      // Expired: never shown, even though it would weigh most.
      { key: "doubleWatch", value: -0.9, expiresAtTick: tick },
    ];
    jax.mood = snapshot.config.mood.lowBelow - 0.1;
    const line = lineStarting(digest(snapshot), "- Jax Okonkwo ");
    expect(line).toContain(
      `; mood: low (${label("doubleWatch")}, ${label("helmScrape")} x2, ${label("stoodLongWatch")}); good at: `,
    );
    expect(line).not.toContain(label("helmCleanPass"));

    jax.thoughts = [thought("helmCleanPass")];
    jax.mood = snapshot.config.mood.highAbove + 0.1;
    expect(lineStarting(digest(snapshot), "- Jax Okonkwo ")).toContain(
      `; mood: high (${label("helmCleanPass")}); `,
    );
    jax.thoughts = [];
    jax.mood = 0;
    expect(lineStarting(digest(snapshot), "- Jax Okonkwo ")).toContain("; mood: steady; good at: ");
  });
});

describe("buildDigest: the helm's stakes (D78)", () => {
  it("reports each hazard with who was at the helm and how it went, and an empty helm", () => {
    const snapshot = clone(quietTooLongRequest(content()));
    const state = snapshot.state;
    const noor = actorNamed(state, "Noor Haddad");
    const pump = machineOf(state, "machine.coolant_pump");
    const pumpMachine = state.machines[pump];
    if (pumpMachine === undefined) throw new Error("fixture: pump");
    const { hard, brutal } = snapshot.config.hazards.difficulty;
    const events = [
      event(3_810, "navHazard", {
        hazardId: "hz1" as never,
        kind: "debrisField",
        difficulty: hard,
        standerId: noor.id,
        skill: 3,
        outcome: "scrape",
        scrapedMachineId: pump,
        lostSeconds: 0,
      }),
      event(3_850, "navHazard", {
        hazardId: "hz2" as never,
        kind: "ionStorm",
        difficulty: hard,
        standerId: noor.id,
        skill: 3,
        outcome: "clean",
        lostSeconds: 0,
      }),
      event(3_900, "helmUnattended", { machineId: machineOf(state, "machine.helm"), seconds: 20 }),
      event(3_950, "navHazard", {
        hazardId: "hz3" as never,
        kind: "ionStorm",
        difficulty: brutal,
        skill: 0,
        outcome: "unattended",
        lostSeconds: 60,
      }),
      event(3_990, "navHazard", {
        hazardId: "hz4" as never,
        kind: "ionStorm",
        difficulty: 9,
        standerId: noor.id,
        skill: 3,
        outcome: "delay",
        lostSeconds: 60,
      }),
    ];
    const text = digest(snapshot, events);
    const pumpName = machineName(content(), pumpMachine);
    expect(text).toContain(
      `helm check t3810: debris field (hard): Noor Haddad at the helm (piloting 3): scraped through; the ${pumpName} took a fault`,
    );
    expect(text).toContain(
      "helm check t3850: ion storm (hard): Noor Haddad at the helm (piloting 3): came through clean",
    );
    expect(text).toContain("helm empty t3900: nobody at the helm for 20s in transit");
    expect(text).toContain(
      "helm check t3950: ion storm (brutal): nobody at the helm: scraped through, and lost 60s on the leg",
    );
    expect(text).toContain(
      "helm check t3990: ion storm (difficulty 9): Noor Haddad at the helm (piloting 3): lost 60s on the leg",
    );
  });

  it("shows a scheduled hazard as truth nobody aboard knows, and the hazard budget", () => {
    const snapshot = clone(quietTooLongRequest(content()));
    const state = snapshot.state;
    const rate = snapshot.config.time.tickRate;
    state.hazards = [
      {
        id: "hz1" as never,
        kind: "ionStorm",
        difficulty: snapshot.config.hazards.difficulty.brutal,
        fireAtTick: state.tick + 50 * rate,
      },
    ];
    state.narrator.budget.hazardsRemaining = 1;
    const text = digest(snapshot);
    expect(text).toContain(
      "hazard scheduled: ion storm (brutal), due in ~50s [scheduled; nobody aboard knows]",
    );
    expect(text).toContain("## Your budget\nspawns remaining: ");
    expect(text).toContain("\nhazards remaining: 1");
    state.travel = {
      stage: "docked",
      portId: "port.green_meridian" as never,
      plannedDestinationId: "port.crossroads_hub" as never,
    };
    expect(digest(snapshot)).toContain(
      "hazard scheduled: ion storm (brutal), due once she is in transit, no sooner than ~50s from now [scheduled; nobody aboard knows]",
    );
  });
});
