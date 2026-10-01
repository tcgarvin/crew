/** D24–D26 offer card text from template keys, as the web host and the null narrator show it. */
import type { Decision, DecisionId } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadBundle } from "./loader";
import { renderTextRef, templateCard } from "./templates";

function bundle() {
  const result = loadBundle();
  if (!result.ok) throw new Error("content failed validation");
  return result.bundle;
}

function offer(params: Decision["prompt"]["params"]): Decision {
  return {
    id: "d1" as DecisionId,
    origin: "policy",
    perspectiveActorId: "a1" as Decision["perspectiveActorId"],
    prompt: { key: "job.offer", params },
    left: {
      label: { key: "job.offer.accept", params: {} },
      commands: [],
      aftermath: { key: "job.accept.aftermath", params: {} },
    },
    right: {
      label: { key: "job.offer.decline", params: {} },
      commands: [],
      aftermath: { key: "job.decline.aftermath", params: {} },
    },
    status: "pending",
    createdTick: 0,
  };
}

describe("offer card templates", () => {
  it("titles the card with the person and leads with their pitch", () => {
    const card = templateCard(
      offer({
        issuer: "Ysolde Maren, Meridian Growers Collective",
        name: "Ysolde Maren",
        role: "grower",
        org: "Meridian Growers Collective",
        from: "port.green_meridian",
        to: "port.crossroads_hub",
        cargo: "item.crate_perishable",
        urgency: "urgent",
        pitch: "This lot was picked this morning. It won't wait for the next quiet ship.",
      }),
      bundle(),
    );
    expect(card.title).toBe("Ysolde Maren, Meridian Growers Collective");
    expect(card.situation).toBe(
      "“This lot was picked this morning. It won't wait for the next quiet ship.” Fresh produce, Green Meridian to Crossroads Hub, needed urgently.",
    );
    expect(card.situation.split(/\s+/).length).toBeLessThanOrEqual(70);
    // D29: the issuer speaks on the offer card.
    expect(card.speaker).toBe("Ysolde Maren");
    expect(card.leftAftermath).toBe(
      "Taken. The crew start loading — we leave once the hold is full.",
    );
    expect(card.rightAftermath).toBe(
      "You pass. Word gets around the board; another offer usually turns up.",
    );
  });

  it("falls back to the role without an org, and to a stock pitch without one", () => {
    const card = templateCard(
      offer({
        name: "Wren Okafor",
        role: "dispatcher",
        pitchKey: "job.pitch.default",
        urgency: "relaxed",
      }),
      bundle(),
    );
    expect(card.title).toBe("Wren Okafor, dispatcher");
    expect(card.situation).toMatch(/^“Got freight that needs moving/);
    expect(card.situation).toMatch(/no rush\.$/);
  });

  it("never prints pay, even for a pre-D25 decision that still carries it", () => {
    const card = templateCard(
      offer({
        issuer: "Rendell Freight Co.",
        pay: 540,
        from: "port.kessler_drift",
        to: "port.crossroads_hub",
      }),
      bundle(),
    );
    expect(card.title).toBe("Rendell Freight Co.");
    expect(`${card.title} ${card.situation}`).not.toMatch(/\d/);
  });

  it("renders the aftermath keys on their own", () => {
    expect(renderTextRef({ key: "job.decline.aftermath", params: {} })).toMatch(/^You pass\./);
  });
});

describe("departure gate card templates (D36)", () => {
  function gate(params: Decision["prompt"]["params"]): Decision {
    return {
      ...offer({}),
      prompt: { key: "travel.departureGate", params },
      left: {
        label: { key: "travel.departureGate.hold", params: {} },
        commands: [],
        aftermath: { key: "travel.departureGate.hold.aftermath", params: {} },
      },
      right: {
        label: { key: "travel.departureGate.leave", params: {} },
        commands: [],
        aftermath: { key: "travel.departureGate.leave.aftermath", params: {} },
      },
    };
  }

  it("names the machine and the reason in plain words, spoken by the engineer, with no numbers", () => {
    const card = templateCard(
      gate({
        machineId: "m1",
        machine: "Main Engine",
        reason: "faultDerated",
        speaker: "Priya Kessler",
      }),
      bundle(),
    );
    expect(card.title).toBe("Before we leave: Main Engine");
    expect(card.speaker).toBe("Priya Kessler");
    expect(card.situation).toMatch(
      /^The main engine is running below full power with an unrepaired fault\./,
    );
    expect(card.situation).not.toMatch(/\d/);
    expect(card.leftLabel).toBe("Hold for repairs");
    expect(card.rightLabel).toBe("Leave anyway");
    expect(card.leftAftermath).toBeTruthy();
    expect(card.rightAftermath).toBeTruthy();
  });

  it("has a line for every impairment reason and a generic fallback", () => {
    for (const reason of ["blocked", "fault", "lowOutput", "faultDerated", "unknown"]) {
      const text = renderTextRef({
        key: "travel.departureGate",
        params: { machine: "Generator", reason },
      });
      expect(text).toMatch(/^The generator /);
      expect(text).not.toMatch(/\d/);
    }
    expect(templateCard(gate({ reason: "blocked" })).speaker).toBeUndefined();
    expect(templateCard(gate({ reason: "blocked" })).title).toBe("Before we leave");
  });
});
