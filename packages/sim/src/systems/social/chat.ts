/**
 * Ambient chat moves affinity (slice 4, call 10): `onConversation(ctx, a, b)`, called by
 * `systems/work/ambient.ts` after it emits `conversation`: `social.chatAffinity` both ways unless
 * the pair's last affinity-moving chat (`lastChatTick`, either side) is within
 * `social.chatAffinityEveryDays`. Members of a running session still chat: that is the table talk.
 *
 * Owner: W2 of ship life slice 4.
 */
import { dayTicks } from "../../core/clock";
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import { moveAffinity, relationshipOf } from "./relationships";

export function onConversation(ctx: StepCtx, a: Actor, b: Actor): void {
  const { chatAffinity, chatAffinityEveryDays } = ctx.config.social;
  const ab = relationshipOf(ctx, a.id, b.id);
  const ba = relationshipOf(ctx, b.id, a.id);
  const every = dayTicks(ctx.config, chatAffinityEveryDays);
  const recent = (last: number | undefined) => last !== undefined && ctx.tick - last < every;
  if (recent(ab.lastChatTick) || recent(ba.lastChatTick)) return;
  ab.lastChatTick = ctx.tick;
  ba.lastChatTick = ctx.tick;
  moveAffinity(ctx, a.id, b.id, chatAffinity);
  moveAffinity(ctx, b.id, a.id, chatAffinity);
}
