/**
 * Dockside phase 2: what the inspector shows for a tapped dock post or bare dock floor. Content
 * only (the dock map), so it needs no snapshot from the worker.
 */
import type { DockDef, DockPostKind } from "@crew/sim";

export interface PlaceInspection {
  readonly title: string;
  readonly subtitle: string;
  readonly text: string;
}

/** One line on what a post is for, in the world's terms (dockside §3.5: the edge of the map). */
const POST_ROLE: Readonly<Record<DockPostKind, string>> = {
  gate: "Through here is the port itself.",
  warehouseDoor: "Freight goes through here to and from the port's warehouse.",
  marketStall: "Parts and supplies for sale.",
  kiosk: "Somebody keeps this post.",
  loungeDoor: "The way into the port's lounge.",
  bench: "Somewhere to wait.",
  // Expeditions A1 (§4): a landing site's spots.
  target: "Where the one they came for keeps to.",
  guard: "Somebody watches the way in from here.",
  loot: "Where the thing worth taking is kept.",
  exit: "The way out, for anyone who runs.",
  flank: "A second way in.",
  bystander: "Somebody who is not part of this.",
};

/**
 * Expeditions A1 (§4): what kind of spot a landing site's post is, for the subtitle, since nothing
 * is drawn there to say so.
 */
const SITE_POST_KIND: Readonly<Partial<Record<DockPostKind, string>>> = {
  target: "the objective",
  guard: "a guard post",
  loot: "the loot",
  exit: "the way out",
  flank: "the flank",
  bystander: "a bystander's spot",
};

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A post's name without its article, as a heading: "the queue-board kiosk" → "Queue-board kiosk". */
export function postTitle(name: string): string {
  return capitalise(name.replace(/^the\s+/i, ""));
}

/**
 * The inspector's view of a post (`kind: "post"`, `id` its key) or of the dock itself. Throws if
 * the post is not on this dock: the canvas only selects posts it drew.
 */
export function inspectPlace(
  dock: DockDef,
  target: { readonly kind: "post" | "dock"; readonly id: string },
): PlaceInspection {
  if (target.kind === "dock") {
    const subtitle = dock.kind === "site" ? "the landing site" : "the dock";
    return { title: dock.name, subtitle, text: dock.ambience };
  }
  const post = dock.posts.find((p) => p.key === target.id);
  if (post === undefined) throw new Error(`Dock "${dock.id}" has no post "${target.id}"`);
  const kind = SITE_POST_KIND[post.kind];
  const subtitle = kind === undefined ? dock.name : `${capitalise(kind)} · ${dock.name}`;
  return { title: postTitle(post.name), subtitle, text: POST_ROLE[post.kind] };
}
