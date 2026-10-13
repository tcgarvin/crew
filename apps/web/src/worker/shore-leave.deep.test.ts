/**
 * §shore-leave on the real content and every V1 system: docked at Crossroads Hub, off-watch crew
 * keen on gossip go down the ramp for a drink by the night-market stall, never more than
 * `recreation.ashoreMax` at once, and the ticker says so. Once the course is set (and plotted, with
 * no cargo to work) nobody new goes ashore; departure prep's call aboard ends the drink, everyone walks back up the ramp on their own
 * (nobody is brought aboard by the dock crew) and the dock casts off with nobody on it. Every
 * invariant holds every tick.
 */
import type { Command, CommandId, PortDefId, SimEvent, World } from "@crew/sim";
import { isOnDock, isOnShoreLeave, tickerLine } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { assertInvariants, newGame } from "./testGame";

const KESSLER = "port.kessler_drift" as PortDefId;
const SHORE_LEAVE = "activity.shore_leave";

let n = 0;

describe("shore leave on real content (§shore-leave)", { timeout: 180_000 }, () => {
  it("goes ashore for a drink at the Hub, at most ashoreMax at once, and is aboard by cast-off", () => {
    const { bundle, kernel, world } = newGame(20261013);
    const cap = world.config.values.recreation.ashoreMax;
    // Everyone keen on gossip and bored, with the gossip aboard backing off, so the drink ashore is
    // what the off watch picks.
    for (const actor of Object.values(world.state.actors)) {
      if (!actor.crew || actor.passenger === true) continue;
      actor.interests = { likes: ["gossip"], strong: "gossip", dislikes: [] };
      actor.needs.recreation = 0.9;
      actor.workBackoff = { ...(actor.workBackoff ?? {}), "recreate:activity.gossip": 1e9 };
    }
    const send = (command: Omit<Command, "id">) => {
      n += 1;
      const result = kernel.enqueueCommand(world, {
        ...command,
        id: `cmd:shore:${n}` as CommandId,
      } as Command);
      if (result.status !== "accepted") {
        throw new Error(`${command.kind}: ${JSON.stringify(result)}`);
      }
    };
    const events: SimEvent[] = [];
    const lines: string[] = [];
    const wentAshore = new Set<string>();
    let mostOnLeave = 0;
    const step = (world: World) => {
      const result = kernel.advance(world, 1);
      events.push(...result.events);
      for (const e of result.events) {
        const line = tickerLine(e, world.state, bundle);
        if (line !== null) lines.push(line);
      }
      assertInvariants(world);
      const onLeave = Object.values(world.state.actors).filter(
        (a) => a.crew && isOnShoreLeave(bundle, world.state, a),
      );
      mostOnLeave = Math.max(mostOnLeave, onLeave.length);
      for (const a of onLeave) {
        if (isOnDock(bundle, world.state, a.location)) wentAshore.add(a.id);
      }
      if (result.halt.kind === "hook") {
        const hook = world.state.narrator.pendingHook;
        if (hook === undefined) throw new Error("hook halt without a pending hook");
        send({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
      } else if (result.halt.kind === "decision") {
        const head = world.state.decisions.queue[0];
        if (head === undefined) throw new Error("decision halt without a queued decision");
        send({
          source: "player",
          kind: "resolveDecision",
          payload: { decisionId: head, side: "left" },
        });
      }
    };

    // A drink ashore starts.
    const drinking = () =>
      Object.values(world.state.social.sessions).some(
        (s) => s.activityId === SHORE_LEAVE && "postKey" in s.venue && s.startedTick !== undefined,
      );
    for (let i = 0; i < 20 * 900 && !drinking(); i++) {
      step(world);
    }
    expect(drinking()).toBe(true);
    expect(wentAshore.size).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("having a drink ashore, by the night-market stall"))).toBe(
      true,
    );
    // Let it run a while: more may join, never past the cap.
    for (let i = 0; i < 20 * 30; i++) step(world);
    expect(mostOnLeave).toBeLessThanOrEqual(cap);

    // Set a course: nobody new goes ashore, the call aboard ends the drink, and the dock casts off
    // with nobody on it.
    send({ source: "player", kind: "setCourse", payload: { destinationPortId: KESSLER } });
    const ashoreAtCourse = new Set(
      Object.values(world.state.actors)
        .filter((a) => a.crew && isOnShoreLeave(bundle, world.state, a))
        .map((a) => a.id),
    );
    // Some are still at their drink when the course is set: the call aboard must end it.
    expect(ashoreAtCourse.size).toBeGreaterThan(0);
    let prepTicks = 0;
    for (let i = 0; i < 20 * 900 && world.state.deck.dock !== undefined; i++) {
      step(world);
      if (world.state.travel.stage === "preparingDeparture") prepTicks += 1;
      for (const actor of Object.values(world.state.actors)) {
        if (ashoreAtCourse.has(actor.id)) continue;
        // Nobody who was aboard at the course goes ashore on leave after it.
        expect(isOnShoreLeave(bundle, world.state, actor)).toBe(false);
      }
    }
    expect(world.state.deck.dock).toBeUndefined();
    expect(Object.values(world.state.social.sessions).some((s) => "postKey" in s.venue)).toBe(
      false,
    );
    const broughtAboard = events.filter(
      (e): e is Extract<SimEvent, { type: "broughtAboard" }> => e.type === "broughtAboard",
    );
    expect(broughtAboard.filter((e) => wentAshore.has(e.payload.actorId))).toEqual([]);
    // Prep, the walk back included, is over inside the recall's minute.
    const recall =
      world.config.values.travel.recallAboardSeconds * world.config.values.time.tickRate;
    expect(prepTicks).toBeLessThan(recall);
  });
});
