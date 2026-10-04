/**
 * Core kernel (W2): world, clock, ids, rng, events, the tick pipeline, commands, caches,
 * invariants and serialize/restore/migrate. Contracts are in `./types`.
 */
export * from "./types";
export { actionLabel, describeEvent, getRenderFrame } from "./render";
export { configTicks, ticksToSeconds } from "./clock";
export { enqueueCommand, ok, reject, type Validation } from "./commands";
export { findItemDef } from "./defs";
export {
  type BerthedDock,
  berthDock,
  berthPlacement,
  deckToDock,
  dockAlongside,
  dockAreaTiles,
  dockFloorMask,
  dockForPort,
  expectedDock,
  isInDockArea,
  isOnDock,
} from "./docks";
export { basePriceFor, effectiveMarket } from "./markets";
export { floorSet } from "./floor-set";
export { clearDockside, dressDock, personnelRampFoot } from "./locals";
export { decisionShownTick, localNamed } from "./delivery";
export { allocateId } from "./ids";
export { checkInvariants } from "./invariants";
export { createKernel, kernel } from "./kernel";
export { createRegistry, type KernelRegistry, NotImplementedError } from "./registry";
export { createRngApi, seedAllStreams, seedStream } from "./rng";
export { migrateState, migrations, restore, serialize } from "./save";
export { advance, createWorld, haltReason } from "./world";
