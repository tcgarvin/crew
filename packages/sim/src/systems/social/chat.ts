/**
 * Ambient chat leaves memories (slice 4, call 10; §ambient-chat): `onConversation(ctx, a, b)`,
 * called by `systems/work/ambient.ts` after it emits `conversation`. Unless the pair's last
 * memorable chat (`lastChatTick`, either side) is within `social.chatMemoryEveryDays`, each side
 * remembers it: `rubbedWrong` with the chance `social.chatSour` gives the pair's compatibility,
 * else `chatted`. The sides roll apart, so one can enjoy a talk the other found grating, and a pair
 * that does not click cools by talking. Members of a running session still chat: that is the table
 * talk.
 *
 * Owner: W2 of ship life slice 4.
 */
import { dayTicks } from "../../core/clock";
import { compatibility } from "../../core/social";
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import { addMemory, relationshipOf } from "./relationships";

export function onConversation(ctx: StepCtx, a: Actor, b: Actor): void {
  const social = ctx.config.social;
  const ab = relationshipOf(ctx, a.id, b.id);
  const ba = relationshipOf(ctx, b.id, a.id);
  const every = dayTicks(ctx.config, social.chatMemoryEveryDays);
  const recent = (last: number | undefined) => last !== undefined && ctx.tick - last < every;
  if (recent(ab.lastChatTick) || recent(ba.lastChatTick)) return;
  ab.lastChatTick = ctx.tick;
  ba.lastChatTick = ctx.tick;
  const pair = compatibility(a, b, social.compatibility);
  const sour = Math.max(0, Math.min(1, social.chatSour.atZero - social.chatSour.perPoint * pair));
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    addMemory(ctx, from.id, to.id, ctx.rng.chance("social", sour) ? "rubbedWrong" : "chatted");
  }
}
