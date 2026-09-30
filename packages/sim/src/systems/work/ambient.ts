/**
 * Ambient chat (PLAN §6 W4a item 5), phase 6, every 20 ticks: two awake crew who are not working
 * a task, within `social.chatRadiusTiles` of each other and both past their chat cooldown, have
 * a one-line conversation that shows in the ticker (`conversation`, notable). No relationship
 * effects in V1; the `socialize` hold is what actually meets the social need.
 *
 * Tunables come from `config.social` (Integration 2 made it required). `AMBIENT_FALLBACK` is
 * kept as a reference value for fixtures. Speaker/listener order alternates by pass so the
 * lowest ID does not always speak.
 */
import { configTicks } from "../../core/clock";
import type { Actor } from "../../core/types/actor";
import type { ConfigDef } from "../../core/types/content";
import type { StepCtx, System } from "../../core/types/pipeline";
import { isAsleep } from "./activity";

export const AMBIENT_EVERY_TICKS = 20;

export const AMBIENT_FALLBACK: ConfigDef["social"] = {
  chatRadiusTiles: 2,
  chatCooldownSeconds: 45,
  templateLines: [
    "{a} joked about the food",
    "{b} complained about the docking fee",
    "{a} asked {b} whether the coolant pump always sounds like that",
    "{a} and {b} argued about the fastest route home",
    "{a} told {b} a story about an old captain",
    "{a} and {b} swapped gossip from the last port",
    "{b} laughed at {a}'s joke about the engine",
    "{a} wondered aloud what the next job pays",
  ],
};

function eligible(ctx: StepCtx, actor: Actor, cooldownTicks: number): boolean {
  if (!actor.crew || actor.availability !== "available" || actor.location.kind !== "onDeck")
    return false;
  if (actor.activity.kind === "task" || isAsleep(actor.activity)) return false;
  const last = actor.lastConversationTick;
  return last === undefined || ctx.tick - last >= cooldownTicks;
}

function withinRadius(a: Actor, b: Actor, radius: number): boolean {
  if (a.location.kind !== "onDeck" || b.location.kind !== "onDeck") return false;
  if (a.location.deckId !== b.location.deckId) return false;
  const dx = a.location.x - b.location.x;
  const dy = a.location.y - b.location.y;
  return dx * dx + dy * dy <= radius * radius;
}

export const ambientChatSystem: System = {
  name: "work.ambientChat",
  phase: "perception",
  every: AMBIENT_EVERY_TICKS,
  run(ctx) {
    const social = ctx.config.social;
    if (social.templateLines.length === 0) return;
    const cooldown = configTicks(ctx.config, social.chatCooldownSeconds);
    const pool = Object.values(ctx.state.actors).filter((a) => eligible(ctx, a, cooldown));
    const talked = new Set<Actor["id"]>();
    const flip = (ctx.tick / AMBIENT_EVERY_TICKS) % 2 === 1;
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const first = pool[i] as Actor;
        const second = pool[j] as Actor;
        if (talked.has(first.id) || talked.has(second.id)) continue;
        if (!withinRadius(first, second, social.chatRadiusTiles)) continue;
        const [a, b] = flip ? [second, first] : [first, second];
        const template = ctx.rng.pick("social", social.templateLines);
        const line = template.replaceAll("{a}", a.name).replaceAll("{b}", b.name);
        ctx.emit({
          type: "conversation",
          subjectIds: [a.id, b.id],
          causeIds: [],
          source: "sim",
          payload: { line },
        });
        a.lastConversationTick = ctx.tick;
        b.lastConversationTick = ctx.tick;
        talked.add(a.id);
        talked.add(b.id);
      }
    }
  },
};
