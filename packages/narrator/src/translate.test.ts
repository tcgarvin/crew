import {
  AUTHORITY,
  type CommandKind,
  NARRATOR_COMMAND_KINDS,
  type NarratorCommand,
  type PortDefId,
  type SaveEnvelope,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorPlan, NarratorRequest, TranslationCtx } from "./contract";
import { approachingPortRequest, quietTooLongRequest } from "./fixtures";
import { payFor, routeDistance } from "./lookups";
import { content, emptyPlan } from "./test-support";
import { translateIntents } from "./translate";

function ctxOf(req: NarratorRequest): TranslationCtx {
  return {
    snapshot: req.snapshot,
    content: content(),
    hookTick: req.hook.tick,
    callId: "call1",
    hook: req.hook,
  };
}

function docked(req: NarratorRequest, portId = "port.kessler_drift"): NarratorRequest {
  const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
  snapshot.state.travel = { stage: "docked", portId: portId as PortDefId };
  return { ...req, snapshot };
}

function plan(intents: unknown[]): NarratorPlan {
  return emptyPlan({ intents: intents as NarratorPlan["intents"] });
}

const job = {
  kind: "offerJob",
  issuerName: "Ysolde Maren",
  issuerRole: "Shift foreman",
  issuerOrg: "Kessler Drift Mining Guild",
  pitch: "The deep face ate our last set of bits. Get these to the Hub and I'll owe you one.",
  description: "Drill bits for the deep face, and quick about it.",
  fromPort: "port.kessler_drift",
  toPort: "port.crossroads_hub",
  cargoItem: "item.crate_hazardous",
  quantity: "few",
  payTier: "generous",
  urgency: "urgent",
  surface: true,
};

const decision = {
  kind: "surfaceDecision",
  title: "A request at the ramp",
  speaker: "Oren Vale",
  situation: "A dock foreman asks whether we could run a sealed crate to the Hub on our way.",
  left: { label: "Head for the Hub", effect: "setCourse", coursePort: "port.crossroads_hub" },
  right: { label: "Not our business", effect: "none", coursePort: null },
  leftAftermath: "We set course for the Hub with the crate aboard.",
  rightAftermath: "The foreman nods and goes looking for another ship.",
  beatOfThread: null,
};

/** D39: a foreshadowing card; both sides are the captain's attitude. */
const beatCard = {
  kind: "surfaceDecision",
  title: "A blip on the board",
  speaker: "Dane Whitcross",
  situation:
    "Dane stops by the hatch, tablet in hand. “Captain. The aft sensor picked up something on the last sweep. Gone now. I have logged it.”",
  left: { label: "Keep an eye on it.", effect: "none", coursePort: null },
  right: { label: "Probably nothing.", effect: "none", coursePort: null },
  leftAftermath: "Dane nods and adds it to his watch list.",
  rightAftermath: "Dane files it and goes back to his rounds.",
  beatOfThread: "the aft sensor",
};

const sensorThread = {
  title: "The aft sensor",
  scale: "episode" as const,
  people: ["Dane Whitcross"],
  stage: "Something showed on a sweep.",
  nextBeat: "Underway, it shows again and does not go away.",
  lastBeatTick: null,
  beatCardShown: false,
};

function expectNarratorOnly(commands: readonly NarratorCommand[]): void {
  for (const command of commands) {
    expect(NARRATOR_COMMAND_KINDS).toContain(command.kind);
    expect(command.source).toBe("narrator");
  }
}

describe("translateIntents: valid intents", () => {
  it("offerJob → offerJob with pay inside the kernel price band", () => {
    const req = approachingPortRequest(content());
    const result = translateIntents(plan([job]), ctxOf(req));
    expect(result.dropped).toEqual([]);
    const [command] = result.commands;
    expect(command?.kind).toBe("offerJob");
    if (command?.kind !== "offerJob") return;
    expect(command.id).toBe("cmd:narrator:call1:0");
    expect(command.targetTick).toBe(req.hook.tick + 1);
    const draft = command.payload.job;
    expect(draft.cargo).toEqual([{ itemDefId: "item.crate_hazardous", count: 3 }]);
    expect(draft.description.prose).toBe(job.description);
    const distance = routeDistance(content(), draft.fromPortId, draft.toPortId) ?? 0;
    const band = req.snapshot.config.commerce.priceBands.hazardous;
    // Same formula as the kernel's `checkPriceBand` (systems/commerce/jobs.ts).
    expect(draft.pay).toBeGreaterThanOrEqual(Math.round(band.min * distance * 3));
    expect(draft.pay).toBeLessThanOrEqual(Math.round(band.max * distance * 3));
    expect(command.payload.surface).toBe(true);
    // D25: a person with a role, an organisation and a line of dialogue.
    expect(draft.issuer).toEqual({
      name: "Ysolde Maren",
      role: "shift foreman",
      org: "Kessler Drift Mining Guild",
    });
    expect(draft.pitch?.prose).toBe(job.pitch);
    expect(draft.urgency).toBe("urgent");
  });

  it("offerJob without an organisation leaves org out, and clips a long pitch", () => {
    const req = approachingPortRequest(content());
    const long = {
      ...job,
      issuerOrg: null,
      pitch: Array.from({ length: 50 }, () => "word").join(" "),
    };
    const [command] = translateIntents(plan([long]), ctxOf(req)).commands;
    if (command?.kind !== "offerJob") throw new Error("expected an offerJob");
    expect(command.payload.job.issuer).toEqual({ name: "Ysolde Maren", role: "shift foreman" });
    expect(command.payload.job.pitch?.prose?.split(" ")).toHaveLength(30);
  });

  it("drops an offer whose pitch talks pay (D24)", () => {
    const req = approachingPortRequest(content());
    const paid = {
      ...job,
      pitch: "Four hundred's too low. I'll make it 500 credits if you leave now.",
    };
    const result = translateIntents(plan([paid]), ctxOf(req));
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toBe(
      "offerJob: pitch: player-facing text states a numeric consequence",
    );
  });

  it("every pay tier lands inside the band for every class and route", () => {
    const config = approachingPortRequest(content()).snapshot.config;
    for (const port of Object.values(content().ports)) {
      for (const route of port.routes) {
        for (const cls of ["general", "fragile", "perishable", "hazardous"] as const) {
          for (const tier of ["low", "standard", "generous"] as const) {
            for (const units of [1, 3, 6]) {
              const { pay, min, max } = payFor(config, cls, route.distance, units, tier);
              expect(Number.isInteger(pay)).toBe(true);
              expect(pay).toBeGreaterThanOrEqual(min);
              expect(pay).toBeLessThanOrEqual(max);
            }
          }
        }
      }
    }
  });

  it("spawnAtBoundary → a port-store spawn of an existing item, never on deck (N4)", () => {
    const req = approachingPortRequest(content());
    const result = translateIntents(
      plan([
        {
          kind: "spawnAtBoundary",
          port: "port.kessler_drift",
          store: "warehouse",
          cargoItem: "item.crate_general",
          quantity: "several",
        },
      ]),
      ctxOf(req),
    );
    const [command] = result.commands;
    expect(command?.kind).toBe("spawnAtBoundary");
    if (command?.kind !== "spawnAtBoundary") return;
    expect(command.payload.location).toEqual({
      kind: "portStore",
      portId: "port.kessler_drift",
      storeKey: "warehouse",
    });
    expect(command.payload.defs).toEqual({ items: [], crew: [] });
    expect(command.payload.spawns).toEqual([
      { kind: "item", tempRef: "$spawn0", itemDefId: "item.crate_general", count: 3 },
    ]);
  });

  it("scheduleFault → a window within config bounds", () => {
    const req = quietTooLongRequest(content());
    const generator = Object.values(req.snapshot.state.machines).find(
      (m) => m.defId === "machine.generator",
    );
    const result = translateIntents(
      plan([
        {
          kind: "scheduleFault",
          machine: generator?.id,
          faultKey: "electrical_short",
          window: "later",
        },
      ]),
      ctxOf(req),
    );
    const [command] = result.commands;
    expect(command?.kind).toBe("scheduleFault");
    if (command?.kind !== "scheduleFault") return;
    const [earliest, latest] = command.payload.windowTicks;
    const { tickRate } = req.snapshot.config.time;
    expect(earliest).toBeGreaterThanOrEqual(0);
    expect(latest - earliest).toBeLessThanOrEqual(
      req.snapshot.config.narrator.maxFaultWindowSeconds * tickRate,
    );
  });

  it("surfaceDecision → a card whose options are player commands", () => {
    const req = docked(approachingPortRequest(content()));
    const result = translateIntents(plan([decision]), ctxOf(req));
    expect(result.dropped).toEqual([]);
    const [command] = result.commands;
    expect(command?.kind).toBe("surfaceDecision");
    if (command?.kind !== "surfaceDecision") return;
    const card = command.payload.card;
    expect(card.prompt.prose).toBe(decision.situation);
    expect(card.prompt.params).toEqual({ title: decision.title, speaker: "Oren Vale" });
    expect(card.left.commands).toEqual([
      { kind: "setCourse", payload: { destinationPortId: "port.crossroads_hub" } },
    ]);
    expect(card.right.commands).toEqual([]);
    // D26: aftermaths travel on the card sides and land on the Decision options.
    expect(card.left.aftermath?.prose).toBe(decision.leftAftermath);
    expect(card.right.aftermath?.prose).toBe(decision.rightAftermath);
    for (const option of [card.left, card.right]) {
      for (const draft of option.commands) {
        expect(AUTHORITY.player as readonly CommandKind[]).toContain(draft.kind);
      }
    }
  });
});

describe("translateIntents: beat cards (D39)", () => {
  it("accepts a beat card naming a stored thread, matched case-insensitively", () => {
    const req = quietTooLongRequest(content());
    const result = translateIntents(plan([beatCard]), { ...ctxOf(req), threads: [sensorThread] });
    expect(result.dropped).toEqual([]);
    expect(result.commands.map((c) => c.kind)).toEqual(["surfaceDecision"]);
    expect(result.beatCardThread).toBe("The aft sensor");
  });

  it("accepts a beat card for a thread the plan's notes start this call", () => {
    const req = quietTooLongRequest(content());
    const { lastBeatTick: _t, beatCardShown: _b, ...written } = sensorThread;
    const withThread = emptyPlan({
      intents: [beatCard] as never,
      notes: { summary: "s", threads: [written], cast: [] },
    });
    const result = translateIntents(withThread, ctxOf(req));
    expect(result.dropped).toEqual([]);
    expect(result.beatCardThread).toBe("The aft sensor");
  });

  it("drops a beat card whose thread matches none in the notes", () => {
    const req = quietTooLongRequest(content());
    const result = translateIntents(plan([beatCard]), { ...ctxOf(req), threads: [] });
    expect(result.commands).toEqual([]);
    expect(result.beatCardThread).toBeUndefined();
    expect(result.dropped[0]?.reason).toBe(
      'surfaceDecision: beatOfThread "the aft sensor" matches no thread in your notes; name one exactly',
    );
  });

  it("drops a second beat card for a thread that already had one", () => {
    const req = quietTooLongRequest(content());
    const result = translateIntents(plan([beatCard]), {
      ...ctxOf(req),
      threads: [{ ...sensorThread, beatCardShown: true }],
    });
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toBe(
      'surfaceDecision: thread "The aft sensor" already had its beat card; its next card must pay it off (nextBeat)',
    );
  });

  it("drops a beat card with a setCourse side", () => {
    const req = docked(quietTooLongRequest(content()));
    const steering = {
      ...beatCard,
      left: { label: "Head for the Hub", effect: "setCourse", coursePort: "port.crossroads_hub" },
    };
    const result = translateIntents(plan([steering]), { ...ctxOf(req), threads: [sensorThread] });
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toBe(
      "surfaceDecision: a beat card's sides are the captain's attitude; both must be effect none",
    );
  });

  it("a normal card (beatOfThread null) attributes no beat", () => {
    const req = docked(approachingPortRequest(content()));
    const result = translateIntents(plan([decision]), { ...ctxOf(req), threads: [sensorThread] });
    expect(result.dropped).toEqual([]);
    expect(result.beatCardThread).toBeUndefined();
  });
});

describe("translateIntents: drops with reasons", () => {
  it("drops an offer from a port the ship is not at", () => {
    const req = approachingPortRequest(content());
    const result = translateIntents(
      plan([{ ...job, fromPort: "port.green_meridian", toPort: "port.crossroads_hub" }]),
      ctxOf(req),
    );
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toMatch(/fromPort must be port\.kessler_drift/);
  });

  it("drops an out-of-band price smuggled in as a raw number", () => {
    const req = approachingPortRequest(content());
    const result = translateIntents(plan([{ ...job, pay: 999_999 }]), ctxOf(req));
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.kind).toBe("offerJob");
  });

  it("drops an unknown fault key for the machine", () => {
    const req = quietTooLongRequest(content());
    const pump = Object.values(req.snapshot.state.machines).find(
      (m) => m.defId === "machine.coolant_pump",
    );
    const result = translateIntents(
      plan([
        { kind: "scheduleFault", machine: pump?.id, faultKey: "electrical_short", window: "soon" },
        { kind: "scheduleFault", machine: pump?.id, faultKey: "worn_bearing", window: "soon" },
      ]),
      ctxOf(req),
    );
    expect(result.commands).toEqual([]);
    expect(result.dropped.map((d) => d.reason)).toEqual([
      `scheduleFault: machine ${pump?.id} has no fault "electrical_short"`,
      `scheduleFault: ${pump?.id} already has or awaits "worn_bearing"`,
    ]);
  });

  it("drops an on-deck spawn location and a store the port does not have", () => {
    const req = approachingPortRequest(content());
    const onDeck = {
      kind: "spawnAtBoundary",
      port: "port.kessler_drift",
      store: "warehouse",
      cargoItem: "item.crate_general",
      quantity: "one",
      location: { kind: "onDeck", deckId: "deck.freighter_mk1", x: 3, y: 3 },
    };
    const noLounge = { ...onDeck, store: "lounge" } as Record<string, unknown>;
    // biome-ignore lint/performance/noDelete: building a test intent without the key.
    delete noLounge.location;
    const result = translateIntents(plan([onDeck, noLounge]), ctxOf(req));
    expect(result.commands).toEqual([]);
    expect(result.dropped[1]?.reason).toBe(
      'spawnAtBoundary: port port.kessler_drift has no store "lounge"',
    );
  });

  it("drops faults and spawns past the budget", () => {
    const req = quietTooLongRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    snapshot.state.narrator.budget = { spawnsRemaining: 0, faultsRemaining: 1 };
    const machines = Object.values(snapshot.state.machines);
    const gen = machines.find((m) => m.defId === "machine.generator")?.id;
    const engine = machines.find((m) => m.defId === "machine.engine")?.id;
    const result = translateIntents(
      plan([
        { kind: "scheduleFault", machine: gen, faultKey: "electrical_short", window: "soon" },
        { kind: "scheduleFault", machine: engine, faultKey: "failed_controller", window: "soon" },
        {
          kind: "spawnAtBoundary",
          port: "port.green_meridian",
          store: "lounge",
          cargoItem: "item.crate_general",
          quantity: "one",
        },
      ]),
      { ...ctxOf(req), snapshot },
    );
    expect(result.commands.map((c) => c.kind)).toEqual(["scheduleFault"]);
    expect(result.dropped.map((d) => d.reason)).toEqual([
      "scheduleFault: fault budget exhausted",
      "spawnAtBoundary: spawn budget exhausted",
    ]);
  });

  it("allows one card per call and none on a policy decision", () => {
    const req = docked(approachingPortRequest(content()));
    const two = translateIntents(plan([job, decision]), ctxOf(req));
    expect(two.commands.map((c) => c.kind)).toEqual(["offerJob"]);
    expect(two.dropped[0]?.reason).toBe("surfaceDecision: only one card per call");
  });

  it("drops a card whose aftermath states numbers, and omits a blank one (D26)", () => {
    const req = docked(approachingPortRequest(content()));
    const numeric = { ...decision, leftAftermath: "We lose 10% of the fuel getting there." };
    expect(translateIntents(plan([numeric]), ctxOf(req)).dropped[0]?.reason).toBe(
      "surfaceDecision: leftAftermath: player-facing text states a numeric consequence",
    );
    const blank = { ...decision, rightAftermath: "  " };
    const [command] = translateIntents(plan([blank]), ctxOf(req)).commands;
    if (command?.kind !== "surfaceDecision") throw new Error("expected a card");
    expect(command.payload.card.left.aftermath?.prose).toBe(decision.leftAftermath);
    expect(command.payload.card.right).not.toHaveProperty("aftermath");
  });

  it("keeps a valid speaker and omits a null or blank one (D29)", () => {
    const req = docked(approachingPortRequest(content()));
    const speakerOf = (intent: unknown) => {
      const result = translateIntents(plan([intent]), ctxOf(req));
      expect(result.dropped).toEqual([]);
      const [command] = result.commands;
      if (command?.kind !== "surfaceDecision") throw new Error("expected a card");
      return command.payload.card.prompt.params;
    };
    expect(speakerOf(decision)).toEqual({ title: decision.title, speaker: "Oren Vale" });
    expect(speakerOf({ ...decision, speaker: null })).toEqual({ title: decision.title });
    expect(speakerOf({ ...decision, speaker: "   " })).toEqual({ title: decision.title });
    const numeric = translateIntents(plan([{ ...decision, speaker: "Unit 7%" }]), ctxOf(req));
    expect(numeric.dropped[0]?.reason).toBe(
      "surfaceDecision: speaker: player-facing text states a numeric consequence",
    );
  });

  it("nulls a captain speaker, keeps the card and tells the model why (D41)", () => {
    const req = docked(approachingPortRequest(content()));
    for (const name of ["Mara Osei", "mara osei"]) {
      const result = translateIntents(plan([{ ...decision, speaker: name }]), ctxOf(req));
      expect(result.dropped).toEqual([]);
      expect(result.notes).toEqual([
        `speaker: "${name}" is the captain and cannot bring a card; name the crew member who does`,
      ]);
      const [command] = result.commands;
      if (command?.kind !== "surfaceDecision") throw new Error("expected a card");
      expect(command.payload.card.prompt.params).toEqual({ title: decision.title });
    }
    const other = translateIntents(plan([decision]), ctxOf(req));
    expect(other.notes).toEqual([]);
  });

  it("drops setCourse sides while not docked", () => {
    const req = approachingPortRequest(content());
    const result = translateIntents(plan([decision]), ctxOf(req));
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toMatch(/setCourse is only possible while docked/);
  });

  it("drops player-facing text that reveals an undiscovered fault (N1) or states numbers", () => {
    const req = quietTooLongRequest(content());
    const leak = {
      ...decision,
      situation: "Priya swears she hears a grinding noise from the pump. Stop and check?",
      left: { label: "Stop and check", effect: "none", coursePort: null },
    };
    const numbers = {
      ...leak,
      situation: "The crew want a bonus of 200 credits for the long haul.",
    };
    const result = translateIntents(plan([leak, numbers]), ctxOf(req));
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toContain('("grinding noise")');
    expect(result.dropped[1]?.reason).toContain("numeric consequence");
  });
});

describe("translateIntents: malicious plans (N6)", () => {
  const forbidden = [
    { kind: "setMoney", amount: 1_000_000 },
    { kind: "scenarioSpawn", spawns: [] },
    { kind: "scenarioInjectFault", machineId: "m3", faultKey: "worn_bearing" },
    { kind: "scenarioSetNeeds", actorId: "a1", needs: { hunger: 1 } },
    { kind: "resolveDecision", decisionId: "d1", side: "left" },
    { kind: "acknowledgeHook", hookId: "hook1" },
    { kind: "acceptContract", jobId: "job1" },
    { kind: "setCourse", destinationPortId: "port.green_meridian" },
    { kind: "__proto__" },
    { kind: 42 },
    null,
    "offerJob",
    [],
    { ...job, kind: "offerJob", source: "scenario" },
    { ...job, id: "cmd:player:1" },
    {
      kind: "surfaceDecision",
      title: "x",
      speaker: null,
      situation: "y",
      left: { label: "a", effect: "setMoney", coursePort: null },
      right: { label: "b", effect: "none", coursePort: null },
      leftAftermath: "",
      rightAftermath: "",
      beatOfThread: null,
    },
  ];

  it("never produces a command outside the narrator allow-list", () => {
    const req = docked(approachingPortRequest(content()));
    const result = translateIntents(plan(forbidden), ctxOf(req));
    expect(result.commands).toEqual([]);
    expect(result.dropped).toHaveLength(forbidden.length);
    for (const drop of result.dropped) expect(drop.reason.length).toBeGreaterThan(0);
  });

  it("survives random junk without emitting a forbidden kind", () => {
    const req = docked(approachingPortRequest(content()));
    const values = [...forbidden, job, decision, { ...job, surface: false }, undefined, {}];
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed;
    };
    for (let round = 0; round < 200; round += 1) {
      const intents = Array.from({ length: next() % 6 }, () => values[next() % values.length]);
      const result = translateIntents(plan(intents), ctxOf(req));
      expectNarratorOnly(result.commands);
      expect(result.commands.length + result.dropped.length).toBe(intents.length);
    }
  });

  it("the narrator's kernel authority is exactly the allow-list", () => {
    expect([...AUTHORITY.narrator].sort()).toEqual([...NARRATOR_COMMAND_KINDS].sort());
  });
});
