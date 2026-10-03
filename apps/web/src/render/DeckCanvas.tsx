import type { PortDef, PortDefId, RenderFrame } from "@crew/sim";
/**
 * Canvas host component (PLAN §6 W7). Fits the ship to the viewport (devicePixelRatio-aware),
 * draws on animation frames, and turns taps/clicks into entity selection for the inspector.
 * Pan/zoom is explicitly not required (task brief).
 *
 * Integration 1: takes the real `DeckLayout` (derived from `@crew/content`'s `DeckDef`) instead
 * of the mock geometry, and rotates the canvas 90° on portrait viewports so a landscape deck
 * still fills the width (task item 5).
 *
 * Dockside (D58): the canvas runs its own animation loop, because the stars stream and the plume
 * flickers between sim frames. It redraws only while something moves (stars, plume) or when the
 * frame, selection or size changes, so a paused game at the dock costs nothing.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  type DeckLayout,
  type ViewTransform,
  computeFitTransform,
  deckPiles,
  drawFrame,
  flightBounds,
  screenToWorld,
  shouldRotate,
} from "./draw";
import { engineOutput, hullGeometry } from "./hull";
import { sceneAt } from "./scene";
import { StarScroll, buildStarField } from "./stars";

export interface Selection {
  readonly kind: "actor" | "machine" | "item";
  readonly id: string;
}

export interface DeckCanvasProps {
  readonly layout: DeckLayout;
  /** The content's ports, for each one's setting (station or planet). */
  readonly ports: Readonly<Record<PortDefId, PortDef>>;
  readonly frame: RenderFrame | undefined;
  /** The game is paused: the stars and plume hold still with it. */
  readonly paused: boolean;
  readonly selected: Selection | undefined;
  readonly onSelect: (selection: Selection | undefined) => void;
}

const HIT_RADIUS_TILES = 0.8;
/** Crates sit on a tile; tapping anywhere near its square selects the pile's top item. */
const ITEM_HIT_RADIUS_TILES = 0.5;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** -1..1, a slow uneven wobble for the plume's length. */
function plumeFlicker(nowMs: number): number {
  return Math.sin(nowMs / 37) * 0.6 + Math.sin(nowMs / 13) * 0.4;
}

export function DeckCanvas({ layout, ports, frame, paused, selected, onSelect }: DeckCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<ViewTransform>({ scale: 1, offsetX: 0, offsetY: 0 });
  const sizeRef = useRef({ width: 0, height: 0 });
  const rotatedRef = useRef(false);
  const hull = useMemo(() => hullGeometry(layout), [layout]);
  const stars = useMemo(() => buildStarField(), []);
  const scrollRef = useRef(new StarScroll());
  /** Bumped whenever the picture must be redrawn even if nothing is animating. */
  const dirtyRef = useRef(true);
  const latest = useRef({ frame, selected, paused });

  useEffect(() => {
    latest.current = { frame, selected, paused };
    dirtyRef.current = true;
  }, [frame, selected, paused]);

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
    rotatedRef.current = shouldRotate(width, height, layout);
    transformRef.current = computeFitTransform(
      width,
      height,
      flightBounds(hull),
      rotatedRef.current,
    );
    dirtyRef.current = true;
  }, [layout, hull]);

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
      const { frame: current, selected: chosen, paused: still } = latest.current;
      if (current !== undefined) {
        const scene = sceneAt(current.travel, ports, { reducedMotion });
        const streaming = !still && scene.starSpeed > 0 && scene.starAlpha > 0;
        const plume = scene.plume * engineOutput(current, layout);
        const flickering = !still && !reducedMotion && plume > 0.01;
        scrollRef.current.advance(delta, still ? 0 : scene.starSpeed);
        if (streaming || flickering || dirtyRef.current) {
          dirtyRef.current = false;
          const { width, height } = sizeRef.current;
          drawFrame(
            ctx,
            transformRef.current,
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
  }, [layout, ports, hull, stars]);

  const handlePointer = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!frame) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const t = transformRef.current;
      const { x: worldX, y: worldY } = screenToWorld(
        t,
        px,
        py,
        rotatedRef.current,
        sizeRef.current.width,
      );

      let best: Selection | undefined;
      let bestDist = HIT_RADIUS_TILES;
      for (const actor of frame.actors) {
        const d = Math.hypot(actor.x - worldX, actor.y - worldY);
        if (d < bestDist) {
          bestDist = d;
          best = { kind: "actor", id: actor.id };
        }
      }
      if (!best) {
        let bestItem = ITEM_HIT_RADIUS_TILES;
        for (const pile of deckPiles(frame, layout.deckId)) {
          const d = Math.hypot(pile.x - worldX, pile.y - worldY);
          if (d < bestItem) {
            bestItem = d;
            best = { kind: "item", id: pile.top.id };
          }
        }
      }
      if (!best) {
        const machineByKey = new Map(
          frame.machines
            .filter((m) => m.deckId === layout.deckId)
            .map((m) => [m.placementKey, m.id] as const),
        );
        for (const m of layout.machines) {
          const d = Math.hypot(m.center.x - worldX, m.center.y - worldY);
          if (d < HIT_RADIUS_TILES + m.footprint.length * 0.4) {
            const id = machineByKey.get(m.placementKey);
            if (id !== undefined) {
              best = { kind: "machine", id };
              break;
            }
          }
        }
      }
      onSelect(best);
    },
    [frame, layout, onSelect],
  );

  return (
    <div className="deck-canvas-container" ref={containerRef}>
      <canvas ref={canvasRef} className="deck-canvas" onPointerDown={handlePointer} />
    </div>
  );
}
