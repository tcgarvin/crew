/**
 * Expeditions A1 (W2's real-content fixture for the fight's tests): the default game on the full
 * registry, set down at the Boathouse at tick 0 with a plan, run until the expedition resolves,
 * and the fight's tally read back. The sim's own tests cannot import `@crew/content`, so the
 * Boathouse fights live here. The registry is the pacing one, so damage is the real `applyDamage`.
 */
import {
  type ActorId,
  type CommandId,
  type PortDefId,
  type SiteCastEntryDef,
  type World,
  createKernel,
} from "@crew/sim";
import { createPacingRegistry, loadPacingContent } from "./pacing";

export const BOATHOUSE = "port.boathouse" as PortDefId;

/** One fight's record. */
export interface FightRecord {
  readonly plan: string;
  readonly seed: number;
  readonly outcome: string;
  /** Seconds from the start command to contact (undefined: never noticed). */
  readonly toContact?: number;
  /** Seconds from contact (or the approach) to resolution, as `expeditionResolved` says. */
  readonly seconds: number;
  readonly shotsUs: number;
  readonly shotsThem: number;
  readonly woundsUs: number;
  readonly woundsThem: number;
  readonly deadUs: number;
  readonly deadThem: number;
  readonly downUs: number;
  /** The objective was held before anyone noticed the party. */
  readonly quiet: boolean;
  readonly fled: readonly string[];
  readonly surrendered: readonly string[];
  readonly lines: readonly string[];
  readonly world: World;
}

/** The default cast's variants (the plan's "The Boathouse"). */
export function castVariant(
  base: readonly SiteCastEntryDef[],
  variant: "default" | "shaky" | "hard",
): readonly SiteCastEntryDef[] {
  if (variant === "default") return base;
  return base.map((entry) => {
    if (entry.part !== "guard") return entry;
    if (variant === "shaky") return { ...entry, resolve: "shaky", tie: "paid" };
    return { ...entry, resolve: "hard", tie: "devoted", arms: "blaster" };
  });
}

/** Run one fight at the Boathouse under `plan` to its resolution (or `capSeconds`). */
export function runFight(
  plan: string,
  seed: number,
  options: { readonly cast?: "default" | "shaky" | "hard"; readonly capSeconds?: number } = {},
): FightRecord {
  const { bundle, config, scenarioId } = loadPacingContent();
  const kernel = createKernel(createPacingRegistry());
  const world = kernel.createWorld(scenarioId, seed, bundle, config);
  const site = bundle.docks?.["dock.boathouse" as keyof typeof bundle.docks];
  const cast = castVariant(site?.defaultCast ?? [], options.cast ?? "default");
  const started = kernel.enqueueCommand(world, {
    id: `cmd:fight:${seed}` as CommandId,
    source: "scenario",
    kind: "scenarioStartExpedition",
    payload: { siteId: BOATHOUSE, plan, cast },
  });
  if (started.status !== "accepted") throw new Error(`start refused: ${JSON.stringify(started)}`);
  const rate = world.config.values.time.tickRate;
  const cap = Math.round((options.capSeconds ?? 400) * rate);
  let contactTick: number | undefined;
  let resolved:
    | {
        seconds: number;
        outcome: string;
        woundsUs: number;
        woundsThem: number;
        deadUs: number;
        deadThem: number;
      }
    | undefined;
  let shotsUs = 0;
  let shotsThem = 0;
  let acks = 0;
  const fled: string[] = [];
  const surrendered: string[] = [];
  const lines: string[] = [];
  const party = new Set<string>();
  for (let t = 0; t < cap && resolved === undefined; ) {
    const result = kernel.advance(world, 20);
    t += Math.max(1, result.ticksAdvanced);
    for (const event of result.events) {
      if (event.type === "expeditionStarted") for (const id of event.payload.party) party.add(id);
      if (event.type === "expeditionContact") contactTick = event.tick;
      if (event.type === "shotFired") {
        if (party.has(event.payload.byActorId)) shotsUs += 1;
        else shotsThem += 1;
      }
      if (event.type === "combatantBroke" && event.payload.side === "them") {
        const name = world.state.actors[event.payload.actorId]?.name ?? event.payload.actorId;
        (event.payload.how === "fled" ? fled : surrendered).push(name);
      }
      if (event.significance !== "trace") lines.push(`${event.tick} ${event.type}`);
      if (event.type === "expeditionResolved") {
        resolved = event.payload;
      }
    }
    const hookId = world.state.narrator.pendingHook?.id;
    if (hookId !== undefined) {
      acks += 1;
      kernel.enqueueCommand(world, {
        id: `cmd:fight:ack:${acks}` as CommandId,
        source: "system",
        kind: "acknowledgeHook",
        payload: { hookId },
      });
    }
  }
  const members = [...party].map((id) => world.state.actors[id as ActorId]);
  const expedition = world.state.expedition;
  const objective = expedition?.objectiveTick;
  const contact = expedition?.fightStartedTick;
  return {
    plan,
    seed,
    outcome: resolved?.outcome ?? "unresolved",
    ...(contactTick === undefined ? {} : { toContact: contactTick / rate }),
    seconds: resolved?.seconds ?? Number.NaN,
    shotsUs,
    shotsThem,
    woundsUs: resolved?.woundsUs ?? 0,
    woundsThem: resolved?.woundsThem ?? 0,
    deadUs: resolved?.deadUs ?? 0,
    deadThem: resolved?.deadThem ?? 0,
    quiet: objective !== undefined && (contact === undefined || objective < contact),
    downUs: members.filter((a) => a?.availability === "incapacitated").length,
    fled,
    surrendered,
    lines,
    world,
  };
}
