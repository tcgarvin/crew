import { describe, expect, it } from "vitest";
import { stageDockRequest } from "../fixtures";
import { NULL_NARRATOR_MODEL } from "../null";
import { STATIC_RULES } from "../prompts/index";
import { PROMPT_VERSION } from "../prompts/system";
import { runNarrator, runNarratorWithTrace } from "../run";
import { content, fakeTransport, okResult } from "../test-support";
import { TransportError } from "../transport";
import { STAGING_RULES } from "./prompt";

const STORED_NOTES = {
  summary: "The crew are owed money at the Drift.",
  threads: [
    {
      title: "Greta's grudge",
      scale: "episode",
      people: ["Greta Lindholm"],
      arcNotes: "Greta thinks the ship jumped the queue last time.",
      nextBeat: "Next time at the Drift, she makes them wait.",
      lastBeatTick: 400,
      beatCardShown: false,
    },
  ],
  cardsShown: [],
  cast: [],
  lastUpdatedTick: 400,
  lastRejections: [],
};

function ctx(transport?: ReturnType<typeof fakeTransport>) {
  return {
    gameId: "g1",
    content: content(),
    callId: "stage1",
    notes: STORED_NOTES,
    model: "staging/model",
    ...(transport === undefined ? {} : { transport }),
  };
}

const reply = (body: unknown) => fakeTransport(okResult(JSON.stringify(body)));

describe("the staging call (D67)", () => {
  it("asks the model with the staging prompt and schema, and answers one stageDock, no notes", async () => {
    const transport = reply({
      rationale: "Greta's grudge is due: put her where the captain will see her waiting.",
      intents: [
        {
          kind: "placePerson",
          who: "seed",
          name: "Greta Lindholm",
          role: "",
          look: "",
          post: "canteen_hatch",
          label: "arms folded, waiting",
        },
        { kind: "setAmbience", line: "The conveyor has stopped, and the berth is very quiet." },
      ],
    });
    const res = await runNarrator(stageDockRequest(content()), ctx(transport));
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0];
    expect(call?.model).toBe("staging/model");
    expect(call?.schemaName).toBe("staging_plan");
    expect(call?.system[0]).toBe(STAGING_RULES);
    expect(call?.system[0]).not.toBe(STATIC_RULES);
    expect(call?.user).toContain("## The dock you are dressing (Kessler Drift, ore berth 3)");
    // Aware of the story: the threads it must not change are in front of it.
    expect(call?.user).toContain("Greta's grudge");
    expect(JSON.stringify(call?.jsonSchema)).toContain("placePerson");
    expect(JSON.stringify(call?.jsonSchema)).not.toContain("offerJob");
    expect(res.fallback).toBeUndefined();
    expect(res.promptVersion).toBe(PROMPT_VERSION);
    expect(res.commands.map((c) => c.kind)).toEqual(["stageDock"]);
    expect(res.notesUpdate).toBeUndefined();
    expect(res.card).toBeUndefined();
    expect(res.dropped).toEqual([]);
  });

  it("drops story intents in the reply instead of falling back", async () => {
    const transport = reply({
      rationale: "An offer, why not.",
      intents: [
        { kind: "offerJob", issuerName: "Greta Lindholm" },
        { kind: "setAmbience", line: "Ore dust hangs in the lamplight." },
      ],
    });
    const res = await runNarrator(stageDockRequest(content()), ctx(transport));
    expect(res.fallback).toBeUndefined();
    expect(res.commands.map((c) => c.kind)).toEqual(["stageDock"]);
    expect(res.dropped?.map((d) => d.kind)).toEqual(["offerJob"]);
    expect(res.notesUpdate).toBeUndefined();
  });

  it("an empty intents list is the floor set: no commands, not a fallback", async () => {
    const res = await runNarrator(
      stageDockRequest(content()),
      ctx(reply({ rationale: "A quiet arrival.", intents: [] })),
    );
    expect(res.fallback).toBeUndefined();
    expect(res.commands).toEqual([]);
  });

  it("refuses a reply that writes notes or anything else beside the plan (schemaInvalid)", async () => {
    const run = await runNarratorWithTrace(
      stageDockRequest(content()),
      ctx(reply({ rationale: "x", intents: [], notes: { summary: "rewritten" } })),
    );
    expect(run.response.fallback).toBe("schemaInvalid");
    expect(run.response.commands).toEqual([]);
    expect(run.response.notesUpdate).toBeUndefined();
    expect(run.error).toContain("staging plan failed validation");
  });

  it("falls back to the floor set on a provider error, with the reason", async () => {
    const run = await runNarratorWithTrace(
      stageDockRequest(content()),
      ctx(fakeTransport(new TransportError("apiError", "OpenRouter 502"))),
    );
    expect(run.response).toMatchObject({
      commands: [],
      fallback: "apiError",
      model: NULL_NARRATOR_MODEL,
    });
    expect(run.response.notesUpdate).toBeUndefined();
    expect(run.error).toBe("OpenRouter 502");
  });

  it("falls back notConfigured without a transport", async () => {
    const res = await runNarrator(stageDockRequest(content()), ctx());
    expect(res).toMatchObject({ commands: [], fallback: "notConfigured" });
  });
});
