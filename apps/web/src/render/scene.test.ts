import type { PortDefId, PortSetting, RenderTravel, TravelStage } from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  APPROACH_START_OFFSET,
  DEPARTED_OFFSET,
  DOCKING_START_OFFSET,
  DRIFT_STAR_SPEED,
  type Scene,
  type SceneOptions,
  mixColor,
  sceneAt,
} from "./scene";

const HUB = "port.hub" as PortDefId;
const FARM = "port.farm" as PortDefId;
const PORTS: Readonly<Record<PortDefId, { setting: PortSetting }>> = {
  [HUB]: { setting: "station" },
  [FARM]: { setting: "planet" },
};
const MOTION: SceneOptions = { reducedMotion: false };
const STILL: SceneOptions = { reducedMotion: true };

/** A frame leaving `from` for `to`; docked frames name `to` at both ends. */
function travel(
  state: TravelStage,
  progress: number,
  from: PortDefId,
  to: PortDefId,
  drifting = false,
): RenderTravel {
  return state === "docked"
    ? { state, progress: 0, fromPortId: to, toPortId: to, drifting: false }
    : { state, progress, fromPortId: from, toPortId: to, drifting };
}

/** Every numeric channel except `cloudScroll`, which may restart where no cloud is showing. */
const CONTINUOUS = [
  "sky",
  "starSpeed",
  "starAlpha",
  "portOffset",
  "portScale",
  "altitude",
  "portAlpha",
  "cloudBand",
  "dust",
  "plume",
  "cameraT",
] as const satisfies readonly (keyof Scene)[];

function expectContinuous(a: Scene, b: Scene): void {
  for (const key of CONTINUOUS) {
    expect({ key, value: b[key] }).toEqual({ key, value: expect.closeTo(a[key], 6) });
  }
  // A cloud restart is invisible only if there is no cloud at the seam.
  if (a.cloudScroll !== b.cloudScroll) {
    expect(a.cloudBand).toBe(0);
    expect(b.cloudBand).toBe(0);
  }
}

/** Two stages that follow each other, sampled at the seam. */
function seam(
  first: TravelStage,
  second: TravelStage,
  from: PortDefId,
  to: PortDefId,
  options = MOTION,
): [Scene, Scene] {
  return [
    sceneAt(travel(first, 1, from, to), PORTS, options),
    sceneAt(travel(second, 0, from, to), PORTS, options),
  ];
}

describe("sceneAt stage boundaries", () => {
  it("berths at a station: dock in place, no stars, no plume, docked framing", () => {
    const scene = sceneAt(travel("docked", 0, HUB, HUB), PORTS, MOTION);
    expect(scene).toMatchObject({
      setting: "station",
      sky: 0,
      starSpeed: 0,
      starAlpha: 0,
      portOffset: 0,
      portScale: 1,
      altitude: 0,
      portAlpha: 1,
      cloudBand: 0,
      dust: 0,
      plume: 0,
      cameraT: 1,
    });
  });

  it("sits on a planet's pad under its sky", () => {
    const scene = sceneAt(travel("docked", 0, FARM, FARM), PORTS, MOTION);
    expect(scene).toMatchObject({ setting: "planet", sky: 1, portOffset: 0, altitude: 0 });
    expect(scene.skyColor).toBe(mixColor(scene.palette.space, scene.palette.sky, 1));
  });

  it("streams stars at full speed in transit with the berth off screen astern", () => {
    for (const to of [HUB, FARM]) {
      const scene = sceneAt(travel("transit", 0.5, HUB, to), PORTS, MOTION);
      expect(scene).toMatchObject({
        sky: 0,
        starSpeed: 1,
        starAlpha: 1,
        portOffset: DEPARTED_OFFSET,
        portScale: 0,
        portAlpha: 0,
        plume: 1,
        cameraT: 0,
      });
    }
  });

  it("starts the approach with the port a point far ahead, and ends it at the bay mouth", () => {
    const start = sceneAt(travel("approaching", 0, FARM, HUB), PORTS, MOTION);
    expect(start).toMatchObject({ portScale: 0, portOffset: APPROACH_START_OFFSET, portAlpha: 0 });
    const end = sceneAt(travel("approaching", 1, FARM, HUB), PORTS, MOTION);
    expect(end).toMatchObject({ portScale: 1, portOffset: DOCKING_START_OFFSET });
    expect(end.starSpeed).toBeLessThan(start.starSpeed);
    expect(end.plume).toBeLessThan(start.plume);
  });

  it("brings a planet's sky up and its stars down over the approach", () => {
    const end = sceneAt(travel("approaching", 1, HUB, FARM), PORTS, MOTION);
    expect(end).toMatchObject({ sky: 1, starAlpha: 0 });
    const mid = sceneAt(travel("approaching", 0.75, HUB, FARM), PORTS, MOTION);
    expect(mid.cloudBand).toBeGreaterThan(0.5);
  });

  it("shows the departure port until transit, then the destination", () => {
    expect(sceneAt(travel("departing", 0.5, FARM, HUB), PORTS, MOTION).setting).toBe("planet");
    expect(sceneAt(travel("transit", 0.5, FARM, HUB), PORTS, MOTION).setting).toBe("station");
  });

  it("moves the berth only from fore to aft", () => {
    const order: [TravelStage, number][] = [
      ["approaching", 0],
      ["approaching", 0.5],
      ["docking", 0],
      ["docking", 0.5],
      ["docking", 1],
      ["undocking", 0.5],
      ["departing", 0],
      ["departing", 0.5],
      ["departing", 1],
    ];
    const offsets = order.map(
      ([stage, p]) => sceneAt(travel(stage, p, HUB, HUB), PORTS, MOTION).portOffset,
    );
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1] ?? Number.NEGATIVE_INFINITY);
    }
  });
});

describe("sceneAt continuity", () => {
  for (const port of [HUB, FARM]) {
    const name = PORTS[port]?.setting;
    it(`is continuous across approaching → docking → docked (${name})`, () => {
      expectContinuous(...seam("approaching", "docking", HUB, port));
      const docked = sceneAt(travel("docked", 0, port, port), PORTS, MOTION);
      expectContinuous(sceneAt(travel("docking", 1, HUB, port), PORTS, MOTION), docked);
    });

    it(`is continuous across undocking → departing → transit (${name})`, () => {
      const docked = sceneAt(travel("docked", 0, port, port), PORTS, MOTION);
      expectContinuous(docked, sceneAt(travel("preparingDeparture", 0, port, HUB), PORTS, MOTION));
      expectContinuous(...seam("preparingDeparture", "undocking", port, HUB));
      expectContinuous(...seam("undocking", "departing", port, HUB));
      // Transit already shows the destination; nothing of either port is on screen at the seam.
      const [left, cruising] = seam("departing", "transit", port, HUB);
      expectContinuous(left, cruising);
    });

    it(`is continuous at every seam under reduced motion (${name})`, () => {
      expectContinuous(...seam("approaching", "docking", HUB, port, STILL));
      expectContinuous(
        sceneAt(travel("docking", 1, HUB, port), PORTS, STILL),
        sceneAt(travel("docked", 0, port, port), PORTS, STILL),
      );
      expectContinuous(...seam("undocking", "departing", port, HUB, STILL));
      expectContinuous(...seam("departing", "transit", port, HUB, STILL));
    });
  }

  it("changes smoothly within a stage (no jumps between close samples)", () => {
    for (const stage of ["undocking", "departing", "approaching", "docking"] as const) {
      for (const port of [HUB, FARM]) {
        for (let i = 0; i < 100; i++) {
          const a = sceneAt(travel(stage, i / 100, HUB, port), PORTS, MOTION);
          const b = sceneAt(travel(stage, (i + 1) / 100, HUB, port), PORTS, MOTION);
          for (const key of CONTINUOUS) {
            // The berth crosses up to ~4.5 deck lengths in one stage; the rest are 0..1 channels.
            const limit = key === "portOffset" ? 0.2 : 0.1;
            expect({ stage, key, step: Math.abs(b[key] - a[key]) < limit }).toEqual({
              stage,
              key,
              step: true,
            });
          }
        }
      }
    }
  });
});

describe("sceneAt reduced motion", () => {
  it("never slides the berth and fades it in while docking instead", () => {
    for (const p of [0, 0.3, 0.7, 1]) {
      const scene = sceneAt(travel("docking", p, HUB, HUB), PORTS, STILL);
      expect(scene.portOffset).toBe(0);
      expect(scene.starSpeed).toBe(0);
    }
    expect(sceneAt(travel("docking", 0, HUB, HUB), PORTS, STILL).portAlpha).toBe(0);
    expect(sceneAt(travel("docking", 0.5, HUB, HUB), PORTS, STILL).portAlpha).toBeCloseTo(0.5);
    expect(sceneAt(travel("departing", 1, HUB, HUB), PORTS, STILL).portAlpha).toBe(0);
    expect(sceneAt(travel("approaching", 0.9, HUB, HUB), PORTS, STILL).portAlpha).toBe(0);
  });
});

describe("sceneAt drifting", () => {
  it("slows the stars to a crawl and kills the plume", () => {
    for (const stage of ["transit", "approaching", "departing"] as const) {
      const scene = sceneAt(travel(stage, 0.6, HUB, FARM, true), PORTS, MOTION);
      expect(scene.plume).toBe(0);
      expect(scene.starSpeed).toBeLessThanOrEqual(DRIFT_STAR_SPEED);
      expect(scene.starSpeed).toBeGreaterThan(0);
    }
  });
});

describe("sceneAt content errors", () => {
  it("throws on a port the content does not have", () => {
    const unknown = "port.nowhere" as PortDefId;
    expect(() => sceneAt(travel("transit", 0.5, HUB, unknown), PORTS, MOTION)).toThrow(
      /unknown port "port.nowhere"/,
    );
  });
});

describe("mixColor", () => {
  it("blends two hex colours", () => {
    expect(mixColor("#000000", "#ffffff", 0)).toBe("rgb(0, 0, 0)");
    expect(mixColor("#000000", "#ffffff", 1)).toBe("rgb(255, 255, 255)");
    expect(mixColor("#000000", "#204060", 0.5)).toBe("rgb(16, 32, 48)");
  });
});
