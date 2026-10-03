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

describe("passage offer card templates (passengers §6)", () => {
  const passage = {
    issuer: "Halla Thorne, assayer",
    name: "Halla Thorne",
    role: "assayer",
    from: "port.crossroads_hub",
    to: "port.ossory_station",
    urgency: "soon",
    pitch: "I need to get to Ossory and back. I can pay, and I don't take up much room.",
    passenger: "true",
    roundTrip: "true",
  };

  it("says a person wants passage there and back, travelling light, with passage sides and aftermaths", () => {
    const card = templateCard(offer(passage), bundle());
    expect(card.title).toBe("Halla Thorne, assayer");
    expect(card.speaker).toBe("Halla Thorne");
    expect(card.situation).toBe(
      "“I need to get to Ossory and back. I can pay, and I don't take up much room.” Halla Thorne wants passage to Ossory Station and back, travelling light, wanted soon.",
    );
    expect(card.situation).not.toMatch(/freight/i);
    expect(card.situation).not.toMatch(/\d/);
    expect(card.situation).not.toMatch(/\b(she|he|her|him|his|hers)\b/i);
    expect(card.situation.split(/\s+/).length).toBeLessThanOrEqual(70);
    expect(card.leftLabel).toBe("Welcome aboard.");
    expect(card.rightLabel).toBe("Not this trip.");
    expect(card.leftAftermath).toBe(
      "They come up the ramp with what they carry. We leave once they're settled.",
    );
    expect(card.rightAftermath).toBe("You pass. They go looking for another ship.");
    expect(`${card.leftAftermath} ${card.rightAftermath}`).not.toMatch(/\d/);
  });

  it("one way with luggage names the luggage by its cargo word and drops 'and back'", () => {
    const card = templateCard(
      offer({ ...passage, roundTrip: "false", cargo: "item.crate_fragile", urgency: "relaxed" }),
      bundle(),
    );
    expect(card.situation).toMatch(
      /” Halla Thorne wants passage to Ossory Station, with luggage \([a-z ]+\), no rush\.$/,
    );
    expect(card.situation.split("” ")[1]).not.toContain("and back");
    expect(card.situation).not.toMatch(/\d/);
  });

  it("keeps the freight sides for freight, and narrator prose on a side wins over the passage text", () => {
    const freight = templateCard(offer({ ...passage, passenger: "false" }), bundle());
    expect(freight.leftLabel).toBe("Take the job");
    expect(freight.situation).not.toContain("wants passage");
    const prose = offer(passage);
    const withProse = {
      ...prose,
      left: { ...prose.left, label: { ...prose.left.label, prose: "Bring her up." } },
    };
    expect(templateCard(withProse, bundle()).leftLabel).toBe("Bring her up.");
    expect(templateCard(withProse, bundle()).rightLabel).toBe("Not this trip.");
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

describe("passenger overdue card templates (passengers §3.3)", () => {
  function overdue(params: Decision["prompt"]["params"]): Decision {
    return {
      ...offer({}),
      prompt: { key: "commerce.passengerOverdue", params },
      left: {
        label: { key: "commerce.passengerOverdue.wait", params: {} },
        commands: [],
        aftermath: { key: "commerce.passengerOverdue.wait.aftermath", params: {} },
      },
      right: {
        label: { key: "commerce.passengerOverdue.leave", params: {} },
        commands: [],
        aftermath: { key: "commerce.passengerOverdue.leave.aftermath", params: {} },
      },
    };
  }

  it("names the passenger and the port, spoken by the first officer, with no numbers or pronoun guesses", () => {
    const card = templateCard(
      overdue({
        jobId: "j1",
        name: "Halla Thorne",
        port: "port.ossory_station",
        speaker: "Dane Whitcross",
      }),
      bundle(),
    );
    expect(card.title).toBe("Overdue: Halla Thorne");
    expect(card.speaker).toBe("Dane Whitcross");
    expect(card.situation).toMatch(/^Halla Thorne went ashore at Ossory Station/);
    expect(card.situation).not.toMatch(/\d/);
    expect(card.situation).not.toMatch(/\b(she|he|her|him)\b/i);
    expect(card.leftLabel).toBe("Wait for them");
    expect(card.rightLabel).toBe("Leave without them");
    expect(card.leftAftermath).toBeTruthy();
    expect(card.rightAftermath).toBeTruthy();
    expect(card.situation.split(/\s+/).length).toBeLessThanOrEqual(70);
  });

  it("falls back without a speaker or a name", () => {
    const card = templateCard(overdue({}));
    expect(card.title).toBe("Overdue");
    expect(card.speaker).toBeUndefined();
    expect(card.situation).toMatch(/^Our passenger went ashore at another port/);
  });
});
