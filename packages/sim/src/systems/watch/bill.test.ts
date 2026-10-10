import { describe, expect, it } from "vitest";
import type { CrewDef, RoleTag } from "../../core/types/content";
import type { CrewDefId } from "../../core/types/ids";
import { resolveWatchBill } from "../../core/watch-bill";
import { fixtureContent } from "../travel/fixtures";
import { FIX } from "../travel/fixtures";
import { generateWatchBill } from "./bill";
import { BRIDGE, bridgeContent } from "./fixtures/bridge-deck";

function def(id: string, roleTags: RoleTag[], piloting: number): CrewDef {
  return {
    id: `crew.${id}` as CrewDefId,
    name: id,
    roleTags,
    skills: { piloting },
    startingInventory: [],
    bio: "",
    voice: "",
  };
}

/** The nine authored crew, as far as the bill cares: roles and piloting. */
const NINE = [
  def("mara", ["captain"], 6),
  def("dane", ["firstOfficer"], 4),
  def("priya", ["engineer"], 1),
  def("tomas", ["engineer", "deckhand"], 1),
  def("jax", ["pilot"], 8),
  def("bettina", ["cook"], 1),
  def("oyelaran", ["medic"], 2),
  def("sunniva", ["deckhand"], 1),
  def("noor", ["pilot"], 3),
];

const piloting = new Map(NINE.map((d) => [d.id, d.skills.piloting ?? 0]));

describe("generateWatchBill (§sections-and-dayworkers)", () => {
  it("gives nine crew three sections, each with a qualified stander, engineers spread, day roles on day hours", () => {
    const bill = generateWatchBill(NINE, 3, 3);
    expect(bill.sections.map((s) => s.key)).toEqual(["red", "white", "blue"]);
    for (const section of bill.sections) {
      expect(section.members.some((m) => (piloting.get(m) ?? 0) >= 3)).toBe(true);
    }
    // Non-officer pilots stand first: Jax, then Noor; then the captain.
    expect(bill.sections.map((s) => s.members[0])).toEqual(["crew.jax", "crew.noor", "crew.mara"]);
    const engineers = bill.sections.map((s) =>
      s.members.filter((m) => m === "crew.priya" || m === "crew.tomas"),
    );
    expect(engineers.every((list) => list.length <= 1)).toBe(true);
    expect([...bill.dayworkers].sort()).toEqual(["crew.bettina", "crew.oyelaran", "crew.sunniva"]);
    const everyone = [...bill.sections.flatMap((s) => s.members), ...bill.dayworkers];
    expect(everyone.sort()).toEqual(NINE.map((d) => d.id).sort());
  });

  it("gives a pilot and a cook one section and a dayworker", () => {
    const bill = generateWatchBill([def("pilot", ["pilot"], 4), def("cook", ["cook"], 0)], 3, 3);
    expect(bill).toEqual({
      sections: [{ key: "red", members: ["crew.pilot"] }],
      dayworkers: ["crew.cook"],
    });
  });

  it("keeps everyone on day hours when nobody is qualified", () => {
    const crew = [def("a", ["engineer"], 1), def("b", ["deckhand"], 0)];
    expect(generateWatchBill(crew, 3, 3)).toEqual({
      sections: [],
      dayworkers: ["crew.a", "crew.b"],
    });
  });

  it("is used for a scenario without a bill on a deck with a helm, and not on one without", () => {
    const withHelm = bridgeContent();
    const scenario = withHelm.scenarios[BRIDGE.scenario];
    const deck = scenario === undefined ? undefined : withHelm.decks[scenario.deckId];
    if (scenario === undefined || deck === undefined) throw new Error("fixture changed");
    const { watchBill: _bill, ...unbilled } = scenario;
    expect(resolveWatchBill(unbilled, deck, withHelm, 3).sections.length).toBe(3);
    const helmless = fixtureContent();
    const freight = helmless.scenarios[FIX.scenario];
    const freightDeck = helmless.decks[FIX.deck];
    if (freight === undefined || freightDeck === undefined) throw new Error("fixture changed");
    const { watchBill: _freightBill, ...noBill } = freight;
    expect(resolveWatchBill(noBill, freightDeck, helmless, 3)).toEqual({
      sections: [],
      dayworkers: freight.crew,
    });
  });
});
