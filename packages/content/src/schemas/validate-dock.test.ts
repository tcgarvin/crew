import type { DockDef } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { rawBundle } from "../loader";
import { validateBundle } from "./validate";
import { dockWalkableMask } from "./validate-dock";

type Raw = Record<string, Record<string, unknown>>;
type MutableDock = { -readonly [K in keyof DockDef]: DockDef[K] };

const HUB = "dock.crossroads_hub";
const HUB_PORT = "port.crossroads_hub";
/** Freighter Mk1 docked at the Hub (shipAt (3,1)): its ramps land at these dock tiles. */
const PERSONNEL_LANDING = { x: 5, y: 19 };
const CARGO_LANDING = { x: 16, y: 19 };

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
        'ramp "personnel_ramp" of "deck.freighter_mk1" lands at (5,19), which is wall',
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
      // Wall the lounge gate (6,26) into its corner of the quay.
      for (const [x, y] of [
        [5, 25],
        [6, 25],
        [7, 25],
        [5, 26],
        [7, 26],
      ] as const) {
        setTile(dock, x, y, "#");
      }
    });
    expect(messages).toContainEqual(
      expect.stringContaining('post "lounge_gate" at (6,26) cannot be reached from ramp'),
    );
  });

  it("rejects a post or area on anything but walkable floor", () => {
    const messages = messagesAfter((dock) => {
      dock.posts = dock.posts.map((p) =>
        p.key === "bench" ? { ...p, tile: { x: 15, y: 26 } } : p,
      );
      dock.areas = dock.areas.map((a) =>
        a.key === "delivery" ? { ...a, rect: { x: 31, y: 24, w: 2, h: 3 } } : a,
      );
    });
    expect(messages).toContainEqual(
      expect.stringContaining('post "bench" at (15,26) is wall, not walkable floor'),
    );
    expect(messages).toContainEqual(
      expect.stringContaining('area "delivery" tile (31,26) is wall, not walkable floor'),
    );
  });

  it("rejects a ramp landing inside an area", () => {
    const messages = messagesAfter((dock) => {
      dock.areas = dock.areas.map((a) =>
        a.key === "staging" ? { ...a, rect: { x: 15, y: 19, w: 3, h: 2 } } : a,
      );
    });
    expect(messages).toContainEqual(expect.stringContaining('inside area "staging"'));
  });

  it("rejects a berth that does not match the ship at shipAt", () => {
    const messages = messagesAfter((dock) => {
      dock.shipAt = { x: 4, y: 1 };
    });
    expect(messages).toContainEqual(
      expect.stringContaining('berth at (3,1) is not under "deck.freighter_mk1" docked at (4,1)'),
    );
  });

  it("rejects a map over the size cap", () => {
    const messages = messagesAfter((dock) => {
      dock.width = 50;
      dock.rows = dock.rows.map((r) => `${r}${r[0] === "#" ? "#" : " "}`.padEnd(50, "#"));
    });
    expect(messages).toContainEqual(expect.stringContaining("50 x 28 exceeds the 48 x 36 cap"));
  });

  it("rejects characters missing from the legend and rows of the wrong width", () => {
    expect(messagesAfter((dock) => setTile(dock, 0, 20, "?"))).toContainEqual(
      expect.stringContaining('row 20 uses "?", which is not in the legend'),
    );
    expect(
      messagesAfter((dock) => {
        dock.rows = dock.rows.map((r, y) => (y === 3 ? r.slice(1) : r));
      }),
    ).toContainEqual(expect.stringContaining("row 3 is 37 wide, expected width 38"));
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

  it("needs a sky colour for a planet dock", () => {
    const messages = messagesAfter((dock) => {
      dock.setting = "planet";
    });
    expect(messages).toContainEqual(expect.stringContaining("a planet dock needs palette.sky"));
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
