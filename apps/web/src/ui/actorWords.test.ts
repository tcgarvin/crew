import type { RoleTag } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { actorSubtitle, rosterRole } from "./actorWords";

const tags = (...names: string[]) => names as RoleTag[];

describe("actorSubtitle", () => {
  it("lists a crew member's role tags", () => {
    expect(actorSubtitle({ roleTags: tags("pilot", "medic") })).toBe("pilot, medic");
  });

  it("falls back to crew when there are no tags", () => {
    expect(actorSubtitle({ roleTags: [] })).toBe("crew");
  });

  it("says passenger for a passenger even without tags", () => {
    expect(actorSubtitle({ roleTags: [], passenger: true })).toBe("passenger");
  });

  it("says a disembarking passenger is going ashore", () => {
    expect(actorSubtitle({ roleTags: [], passenger: true, disembarking: true })).toBe(
      "passenger, going ashore",
    );
  });
});

describe("rosterRole", () => {
  it("tags a passenger regardless of role tags", () => {
    expect(rosterRole({ roleTags: tags("pilot"), passenger: true })).toBe("passenger");
  });

  it("uses role tags for crew and crew when there are none", () => {
    expect(rosterRole({ roleTags: tags("engineer") })).toBe("engineer");
    expect(rosterRole({ roleTags: [] })).toBe("crew");
  });
});
