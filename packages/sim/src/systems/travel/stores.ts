/** A port's warehouse store as a custody location (moved out of `travel.ts` for D66's modules). */
import type { PhysicalLocation } from "../../core/types/common";
import type { ExternalStoreDef, PortDef } from "../../core/types/content";

function warehouseStore(port: PortDef): ExternalStoreDef | undefined {
  return port.externalStores.find((s) => s.kind === "warehouse") ?? port.externalStores[0];
}

/** Spawn location for freight at a port on arrival/accept: its warehouse (or first) store. */
export function portStoreLocation(port: PortDef): PhysicalLocation {
  const store = warehouseStore(port);
  if (store === undefined) throw new Error(`Port "${port.id}" has no external store`);
  return { kind: "inExternalStore", portId: port.id, storeKey: store.key };
}
