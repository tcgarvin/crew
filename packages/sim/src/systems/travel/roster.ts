/**
 * Command perspective (D8, PLAN §6 W6 item 6): who the player is currently seeing/acting as. The
 * rule lives in `core/command-actor.ts` (§looking-for-work) so the kernel's own decision code
 * shares it; this module keeps the systems' import path.
 */
export { commandActor, isFitForCommand } from "../../core/command-actor";
