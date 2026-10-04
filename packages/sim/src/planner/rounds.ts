/**
 * What an on-duty actor with nothing else to do does (D77): the officer of the watch walks rounds
 * and idles at the captain's chair between them, an engineer does the machine round, everyone
 * else goes to their post.
 *
 * Owner: W2 of ship life slice 2. Gate B stub: today's post candidate for everyone.
 */
import type { RoleTag } from "../core/types/content";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView } from "../core/types/view";
import type { Candidate, Rejection } from "./candidates";
import { backingOff, compartmentTagged, loungeTile, personal } from "./common";

/**
 * W4a decision: where an on-duty actor with nothing better to do waits, by role (first role with
 * a matching compartment tag wins). A vocabulary mapping, not a tunable. Being at one's post is
 * also how an engineer comes to hear a grinding pump.
 */
const POST_TAGS: Readonly<Record<RoleTag, readonly string[]>> = {
  captain: ["bridge"],
  firstOfficer: ["bridge"],
  pilot: ["bridge"],
  engineer: ["engineering"],
  deckhand: ["cargoHold"],
  cook: ["galley"],
  medic: ["infirmary"],
};

function postCandidate(view: AgentView): Candidate | Rejection | undefined {
  if (!view.self.onDuty) return undefined;
  const tags = view.self.roleTags.flatMap((role) => POST_TAGS[role]);
  const post = compartmentTagged(view, tags);
  const here = view.self.tile;
  if (post === undefined || here === undefined) return undefined;
  if (view.schematic.deck.tiles[here.y]?.[here.x] === post.symbol) return undefined;
  if (backingOff(view, "wander")) return { ref: "post", reason: "backoff" };
  const tile = loungeTile(view, tags);
  const ticks = tile === undefined ? null : view.estimateTravelTicks(tile);
  if (tile === undefined || ticks === null) return { ref: "post", reason: "unreachableTarget" };
  return personal("post", "voluntaryActivity", ticks, view.tick, {
    kind: "personal",
    activity: "wander",
    tile,
  });
}

/** The on-duty idle candidate, voluntary class. Stub: the post (W2 adds rounds). */
export function dutyIdleCandidate(
  view: AgentView,
  _config: PlannerConfig,
): Candidate | Rejection | undefined {
  return postCandidate(view);
}
