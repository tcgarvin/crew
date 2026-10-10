import type { DirtFrame, PortDef, PortDefId, RenderFrame } from "@crew/sim";
/**
 * Canvas host component (PLAN §6 W7). Fits the ship to the viewport (devicePixelRatio-aware),
 * draws on animation frames, and turns taps/clicks into entity selection for the inspector.
 * Pan/zoom is explicitly not required (task brief).
 *
 * Integration 1: takes the real `DeckLayout` (derived from `@crew/content`'s `DeckDef`) instead
 * of the mock geometry, and rotates the canvas 90° on portrait viewports so a landscape deck
 * still fills the width (task item 5).
 *
 * Dockside (§stars-plume-and-the-animation-loop): the canvas runs its own animation loop, because
 * the stars stream and the plume flickers between sim frames. It redraws only while something moves
 * (stars, plume) or when the frame, selection or size changes, so a paused game at the dock costs
 * nothing.
 *
 * Dockside phase 2: the dock map for the port in view is drawn alongside, and the camera eases
 * from the flight framing to ship plus dock (`cameraBounds`) with the scene's `cameraT`, so the
 * fit is recomputed every drawn frame rather than on resize alone.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { cameraBounds } from "./camera";
import type { DeckLayout } from "./deckLayout";
import {
  type DockTable,
  berthInView,
  clampEngagement,
  dockInView,
  dockSlide,
  withDockSlide,
} from "./dock";
import {
  type DrawSelection,
  computeFitTransform,
  drawFrame,
  screenToWorld,
  shouldRotate,
} from "./draw";
import type { GrimeTint } from "./grime";
import { engineOutput, hullGeometry } from "./hull";
import { ImpactFlashes } from "./impacts";
import { pickAt } from "./pick";
import { RockFade, buildRockField, rockScrollSpeed } from "./rocks";
import { sceneAt, withDockSky } from "./scene";
import type { ViewTransform } from "./screen";
import { StarScroll, buildStarField } from "./stars";

export type Selection = DrawSelection;

export interface DeckCanvasProps {
  readonly layout: DeckLayout;
  /** The content's ports, for each one's setting (station or planet). */
  readonly ports: Readonly<Record<PortDefId, PortDef>>;
  /** The content's dock maps (empty when it has none: every port draws the stand-in berth). */
  readonly docks: DockTable;
  readonly frame: RenderFrame | undefined;
  /**
   * §dirt-grid: the dirt frame playback has reached, for the grime tint; none yet draws a clean
   * deck.
   */
  readonly dirt: DirtFrame | undefined;
  /** §dirt-grid: the tint's knobs (`config.dirt`). */
  readonly grimeTint: GrimeTint;
  /** The game is paused: the stars and plume hold still with it. */
  readonly paused: boolean;
  readonly selected: Selection | undefined;
  readonly onSelect: (selection: Selection | undefined) => void;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** -1..1, a slow uneven wobble for the plume's length. */
function plumeFlicker(nowMs: number): number {
  return Math.sin(nowMs / 37) * 0.6 + Math.sin(nowMs / 13) * 0.4;
}

/** The last picture drawn, so a tap hits what is on screen. */
interface Drawn {
  readonly transform: ViewTransform;
  /** How far the dock (and everyone on it) was drawn from its grafted place, tiles. */
  readonly slide: number;
}

export function DeckCanvas({
  layout,
  ports,
  docks,
  frame,
  dirt,
  grimeTint,
  paused,
  selected,
  onSelect,
}: DeckCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const drawnRef = useRef<Drawn>({ transform: { scale: 1, offsetX: 0, offsetY: 0 }, slide: 0 });
  const sizeRef = useRef({ width: 0, height: 0 });
  const rotatedRef = useRef(false);
  const hull = useMemo(() => hullGeometry(layout), [layout]);
  const stars = useMemo(() => buildStarField(), []);
  const scrollRef = useRef(new StarScroll());
  /**
   * §stuck-in-the-rocks: the asteroid field's rocks, their own scroll (still while stuck), fade and
   * flashes.
   */
  const rockField = useMemo(() => buildRockField(), []);
  const rockScrollRef = useRef(new StarScroll());
  const rockFadeRef = useRef(new RockFade());
  const flashesRef = useRef(new ImpactFlashes());
  const flashCountRef = useRef(0);
  /** Bumped whenever the picture must be redrawn even if nothing is animating. */
  const dirtyRef = useRef(true);
  const latest = useRef({ frame, dirt, selected, paused });

  useEffect(() => {
    latest.current = { frame, dirt, selected, paused };
    dirtyRef.current = true;
  }, [frame, dirt, selected, paused]);

  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;
    sizeRef.current = { width, height };
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Decided by the window, not the canvas: on a portrait phone the canvas is close to square,
    // so a headline wrapping to a second line (docked, "loading cargo (0 of 3 crates aboard)")
    // used to flip the whole drawing 90° and back as the headline changed.
    rotatedRef.current = shouldRotate(window.innerWidth, window.innerHeight, layout);
    dirtyRef.current = true;
  }, [layout]);

  useEffect(() => {
    resize();
    const observer = new ResizeObserver(resize);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [resize]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    let reducedMotion = prefersReducedMotion();
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const onMotionChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      dirtyRef.current = true;
    };
    media.addEventListener("change", onMotionChange);
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      const { frame: current, dirt: grime, selected: chosen, paused: still } = latest.current;
      if (current !== undefined) {
        const dock = dockInView(current, docks);
        const scene = withDockSky(sceneAt(current.travel, ports, { reducedMotion }), dock);
        const streaming = !still && scene.starSpeed > 0 && scene.starAlpha > 0;
        const plume = scene.plume * engineOutput(current, layout);
        const flickering = !still && !reducedMotion && plume > 0.01;
        scrollRef.current.advance(delta, still ? 0 : scene.starSpeed);
        // §stuck-in-the-rocks: the rocks stream with the stars but hold still while the ship is
        // stuck; their fade and the impact flashes run on real time, held while paused.
        const field = current.field;
        const running = still ? 0 : delta;
        rockScrollRef.current.advance(delta, rockScrollSpeed(field, scene.starSpeed, still));
        const fade = rockFadeRef.current;
        const alphaBefore = fade.alpha;
        fade.advance(running, field);
        const flashes = flashesRef.current;
        flashes.advance(running);
        flashes.note(current.impacts, current.tick);
        const flashing = flashes.active();
        // One more draw after the last flash ends, to clear it.
        const flashesChanged = flashing.length > 0 || flashCountRef.current > 0;
        flashCountRef.current = flashing.length;
        if (
          streaming ||
          flickering ||
          dirtyRef.current ||
          fade.alpha !== alphaBefore ||
          flashesChanged
        ) {
          dirtyRef.current = false;
          const { width, height } = sizeRef.current;
          const transform = computeFitTransform(
            width,
            height,
            cameraBounds(
              hull,
              dock === undefined ? undefined : berthInView(dock, layout),
              scene.cameraT,
            ),
            rotatedRef.current,
          );
          drawnRef.current = {
            transform,
            slide: dock === undefined ? 0 : dockSlide(scene, layout.width),
          };
          drawFrame(
            ctx,
            transform,
            layout,
            current,
            width,
            height,
            rotatedRef.current,
            {
              scene,
              hull,
              stars,
              starScrollPx: scrollRef.current.offsetPx,
              plume,
              flicker: flickering ? plumeFlicker(now) : 0,
              dock,
              clamps: clampEngagement(current.travel),
              ...(grime === undefined ? {} : { grime: { dirt: grime, tint: grimeTint } }),
              ...(fade.alpha <= 0
                ? {}
                : {
                    rocks: {
                      field: rockField,
                      scrollPx: rockScrollRef.current.offsetPx,
                      alpha: fade.alpha,
                      severity: fade.severity,
                    },
                  }),
              flashes: flashing,
            },
            chosen,
          );
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      media.removeEventListener("change", onMotionChange);
    };
  }, [layout, ports, docks, hull, stars, rockField, grimeTint]);

  const handlePointer = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!frame) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const { transform, slide } = drawnRef.current;
      const { x: worldX, y: worldY } = screenToWorld(
        transform,
        px,
        py,
        rotatedRef.current,
        sizeRef.current.height,
      );
      // Hit what is on screen: people and crates on the dock where the sliding dock put them.
      const shown = withDockSlide(frame, slide);

      onSelect(pickAt(shown, layout, dockInView(frame, docks), slide, worldX, worldY));
    },
    [frame, layout, docks, onSelect],
  );

  return (
    <div className="deck-canvas-container" ref={containerRef}>
      <canvas ref={canvasRef} className="deck-canvas" onPointerDown={handlePointer} />
    </div>
  );
}
