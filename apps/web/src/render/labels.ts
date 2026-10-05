/**
 * Where people's labels go on a crowded canvas (slice-2 QA, D72 addendum): pure geometry over
 * measured label sizes, no drawing. A handover puts two people a tile apart beside the helm, a
 * bridge crowd stacks over the room plates on a phone, and a label that simply rose above its
 * dot covered the next person's label, the room's name plate and the machine's name. So each
 * label tries a few spots around its dot (above, below, beside, then further up or down with a
 * leader line back to the dot) and, if it is crowded everywhere, a shorter text; it never covers
 * another person's label, avoids people's dots and room plates where it can, and stays on the
 * canvas. Machine names and room plates under a placed label are left undrawn by the caller.
 */

/** A screen rectangle, CSS pixels. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** A box `width` × `height` centred on (`x`, `y`). */
export function centredBox(x: number, y: number, width: number, height: number): Box {
  return { left: x - width / 2, top: y - height / 2, right: x + width / 2, bottom: y + height / 2 };
}

/** One way to word a label, with its plate width as measured in the label font. */
export interface LabelText {
  readonly text: string;
  readonly width: number;
}

/** A person to label: where their dot is and the texts to try, preferred first. */
export interface LabelRequest {
  readonly dotX: number;
  readonly dotY: number;
  /** Never empty. The first is the full label; later ones are shorter forms for a crowd. */
  readonly texts: readonly LabelText[];
  /** Extra rise above the dot (a loaded hand truck's handle). */
  readonly lift: number;
}

/** What the canvas and the labels share. */
export interface LabelSpace {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** A label plate's height. */
  readonly plateHeight: number;
  readonly dotRadius: number;
}

/** Something a label would rather not cover, and how much covering it costs. */
export interface Obstacle {
  readonly box: Box;
  readonly cost: number;
}

/** What covering things costs a label; lower is better, and another person's label is never. */
export const LABEL_COSTS = {
  /** A person's dot: the label would hide who it is about, or someone else. */
  dot: 4,
  /** A room's name plate (`drawCompartmentLabels`). */
  roomPlate: 3,
  /** A machine's name, which is left undrawn under a label. */
  machineName: 1,
  /** Each step down the list of texts: a shorter text only when it buys real room. */
  shorterText: 2.5,
} as const;

export interface PlacedLabel {
  /** Index into the requests. */
  readonly index: number;
  readonly text: string;
  readonly box: Box;
  /** Set when the label sits away from its dot: draw a line from (dotX, dotY) to the box. */
  readonly leader: boolean;
}

interface Spot {
  readonly x: number;
  readonly y: number;
  readonly cost: number;
}

/** Candidate centres around a dot for a plate `width` wide, best first by preference cost. */
function spots(request: LabelRequest, width: number, space: LabelSpace): Spot[] {
  const { dotX, dotY, lift } = request;
  const r = space.dotRadius;
  const h = space.plateHeight;
  const above = dotY - r - 6 - lift;
  const below = dotY + r + 2 + h / 2;
  const step = h + 2;
  return [
    { x: dotX, y: above, cost: 0 },
    { x: dotX, y: below, cost: 0.6 },
    { x: dotX + r + 4 + width / 2, y: dotY, cost: 0.8 },
    { x: dotX - r - 4 - width / 2, y: dotY, cost: 0.8 },
    { x: dotX, y: above - step, cost: 1.5 },
    { x: dotX, y: below + step, cost: 1.8 },
    { x: dotX, y: above - 2 * step, cost: 2.5 },
    { x: dotX, y: below + 2 * step, cost: 2.8 },
  ];
}

/** Clamp a centre so the whole plate is on the canvas, 2 px in. */
function onCanvas(x: number, y: number, width: number, space: LabelSpace): [number, number] {
  const h = space.plateHeight;
  const cx = Math.max(width / 2 + 2, Math.min(space.viewportWidth - width / 2 - 2, x));
  const cy = Math.max(h / 2 + 2, Math.min(space.viewportHeight - h / 2 - 2, y));
  return [cx, cy];
}

/** The gap from a dot's edge to a box, so a label that drifted from its dot gets a leader. */
function gapToDot(box: Box, dotX: number, dotY: number, radius: number): number {
  const dx = Math.max(box.left - dotX, 0, dotX - box.right);
  const dy = Math.max(box.top - dotY, 0, dotY - box.bottom);
  return Math.hypot(dx, dy) - radius;
}

/**
 * Place every request's label, in order (the caller orders them: the first placed gets first
 * pick). Each gets the cheapest spot and text that overlaps no label already placed; with none,
 * its shortest text is stacked upward from above its dot until it clears them, as labels always
 * did, so every request is labelled.
 */
export function placeLabels(
  requests: readonly LabelRequest[],
  space: LabelSpace,
  obstacles: readonly Obstacle[],
): PlacedLabel[] {
  const dots: Obstacle[] = requests.map((r) => ({
    box: centredBox(r.dotX, r.dotY, space.dotRadius * 2, space.dotRadius * 2),
    cost: LABEL_COSTS.dot,
  }));
  const placed: PlacedLabel[] = [];
  requests.forEach((request, index) => {
    const others = dots.filter((_, i) => i !== index);
    let best: { label: PlacedLabel; cost: number } | undefined;
    request.texts.forEach(({ text, width }, textIndex) => {
      for (const spot of spots(request, width, space)) {
        const [x, y] = onCanvas(spot.x, spot.y, width, space);
        const box = centredBox(x, y, width, space.plateHeight);
        if (placed.some((p) => boxesOverlap(p.box, box))) continue;
        let cost = spot.cost + textIndex * LABEL_COSTS.shorterText;
        for (const o of [...others, ...obstacles]) if (boxesOverlap(o.box, box)) cost += o.cost;
        if (best === undefined || cost < best.cost) {
          const gap = gapToDot(box, request.dotX, request.dotY, space.dotRadius);
          best = { label: { index, text, box, leader: gap > 8 + request.lift }, cost };
        }
      }
    });
    placed.push(best?.label ?? stackedAbove(request, index, space, placed));
  });
  return placed;
}

/** The fallback: the shortest text above the dot, pushed up past every label in its way. */
function stackedAbove(
  request: LabelRequest,
  index: number,
  space: LabelSpace,
  placed: readonly PlacedLabel[],
): PlacedLabel {
  const shortest = request.texts[request.texts.length - 1];
  if (shortest === undefined) throw new Error("placeLabels: a label request has no text");
  const h = space.plateHeight;
  const [x] = onCanvas(request.dotX, 0, shortest.width, space);
  let y = request.dotY - space.dotRadius - 6 - request.lift;
  for (const p of [...placed].sort((a, b) => b.box.bottom - a.box.bottom)) {
    const box = centredBox(x, y, shortest.width, h);
    if (boxesOverlap(p.box, box)) y = p.box.top - h / 2 - 1;
  }
  const [, cy] = onCanvas(x, y, shortest.width, space);
  const box = centredBox(x, cy, shortest.width, h);
  const gap = gapToDot(box, request.dotX, request.dotY, space.dotRadius);
  return { index, text: shortest.text, box, leader: gap > 8 + request.lift };
}
