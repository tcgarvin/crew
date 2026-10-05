/**
 * Ambient chat moves affinity (slice 4, call 10): `onConversation(ctx, a, b)`, called by
 * `systems/work/ambient.ts` after it emits `conversation`: `social.chatAffinity` both ways unless
 * the pair's `lastChatTick` is within `social.chatAffinityEveryDays`.
 *
 * Owner: W2 of ship life slice 4. Gate stub: no-op.
 */
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";

export function onConversation(_ctx: StepCtx, _a: Actor, _b: Actor): void {}
