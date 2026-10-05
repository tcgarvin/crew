/**
 * The planner's cleaning rule (D82) over a hand-built `AgentView` (dependency-cruiser's
 * `planner-boundary` rule covers tests here too): room affinity by role, anyone once the problem
 * ages, anyone while it is essential.
 */
import { describe, expect, it } from "vitest";
import type { DeckDef, DirtTier, RoleTag } from "../core/types/content";
import type { ActorId, CompartmentId, DeckDefId, ProblemId, TaskId } from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, ProblemView, SelfView, TaskView } from "../core/types/view";
import type { UrgencyClass } from "../core/types/work";
import { cleanTaskAllowed, cleaningRolesFor, isCleaningTask } from "./cleaning";

const DECK = "deck.stub" as DeckDefId;
const DAY = 1200;
const RATE = 20;
const AGING_DAYS = 0.075;

const deck: DeckDef = {
  id: DECK,
  name: "Stub",
  width: 6,
  height: 1,
  tiles: ["GHIBLM"],
  compartments: [
    { key: "galley", symbol: "G", name: "Galley", tags: ["galley"] },
    { key: "hold", symbol: "H", name: "Cargo Hold", tags: ["cargoHold"] },
    { key: "infirmary", symbol: "I", name: "Infirmary", tags: ["infirmary"] },
    { key: "bridge", symbol: "B", name: "Bridge", tags: ["bridge"] },
    { key: "lounge", symbol: "L", name: "Lounge", tags: ["lounge"] },
    { key: "mess", symbol: "M", name: "Mess", tags: ["mess"] },
  ],
  doors: [],
  openings: [],
  walls: [],
  machines: [],
  powerDomains: [],
  zones: [],
  docking: {
    cargoRampDoorKey: "x",
    personnelRampDoorKey: "x",
    cargoTransferTiles: [],
    personnelTransferTiles: [],
  },
  hull: { class: "test_hull", sizeClass: "S" },
  spawnPoints: [],
};

const config = {
  time: { tickRate: RATE, daySeconds: DAY, watchesPerDay: 3 },
  urgency: {
    needEssentialAbove: 0.7,
    needSurvivalAbove: 0.9,
    heatContainmentAbove: 0.7,
    heatSurvivalAbove: 0.9,
    routineAgingDays: AGING_DAYS,
    cleaningAgingDays: AGING_DAYS,
  },
} as PlannerConfig;

const AGING_TICKS = AGING_DAYS * DAY * RATE;

function viewAs(roleTags: readonly RoleTag[], tick: number): AgentView {
  const self = {
    id: "a1" as ActorId,
    name: "Stub",
    roleTags,
    onDuty: true,
  } as unknown as SelfView;
  return { tick, self, schematic: { deck } } as unknown as AgentView;
}

function dirty(
  key: string,
  tier: DirtTier = "dirty",
  urgency: UrgencyClass = "routineObligation",
): ProblemView {
  return {
    id: "p1" as ProblemId,
    kind: "compartmentDirty",
    payload: { compartmentId: "c1" as CompartmentId, key, tier },
    owner: "dirt",
    visibility: "public",
    dedupeKey: `dirty:${key}`,
    status: "open",
    createdTick: 0,
    revision: 1,
    baseUrgency: urgency,
    location: { kind: "compartment", compartmentId: "c1" as CompartmentId },
  };
}

const task = { id: "t1" as TaskId, type: "cleanCompartment" } as TaskView;

const allowed = (roles: readonly RoleTag[], problem: ProblemView, tick = 1) =>
  cleanTaskAllowed(viewAs(roles, tick), config, task, problem);

describe("cleanTaskAllowed (D82)", () => {
  it("decides only cleanCompartment tasks", () => {
    expect(isCleaningTask(task)).toBe(true);
    expect(isCleaningTask({ ...task, type: "haul" })).toBe(false);
  });

  it("the deckhand mops the hold and not the galley; the cook the galley and the mess", () => {
    expect(allowed(["deckhand"], dirty("hold"))).toBe(true);
    expect(allowed(["cook"], dirty("hold"))).toBe(false);
    expect(allowed(["cook"], dirty("galley"))).toBe(true);
    expect(allowed(["cook"], dirty("mess"))).toBe(true);
    expect(allowed(["deckhand"], dirty("galley"))).toBe(false);
  });

  it("the captain mops nothing but the bridge until the problem ages", () => {
    expect(allowed(["captain"], dirty("hold"))).toBe(false);
    expect(allowed(["captain"], dirty("bridge"))).toBe(true);
    expect(allowed(["captain"], dirty("hold"), AGING_TICKS - 1)).toBe(false);
    expect(allowed(["captain"], dirty("hold"), AGING_TICKS)).toBe(true);
  });

  it("anyone mops a filthy infirmary (essential), and nobody's room is anyone's once aged", () => {
    const filthy = dirty("infirmary", "filthy", "essentialOperation");
    for (const role of ["captain", "deckhand", "cook", "engineer"] as const) {
      expect(allowed([role], filthy)).toBe(true);
    }
    expect(allowed(["engineer"], dirty("infirmary"))).toBe(false);
    expect(allowed(["medic"], dirty("infirmary"))).toBe(true);
    expect(allowed(["deckhand"], dirty("lounge"))).toBe(false);
    expect(allowed(["deckhand"], dirty("lounge"), AGING_TICKS)).toBe(true);
  });
});

describe("cleaningRolesFor (D82)", () => {
  it("names the roles that keep a room clean, none for a room nobody keeps", () => {
    expect(cleaningRolesFor(["cargoHold"])).toEqual(["deckhand"]);
    expect(cleaningRolesFor(["galley"])).toEqual(["cook"]);
    expect(cleaningRolesFor(["bridge"])).toEqual(["captain", "firstOfficer", "pilot"]);
    expect(cleaningRolesFor(["quarters"])).toEqual([]);
    expect(cleaningRolesFor(["corridor", "engineering"])).toEqual(["engineer", "deckhand"]);
  });
});
