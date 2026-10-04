/**
 * What a repair still needs that is not aboard (D47, D71), and whether this port can supply it.
 *
 * A diagnosed fault's repair needs two kinds of supply: the parts its remaining steps consume, and
 * a tool of every kind its recipe names (the repair task asks for every step's tools, so a tool is
 * needed until the fault is fixed). A part is short by however many units are missing; a tool kind
 * is short when nothing aboard provides it, and is then wanted as one unit of the item def that
 * supplies it (`toolSupplyDefId`). Both shortfalls become `partsNeeded` problems that commerce
 * buys from a port market (`equipment.ts`), and the departure gate (D36) asks the same question
 * of the port the ship is at, so it never holds for a repair nothing aboard or for sale can finish.
 *
 * "Aboard" is on deck, in someone's hands or worn, and, D61, on the dock alongside: the ship's own
 * gear within reach while docked. Freight on offer is nobody's (D63, D66).
 */
import { isNobodysFreight } from "../../core/freight";
import { affordableUnits } from "../../core/markets";
import type { ContentBundle, MachineDef, ToolKind } from "../../core/types/content";
import type { ItemDefId, LocalKey, PortDefId } from "../../core/types/ids";
import type { ReadonlyWorldState } from "../../core/types/pipeline";
import type { Machine, MachineFault } from "../../core/types/ship";

type SupplyState = Pick<ReadonlyWorldState, "items" | "jobs">;

/** Units of each item def aboard, by def (see the module doc for what "aboard" covers). */
export function unitsAboard(state: SupplyState): Map<ItemDefId, number> {
  const aboard = new Map<ItemDefId, number>();
  for (const item of Object.values(state.items)) {
    const kind = item.location.kind;
    if (kind !== "onDeck" && kind !== "carriedBy" && kind !== "equippedBy") continue;
    if (isNobodysFreight(state, item)) continue;
    const units = item.stacking === "stack" ? item.count : 1;
    aboard.set(item.defId, (aboard.get(item.defId) ?? 0) + units);
  }
  return aboard;
}

/** Every tool kind some item aboard provides. */
function toolKindsAboard(
  aboard: ReadonlyMap<ItemDefId, number>,
  content: Pick<ContentBundle, "items">,
): Set<ToolKind> {
  const kinds = new Set<ToolKind>();
  for (const defId of aboard.keys()) {
    for (const kind of content.items[defId]?.toolKinds ?? []) kinds.add(kind);
  }
  return kinds;
}

/**
 * The item def bought to supply a missing tool kind: the most specific one (fewest tool kinds,
 * so a welder torch before a kit that also welds), then by id. One fixed answer per kind, so the
 * `partsNeeded` problem for it is stable from port to port. `undefined` when no item provides it
 * (content validation rejects that for any recipe tool).
 */
export function toolSupplyDefId(
  content: Pick<ContentBundle, "items">,
  kind: ToolKind,
): ItemDefId | undefined {
  const providers = Object.values(content.items)
    .filter((def) => def.toolKinds.includes(kind))
    .sort((a, b) => a.toolKinds.length - b.toolKinds.length || a.id.localeCompare(b.id));
  return providers[0]?.id;
}

/** One supply a repair is short of. */
export interface SupplyShortfall {
  readonly itemDefId: ItemDefId;
  readonly count: number;
  readonly need: "tool" | "part";
}

type RepairFault = Pick<MachineFault, "faultKey" | "diagnosed" | "repairStepIndex">;

/**
 * What the repairs of `faults` (on one machine) still need that is not aboard: parts summed over
 * their remaining steps against what is aboard, and one supplying item per tool kind nothing aboard
 * provides. Undiagnosed faults need nothing yet (nobody knows what the repair takes).
 */
export function repairShortfall(
  content: Pick<ContentBundle, "items">,
  def: MachineDef,
  faults: readonly RepairFault[],
  aboard: ReadonlyMap<ItemDefId, number>,
): SupplyShortfall[] {
  const parts = new Map<ItemDefId, number>();
  const toolKinds = new Set<ToolKind>();
  for (const fault of faults) {
    if (!fault.diagnosed) continue;
    const steps = def.faults.find((f) => f.key === fault.faultKey)?.repair.steps ?? [];
    for (const step of steps) for (const kind of step.tools) toolKinds.add(kind);
    for (const line of steps.slice(fault.repairStepIndex).flatMap((s) => s.consumes)) {
      parts.set(line.itemDefId, (parts.get(line.itemDefId) ?? 0) + line.count);
    }
  }
  const short: SupplyShortfall[] = [];
  for (const [itemDefId, count] of parts) {
    const missing = count - (aboard.get(itemDefId) ?? 0);
    if (missing > 0) short.push({ itemDefId, count: missing, need: "part" });
  }
  const kindsAboard = toolKindsAboard(aboard, content);
  const tools = new Set<ItemDefId>();
  for (const kind of toolKinds) {
    if (kindsAboard.has(kind)) continue;
    const supply = toolSupplyDefId(content, kind);
    if (supply === undefined || tools.has(supply) || parts.has(supply)) continue;
    tools.add(supply);
    short.push({ itemDefId: supply, count: 1, need: "tool" });
  }
  return short;
}

/** A diagnosed fault whose repair is short of something the port cannot sell (or not afford). */
export interface RepairOutOfReach extends SupplyShortfall {
  readonly faultKey: LocalKey;
}

/**
 * D71: the first of `faultKeys` (diagnosed faults on `machine`) whose repair is short of a supply
 * that neither the ship has nor the market at `portId` can sell it in full right now (out of
 * stock there, or more than the ship can pay). `portId` undefined: no market is in reach.
 */
export function repairOutOfReach(
  state: Pick<ReadonlyWorldState, "items" | "jobs" | "markets" | "money">,
  content: Pick<ContentBundle, "items" | "ports">,
  machine: Pick<Machine, "faults">,
  def: MachineDef,
  faultKeys: ReadonlySet<LocalKey>,
  portId: PortDefId | undefined,
): RepairOutOfReach | undefined {
  const aboard = unitsAboard(state);
  for (const fault of machine.faults) {
    if (!faultKeys.has(fault.faultKey)) continue;
    for (const line of repairShortfall(content, def, [fault], aboard)) {
      const buyable =
        portId === undefined
          ? 0
          : affordableUnits(state, content, portId, line.itemDefId, line.count);
      if (buyable < line.count) return { ...line, faultKey: fault.faultKey };
    }
  }
  return undefined;
}
