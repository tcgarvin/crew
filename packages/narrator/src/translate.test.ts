import {
  AUTHORITY,
  CALL_BACK_WHY_MAX,
  type CommandKind,
  NARRATOR_COMMAND_KINDS,
  type NarratorCommand,
  type PortDefId,
  type SaveEnvelope,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { CallBackPlan, NarratorPlan, NarratorRequest, TranslationCtx } from "./contract";
import {
  FIXTURE_PASSENGER,
  approachRequest,
  farCaptainAshoreRequest,
  passengerAboardRequest,
  quietTooLongRequest,
  requestedCallRequest,
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
  left: {
    label: "Head for the Hub",
    effect: "setCourse",
    coursePort: "port.crossroads_hub",
    talkWith: "",
    tone: "",
  },
  right: { label: "Not our business", effect: "none", coursePort: "", talkWith: "", tone: "" },
  leftAftermath: "We set course for the Hub with the crate aboard.",
  rightAftermath: "The foreman nods and goes looking for another ship.",
  beatOfThread: "",
  closesThread: "",
};

/** §beat-cards: a foreshadowing card; both sides are the captain's attitude. */
const beatCard = {
  kind: "surfaceDecision",
  title: "A blip on the board",
  speaker: "Dane Whitcross",
  situation:
    "Dane stops by the hatch, tablet in hand. “Captain. The aft sensor picked up something on the last sweep. Gone now. I have logged it.”",
  left: { label: "Keep an eye on it.", effect: "none", coursePort: "", talkWith: "", tone: "" },
  right: { label: "Probably nothing.", effect: "none", coursePort: "", talkWith: "", tone: "" },
  leftAftermath: "Dane nods and adds it to his watch list.",
  rightAftermath: "Dane files it and goes back to his rounds.",
  beatOfThread: "the aft sensor",
  closesThread: "",
};

const sensorThread = {
  title: "The aft sensor",
  scale: "episode" as const,
  people: ["Dane Whitcross"],
  arcNotes: "Something showed on a sweep.",
  nextBeat: "Underway, it shows again and does not go away.",
  openedTick: 0,
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
    const req = docked(approachRequest(content()), HUB);
    const far = { ...job, fromPort: HUB, toPort: OSSORY, payTier: "standard" };
    const result = translateIntents(plan([far]), ctxOf(req));
    expect(result.dropped).toEqual([]);
    const command = result.commands[0];
    if (command?.kind !== "offerJob") throw new Error("no offer");
    const draft = command.payload.job;
    expect(draft.toPortId).toBe(OSSORY);
    expect(routeDistance(content(), HUB, OSSORY)).toBeUndefined();
    const path = pathBetween(content(), HUB, OSSORY);
    if (path === undefined) throw new Error("no path");
    expect(path.hops).toBe(2);
    expect(path.distance).toBe(
      (routeDistance(content(), HUB, "port.kessler_drift") ?? 0) +
        (routeDistance(content(), "port.kessler_drift", OSSORY) ?? 0),
    );
    const expected = payFor(req.snapshot.config, "hazardous", path.distance, 3, "standard");
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
    const req = docked(approachRequest(content()), HUB);
    const far = { ...job, fromPort: HUB, toPort: OSSORY };
    const result = translateIntents(plan([far]), { ...ctxOf(req), content: cut });
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toBe(
      "offerJob: no route from port.crossroads_hub to port.ossory_station",
    );
  });

  it("accepts a setCourse side to a port two hops away", () => {
    const req = docked(approachRequest(content()), HUB);
    const card = {
      ...decision,
      left: {
        label: "Make for Ossory",
        effect: "setCourse",
        coursePort: OSSORY,
        talkWith: "",
        tone: "",
      },
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
    const req = docked(approachRequest(content()));
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
    // §issuers-and-pitches: a person with a role, an organisation and a line of dialogue.
    expect(draft.issuer).toEqual({
      name: "Ysolde Maren",
      role: "shift foreman",
      org: "Kessler Drift Mining Guild",
    });
    expect(draft.pitch?.prose).toBe(job.pitch);
    expect(draft.urgency).toBe("urgent");
  });

  it("offerJob without an organisation leaves org out, and clips a long pitch", () => {
    const req = docked(approachRequest(content()));
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

  it("drops an offer whose pitch talks pay (§cards-never-mention-pay)", () => {
    const req = docked(approachRequest(content()));
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
    const config = approachRequest(content()).snapshot.config;
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
    const req = approachRequest(content());
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

  it("stockMarket → the port's content price times the tier, count clamped, any item (§market-lever)", () => {
    const req = approachRequest(content());
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
    const req = approachRequest(content());
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
    const req = docked(approachRequest(content()));
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
    // §aftermath-caption: aftermaths travel on the card sides and land on the Decision options.
    expect(card.left.aftermath?.prose).toBe(decision.leftAftermath);
    expect(card.right.aftermath?.prose).toBe(decision.rightAftermath);
    for (const option of [card.left, card.right]) {
      for (const draft of option.commands) {
        expect(AUTHORITY.player as readonly CommandKind[]).toContain(draft.kind);
      }
    }
  });
});

describe("translateIntents: beat cards (§beat-cards)", () => {
  it("accepts a beat card naming a stored thread, matched case-insensitively", () => {
    const req = quietTooLongRequest(content());
    const result = translateIntents(plan([beatCard]), { ...ctxOf(req), threads: [sensorThread] });
    expect(result.dropped).toEqual([]);
    expect(result.commands.map((c) => c.kind)).toEqual(["surfaceDecision"]);
    expect(result.beatCardThread).toBe("The aft sensor");
  });

  it("accepts a beat card that names no stored thread as starting one, for the notes turn (§notes-turn)", () => {
    const req = quietTooLongRequest(content());
    const result = translateIntents(plan([beatCard]), { ...ctxOf(req), threads: [] });
    expect(result.dropped).toEqual([]);
    expect(result.commands.map((c) => c.kind)).toEqual(["surfaceDecision"]);
    expect(result.beatCardThread).toBe("the aft sensor");
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
      left: {
        label: "Head for the Hub",
        effect: "setCourse",
        coursePort: "port.crossroads_hub",
        talkWith: "",
        tone: "",
      },
    };
    const result = translateIntents(plan([steering]), { ...ctxOf(req), threads: [sensorThread] });
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toBe(
      "surfaceDecision: a beat card's sides are the captain's attitude; both must be effect none",
    );
  });

  it("puts a closing card's thread on the card and reports it (§closing-cards)", () => {
    const req = docked(approachRequest(content()));
    const closing = { ...decision, closesThread: "the aft sensor" };
    const result = translateIntents(plan([closing]), { ...ctxOf(req), threads: [sensorThread] });
    expect(result.dropped).toEqual([]);
    expect(result.closedThread).toBe("The aft sensor");
    const command = result.commands[0];
    expect(command?.kind).toBe("surfaceDecision");
    if (command?.kind !== "surfaceDecision") return;
    expect(command.payload.card.prompt.params.closesThread).toBe("The aft sensor");
  });

  it("closes a thread whose title is not fit to show, without naming it (§closing-cards)", () => {
    const req = docked(approachRequest(content()));
    const priced = { ...sensorThread, title: "The 200 credit favour" };
    const closing = { ...decision, closesThread: "The 200 credit favour" };
    const result = translateIntents(plan([closing]), { ...ctxOf(req), threads: [priced] });
    expect(result.dropped).toEqual([]);
    expect(result.closedThread).toBe("The 200 credit favour");
    const command = result.commands[0];
    if (command?.kind !== "surfaceDecision") throw new Error("expected a surfaced card");
    expect(command.payload.card.prompt.params.closesThread).toBe("");
  });

  it("puts up a closing card whose title matches no open thread, closing nothing (§closing-cards)", () => {
    const req = docked(approachRequest(content()));
    // The model named the offer's issuer, not the thread.
    const closing = { ...decision, closesThread: "Tilde Haugen, seed-bank archivist" };
    const result = translateIntents(plan([closing]), { ...ctxOf(req), threads: [sensorThread] });
    expect(result.dropped).toEqual([]);
    expect(result.closedThread).toBeUndefined();
    const command = result.commands[0];
    if (command?.kind !== "surfaceDecision") throw new Error("expected a surfaced card");
    expect(command.payload.card.prompt.params).not.toHaveProperty("closesThread");
    expect(result.notes).toEqual([
      'closesThread: "Tilde Haugen, seed-bank archivist" matches no title under "Open threads", so the card went up closing nothing; copy the title exactly',
    ]);
  });

  it("says nothing about an unmatched closesThread when the card is dropped anyway (§closing-cards)", () => {
    const req = docked(approachRequest(content()));
    const closing = { ...decision, closesThread: "Somebody's run", right: decision.left };
    const result = translateIntents(plan([closing]), { ...ctxOf(req), threads: [] });
    expect(result.dropped[0]?.reason).toBe("surfaceDecision: both sides have the same label");
    expect(result.notes).toEqual([]);
  });

  it("drops a closing card for a thread an earlier card already closed (§closing-cards)", () => {
    const req = docked(approachRequest(content()));
    const closing = { ...decision, closesThread: "the aft sensor" };
    const result = translateIntents(plan([closing]), {
      ...ctxOf(req),
      threads: [],
      closedThreads: ["The aft sensor"],
    });
    expect(result.commands).toEqual([]);
    expect(result.closedThread).toBeUndefined();
    expect(result.dropped[0]?.reason).toBe(
      'surfaceDecision: closesThread "the aft sensor" was already closed by an earlier card; a thread closes once',
    );
  });

  it("drops a card that both foreshadows and closes (§closing-cards)", () => {
    const req = quietTooLongRequest(content());
    const both = { ...beatCard, closesThread: "the aft sensor" };
    const result = translateIntents(plan([both]), { ...ctxOf(req), threads: [sensorThread] });
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toBe(
      "surfaceDecision: a card cannot both foreshadow a thread (beatOfThread) and close one (closesThread)",
    );
  });

  it("a normal card (beatOfThread null) attributes no beat", () => {
    const req = docked(approachRequest(content()));
    const result = translateIntents(plan([decision]), { ...ctxOf(req), threads: [sensorThread] });
    expect(result.dropped).toEqual([]);
    expect(result.beatCardThread).toBeUndefined();
  });
});

describe("translateIntents: drops with reasons", () => {
  it("drops an offer from a port the ship is not at", () => {
    const req = docked(approachRequest(content()));
    const result = translateIntents(
      plan([{ ...job, fromPort: "port.green_meridian", toPort: "port.crossroads_hub" }]),
      ctxOf(req),
    );
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toMatch(/fromPort must be port\.kessler_drift/);
  });

  it("drops an offer made in flight: offers are made in person at the dock (§offer-lever)", () => {
    const req = approachRequest(content());
    expect(req.snapshot.state.travel.stage).not.toBe("docked");
    const result = translateIntents(plan([job]), ctxOf(req));
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toBe(
      "offerJob: the ship is not docked; offers are made in person at the dock",
    );
  });

  it("drops an out-of-band price smuggled in as a raw number", () => {
    const req = docked(approachRequest(content()));
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
    const req = approachRequest(content());
    const onDeck = {
      kind: "spawnAtBoundary",
      port: "port.kessler_drift",
      store: "warehouse",
      cargoItem: "item.crate_general",
      quantity: "one",
      location: { kind: "onDeck", deckId: "deck.freighter_mk2", x: 3, y: 3 },
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

  it("drops every unknown id with a pointer to What you can do (§narrator-authority)", () => {
    const req = docked(approachRequest(content()));
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
          left: {
            label: "Go",
            effect: "setCourse",
            coursePort: "port.nowhere",
            talkWith: "",
            tone: "",
          },
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
    const req = docked(approachRequest(content()));
    const tool = Object.values(content().items).find((i) => i.cargoClass === undefined);
    expect(tool).toBeDefined();
    const result = translateIntents(plan([{ ...job, cargoItem: tool?.id }]), ctxOf(req));
    expect(result.dropped[0]?.reason).toBe(`offerJob: cargoItem: ${tool?.id} is not a cargo item`);
  });

  it("drops faults and spawns past the budget", () => {
    const req = quietTooLongRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    snapshot.state.narrator.budget = {
      spawnsRemaining: 0,
      faultsRemaining: 1,
      hazardsRemaining: 0,
    };
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
    const req = docked(approachRequest(content()));
    const two = translateIntents(plan([job, decision]), ctxOf(req));
    expect(two.commands.map((c) => c.kind)).toEqual(["offerJob"]);
    expect(two.dropped[0]?.reason).toBe("surfaceDecision: only one card per call");
  });

  it("drops a card whose aftermath states numbers, and omits a blank one (§aftermath-caption)", () => {
    const req = docked(approachRequest(content()));
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

  it("keeps a valid speaker and omits an empty or blank one (§spoken-cards, §narrator-authority)", () => {
    const req = docked(approachRequest(content()));
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

  it("nulls a captain speaker, keeps the card and tells the model why (§captain-never-speaks)", () => {
    const req = docked(approachRequest(content()));
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
    const req = approachRequest(content());
    const result = translateIntents(plan([decision]), ctxOf(req));
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toMatch(/setCourse is only possible while docked/);
  });

  it("drops player-facing text that reveals an undiscovered fault (N1) or states numbers", () => {
    const req = quietTooLongRequest(content());
    const leak = {
      ...decision,
      situation: "Priya swears she hears a grinding noise from the pump. Stop and check?",
      left: { label: "Stop and check", effect: "none", coursePort: "", talkWith: "", tone: "" },
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
      left: { label: "a", effect: "setMoney", coursePort: "", talkWith: "", tone: "" },
      right: { label: "b", effect: "none", coursePort: "", talkWith: "", tone: "" },
      leftAftermath: "",
      rightAftermath: "",
      beatOfThread: "",
      closesThread: "",
    },
  ];

  it("never produces a command outside the narrator allow-list", () => {
    const req = docked(approachRequest(content()));
    const result = translateIntents(plan(forbidden), ctxOf(req));
    expect(result.commands).toEqual([]);
    expect(result.dropped).toHaveLength(forbidden.length);
    for (const drop of result.dropped) expect(drop.reason.length).toBeGreaterThan(0);
  });

  it("survives random junk without emitting a forbidden kind", () => {
    const req = docked(approachRequest(content()));
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
  const atHub = () => ctxOf(farCaptainAshoreRequest(content()));

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
    const config = farCaptainAshoreRequest(content()).snapshot.config;
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
    const card = {
      ...decision,
      left: { label: "Fine by me", effect: "none", coursePort: "", talkWith: "", tone: "" },
    };
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

  describe("one job at a time (§one-job-in-hand, D50)", () => {
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

    it.each(["inTransit", "delivered"])(
      "freight %s at the port the ship is docked at does not drop an offer (the kernel's rule)",
      (status) => {
        const { ctx } = withJobStatus(status);
        const held = Object.values(ctx.snapshot.state.jobs)[0];
        if (held === undefined) throw new Error("fixture: no job");
        // Freight being unloaded here, not a passage: the kernel would accept the next job.
        // biome-ignore lint/performance/noDelete: a freight job has no passage key.
        delete (held as { passage?: unknown }).passage;
        (held as { toPortId: string }).toPortId = "port.kessler_drift";
        const result = translateIntents(plan([{ ...job, fromPort: "port.kessler_drift" }]), ctx);
        expect(result.dropped).toEqual([]);
        expect(result.commands.map((c) => c.kind)).toEqual(["offerJob"]);
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
    left: {
      label: "Put her off at the Drift.",
      effect: "endPassage",
      coursePort: "",
      talkWith: "",
      tone: "",
    },
    right: { label: "She stays.", effect: "none", coursePort: "", talkWith: "", tone: "" },
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
    const none = translateIntents(plan([putOff]), ctxOf(approachRequest(content())));
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

describe("translateIntents: a privateTalk side (§private-talk)", () => {
  const side = (talkWith: string, tone: string) => ({
    label: "My cabin. Now.",
    effect: "privateTalk",
    coursePort: "",
    talkWith,
    tone,
  });
  const talk = (talkWith: string, tone = "stern") => ({
    ...decision,
    title: "Words at the card table",
    speaker: "Dane Whitcross",
    situation:
      "Dane stops the captain in the corridor. “Jax and Tomas are at it again over the cards, Captain. Someone should have a word.”",
    left: side(talkWith, tone),
    right: { label: "Let them be.", effect: "none", coursePort: "", talkWith: "", tone: "" },
    leftAftermath: "Jax is told to come up to the captain's cabin.",
    rightAftermath: "Dane goes back to his station.",
  });

  function translated(req: NarratorRequest, intent: unknown) {
    return translateIntents(plan([intent]), ctxOf(req));
  }

  function actorId(req: NarratorRequest, name: string): string {
    const actor = Object.values(req.snapshot.state.actors).find((a) => a.name === name);
    if (actor === undefined) throw new Error(`fixture: no ${name}`);
    return actor.id;
  }

  it.each(["warm", "stern"] as const)(
    "a %s word with a crew member → privateTalk for them, as a player command",
    (tone) => {
      const req = quietTooLongRequest(content());
      const result = translated(req, talk("jax okonkwo", tone));
      expect(result.dropped).toEqual([]);
      const [command] = result.commands;
      if (command?.kind !== "surfaceDecision") throw new Error("no card");
      expect(command.payload.card.left.commands).toEqual([
        { kind: "privateTalk", payload: { actorId: actorId(req, "Jax Okonkwo"), tone } },
      ]);
      expect(command.payload.card.right.commands).toEqual([]);
      expect((AUTHORITY.player as readonly CommandKind[]).includes("privateTalk")).toBe(true);
    },
  );

  it("drops the card when the name is nobody aboard, or the tone or name is missing", () => {
    const req = quietTooLongRequest(content());
    expect(translated(req, talk("Oren Vale")).dropped[0]?.reason).toBe(
      'surfaceDecision: left: talkWith "Oren Vale" is nobody aboard; use a name listed under Crew',
    );
    expect(translated(req, talk("")).dropped[0]?.reason).toBe(
      "surfaceDecision: left: privateTalk needs talkWith (a crew member's name)",
    );
    expect(translated(req, talk("Jax Okonkwo", "")).dropped[0]?.reason).toBe(
      "surfaceDecision: left: privateTalk needs tone warm or stern",
    );
  });

  it("never calls in the captain, who does the calling", () => {
    const result = translated(quietTooLongRequest(content()), talk("Mara Osei"));
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toBe(
      "surfaceDecision: left: Mara Osei is the captain, who does the calling in",
    );
  });

  it("never calls in a passenger", () => {
    const result = translated(passengerAboardRequest(content()), talk(FIXTURE_PASSENGER));
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toBe(
      `surfaceDecision: left: ${FIXTURE_PASSENGER} is not crew; only crew are called in for a word`,
    );
  });

  it("never calls in someone ashore", () => {
    const req = quietTooLongRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    const jax = Object.values(snapshot.state.actors).find((a) => a.name === "Jax Okonkwo");
    if (jax === undefined) throw new Error("fixture: no Jax");
    jax.availability = "offShip";
    const result = translated({ ...req, snapshot }, talk("Jax Okonkwo"));
    expect(result.dropped[0]?.reason).toBe(
      "surfaceDecision: left: Jax Okonkwo is not aboard to be called in",
    );
  });

  it("drops the card while a talk is already pending", () => {
    const req = quietTooLongRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    snapshot.state.social.privateTalk = {
      captainId: actorId(req, "Mara Osei") as never,
      actorId: actorId(req, "Tomas Ruiz") as never,
      tone: "warm",
      requestedTick: snapshot.state.tick,
    };
    const result = translated({ ...req, snapshot }, talk("Jax Okonkwo"));
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toBe(
      "surfaceDecision: left: a private word is already pending; wait for it to be held or missed",
    );
  });

  it("is not a beat card's side: a beat card's sides are effect none", () => {
    const req = quietTooLongRequest(content());
    const notes = {
      ...emptyPlan().notes,
      threads: [
        {
          title: "Cards",
          scale: "beat" as const,
          people: ["Jax Okonkwo"],
          arcNotes: "Jax keeps winning",
          nextBeat: "Tomas says something",
        },
      ],
    };
    const result = translateIntents(
      emptyPlan({
        intents: [{ ...talk("Jax Okonkwo"), beatOfThread: "Cards" }] as NarratorPlan["intents"],
        notes,
      }),
      ctxOf(req),
    );
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toContain("both must be effect none");
  });
});

describe("translateIntents: scheduleHazard, the sixth lever (§hazard-and-field-levers)", () => {
  const hazard = {
    kind: "scheduleHazard",
    hazard: "debrisField",
    difficulty: "hard",
    window: "soon",
  };

  /** In transit with `secondsLeft` of the leg to run at nominal speed. */
  function inTransit(secondsLeft: number): NarratorRequest {
    const req = quietTooLongRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    const travel = snapshot.state.travel;
    if (travel.stage === "docked") throw new Error("fixture: expected the ship under way");
    const speed = snapshot.config.travel.nominalSpeed;
    snapshot.state.travel = {
      ...travel,
      routeDistance: 400,
      routeProgress: 400 - secondsLeft * speed,
    };
    return { ...req, snapshot };
  }

  function withBudget(req: NarratorRequest, hazardsRemaining: number): NarratorRequest {
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    snapshot.state.narrator.budget = { ...snapshot.state.narrator.budget, hazardsRemaining };
    return { ...req, snapshot };
  }

  it("translates the tier to config's difficulty and the window to the fault windows' ticks", () => {
    const req = withBudget(inTransit(200), 2);
    const result = translateIntents(plan([hazard]), ctxOf(req));
    expect(result.dropped).toEqual([]);
    const [command] = result.commands;
    expect(command?.kind).toBe("scheduleHazard");
    if (command?.kind !== "scheduleHazard") return;
    const config = req.snapshot.config;
    expect(command.source).toBe("narrator");
    expect(command.payload.kind).toBe("debrisField");
    expect(command.payload.difficulty).toBe(config.hazards.difficulty.hard);
    const [earliest, latest] = command.payload.windowTicks;
    const third = (config.narrator.maxFaultWindowSeconds / 3) * config.time.tickRate;
    expect(earliest).toBe(0);
    expect(latest).toBe(Math.round(third));
    expect(latest - earliest).toBeLessThanOrEqual(
      config.narrator.maxFaultWindowSeconds * config.time.tickRate,
    );
  });

  it("maps every tier and kind", () => {
    const config = quietTooLongRequest(content()).snapshot.config;
    for (const difficulty of ["easy", "hard", "brutal"] as const) {
      for (const kind of ["debrisField", "ionStorm"]) {
        const req = withBudget(inTransit(200), 2);
        const result = translateIntents(
          plan([{ ...hazard, hazard: kind, difficulty }]),
          ctxOf(req),
        );
        const [command] = result.commands;
        if (command?.kind !== "scheduleHazard") throw new Error(`no hazard for ${kind}`);
        expect(command.payload).toMatchObject({
          kind,
          difficulty: config.hazards.difficulty[difficulty],
        });
      }
    }
  });

  it("drops a window that opens after this leg's transit ends, and keeps soon", () => {
    const req = withBudget(inTransit(10), 2);
    const later = translateIntents(plan([{ ...hazard, window: "later" }]), ctxOf(req));
    expect(later.commands).toEqual([]);
    expect(later.dropped[0]?.reason).toBe(
      "scheduleHazard: window later opens after this leg's transit ends (~10s left); use soon, or place it on the next leg",
    );
    const soon = translateIntents(plan([hazard]), ctxOf(req));
    expect(soon.commands.map((c) => c.kind)).toEqual(["scheduleHazard"]);
  });

  it("drops one while docked with no course, and accepts one once a course is set", () => {
    const bare = withBudget(docked(approachRequest(content())), 2);
    const none = translateIntents(plan([{ ...hazard, window: "muchLater" }]), ctxOf(bare));
    expect(none.commands).toEqual([]);
    expect(none.dropped[0]?.reason).toBe(
      "scheduleHazard: the ship is docked with no course set; a hazard needs a leg to lie on",
    );
    const snapshot = structuredClone(bare.snapshot) as SaveEnvelope;
    snapshot.state.travel = {
      stage: "docked",
      portId: "port.kessler_drift" as PortDefId,
      plannedDestinationId: "port.ossory_station" as PortDefId,
    };
    const set = translateIntents(plan([{ ...hazard, window: "muchLater" }]), {
      ...ctxOf(bare),
      snapshot,
    });
    expect(set.dropped).toEqual([]);
    expect(set.commands.map((c) => c.kind)).toEqual(["scheduleHazard"]);
  });

  it("drops one on approach: this leg's transit is over", () => {
    const req = withBudget(approachRequest(content()), 2);
    expect(req.snapshot.state.travel.stage).toBe("approaching");
    const result = translateIntents(plan([hazard]), ctxOf(req));
    expect(result.dropped.map((d) => d.reason)).toEqual([
      "scheduleHazard: the ship is approaching: this leg's transit is over; place it on the next leg once a course is set",
    ]);
  });

  it("spends the hazard budget and lets one hazard wait at a time", () => {
    const empty = translateIntents(plan([hazard]), ctxOf(withBudget(inTransit(200), 0)));
    expect(empty.dropped.map((d) => d.reason)).toEqual(["scheduleHazard: hazard budget exhausted"]);

    const two = translateIntents(
      plan([hazard, { ...hazard, hazard: "ionStorm" }]),
      ctxOf(withBudget(inTransit(200), 2)),
    );
    expect(two.commands.map((c) => c.kind)).toEqual(["scheduleHazard"]);
    expect(two.dropped.map((d) => d.reason)).toEqual([
      "scheduleHazard: a hazard is already waiting on the ship's path; let it fire first",
    ]);

    const req = withBudget(inTransit(200), 2);
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    snapshot.state.hazards = [
      {
        id: "hz1" as never,
        kind: "ionStorm",
        difficulty: 5,
        fireAtTick: snapshot.state.tick + 100,
      },
    ];
    const waiting = translateIntents(plan([hazard]), { ...ctxOf(req), snapshot });
    expect(waiting.commands).toEqual([]);
    expect(waiting.dropped[0]?.reason).toContain("a hazard is already waiting");
  });

  it("drops an unknown hazard kind or tier at the schema", () => {
    const req = withBudget(inTransit(200), 2);
    const result = translateIntents(
      plan([
        { ...hazard, hazard: "blackHole" },
        { ...hazard, difficulty: "deadly" },
      ]),
      ctxOf(req),
    );
    expect(result.commands).toEqual([]);
    expect(result.dropped.map((d) => d.kind)).toEqual(["scheduleHazard", "scheduleHazard"]);
    for (const drop of result.dropped) expect(drop.reason).toContain("scheduleHazard: invalid");
  });
});

describe("translateIntents: scheduleField, the seventh lever (§scheduling-a-field)", () => {
  const field = {
    kind: "scheduleField",
    severity: "heavy",
    detection: "rolled",
    window: "soon",
    scripted: [] as unknown[],
  };
  const hit = (target: string, at = "middle", rock = "", effect = "") => ({
    target,
    at,
    rock,
    effect,
  });

  /** In transit with `secondsLeft` of the leg to run at nominal speed. */
  function inTransit(secondsLeft: number): NarratorRequest {
    const req = quietTooLongRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    const travel = snapshot.state.travel;
    if (travel.stage === "docked") throw new Error("fixture: expected the ship under way");
    const speed = snapshot.config.travel.nominalSpeed;
    snapshot.state.travel = {
      ...travel,
      routeDistance: 400,
      routeProgress: 400 - secondsLeft * speed,
    };
    return { ...req, snapshot };
  }

  function machineIdOf(req: NarratorRequest, defId: string): string {
    const machine = Object.values(req.snapshot.state.machines).find((m) => m.defId === defId);
    if (machine === undefined) throw new Error(`fixture: no ${defId}`);
    return machine.id;
  }

  function onlyDrop(req: NarratorRequest, intent: object): string | undefined {
    const result = translateIntents(plan([intent]), ctxOf(req));
    expect(result.commands).toEqual([]);
    return result.dropped[0]?.reason;
  }

  it("translates severity, detection, the window and scripted hits by machine id, machine name and room name", () => {
    const req = inTransit(200);
    const engine = machineIdOf(req, "machine.engine");
    const stove = machineIdOf(req, "machine.galley_stove");
    const result = translateIntents(
      plan([
        {
          ...field,
          detection: "unseen",
          scripted: [
            hit(engine, "late", "small", "knockout"),
            hit("galley stove", "early", "", "damage"),
            hit("Cargo Hold", "middle", "large", ""),
          ],
        },
      ]),
      ctxOf(req),
    );
    expect(result.dropped).toEqual([]);
    const [command] = result.commands;
    if (command?.kind !== "scheduleField") throw new Error("no field");
    const config = req.snapshot.config;
    const length = config.field.severities.heavy.lengthSeconds;
    expect(command.source).toBe("narrator");
    expect(command.payload.severity).toBe("heavy");
    expect(command.payload.detection).toBe("unseen");
    const third = (config.narrator.maxFaultWindowSeconds / 3) * config.time.tickRate;
    expect(command.payload.windowTicks).toEqual([0, Math.round(third)]);
    const hold = Object.values(req.snapshot.state.compartments).find((c) => c.key === "cargoHold");
    expect(hold).toBeDefined();
    expect(command.payload.scripted).toEqual([
      {
        atSeconds: Math.round(length * 0.85),
        target: { kind: "machine", machineId: engine },
        rock: "small",
        effect: "knockout",
      },
      {
        atSeconds: Math.round(length * 0.15),
        target: { kind: "machine", machineId: stove },
        effect: "damage",
      },
      {
        atSeconds: Math.round(length * 0.5),
        target: { kind: "compartment", compartmentId: hold?.id },
        rock: "large",
      },
    ]);
  });

  it("spaces scripted hits at the same moment a few seconds apart, inside the field", () => {
    const req = inTransit(200);
    const late = [hit("Galley", "late"), hit("Galley", "late"), hit("Galley", "late")];
    const result = translateIntents(
      plan([{ ...field, severity: "light", scripted: late }]),
      ctxOf(req),
    );
    const [command] = result.commands;
    if (command?.kind !== "scheduleField") throw new Error("no field");
    const length = req.snapshot.config.field.severities.light.lengthSeconds;
    const first = Math.round(length * 0.85);
    expect(command.payload.scripted.map((s) => s.atSeconds)).toEqual([first, first + 4, first + 8]);
    for (const s of command.payload.scripted) expect(s.atSeconds).toBeLessThan(length);
  });

  it("drops an unknown target, an ambiguous machine name and a person, each with its reason", () => {
    const req = inTransit(200);
    expect(onlyDrop(req, { ...field, scripted: [hit("Reactor Nine")] })).toBe(
      'scheduleField: scripted[0]: no machine or room "Reactor Nine" aboard; use an id or room name from What you can do',
    );
    const bunks = Object.values(req.snapshot.state.machines)
      .filter((m) => m.defId === "machine.bunk")
      .map((m) => m.id);
    expect(bunks.length).toBeGreaterThan(1);
    expect(onlyDrop(req, { ...field, scripted: [hit("Galley"), hit("Bunk")] })).toBe(
      `scheduleField: scripted[1]: ${bunks.length} machines aboard are called "Bunk"; use the machine id (${bunks.join(", ")})`,
    );
    expect(onlyDrop(req, { ...field, scripted: [hit("Jax Okonkwo")] })).toBe(
      'scheduleField: scripted[0]: "Jax Okonkwo" is a person: people are not targets until bodies; aim at a machine or a room',
    );
  });

  it("drops a fourth scripted impact", () => {
    const req = inTransit(200);
    const four = [hit("Galley"), hit("Cargo Hold"), hit("Bridge"), hit("Gym")];
    expect(onlyDrop(req, { ...field, scripted: four })).toBe(
      `scheduleField: at most ${req.snapshot.config.field.maxScripted} scripted impacts, got 4`,
    );
  });

  it("drops a window after this leg's transit, a docked ship with no course, and the approach", () => {
    expect(onlyDrop(inTransit(10), { ...field, window: "later" })).toBe(
      "scheduleField: window later opens after this leg's transit ends (~10s left); use soon, or place it on the next leg",
    );
    expect(onlyDrop(docked(approachRequest(content())), field)).toBe(
      "scheduleField: the ship is docked with no course set; a field needs a leg to lie on",
    );
    expect(onlyDrop(approachRequest(content()), field)).toBe(
      "scheduleField: the ship is approaching: this leg's transit is over; place it on the next leg once a course is set",
    );
  });

  it("allows one field per leg: none on top of the leg's field, and only one per call", () => {
    const req = inTransit(200);
    const two = translateIntents(plan([field, { ...field, severity: "light" }]), ctxOf(req));
    expect(two.commands.map((c) => c.kind)).toEqual(["scheduleField"]);
    expect(two.dropped.map((d) => d.reason)).toEqual([
      "scheduleField: this leg already has its field (one per leg); place the next on a later leg",
    ]);
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    snapshot.state.field = {
      id: "f1" as never,
      severity: "light",
      detection: "rolled",
      startsAtTick: snapshot.state.tick + 100,
      phase: { kind: "scheduled" },
      impacts: 0,
      stuckImpacts: 0,
      hullLost: 0,
      scripted: [],
    };
    expect(onlyDrop({ ...req, snapshot }, field)).toContain("this leg already has its field");
  });

  it("drops scripted hits that alone would sink the ship, pricing an unsized rock as large", () => {
    const req = inTransit(200);
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    snapshot.state.hull = { ...snapshot.state.hull, integrity: 20 };
    const weak = { ...req, snapshot };
    const { small, large } = snapshot.config.field.hullDamage;
    expect(3 * large).toBeGreaterThanOrEqual(20);
    expect(3 * small).toBeLessThan(20);
    const three = [hit("Galley"), hit("Cargo Hold"), hit("Gym")];
    expect(onlyDrop(weak, { ...field, scripted: three })).toBe(
      `scheduleField: scripted impacts alone would sink the ship (${3 * large} hull points against 20 left); script fewer or smaller rocks`,
    );
    const smaller = three.map((h) => ({ ...h, rock: "small" }));
    const accepted = translateIntents(plan([{ ...field, scripted: smaller }]), ctxOf(weak));
    expect(accepted.dropped).toEqual([]);
  });

  it("drops any field once the ship is lost", () => {
    const req = inTransit(200);
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    snapshot.state.hull = { ...snapshot.state.hull, integrity: 0, lostAtTick: snapshot.state.tick };
    expect(onlyDrop({ ...req, snapshot }, field)).toBe("scheduleField: the ship is lost");
  });

  it("drops an unknown severity, moment or effect at the schema", () => {
    const req = inTransit(200);
    const result = translateIntents(
      plan([
        { ...field, severity: "apocalyptic" },
        { ...field, scripted: [hit("Galley", "whenever")] },
        { ...field, scripted: [hit("Galley", "early", "", "vaporise")] },
      ]),
      ctxOf(req),
    );
    expect(result.commands).toEqual([]);
    expect(result.dropped).toHaveLength(3);
    for (const drop of result.dropped) expect(drop.reason).toContain("scheduleField: invalid");
  });
});

describe("translateIntents: the call-back request (§requested-call-back)", () => {
  const req = docked(quietTooLongRequest(content()));

  it("emits requestCall after the intents, at the next tick, with the plan's when and why", () => {
    const res = translateIntents(
      emptyPlan({
        intents: [decision] as NarratorPlan["intents"],
        callBack: { when: "departure", why: "A debris field on Noor's first hard watch." },
      }),
      ctxOf(req),
    );
    expect(res.dropped).toEqual([]);
    expect(res.commands.map((c) => c.kind)).toEqual(["surfaceDecision", "requestCall"]);
    expect(res.commands[1]).toEqual({
      id: "cmd:narrator:call1:1",
      source: "narrator",
      targetTick: req.hook.tick + 1,
      kind: "requestCall",
      payload: { when: "departure", why: "A debris field on Noor's first hard watch." },
    });
  });

  it("emits nextPort too: it replaces a standing request", () => {
    const res = translateIntents(
      emptyPlan({ callBack: { when: "nextPort", why: "" } }),
      ctxOf(requestedCallRequest(content())),
    );
    expect(res.commands).toEqual([
      expect.objectContaining({ kind: "requestCall", payload: { when: "nextPort", why: "" } }),
    ]);
  });

  it("clips why to CALL_BACK_WHY_MAX and strips control characters", () => {
    const why = `line one\nline\u0007two ${"x".repeat(300)}`;
    const res = translateIntents(emptyPlan({ callBack: { when: "midLeg", why } }), ctxOf(req));
    const command = res.commands[0];
    if (command?.kind !== "requestCall") throw new Error("no requestCall");
    expect(command.payload.why.length).toBeLessThanOrEqual(CALL_BACK_WHY_MAX);
    expect(command.payload.why.startsWith("line one line two x")).toBe(true);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
    expect(command.payload.why).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("asks for nothing when the plan has no callBack (a plan built in code)", () => {
    const res = translateIntents(emptyPlan(), ctxOf(req));
    expect(res.commands).toEqual([]);
    expect(res.dropped).toEqual([]);
  });

  it("drops a malformed callBack with a reason instead of passing it on", () => {
    const res = translateIntents(
      emptyPlan({ callBack: { when: "never", why: "" } as unknown as CallBackPlan }),
      ctxOf(req),
    );
    expect(res.commands).toEqual([]);
    expect(res.dropped).toEqual([expect.objectContaining({ intentIndex: -1, kind: "callBack" })]);
  });
});
