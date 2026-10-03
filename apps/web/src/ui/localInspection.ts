/**
 * Dockside phase 3 (D68): what the inspector shows for one of the dock's own people (a local) or a
 * prop the staging call set out. Both come from the render frame and the dock map alone, so, like
 * a post, they need no snapshot from the worker.
 */
import type { DockDef, RenderDockProp, RenderLocal } from "@crew/sim";
import { dockWhere } from "./itemInspection";
import type { PlaceInspection } from "./placeInspection";

export interface LocalInspection {
  readonly name: string;
  /** Lower case, as the sim keeps it: "berth agent", "dock hand". */
  readonly role: string;
  /** "at the queue-board kiosk" while at their post, else where on the dock they are. */
  readonly where: string;
  /** Their post's name ("the warehouse door") when they are away from it; absent at it. */
  readonly post?: string;
  /** What they are doing ("waiting for a delivery"); absent when nothing in particular. */
  readonly doing?: string;
  /** A narrator-invented face's one-line look. */
  readonly look?: string;
}

/** Within this many tiles of their post (they shuffle about it), a local is "at" it. */
const AT_POST_TILES = 2;

/**
 * The inspector's view of a local. Positions are the frame's, in the grafted deck frame (not the
 * slid one the canvas draws). Throws if their post is not on this dock: the sim only places locals
 * at posts of the dock alongside (D66).
 */
export function inspectLocal(dock: DockDef, local: RenderLocal): LocalInspection {
  const post = dock.posts.find((p) => p.key === local.postKey);
  if (post === undefined) throw new Error(`Dock "${dock.id}" has no post "${local.postKey}"`);
  const tileX = Math.floor(local.x) + dock.shipAt.x;
  const tileY = Math.floor(local.y) + dock.shipAt.y;
  const atPost = Math.hypot(post.tile.x - tileX, post.tile.y - tileY) <= AT_POST_TILES;
  return {
    name: local.name,
    role: local.role,
    where: atPost ? `at ${post.name}` : dockWhere(dock, local.x, local.y),
    ...(atPost ? {} : { post: post.name }),
    ...(local.label === undefined ? {} : { doing: local.label }),
    ...(local.look === undefined ? {} : { look: local.look }),
  };
}

const COUNT_WORDS = ["", "One", "Two", "Three", "Four"] as const;

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The inspector's view of a staged prop: what it is, how many and where, and that it is the
 * port's (it is set dressing, never an item: nobody aboard can pick it up or use it).
 */
export function inspectDockProp(dock: DockDef, prop: RenderDockProp): PlaceInspection {
  const where = dockWhere(dock, prop.x, prop.y);
  const count = COUNT_WORDS[prop.count];
  const amount = prop.count > 1 && count !== undefined ? `${count} of them, ${where}` : where;
  return {
    title: prop.name,
    subtitle: "on the dock",
    text: `${capitalise(amount)}. The port's, not the ship's.`,
  };
}
