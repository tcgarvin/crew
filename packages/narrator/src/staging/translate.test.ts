import {
  type CommandId,
  type MachineId,
  type SaveEnvelope,
  createKernel,
  createRegistry,
  registerSpatial,
  registerTravel,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { stageDockRequest } from "../fixtures";
import { EMPTY_NOTES, type NarratorNotes } from "../notes";
import { content } from "../test-support";
import type { StagingEnvelope } from "./plan";
import { type StageDockHook, translateStaging } from "./translate";

const req = () => stageDockRequest(content());

function hookOf(request: ReturnType<typeof stageDockRequest>): StageDockHook {
  if (request.hook.kind !== "stageDock") throw new Error("fixture hook kind");
  return request.hook;
}

const CAST_NOTES: NarratorNotes = {
  ...EMPTY_NOTES,
  cast: [
    {
      name: "Ilse Brandt",
      note: "ore buyer who owes the captain a favour",
      portId: "port.kessler_drift",
      lastSeenTick: 100,
    },
  ],
};

function translate(
  intents: unknown[],
  options: { notes?: NarratorNotes; snapshot?: SaveEnvelope } = {},
) {
  const request = req();
  const plan: StagingEnvelope = { rationale: "test", intents };
  return translateStaging(plan, {
    snapshot: options.snapshot ?? request.snapshot,
    content: content(),
    hook: hookOf(request),
    callId: "call-stage",
    notes: options.notes ?? EMPTY_NOTES,
  });
}

const person = (fields: Record<string, string>) => ({
  kind: "placePerson",
  who: "newFace",
  name: "Ruth Calloway",
  role: "courier",
  look: "oilskin coat, a satchel over one shoulder",
  post: "canteen_hatch",
  label: "",
  ...fields,
});

const FULL_PLAN = [
  person({ label: "watching the ramps" }),
  person({ who: "seed", name: "marisol kemp", role: "", look: "", post: "canteen_hatch" }),
  person({ who: "cast", name: "Ilse Brandt", role: "Ore Buyer", look: "", post: "ore_store" }),
  { kind: "placeProp", item: "item.crate_general", count: "2", at: "staging" },
  { kind: "placeProp", item: "item.med_kit", count: "1", at: "shift_board" },
  {
    kind: "setAmbience",
    line: "The conveyor stalls, and the whole berth hears the foreman swear.",
  },
];

describe("translateStaging (§staging-prompt)", () => {
  it("turns a staging plan into exactly one stageDock command, names as content has them", () => {
    const { commands, dropped } = translate(FULL_PLAN, { notes: CAST_NOTES });
    expect(dropped).toEqual([]);
    expect(commands).toHaveLength(1);
    const [command] = commands;
    expect(command).toMatchObject({
      id: "cmd:narrator:call-stage:0",
      source: "narrator",
      kind: "stageDock",
      targetTick: hookOf(req()).tick + 1,
    });
    if (command?.kind !== "stageDock") throw new Error("not stageDock");
    expect(command.payload).toEqual({
      place: [
        {
          who: {
            kind: "newFace",
            name: "Ruth Calloway",
            role: "courier",
            look: "oilskin coat, a satchel over one shoulder",
          },
          postKey: "canteen_hatch",
          label: "watching the ramps",
        },
        { who: { kind: "seed", name: "Marisol Kemp" }, postKey: "canteen_hatch" },
        { who: { kind: "cast", name: "Ilse Brandt", role: "ore buyer" }, postKey: "ore_store" },
      ],
      props: [
        { itemDefId: "item.crate_general", count: 2, at: { kind: "staging" } },
        { itemDefId: "item.med_kit", count: 1, at: { kind: "post", postKey: "shift_board" } },
      ],
      ambience: "The conveyor stalls, and the whole berth hears the foreman swear.",
    });
  });

  it("is accepted by the real kernel while the staging call is open", () => {
    const request = req();
    const registry = createRegistry();
    registerSpatial(registry);
    registerTravel(registry);
    const kernel = createKernel(registry);
    const world = kernel.restore(request.snapshot, content());
    const { commands } = translate(FULL_PLAN, { notes: CAST_NOTES });
    const [command] = commands;
    if (command === undefined) throw new Error("no command");
    expect(kernel.enqueueCommand(world, command)).toMatchObject({ status: "accepted" });
  });

  it("drops every non-staging intent with a reason, story levers included", () => {
    const { commands, dropped } = translate([
      { kind: "offerJob", issuerName: "Greta Lindholm" },
      { kind: "surfaceDecision", title: "A word at the ramp" },
      { kind: "scheduleFault", machine: "m2", faultKey: "worn_bearing", window: "soon" },
      { kind: "stockMarket", port: "port.kessler_drift", cargoItem: "item.med_kit" },
      { kind: "spawnAtBoundary", port: "port.kessler_drift" },
      { kind: "stageDock", place: [] },
      { kind: "writeNotes", summary: "the story so far" },
      "not even an object",
    ]);
    expect(commands).toEqual([]);
    expect(dropped.map((d) => [d.intentIndex, d.kind])).toEqual([
      [0, "offerJob"],
      [1, "surfaceDecision"],
      [2, "scheduleFault"],
      [3, "stockMarket"],
      [4, "spawnAtBoundary"],
      [5, "stageDock"],
      [6, "writeNotes"],
      [7, "unknown"],
    ]);
    expect(dropped[0]?.reason).toBe(
      '"offerJob" moves the plot, and the staging call only sets the stage (placePerson, placeProp, setAmbience)',
    );
    expect(dropped[6]?.reason).toBe(
      '"writeNotes" is not something the staging call can do (placePerson, placeProp, setAmbience)',
    );
  });

  it("keeps the good parts of a plan and drops the bad ones, each with a reason", () => {
    const aboard = Object.values(req().snapshot.state.actors).find((a) => a.crew)?.name ?? "";
    const { commands, dropped } = translate([
      person({ post: "nowhere" }),
      person({ who: "seed", name: "Nobody Here", role: "" }),
      person({ who: "cast", name: "Ilse Brandt", role: "ore buyer" }),
      person({ name: aboard }),
      person({}),
      person({}),
      { kind: "placeProp", item: "item.unobtainium", count: "1", at: "staging" },
      { kind: "placeProp", item: "item.med_kit", count: "1", at: "the bar" },
      { kind: "placeProp", item: "item.med_kit", count: "9", at: "staging" },
      { kind: "setAmbience", line: "" },
      { kind: "setAmbience", line: "Gulls everywhere." },
      { kind: "setAmbience", line: "And a second line." },
    ]);
    const reasons = dropped.map((d) => `${d.intentIndex} ${d.reason}`);
    expect(reasons).toEqual([
      '0 placePerson: unknown post "nowhere" on Kessler Drift, ore berth 3; use a post key listed under The dock you are dressing',
      '1 placePerson: "Nobody Here" is not one of Kessler Drift\'s people; use a name under People you know here, or a newFace',
      '2 placePerson: "Ilse Brandt" is not in your cast; use a seed or a newFace',
      `3 placePerson: ${aboard} is aboard the ship, not on the dock`,
      "5 placePerson: Ruth Calloway is already placed this call",
      '6 placeProp: unknown item "item.unobtainium"; use an item id from the catalogue',
      '7 placeProp: unknown post "the bar" on Kessler Drift, ore berth 3; use a post key listed under The dock you are dressing',
      expect.stringMatching(/^8 placeProp: invalid count/),
      "9 setAmbience: ambience line is empty",
      "11 setAmbience: one ambience line per docking",
    ]);
    const [command] = commands;
    if (command?.kind !== "stageDock") throw new Error("not stageDock");
    expect(command.payload.place.map((p) => p.who.name)).toEqual(["Ruth Calloway"]);
    expect(command.payload.props).toEqual([]);
    expect(command.payload.ambience).toBe("Gulls everywhere.");
  });

  it("caps people and props at three each", () => {
    const names = ["Ann One", "Bea Two", "Cy Three", "Di Four"];
    const { commands, dropped } = translate([
      ...names.map((name) => person({ name })),
      ...["1", "2", "3", "4"].map((count) => ({
        kind: "placeProp",
        item: "item.crate_general",
        count,
        at: "staging",
      })),
    ]);
    expect(dropped.map((d) => d.reason)).toEqual([
      "placePerson: at most 3 people per docking",
      "placeProp: at most 3 props per docking",
    ]);
    if (commands[0]?.kind !== "stageDock") throw new Error("not stageDock");
    expect(commands[0].payload.place).toHaveLength(3);
    expect(commands[0].payload.props).toHaveLength(3);
  });

  it("applies the player-text checks to names, roles, labels, looks and the ambience line", () => {
    const request = req();
    const snapshot = structuredClone(request.snapshot) as SaveEnvelope;
    const pump = Object.values(snapshot.state.machines).find(
      (m) => m.defId === "machine.coolant_pump",
    );
    if (pump === undefined) throw new Error("fixture: no pump");
    pump.scheduledFaults.push({
      faultKey: "worn_bearing",
      fireAtTick: snapshot.state.tick + 100,
      source: "narrator",
      commandId: "cmd:narrator:x:0" as CommandId,
    } as never);
    const { commands, dropped } = translate(
      [
        person({ label: "selling 3 crates for 40 credits" }),
        person({ name: "Ann One", look: "eyes on the worn bearing of your pump" }),
        person({ name: "Bea {Two}" }),
        person({ name: "Cy Three", role: "x".repeat(61) }),
        { kind: "setAmbience", line: "Docking fees are up 20% this week." },
      ],
      { snapshot },
    );
    expect(commands).toEqual([]);
    expect(dropped.map((d) => d.reason)).toEqual([
      "placePerson: label: player-facing text states a numeric consequence",
      'placePerson: look: player-facing text reveals something nobody aboard knows ("worn bearing")',
      "placePerson: name has template braces",
      "placePerson: role is longer than 60 characters",
      "setAmbience: ambience line: player-facing text states a numeric consequence",
    ]);
    expect(pump.id as MachineId).toBeDefined();
  });

  it("clips a long label, look or ambience line to the kernel's caps instead of dropping it", () => {
    const { commands, dropped } = translate([
      person({ label: "leaning on the hatch and watching every single crate come down the ramp" }),
      { kind: "setAmbience", line: `${"The conveyor rattles on and on. ".repeat(10)}` },
    ]);
    expect(dropped).toEqual([]);
    if (commands[0]?.kind !== "stageDock") throw new Error("not stageDock");
    expect(commands[0].payload.place[0]?.label?.length).toBeLessThanOrEqual(48);
    expect(commands[0].payload.ambience?.length).toBeLessThanOrEqual(200);
  });

  it("an empty plan is the floor set alone: no command at all", () => {
    expect(translate([])).toEqual({ commands: [], dropped: [] });
  });

  it("never touches the notes it reads", () => {
    const notes = structuredClone(CAST_NOTES);
    translate(FULL_PLAN, { notes });
    expect(notes).toEqual(CAST_NOTES);
  });
});
