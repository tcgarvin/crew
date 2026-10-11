/**
 * Social life (slice 4): relationships (§memories), outcomes and rivalries, ambient chat, seats and
 * the captain's table. Register after `registerRecreation` (same phase).
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { fallOut, giveThought, plantMemory } from "./levers";
import { socialSystem } from "./social";

/** The social system and the narrator's social levers (§memory-levers). */
export function registerSocial(registry: KernelRegistry): Unregister {
  const unregister = [
    registry.registerSystem(socialSystem),
    registry.registerCommandHandler("plantMemory", plantMemory),
    registry.registerCommandHandler("fallOut", fallOut),
    registry.registerCommandHandler("giveThought", giveThought),
  ];
  return () => {
    for (const undo of unregister) undo();
  };
}

export { onConversation } from "./chat";
export { resolveOutcome } from "./outcomes";
export { fallOut, giveThought, plantMemory } from "./levers";
export { addMemory, isLasting, pruneSocial } from "./relationships";
export { type SeatOption, seatPreference } from "./seating";
export { SOCIAL_EVERY_TICKS, socialSystem } from "./social";
