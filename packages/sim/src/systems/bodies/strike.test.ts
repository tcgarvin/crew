/**
 * §strike-lever (D106): the narrator's `strike`, through `applyDamage`, aboard the bodies fixture
 * (four crew standing in the hold; Mara is the captain) and in the site fixture's fight.
 */
import { describe, expect, it } from "vitest";
import { cmd } from "../../core/fixtures/test-world";
import { tickerLine } from "../../core/render";
import type { CommandPayloadMap, EnqueueResult } from "../../core/types/commands";
import type { SimEvent } from "../../core/types/events";
import type { ActorId, PortDefId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { run, startExpedition } from "../expedition/fixtures/fight";
import { send, siteWorld } from "../expedition/fixtures/site";
import { CREW } from "../work/fixtures/crew-deck";
import {
  BETTINA,
  JAX,
  MARA,
  PRIYA,
  actorOf,
  bodiesWorld,
  bodiesWorldViolations,
} from "./fixtures/bodies-deck";

type Strike = CommandPayloadMap["strike"];

function strikeAboard(
  test: ReturnType<typeof bodiesWorld>,
  payload: Strike,
): { result: EnqueueResult; events: SimEvent[] } {
  const result = test.kernel.enqueueCommand(
    test.world,
    cmd({ source: "narrator", kind: "strike", payload }),
  );
  const events = result.status === "accepted" ? [...test.kernel.advance(test.world, 1).events] : [];
  return { result, events };
}

const reasonOf = (result: EnqueueResult) =>
  result.status === "rejected" ? result.rejection.reason : "accepted";

const ticker = (world: World, events: readonly SimEvent[]) =>
  events
    .map((e) => tickerLine(e, world.state, world.content))
    .filter((line): line is string => line !== null);

const thoughtsOf = (world: World, id: ActorId) => actorOf(world, id).thoughts.map((t) => t.key);

describe("strike aboard (§strike-lever)", () => {
  it("kills the captain by the body rules with a grave head strike, and the ticker tells the narrator's line", () => {
    const test = bodiesWorld();
    const { result, events } = strikeAboard(test, {
      actorId: MARA,
      severity: "grave",
      type: "blunt",
      part: "head",
      how: "Mara Quill falls from the hold ladder",
    });
    expect(result.status).toBe("accepted");
    const types = events
      .map((e) => e.type)
      .filter((t) => ["struck", "wounded", "died"].includes(t));
    expect(types).toEqual(["struck", "wounded", "died"]);
    expect(events.find((e) => e.type === "struck")?.significance).toBe("narrative");
    expect(actorOf(test.world, MARA).availability).toBe("dead");
    const lines = ticker(test.world, events);
    expect(lines).toContain("Mara Quill falls from the hold ladder");
    expect(lines.some((l) => l.includes("is hit"))).toBe(false);
    expect(bodiesWorldViolations(test.world)).toEqual([]);
  });

  it("wounds without killing on a graze, and the crew in the room see a crewmate hurt", () => {
    const test = bodiesWorld();
    strikeAboard(test, {
      actorId: JAX,
      severity: "graze",
      type: "blunt",
      part: "leftArm",
      how: "Jax catches his arm on the cargo net",
    });
    const jax = actorOf(test.world, JAX);
    expect(jax.availability).toBe("available");
    expect(jax.body.wounds).toHaveLength(1);
    expect(thoughtsOf(test.world, JAX)).toContain("wounded");
    for (const witness of [MARA, PRIYA, BETTINA]) {
      expect(thoughtsOf(test.world, witness)).toContain("sawCrewHurt");
    }
  });

  it("gives a crew striker whose blow killed killedSomeone", () => {
    const test = bodiesWorld();
    strikeAboard(test, {
      actorId: PRIYA,
      severity: "grave",
      type: "blunt",
      part: "head",
      byActorId: JAX,
      how: "Jax swings the wrench and Priya goes down",
    });
    expect(actorOf(test.world, PRIYA).availability).toBe("dead");
    expect(thoughtsOf(test.world, JAX)).toContain("killedSomeone");
  });

  it("refuses the dead, nobody, someone off the ship, and a dead striker", () => {
    const test = bodiesWorld();
    const base = { severity: "grave", type: "blunt", part: "head", how: "a fall" } as const;
    strikeAboard(test, { ...base, actorId: BETTINA });
    expect(reasonOf(strikeAboard(test, { ...base, actorId: BETTINA }).result)).toContain(
      "already dead",
    );
    expect(reasonOf(strikeAboard(test, { ...base, actorId: "a99" as ActorId }).result)).toContain(
      "no one",
    );
    expect(
      reasonOf(strikeAboard(test, { ...base, actorId: JAX, byActorId: BETTINA }).result),
    ).toContain("already dead");
    const priya = actorOf(test.world, PRIYA);
    priya.availability = "offShip";
    priya.location = {
      kind: "inExternalStore",
      portId: "port.alpha" as PortDefId,
      storeKey: "lounge",
    };
    expect(reasonOf(strikeAboard(test, { ...base, actorId: PRIYA }).result)).toContain(
      "not on the ship or the site",
    );
  });

  it("refuses a missing how and a severity the bodies do not know", () => {
    const test = bodiesWorld();
    const base = { actorId: JAX, type: "blunt", how: "a fall" } as const;
    expect(reasonOf(strikeAboard(test, { ...base, severity: "graze", how: " " }).result)).toContain(
      "how",
    );
    expect(
      reasonOf(strikeAboard(test, { ...base, severity: "fatal" as Strike["severity"] }).result),
    ).toContain("severity");
  });
});

describe("strike in the fight (§strike-lever)", () => {
  it("lands like a shot: the fight's own line tells it and a dead guard leaves the fight", () => {
    const test = siteWorld({ scenario: CREW.scenario8 });
    startExpedition(test, "assault-lethal-armed");
    run(test, 400 * 20, { until: () => test.world.state.expedition?.phase === "fight", step: 1 });
    expect(test.world.state.expedition?.phase).toBe("fight");
    const guard = Object.values(test.world.state.actors).find(
      (a) => a.combatant?.disposition.part === "guard" && a.availability === "available",
    );
    if (guard === undefined) throw new Error("no guard standing in the fight");
    const accepted = send(test, {
      kind: "strike",
      payload: { actorId: guard.id, severity: "grave", type: "blaster", part: "head", how: "x" },
    });
    expect(accepted.status).toBe("accepted");
    const events = run(test, 2, { step: 1 });
    const struck = events.find((e) => e.type === "struck");
    expect(struck?.payload).toMatchObject({ actorId: guard.id, inFight: true });
    expect(guard.availability).toBe("dead");
    expect(guard.combatant?.state).toBe("dead");
    const lines = ticker(test.world, events);
    expect(lines).not.toContain("X");
    expect(lines).toContain(`${guard.name} is dead`);
  });
});
