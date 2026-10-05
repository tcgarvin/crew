/**
 * Social life (slice 4): relationships, outcomes and rivalries, ambient affinity, seats and the
 * captain's table. Register after `registerRecreation` (same phase).
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { socialSystem } from "./social";

export function registerSocial(registry: KernelRegistry): Unregister {
  return registry.registerSystem(socialSystem);
}

export { onConversation } from "./chat";
export { resolveOutcome } from "./outcomes";
export { moveAffinity, pruneSocial } from "./relationships";
export { type SeatOption, seatPreference } from "./seating";
export { SOCIAL_EVERY_TICKS, socialSystem } from "./social";
