import {
  type ItemDefId,
  type LocalKey,
  type SaveEnvelope,
  type StagingPlan,
  dockAlongside,
  dressDock,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { buildDigest } from "./digest";
import { captainAshoreRequest, quietTooLongRequest, stageDockRequest } from "./fixtures";
import { EMPTY_NOTES } from "./notes";
import { content } from "./test-support";

const KESSLER_PLAN: StagingPlan = {
  place: [
    {
      who: {
        kind: "newFace",
        name: "Ruth Calloway",
        role: "courier",
        look: "oilskin coat, a satchel",
      },
      postKey: "canteen_hatch" as LocalKey,
      label: "watching the ramps",
    },
    {
      who: { kind: "seed", name: "Osric Tan" },
      postKey: "assay_window" as LocalKey,
      label: "weighing a sample",
    },
  ],
  props: [
    { itemDefId: "item.crate_general" as ItemDefId, count: 2, at: { kind: "staging" } },
    {
      itemDefId: "item.med_kit" as ItemDefId,
      count: 1,
      at: { kind: "post", postKey: "shift_board" as LocalKey },
    },
  ],
  ambience: "The shift board is flashing red and someone is shouting about berth fees.",
};

/** The docked Kessler job-board fixture with its dock dressed by `plan` on top of the floor set. */
function dressedKessler(plan: StagingPlan | undefined) {
  const bundle = content();
  const req = captainAshoreRequest(bundle);
  const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
  dressDock(snapshot.state, bundle, plan, snapshot.state.tick, 1);
  return { req, snapshot, bundle };
}

function sectionOf(text: string, heading: string): string[] {
  return text.split(`## ${heading}\n`)[1]?.split("\n\n")[0]?.split("\n") ?? [];
}

describe('"On the dock" (D67)', () => {
  it("lists who is on the dock, where, doing what and why, the props and the arrival line", () => {
    const { req, snapshot, bundle } = dressedKessler(KESSLER_PLAN);
    const dock = dockAlongside(bundle, snapshot.state)?.dock;
    if (dock === undefined) throw new Error("fixture: no dock");
    const { text } = buildDigest(snapshot, [], EMPTY_NOTES, bundle, req.hook);
    expect(sectionOf(text, `On the dock (${dock.name})`)).toEqual([
      `the place: ${dock.ambience}`,
      "as the ship came in: The shift board is flashing red and someone is shouting about berth fees.",
      "people on the dock (not crew; they stay on the dock):",
      "- Greta Lindholm (shift foreman) at the shift board: a regular here",
      '- Osric Tan (assay clerk) at the assay window, "weighing a sample": a regular here',
      '- Ruth Calloway (courier) at the hatch to the canteen ring, "watching the ramps": a new face, not in your cast until you write about them; looks: oilskin coat, a satchel',
      "set dressing (nobody's; nobody aboard can use it):",
      "- 2x General Cargo Crate on the staging area",
      "- 1x Med Kit by the shift board",
    ]);
  });

  it("is in every docked call's digest, story calls included, and in no call in flight", () => {
    const { req, snapshot, bundle } = dressedKessler(undefined);
    expect(req.hook.kind).toBe("captainAshore");
    const docked = buildDigest(snapshot, [], EMPTY_NOTES, bundle, req.hook).text;
    expect(docked).toContain("## On the dock (");
    expect(docked).toContain("- Greta Lindholm (shift foreman) at the shift board: a regular here");
    const quiet = quietTooLongRequest(bundle);
    expect(buildDigest(quiet.snapshot, [], EMPTY_NOTES, bundle, quiet.hook).text).not.toContain(
      "## On the dock",
    );
  });

  it("does not put a new face in the cast or the people the captain knows", () => {
    const { req, snapshot, bundle } = dressedKessler(KESSLER_PLAN);
    const { text } = buildDigest(snapshot, [], EMPTY_NOTES, bundle, req.hook);
    expect(sectionOf(text, "People you know here (Kessler Drift)").join("\n")).not.toContain(
      "Ruth Calloway",
    );
    expect(text).not.toContain("cast: Ruth Calloway");
  });
});

describe('"The dock you are dressing" (stageDock, D67)', () => {
  it("shows the dock's posts by key, its areas and the floor set, and no story budget", () => {
    const bundle = content();
    const req = stageDockRequest(bundle);
    const { text } = buildDigest(req.snapshot, req.recentEvents, EMPTY_NOTES, bundle, req.hook);
    const lines = sectionOf(text, "The dock you are dressing (Kessler Drift, ore berth 3)");
    expect(lines).toContain("- shift_board: the shift board (kiosk)");
    expect(lines).toContain("- ore_store: the ore-store lock (warehouseDoor)");
    expect(lines.some((l) => l.startsWith("areas: the staging area"))).toBe(true);
    expect(lines).toContain(
      "- Greta Lindholm (shift foreman) at shift_board (the shift board): a regular here",
    );
    expect(text).not.toContain("## Your budget");
    // It reads what the story narrator reads: the port's people, the crew, the notes.
    expect(text).toContain("## People you know here (Kessler Drift)");
    expect(text).toContain("## Crew (9)");
    expect(text).toContain("## Your notes so far");
    // The dock is not alongside yet: nothing is "on" it.
    expect(text).not.toContain("## On the dock");
  });

  it("is only in the staging call's digest", () => {
    const bundle = content();
    const req = captainAshoreRequest(bundle);
    expect(buildDigest(req.snapshot, [], EMPTY_NOTES, bundle, req.hook).text).not.toContain(
      "## The dock you are dressing",
    );
  });
});
