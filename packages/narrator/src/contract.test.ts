import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildNarratorPlanSchema, buildNotesSchema } from "./contract";

const schema = buildNarratorPlanSchema();
/** §requested-call-back: every plan the model writes carries a call-back request. */
const callBack = { when: "nextPort", why: "" };

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
          passenger: false,
          roundTrip: false,
        },
        {
          kind: "spawnAtBoundary",
          port: "port.a",
          store: "warehouse",
          cargoItem: "item.crate",
          quantity: "one",
        },
        { kind: "scheduleFault", machine: "m1", faultKey: "wornBearing", window: "later" },
        { kind: "scheduleHazard", hazard: "ionStorm", difficulty: "brutal", window: "soon" },
        {
          kind: "scheduleField",
          severity: "heavy",
          detection: "unseen",
          window: "later",
          scripted: [
            { target: "m21", at: "late", rock: "small", effect: "knockout" },
            { target: "Galley", at: "early", rock: "", effect: "" },
          ],
        },
        {
          kind: "surfaceDecision",
          title: "A stranger at the ramp",
          speaker: "",
          situation: "A stranger asks for passage.",
          left: {
            label: "Take her aboard",
            effect: "setCourse",
            coursePort: "port.b",
            talkWith: "",
            tone: "",
          },
          right: { label: "Refuse", effect: "none", coursePort: "", talkWith: "", tone: "" },
          leftAftermath: "She comes aboard and we plot for Port B.",
          rightAftermath: "She walks back into the crowd.",
          beatOfThread: "",
          closesThread: "",
        },
      ],
      card: null,
      callBack,
    };
    expect(schema.parse(plan)).toEqual(plan);
    expect(schema.safeParse({ ...plan, intents: [{ kind: "setMoney", amount: 5 }] }).success).toBe(
      false,
    );
  });

  it("keeps notes out of the plan; the notes turn has its own schema (§notes-turn)", () => {
    const notes = {
      summary: "The crew took on seals at Port A.",
      threads: [
        {
          title: "Who is the stranger?",
          scale: "episode",
          people: ["Ines Varga"],
          arcNotes: "A stranger asked for passage at Port A.",
          nextBeat: "Once underway, she lets slip why she left.",
        },
      ],
      cast: [{ name: "Ines Varga", note: "Berth agent; regular employer.", portId: "port.a" }],
      retired: [],
      endedArcs: [],
    };
    expect(buildNotesSchema().parse(notes)).toEqual(notes);
    const plan = { rationale: "", intents: [], card: null, callBack };
    expect(schema.safeParse(plan).success).toBe(true);
    expect(schema.safeParse({ ...plan, notes }).success).toBe(false);
  });

  it("parses passenger and roundTrip on offerJob and endPassage on a side, and requires the booleans (passengers §4)", () => {
    const base = {
      rationale: "",
      intents: [],
      card: null,
      callBack,
    };
    const passage = {
      kind: "offerJob",
      issuerName: "Halla Thorne",
      issuerRole: "assayer",
      issuerOrg: "",
      pitch: "I need to get to Ossory and back.",
      description: "Passage there and home.",
      fromPort: "port.a",
      toPort: "port.b",
      cargoItem: "",
      quantity: "one",
      payTier: "standard",
      urgency: "soon",
      surface: true,
      passenger: true,
      roundTrip: true,
    };
    const putOff = {
      kind: "surfaceDecision",
      title: "About our passenger",
      speaker: "Dane Whitcross",
      situation: "Dane has a word about the passenger.",
      left: { label: "Put her off", effect: "endPassage", coursePort: "", talkWith: "", tone: "" },
      right: { label: "She stays", effect: "none", coursePort: "", talkWith: "", tone: "" },
      leftAftermath: "",
      rightAftermath: "",
      beatOfThread: "",
      closesThread: "",
    };
    const plan = { ...base, intents: [passage, putOff] };
    expect(schema.parse(plan)).toEqual(plan);
    const { passenger: _p, ...noPassenger } = passage;
    expect(schema.safeParse({ ...base, intents: [noPassenger] }).success).toBe(false);
    const { roundTrip: _r, ...noRoundTrip } = passage;
    expect(schema.safeParse({ ...base, intents: [noRoundTrip] }).success).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        intents: [{ ...putOff, left: { ...putOff.left, effect: "abandon" } }],
      }).success,
    ).toBe(false);
  });

  it("parses a privateTalk side with talkWith and a tone, empty for none, and requires both (§private-talk)", () => {
    const base = {
      rationale: "",
      intents: [],
      card: null,
      callBack,
    };
    const word = {
      kind: "surfaceDecision",
      title: "Words at the card table",
      speaker: "Dane Whitcross",
      situation: "Dane has a word about Jax.",
      left: {
        label: "My cabin. Now.",
        effect: "privateTalk",
        coursePort: "",
        talkWith: "Jax Okonkwo",
        tone: "stern",
      },
      right: { label: "Let them be.", effect: "none", coursePort: "", talkWith: "", tone: "" },
      leftAftermath: "",
      rightAftermath: "",
      beatOfThread: "",
      closesThread: "",
    };
    const plan = { ...base, intents: [word] };
    expect(schema.parse(plan)).toEqual(plan);
    const withLeft = (left: Record<string, unknown>) =>
      schema.safeParse({ ...base, intents: [{ ...word, left }] }).success;
    expect(withLeft({ ...word.left, tone: "kind" })).toBe(false);
    const { tone: _t, ...noTone } = word.left;
    expect(withLeft(noTone)).toBe(false);
    const { talkWith: _w, ...noTalkWith } = word.left;
    expect(withLeft(noTalkWith)).toBe(false);
  });

  it("does not embed the vocabulary: ids are strings the translator checks (§narrator-authority)", () => {
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

  it("accepts an empty or named speaker on the card, never a missing one (§spoken-cards, §narrator-authority)", () => {
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
      callBack,
    };
    expect(schema.safeParse(plan).success).toBe(true);
    expect(schema.safeParse({ ...plan, card: { ...card, speaker: "Mara Osei" } }).success).toBe(
      true,
    );
    const { speaker: _omitted, ...withoutSpeaker } = card;
    expect(schema.safeParse({ ...plan, card: withoutSpeaker }).success).toBe(false);
    // §plan-schema-in-the-prompt: null is a union type for the grammar compiler; empty means none.
    expect(schema.safeParse({ ...plan, card: { ...card, speaker: null } }).success).toBe(false);
  });

  it("requires callBack, with when one of nextPort, departure, midLeg (§requested-call-back)", () => {
    const plan = { rationale: "", intents: [], card: null };
    expect(schema.safeParse(plan).success).toBe(false);
    const departure = { when: "departure", why: "A debris field on the junior pilot's watch." };
    expect(schema.safeParse({ ...plan, callBack: departure }).success).toBe(true);
    expect(schema.safeParse({ ...plan, callBack: { ...departure, when: "never" } }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...plan, callBack: { when: "midLeg" } }).success).toBe(false);
  });
});
