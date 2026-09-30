import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildNarratorPlanSchema } from "./contract";

const schema = buildNarratorPlanSchema({
  ports: ["port.a", "port.b"],
  machines: ["m1"],
  faultKeys: ["wornBearing"],
  cargoItems: ["item.crate"],
  storeKeys: ["warehouse"],
});

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

describe("NarratorPlan structured-output schema", () => {
  const json = z.toJSONSchema(schema, { io: "input" });

  it("uses only keywords structured outputs support", () => {
    const unsupported = [
      "oneOf",
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "pattern",
      "$ref",
    ];
    walk(json, (n) => {
      for (const key of unsupported) expect(n).not.toHaveProperty(key);
    });
  });

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

  it("parses a plan with each intent kind", () => {
    const plan = {
      rationale: "Quiet stretch; offer work and seed a problem.",
      intents: [
        {
          kind: "offerJob",
          issuer: "Harbour co-op",
          description: "Crates of pump seals for the ring.",
          fromPort: "port.a",
          toPort: "port.b",
          cargoItem: "item.crate",
          quantity: "few",
          payTier: "standard",
          surface: true,
        },
        {
          kind: "spawnAtBoundary",
          port: "port.a",
          store: "warehouse",
          cargoItem: "item.crate",
          quantity: "one",
        },
        { kind: "scheduleFault", machine: "m1", faultKey: "wornBearing", window: "later" },
        {
          kind: "surfaceDecision",
          prompt: "A stranger asks for passage.",
          left: { label: "Take her aboard", effect: "setCourse", coursePort: "port.b" },
          right: { label: "Refuse", effect: "none", coursePort: null },
        },
      ],
      card: null,
      notes: "The crew took on seals at Port A.",
    };
    expect(schema.parse(plan)).toEqual(plan);
    expect(schema.safeParse({ ...plan, intents: [{ kind: "setMoney", amount: 5 }] }).success).toBe(
      false,
    );
  });
});
