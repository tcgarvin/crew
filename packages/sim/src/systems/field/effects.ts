/**
 * §machines-in-the-blast: what a rock does to the machines it hits (slice 5 call 7). Every ship
 * machine with a footprint tile inside the blast rolls once on `field.machineEffects` (or takes the
 * scripted impact's effect): `none` glances off; `graze` and `damage` take `field.effectIntegrity`
 * off through damage response's `damageMachine`; `knockout` takes the machine's whole integrity, so
 * one hit can take a system from whole to out; `fault` is one of the machine's fault defs,
 * weighted, through the one fault path (D6, equipment's `applyFault`). A machine with no fault
 * left to take (none in content, or every one already present or on its way) takes `damage`
 * instead. `machineKnockedOut` is the impact's when a machine went from running to blocked.
 *
 * Owner: W1 of ship life slice 5.
 */
import type { TileCoord } from "../../core/types/common";
import { type FaultDef, MACHINE_EFFECTS, type MachineEffect } from "../../core/types/content";
import type { LocalKey, MachineId } from "../../core/types/ids";
import type { RngApi, StepCtx } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import type { ActiveField } from "../../core/types/state";
import { shipDeckId } from "../../core/world";
import { damageMachine } from "../damage/machines";
import { applyFault, isMachineBlocked } from "../equipment/equipment";
import { rotateOffset } from "../spatial/geometry";

/** One machine's share of an impact. */
export interface MachineHit {
  readonly machineId: MachineId;
  readonly effect: MachineEffect;
  /** The hit took it from running to blocked. */
  readonly knockedOut: boolean;
}

/** The absolute footprint tiles of a placed machine (origin + rotated offsets). */
export function machineFootprintTiles(
  ctx: Pick<StepCtx, "content">,
  machine: Pick<Machine, "id" | "defId" | "deckId" | "placementKey">,
): TileCoord[] {
  const def = ctx.content.machines[machine.defId];
  const placement = ctx.content.decks[machine.deckId]?.machines.find(
    (p) => p.key === machine.placementKey,
  );
  if (def === undefined || placement === undefined) {
    throw new Error(`machine ${machine.id}: no def or placement for its footprint`);
  }
  return def.footprint.map((offset) => {
    const r = rotateOffset(offset, placement.rotation);
    return { x: placement.origin.x + r.x, y: placement.origin.y + r.y };
  });
}

/** Ship machines with a footprint tile among `tiles`, by id. */
export function machinesInBlast(
  ctx: Pick<StepCtx, "state" | "content">,
  tiles: readonly TileCoord[],
): Machine[] {
  const deckId = shipDeckId(ctx.state);
  const hit = new Set(tiles.map((t) => `${t.x},${t.y}`));
  return Object.values(ctx.state.machines)
    .filter((machine) => machine.deckId === deckId)
    .filter((machine) => machineFootprintTiles(ctx, machine).some((t) => hit.has(`${t.x},${t.y}`)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One roll on the effect table (`field.machineEffects`, weighted). */
export function rollEffect(
  rng: Pick<RngApi, "weighted">,
  weights: Readonly<Record<MachineEffect, number>>,
): MachineEffect {
  return rng.weighted(
    "failures",
    MACHINE_EFFECTS.map((effect) => ({ item: effect, weight: weights[effect] })),
  );
}

/** Faults `machine` could still take: not present, not already on its way, with some weight. */
function faultsLeft(ctx: Pick<StepCtx, "defs">, machine: Machine): readonly FaultDef[] {
  const taken = new Set<LocalKey>([
    ...machine.faults.map((f) => f.faultKey),
    ...machine.scheduledFaults.map((f) => f.faultKey),
  ]);
  return ctx.defs.machine(machine.defId).faults.filter((f) => f.weight > 0 && !taken.has(f.key));
}

/**
 * Apply `effect` to `machine` (call 7); returns the effect it actually took (`fault` with no
 * fault left becomes `damage`).
 */
function applyEffect(
  ctx: StepCtx,
  field: ActiveField,
  machine: Machine,
  effect: MachineEffect,
): MachineEffect {
  const integrity = ctx.config.field.effectIntegrity;
  switch (effect) {
    case "none":
      return effect;
    case "graze":
      damageMachine(ctx, machine, integrity.graze);
      return effect;
    case "damage":
      damageMachine(ctx, machine, integrity.damage);
      return effect;
    case "knockout":
      damageMachine(ctx, machine, machine.integrity);
      return effect;
    case "fault": {
      const faults = faultsLeft(ctx, machine);
      if (faults.length === 0) return applyEffect(ctx, field, machine, "damage");
      const fault = ctx.rng.weighted(
        "failures",
        faults.map((f) => ({ item: f, weight: f.weight })),
      );
      applyFault(ctx, machine, ctx.defs.machine(machine.defId), fault.key, field.causeCommandId);
      return effect;
    }
  }
}

/**
 * Every machine in the blast takes its effect: the scripted one when given, else its own roll.
 * Returns each machine's hit, by machine id.
 */
export function hitMachines(
  ctx: StepCtx,
  field: ActiveField,
  tiles: readonly TileCoord[],
  scriptedEffect: MachineEffect | undefined,
): MachineHit[] {
  return machinesInBlast(ctx, tiles).map((machine) => {
    const def = ctx.defs.machine(machine.defId);
    const wasBlocked = isMachineBlocked(machine, def, ctx.config.equipment);
    const rolled = scriptedEffect ?? rollEffect(ctx.rng, ctx.config.field.machineEffects);
    const effect = applyEffect(ctx, field, machine, rolled);
    const knockedOut = !wasBlocked && isMachineBlocked(machine, def, ctx.config.equipment);
    return { machineId: machine.id, effect, knockedOut };
  });
}
