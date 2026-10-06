import {
  type EventId,
  type ItemDefId,
  type ItemId,
  type Job,
  type JobId,
  type MachineId,
  type PortDefId,
  type ProblemId,
  type SaveEnvelope,
  type SimEvent,
  dayTicks,
  dockAlongside,
  dockAreaTiles,
  personnelRampFoot,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { DIGEST_MAX_CHARS, buildDigest } from "./digest";
import {
  FIXTURE_PASSENGER,
  approachRequest,
  farCaptainAshoreRequest,
  passengerAboardRequest,
  passengerOverdueRequest,
  quietTooLongRequest,
} from "./fixtures";
import { pathBetween, portName } from "./lookups";
import { EMPTY_NOTES } from "./notes";
import { content } from "./test-support";

const HUB_PORT = "port.crossroads_hub";

/**
 * "2 hops, 425s transit" and the waypoints by name, from content: the leg lengths are tuning
 * (D76 made the spur legs a watch long), so tests derive them rather than pin them.
 */
function pathWords(from: string, to: string): { hops: string; via: string } {
  const path = pathBetween(content(), from, to);
  if (path === undefined) throw new Error(`no path ${from} -> ${to}`);
  const via = path.path
    .slice(1, -1)
    .map((id) => portName(content(), id))
    .join(", ");
  return {
    hops: `${path.hops} ${path.hops === 1 ? "hop" : "hops"}, ${path.distance}s transit`,
    via,
  };
}

function manyEvents(n: number): SimEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}` as EventId,
    tick: i,
    seq: 0,
    type: "faultRepaired",
    subjectIds: [],
    causeIds: [],
    source: "sim",
    significance: "narrative",
    payload: { machineId: "m3", faultKey: `fault_${i}` },
  })) as unknown as SimEvent[];
}

describe("buildDigest: parts market (D47)", () => {
  function dockedWithShortfall(portId: string, balance = 5000) {
    const req = approachRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    const state = snapshot.state;
    state.travel = {
      stage: "docked",
      portId: portId as never,
      plannedDestinationId: "port.crossroads_hub" as never,
      holdForRepairs: true,
    };
    state.money.balance = balance;
    const engine = Object.values(state.machines).find((m) => m.defId === "machine.engine");
    if (engine === undefined) throw new Error("fixture: no engine");
    const problemId = "p9" as ProblemId;
    state.work.problems[problemId] = {
      id: problemId,
      kind: "partsNeeded",
      payload: {
        machineId: engine.id as MachineId,
        itemDefId: "item.spare_parts_stack" as never,
        count: 1,
      },
      owner: "equipment",
      visibility: "public",
      dedupeKey: `partsNeeded:${engine.id}:item.spare_parts_stack`,
      status: "open",
      createdTick: 10,
      revision: 0,
      baseUrgency: "essentialOperation",
      location: { kind: "machine", machineId: engine.id as MachineId },
    };
    return { ...req, snapshot, hook: undefined };
  }

  it("shows what the market here sells, with prices, and a hold's reason", () => {
    const req = dockedWithShortfall("port.crossroads_hub");
    const { text } = buildDigest(req.snapshot, [], EMPTY_NOTES, content(), undefined);
    expect(text).toContain("market here: ");
    expect(text).toContain("Spare Parts x4 at 120 cr");
    expect(text).toContain("departure held for repairs");
    expect(text).toContain(
      "the repair is waiting on parts: 1x Spare Parts (the crew are buying it here (Crossroads Hub))",
    );
    expect(text).toContain(
      "- partsNeeded (public) since tick 10: Main Engine needs 1x Spare Parts; the crew are buying it here (Crossroads Hub)",
    );
  });

  it("says when the part is not sold here, and when the ship cannot afford it", () => {
    const bare = dockedWithShortfall("port.green_meridian");
    expect(buildDigest(bare.snapshot, [], EMPTY_NOTES, content(), undefined).text).toContain(
      "needs 1x Spare Parts; not available here (Green Meridian)",
    );
    const broke = dockedWithShortfall("port.crossroads_hub", 50);
    expect(buildDigest(broke.snapshot, [], EMPTY_NOTES, content(), undefined).text).toContain(
      "needs 1x Spare Parts; cannot afford it here (50 credits)",
    );
  });
});

describe("buildDigest", () => {
  it("is deterministic", () => {
    const req = quietTooLongRequest(content());
    const a = buildDigest(req.snapshot, req.recentEvents, EMPTY_NOTES, content(), req.hook);
    const b = buildDigest(req.snapshot, req.recentEvents, EMPTY_NOTES, content(), req.hook);
    expect(a).toEqual(b);
  });

  it("labels faults nobody has noticed and skips trace events", () => {
    const req = quietTooLongRequest(content());
    const { text } = buildDigest(req.snapshot, req.recentEvents, EMPTY_NOTES, content(), req.hook);
    expect(text).toContain('worn_bearing "Worn bearing" [undiscovered]');
    expect(text).not.toContain("Fault occurred");
    expect(text).toContain("quietTooLong");
  });

  it("stays within the default budget with a long event history", () => {
    const req = approachRequest(content());
    const digest = buildDigest(req.snapshot, manyEvents(500), EMPTY_NOTES, content(), req.hook);
    expect(digest.text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(digest.approxTokens).toBeLessThanOrEqual(2_500);
  });

  it("truncates deterministically, lowest priority first, and says so", () => {
    const req = quietTooLongRequest(content());
    const small = buildDigest(
      req.snapshot,
      manyEvents(20),
      EMPTY_NOTES,
      content(),
      req.hook,
      1_500,
    );
    expect(small.truncated).toBe(true);
    expect(small.text.length).toBeLessThanOrEqual(1_700);
    expect(small.text).toMatch(/\[digest truncated: \d+ lower-priority lines omitted/);
    // Never-drop sections survive.
    expect(small.text).toContain("## Why you were called");
    expect(small.text).toContain("## Your budget");
    expect(
      buildDigest(req.snapshot, manyEvents(20), EMPTY_NOTES, content(), req.hook, 1_500),
    ).toEqual(small);
  });

  it("includes the running notes, threads and past rejections (D32)", () => {
    const req = quietTooLongRequest(content());
    const notes = {
      ...EMPTY_NOTES,
      summary: "The pump has been grumbling.",
      threads: [
        {
          title: "A buyer at Meridian",
          scale: "season" as const,
          people: ["Ysolde Maren", "Jax"],
          stage: "Ysolde hinted she has a buyer",
          nextBeat: "When we next dock at Meridian, she names a price",
          lastBeatTick: 1200,
          beatCardShown: false,
        },
      ],
      lastRejections: ["offerJob: no route"],
    };
    const { text } = buildDigest(req.snapshot, [], notes, content(), req.hook);
    expect(text).toContain("summary: The pump has been grumbling.");
    expect(text).toContain(
      "- [season] A buyer at Meridian (Ysolde Maren, Jax): Ysolde hinted she has a buyer. Next: When we next dock at Meridian, she names a price. Last beat t1200",
    );
    expect(text).toContain("rejected last time: offerJob: no route");
  });

  it("shows each crew member's voice after their bio (D38)", () => {
    const req = quietTooLongRequest(content());
    const { text } = buildDigest(req.snapshot, [], EMPTY_NOTES, content(), req.hook);
    const crewLines = text
      .split("## Crew")[1]
      ?.split("\n\n")[0]
      ?.split("\n")
      .filter((line) => line.startsWith("- ") && !line.startsWith("- passengers"));
    expect(crewLines?.length).toBe(9);
    for (const line of crewLines ?? []) expect(line).toMatch(/\. .+ voice: .+/);
    const dane = content().crew["crew.dane_whitcross" as keyof ReturnType<typeof content>["crew"]];
    expect(text).toContain(`${dane?.bio} voice: ${dane?.voice}`);
  });

  it("says a crew member on the dock alongside is on the dock (D61)", () => {
    const bundle = content();
    const req = farCaptainAshoreRequest(bundle);
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    const state = snapshot.state;
    expect(state.deck.dock?.dockId).toBe("dock.crossroads_hub");
    const berth = dockAlongside(bundle, state);
    if (berth === undefined || state.deck.dock === undefined) throw new Error("fixture: no dock");
    const foot = personnelRampFoot(bundle, state.deck.dock.deckId, berth);
    if (foot === undefined) throw new Error("fixture: the dock has no personnel ramp foot");
    const mara = Object.values(state.actors).find((a) => a.name === "Mara Osei");
    if (mara === undefined || mara.location.kind !== "onDeck") throw new Error("fixture: no Mara");
    // The personnel ramp's landing: the first dock tile off the ship, wherever the berth puts it.
    mara.location = { ...mara.location, x: foot.x + 0.5, y: foot.y + 0.5 };
    const { text } = buildDigest(snapshot, [], EMPTY_NOTES, bundle, req.hook);
    const line = text.split("\n").find((l) => l.startsWith("- Mara Osei"));
    expect(line).toMatch(
      /: this is the captain, the player; never a speaker\. \w+ on the dock; needs/,
    );
  });

  it("describes the dock alongside: its ambience and the freight on it, by standing (D63)", () => {
    const bundle = content();
    const req = farCaptainAshoreRequest(bundle);
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    const state = snapshot.state;
    const berth = dockAlongside(bundle, state);
    if (berth === undefined || state.deck.dock === undefined) throw new Error("fixture: no dock");
    const { dock } = berth;
    const deckId = state.deck.dock.deckId;
    const staging = dockAreaTiles(berth, "freightStaging");
    const bay = dockAreaTiles(berth, "deliveryBay");
    const crate = (id: string, jobId: string, tile: { x: number; y: number } | undefined) => {
      if (tile === undefined) throw new Error("fixture: dock area too small");
      state.items[id as ItemId] = {
        id: id as ItemId,
        defId: "item.crate_general" as ItemDefId,
        stacking: "unique",
        condition: 1,
        jobId: jobId as JobId,
        location: { kind: "onDeck", deckId, x: tile.x + 0.5, y: tile.y + 0.5 },
      };
    };
    const job = (id: string, status: Job["status"], toPortId: string, itemIds: string[]) => {
      state.jobs[id as JobId] = {
        id: id as JobId,
        origin: "narrator",
        issuer: "Hal Petrosyan, queue clerk",
        issuerPerson: { name: "Hal Petrosyan", role: "queue clerk" },
        pitch: { key: "job.pitch.default", params: {} },
        urgency: "relaxed",
        description: { key: "test.job", params: {} },
        fromPortId: (status === "inTransit" ? "port.green_meridian" : HUB_PORT) as PortDefId,
        toPortId: toPortId as PortDefId,
        cargo: [{ itemDefId: "item.crate_general" as ItemDefId, count: itemIds.length }],
        cargoClass: "general",
        pay: 100,
        status,
        offeredTick: 0,
        expiresAtTick: 99_999,
        cargoItemIds: itemIds as ItemId[],
      };
    };
    crate("i901", "j901", staging[0]);
    crate("i902", "j901", staging[1]);
    job("j901", "offered", "port.kessler_drift", ["i901", "i902"]);
    crate("i903", "j902", staging[2]);
    job("j902", "accepted", "port.green_meridian", ["i903"]);
    crate("i904", "j903", bay[0]);
    job("j903", "inTransit", HUB_PORT, ["i904"]);
    const { text } = buildDigest(snapshot, [], EMPTY_NOTES, bundle, req.hook);
    const section = text.split(`## On the dock (${dock.name})\n`)[1]?.split("\n\n")[0];
    const lines = section?.split("\n") ?? [];
    expect(lines[0]).toBe(`the place: ${dock.ambience}`);
    // D67: the people on the dock come first; the freight follows under its own line.
    expect(lines.slice(lines.indexOf("freight:"))).toEqual([
      "freight:",
      "- on offer: 2 crates staged for j901 (Hal Petrosyan (queue clerk), to Kessler Drift); not taken",
      "- waiting to be loaded: 1 crate for j902 (Hal Petrosyan (queue clerk), to Green Meridian)",
      "- delivered: 1 crate for j903 (Hal Petrosyan (queue clerk), to Crossroads Hub) in the delivery bay",
    ]);
    // In flight there is no dock, and no section.
    const quiet = quietTooLongRequest(bundle);
    expect(buildDigest(quiet.snapshot, [], EMPTY_NOTES, bundle, quiet.hook).text).not.toContain(
      "## On the dock",
    );
  });

  it("says freight unloading at its destination is not in hand, so an offer can follow", () => {
    const bundle = content();
    const req = farCaptainAshoreRequest(bundle);
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    const state = snapshot.state;
    if (state.travel.stage !== "docked") throw new Error("fixture: not docked");
    const job = (id: string, status: Job["status"], fromPortId: string, toPortId: string) => {
      state.jobs[id as JobId] = {
        id: id as JobId,
        origin: "narrator",
        issuer: "Hal Petrosyan, queue clerk",
        issuerPerson: { name: "Hal Petrosyan", role: "queue clerk" },
        pitch: { key: "job.pitch.default", params: {} },
        urgency: "relaxed",
        description: { key: "test.job", params: {} },
        fromPortId: fromPortId as PortDefId,
        toPortId: toPortId as PortDefId,
        cargo: [{ itemDefId: "item.crate_general" as ItemDefId, count: 1 }],
        cargoClass: "general",
        pay: 100,
        status,
        offeredTick: 0,
        expiresAtTick: 99_999,
        cargoItemIds: [],
      };
    };
    const here = state.travel.portId;
    job("j903", "inTransit", "port.green_meridian", here);
    const jobLine = (text: string, id: string) =>
      text.split("\n").find((l) => l.startsWith(`- ${id} `));
    const unloading = buildDigest(snapshot, [], EMPTY_NOTES, bundle, req.hook).text;
    expect(jobLine(unloading, "j903")).toMatch(/; being finished here, not in hand: .*$/);
    // With another job really in hand, nothing is said to be free.
    job("j902", "accepted", here, "port.green_meridian");
    const held = buildDigest(snapshot, [], EMPTY_NOTES, bundle, req.hook).text;
    expect(jobLine(held, "j903")).not.toContain("not in hand");
    expect(jobLine(held, "j902")).not.toContain("not in hand");
  });

  it("lists the captain first, as the player and never a speaker, with her voice (D41)", () => {
    const req = quietTooLongRequest(content());
    const { text } = buildDigest(req.snapshot, [], EMPTY_NOTES, content(), req.hook);
    const crewLines = text
      .split("## Crew")[1]
      ?.split("\n\n")[0]
      ?.split("\n")
      .filter((line) => line.startsWith("- ") && !line.startsWith("- passengers"));
    const mara = content().crew["crew.mara_osei" as keyof ReturnType<typeof content>["crew"]];
    const first = crewLines?.[0] ?? "";
    expect(first).toMatch(
      /^- Mara Osei \[captain\] \[Red, o(n|ff) watch\]: this is the captain, the player; never a speaker\. .+; needs: .+; mood: .+; good at: .+/,
    );
    expect(first).toContain(`voice: ${mara?.voice}`);
    expect(first).not.toContain("captain, the player; never a speaker. voice:");
    expect(text.match(/never a speaker/g)).toHaveLength(1);
  });

  it("marks threads that have had their beat card as foreshadowed (D39)", () => {
    const req = quietTooLongRequest(content());
    const thread = {
      title: "The quiet pump",
      scale: "episode" as const,
      people: ["Priya Kessler"],
      stage: "Priya heard something",
      nextBeat: "Underway, the pump fails",
      lastBeatTick: 400,
      beatCardShown: true,
    };
    const notes = {
      ...EMPTY_NOTES,
      threads: [thread, { ...thread, title: "Plain", beatCardShown: false }],
    };
    const { text } = buildDigest(req.snapshot, [], notes, content(), req.hook);
    expect(text).toContain(
      "- [episode] The quiet pump (Priya Kessler): Priya heard something. Next: Underway, the pump fails. Last beat t400 (foreshadowed)\n",
    );
    expect(text).toMatch(
      /^- \[episode\] Plain \(Priya Kessler\): Priya heard something\. Next: Underway, the pump fails\. Last beat t400$/m,
    );
  });

  it("lists what the captain has seen, newest first, right after the notes (D31)", () => {
    const req = quietTooLongRequest(content());
    const base = {
      decisionId: null,
      speaker: null,
      leftLabel: "Take it",
      rightLabel: "Leave it",
      chosen: null,
      closedThread: null,
    };
    const notes = {
      ...EMPTY_NOTES,
      summary: "s",
      cardsShown: [
        {
          ...base,
          tick: 10,
          title: "Resupply",
          gist: "Mara wants more seals.",
          chosen: "right" as const,
        },
        {
          ...base,
          tick: 20,
          decisionId: "decision:2",
          title: "A stranger",
          speaker: "Mara Osei",
          gist: "Someone at the ramp.",
        },
        {
          ...base,
          tick: 30,
          title: "Fenwick's handoff",
          speaker: "Dane Whitcross",
          gist: "A clean run.",
          chosen: "left" as const,
          closedThread: "Fenwick's manifest",
        },
      ],
    };
    const { text } = buildDigest(req.snapshot, [], notes, content(), req.hook);
    const section = text.split("## What the captain has seen\n")[1]?.split("\n\n")[0];
    expect(section).toBe(
      [
        '- t30 "Fenwick\'s handoff" (Dane Whitcross): A clean run. → chose "Take it" (closed thread "Fenwick\'s manifest")',
        '- t20 "A stranger" (Mara Osei): Someone at the ramp. → unresolved',
        '- t10 "Resupply" (observed): Mara wants more seals. → chose "Leave it"',
      ].join("\n"),
    );
    expect(text.indexOf("## Your notes so far")).toBeLessThan(
      text.indexOf("## What the captain has seen"),
    );
  });

  it("trims the crew and events before what the captain has seen", () => {
    const req = quietTooLongRequest(content());
    const notes = {
      ...EMPTY_NOTES,
      cardsShown: Array.from({ length: 12 }, (_, i) => ({
        tick: i,
        decisionId: null,
        title: `Card ${i}`,
        speaker: null,
        gist: "g",
        leftLabel: "l",
        rightLabel: "r",
        chosen: null,
        closedThread: null,
      })),
    };
    const small = buildDigest(req.snapshot, manyEvents(20), notes, content(), req.hook, 1_500);
    expect(small.truncated).toBe(true);
    expect(small.text).toContain('- t11 "Card 11"');
    expect(small.text).toContain('- t0 "Card 0"');
    expect(small.text).not.toContain("## Crew");
    expect(small.text).not.toContain("## Recent events");
  });

  it("lists the people the captain knows at the port, without pay (D24, D25)", () => {
    const req = quietTooLongRequest(content());
    const notes = {
      ...EMPTY_NOTES,
      cast: [
        {
          name: "Ysolde Maren",
          note: "grower, owes us a favour",
          portId: "port.green_meridian",
          lastSeenTick: 1200,
        },
        {
          name: "Hamid Rask",
          note: "Hub dispatcher",
          portId: "port.crossroads_hub",
          lastSeenTick: 3,
        },
      ],
    };
    const { text } = buildDigest(req.snapshot, req.recentEvents, notes, content(), req.hook);
    const section = text.split("## People you know here (Green Meridian)\n")[1]?.split("\n\n")[0];
    const lines = section?.split("\n") ?? [];
    expect(lines[0]).toMatch(/^the place: /);
    expect(lines[1]).toBe("- Ysolde Maren: grower, owes us a favour; last seen at tick 1200");
    expect(section).not.toContain("Hamid Rask");
    expect(text).toContain("from Tobiah Rask (freight broker, Meridian Trading House)");
    expect(text).not.toContain("pays");
  });

  it("seeds the port's character and its locals into the people section without touching the cast (§2.4)", () => {
    const req = quietTooLongRequest(content());
    const port = content().ports["port.green_meridian" as never];
    if (port === undefined) throw new Error("fixture port");
    const [first, ...rest] = port.castSeed;
    if (first === undefined) throw new Error("port has no cast seed");
    // The model already wrote about one of the seeded locals: its own note wins.
    const notes = {
      ...EMPTY_NOTES,
      cast: [{ name: first.name, note: "owes us a favour", portId: port.id, lastSeenTick: 1200 }],
    };
    const { text } = buildDigest(req.snapshot, req.recentEvents, notes, content(), req.hook);
    const section = text.split("## People you know here (Green Meridian)\n")[1]?.split("\n\n")[0];
    expect(section).toContain(`the place: ${port.character}`);
    expect(section).toContain(`- ${first.name}: owes us a favour; last seen at tick 1200`);
    expect(section).not.toContain(`- ${first.name}, ${first.role}:`);
    expect(section).toContain("locals you have not met yet but may bring in");
    for (const seed of rest)
      expect(section).toContain(`- ${seed.name}, ${seed.role}: ${seed.note}`);
    // Seeds are read from content, never written into the notes the model gets back.
    expect(text.match(/^cast: /gm) ?? []).toHaveLength(1);
  });
});

describe("buildDigest: voyages (passengers-and-galaxy §2.3)", () => {
  const OSSORY = "port.ossory_station" as never;
  const DRIFT = "port.kessler_drift" as never;
  const HUB = "port.crossroads_hub" as never;

  it("says the ship is under way on a leg and bound for the voyage destination, with hops left", () => {
    const req = approachRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    const t = snapshot.state.travel;
    if (t.stage === "docked") throw new Error("fixture: expected a leg");
    snapshot.state.travel = { ...t, voyageDestinationId: OSSORY };
    const { text } = buildDigest(snapshot, [], EMPTY_NOTES, content(), req.hook);
    expect(text).toContain(
      `travel: approaching, under way Crossroads Hub -> Kessler Drift (port.kessler_drift), 100% of route, bound for Ossory Station (port.ossory_station); ${pathWords(DRIFT, OSSORY).hops} still to go from there`,
    );
  });

  it("says the ship is stopping at a waypoint on the way, and plain docked otherwise", () => {
    const req = approachRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    snapshot.state.travel = {
      stage: "docked",
      portId: DRIFT,
      plannedDestinationId: OSSORY,
      voyageDestinationId: OSSORY,
    };
    const stopping = buildDigest(snapshot, [], EMPTY_NOTES, content(), undefined).text;
    expect(stopping).toContain(
      `travel: stopping at Kessler Drift (port.kessler_drift) on the way to Ossory Station (port.ossory_station); ${pathWords(DRIFT, OSSORY).hops} still to go; next leg to Ossory Station; the ship continues on her own once nothing holds her here`,
    );
    snapshot.state.travel = { stage: "docked", portId: HUB, voyageDestinationId: OSSORY };
    expect(buildDigest(snapshot, [], EMPTY_NOTES, content(), undefined).text).toContain(
      `on the way to Ossory Station (port.ossory_station); ${pathWords(HUB, OSSORY).hops} still to go;`,
    );
    // At the destination the voyage is over: no "on the way" wording even if the field lingers.
    snapshot.state.travel = { stage: "docked", portId: OSSORY, voyageDestinationId: OSSORY };
    expect(buildDigest(snapshot, [], EMPTY_NOTES, content(), undefined).text).toContain(
      "travel: docked at Ossory Station (port.ossory_station)\n",
    );
  });

  it("marks a far job with its hops, transit and waypoints", () => {
    const req = quietTooLongRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    for (const job of Object.values(snapshot.state.jobs)) job.toPortId = OSSORY;
    const { text } = buildDigest(snapshot, [], EMPTY_NOTES, content(), req.hook);
    const far = pathWords(HUB, OSSORY);
    expect(text).toContain(
      `Crossroads Hub -> Ossory Station (${far.hops} via ${far.via}), 4x General Cargo Crate`,
    );
    const near = buildDigest(req.snapshot, [], EMPTY_NOTES, content(), req.hook).text;
    expect(near).toContain("Crossroads Hub -> Green Meridian, 4x General Cargo Crate");
  });
});

describe("buildDigest: passengers (passengers-and-galaxy §3.2, §3.3)", () => {
  const ABOARD = `- Aboard: ${FIXTURE_PASSENGER}, passenger, bound for Ossory Station and back to Crossroads Hub`;

  function digestOf(req: ReturnType<typeof passengerAboardRequest>) {
    return buildDigest(req.snapshot, req.recentEvents, EMPTY_NOTES, content(), req.hook).text;
  }

  it("lists a passenger aboard on an Aboard line after the crew: where to, whether back, where on deck now", () => {
    const req = passengerAboardRequest(content());
    const text = digestOf(req);
    const aboard = text.split("\n").find((l) => l.startsWith("- Aboard:"));
    expect(aboard).toContain(`${ABOARD}; now `);
    expect(aboard).toMatch(/now (idle|wandering|walking|eating|sleeping|resting)/);
    expect(aboard).toContain("Says: Passage to Ossory Station and home again.");
    // Not a crew line: no role tags, needs or voice; the crew count leaves her out.
    expect(text).toContain("## Crew (9)");
    expect(text).not.toMatch(new RegExp(`^- ${FIXTURE_PASSENGER}[ :\\[]`, "m"));
    expect(text).not.toContain("passengers/NPCs");
  });

  it("says the job is a round-trip passage on the Jobs line, with the leg and the luggage", () => {
    const req = passengerAboardRequest(content());
    const far = pathWords(HUB_PORT, "port.ossory_station");
    expect(digestOf(req)).toContain(
      `Crossroads Hub -> Ossory Station (${far.hops} via ${far.via}), round-trip passage (leg out), no luggage`,
    );
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    const job = Object.values(snapshot.state.jobs)[0];
    if (job?.passage === undefined) throw new Error("fixture: no passage");
    job.passage.roundTrip = false;
    job.cargo = [{ itemDefId: "item.crate_fragile" as never, count: 1 }];
    const oneWay = digestOf({ ...req, snapshot });
    expect(oneWay).toContain("one-way passage (leg out), luggage: 1x Fragile Cargo Crate");
    expect(oneWay).toContain(
      `- Aboard: ${FIXTURE_PASSENGER}, passenger, bound for Ossory Station, one way;`,
    );
  });

  function ended(
    reason: "leftBehind" | "putOff" | "completed",
    where: "ashore" | "onDeck",
  ): ReturnType<typeof passengerAboardRequest> {
    const req = passengerAboardRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    const job = Object.values(snapshot.state.jobs)[0];
    const passenger = Object.values(snapshot.state.actors).find((a) => a.passenger === true);
    if (job?.passage === undefined || passenger === undefined) throw new Error("fixture");
    job.passage.endReason = reason;
    snapshot.state.travel = { stage: "docked", portId: "port.ossory_station" as PortDefId };
    if (where === "ashore") {
      passenger.availability = "offShip";
      passenger.location = {
        kind: "inExternalStore",
        portId: "port.ossory_station" as PortDefId,
        storeKey: "lounge" as never,
      };
    }
    return { ...req, snapshot };
  }

  it.each(["leftBehind", "putOff"] as const)(
    "a passenger %s at a port is no longer Aboard and is listed under the people at that port",
    (reason) => {
      const text = digestOf(ended(reason, "ashore"));
      expect(text).not.toContain("- Aboard:");
      expect(text).toContain("## Crew (9)");
      const section = text.split("## People you know here (Ossory Station)\n")[1]?.split("\n\n")[0];
      const how = reason === "putOff" ? "put off the ship" : "left behind";
      expect(section).toContain(
        `- ${FIXTURE_PASSENGER}: passenger ${how} here, off ship (was bound for Ossory Station and back to Crossroads Hub); yours to use. Said: Passage to Ossory Station and home again.`,
      );
      // The cast slot is the model's: a cast entry by the same name wins over the kernel's line.
      const notes = {
        ...EMPTY_NOTES,
        cast: [
          {
            name: FIXTURE_PASSENGER,
            note: "stranded, furious",
            portId: "port.ossory_station",
            lastSeenTick: 5,
          },
        ],
      };
      const req = ended(reason, "ashore");
      const withCast = buildDigest(req.snapshot, req.recentEvents, notes, content(), req.hook).text;
      expect(withCast).toContain(`- ${FIXTURE_PASSENGER}: stranded, furious; last seen at tick 5`);
      expect(withCast).not.toContain(`passenger ${how} here`);
    },
  );

  it("a passenger put off while still on deck is Aboard until the next docking, and says so", () => {
    const text = digestOf(ended("putOff", "onDeck"));
    expect(text).toMatch(
      new RegExp(
        `^- Aboard: ${FIXTURE_PASSENGER}, passenger, put off: leaves the ship at the next docking; now .+\\.$`,
        "m",
      ),
    );
    expect(text).not.toContain("bound for Ossory Station");
  });

  it("a passenger mid-passage ashore at the far port is Aboard (ashore), not one of the people there", () => {
    const req = passengerOverdueRequest(content());
    const text = digestOf(req);
    expect(text).toContain(`${ABOARD}; ashore at Ossory Station`);
    expect(text).not.toContain("passenger left behind here");
  });

  it("says 'going down the ramp' while the passenger is disembarking", () => {
    const req = passengerAboardRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    const passenger = Object.values(snapshot.state.actors).find((a) => a.passenger === true);
    if (passenger === undefined) throw new Error("fixture: no passenger");
    passenger.disembarking = true;
    expect(digestOf({ ...req, snapshot })).toContain(`${ABOARD}; now going down the ramp.`);
  });

  it("while ashore says where, when they are due back, and OVERDUE once the overdue window has passed", () => {
    const req = passengerOverdueRequest(content());
    const overdue = digestOf(req);
    const job = Object.values(req.snapshot.state.jobs)[0];
    const since = job?.passage?.ashoreSinceTick;
    const dueAt = job?.passage?.returnsAtTick;
    if (since === undefined || dueAt === undefined) throw new Error("fixture: not ashore");
    const config = req.snapshot.config;
    const overdueAt = since + dayTicks(config, config.commerce.passage.overdueDays);
    expect(overdue).toContain(
      `${ABOARD}; ashore at Ossory Station, back at about ${Math.round(dueAt / config.time.tickRate)}s (tick ${dueAt}); OVERDUE (expected by tick ${overdueAt}).`,
    );
    expect(overdue).toContain("round-trip passage (leg ashore), no luggage");
    // Earlier in the stay, not overdue yet.
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    snapshot.state.tick = overdueAt - 1;
    const early = digestOf({ ...req, snapshot });
    expect(early).toContain("ashore at Ossory Station, back at about");
    expect(early).not.toContain("OVERDUE");
  });

  it("the overdue policy hook names the first officer and shows the templated card with both sides (D37)", () => {
    const req = passengerOverdueRequest(content());
    const text = digestOf(req);
    const firstOfficer = Object.values(req.snapshot.state.actors).find(
      (a) => a.passenger !== true && a.roleTags.includes("firstOfficer"),
    );
    if (firstOfficer === undefined) throw new Error("fixture: no first officer");
    expect(text).toContain(
      `policyDecision: decision ${req.hook.kind === "policyDecision" ? req.hook.context.decisionId : "?"} needs the captain; ${firstOfficer.name} brings it: write the card in their voice`,
    );
    expect(text).toContain(`(brought by ${firstOfficer.name})`);
    expect(text).toContain(
      `${FIXTURE_PASSENGER} went ashore at Ossory Station and hasn't come back when they said they would.`,
    );
    expect(text).toContain('Left: "Wait for them". Right: "Leave without them".');
    expect(text).not.toContain("commerce.passengerOverdue {");
  });

  it("a notableEvent hook for passengerReturned reads as 'is back aboard'", () => {
    const base = passengerAboardRequest(content());
    const snapshot = structuredClone(base.snapshot) as SaveEnvelope;
    const job = Object.values(snapshot.state.jobs)[0];
    if (job?.passage === undefined) throw new Error("fixture: no passage");
    job.passage.leg = "back";
    const returned: SimEvent = {
      id: "evt9" as EventId,
      tick: 8_000,
      seq: 0,
      type: "passengerReturned",
      subjectIds: [],
      causeIds: [],
      source: "sim",
      significance: "narrative",
      payload: { jobId: job.id, actorId: job.passage.actorId, name: FIXTURE_PASSENGER },
    } as unknown as SimEvent;
    const hook = {
      id: base.hook.id,
      kind: "notableEvent" as const,
      context: { eventIds: [returned.id] },
      tick: 8_001,
    };
    const text = buildDigest(
      snapshot,
      [...base.recentEvents, returned],
      EMPTY_NOTES,
      content(),
      hook,
    ).text;
    expect(text).toContain(`notableEvent: events evt9: ${FIXTURE_PASSENGER} is back aboard`);
    expect(text).toContain(`${FIXTURE_PASSENGER}, passenger, on the way home to Crossroads Hub;`);
  });
});
