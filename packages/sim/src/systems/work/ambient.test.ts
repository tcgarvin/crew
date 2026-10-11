/**
 * §ambient-chat: who chats and which lines come up. Nobody in a fight or in the party of an
 * expedition under way starts or joins a chat, nor do the cast; the docking-fee complaint comes up
 * only where the ship paid the fee at this docking.
 */
import { describe, expect, it } from "vitest";
import { allocateId } from "../../core/ids";
import type { Combatant } from "../../core/types/actor";
import type { ChatLineDef } from "../../core/types/content";
import type { ActorId, PortDefId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { StepCtx } from "../../core/types/pipeline";
import type { ExpeditionPhase } from "../../core/types/state";
import { galleyStepCtx } from "../galley/fixtures/galley-deck";
import { ambientChatSystem } from "./ambient";
import { JON, MARA, crewWorld, place } from "./fixtures/crew-deck";

const FEE_LINE = "{b} complained about the docking fee";
const GATED_FEE: ChatLineDef = { line: FEE_LINE, when: "paidDockingFee" };

/** Mara and Jon side by side on the deck, both free to chat. */
function pairWorld(): World {
  const { world } = crewWorld();
  place(world, MARA, { x: 2, y: 2 });
  place(world, JON, { x: 3, y: 2 });
  return world;
}

function actorOf(world: World, id: ActorId) {
  const actor = world.state.actors[id];
  if (actor === undefined) throw new Error(`no actor ${id}`);
  return actor;
}

/** One ambient-chat pass under these template lines; the lines said, in order. */
function chatPass(
  world: World,
  templateLines: readonly ChatLineDef[] = ["{a} joked about the food"],
  content: StepCtx["content"] = world.content,
): string[] {
  const { ctx, drafts } = galleyStepCtx(world);
  const social = { ...ctx.config.social, templateLines };
  ambientChatSystem.run({ ...ctx, content, config: { ...ctx.config, social } });
  return drafts
    .filter((draft) => draft.type === "conversation")
    .map((draft) => (draft.payload as { line: string }).line);
}

function underWay(world: World, phase: ExpeditionPhase, party: readonly ActorId[]): void {
  const travel = world.state.travel;
  if (travel.stage !== "docked") throw new Error("fixture changed: not docked");
  world.state.expedition = {
    siteId: travel.portId,
    phase,
    party: [...party],
    leaderId: party[0] ?? MARA,
    startedTick: 0,
    shots: 0,
  };
}

function fighter(side: Combatant["side"]): Combatant {
  return {
    side,
    disposition: { part: "ally", resolveBase: 1, loyalty: 1, wants: "nothing" },
    state: "steady",
    resolve: 1,
    lastDecidedTick: 0,
  };
}

function payDockingFee(world: World): void {
  const id = allocateId(world.state, "transaction");
  world.state.money.transactions[id] = { id, tick: world.state.tick, amount: -5, reason: "fee" };
}

/** The content with the port the ship lies at made a landing site. */
function atSite(world: World): StepCtx["content"] {
  const travel = world.state.travel;
  if (travel.stage !== "docked") throw new Error("fixture changed: not docked");
  const portId: PortDefId = travel.portId;
  const port = world.content.ports[portId];
  if (port === undefined) throw new Error("fixture changed: no port");
  return {
    ...world.content,
    ports: { ...world.content.ports, [portId]: { ...port, kind: "site" } },
  };
}

describe("who chats (§ambient-chat)", () => {
  it("two crew side by side chat when nothing holds them", () => {
    expect(chatPass(pairWorld())).toHaveLength(1);
  });

  it("the party never chats while the expedition is under way, in any phase", () => {
    for (const phase of ["mustering", "walkingOut", "approach", "fight"] as const) {
      const world = pairWorld();
      underWay(world, phase, [MARA, JON]);
      expect(chatPass(world), phase).toEqual([]);
    }
  });

  it("a party member neither starts nor joins a chat with a crewmate left aboard", () => {
    const world = pairWorld();
    underWay(world, "approach", [MARA]);
    expect(chatPass(world)).toEqual([]);
  });

  it("the party chat again once the expedition is resolved", () => {
    const world = pairWorld();
    underWay(world, "resolved", [MARA, JON]);
    expect(chatPass(world)).toHaveLength(1);
  });

  it("a fighter on either side never chats, nor do the cast", () => {
    const fighting = pairWorld();
    actorOf(fighting, MARA).combatant = fighter("us");
    expect(chatPass(fighting)).toEqual([]);

    const cast = pairWorld();
    for (const id of [MARA, JON]) {
      const actor = actorOf(cast, id);
      actor.crew = false;
      actor.combatant = fighter("them");
    }
    expect(chatPass(cast)).toEqual([]);
  });
});

describe("the docking-fee line (§ambient-chat)", () => {
  it("does not come up at the port a run starts at, where no fee was paid", () => {
    expect(chatPass(pairWorld(), [GATED_FEE])).toEqual([]);
  });

  it("comes up docked at a port where the ship paid the fee", () => {
    const world = pairWorld();
    payDockingFee(world);
    expect(chatPass(world, [GATED_FEE])).toEqual([
      expect.stringContaining("complained about the docking fee"),
    ]);
  });

  it("never comes up at a landing site, whatever fees are on the books", () => {
    const world = pairWorld();
    payDockingFee(world);
    const site = atSite(world);
    expect(chatPass(world, [GATED_FEE], site)).toEqual([]);
    expect(chatPass(world, ["{a} joked about the food", GATED_FEE], site)).toEqual([
      expect.stringContaining("joked about the food"),
    ]);
  });
});
