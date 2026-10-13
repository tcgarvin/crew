/**
 * Expeditions A1 (§7.1, plan "Risks"): the captain can die, and command passes to the first
 * officer by D8's `isFitForCommand`, which reads `availability`. With the captain dead, the first
 * officer is the command actor and the ship still raises `captainAshore` at the next docking, in
 * their name.
 */
import { describe, expect, it } from "vitest";
import { commandActor } from "../../core/command-actor";
import { cmd } from "../../core/fixtures/test-world";
import { bodyViolations } from "../../core/invariants";
import type { ActorId, HookId } from "../../core/types/ids";
import { PORTS, advanceToStage, freightTestWorld } from "../travel/fixtures";
import { woundNow } from "./fixtures/bodies-deck";

function roleHolder(actors: Record<ActorId, { roleTags: readonly string[] }>, tag: string) {
  const entry = Object.entries(actors).find(([, a]) => a.roleTags.includes(tag));
  if (entry === undefined) throw new Error(`no ${tag}`);
  return entry[0] as ActorId;
}

describe("a dead captain (§7.1)", () => {
  it("hands command to the first officer, and the next docking still asks captainAshore", () => {
    const { world, kernel } = freightTestWorld();
    expect(kernel.advance(world, 1).halt).toEqual({ kind: "hook" });
    const firstAsk = world.state.narrator.pendingHook?.id as HookId | undefined;
    if (firstAsk === undefined) throw new Error("no first ask");
    kernel.enqueueCommand(
      world,
      cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId: firstAsk } }),
    );
    const captain = roleHolder(world.state.actors, "captain");
    const mate = roleHolder(world.state.actors, "firstOfficer");
    expect(commandActor(world.state)).toBe(captain);

    const { result } = woundNow(world, captain, {
      part: "head",
      severity: "grave",
      type: "blaster",
    });
    expect(result.died).toBe(true);
    expect(commandActor(world.state)).toBe(mate);

    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    advanceToStage(kernel, world, "approaching");
    const untilAsk = kernel.advance(world, 1_000);
    expect(untilAsk.halt).toEqual({ kind: "hook" });
    expect(world.state.travel).toEqual({
      stage: "docked",
      portId: PORTS.b,
      dockedSinceTick: expect.any(Number),
    });
    expect(world.state.narrator.pendingHook).toMatchObject({
      kind: "captainAshore",
      context: { portId: PORTS.b, actorId: mate },
    });
    expect(world.state.actors[captain]?.availability).toBe("dead");
    expect(bodyViolations(world)).toEqual([]);
  });
});
