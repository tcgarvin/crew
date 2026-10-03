import { describe, expect, it } from "vitest";
import { planJsonSchema } from "../plan";
import { buildStagingPlanSchema, stagingEnvelopeSchema } from "./plan";

/** Walk a JSON Schema and collect every object node. */
function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    visit(record);
    for (const child of Object.values(record)) walk(child, visit);
  }
}

describe("the staging plan schema (D67, in the D53 style)", () => {
  const json = planJsonSchema(buildStagingPlanSchema());

  it("closes every object and requires every property", () => {
    walk(json, (n) => {
      if (n.type === "object" && n.properties) {
        expect(n.additionalProperties).toBe(false);
        expect(Object.keys(n.properties as object).sort()).toEqual(
          [...(n.required as string[])].sort(),
        );
      }
    });
  });

  it("is game-independent and small: no per-game ids, no story levers, under 2 KiB", () => {
    const text = JSON.stringify(json);
    expect(text).not.toContain("port.");
    expect(text).not.toContain("item.");
    expect(text).not.toContain("offerJob");
    // No notes, no card: the plan is the two keys.
    expect(Object.keys(json.properties as object)).toEqual(["rationale", "intents"]);
    expect(text.length).toBeLessThan(2 * 1024);
  });

  it("parses a plan with each intent kind", () => {
    const plan = {
      rationale: "Set up the courier for the story.",
      intents: [
        {
          kind: "placePerson",
          who: "newFace",
          name: "Ruth Calloway",
          role: "courier",
          look: "oilskin coat",
          post: "canteen_hatch",
          label: "watching the ramps",
        },
        { kind: "placeProp", item: "item.crate_general", count: "2", at: "staging" },
        { kind: "setAmbience", line: "Ore dust hangs in the lamplight." },
      ],
    };
    expect(buildStagingPlanSchema().safeParse(plan).success).toBe(true);
    expect(stagingEnvelopeSchema.safeParse(plan).success).toBe(true);
  });

  it("the envelope takes any intent (the translator drops it) but nothing beside the plan", () => {
    expect(
      stagingEnvelopeSchema.safeParse({ rationale: "x", intents: [{ kind: "offerJob" }] }).success,
    ).toBe(true);
    expect(
      stagingEnvelopeSchema.safeParse({ rationale: "x", intents: [], notes: {} }).success,
    ).toBe(false);
    expect(
      stagingEnvelopeSchema.safeParse({ rationale: "x", intents: [], card: null }).success,
    ).toBe(false);
  });
});
