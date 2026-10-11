import { describe, expect, it } from "vitest";
import {
  type Box,
  LABEL_COSTS,
  type LabelRequest,
  type LabelSpace,
  boxesOverlap,
  centredBox,
  fitLabelText,
  maxPlateWidth,
  placeLabels,
} from "./labels";

const SPACE: LabelSpace = {
  viewportWidth: 400,
  viewportHeight: 300,
  plateHeight: 15,
  dotRadius: 4,
};

function request(dotX: number, dotY: number, ...texts: [string, number][]): LabelRequest {
  return { dotX, dotY, texts: texts.map(([text, width]) => ({ text, width })), lift: 0 };
}

const inside = (box: Box, space: LabelSpace) =>
  box.left >= 0 &&
  box.top >= 0 &&
  box.right <= space.viewportWidth &&
  box.bottom <= space.viewportHeight;

describe("person label placement (slice-2 QA)", () => {
  it("puts a lone label just above its dot", () => {
    const [label] = placeLabels([request(200, 150, ["Mara Osei — idle", 100])], SPACE, []);
    expect(label?.box.bottom).toBeLessThanOrEqual(150);
    expect((label?.box.left ?? 0) + (label?.box.right ?? 0)).toBe(400);
    expect(label?.leader).toBe(false);
  });

  it("never lets two people a tile apart cover each other's labels (the handover)", () => {
    const labels = placeLabels(
      [
        request(200, 162, ["Jax Okonkwo — relieving Noor", 170]),
        request(200, 150, ["Noor Haddad — at the helm", 150]),
      ],
      SPACE,
      [],
    );
    expect(labels).toHaveLength(2);
    const [a, b] = labels;
    expect(boxesOverlap(a?.box as Box, b?.box as Box)).toBe(false);
    for (const label of labels) expect(inside(label.box, SPACE)).toBe(true);
  });

  it("moves a label off a room plate when there is room elsewhere", () => {
    const plate = { box: centredBox(200, 139, 80, 15), cost: LABEL_COSTS.roomPlate };
    const [label] = placeLabels([request(200, 150, ["Dane — idle", 70])], SPACE, [plate]);
    expect(boxesOverlap(label?.box as Box, plate.box)).toBe(false);
  });

  it("takes the shorter text when the full one only fits over something", () => {
    // A dot in a slot between two walls of plates: only a narrow label fits beside it.
    const blocks = [
      { box: { left: 0, top: 0, right: 400, bottom: 140 }, cost: LABEL_COSTS.roomPlate },
      { box: { left: 0, top: 160, right: 400, bottom: 300 }, cost: LABEL_COSTS.roomPlate },
      { box: { left: 0, top: 140, right: 150, bottom: 160 }, cost: LABEL_COSTS.roomPlate },
      { box: { left: 290, top: 140, right: 400, bottom: 160 }, cost: LABEL_COSTS.roomPlate },
    ];
    const [label] = placeLabels(
      [request(200, 150, ["Jax Okonkwo — relieving Noor", 170], ["Jax — relieving Noor", 80])],
      SPACE,
      blocks,
    );
    expect(label?.text).toBe("Jax — relieving Noor");
  });

  it("keeps a label at the canvas edge on the canvas", () => {
    const labels = placeLabels(
      [
        request(2, 2, ["Priya Kessler — doing rounds", 160]),
        request(398, 298, ["Tomas — idle", 80]),
      ],
      SPACE,
      [],
    );
    for (const label of labels) expect(inside(label.box, SPACE)).toBe(true);
  });

  it("labels everyone in a crowd, with leaders for those set away from their dots", () => {
    const crowd = Array.from({ length: 8 }, (_, i) =>
      request(200 + (i % 2) * 6, 150 + Math.floor(i / 2) * 6, [`Person ${i} — eating`, 120]),
    );
    const labels = placeLabels(crowd, SPACE, []);
    expect(labels).toHaveLength(8);
    for (const [i, a] of labels.entries()) {
      for (const b of labels.slice(i + 1)) expect(boxesOverlap(a.box, b.box)).toBe(false);
    }
    expect(labels.some((l) => l.leader)).toBe(true);
  });
});

describe("fitLabelText", () => {
  const measure = (text: string) => text.length * 6;

  it("keeps a text that fits", () => {
    expect(fitLabelText("cards — Jax, Tomas", 200, measure)).toBe("cards — Jax, Tomas");
  });

  it("cuts a text too wide for the canvas with an ellipsis, inside the width", () => {
    const full = "putting a vid on — Noor, Dane, Su…";
    const fitted = fitLabelText(full, 120, measure);
    expect(fitted.endsWith("…")).toBe(true);
    expect(measure(fitted)).toBeLessThanOrEqual(120);
    expect(full.startsWith(fitted.slice(0, -1))).toBe(true);
  });

  it("keeps at least the first character and the ellipsis", () => {
    expect(fitLabelText("Oyelaran", 1, measure)).toBe("O…");
  });
});

describe("plates at the canvas edge", () => {
  it("places a plate cut to the canvas width wholly on the canvas", () => {
    const space: LabelSpace = { ...SPACE, viewportWidth: 120 };
    const width = maxPlateWidth(space.viewportWidth);
    const [label] = placeLabels([request(3, 150, ["wide", width])], space, []);
    expect(label?.box.left).toBeGreaterThanOrEqual(0);
    expect(label?.box.right).toBeLessThanOrEqual(120);
  });

  it("clamps a plate whose dot is at the left edge so it starts on the canvas", () => {
    const [label] = placeLabels([request(0, 150, ["putting a vid on", 100])], SPACE, []);
    expect(label?.box.left).toBeGreaterThanOrEqual(0);
  });
});
