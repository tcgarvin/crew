import { describe, expect, it } from "vitest";
import { bodyViolations, checkInvariants, expeditionViolations } from "../../core/invariants";
import { siteOf } from "../../core/sites";
import type { SiteCastEntryDef } from "../../core/types/content";
import type { ActorId } from "../../core/types/ids";
import { travelViolations } from "../travel/invariants";
import { SITE, SITE_CAST, send, siteWorld } from "./fixtures/site";

type Test = ReturnType<typeof siteWorld>;

function start(test: Test, payload: { cast?: readonly SiteCastEntryDef[]; plan?: string } = {}) {
  return send(test, {
    kind: "scenarioStartExpedition",
    payload: { siteId: SITE.port, ...payload },
  });
}

const reason = (result: ReturnType<typeof start>) =>
  result.status === "rejected" ? result.rejection : undefined;

function healthy(test: Test): string[] {
  return [
    ...checkInvariants(test.world.state),
    ...travelViolations(test.world),
    ...bodyViolations(test.world),
    ...expeditionViolations(test.world),
  ];
}

const castOf = (test: Test) =>
  Object.values(test.world.state.actors).filter((a) => a.combatant !== undefined);

describe("scenarioStartExpedition (expeditions A1, call 3)", () => {
  it("refuses an unknown port and a port that is not a site", () => {
    const test = siteWorld();
    const unknown = send(test, {
      kind: "scenarioStartExpedition",
      payload: { siteId: "port.nowhere" as typeof SITE.port },
    });
    expect(reason(unknown)?.code).toBe("unknownEntity");
    const port = send(test, {
      kind: "scenarioStartExpedition",
      payload: { siteId: "port.tiny.far" as typeof SITE.port },
    });
    expect(reason(port)?.reason).toMatch(/is a port, not a site/);
  });

  it("holds the cast to six people, three armed, one target, and posts of the part's kind", () => {
    const test = siteWorld();
    const [target, hesk, darrow, pell] = SITE_CAST as [
      SiteCastEntryDef,
      SiteCastEntryDef,
      SiteCastEntryDef,
      SiteCastEntryDef,
    ];
    const seven = [target, hesk, darrow, pell, pell, pell, pell];
    expect(reason(start(test, { cast: seven }))?.reason).toMatch(/7 people/);
    const armed = [hesk, hesk, darrow, { ...pell, arms: "blaster" as const }];
    expect(reason(start(test, { cast: armed }))?.reason).toMatch(/4 armed/);
    expect(reason(start(test, { cast: [target, target] }))?.reason).toMatch(/2 targets/);
    const misplaced = [{ ...target, post: "guard_east" }];
    expect(reason(start(test, { cast: misplaced }))?.reason).toMatch(/target post/);
    expect(reason(start(test, { cast: [{ ...hesk, post: "nowhere" }] }))?.reason).toMatch(
      /no post "nowhere"/,
    );
  });

  it("refuses a plan the menu does not hold", () => {
    const test = siteWorld();
    expect(reason(start(test, { plan: "charge-everyone" }))?.reason).toMatch(
      /not on the plan menu/,
    );
    expect(start(test, { plan: "assault-lethal-armed" }).status).toBe("accepted");
  });

  it("refuses while anyone is on the dock", () => {
    const test = siteWorld();
    const mara = test.world.state.actors["a1" as ActorId];
    if (mara?.location.kind !== "onDeck") throw new Error("fixture crew");
    // Dock (5, 9): the quay, under deck row 8.
    mara.location = { ...mara.location, x: 3.5, y: 8.5 };
    expect(reason(start(test))?.reason).toMatch(/is on the dock/);
  });

  it("swaps the dock for the site's in place, the cast at their posts and armed", () => {
    const test = siteWorld();
    expect(start(test).status).toBe("accepted");
    test.kernel.advance(test.world, 1);
    const state = test.world.state;
    expect(state.travel).toEqual({ stage: "docked", portId: SITE.port });
    expect(siteOf(test.world.content, state)?.dock.id).toBe(SITE.dock);
    expect(Object.keys(state.dockside.locals)).toEqual([]);
    const cast = castOf(test);
    expect(cast.map((a) => a.name)).toEqual(SITE_CAST.map((c) => c.name));
    for (const actor of cast) {
      expect(actor.crew).toBe(false);
      expect(actor.combatant?.side).toBe("them");
    }
    // Ruling 7: the ladder starts from resolve; the shaky (0.45) start wavering.
    expect(cast.map((a) => a.combatant?.state)).toEqual([
      "steady",
      "steady",
      "wavering",
      "wavering",
    ]);
    const carried = Object.values(state.items).filter((i) => i.location.kind === "carriedBy");
    expect(carried.map((i) => i.defId).sort()).toEqual([SITE.baton, SITE.blaster]);
    expect(state.expedition).toMatchObject({ siteId: SITE.port, phase: "mustering", shots: 0 });
    expect(state.expedition?.party[0]).toBe(state.expedition?.leaderId);
    for (const door of Object.values(state.doors).filter((d) => d.kind === "ramp")) {
      expect(door.physicalState).toBe("open");
    }
    test.kernel.advance(test.world, 40);
    expect(healthy(test)).toEqual([]);
  });

  it("takes a plan by adoptPlan once, and withdrawParty only with the party ashore", () => {
    const test = siteWorld();
    start(test);
    test.kernel.advance(test.world, 1);
    expect(reason(send(test, { kind: "withdrawParty", payload: {} }))?.reason).toMatch(
      /not ashore/,
    );
    expect(send(test, { kind: "adoptPlan", payload: { planId: "hold-lethal-armed" } }).status).toBe(
      "accepted",
    );
    test.kernel.advance(test.world, 1);
    expect(test.world.state.expedition?.plan?.id).toBe("hold-lethal-armed");
    const again = send(test, { kind: "adoptPlan", payload: { planId: "assault-lethal-armed" } });
    expect(reason(again)?.reason).toMatch(/already/);
  });
});

describe("with no expedition, nothing changes (expeditions A1)", () => {
  it("keeps every body whole and capacities as fatigue writes them", () => {
    const test = siteWorld();
    test.kernel.advance(test.world, 200);
    expect(test.world.state.expedition).toBeUndefined();
    for (const actor of Object.values(test.world.state.actors)) {
      expect(actor.body.wounds).toEqual([]);
      expect(actor.combatant).toBeUndefined();
    }
    expect(healthy(test)).toEqual([]);
  });
});
