/**
 * Ambient chat (PLAN §6 W4a item 5), phase 6, every 20 ticks: two awake crew who are not working
 * a task, within `social.chatRadiusTiles` of each other and both past their chat cooldown, have
 * a one-line conversation that shows in the ticker (`conversation`, notable). Slice 4: the social
 * system's `onConversation` leaves the pair memories (D88); the `socialize` hold is what actually
 * meets the social need.
 *
 * Tunables come from `config.social` (Integration 2 made it required). `AMBIENT_FALLBACK` is
 * kept as a reference value for fixtures. Speaker/listener order alternates by pass so the
 * lowest ID does not always speak.
 */
import { configTicks } from "../../core/clock";
import type { Actor } from "../../core/types/actor";
import type { ConfigDef } from "../../core/types/content";
import type { StepCtx, System } from "../../core/types/pipeline";
import { onConversation } from "../social/chat";
import { isAsleep } from "./activity";
import { emitSim } from "./events";

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
  chatMemoryEveryDays: 2,
  chatSour: { atZero: 0.25, perPoint: 0.1 },
  compatibility: { base: 2, perValuePoint: 0.5, perSharedLike: 1, perClash: 1, range: 2 },
  memories: {
    chatted: { label: "a good chat", opinion: 1, durationDays: 5, stackLimit: 2 },
    rubbedWrong: { label: "got on my nerves", opinion: -1, durationDays: 5, stackLimit: 2 },
    goodTime: { label: "a good time together", opinion: 1, durationDays: 3, stackLimit: 2 },
    beatMe: { label: "beat me", opinion: -1, durationDays: 3, stackLimit: 2 },
    keepsBeatingMe: { label: "keeps beating me", opinion: -1, durationDays: 3, stackLimit: 1 },
    goodTalk: { label: "a good talk", opinion: 2, durationDays: 5, stackLimit: 1 },
    argued: { label: "an argument", opinion: -2, durationDays: 5, stackLimit: 2 },
    playedForMe: { label: "played for me", opinion: 1, durationDays: 3, stackLimit: 1 },
    sharedATable: { label: "shared a table", opinion: 1, durationDays: 5, stackLimit: 1 },
    heardMeOut: { label: "heard me out", opinion: 2, durationDays: 7, stackLimit: 1 },
    dressedMeDown: { label: "dressed me down", opinion: -2, durationDays: 7, stackLimit: 1 },
    talkedItThrough: { label: "talked it through", opinion: 1, durationDays: 7, stackLimit: 1 },
  },
  affinityRange: 10,
  avoidBelow: -3,
  preferAbove: 0,
  rivalry: { streakFor: 3 },
  debate: { agreeWithin: 2, argueBeyond: 4 },
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
        emitSim(ctx, "conversation", [a.id, b.id], { line });
        // Slice 4 (call 10; D88): a chat leaves each side a memory of the other.
        onConversation(ctx, a, b);
        a.lastConversationTick = ctx.tick;
        b.lastConversationTick = ctx.tick;
        talked.add(a.id);
        talked.add(b.id);
      }
    }
  },
};
