/**
 * Dockside §2 (D58): what the world outside the hull looks like at a given moment. `sceneAt` is a
 * pure function of the travel stage, its progress and the two ports, so the port-bound scenery is
 * right on a reload, under playback interpolation and at every speed. Stars are the exception:
 * they carry no meaning, so the canvas scrolls them from its own accumulator at `starSpeed`.
 *
 * Distances along the ship are in deck lengths, positive aft (D72: west, −x in deck coordinates;
 * the conversion is `orientation.ts` `aftOf`): the ship never moves on screen, so the world flows
 * fore to aft past it and arrival never reverses.
 */
import type { DockDef, PortDef, PortDefId, PortSetting, RenderTravel } from "@crew/sim";
import { mixHex } from "./color";

/** Stand-in colours per setting until phase 2's dock maps bring a palette per port. */
export interface ScenePalette {
  /** Open space, behind everything in flight. */
  readonly space: string;
  /** Planet sky at full atmosphere (station: same as `space`). */
  readonly sky: string;
  /** The sky's far end of the gradient, toward the horizon. */
  readonly skyLow: string;
  /** Station hull, or the planet's disc. */
  readonly structure: string;
  /** Station lights, or the lit limb of the planet's disc. */
  readonly structureLight: string;
  /** Bay floor, or the ground around the pad. */
  readonly ground: string;
  /** Deck plating seams, or field strips. */
  readonly groundAccent: string;
  /** The berth, or the landing pad. */
  readonly pad: string;
  /** Hazard and pad markings. */
  readonly marking: string;
  /** Station bay walls in the foreground. */
  readonly wall: string;
  /** Cloud colour, as "r, g, b" so alpha can be applied. */
  readonly cloudRgb: string;
  /** Dust kicked up off the pad, as "r, g, b". */
  readonly dustRgb: string;
}

export const SCENE_PALETTES: Readonly<Record<PortSetting, ScenePalette>> = {
  station: {
    space: "#04060b",
    sky: "#04060b",
    skyLow: "#04060b",
    structure: "#3b4757",
    structureLight: "#7fd1ff",
    ground: "#141a22",
    groundAccent: "#1f2833",
    pad: "#1a222d",
    marking: "#b8892e",
    wall: "#2a3340",
    cloudRgb: "200, 210, 220",
    dustRgb: "150, 150, 150",
  },
  planet: {
    space: "#04060b",
    sky: "#9fb768",
    skyLow: "#5f8a63",
    structure: "#4f7a45",
    structureLight: "#d9cf7a",
    ground: "#4d6b34",
    groundAccent: "#7d8c3c",
    pad: "#6f757c",
    marking: "#e2c044",
    wall: "#2a3340",
    cloudRgb: "244, 241, 230",
    dustRgb: "196, 172, 124",
  },
};

export interface Scene {
  /** Which kind of port is in view: the one being left, approached, or berthed at. */
  readonly setting: PortSetting;
  readonly palette: ScenePalette;
  /** 0 open space to 1 full planet sky (always 0 at a station). */
  readonly sky: number;
  /** Background colour: `space` blended toward `sky` by `sky`. */
  readonly skyColor: string;
  /** Star streaming, 0 still to 1 full transit speed. 0 under reduced motion. */
  readonly starSpeed: number;
  readonly starAlpha: number;
  /**
   * Where the berth (bay or pad) is relative to the ship, in deck lengths, positive aft: 0 when
   * docked, negative ahead on arrival, positive astern on departure.
   */
  readonly portOffset: number;
  /** Size of the far scenery (station structure or planet disc): 0 a point, 1 full. */
  readonly portScale: number;
  /** Height above the berth, 0 landed to 1 in space; the planet's ground scales with it. */
  readonly altitude: number;
  /** Opacity of the berth-side scenery (bay, walls, ground, pad); the reduced-motion cross-fade. */
  readonly portAlpha: number;
  /** Cloud cover over the deck, 0 none to 1 thickest (planets only). */
  readonly cloudBand: number;
  /**
   * How far the clouds have streamed past, in deck lengths. Only meaningful while `cloudBand` is
   * above 0; it restarts between stages where no cloud is showing.
   */
  readonly cloudScroll: number;
  /** Dust kicked up around the ship on a pad, 0 to 1 (planets only). */
  readonly dust: number;
  /** Engine plume before the engines' own state is applied, 0 to 1. */
  readonly plume: number;
  /** 0 flight framing to 1 docked framing (ship plus dock map; `camera.ts`). */
  readonly cameraT: number;
}

export interface SceneOptions {
  /** `prefers-reduced-motion`: port scenery cross-fades instead of sliding; stars stand still. */
  readonly reducedMotion: boolean;
}

/** Deck lengths ahead the berth starts the approach (well off screen). */
export const APPROACH_START_OFFSET = -6;
/** Deck lengths ahead the berth is when docking begins: the bay mouth, just off the nose. */
export const DOCKING_START_OFFSET = -1.5;
/** How far the dock drifts aft while undocking. */
export const UNDOCKED_OFFSET = 0.12;
/** Deck lengths astern the berth has fallen by the end of departure (off screen). */
export const DEPARTED_OFFSET = 3;
/** Height reached by the end of undocking (the ground starts to drop away). */
const UNDOCKED_ALTITUDE = 0.15;
/** Plume while lifting off or backing out of the bay. */
const UNDOCKING_PLUME = 0.25;
/** Plume and star speed as the ship slows at the end of the approach. */
const APPROACH_END_PLUME = 0.3;
const APPROACH_END_STAR_SPEED = 0.2;
/** Stars still visible at a station's bay mouth. */
const APPROACH_END_STATION_STARS = 0.7;
/** Star speed when drifting: a crawl, so the ship still reads as moving through space. */
export const DRIFT_STAR_SPEED = 0.03;
/** Deck lengths of cloud that stream past over one stage. */
const CLOUD_TRAVEL = 4;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smoothstep over [0, 1]: zero slope at both ends. */
export function smooth(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

function easeIn(t: number): number {
  const x = clamp01(t);
  return x * x;
}

function easeOut(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) * (1 - x);
}

/** 0 at both ends of [0, 1], 1 in the middle. */
function bump(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  return Math.sin(Math.PI * t) ** 2;
}

function hexRgb(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** `a` blended toward `b` by `t`, as an `rgb()` string. Both must be `#rrggbb`. */
export function mixColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexRgb(a);
  const [br, bg, bb] = hexRgb(b);
  const k = clamp01(t);
  const r = Math.round(lerp(ar, br, k));
  const g = Math.round(lerp(ag, bg, k));
  const bl = Math.round(lerp(ab, bb, k));
  return `rgb(${r}, ${g}, ${bl})`;
}

type Channels = Omit<Scene, "setting" | "palette" | "skyColor">;

const BERTHED: Channels = {
  sky: 0,
  starSpeed: 0,
  starAlpha: 0,
  portOffset: 0,
  portScale: 1,
  altitude: 0,
  portAlpha: 1,
  cloudBand: 0,
  cloudScroll: 0,
  dust: 0,
  plume: 0,
  cameraT: 1,
};

const CRUISING: Channels = {
  sky: 0,
  starSpeed: 1,
  starAlpha: 1,
  portOffset: DEPARTED_OFFSET,
  portScale: 0,
  altitude: 1,
  portAlpha: 0,
  cloudBand: 0,
  cloudScroll: 0,
  dust: 0,
  plume: 1,
  cameraT: 0,
};

/** Stage by stage (dockside §2.4); `planet` switches on the sky, clouds and dust. */
function channels(stage: RenderTravel["state"], p: number, planet: boolean): Channels {
  const sky = planet ? 1 : 0;
  switch (stage) {
    case "docked":
    case "preparingDeparture":
      return { ...BERTHED, sky };
    case "undocking":
      return {
        ...BERTHED,
        sky,
        portOffset: UNDOCKED_OFFSET * easeIn(p),
        altitude: UNDOCKED_ALTITUDE * easeIn(p),
        dust: planet ? bump(p) : 0,
        plume: UNDOCKING_PLUME * p,
        cameraT: 1 - smooth(p),
      };
    case "departing":
      return {
        sky: planet ? 1 - smooth(p) : 0,
        starSpeed: easeIn(p),
        starAlpha: smooth((p - 0.3) / 0.7),
        portOffset: lerp(UNDOCKED_OFFSET, DEPARTED_OFFSET, easeIn(p)),
        portScale: 1 - smooth(p),
        altitude: lerp(UNDOCKED_ALTITUDE, 1, smooth(p)),
        portAlpha: 1 - smooth((p - 0.75) / 0.25),
        cloudBand: planet ? bump(p) : 0,
        cloudScroll: planet ? CLOUD_TRAVEL * p : 0,
        dust: 0,
        plume: lerp(UNDOCKING_PLUME, 1, easeIn(p)),
        cameraT: 0,
      };
    case "transit":
      return CRUISING;
    case "approaching": {
      const approachSky = planet ? smooth((p - 0.45) / 0.55) : 0;
      return {
        sky: approachSky,
        starSpeed: lerp(1, APPROACH_END_STAR_SPEED, easeOut(p)),
        starAlpha: planet ? 1 - approachSky : lerp(1, APPROACH_END_STATION_STARS, p),
        portOffset: lerp(APPROACH_START_OFFSET, DOCKING_START_OFFSET, easeOut(p)),
        portScale: easeIn(p),
        altitude: 1,
        portAlpha: smooth(p / 0.2),
        cloudBand: planet ? bump((p - 0.45) / 0.55) : 0,
        cloudScroll: planet ? CLOUD_TRAVEL * p : 0,
        dust: 0,
        plume: lerp(1, APPROACH_END_PLUME, easeOut(p)),
        cameraT: 0,
      };
    }
    case "docking":
      return {
        sky,
        starSpeed: APPROACH_END_STAR_SPEED * (1 - p),
        starAlpha: planet ? 0 : APPROACH_END_STATION_STARS * (1 - smooth(p)),
        portOffset: lerp(DOCKING_START_OFFSET, 0, easeOut(p)),
        portScale: 1,
        altitude: 1 - smooth(p),
        portAlpha: 1,
        cloudBand: 0,
        cloudScroll: 0,
        // The puff as the ship settles onto the pad.
        dust: planet ? bump((p - 0.6) / 0.4) : 0,
        plume: APPROACH_END_PLUME * (1 - p),
        cameraT: smooth(p),
      };
  }
}

/**
 * Reduced motion: nothing slides. The berth stays where it ends up and fades in on docking and out
 * on departure; clouds hold still; stars stop.
 */
function reduceMotion(stage: RenderTravel["state"], p: number, c: Channels): Channels {
  const portAlpha =
    stage === "approaching" || stage === "transit"
      ? 0
      : stage === "docking"
        ? smooth(p)
        : stage === "departing"
          ? 1 - smooth(p)
          : 1;
  return { ...c, starSpeed: 0, portOffset: 0, portAlpha, cloudScroll: 0 };
}

/** The port whose scenery is in view: the one being left until transit, then the destination. */
export function portInView(
  travel: Pick<RenderTravel, "state" | "fromPortId" | "toPortId">,
): PortDefId {
  switch (travel.state) {
    case "preparingDeparture":
    case "undocking":
    case "departing":
      return travel.fromPortId;
    case "docked":
    case "transit":
    case "approaching":
    case "docking":
      return travel.toPortId;
  }
}

/**
 * The scene outside the hull for one frame. Throws if the frame names a port the content does not
 * have: the worker runs the same bundle, so that is a bug, not a state to draw around.
 */
export function sceneAt(
  travel: RenderTravel,
  ports: Readonly<Record<PortDefId, Pick<PortDef, "setting">>>,
  options: SceneOptions,
): Scene {
  const portId = portInView(travel);
  const port = ports[portId];
  if (port === undefined) throw new Error(`sceneAt: unknown port "${portId}"`);
  const p = clamp01(travel.progress);
  const planet = port.setting === "planet";
  let c = channels(travel.state, p, planet);
  if (options.reducedMotion) c = reduceMotion(travel.state, p, c);
  if (travel.drifting) {
    c = { ...c, plume: 0, starSpeed: Math.min(c.starSpeed, DRIFT_STAR_SPEED) };
  }
  const palette = SCENE_PALETTES[port.setting];
  return {
    ...c,
    setting: port.setting,
    palette,
    skyColor: mixColor(palette.space, palette.sky, c.sky),
  };
}

/**
 * Phase 2: a planet's dock map brings its own sky colour (`palette.sky`); the scene's sky
 * gradient and blend use it in place of the per-setting stand-in. A station map changes nothing
 * here: its bay is drawn by the map itself.
 */
export function withDockSky(scene: Scene, dock: Pick<DockDef, "palette"> | undefined): Scene {
  const sky = dock?.palette.sky;
  if (scene.setting !== "planet" || sky === undefined) return scene;
  const palette: ScenePalette = { ...scene.palette, sky, skyLow: mixHex(sky, "#2e4a5a", 0.4) };
  return { ...scene, palette, skyColor: mixColor(palette.space, palette.sky, scene.sky) };
}
