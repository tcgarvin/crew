/**
 * The per-game vocabulary the plan schema's enums are built over (W0 `NarratorVocabulary`).
 * Only things that exist appear, so the model cannot even name a missing port or fault.
 */
import type { ContentBundle } from "@crew/sim";
import { NO_CHOICE, type NarratorVocabulary } from "./contract";
import type { State } from "./lookups";

function nonEmpty(values: Iterable<string>): readonly [string, ...string[]] {
  const sorted = [...new Set(values)].sort();
  const [first, ...rest] = sorted;
  return first === undefined ? [NO_CHOICE] : [first, ...rest];
}

export function buildVocabulary(state: State, content: ContentBundle): NarratorVocabulary {
  const faultyMachines = Object.values(state.machines).filter(
    (m) => (content.machines[m.defId]?.faults.length ?? 0) > 0,
  );
  return {
    ports: nonEmpty(Object.keys(content.ports)),
    machines: nonEmpty(faultyMachines.map((m) => m.id)),
    faultKeys: nonEmpty(
      faultyMachines.flatMap((m) => content.machines[m.defId]?.faults.map((f) => f.key) ?? []),
    ),
    cargoItems: nonEmpty(
      Object.values(content.items)
        .filter((i) => i.cargoClass !== undefined)
        .map((i) => i.id),
    ),
    storeKeys: nonEmpty(
      Object.values(content.ports).flatMap((p) => p.externalStores.map((s) => s.key)),
    ),
  };
}
