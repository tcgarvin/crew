import type { RosterEntry, SelfView } from "@crew/sim";

/**
 * Plain words for who an actor is, for the inspector. Passengers (passengers-and-galaxy §3.2)
 * carry no role tags, so without this they would read as "crew".
 */
export function actorSubtitle(
  self: Pick<SelfView, "roleTags" | "passenger" | "disembarking">,
): string {
  if (self.passenger === true) {
    return self.disembarking === true ? "passenger, going ashore" : "passenger";
  }
  return self.roleTags.join(", ") || "crew";
}

/** The roster line's role words: "passenger" for a passenger, else the role tags or "crew". */
export function rosterRole(entry: Pick<RosterEntry, "roleTags" | "passenger">): string {
  if (entry.passenger === true) return "passenger";
  return entry.roleTags.join(", ") || "crew";
}
