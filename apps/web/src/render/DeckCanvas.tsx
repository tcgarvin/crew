import type { RenderFrame } from "@crew/sim";
/**
 * Canvas host component (PLAN §6 W7). Fits the deck to the viewport (devicePixelRatio-aware),
 * redraws on every new frame, and turns taps/clicks into entity selection for the inspector.
 * Pan/zoom is explicitly not required (task brief).
 */
import { useCallback, useEffect, useRef } from "react";
import { MOCK_MACHINES } from "../worker/mockGeometry";
import { type ViewTransform, computeFitTransform, drawFrame } from "./draw";

export interface Selection {
  readonly kind: "actor" | "machine";
  readonly id: string;
}

export interface DeckCanvasProps {
  readonly frame: RenderFrame | undefined;
  readonly selected: Selection | undefined;
  readonly onSelect: (selection: Selection | undefined) => void;
}

const HIT_RADIUS_TILES = 0.8;

export function DeckCanvas({ frame, selected, onSelect }: DeckCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<ViewTransform>({ scale: 1, offsetX: 0, offsetY: 0 });
  const sizeRef = useRef({ width: 0, height: 0 });

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
    transformRef.current = computeFitTransform(width, height);
  }, []);

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
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !frame) return;
    const { width, height } = sizeRef.current;
    drawFrame(ctx, transformRef.current, frame, width, height, selected);
  }, [frame, selected]);

  const handlePointer = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!frame) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const t = transformRef.current;
      const worldX = (px - t.offsetX) / t.scale;
      const worldY = (py - t.offsetY) / t.scale;

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
        for (const m of MOCK_MACHINES) {
          const d = Math.hypot(m.x - worldX, m.y - worldY);
          if (d < HIT_RADIUS_TILES) {
            best = { kind: "machine", id: m.id };
            break;
          }
        }
      }
      onSelect(best);
    },
    [frame, onSelect],
  );

  return (
    <div className="deck-canvas-container" ref={containerRef}>
      <canvas ref={canvasRef} className="deck-canvas" onPointerDown={handlePointer} />
    </div>
  );
}
