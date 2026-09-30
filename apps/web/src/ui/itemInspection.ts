/**
 * Polish A: build the inspector's view of a tapped item from a state snapshot — its name, count,
 * where it is in plain words, and, for freight, whose it is and where it is going (D28).
 */
import type { ContentBundle, DeepReadonly, ItemId, WorldState } from "@crew/sim";
import type { DeckLayout } from "../render/deckLayout";
import type { ItemInspection } from "./Inspector";

function where(
  state: DeepReadonly<WorldState>,
  location: DeepReadonly<WorldState["items"][ItemId]["location"]>,
  content: ContentBundle,
  layout: DeckLayout,
): string {
  switch (location.kind) {
    case "onDeck": {
      const tile = layout.tiles[Math.floor(location.y) * layout.width + Math.floor(location.x)];
      const room =
        tile?.compartmentKey === undefined
          ? undefined
          : layout.compartmentNames[tile.compartmentKey];
      return room === undefined ? "on deck" : `in the ${room.toLowerCase()}`;
    }
    case "carriedBy":
    case "equippedBy":
      return `carried by ${state.actors[location.actorId]?.name ?? "someone"}`;
    case "inContainer":
      return "packed in a container";
    case "installedIn":
      return "installed in a machine";
    case "inExternalStore":
      return `ashore at ${content.ports[location.portId]?.name ?? location.portId}`;
  }
}

export function inspectItem(
  state: DeepReadonly<WorldState>,
  itemId: ItemId,
  content: ContentBundle,
  layout: DeckLayout,
): ItemInspection | undefined {
  const item = state.items[itemId];
  if (item === undefined) return undefined;
  const def = content.items[item.defId] ?? state.defs.dynamic.items[item.defId];
  const job = item.jobId === undefined ? undefined : state.jobs[item.jobId];
  const port = (id: string) => content.ports[id as keyof ContentBundle["ports"]]?.name ?? id;
  return {
    name: def?.name ?? "Cargo",
    count: item.stacking === "stack" ? item.count : 1,
    where: where(state, item.location, content, layout),
    ...(job === undefined
      ? {}
      : {
          job: {
            issuer: job.issuer,
            from: port(job.fromPortId),
            to: port(job.toPortId),
            status: job.status,
          },
        }),
  };
}
