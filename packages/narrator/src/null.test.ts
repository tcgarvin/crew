/**
 * D40: the null narrator is the only offline source of work. For `captainAshore` it answers with one
 * templated `offerJob` through the real translator; for other hooks it keeps its old behaviour
 * (no commands; a template card for a policy decision). §staging-hook-and-the-hold: it stages
 * nothing, so a dock is the sim's floor set, and it never offers on the way in.
 */
import type {
  ActorId,
  ContentBundle,
  DecisionId,
  NarratorHook,
  PortDefId,
  SaveEnvelope,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorRequest } from "./contract";
import {
  FIXTURE_ERRAND_TARGET,
  approachRequest,
  quietTooLongRequest,
  requestedCallRequest,
  siteArrivalRequest,
  stageDockRequest,
} from "./fixtures";
import { pathBetween, payFor, routeDistance } from "./lookups";
import { NULL_NARRATOR_MODEL, nullNarratorResponse } from "./null";
import { content } from "./test-support";

const DRIFT = "port.kessler_drift" as PortDefId;

/** Docked at Kessler Drift with nothing on, the sim asking for work. */
function captainAshoreRequest(tick = 2_400): NarratorRequest {
  const base = approachRequest(content());
  const snapshot: SaveEnvelope = { ...structuredClone(base.snapshot), savedAtTick: tick };
  snapshot.state.tick = tick;
  snapshot.state.travel = { stage: "docked", portId: DRIFT };
  const hook: NarratorHook = {
    id: "k2" as never,
    kind: "captainAshore",
    context: { portId: DRIFT, actorId: "a1" as ActorId },
    tick,
  };
  snapshot.state.narrator.pendingHook = hook;
  return { gameId: "fixture-board", hook, snapshot, recentEvents: [] };
}

function offerOf(req: NarratorRequest) {
  const res = nullNarratorResponse(req, { callId: "call1", content: content() });
  expect(res.commands.map((c) => c.kind)).toEqual(["offerJob"]);
  const command = res.commands[0];
  if (command?.kind !== "offerJob") throw new Error("no offer");
  return { res, command };
}

describe("null narrator offers work (D40)", () => {
  it("answers stageDock with an empty plan and nothing else: the floor set alone (§staging-hook-and-the-hold)", () => {
    const res = nullNarratorResponse(stageDockRequest(content()), { content: content() });
    expect(res.commands).toEqual([]);
    expect(res.card).toBeUndefined();
    expect(res.notesUpdate).toBeUndefined();
  });

  it("offers nothing on the way in (§staging-hook-and-the-hold: arrival is the staging call's)", () => {
    const res = nullNarratorResponse(approachRequest(content()), { content: content() });
    expect(res.commands).toEqual([]);
  });

  it("answers captainAshore with one translated, surfaced offerJob from the port's templates", () => {
    const req = captainAshoreRequest();
    const { res, command } = offerOf(req);
    expect(res.model).toBe(NULL_NARRATOR_MODEL);
    expect(command).toMatchObject({
      id: "cmd:narrator:call1:0",
      source: "narrator",
      targetTick: req.hook.tick + 1,
    });
    const { job, surface } = command.payload;
    expect(surface).toBe(true);
    expect(job.fromPortId).toBe(DRIFT);
    const port = content().ports[DRIFT];
    expect(port?.jobTemplates.map((t) => t.toPortId)).toContain(job.toPortId);
    expect(port?.jobTemplates.flatMap((t) => t.cargo.map((c) => c.itemDefId))).toContain(
      job.cargo[0]?.itemDefId,
    );
  });

  it("gives the offer an issuer person and a pitch from the name table, with no numbers (§issuers-and-pitches)", () => {
    const { command } = offerOf(captainAshoreRequest());
    const { job } = command.payload;
    const people = content().people;
    if (people === undefined) throw new Error("content has no name table");
    if (typeof job.issuer === "string") throw new Error("issuer is not a person");
    const [given, family] = job.issuer.name.split(" ");
    expect(people.givenNames).toContain(given);
    expect(people.familyNames).toContain(family);
    expect(people.ports[DRIFT]?.roles).toContain(job.issuer.role);
    expect(people.ports[DRIFT]?.orgs).toContain(job.issuer.org);
    expect(job.pitch?.prose).toMatch(/\S/);
    expect(job.pitch?.prose).not.toMatch(/[{}]|\d/);
    expect(job.description.prose).not.toMatch(/[{}]|\d/);
    expect(["relaxed", "soon", "urgent"]).toContain(job.urgency);
  });

  it("pays inside the price band, as a model's offer would", () => {
    const { command } = offerOf(captainAshoreRequest());
    const { job } = command.payload;
    const bundle = content();
    const line = job.cargo[0];
    if (line === undefined) throw new Error("no cargo");
    const cargoClass = bundle.items[line.itemDefId]?.cargoClass;
    const distance = routeDistance(bundle, job.fromPortId, job.toPortId);
    if (cargoClass === undefined || distance === undefined) throw new Error("bad offer");
    const { min, max } = payFor(bundle.config, cargoClass, distance, line.count, "standard");
    expect(job.pay).toBeGreaterThanOrEqual(min);
    expect(job.pay).toBeLessThanOrEqual(max);
  });

  it("is deterministic for the same snapshot and varies with the tick", () => {
    const a = offerOf(captainAshoreRequest()).command.payload;
    const b = offerOf(captainAshoreRequest()).command.payload;
    expect(a).toEqual(b);
    const offers = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
        const { job } = offerOf(captainAshoreRequest(1_000 * n)).command.payload;
        return typeof job.issuer === "string" ? job.issuer : job.issuer.name;
      }),
    );
    expect(offers.size).toBeGreaterThan(1);
  });

  it("never offers passages: passenger and roundTrip are false on every offline offer (§4.4)", () => {
    for (const req of [captainAshoreRequest(), captainAshoreRequest(3_000)]) {
      const { job } = offerOf(req).command.payload;
      expect(job.passenger ?? false).toBe(false);
      expect(job.roundTrip ?? false).toBe(false);
      expect(job.cargo.length).toBeGreaterThan(0);
    }
  });

  it("posts the offer quietly when a card is already queued", () => {
    const req = captainAshoreRequest();
    const snapshot = req.snapshot as SaveEnvelope;
    snapshot.state.decisions.queue.push("d-queued" as never);
    const { command } = offerOf(req);
    expect(command.payload.surface).toBe(false);
  });

  it("translates a two-hop template at a far port, priced by path distance (§2.3)", () => {
    const TERNS = "port.terns_rest" as PortDefId;
    const bundle = content();
    expect(Object.values(bundle.ports).filter((p) => p.kind !== "site")).toHaveLength(6);
    const terns = bundle.ports[TERNS];
    if (terns === undefined) throw new Error("fixture port");
    // Tern's Rest -> Kessler Drift runs through the Hub: 90 + 25.
    const twoHop = terns.jobTemplates.filter((t) => t.toPortId === DRIFT);
    expect(twoHop).toHaveLength(1);
    const farOnly: ContentBundle = {
      ...bundle,
      ports: { ...bundle.ports, [TERNS]: { ...terns, jobTemplates: twoHop } },
    };
    const req = captainAshoreRequest();
    const snapshot = req.snapshot as SaveEnvelope;
    snapshot.state.travel = { stage: "docked", portId: TERNS };
    const hook: NarratorHook = {
      ...req.hook,
      kind: "captainAshore",
      context: { portId: TERNS, actorId: "a1" as ActorId },
    };
    snapshot.state.narrator.pendingHook = hook;
    const res = nullNarratorResponse({ ...req, hook }, { callId: "c", content: farOnly });
    expect(res.commands.map((c) => c.kind)).toEqual(["offerJob"]);
    const command = res.commands[0];
    if (command?.kind !== "offerJob") throw new Error("no offer");
    const { job } = command.payload;
    expect(job.fromPortId).toBe(TERNS);
    expect(job.toPortId).toBe(DRIFT);
    expect(routeDistance(bundle, TERNS, DRIFT)).toBeUndefined();
    const line = job.cargo[0];
    if (line === undefined) throw new Error("no cargo");
    const distance = pathBetween(bundle, snapshot.state, TERNS, DRIFT)?.distance;
    if (distance === undefined) throw new Error("no path");
    const { min, max } = payFor(bundle.config, "hazardous", distance, line.count, "standard");
    expect(job.pay).toBeGreaterThanOrEqual(min);
    expect(job.pay).toBeLessThanOrEqual(max);
  });

  it("offers nothing without content, at a port with no templates, or on other hooks", () => {
    expect(nullNarratorResponse(captainAshoreRequest(), { callId: "c" }).commands).toEqual([]);
    const bundle = content();
    const drift = bundle.ports[DRIFT];
    if (drift === undefined) throw new Error("fixture port");
    const bare: ContentBundle = {
      ...bundle,
      ports: { ...bundle.ports, [DRIFT]: { ...drift, jobTemplates: [] } },
    };
    expect(
      nullNarratorResponse(captainAshoreRequest(), { callId: "c", content: bare }).commands,
    ).toEqual([]);
    expect(
      nullNarratorResponse(quietTooLongRequest(content()), { callId: "c", content: content() })
        .commands,
    ).toEqual([]);
  });

  it("answers the call the narrator asked for with nothing, and asks for no call back (§requested-call-back)", () => {
    const res = nullNarratorResponse(requestedCallRequest(content()), {
      callId: "c",
      content: content(),
    });
    expect(res.commands).toEqual([]);
    expect(res.card).toBeUndefined();
    expect(res.model).toBe(NULL_NARRATOR_MODEL);
  });
});

describe("null narrator and errands (expeditions A2, plan call 14)", () => {
  it("never offers an errand: its offers are the port's freight templates", () => {
    for (const tick of [2_400, 2_401, 2_402, 2_403, 2_404]) {
      const { command } = offerOf(captainAshoreRequest(tick));
      expect(command.payload.job.errand).toBeUndefined();
      expect(command.payload.job.toPortId).not.toBe(command.payload.job.fromPortId);
    }
  });

  it("dresses the arrival card from its template: the first officer at the ramp head, the two plans as sides", () => {
    const req = siteArrivalRequest(content());
    const res = nullNarratorResponse(req, { callId: "c", content: content() });
    const firstOfficer = Object.values(req.snapshot.state.actors).find((a) =>
      a.roleTags.includes("firstOfficer"),
    );
    expect(res.commands).toEqual([]);
    expect(res.card).toMatchObject({
      title: "At Harrow End",
      speaker: firstOfficer?.name,
      leftLabel: "Hold the ramp from cover",
      rightLabel: "Go in and take them",
    });
    expect(res.card?.situation).toContain(
      `${FIXTURE_ERRAND_TARGET} is at Harrow End, and not alone.`,
    );
    expect(res.card?.leftAftermath).toMatch(/^hold the ramp from cover \(\d+ go\)$/);
  });

  it("dresses the turn card from its template", () => {
    const req = siteArrivalRequest(content());
    const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
    const state = snapshot.state;
    const arrival = state.decisions.queue[0];
    const card = arrival === undefined ? undefined : state.decisions.records[arrival];
    if (card === undefined) throw new Error("no arrival card");
    const turnId = "d-turn" as DecisionId;
    const key = "expedition.turn";
    state.decisions.records[turnId] = {
      ...card,
      id: turnId,
      prompt: { key, params: { speaker: "Dane Whitcross", name: "Mattie Lusk", how: "down" } },
      left: { label: { key: `${key}.press`, params: {} }, commands: [] },
      right: {
        label: { key: `${key}.withdraw`, params: {} },
        commands: [{ kind: "withdrawParty", payload: {} }],
      },
    };
    state.decisions.queue = [turnId];
    const hook: NarratorHook = {
      ...req.hook,
      kind: "policyDecision",
      context: { decisionId: turnId },
    };
    const res = nullNarratorResponse(
      { ...req, hook, snapshot },
      { callId: "c", content: content() },
    );
    expect(res.card).toMatchObject({
      title: "The fight turns",
      situation: "Mattie Lusk is down. Press on, or pull back?",
      leftLabel: "Press on",
      rightLabel: "Pull back to the ship",
    });
  });
});
