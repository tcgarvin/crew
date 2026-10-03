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
import {
  approachingPortRequest,
  farJobBoardRequest,
  passengerAboardRequest,
  quietTooLongRequest,
} from "./fixtures";
import { fareFor, pathBetween, payFor, routeDistance } from "./lookups";
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
  passenger: false,
  roundTrip: false,
};

const decision = {
  kind: "surfaceDecision",
  title: "A request at the ramp",
  speaker: "Oren Vale",
  situation: "A dock foreman asks whether we could run a sealed crate to the Hub on our way.",
  left: { label: "Head for the Hub", effect: "setCourse", coursePort: "port.crossroads_hub" },
  right: { label: "Not our business", effect: "none", coursePort: "" },
  leftAftermath: "We set course for the Hub with the crate aboard.",
  rightAftermath: "The foreman nods and goes looking for another ship.",
  beatOfThread: "",
  closesThread: "",
};

/** D39: a foreshadowing card; both sides are the captain's attitude. */
const beatCard = {
  kind: "surfaceDecision",
  title: "A blip on the board",
  speaker: "Dane Whitcross",
  situation:
    "Dane stops by the hatch, tablet in hand. “Captain. The aft sensor picked up something on the last sweep. Gone now. I have logged it.”",
  left: { label: "Keep an eye on it.", effect: "none", coursePort: "" },
  right: { label: "Probably nothing.", effect: "none", coursePort: "" },
  leftAftermath: "Dane nods and adds it to his watch list.",
  rightAftermath: "Dane files it and goes back to his rounds.",
  beatOfThread: "the aft sensor",
  closesThread: "",
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

describe("translateIntents: far ports (passengers-and-galaxy §2.3)", () => {
  const OSSORY = "port.ossory_station";
  const HUB = "port.crossroads_hub";

  it("accepts an offerJob to a port two hops away and prices it over the path distance", () => {
    const req = docked(approachingPortRequest(content()), HUB);
    const far = { ...job, fromPort: HUB, toPort: OSSORY, payTier: "standard" };
    const result = translateIntents(plan([far]), ctxOf(req));
    expect(result.dropped).toEqual([]);
    const command = result.commands[0];
    if (command?.kind !== "offerJob") throw new Error("no offer");
    const draft = command.payload.job;
    expect(draft.toPortId).toBe(OSSORY);
    expect(routeDistance(content(), HUB, OSSORY)).toBeUndefined();
    const path = pathBetween(content(), HUB, OSSORY);
    expect(path).toMatchObject({ hops: 2, distance: 145 });
    const expected = payFor(req.snapshot.config, "hazardous", 145, 3, "standard");
    expect(draft.pay).toBe(expected.pay);
    // Direct-route pricing would be a different (lower) number.
    expect(draft.pay).not.toBe(payFor(req.snapshot.config, "hazardous", 25, 3, "standard").pay);
  });

  it("still drops an offerJob to a port no chain of legs reaches", () => {
    const bundle = content();
    const ossory = bundle.ports[OSSORY as PortDefId];
    const drift = bundle.ports["port.kessler_drift" as PortDefId];
    if (ossory === undefined || drift === undefined) throw new Error("fixture ports");
    const cut = {
      ...bundle,
      ports: {
        ...bundle.ports,
        [OSSORY]: { ...ossory, routes: [] },
        "port.kessler_drift": {
          ...drift,
          routes: drift.routes.filter((r) => r.toPortId !== OSSORY),
        },
      },
    };
    const req = docked(approachingPortRequest(content()), HUB);
    const far = { ...job, fromPort: HUB, toPort: OSSORY };
    const result = translateIntents(plan([far]), { ...ctxOf(req), content: cut });
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toBe(
      "offerJob: no route from port.crossroads_hub to port.ossory_station",
    );
  });

  it("accepts a setCourse side to a port two hops away", () => {
    const req = docked(approachingPortRequest(content()), HUB);
    const card = {
      ...decision,
      left: { label: "Make for Ossory", effect: "setCourse", coursePort: OSSORY },
    };
    const result = translateIntents(plan([card]), ctxOf(req));
    expect(result.dropped).toEqual([]);
    const command = result.commands[0];
    if (command?.kind !== "surfaceDecision") throw new Error("no card");
    expect(command.payload.card.left.commands).toEqual([
      { kind: "setCourse", payload: { destinationPortId: OSSORY } },
    ]);
  });
});

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
      issuerOrg: "",
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

  it("stockMarket → the port's content price times the tier, count clamped, any item (D47)", () => {
    const req = approachingPortRequest(content());
    const config = req.snapshot.config;
    const result = translateIntents(
      plan([
        {
          kind: "stockMarket",
          port: "port.green_meridian",
          cargoItem: "item.spare_parts_stack",
          count: "3",
          priceTier: "dear",
        },
        {
          kind: "stockMarket",
          port: "port.kessler_drift",
          cargoItem: "item.toolkit",
          count: "0",
          priceTier: "cheap",
        },
      ]),
      ctxOf(req),
    );
    expect(result.dropped).toEqual([]);
    const meridianParts = content().ports["port.green_meridian" as PortDefId]?.market.find(
      (l) => l.itemDefId === "item.spare_parts_stack",
    );
    if (meridianParts === undefined) throw new Error("content lost Green Meridian's parts line");
    expect(result.commands[0]).toMatchObject({
      kind: "stockMarket",
      source: "narrator",
      payload: {
        portId: "port.green_meridian",
        itemDefId: "item.spare_parts_stack",
        count: 3,
        price: Math.round(meridianParts.price * config.commerce.market.priceTiers.dear),
      },
    });
    // A toolkit is sold nowhere in content, so the config default price applies, times "cheap".
    expect(result.commands[1]).toMatchObject({
      kind: "stockMarket",
      payload: {
        portId: "port.kessler_drift",
        itemDefId: "item.toolkit",
        count: 0,
        price: Math.round(
          config.commerce.market.defaultPrice * config.commerce.market.priceTiers.cheap,
        ),
      },
    });
  });

  it("drops a stockMarket with an unknown port or item, with a pointer to What you can do", () => {
    const req = approachingPortRequest(content());
    const result = translateIntents(
      plan([
        {
          kind: "stockMarket",
          port: "port.nowhere",
          cargoItem: "item.spare_parts_stack",
          count: "1",
          priceTier: "fair",
        },
        {
          kind: "stockMarket",
          port: "port.crossroads_hub",
          cargoItem: "item.unobtainium",
          count: "1",
          priceTier: "fair",
        },
        {
          kind: "stockMarket",
          port: "port.crossroads_hub",
          cargoItem: "item.spare_parts_stack",
          count: "9",
          priceTier: "fair",
        },
      ]),
      ctxOf(req),
    );
    expect(result.commands).toEqual([]);
    expect(result.dropped.map((d) => d.kind)).toEqual([
      "stockMarket",
      "stockMarket",
      "stockMarket",
    ]);
    expect(result.dropped[0]?.reason).toContain("What you can do");
    expect(result.dropped[1]?.reason).toContain("What you can do");
    expect(result.dropped[2]?.reason).toContain("stockMarket: invalid");
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

  it("puts a closing card's thread on the card and reports it (D56)", () => {
    const req = docked(approachingPortRequest(content()));
    const closing = { ...decision, closesThread: "the aft sensor" };
    const result = translateIntents(plan([closing]), { ...ctxOf(req), threads: [sensorThread] });
    expect(result.dropped).toEqual([]);
    expect(result.closedThread).toBe("The aft sensor");
    const command = result.commands[0];
    expect(command?.kind).toBe("surfaceDecision");
    if (command?.kind !== "surfaceDecision") return;
    expect(command.payload.card.prompt.params.closesThread).toBe("The aft sensor");
  });

  it("closes a thread whose title is not fit to show, without naming it (D56)", () => {
    const req = docked(approachingPortRequest(content()));
    const priced = { ...sensorThread, title: "The 200 credit favour" };
    const closing = { ...decision, closesThread: "The 200 credit favour" };
    const result = translateIntents(plan([closing]), { ...ctxOf(req), threads: [priced] });
    expect(result.dropped).toEqual([]);
    expect(result.closedThread).toBe("The 200 credit favour");
    const command = result.commands[0];
    if (command?.kind !== "surfaceDecision") throw new Error("expected a surfaced card");
    expect(command.payload.card.prompt.params.closesThread).toBe("");
  });

  it("drops a closing card for a thread that is not open in the stored notes (D56)", () => {
    const req = docked(approachingPortRequest(content()));
    const { lastBeatTick: _t, beatCardShown: _b, ...written } = sensorThread;
    // Written back by the model this call, but already retired from the stored notes.
    const rewritten = emptyPlan({
      intents: [{ ...decision, closesThread: "the aft sensor" }] as never,
      notes: { summary: "s", threads: [written], cast: [] },
    });
    const result = translateIntents(rewritten, { ...ctxOf(req), threads: [] });
    expect(result.commands).toEqual([]);
    expect(result.closedThread).toBeUndefined();
    expect(result.dropped[0]?.reason).toBe(
      'surfaceDecision: closesThread "the aft sensor" matches no open thread in your notes; it may already be closed',
    );
  });

  it("drops a card that both foreshadows and closes (D56)", () => {
    const req = quietTooLongRequest(content());
    const both = { ...beatCard, closesThread: "the aft sensor" };
    const result = translateIntents(plan([both]), { ...ctxOf(req), threads: [sensorThread] });
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toBe(
      "surfaceDecision: a card cannot both foreshadow a thread (beatOfThread) and close one (closesThread)",
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
      `scheduleFault: machine ${pump?.id} has no fault "electrical_short"; use a faultKey listed under it in What you can do`,
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
    const noChapel = { ...onDeck, store: "chapel" } as Record<string, unknown>;
    // biome-ignore lint/performance/noDelete: building a test intent without the key.
    delete noChapel.location;
    const result = translateIntents(plan([onDeck, noChapel]), ctxOf(req));
    expect(result.commands).toEqual([]);
    expect(result.dropped[1]?.reason).toBe(
      'spawnAtBoundary: port port.kessler_drift has no store "chapel"; use one listed under What you can do',
    );
  });

  it("drops every unknown id with a pointer to What you can do (D45)", () => {
    const req = docked(approachingPortRequest(content()));
    const pump = Object.values(req.snapshot.state.machines).find(
      (m) => m.defId === "machine.coolant_pump",
    );
    const spawn = {
      kind: "spawnAtBoundary",
      port: "port.kessler_drift",
      store: "warehouse",
      cargoItem: "item.crate_general",
      quantity: "one",
    };
    const result = translateIntents(
      plan([
        { ...job, fromPort: "port.nowhere" },
        { ...job, toPort: "port.nowhere" },
        { ...job, cargoItem: "item.unobtainium" },
        { ...spawn, port: "port.nowhere" },
        { ...spawn, store: "vault" },
        { ...spawn, cargoItem: "item.unobtainium" },
        { kind: "scheduleFault", machine: "m99", faultKey: "worn_bearing", window: "soon" },
        { kind: "scheduleFault", machine: pump?.id, faultKey: "gremlins", window: "soon" },
        {
          ...decision,
          left: { label: "Go", effect: "setCourse", coursePort: "port.nowhere" },
        },
      ]),
      ctxOf(req),
    );
    expect(result.commands).toEqual([]);
    const hint = "use one listed under What you can do";
    expect(result.dropped.map((d) => d.reason)).toEqual([
      `offerJob: fromPort: unknown port "port.nowhere"; ${hint}`,
      `offerJob: toPort: unknown port "port.nowhere"; ${hint}`,
      `offerJob: cargoItem: unknown item "item.unobtainium"; ${hint}`,
      `spawnAtBoundary: port: unknown port "port.nowhere"; ${hint}`,
      `spawnAtBoundary: port port.kessler_drift has no store "vault"; ${hint}`,
      `spawnAtBoundary: cargoItem: unknown item "item.unobtainium"; ${hint}`,
      `scheduleFault: machine: unknown machine "m99"; ${hint}`,
      `scheduleFault: machine ${pump?.id} has no fault "gremlins"; use a faultKey listed under it in What you can do`,
      `surfaceDecision: left: coursePort: unknown port "port.nowhere"; ${hint}`,
    ]);
  });

  it("drops a known item that is not cargo", () => {
    const req = approachingPortRequest(content());
    const tool = Object.values(content().items).find((i) => i.cargoClass === undefined);
    expect(tool).toBeDefined();
    const result = translateIntents(plan([{ ...job, cargoItem: tool?.id }]), ctxOf(req));
    expect(result.dropped[0]?.reason).toBe(`offerJob: cargoItem: ${tool?.id} is not a cargo item`);
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

  it("keeps a valid speaker and omits an empty or blank one (D29, D45)", () => {
    const req = docked(approachingPortRequest(content()));
    const speakerOf = (intent: unknown) => {
      const result = translateIntents(plan([intent]), ctxOf(req));
      expect(result.dropped).toEqual([]);
      const [command] = result.commands;
      if (command?.kind !== "surfaceDecision") throw new Error("expected a card");
      return command.payload.card.prompt.params;
    };
    expect(speakerOf(decision)).toEqual({ title: decision.title, speaker: "Oren Vale" });
    expect(speakerOf({ ...decision, speaker: "" })).toEqual({ title: decision.title });
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
      left: { label: "Stop and check", effect: "none", coursePort: "" },
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
      speaker: "",
      situation: "y",
      left: { label: "a", effect: "setMoney", coursePort: "" },
      right: { label: "b", effect: "none", coursePort: "" },
      leftAftermath: "",
      rightAftermath: "",
      beatOfThread: "",
      closesThread: "",
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

describe("translateIntents: passengers (passengers-and-galaxy §4.1, §4.2)", () => {
  const passage = {
    ...job,
    issuerName: "Halla Thorne",
    issuerRole: "assayer",
    issuerOrg: "",
    pitch: "I need to get to Ossory and back. I can pay, and I don't take up much room.",
    description: "Passage to Ossory Station and home again. She says she has a claim to sell.",
    fromPort: "port.crossroads_hub",
    toPort: "port.ossory_station",
    cargoItem: "",
    quantity: "several",
    payTier: "standard",
    surface: false,
    passenger: true,
    roundTrip: true,
  };
  const atHub = () => ctxOf(farJobBoardRequest(content()));

  it("passenger offer → a passage draft: passenger and roundTrip set, surface forced true, no luggage for an empty cargoItem", () => {
    const result = translateIntents(plan([passage]), atHub());
    expect(result.dropped).toEqual([]);
    const [command] = result.commands;
    if (command?.kind !== "offerJob") throw new Error("no offer");
    expect(command.payload.surface).toBe(true);
    expect(command.payload.job).toMatchObject({
      passenger: true,
      roundTrip: true,
      cargo: [],
      fromPortId: "port.crossroads_hub",
      toPortId: "port.ossory_station",
      issuer: { name: "Halla Thorne", role: "assayer" },
    });
  });

  it("prices a passage by the passenger band over path distance, doubled for a round trip", () => {
    const config = farJobBoardRequest(content()).snapshot.config;
    const path = pathBetween(content(), "port.crossroads_hub", "port.ossory_station");
    if (path === undefined) throw new Error("no path");
    expect(path.hops).toBe(2);
    const round = translateIntents(plan([passage]), atHub()).commands[0];
    const oneWay = translateIntents(plan([{ ...passage, roundTrip: false }]), atHub()).commands[0];
    if (round?.kind !== "offerJob" || oneWay?.kind !== "offerJob") throw new Error("no offer");
    expect(round.payload.job.pay).toBe(fareFor(config, path.distance, true, "standard").pay);
    expect(oneWay.payload.job.pay).toBe(fareFor(config, path.distance, false, "standard").pay);
    expect(round.payload.job.pay).toBe(oneWay.payload.job.pay * 2);
    const band = config.commerce.priceBands.passenger;
    expect(round.payload.job.pay).toBeGreaterThanOrEqual(Math.round(band.min * path.distance * 2));
    expect(round.payload.job.pay).toBeLessThanOrEqual(Math.round(band.max * path.distance * 2));
    expect(oneWay.payload.job.roundTrip).toBe(false);
  });

  it("takes cargoItem as one unit of luggage whatever the quantity tier, and luggage adds nothing to the fare", () => {
    const withBag = translateIntents(
      plan([{ ...passage, cargoItem: "item.crate_fragile", quantity: "several" }]),
      atHub(),
    );
    expect(withBag.dropped).toEqual([]);
    const [command] = withBag.commands;
    if (command?.kind !== "offerJob") throw new Error("no offer");
    expect(command.payload.job.cargo).toEqual([{ itemDefId: "item.crate_fragile", count: 1 }]);
    const noBag = translateIntents(plan([passage]), atHub()).commands[0];
    if (noBag?.kind !== "offerJob") throw new Error("no offer");
    expect(command.payload.job.pay).toBe(noBag.payload.job.pay);
  });

  it("still checks that luggage is a known cargo item", () => {
    const result = translateIntents(plan([{ ...passage, cargoItem: "item.unobtainium" }]), atHub());
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toContain(
      'offerJob: cargoItem: unknown item "item.unobtainium"',
    );
  });

  it("drops roundTrip without passenger with a reason, and leaves freight untouched", () => {
    const result = translateIntents(
      plan([
        { ...passage, passenger: false, roundTrip: true, cargoItem: "item.crate_general" },
        { ...passage, passenger: false, roundTrip: false, cargoItem: "item.crate_general" },
      ]),
      atHub(),
    );
    expect(result.dropped).toEqual([
      {
        intentIndex: 0,
        kind: "offerJob",
        reason: "offerJob: roundTrip needs passenger (freight has no return)",
      },
    ]);
    const [freight] = result.commands;
    if (freight?.kind !== "offerJob") throw new Error("no offer");
    expect(freight.payload.surface).toBe(false);
    expect(freight.payload.job.passenger).toBeUndefined();
    expect(freight.payload.job.roundTrip).toBeUndefined();
    expect(freight.payload.job.cargo).toEqual([{ itemDefId: "item.crate_general", count: 6 }]);
  });

  it("a passenger offer counts as the call's one card, so a second surfaced card is dropped", () => {
    const result = translateIntents(plan([passage, decision]), atHub());
    expect(result.commands.map((c) => c.kind)).toEqual(["offerJob"]);
    expect(result.dropped[0]?.reason).toBe("surfaceDecision: only one card per call");
  });

  it("a passenger offer after the call's card is dropped with its own reason, never posted quietly", () => {
    const card = { ...decision, left: { label: "Fine by me", effect: "none", coursePort: "" } };
    const result = translateIntents(plan([card, passage]), atHub());
    expect(result.commands.map((c) => c.kind)).toEqual(["surfaceDecision"]);
    expect(result.dropped).toEqual([
      {
        intentIndex: 1,
        kind: "offerJob",
        reason: "offerJob: a passenger offer must be surfaced and this call's card is taken",
      },
    ]);
    // Freight in the same spot keeps the generic reason (it could have gone to the board).
    const freight = translateIntents(
      plan([card, { ...job, fromPort: "port.crossroads_hub", toPort: "port.kessler_drift" }]),
      atHub(),
    );
    expect(freight.dropped[0]?.reason).toBe("offerJob: only one card per call");
  });

  describe("one job at a time (D16, D50)", () => {
    function withJobStatus(status: string): { ctx: TranslationCtx; jobId: string } {
      const req = docked(passengerAboardRequest(content()), "port.kessler_drift");
      const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
      const held = Object.values(snapshot.state.jobs)[0];
      if (held === undefined) throw new Error("fixture: no job");
      held.status = status as never;
      return { ctx: ctxOf({ ...req, snapshot }), jobId: held.id };
    }

    it.each(["accepted", "inTransit", "delivered"])(
      "drops any offerJob while a job is %s, naming the job in hand",
      (status) => {
        const { ctx, jobId } = withJobStatus(status);
        const result = translateIntents(
          plan([job, { ...passage, fromPort: "port.kessler_drift" }]),
          ctx,
        );
        expect(result.commands).toEqual([]);
        expect(result.dropped.map((d) => d.reason)).toEqual([
          `offerJob: a job is already in hand: ${jobId} to Ossory Station`,
          `offerJob: a job is already in hand: ${jobId} to Ossory Station`,
        ]);
      },
    );

    it.each(["paid", "declined", "expired", "failed", "offered"])(
      "a job that is %s is not in hand, so an offer goes through",
      (status) => {
        const { ctx } = withJobStatus(status);
        const result = translateIntents(plan([job]), ctx);
        expect(result.dropped).toEqual([]);
        expect(result.commands.map((c) => c.kind)).toEqual(["offerJob"]);
      },
    );
  });

  const putOff = {
    ...decision,
    title: "About our passenger",
    speaker: "Dane Whitcross",
    situation:
      "Dane finds the captain by the galley hatch. “She's been in the hold twice tonight, Captain. Nothing missing that I can see. I'd put her off at the Drift and be done.”",
    left: { label: "Put her off at the Drift.", effect: "endPassage", coursePort: "" },
    right: { label: "She stays.", effect: "none", coursePort: "" },
    leftAftermath: "Dane nods; she goes down the ramp at the next port.",
    rightAftermath: "Dane says nothing more about it, for now.",
  };

  it("endPassage side → the kernel's endPassage for the live passage, as a player command", () => {
    const req = passengerAboardRequest(content());
    const result = translateIntents(plan([putOff]), ctxOf(req));
    expect(result.dropped).toEqual([]);
    const [command] = result.commands;
    if (command?.kind !== "surfaceDecision") throw new Error("no card");
    const jobId = Object.keys(req.snapshot.state.jobs)[0];
    expect(command.payload.card.left.commands).toEqual([
      { kind: "endPassage", payload: { jobId } },
    ]);
    expect(command.payload.card.right.commands).toEqual([]);
    expect((AUTHORITY.player as readonly CommandKind[]).includes("endPassage")).toBe(true);
  });

  it("drops an endPassage side when no passage is live: none at all, or one already ended", () => {
    const none = translateIntents(plan([putOff]), ctxOf(approachingPortRequest(content())));
    expect(none.commands).toEqual([]);
    expect(none.dropped[0]?.reason).toBe(
      "surfaceDecision: left: endPassage needs a passenger aboard or ashore on a live passage",
    );
    const req = passengerAboardRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    for (const j of Object.values(snapshot.state.jobs)) {
      if (j.passage !== undefined) j.passage.endReason = "putOff";
    }
    const ended = translateIntents(plan([putOff]), ctxOf({ ...req, snapshot }));
    expect(ended.commands).toEqual([]);
    expect(ended.dropped[0]?.reason).toContain("endPassage needs a passenger");
  });
});
