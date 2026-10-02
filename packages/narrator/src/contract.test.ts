import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildNarratorPlanSchema } from "./contract";

const schema = buildNarratorPlanSchema();

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
          issuerName: "Ines Varga",
          issuerRole: "berth agent",
          issuerOrg: "Harbour co-op",
          pitch: "Seals for the ring pumps. They've been asking for a month.",
          description: "Crates of pump seals for the ring.",
          fromPort: "port.a",
          toPort: "port.b",
          cargoItem: "item.crate",
          quantity: "few",
          payTier: "standard",
          urgency: "soon",
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
          title: "A stranger at the ramp",
          speaker: "",
          situation: "A stranger asks for passage.",
          left: { label: "Take her aboard", effect: "setCourse", coursePort: "port.b" },
          right: { label: "Refuse", effect: "none", coursePort: "" },
          leftAftermath: "She comes aboard and we plot for Port B.",
          rightAftermath: "She walks back into the crowd.",
          beatOfThread: "",
        },
      ],
      card: null,
      notes: {
        summary: "The crew took on seals at Port A.",
        threads: [
          {
            title: "Who is the stranger?",
            scale: "episode",
            people: ["Ines Varga"],
            stage: "A stranger asked for passage at Port A.",
            nextBeat: "Once underway, she lets slip why she left.",
          },
        ],
        cast: [{ name: "Ines Varga", note: "Berth agent; regular employer.", portId: "port.a" }],
      },
    };
    expect(schema.parse(plan)).toEqual(plan);
    expect(schema.safeParse({ ...plan, intents: [{ kind: "setMoney", amount: 5 }] }).success).toBe(
      false,
    );
  });

  it("does not embed the vocabulary: ids are strings the translator checks (D45)", () => {
    walk(json, (n) => {
      if (Array.isArray(n.enum)) expect(n.enum.length).toBeLessThanOrEqual(8);
    });
    // Unions are the grammar compiler's expensive construct: only `card` and the intents union.
    let unions = 0;
    walk(json, (n) => {
      if (Array.isArray(n.anyOf) || Array.isArray(n.type)) unions += 1;
    });
    expect(unions).toBe(2);
    const text = JSON.stringify(json);
    expect(text).not.toContain("port.a");
    expect(text).toContain('from \\"What you can do\\"');
  });

  it("accepts an empty or named speaker on the card, never a missing one (D29, D45)", () => {
    const card = {
      title: "Mara flags a problem",
      speaker: "",
      situation: "Mara catches you in the corridor.",
      leftLabel: "I'll take it.",
      rightLabel: "You handle it.",
      leftAftermath: "You go looking for Jax.",
      rightAftermath: "Mara nods and heads aft.",
    };
    const plan = {
      rationale: "r",
      intents: [],
      card,
      notes: { summary: "", threads: [], cast: [] },
    };
    expect(schema.safeParse(plan).success).toBe(true);
    expect(schema.safeParse({ ...plan, card: { ...card, speaker: "Mara Osei" } }).success).toBe(
      true,
    );
    const { speaker: _omitted, ...withoutSpeaker } = card;
    expect(schema.safeParse({ ...plan, card: withoutSpeaker }).success).toBe(false);
    // D45: null is a union type for the grammar compiler; empty means none.
    expect(schema.safeParse({ ...plan, card: { ...card, speaker: null } }).success).toBe(false);
  });
});
