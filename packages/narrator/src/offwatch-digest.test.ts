/**
 * §ship-life-lines: the off-watch and rivalry lines under "Ship", the crew line's likes,
 * relationships and berth after `good at`, and `{ref}` in thought labels. The world comes from
 * the in-code fixtures (the default scenario's Mk2); sessions, rivalries, relationships, steps
 * and thoughts are written by hand, so these hold whatever the recreation and social systems do.
 */
import type {
  ActivityDefId,
  ActorId,
  CompartmentId,
  DockDefId,
  LocalKey,
  MachineId,
  MemoryKey,
  SaveEnvelope,
  SessionId,
  ThoughtKey,
  TopicDefId,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { buildDigest } from "./digest";
import { quietTooLongRequest } from "./fixtures";
import { EMPTY_NOTES } from "./notes";
import { thoughtLabel } from "./offwatch-digest";
import { content } from "./test-support";

type State = SaveEnvelope["state"];
type Actor = State["actors"][ActorId];

const CARDS = "activity.cards" as ActivityDefId;
const MUSIC = "activity.music" as ActivityDefId;
const DEBATE = "activity.debate" as ActivityDefId;

function snapshot(): SaveEnvelope {
  return structuredClone(quietTooLongRequest(content()).snapshot) as SaveEnvelope;
}

function digest(snap: SaveEnvelope): string {
  return buildDigest(snap, [], EMPTY_NOTES, content(), undefined).text;
}

function shipLines(text: string): string[] {
  return text.split("## Ship\n")[1]?.split("\n\n")[0]?.split("\n") ?? [];
}

function crewLine(text: string, name: string): string {
  const line = text
    .split("## Crew")[1]
    ?.split("\n")
    .find((l) => l.startsWith(`- ${name} `));
  if (line === undefined) throw new Error(`no crew line for ${name}`);
  return line;
}

function actorNamed(state: State, name: string): Actor {
  const actor = Object.values(state.actors).find((a) => a.name === name);
  if (actor === undefined) throw new Error(`fixture: no ${name}`);
  return actor;
}

function compartmentOf(state: State, key: string): CompartmentId {
  const room = Object.values(state.compartments).find((c) => c.key === key);
  if (room === undefined) throw new Error(`fixture: no compartment ${key}`);
  return room.id;
}

function machineAt(state: State, placementKey: string): MachineId {
  const machine = Object.values(state.machines).find((m) => m.placementKey === placementKey);
  if (machine === undefined) throw new Error(`fixture: no machine ${placementKey}`);
  return machine.id;
}

/** A floor tile of the room with `key` on the ship's deck. */
function tileIn(state: State, key: string): { deckId: string; x: number; y: number } {
  const room = Object.values(state.compartments).find((c) => c.key === key);
  const deck = room === undefined ? undefined : content().decks[room.deckId];
  const symbol = deck?.compartments.find((c) => c.key === key)?.symbol;
  if (room === undefined || deck === undefined || symbol === undefined) {
    throw new Error(`fixture: no room ${key}`);
  }
  for (const [y, row] of deck.tiles.entries()) {
    const x = row.indexOf(symbol);
    if (x >= 0) return { deckId: room.deckId, x: x + 0.5, y: y + 0.5 };
  }
  throw new Error(`fixture: room ${key} has no tile`);
}

/** Puts `actor` in the lounge playing `activityId` on their own (a solo `recreate` step). */
function playAlone(state: State, actor: Actor, activityId: ActivityDefId, label: string): void {
  actor.location = { kind: "onDeck", ...tileIn(state, "lounge") } as Actor["location"];
  actor.activity = {
    kind: "personal",
    activity: "recreate",
    urgency: "voluntaryActivity",
    action: {
      kind: "recreate",
      stage: "playing",
      progress: 0,
      startedTick: state.tick,
      interruptible: true,
    },
    sinceTick: state.tick,
    label,
    plan: {
      steps: [{ kind: "recreate", activityId, role: "solo", ticksDone: 0, ticksNeeded: 600 }],
      stepIndex: 0,
    },
  } as Actor["activity"];
}

function cardsAtTheTable(state: State, members: readonly ActorId[], started: boolean): void {
  const id = "s1" as SessionId;
  state.social.sessions[id] = {
    id,
    activityId: CARDS,
    venue: {
      compartmentId: compartmentOf(state, "lounge"),
      machineId: machineAt(state, "games_table_1"),
    },
    hostId: members[0] as ActorId,
    members: [...members],
    openedTick: state.tick - 100,
    ...(started ? { startedTick: state.tick - 20, endsAtTick: state.tick + 1000 } : {}),
  };
}

describe("the off-watch line (§ship-life-lines)", () => {
  it("names a running game with its players and someone playing on their own", () => {
    const snap = snapshot();
    const state = snap.state;
    const jax = actorNamed(state, "Jax Okonkwo");
    const tomas = actorNamed(state, "Tomas Ruiz");
    cardsAtTheTable(state, [jax.id, tomas.id], true);
    playAlone(state, actorNamed(state, "Bettina Solheim"), MUSIC, "playing the harmonica");
    expect(shipLines(digest(snap))).toContain(
      "off watch: cards in Lounge (Jax Okonkwo, Tomas Ruiz); Bettina Solheim playing the harmonica in Lounge",
    );
  });

  it("says a game still gathering in the def's waiting words, with who is waiting", () => {
    const snap = snapshot();
    const state = snap.state;
    cardsAtTheTable(state, [actorNamed(state, "Jax Okonkwo").id], false);
    expect(shipLines(digest(snap))).toContain(
      "off watch: Jax Okonkwo waiting for a game of cards in Lounge",
    );
  });

  it("names a running debate's topic", () => {
    const snap = snapshot();
    const state = snap.state;
    const id = "s2" as SessionId;
    state.social.sessions[id] = {
      id,
      activityId: DEBATE,
      venue: { compartmentId: compartmentOf(state, "lounge") },
      hostId: actorNamed(state, "Priya Kessler").id,
      members: [actorNamed(state, "Priya Kessler").id, actorNamed(state, "Dane Whitcross").id],
      openedTick: state.tick - 100,
      startedTick: state.tick - 10,
      endsAtTick: state.tick + 500,
      topicId: "topic.the_guild" as TopicDefId,
    };
    expect(shipLines(digest(snap))).toContain(
      "off watch: debating about the Guild in Lounge (Priya Kessler, Dane Whitcross)",
    );
  });

  it("says where a drink ashore is: by the dock post, at the port (§shore-leave)", () => {
    const snap = snapshot();
    const state = snap.state;
    const id = "s3" as SessionId;
    const jax = actorNamed(state, "Jax Okonkwo").id;
    const priya = actorNamed(state, "Priya Kessler").id;
    state.social.sessions[id] = {
      id,
      activityId: "activity.shore_leave" as ActivityDefId,
      venue: { dockId: "dock.crossroads_hub" as DockDefId, postKey: "night_stall" as LocalKey },
      hostId: jax,
      members: [jax, priya],
      openedTick: state.tick - 100,
      startedTick: state.tick - 10,
      endsAtTick: state.tick + 500,
    };
    expect(shipLines(digest(snap))).toContain(
      "off watch: having a drink by the night-market stall at Crossroads Hub (Jax Okonkwo, Priya Kessler)",
    );
  });

  it("is absent when nobody is at leisure in an activity", () => {
    expect(digest(snapshot())).not.toContain("off watch:");
  });
});

describe("the rivalries line (§ship-life-lines)", () => {
  it("names a rivalry in the key's order with its tally and the current run", () => {
    const snap = snapshot();
    const state = snap.state;
    const tomas = actorNamed(state, "Tomas Ruiz").id;
    const jax = actorNamed(state, "Jax Okonkwo").id;
    state.social.rivalries[`${tomas}|${jax}|${CARDS}`] = { wins: 0, losses: 3, streak: -3 };
    expect(shipLines(digest(snap))).toContain(
      "rivalries: Tomas Ruiz vs Jax Okonkwo at cards (0–3, Jax Okonkwo's run of 3)",
    );
  });

  it("leaves out a pair with fewer than three games and no run, and the run under two", () => {
    const snap = snapshot();
    const state = snap.state;
    const tomas = actorNamed(state, "Tomas Ruiz").id;
    const jax = actorNamed(state, "Jax Okonkwo").id;
    const dane = actorNamed(state, "Dane Whitcross").id;
    state.social.rivalries[`${tomas}|${jax}|${CARDS}`] = { wins: 1, losses: 1, streak: 1 };
    state.social.rivalries[`${dane}|${jax}|${CARDS}`] = { wins: 2, losses: 2, streak: 1 };
    const lines = shipLines(digest(snap));
    expect(lines).toContain("rivalries: Dane Whitcross vs Jax Okonkwo at cards (2–2)");
    expect(lines.join("\n")).not.toContain("Tomas Ruiz vs");
  });

  it("names a two-game run, and skips a pair one of whom is gone", () => {
    const snap = snapshot();
    const state = snap.state;
    const tomas = actorNamed(state, "Tomas Ruiz").id;
    const jax = actorNamed(state, "Jax Okonkwo").id;
    state.social.rivalries[`${jax}|${tomas}|${CARDS}`] = { wins: 2, losses: 0, streak: 2 };
    state.social.rivalries[`${jax}|a999|${CARDS}`] = { wins: 5, losses: 0, streak: 5 };
    expect(shipLines(digest(snap))).toContain(
      "rivalries: Jax Okonkwo vs Tomas Ruiz at cards (2–0, Jax Okonkwo's run of 2)",
    );
  });

  it("throws on a malformed key rather than guessing", () => {
    const snap = snapshot();
    snap.state.social.rivalries["a1|a2"] = { wins: 3, losses: 0, streak: 3 };
    expect(() => digest(snap)).toThrow(/malformed rivalry key/);
  });
});

describe("the crew line's off-watch clauses (§ship-life-lines)", () => {
  it("follows good at with likes, dislikes and the berth, keeping the line's shape", () => {
    const text = digest(snapshot());
    const jax = crewLine(text, "Jax Okonkwo");
    expect(jax).toMatch(
      /; needs: .+; mood: .+; good at: piloting \d+; likes: cards \(keen\), vids; dislikes: reading; berth: bunkroom\. /,
    );
    expect(crewLine(text, "Mara Osei")).toMatch(/; good at: .+; likes: .+; berth: own cabin\. /);
  });

  it("names who they are close to and at odds with, two each at most, from their own side", () => {
    const snap = snapshot();
    const state = snap.state;
    const jax = actorNamed(state, "Jax Okonkwo").id;
    const id = (name: string) => actorNamed(state, name).id;
    // §affinity: compatibility from the authored crew (Jax with Noor and Tomas +1, Dane −2, Priya
    // 0), plus the memories each side holds.
    const remembers = (...keys: MemoryKey[]) => ({
      memories: keys.map((key) => ({ key, expiresAtTick: state.tick + 1000 })),
    });
    state.social.relationships[jax] = {
      [id("Tomas Ruiz")]: remembers("goodTalk", "chatted"),
      [id("Noor Haddad")]: remembers("goodTalk", "heardMeOut"),
      [id("Dane Whitcross")]: remembers("goodTalk", "chatted", "chatted", "goodTime"),
      [id("Priya Kessler")]: remembers("argued", "rubbedWrong"),
    };
    // Priya's side does not show on Jax's line.
    state.social.relationships[id("Priya Kessler")] = { [jax]: remembers("goodTalk", "chatted") };
    const text = digest(snap);
    expect(crewLine(text, "Jax Okonkwo")).toContain(
      "; dislikes: reading; close to: Noor Haddad, Tomas Ruiz; at odds with: Priya Kessler; berth: bunkroom.",
    );
    expect(crewLine(text, "Priya Kessler")).toContain("close to: Jax Okonkwo");
  });

  it("says berth none for someone without a bed", () => {
    const snap = snapshot();
    const jax = actorNamed(snap.state, "Jax Okonkwo").id;
    delete snap.state.berths[jax];
    expect(crewLine(digest(snap), "Jax Okonkwo")).toContain("; berth: none.");
  });

  it("says bored among the needs once recreation passes the seek threshold", () => {
    const snap = snapshot();
    const jax = actorNamed(snap.state, "Jax Okonkwo");
    jax.needs = { hunger: 0, fatigue: 0, comfort: 0, social: 0, recreation: 0.9 };
    expect(crewLine(digest(snap), "Jax Okonkwo")).toContain("; needs: bored; mood:");
    jax.needs.recreation = 0.2;
    expect(crewLine(digest(snap), "Jax Okonkwo")).toContain("; needs: fine; mood:");
  });
});

describe("{ref} in thought labels (§ship-life-lines)", () => {
  it("fills the placeholder with the refId's name in the mood clause", () => {
    const snap = snapshot();
    const state = snap.state;
    const tomas = actorNamed(state, "Tomas Ruiz");
    const jax = actorNamed(state, "Jax Okonkwo");
    tomas.thoughts = [
      {
        key: "keepsBeatingMe" as ThoughtKey,
        value: -0.15,
        expiresAtTick: state.tick + 1000,
        refId: jax.id,
      },
    ];
    expect(crewLine(digest(snap), "Tomas Ruiz")).toContain("(Jax Okonkwo keeps beating me)");
  });

  it("lets the label stand alone without a refId, and says someone for a stranger", () => {
    const state = snapshot().state;
    const bundle = content();
    expect(thoughtLabel(state, bundle, { key: "argued" as ThoughtKey })).toBe("argued with");
    expect(
      thoughtLabel(state, bundle, { key: "argued" as ThoughtKey, refId: "a999" as ActorId }),
    ).toBe("argued with someone");
    expect(thoughtLabel(state, bundle, { key: "wonContest" as ThoughtKey })).toBe(
      bundle.thoughts["wonContest" as ThoughtKey]?.label,
    );
  });
});
