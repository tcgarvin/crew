import { blastTiles, hullFootprint } from "../../core/hull";
/**
 * §rock-impacts: the rocks (slice 5 calls 2, 5, 6, 8, 17, 20). While the ship is in an active
 * field, rocks arrive as a Poisson process on the `failures` stream, one draw a tick, at the
 * severity's `impactsPerMinute` times the helm's factor (`1 − helmThreading × skill/10` with
 * someone at the helm, `unmannedRateFactor` with nobody) times `stuckRateFactor` while stuck. A
 * scripted impact lands at its second; so that it replaces a random one rather than adding to them,
 * the random rate is thinned by the scripted impacts' share of the field's expected count (a light
 * field expects three rocks: three scripted ones leave no random ones).
 *
 * An impact's centre is uniform over the deck's hull footprint (a scripted one: the tile, a tile
 * of the compartment, or a footprint tile of the machine); a `large` rock's blast is the centre
 * and its eight neighbours on the hull. The hull is charged once and the scar written
 * (`hull.ts`), then the machines in the blast take their effects (`effects.ts`), then fragile
 * freight in the struck room may smash (`cargo.ts`, §fragile-cargo), then damage
 * response hears of it (`onImpact`, W2), then `asteroidImpact` and each `machineKnockedOut`.
 * Anyone standing on a blast tile has a near miss (a `nearMiss` thought and event, call 17); then
 * crew unbraced in the struck room may be thrown off their feet (§accidents-aboard).
 *
 * Owner: W1 of ship life slice 5.
 */
import { addThought } from "../../core/thoughts";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { DeckDef, FieldSeverity, MachineEffect, RockSize } from "../../core/types/content";
import type { CompartmentId } from "../../core/types/ids";
import type { RngApi, StepCtx } from "../../core/types/pipeline";
import type { ActiveField, ImpactTarget, ScriptedImpact } from "../../core/types/state";
import { shipDeckId } from "../../core/world";
import { thrownByImpact } from "../bodies/accidents";
import { onImpact } from "../damage/machines";
import { breakFragileCargo } from "./cargo";
import { type MachineHit, hitMachines, machineFootprintTiles } from "./effects";
import { chargeHull, loseShipIfSunk } from "./hull";

/** One impact about to land. */
export interface ImpactSpec {
  readonly centre: TileCoord;
  readonly rock: RockSize;
  /** The scripted effect for every machine in the blast; absent: each rolls its own. */
  readonly effect?: MachineEffect;
  readonly scripted: boolean;
}

/** What the helm is doing about the rocks: the stander's piloting, or nobody there. */
export type HelmAtField = { readonly manned: true; readonly piloting: number } | { manned: false };

/** The helm's factor on the rate (call 8). */
export function helmRateFactor(config: StepCtx["config"], helm: HelmAtField): number {
  const field = config.field;
  if (!helm.manned) return field.unmannedRateFactor;
  const skill = Math.min(10, Math.max(0, helm.piloting));
  return 1 - field.helmThreading * (skill / 10);
}

/**
 * Random impacts per minute right now: the severity's rate, the helm's factor, stuck, and the
 * thinning that lets the scripted impacts stand in for random ones.
 */
export function randomImpactRate(
  config: StepCtx["config"],
  severity: FieldSeverity,
  helm: HelmAtField,
  stuck: boolean,
  scriptedCount: number,
): number {
  const { impactsPerMinute, lengthSeconds } = config.field.severities[severity];
  const expected = (impactsPerMinute * lengthSeconds) / 60;
  const thinning = expected > 0 ? Math.max(0, 1 - scriptedCount / expected) : 0;
  const stuckFactor = stuck ? config.field.stuckRateFactor : 1;
  return impactsPerMinute * helmRateFactor(config, helm) * stuckFactor * thinning;
}

/** The chance of at least one arrival in `seconds` at `perMinute` (Poisson). */
export function arrivalChance(perMinute: number, seconds: number): number {
  return 1 - Math.exp((-perMinute / 60) * seconds);
}

/** A rock's size: the scripted one, else drawn by the severity's `largeShare`. */
export function drawRock(
  rng: Pick<RngApi, "float">,
  config: StepCtx["config"],
  severity: FieldSeverity,
): RockSize {
  return rng.float("failures") < config.field.severities[severity].largeShare ? "large" : "small";
}

/** A random impact's centre: uniform over the hull footprint (call 5). */
export function randomCentre(rng: Pick<RngApi, "int">, footprint: readonly TileCoord[]): TileCoord {
  if (footprint.length === 0) throw new Error("randomCentre: the deck has no hull footprint");
  const tile = footprint[rng.int("failures", 0, footprint.length - 1)];
  if (tile === undefined) throw new Error("randomCentre: index out of the footprint");
  return tile;
}

/** The ship deck's definition. */
export function shipDeck(ctx: Pick<StepCtx, "state" | "content">): DeepReadonly<DeckDef> {
  const deckId = shipDeckId(ctx.state);
  const deck = ctx.content.decks[deckId];
  if (deck === undefined) throw new Error(`field: no deck def ${deckId}`);
  return deck;
}

/** The compartment instance a ship-deck tile lies in. Throws off the hull. */
export function compartmentOfTile(
  ctx: Pick<StepCtx, "state" | "content">,
  tile: TileCoord,
): CompartmentId {
  const deck = shipDeck(ctx);
  const symbol = deck.tiles[tile.y]?.charAt(tile.x);
  const key = deck.compartments.find((c) => c.symbol === symbol)?.key;
  const compartment = Object.values(ctx.state.compartments).find(
    (c) => c.deckId === deck.id && c.key === key,
  );
  if (key === undefined || compartment === undefined) {
    throw new Error(`field: (${tile.x}, ${tile.y}) is in no compartment of ${deck.id}`);
  }
  return compartment.id;
}

/** The tiles of a ship compartment, row-major. */
export function compartmentTiles(
  ctx: Pick<StepCtx, "state" | "content">,
  compartmentId: CompartmentId,
): TileCoord[] {
  const deck = shipDeck(ctx);
  const key = ctx.state.compartments[compartmentId]?.key;
  const symbol = deck.compartments.find((c) => c.key === key)?.symbol;
  if (symbol === undefined) throw new Error(`field: no compartment ${compartmentId} aboard`);
  return hullFootprint(deck).filter((t) => deck.tiles[t.y]?.charAt(t.x) === symbol);
}

/** A scripted impact's centre (call 20): the tile, or uniform over the room or machine. */
function scriptedCentre(ctx: StepCtx, target: ImpactTarget): TileCoord {
  switch (target.kind) {
    case "tile":
      return { x: target.x, y: target.y };
    case "compartment":
      return randomCentre(ctx.rng, compartmentTiles(ctx, target.compartmentId));
    case "machine": {
      const machine = ctx.state.machines[target.machineId];
      if (machine === undefined) throw new Error(`field: no machine ${target.machineId}`);
      return randomCentre(ctx.rng, machineFootprintTiles(ctx, machine));
    }
    case "actor":
      // The command refuses a person at validation and at apply; one here is a corrupt save.
      throw new Error("field: people are not targets until bodies (slice 6)");
  }
}

/** The spec of a scripted impact landing now. */
export function scriptedSpec(ctx: StepCtx, field: ActiveField, impact: ScriptedImpact): ImpactSpec {
  return {
    centre: scriptedCentre(ctx, impact.target),
    rock: impact.rock ?? drawRock(ctx.rng, ctx.config, field.severity),
    ...(impact.effect === undefined ? {} : { effect: impact.effect }),
    scripted: true,
  };
}

/** The spec of a random impact landing now. */
export function randomSpec(ctx: StepCtx, field: ActiveField): ImpactSpec {
  return {
    centre: randomCentre(ctx.rng, hullFootprint(shipDeck(ctx))),
    rock: drawRock(ctx.rng, ctx.config, field.severity),
    scripted: false,
  };
}

/**
 * Land one impact: hull and scar, machines, damage response, the events, near misses. Counts it
 * on the field (`impacts`, `lastImpactTick`); the caller counts it stuck.
 */
export function landImpact(ctx: StepCtx, field: ActiveField, spec: ImpactSpec): void {
  const deck = shipDeck(ctx);
  const tiles = blastTiles(deck, spec.centre, spec.rock);
  const compartmentId = compartmentOfTile(ctx, spec.centre);
  const scar = chargeHull(ctx, field, { tile: spec.centre, compartmentId, rock: spec.rock });
  field.impacts += 1;
  field.lastImpactTick = ctx.tick;
  const hits = hitMachines(ctx, field, tiles, spec.effect);
  breakFragileCargo(ctx, field, compartmentId, spec.rock);
  onImpact(ctx, { fieldId: field.id, scarId: scar.id, compartmentId, tile: spec.centre, tiles });
  ctx.emit({
    type: "asteroidImpact",
    subjectIds: [field.id, scar.id, ...hits.map((hit) => hit.machineId)],
    causeIds: spec.scripted && field.causeCommandId !== undefined ? [field.causeCommandId] : [],
    source: "sim",
    locationRef: { kind: "compartment", compartmentId },
    payload: {
      fieldId: field.id,
      tile: spec.centre,
      tiles,
      rock: spec.rock,
      compartmentId,
      hullDamage: scar.damage,
      scarId: scar.id,
      scripted: spec.scripted,
      hits: hits.map(({ machineId, effect }) => ({ machineId, effect })),
    },
  });
  emitKnockouts(ctx, field, hits);
  nearMisses(ctx, field, tiles);
  // §accidents-aboard: whoever stands unbraced in the struck room may be thrown.
  thrownByImpact(ctx, compartmentId);
  loseShipIfSunk(ctx, field);
}

function emitKnockouts(ctx: StepCtx, field: ActiveField, hits: readonly MachineHit[]): void {
  for (const hit of hits) {
    if (!hit.knockedOut) continue;
    ctx.emit({
      type: "machineKnockedOut",
      subjectIds: [hit.machineId, field.id],
      causeIds: [],
      source: "sim",
      locationRef: { kind: "machine", machineId: hit.machineId },
      payload: { fieldId: field.id, machineId: hit.machineId },
    });
  }
}

/** Everyone aboard standing on a blast tile: a fright, a thought and a ticker line (call 17). */
function nearMisses(ctx: StepCtx, field: ActiveField, tiles: readonly TileCoord[]): void {
  const deckId = shipDeckId(ctx.state);
  const hit = new Set(tiles.map((t) => `${t.x},${t.y}`));
  const actors = Object.values(ctx.state.actors).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const actor of actors) {
    const location = actor.location;
    if (location.kind !== "onDeck" || location.deckId !== deckId) continue;
    const tile = { x: Math.floor(location.x), y: Math.floor(location.y) };
    if (!hit.has(`${tile.x},${tile.y}`)) continue;
    addThought(ctx, actor, "nearMiss", field.id);
    ctx.emit({
      type: "nearMiss",
      subjectIds: [actor.id, field.id],
      causeIds: [],
      source: "sim",
      payload: {
        fieldId: field.id,
        actorId: actor.id,
        compartmentId: compartmentOfTile(ctx, tile),
      },
    });
  }
}
