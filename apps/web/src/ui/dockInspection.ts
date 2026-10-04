/**
 * The inspector's data for anything on the dock a tap can select without a snapshot from the
 * worker: a post or the dock itself (phase 2), one of the dock's own people or a staged prop
 * (phase 3, D68). All of it comes from the frame on screen and the content's dock map.
 */
import type { RenderFrame } from "@crew/sim";
import type { DeckLayout } from "../render/deckLayout";
import { type DockTable, berthInView, dockInView } from "../render/dock";
import type { DockTarget } from "../render/dockHit";
import { dockPropKey } from "../render/locals";
import type { InspectorData } from "./Inspector";
import { inspectDockProp, inspectLocal } from "./localInspection";
import { inspectPlace } from "./placeInspection";

export type DockSelection =
  | DockTarget
  | { readonly kind: "local"; readonly id: string }
  | { readonly kind: "dockProp"; readonly id: string };

/**
 * `undefined` when no dock map is in view, or when the person or prop tapped is no longer in the
 * frame (a dock hand gone back through the warehouse door between the draw and the tap): there is
 * nothing left to describe, so the inspector stays closed.
 */
export function dockInspection(
  frame: RenderFrame,
  docks: DockTable,
  layout: Pick<DeckLayout, "deckId" | "width" | "height" | "hull">,
  target: DockSelection,
): InspectorData | undefined {
  const dock = dockInView(frame, docks);
  if (dock === undefined) return undefined;
  const berth = berthInView(dock, layout);
  switch (target.kind) {
    case "post":
    case "dock":
      return { kind: "place", place: inspectPlace(dock, target) };
    case "local": {
      const local = frame.locals.find((l) => l.id === target.id);
      return local === undefined ? undefined : { kind: "local", local: inspectLocal(berth, local) };
    }
    case "dockProp": {
      const prop = frame.dockProps.find((p, i) => dockPropKey(p, i) === target.id);
      return prop === undefined
        ? undefined
        : { kind: "place", place: inspectDockProp(berth, prop) };
    }
  }
}
