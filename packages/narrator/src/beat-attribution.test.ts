/**
 * §beat-attribution end to end: two narrator calls over the real kernel. The first call's card
 * lands its beat at the hook tick; its scheduled fault and its strike put their beats in motion,
 * and the second call stamps them landed when they fired: the strike at its `struck` event, the
 * fault (a trace event the client never keeps) at the tick the machine's fault says it broke. A strike
 * the kernel refused (its target already dead) puts its beat back to planned, and the second call
 * is told why.
 */
import {
  type Actor,
  type CommandId,
  type HookId,
  type NarratorHook,
  type SimEvent,
  type Tick,
  type World,
  createKernel,
  createRegistry,
  registerBodies,
  registerCommerce,
  registerEquipmentSystems,
  registerSocial,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorNotes, NarratorRequest } from "./contract";
import { FIXTURE_SCENARIO } from "./fixtures";
import { EMPTY_NOTES, EMPTY_PLAN, type PlannedBeat } from "./notes";
import { runNarratorWithTrace } from "./run";
import { content, emptyPlan, fakeTransport, okResult, runBothTurns } from "./test-support";

function realWorld() {
  const bundle = content();
  const registry = createRegistry();
  registerCommerce(registry);
  registerBodies(registry);
  registerEquipmentSystems(registry);
  registerSocial(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(FIXTURE_SCENARIO, 7, bundle, {
    values: bundle.config,
    hash: bundle.hash,
  });
  return { bundle, kernel, world };
}

type Kernel = ReturnType<typeof realWorld>["kernel"];

function quietHook(world: World, n: number): NarratorHook {
  return {
    id: `hook:plan:${n}` as HookId,
    kind: "quietTooLong",
    context: { quietSinceTick: 0 as Tick },
    tick: world.state.tick,
  };
}

/**
 * Run the sim until `done` holds, keeping the notable and narrative events as the client does for
 * the next call, and acknowledging any hook the sim raises on the way.
 */
function runUntil(
  kernel: Kernel,
  world: World,
  done: (events: readonly SimEvent[]) => boolean,
  maxTicks = 30_000,
): SimEvent[] {
  const kept: SimEvent[] = [];
  const start = world.state.tick;
  for (let i = 0; i < maxTicks && !done(kept) && world.state.tick - start < maxTicks; i++) {
    const { events, halt, ticksAdvanced } = kernel.advance(world, 50);
    if (ticksAdvanced === 0 && halt.kind === "completed") break;
    kept.push(...events.filter((e) => e.significance !== "trace"));
    const decision = world.state.decisions.queue[0];
    if (halt.kind === "decision" && decision !== undefined) {
      kernel.enqueueCommand(world, {
        id: `cmd:player:choose:${decision}` as CommandId,
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: decision, side: "left" },
        targetTick: world.state.tick + 1,
      });
    }
    const hook = world.state.narrator.pendingHook;
    if (hook !== undefined) {
      kernel.enqueueCommand(world, {
        id: `cmd:system:ack:${hook.id}` as CommandId,
        source: "system",
        kind: "acknowledgeHook",
        payload: { hookId: hook.id },
        targetTick: world.state.tick + 1,
      });
    }
  }
  return kept;
}

function beat(name: string, tension: PlannedBeat["tension"], decided: boolean): PlannedBeat {
  return {
    name,
    what: `${name}.`,
    tension,
    thread: "",
    decided,
    status: "planned",
    landedTick: null,
    inMotion: [],
  };
}

const NOTES: NarratorNotes = {
  ...EMPTY_NOTES,
  plan: {
    ...EMPTY_PLAN,
    episode: {
      premise: "A quiet leg turns on the pump and on Jax.",
      beats: [
        beat("The engineer's worry", "setup", false),
        beat("The pump goes", "rising", true),
        beat("Jax takes a fall", "turn", true),
        beat("A second fall", "peak", true),
      ],
      until: "",
      tempo: "steady",
      revised: "",
      revisions: 0,
      previousPremise: "",
      openedTick: 0,
    },
  },
};

describe("beats land when their card goes up and when their levers fire (§beat-attribution)", () => {
  it("stamps a card at the hook tick, a fault and a strike at the ticks they fired, and reverts a refused strike", async () => {
    const { bundle, kernel, world } = realWorld();
    const snapshot = kernel.serialize(world);
    const crew = Object.values(snapshot.state.actors).filter(
      (a: Actor) => a.crew && a.passenger !== true,
    );
    const [speaker, victim] = [crew[1], crew[0]];
    if (speaker === undefined || victim === undefined) throw new Error("no crew");
    const pump = Object.values(snapshot.state.machines).find(
      (m) => m.defId === "machine.coolant_pump",
    );
    if (pump === undefined) throw new Error("no pump");
    const strike = (beatName: string) => ({
      kind: "strike",
      beat: beatName,
      who: victim.name,
      severity: "grave",
      type: "blunt",
      part: "head",
      byWho: "",
      how: `${victim.name} falls from the hold ladder`,
    });
    const card = {
      kind: "surfaceDecision",
      beat: "The engineer's worry",
      title: "A noise in the pump",
      speaker: speaker.name,
      situation: `${speaker.name} wipes her hands. "Something in the coolant loop sounds wrong, Captain."`,
      left: { label: "Keep an eye on it", effect: "none", coursePort: "", talkWith: "", tone: "" },
      right: { label: "Probably nothing", effect: "none", coursePort: "", talkWith: "", tone: "" },
      leftAftermath: "She goes back below.",
      rightAftermath: "She shrugs and goes back below.",
      beatOfThread: "",
      closesThread: "",
    };
    const intents = [
      card,
      {
        kind: "scheduleFault",
        beat: "The pump goes",
        machine: pump.id,
        faultKey: "worn_bearing",
        window: "soon",
      },
      strike("Jax takes a fall"),
      strike("A second fall"),
    ];
    const firstHook = quietHook(world, 1);
    const first: NarratorRequest = { gameId: "g", hook: firstHook, snapshot, recentEvents: [] };
    const answer = okResult(JSON.stringify(emptyPlan({ intents: intents as never })));
    const firstReply = await runBothTurns(first, {
      gameId: "g",
      content: bundle,
      transport: fakeTransport(answer),
      notes: NOTES,
      callId: "call-a",
    });
    expect(firstReply.dropped).toEqual([]);
    const afterFirst = firstReply.notesUpdate?.plan.episode.beats ?? [];
    expect(afterFirst.map((b) => [b.name, b.status, b.landedTick, b.inMotion.length])).toEqual([
      ["The engineer's worry", "landed", firstHook.tick, 0],
      ["The pump goes", "planned", null, 1],
      ["Jax takes a fall", "planned", null, 1],
      ["A second fall", "planned", null, 1],
    ]);

    for (const command of firstReply.commands) {
      expect(kernel.enqueueCommand(world, command).status).toBe("accepted");
    }
    const faultId = firstReply.commands.find((c) => c.kind === "scheduleFault")?.id;
    // A fault that breaks is a trace event (the crew have not noticed it), so the client never
    // keeps it: the beat lands from the fault the machine now carries.
    const faultTick = () =>
      Object.values(world.state.machines)
        .flatMap((m) => m.faults)
        .find((f) => f.causeCommandId === faultId)?.sinceTick;
    const events = runUntil(kernel, world, () => faultTick() !== undefined);
    const fired = (type: string, id: string | undefined) =>
      events.find((e) => e.type === type && e.causeIds.includes(id as CommandId))?.tick;
    const [firstStrike, secondStrike] = firstReply.commands.filter((c) => c.kind === "strike");
    expect(fired("struck", firstStrike?.id)).toBeDefined();
    expect(fired("commandRejected", secondStrike?.id)).toBeDefined();
    expect(faultTick()).toBeDefined();

    const second: NarratorRequest = {
      gameId: "g",
      hook: quietHook(world, 2),
      snapshot: kernel.serialize(world),
      recentEvents: events,
    };
    const run = await runNarratorWithTrace(second, {
      gameId: "g",
      content: bundle,
      transport: fakeTransport(okResult(JSON.stringify(emptyPlan()))),
      notes: firstReply.notesUpdate,
      callId: "call-b",
    });
    const stamped = run.response.notesUpdate?.plan.episode.beats ?? [];
    expect(stamped.map((b) => [b.name, b.status, b.landedTick, b.inMotion.length])).toEqual([
      ["The engineer's worry", "landed", firstHook.tick, 0],
      ["The pump goes", "landed", faultTick(), 0],
      ["Jax takes a fall", "landed", fired("struck", firstStrike?.id), 0],
      ["A second fall", "planned", null, 0],
    ]);
    expect(run.trace.digest).toContain(
      'rejected last time: beat "A second fall": your strike for it did not land (the sim refused it); the beat is planned again',
    );
    expect(run.trace.digest).toContain('You are at peak (tempo: steady): "A second fall".');
  });
});
