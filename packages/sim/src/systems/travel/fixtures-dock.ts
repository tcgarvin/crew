/**
 * §dock-alongside test fixture: the furnished crew deck (`work/fixtures/crew-deck.ts`) with the
 * spike's two south ramps, the spike's quay as the dock at the start port (`TINY.port`), a copy of
 * it at `TINY.port2`, and none at `TINY.port3`. Spatial, needs, work, the planner and travel are
 * registered, so departure prep's call aboard runs through the real work system.
 *
 * Deck (12×8) rows 5–6 are the corridor; the cargo ramp is under (2,6), the personnel ramp under
 * (9,6). Docked, the quay's landings are deck (2,7) and (9,7), and it reaches fore of the bow to
 * deck x = −2 (`DOCK.foreQuay`).
 */
import type { TestWorld } from "../../core/fixtures/test-world";
import { TINY, tinyEffectiveConfig } from "../../core/fixtures/tiny-content";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import type { ConfigDef, ContentBundle, DockDef } from "../../core/types/content";
import type { CommandId, DockDefId, PortDefId } from "../../core/types/ids";
import { registerPlannerDefaults } from "../../planner/index";
import { registerNeeds } from "../needs/index";
import { DECK12 } from "../spatial/fixtures/deck-12x8";
import { QUAY, withRamps } from "../spatial/fixtures/dock";
import { registerSpatial } from "../spatial/index";
import { ALL_DERIVATIONS, CREW, crewConfig, crewContent } from "../work/fixtures/crew-deck";
import { registerWork } from "../work/index";
import { registerTravel } from "./index";

export const HOME_DOCK: DockDef = { ...QUAY, portId: TINY.port };
export const FAR_DOCK: DockDef = {
  ...QUAY,
  id: "dock.test.far" as DockDefId,
  portId: TINY.port2,
  name: "Far quay",
};

/** Fast travel so a round trip fits in a few hundred ticks. */
export function docksideConfig(travel: Partial<ConfigDef["travel"]> = {}): ConfigDef {
  const base = crewConfig();
  return { ...base, travel: { ...base.travel, nominalSpeed: 30, ...travel } };
}

export function docksideContent(config: ConfigDef = docksideConfig()): ContentBundle {
  const base = crewContent(config);
  const deck = base.decks[DECK12.deck];
  if (deck === undefined) throw new Error("crew deck fixture lost its deck");
  return {
    ...base,
    decks: { [DECK12.deck]: withRamps(deck) },
    docks: { [HOME_DOCK.id]: HOME_DOCK, [FAR_DOCK.id]: FAR_DOCK },
    hash: "dockside-v1",
  };
}

export function docksideWorld(config: ConfigDef = docksideConfig()): TestWorld {
  const registry = createRegistry();
  registerSpatial(registry);
  registerTravel(registry);
  registerNeeds(registry);
  registerWork(registry, { derivations: ALL_DERIVATIONS });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    CREW.scenario2,
    11,
    docksideContent(config),
    tinyEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

let n = 0;

/** Acknowledge whatever hook is pending, as the narrator host would. */
export function ackHook({ kernel, world }: TestWorld): void {
  const hookId = world.state.narrator.pendingHook?.id;
  if (hookId === undefined) return;
  n += 1;
  kernel.enqueueCommand(world, {
    id: `cmd:dockside:ack:${n}` as CommandId,
    source: "system",
    kind: "acknowledgeHook",
    payload: { hookId },
  });
}

export function setCourse({ kernel, world }: TestWorld, to: PortDefId): void {
  n += 1;
  const result = kernel.enqueueCommand(world, {
    id: `cmd:dockside:course:${n}` as CommandId,
    source: "player",
    kind: "setCourse",
    payload: { destinationPortId: to },
  });
  if (result.status !== "accepted")
    throw new Error(`setCourse rejected: ${JSON.stringify(result)}`);
}
