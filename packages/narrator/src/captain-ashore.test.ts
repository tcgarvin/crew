/**
 * §captain-ashore-ask on the narrator side: the `captainAshore` hook line, a card held to be
 * delivered in person (shown to the model as on its way, never as on screen, and counting as this
 * call's card), the null narrator still handing out work at the ask, and a held card that never
 * came up leaving "What the captain has seen".
 */
import type { DecisionId, SaveEnvelope, SimEvent } from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorPlan, NarratorRequest } from "./contract";
import { buildDigest } from "./digest";
import { captainAshoreRequest } from "./fixtures";
import { applyDecisionEvents } from "./history";
import { type CardShown, EMPTY_NOTES } from "./notes";
import { nullNarratorResponse } from "./null";
import { content, emptyPlan } from "./test-support";
import { translateIntents } from "./translate";

const HELD = "x90" as DecisionId;

/** The captain-ashore fixture with one card from Fenwick Adair held for delivery in person. */
function withHeldCard(): NarratorRequest {
  const req = captainAshoreRequest(content());
  const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
  const state = snapshot.state;
  const captain = Object.values(state.actors).find((a) => a.roleTags.includes("captain"));
  if (captain === undefined) throw new Error("no captain");
  state.decisions.records[HELD] = {
    id: HELD,
    origin: "narrator",
    perspectiveActorId: captain.id,
    prompt: {
      key: "narrator.decision",
      params: { title: "A word at the ramp", speaker: "Fenwick Adair" },
      prose: "Fenwick waves you over: he has a sealed crate that needs to go quietly.",
    },
    left: { label: { key: "narrator.decision.side", params: {}, prose: "Show me." }, commands: [] },
    right: {
      label: { key: "narrator.decision.side", params: {}, prose: "Not today." },
      commands: [],
    },
    status: "pending",
    createdTick: state.tick,
  };
  state.decisions.held.push({
    decisionId: HELD,
    speaker: "Fenwick Adair",
    portId: "port.kessler_drift" as never,
    heldTick: state.tick,
    delivery: { via: "captain", sinceTick: state.tick },
  });
  return { ...req, snapshot };
}

const card = {
  kind: "surfaceDecision",
  title: "Another thing",
  speaker: "Osric Tan",
  situation: "Osric leans out of the assay window with a question about the last load.",
  left: { label: "Ask him", effect: "none", coursePort: "", talkWith: "", tone: "" },
  right: { label: "Later", effect: "none", coursePort: "", talkWith: "", tone: "" },
  leftAftermath: "He tells you what he found.",
  rightAftermath: "He shrugs and goes back in.",
  beatOfThread: "",
  closesThread: "",
};

function sectionOf(text: string, heading: string): string[] {
  return text.split(`## ${heading}\n`)[1]?.split("\n\n")[0]?.split("\n") ?? [];
}

describe("captainAshore on the narrator side (§captain-ashore-ask)", () => {
  it("says who walked ashore, where, and that nothing is on offer", () => {
    const req = captainAshoreRequest(content());
    const text = buildDigest(req.snapshot, [], EMPTY_NOTES, content()).text;
    expect(sectionOf(text, "Why you were called")).toEqual([
      "captainAshore: Mara Osei has walked down the ramp onto the dock at Kessler Drift (port.kessler_drift) looking for work; nothing is on offer here",
    ]);
    expect(text).toContain("job offers possible now: fromPort port.kessler_drift");
  });

  it("shows a held card as on its way, not as a pending decision", () => {
    const req = withHeldCard();
    const text = buildDigest(req.snapshot, [], EMPTY_NOTES, content()).text;
    expect(sectionOf(text, "Cards on their way to the captain in person")).toEqual([
      `- ${HELD} from Fenwick Adair (the captain is on the way to them; not shown yet): Fenwick waves you over: he has a sealed crate that needs to go quietly.`,
    ]);
    expect(sectionOf(text, "Pending decisions")).toEqual([]);
  });

  it("counts a held card as this call's card", () => {
    const req = withHeldCard();
    const plan: NarratorPlan = emptyPlan({ intents: [card] as NarratorPlan["intents"] });
    const result = translateIntents(plan, {
      snapshot: req.snapshot,
      content: content(),
      hookTick: req.hook.tick,
      callId: "c1",
      hook: req.hook,
    });
    expect(result.commands).toEqual([]);
    expect(result.dropped[0]?.reason).toBe("surfaceDecision: only one card per call");
  });

  it("has the null narrator offer work at the ask, and only quietly while a card is held", () => {
    const fresh = nullNarratorResponse(captainAshoreRequest(content()), {
      callId: "c",
      content: content(),
    });
    const offer = fresh.commands.find((c) => c.kind === "offerJob");
    expect(offer?.kind === "offerJob" ? offer.payload.surface : undefined).toBe(true);
    const busy = nullNarratorResponse(withHeldCard(), { callId: "c", content: content() });
    const quiet = busy.commands.find((c) => c.kind === "offerJob");
    expect(quiet?.kind === "offerJob" ? quiet.payload.surface : undefined).not.toBe(true);
  });

  it("has the null narrator's work come from someone on the dock some of the time", () => {
    const base = captainAshoreRequest(content());
    const regulars = Object.values(base.snapshot.state.dockside.locals)
      .filter((l) => l.origin.kind === "regular")
      .map((l) => l.name);
    expect(regulars.length).toBeGreaterThan(0);
    const issuers = Array.from({ length: 12 }, (_, i) => {
      const snapshot = structuredClone(base.snapshot) as SaveEnvelope;
      snapshot.state.tick = 2_400 + i * 37;
      const res = nullNarratorResponse({ ...base, snapshot }, { callId: "c", content: content() });
      const offer = res.commands.find((c) => c.kind === "offerJob");
      if (offer?.kind !== "offerJob") throw new Error("no offer");
      const issuer = offer.payload.job.issuer;
      return typeof issuer === "string" ? issuer : issuer.name;
    });
    expect(issuers.some((name) => regulars.includes(name))).toBe(true);
    expect(issuers.some((name) => !regulars.includes(name))).toBe(true);
  });

  it("forgets a held card that was dropped before it ever came up", () => {
    const req = withHeldCard();
    const state = req.snapshot.state;
    const shown: CardShown = {
      tick: state.tick,
      decisionId: null,
      title: "A word at the ramp",
      speaker: "Fenwick Adair",
      gist: "Fenwick waves you over",
      leftLabel: "Show me.",
      rightLabel: "Not today.",
      chosen: null,
      closedThread: null,
    };
    const record = state.decisions.records[HELD];
    if (record === undefined) throw new Error("no record");
    record.status = "dropped";
    const dropped = {
      id: "e1",
      tick: state.tick + 1,
      seq: 0,
      type: "decisionDropped",
      subjectIds: [HELD],
      causeIds: [],
      source: "sim",
      significance: "notable",
      payload: { decisionId: HELD, reason: "the offer was expired before it was made" },
    } as unknown as SimEvent;
    expect(applyDecisionEvents([shown], [dropped], state, content())).toEqual([]);
  });
});
