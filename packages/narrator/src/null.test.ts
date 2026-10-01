/**
 * D40: the null narrator is the only offline source of work. For `approachingPort` and
 * `jobBoard` it answers with one templated `offerJob` through the real translator; for other
 * hooks it keeps its old behaviour (no commands; a template card for a policy decision).
 */
import type { ContentBundle, NarratorHook, PortDefId, SaveEnvelope } from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorRequest } from "./contract";
import { approachingPortRequest, quietTooLongRequest } from "./fixtures";
import { payFor, routeDistance } from "./lookups";
import { NULL_NARRATOR_MODEL, nullNarratorResponse } from "./null";
import { content } from "./test-support";

const DRIFT = "port.kessler_drift" as PortDefId;

/** Docked at Kessler Drift with nothing on, the sim asking for work. */
function jobBoardRequest(tick = 2_400): NarratorRequest {
  const base = approachingPortRequest(content());
  const snapshot: SaveEnvelope = { ...structuredClone(base.snapshot), savedAtTick: tick };
  snapshot.state.tick = tick;
  snapshot.state.travel = { stage: "docked", portId: DRIFT };
  const hook: NarratorHook = {
    id: "k2" as never,
    kind: "jobBoard",
    context: { portId: DRIFT },
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
  it.each([
    ["approachingPort", () => approachingPortRequest(content())],
    ["jobBoard", () => jobBoardRequest()],
  ])("answers %s with one translated, surfaced offerJob from the port's templates", (_k, make) => {
    const req = make();
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

  it("gives the offer the D25 person and pitch shape from the name table, with no numbers", () => {
    const { command } = offerOf(jobBoardRequest());
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
    const { command } = offerOf(jobBoardRequest());
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
    const a = offerOf(jobBoardRequest()).command.payload;
    const b = offerOf(jobBoardRequest()).command.payload;
    expect(a).toEqual(b);
    const offers = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
        const { job } = offerOf(jobBoardRequest(1_000 * n)).command.payload;
        return typeof job.issuer === "string" ? job.issuer : job.issuer.name;
      }),
    );
    expect(offers.size).toBeGreaterThan(1);
  });

  it("posts the offer quietly when a card is already queued", () => {
    const req = jobBoardRequest();
    const snapshot = req.snapshot as SaveEnvelope;
    snapshot.state.decisions.queue.push("d-queued" as never);
    const { command } = offerOf(req);
    expect(command.payload.surface).toBe(false);
  });

  it("offers nothing without content, at a port with no templates, or on other hooks", () => {
    expect(nullNarratorResponse(jobBoardRequest(), { callId: "c" }).commands).toEqual([]);
    const bundle = content();
    const drift = bundle.ports[DRIFT];
    if (drift === undefined) throw new Error("fixture port");
    const bare: ContentBundle = {
      ...bundle,
      ports: { ...bundle.ports, [DRIFT]: { ...drift, jobTemplates: [] } },
    };
    expect(
      nullNarratorResponse(jobBoardRequest(), { callId: "c", content: bare }).commands,
    ).toEqual([]);
    expect(
      nullNarratorResponse(quietTooLongRequest(content()), { callId: "c", content: content() })
        .commands,
    ).toEqual([]);
  });
});
