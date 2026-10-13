/**
 * §fragile-cargo: a rock that strikes a compartment holding fragile crates of a live freight job
 * may smash them. Each such crate (lying on the deck there, or carried by someone standing there)
 * breaks with `field.fragileBreakChance[rock]`, drawn on the `failures` stream, the field's own;
 * nothing is drawn when the room holds none, so a run without fragile freight draws as before.
 * A smashed crate is marked `broken` and still delivered; the pay is docked at delivery
 * (`deliveredPay`, `commerce/jobs.ts`).
 */
import type { DeepReadonly, PhysicalLocation, TileCoord } from "../../core/types/common";
import type { RockSize } from "../../core/types/content";
import type { CompartmentId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { ActiveField } from "../../core/types/state";
import type { Job } from "../../core/types/travel";
import { shipDeckId } from "../../core/world";
import { compartmentTiles } from "./impacts";

/** A freight job still being carried: taken and not yet paid. Passages and errands never are. */
function liveFreight(job: DeepReadonly<Job> | undefined): boolean {
  if (job === undefined || job.passage !== undefined || job.errand !== undefined) return false;
  return job.status === "accepted" || job.status === "inTransit" || job.status === "delivered";
}

/** The ship-deck tile an item lies on, or the tile of whoever holds it; none off the deck. */
function deckTileOf(
  ctx: Pick<StepCtx, "state">,
  location: DeepReadonly<PhysicalLocation>,
): TileCoord | undefined {
  const deckId = shipDeckId(ctx.state);
  const at =
    location.kind === "carriedBy" || location.kind === "equippedBy"
      ? ctx.state.actors[location.actorId]?.location
      : location;
  if (at?.kind !== "onDeck" || at.deckId !== deckId) return undefined;
  return { x: Math.floor(at.x), y: Math.floor(at.y) };
}

/** The intact fragile crates of live freight jobs in `compartmentId`, in id order. */
export function fragileCratesIn(
  ctx: Pick<StepCtx, "state" | "content" | "defs">,
  compartmentId: CompartmentId,
): Item[] {
  const room = new Set(compartmentTiles(ctx, compartmentId).map((t) => `${t.x},${t.y}`));
  return Object.values(ctx.state.items)
    .filter((item) => {
      if (item.jobId === undefined || item.broken === true) return false;
      if (!liveFreight(ctx.state.jobs[item.jobId])) return false;
      if (ctx.defs.item(item.defId).cargoClass !== "fragile") return false;
      const tile = deckTileOf(ctx, item.location);
      return tile !== undefined && room.has(`${tile.x},${tile.y}`);
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Roll each fragile crate in the struck compartment; smash those that lose (`cargoBroken`). */
export function breakFragileCargo(
  ctx: StepCtx,
  field: ActiveField,
  compartmentId: CompartmentId,
  rock: RockSize,
): void {
  const chance = ctx.config.field.fragileBreakChance[rock];
  for (const item of fragileCratesIn(ctx, compartmentId)) {
    if (!ctx.rng.chance("failures", chance)) continue;
    const jobId = item.jobId;
    if (jobId === undefined) throw new Error(`breakFragileCargo: ${item.id} has no job`);
    item.broken = true;
    ctx.emit({
      type: "cargoBroken",
      subjectIds: [item.id, jobId, field.id],
      causeIds: [],
      source: "sim",
      locationRef: { kind: "compartment", compartmentId },
      payload: { jobId, itemId: item.id, compartmentId },
    });
  }
}
