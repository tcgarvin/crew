import type { ContentBundle, DockDef, ScenarioDef } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { rawBundle } from "../loader";
import type { ValidationIssue } from "./issues";
import { validateBundle } from "./validate";
import { checkQuayRow, checkScenarioBerths, dockWalkableMask } from "./validate-dock";

type Raw = Record<string, Record<string, unknown>>;
type MutableDock = { -readonly [K in keyof DockDef]: DockDef[K] };

const HUB = "dock.crossroads_hub";
const HUB_PORT = "port.crossroads_hub";
/** Freighter Mk1 in the Hub's berth box (box (2,1), ship at (4,3)): its ramps land here. */
const PERSONNEL_LANDING = { x: 33, y: 21 };
const CARGO_LANDING = { x: 22, y: 21 };

function hubDock(raw: Raw): MutableDock {
  return raw.docks?.[HUB] as MutableDock;
}

/** The authored bundle with the Hub dock edited; returns every issue message. */
function messagesAfter(edit: (dock: MutableDock, raw: Raw) => void): string[] {
  const raw = structuredClone(rawBundle()) as Raw;
  edit(hubDock(raw), raw);
  const result = validateBundle(raw);
  return result.ok ? [] : result.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

function setTile(dock: MutableDock, x: number, y: number, ch: string): void {
  const rows = [...dock.rows];
  const row = rows[y] ?? "";
  rows[y] = row.slice(0, x) + ch + row.slice(x + 1);
  dock.rows = rows;
}

describe("dock map validation", () => {
  it("accepts the authored docks", () => {
    expect(messagesAfter(() => {})).toEqual([]);
  });

  it("rejects a ramp that lands on a wall, naming the ramp and the tile", () => {
    const messages = messagesAfter((dock) =>
      setTile(dock, PERSONNEL_LANDING.x, PERSONNEL_LANDING.y, "#"),
    );
    expect(messages).toContainEqual(
      expect.stringContaining(
        'ramp "personnel_ramp" of "deck.freighter_mk1" lands at (33,21), which is wall',
      ),
    );
  });

  it("rejects a blocking prop on a ramp landing, but not a non-blocking one", () => {
    const prop = (blocking: boolean) => ({
      key: "in_the_way",
      kind: "crates" as const,
      rect: { x: CARGO_LANDING.x, y: CARGO_LANDING.y, w: 1, h: 1 },
      rot: 0 as const,
      blocking,
    });
    const withProp = (blocking: boolean) =>
      messagesAfter((dock) => {
        dock.props = [...dock.props, prop(blocking)];
      });
    expect(withProp(true)).toContainEqual(
      expect.stringContaining('which is under blocking prop "in_the_way"'),
    );
    expect(withProp(false)).toEqual([]);
  });

  it("rejects a post that the landings cannot reach", () => {
    const messages = messagesAfter((dock) => {
      // Wall the lounge gate (35,27) into its corner of the quay.
      for (const [x, y] of [
        [34, 26],
        [35, 26],
        [36, 26],
        [34, 27],
        [36, 27],
      ] as const) {
        setTile(dock, x, y, "#");
      }
    });
    expect(messages).toContainEqual(
      expect.stringContaining('post "lounge_gate" at (35,27) cannot be reached from ramp'),
    );
  });

  it("rejects a post or area on anything but walkable floor", () => {
    const messages = messagesAfter((dock) => {
      dock.posts = dock.posts.map((p) =>
        p.key === "bench" ? { ...p, tile: { x: 15, y: 28 } } : p,
      );
      dock.areas = dock.areas.map((a) =>
        a.key === "delivery" ? { ...a, rect: { x: 31, y: 26, w: 2, h: 3 } } : a,
      );
    });
    expect(messages).toContainEqual(
      expect.stringContaining('post "bench" at (15,28) is wall, not walkable floor'),
    );
    expect(messages).toContainEqual(
      expect.stringContaining('area "delivery" tile (31,28) is wall, not walkable floor'),
    );
  });

  it("rejects a ramp landing inside an area", () => {
    const messages = messagesAfter((dock) => {
      dock.areas = dock.areas.map((a) =>
        a.key === "staging" ? { ...a, rect: { x: 20, y: 21, w: 3, h: 2 } } : a,
      );
    });
    expect(messages).toContainEqual(expect.stringContaining('inside area "staging"'));
  });

  it("rejects a berth box over anything but void (§berth-boxes)", () => {
    const messages = messagesAfter((dock) => {
      dock.berth = { origin: { x: 1, y: 2 }, sizeClass: "M" };
    });
    expect(messages).toContainEqual(
      expect.stringContaining("berth.origin: berth box tile (1,21) is floor, not void"),
    );
  });

  it("rejects a map over the size cap", () => {
    const messages = messagesAfter((dock) => {
      dock.width = 50;
      dock.rows = dock.rows.map((r) => `${r}${r[0] === "#" ? "#" : " "}`.padEnd(50, "#"));
    });
    expect(messages).toContainEqual(expect.stringContaining("50 x 29 exceeds the 48 x 36 cap"));
  });

  it("rejects characters missing from the legend and rows of the wrong width", () => {
    expect(messagesAfter((dock) => setTile(dock, 0, 20, "?"))).toContainEqual(
      expect.stringContaining('row 20 uses "?", which is not in the legend'),
    );
    expect(
      messagesAfter((dock) => {
        dock.rows = dock.rows.map((r, y) => (y === 3 ? r.slice(1) : r));
      }),
    ).toContainEqual(expect.stringContaining("row 3 is 39 wide, expected width 40"));
  });

  it("needs exactly one gate, warehouse door, staging area and delivery bay", () => {
    const messages = messagesAfter((dock) => {
      dock.posts = dock.posts.filter((p) => p.kind !== "gate");
      dock.areas = [...dock.areas, { ...(dock.areas[1] as DockDef["areas"][number]), key: "b2" }];
    });
    expect(messages).toContainEqual(
      expect.stringContaining("needs exactly one gate post, found 0"),
    );
    expect(messages).toContainEqual(
      expect.stringContaining("needs exactly one deliveryBay area, found 2"),
    );
  });

  it("needs a sky colour for a planet port's dock, and none for a station's (§dock-map-content)", () => {
    const planet = messagesAfter((_dock, raw) => {
      const port = raw.ports?.[HUB_PORT] as { setting: string };
      port.setting = "planet";
    });
    expect(planet).toContainEqual(expect.stringContaining("a planet dock needs palette.sky"));
    const station = messagesAfter((dock) => {
      dock.palette = { ...dock.palette, sky: "#88aacc" };
    });
    expect(station).toContainEqual(expect.stringContaining("a station dock has no sky colour"));
  });

  it("refuses a dock that repeats its port's setting (§dock-map-content)", () => {
    const messages = messagesAfter((dock) => {
      (dock as unknown as Record<string, unknown>).setting = "station";
    });
    expect(messages.join("\n")).toMatch(/setting/);
  });

  it("checks castSeed posts against the port's dock", () => {
    const messages = messagesAfter((_dock, raw) => {
      const port = raw.ports?.[HUB_PORT] as { castSeed: { post?: string }[] };
      const seed = port.castSeed[0];
      if (seed !== undefined) seed.post = "no_such_post";
    });
    expect(messages).toContainEqual(
      expect.stringContaining(
        '"Hal Petrosyan" has post "no_such_post", which "dock.crossroads_hub" lacks',
      ),
    );
  });

  it("rejects a castSeed post at a port with no dock, and a second dock for one port", () => {
    const noDock = messagesAfter((dock) => {
      dock.portId = "port.kessler_drift" as DockDef["portId"];
    });
    expect(noDock).toContainEqual(expect.stringContaining("but the port has no dock"));
    const twice = messagesAfter((dock, raw) => {
      const docks = raw.docks as Record<string, unknown>;
      docks["dock.hub_again"] = { ...dock, id: "dock.hub_again" };
    });
    expect(twice).toContainEqual(
      expect.stringContaining('port "port.crossroads_hub" already has "dock.crossroads_hub"'),
    );
  });
});

const BOATHOUSE = "dock.boathouse";

/** The authored bundle with the Boathouse site map edited; returns every issue message. */
function siteMessagesAfter(edit: (dock: MutableDock) => void): string[] {
  return messagesAfter((_hub, raw) => edit(raw.docks?.[BOATHOUSE] as MutableDock));
}

type Post = DockDef["posts"][number];

describe("site map validation (expeditions A1, call 10)", () => {
  it("accepts the Boathouse, whose flank meets the direct route only beside the target", () => {
    expect(siteMessagesAfter(() => {})).toEqual([]);
  });

  it("needs exactly one target and one exit and at least one guard", () => {
    const messages = siteMessagesAfter((dock) => {
      dock.posts = dock.posts.filter((p) => p.kind !== "exit" && p.kind !== "guard");
      dock.defaultCast = (dock.defaultCast ?? []).filter((e) => e.part !== "guard");
    });
    expect(messages).toContainEqual(
      expect.stringContaining("a site needs exactly 1 exit post, found 0"),
    );
    expect(messages).toContainEqual(
      expect.stringContaining("a site needs at least 1 guard post, found 0"),
    );
  });

  it("rejects a flank whose only way into the shed is the direct route's door", () => {
    const messages = siteMessagesAfter((dock) => {
      // Shut the west door (10,26) and the north wall's west door (16,22): the east door is left.
      setTile(dock, 10, 26, "#");
      setTile(dock, 16, 22, "#");
    });
    expect(messages).toContainEqual(
      expect.stringContaining(
        'flank post "west_door" at (8,26) reaches the target only along the direct route from ramp "personnel_ramp" of "deck.freighter_mk2"',
      ),
    );
  });

  it("rejects a cast of seven", () => {
    const messages = siteMessagesAfter((dock) => {
      const pell = dock.defaultCast?.find((e) => e.part === "bystander");
      if (pell === undefined) throw new Error("the Boathouse has no bystander");
      const extra = [1, 2, 3].map((n) => ({ ...pell, name: `Netter ${n}` }));
      dock.defaultCast = [...(dock.defaultCast ?? []), ...extra];
    });
    expect(messages).toContainEqual(expect.stringContaining("7 people; at most 6"));
  });

  it("rejects a target at a guard post", () => {
    const messages = siteMessagesAfter((dock) => {
      dock.defaultCast = (dock.defaultCast ?? []).map((e) =>
        e.part === "target" ? { ...e, post: "east_door" } : e,
      );
    });
    expect(messages).toContainEqual(
      expect.stringContaining('Corran Vale is a target, at a target post, not "east_door" (guard)'),
    );
  });

  it("rejects a notice radius as wide as the map", () => {
    const messages = siteMessagesAfter((dock) => {
      dock.noticeRadius = 44;
    });
    expect(messages).toContainEqual(
      expect.stringContaining("noticeRadius 44 is not under the map's width 44"),
    );
  });

  it("lets a port's dock carry a bench and site post kinds, and ignores them", () => {
    const messages = messagesAfter((dock) => {
      const at = (key: string, kind: Post["kind"]): Post => ({
        key,
        kind,
        name: key,
        tile: PERSONNEL_LANDING,
        facing: "n",
      });
      dock.posts = [
        ...dock.posts.filter((p) => p.kind !== "bench"),
        at("bench", "bench"),
        at("odd_target", "target"),
        at("odd_flank", "flank"),
      ];
    });
    expect(messages).toEqual([]);
  });
});

describe("berth box against hull classes (§orientation-and-size)", () => {
  it("leaves a deck whose class is bigger than the box out of the dock's landing checks", () => {
    const messages = messagesAfter((_dock, raw) => {
      const mk1 = raw.decks?.["deck.freighter_mk1"] as { hull: { sizeClass: string } };
      const decks = raw.decks as Record<string, unknown>;
      // No scenario sails it, so nothing needs it to berth anywhere.
      decks["deck.big_copy"] = {
        ...mk1,
        id: "deck.big_copy",
        hull: { ...mk1.hull, sizeClass: "L" },
      };
    });
    expect(messages).toEqual([]);
  });

  it("rejects a scenario whose ship's class does not fit a dock's berth box", () => {
    const bundle = {
      decks: { "deck.big": { id: "deck.big", hull: { class: "x", sizeClass: "L", max: 100 } } },
      docks: {
        "dock.small": { id: "dock.small", berth: { origin: { x: 0, y: 0 }, sizeClass: "M" } },
        "dock.large": { id: "dock.large", berth: { origin: { x: 0, y: 0 }, sizeClass: "L" } },
      },
    } as unknown as ContentBundle;
    const scenario = { id: "scenario.test", deckId: "deck.big" } as unknown as ScenarioDef;
    const issues: ValidationIssue[] = [];
    checkScenarioBerths(scenario, bundle, issues);
    expect(issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([
      'scenarios.scenario.test.deckId: "deck.big" (class L) cannot berth at "dock.small" (an M box)',
    ]);
  });
});

describe("quay row (§berth-boxes)", () => {
  /**
   * A 26 x 16 map with an S box (24 x 14) at (1,0) between two wall columns, the quay row (14)
   * floor from edge to edge, and a wall row under it.
   */
  function quayDock(edit: (dock: MutableDock) => void = () => {}): DockDef {
    const dock = {
      id: "dock.test.quay",
      portId: "port.test.quay",
      name: "Quay test",
      palette: { floor: "#333333", wall: "#111111", accent: "#ffaa00" },
      width: 26,
      height: 16,
      rows: [
        ...Array.from({ length: 14 }, () => `#${" ".repeat(24)}#`),
        ".".repeat(26),
        "#".repeat(26),
      ],
      legend: { ".": "floor", "#": "wall", " ": "void" },
      berth: { origin: { x: 1, y: 0 }, sizeClass: "S" },
      posts: [],
      areas: [],
      props: [],
      foreground: [],
      ambience: "Quiet.",
    } as unknown as MutableDock;
    edit(dock);
    return dock;
  }

  function quayMessages(dock: DockDef): string[] {
    const issues: ValidationIssue[] = [];
    checkQuayRow(dock, issues);
    return issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  }

  it("accepts floor across the box's width", () => {
    expect(quayMessages(quayDock())).toEqual([]);
  });

  it("rejects a wall in the quay row, counting the rest of the gap", () => {
    const dock = quayDock((d) => {
      setTile(d, 1, 14, "#");
      setTile(d, 24, 14, "#");
    });
    expect(quayMessages(dock)).toEqual([
      "docks.dock.test.quay.berth.origin: quay row 14 under the berth box: (1,14) is wall, not walkable floor (and 1 more)",
    ]);
  });

  it("rejects a blocking prop on the quay row", () => {
    const dock = quayDock((d) => {
      d.props = [
        {
          key: "bollard_1",
          kind: "bollard",
          rect: { x: 10, y: 14, w: 1, h: 1 },
          rot: 0,
          blocking: true,
        },
      ];
    });
    expect(quayMessages(dock)).toEqual([
      'docks.dock.test.quay.berth.origin: quay row 14 under the berth box: (10,14) is under blocking prop "bollard_1", not walkable floor',
    ]);
  });

  it("rejects a box whose quay row would be off the map", () => {
    const dock = quayDock((d) => {
      d.berth = { origin: { x: 1, y: 2 }, sizeClass: "S" };
    });
    expect(quayMessages(dock)).toEqual([
      "docks.dock.test.quay.berth.origin: quay row 16 under the berth box: (1,16) is off the map, not walkable floor (and 23 more)",
    ]);
  });
});

describe("dock grime and dust (§dock-map-content, §dirt-deposits)", () => {
  const TERNS = "dock.terns_rest";
  const dust = (dockId: string, value: number): string[] =>
    messagesAfter((_, raw) => {
      (raw.docks?.[dockId] as MutableDock).airborneDust = value;
    });

  it("rejects airborne dust on a station's dock", () => {
    expect(dust(HUB, 0.1)).toEqual([
      `docks.${HUB}.airborneDust: "${HUB}" is a station dock but has airborneDust 0.1; a station has no sky (§dock-map-content)`,
    ]);
  });

  it("allows airborne dust on a planet's dock", () => {
    expect(dust(TERNS, 0.9)).toEqual([]);
  });

  it("allows grime on a station's dock", () => {
    const messages = messagesAfter((dock) => {
      dock.grime = 0.9;
    });
    expect(messages).toEqual([]);
  });

  it.each(["grime", "airborneDust"] as const)("rejects %s outside [0, 1]", (field) => {
    const messages = messagesAfter((dock) => {
      dock[field] = 1.5;
    });
    expect(messages.some((m) => m.includes(field))).toBe(true);
  });
});

describe("dockWalkableMask", () => {
  it("is floor under no blocking prop", () => {
    const dock = {
      width: 3,
      height: 1,
      rows: ["..#"],
      legend: { ".": "floor", "#": "wall" },
      props: [
        { key: "a", kind: "crates", rect: { x: 0, y: 0, w: 1, h: 1 }, rot: 0, blocking: true },
        { key: "b", kind: "lamp", rect: { x: 1, y: 0, w: 1, h: 1 }, rot: 0, blocking: false },
      ],
    } as unknown as DockDef;
    expect([...dockWalkableMask(dock)]).toEqual([0, 1, 0]);
  });
});
