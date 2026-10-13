/**
 * The medbay bed (§treatment-at-the-medbay-bed), read from content and the machine table alone
 * (task derivation has no geometry cache): the ship deck's first `medBed` placement (authored
 * order), its `use` position (where the patient lies), the compartment it stands in, and the tiles
 * a medic stands on to treat: the open floor beside the patient's tile in the same compartment
 * (`besideTiles`), never the patient's own. A deck with no medbay bed has none, and so no wounded
 * problem and no treatment (§the-wounded-problem).
 */
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { ContentBundle } from "../../core/types/content";
import type { ActorId, CompartmentId, LocalKey, MachineId } from "../../core/types/ids";
import type { ReadonlyWorldState } from "../../core/types/pipeline";
import { shipDeckId } from "../../core/world";
import { besideTiles, chebyshev, symbolAt } from "../damage/deck";
import { rotateOffset } from "../spatial/geometry";

export interface MedBed {
  readonly machineId: MachineId;
  /** The `use` interaction position the patient lies at. */
  readonly positionKey: LocalKey;
  readonly useTile: TileCoord;
  readonly compartmentId: CompartmentId;
  /** Where the medic stands: open floor beside `useTile`, nearest first. */
  readonly medicTiles: readonly TileCoord[];
}

type BedState = Pick<ReadonlyWorldState, "deck" | "machines" | "compartments">;
type BedContent = Pick<ContentBundle, "decks" | "machines">;

/** The ship's medbay bed, or undefined on a deck with none. */
export function medBedOf(state: BedState, content: BedContent): MedBed | undefined {
  const deckId = shipDeckId(state);
  const deck = content.decks[deckId];
  if (deck === undefined) return undefined;
  for (const placement of deck.machines) {
    const def = content.machines[placement.machineDefId];
    if (def?.tags.includes("medBed") !== true) continue;
    const position = def.interactionPositions.find((p) => p.purposes.includes("use"));
    const machine = Object.values(state.machines).find(
      (m) => m.deckId === deckId && m.placementKey === placement.key,
    );
    if (position === undefined || machine === undefined) continue;
    const offset = rotateOffset(position.offset, placement.rotation);
    const useTile = { x: placement.origin.x + offset.x, y: placement.origin.y + offset.y };
    const symbol = symbolAt(deck, useTile);
    const key = deck.compartments.find((c) => c.symbol === symbol)?.key;
    const compartment = Object.values(state.compartments).find(
      (c) => c.deckId === deckId && c.key === key,
    );
    if (compartment === undefined) continue;
    const medicTiles = besideTiles(content, deck, useTile).filter(
      (t) => t.x !== useTile.x || t.y !== useTile.y,
    );
    return {
      machineId: machine.id,
      positionKey: position.key,
      useTile,
      compartmentId: compartment.id,
      medicTiles,
    };
  }
  return undefined;
}

/** Is `actor` lying at the bed (standing on its `use` tile, on the ship's deck)? */
export function onTheBed(
  state: Pick<ReadonlyWorldState, "deck">,
  bed: MedBed,
  actor: DeepReadonly<Pick<Actor, "location">>,
): boolean {
  const location = actor.location;
  if (location.kind !== "onDeck" || location.deckId !== shipDeckId(state)) return false;
  return Math.floor(location.x) === bed.useTile.x && Math.floor(location.y) === bed.useTile.y;
}

/** The patient is walking to the bed to wait there (their activity is `convalesce`). */
export function convalescing(actor: DeepReadonly<Pick<Actor, "activity">>): boolean {
  const activity = actor.activity;
  return activity.kind === "personal" && activity.activity === "convalesce";
}

/**
 * §treatment-at-the-medbay-bed: a treatment may be got ready (the kit fetched, the walk to the
 * bedside) while the patient lies at the bed, is on their way to it (`convalescing`) or is within
 * `medical.prepareWithinTiles` of it; only the treating waits for them on the bed.
 */
export function patientAtOrComing(
  state: Pick<ReadonlyWorldState, "deck">,
  bed: MedBed,
  patient: DeepReadonly<Pick<Actor, "location" | "activity">>,
  withinTiles: number,
): boolean {
  if (onTheBed(state, bed, patient) || convalescing(patient)) return true;
  const location = patient.location;
  if (location.kind !== "onDeck" || location.deckId !== shipDeckId(state)) return false;
  const tile = { x: Math.floor(location.x), y: Math.floor(location.y) };
  return chebyshev(tile, bed.useTile) <= withinTiles;
}

/**
 * §extraction: someone other than `patientId`, living, lies or stands still at the bed. Someone
 * walking over the tile does not take it: a crewmate passing would otherwise cancel a carry.
 */
export function bedTakenFrom(
  state: Pick<ReadonlyWorldState, "deck" | "actors">,
  bed: MedBed,
  patientId: ActorId,
): boolean {
  return Object.values(state.actors).some(
    (other) =>
      other.id !== patientId &&
      other.availability !== "dead" &&
      other.movement.kind !== "moving" &&
      onTheBed(state, bed, other),
  );
}
